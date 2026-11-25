/**
 * Microsoft Graph Admin Service & `MailTransport` implementation (`server/modules/integrations/graph/service.ts`).
 *
 * Security invariants:
 *  - Off by default; requires single-tenant GUID `tenantId`, `clientId`, encrypted `clientSecret`,
 *    effective sender mailbox, AND the `"microsoft_graph"` egress preset switched on.
 *  - `sendTestMessage` sends ONLY to the signed-in administrator's own email address (§2.C).
 *  - `MailTransport.send` implements Decision 8 & B-01 fail-closed outcome classification:
 *    pre-wire failures and explicit 4xx/429 rejections return `"rejected"` (safe for failover),
 *    while any post-wire timeout, socket drop, or 5xx gateway failure on `POST /sendMail` returns `"unknown"`
 *    so the message is never replayed and never failed over.
 */
import type { Capability } from "../../../../shared/capabilities.js";
import type { ModuleDeps } from "../../../container.js";
import { DomainError, validation } from "../../../core/errors.js";
import type { MailSenderIdentity, MailTransport, MailTransportMessage, MailTransportResult } from "../../jobs/mailPorts.js";
import { isSecretConfigured, readSecret, readSetting, writeSetting } from "../../platform/index.js";
import { flagKey } from "../../platform/settingsRegistry.js";
import { assertAdminStepUpAnyInTx, assertAdminStepUpAnyPreflight } from "../authz.js";
import type { EgressPolicy } from "../egress.js";
import type { ProviderChecksStore } from "../providerChecks.js";
import {
  extractSecretLast4,
  FORBIDDEN_MULTI_TENANT_ALIASES,
  type GraphConfigSetting,
  hasNoHeaderInjection,
  INTEGRATIONS_GRAPH_CLIENT_SECRET,
  INTEGRATIONS_GRAPH_CONFIG,
  INTEGRATIONS_GRAPH_FLAG,
  INTEGRATIONS_SMTP_CONFIG,
  isValidEntraClientGuid,
  isValidSingleTenantGuid,
  readIntegrationFlag,
  safeEmailAddressSchema,
} from "../settings.js";
import { type ProviderState, readSharedMailSenderFromStore, resolveAdminSelfEmail } from "../smtp.js";
import { createGraphClientFromResolver } from "./client.js";
import type { GraphTokenCache } from "./tokenCache.js";
import {
  GraphApiError,
  type GraphAdminService,
  type GraphClient,
  type GraphConfigView,
  type GraphConnectionTestResult,
  type GraphCredentialsInput,
  type GraphEntraRunbookView,
  type GraphMailTestResult,
  type GraphReadiness,
  type GraphSitesSelectedWriteCheckInput,
  type GraphSitesSelectedWriteCheckResult,
} from "./types.js";

const MAIL_ADMIN_CAPABILITIES: readonly Capability[] = ["integrations.manage", "mail.manage"];
const SITES_SELECTED_ADMIN_CAPABILITIES: readonly Capability[] = [
  "integrations.manage",
  "storage.manage",
  "mail.manage",
];
const SAFE_SITE_ID_RE = /^[A-Za-z0-9.,_!:-]{3,256}$/;
const SAFE_DRIVE_ID_RE = /^[A-Za-z0-9!._-]{3,256}$/;
const SAFE_FOLDER_SEGMENT_RE = /^[A-Za-z0-9 ._()-]{1,120}$/;

const MAILBOX_RESTRICTION_NOTE =
  "Application Mail.Send grants tenant-wide send permission in Microsoft 365 unless you scope this app registration to the dedicated sender mailbox with an Exchange Online ApplicationAccessPolicy (or RBAC for Applications).";

function isCompleteGraphCredentials(cfg: GraphConfigSetting, hasSecret: boolean): boolean {
  return isValidSingleTenantGuid(cfg.tenantId) && isValidEntraClientGuid(cfg.clientId) && hasSecret;
}

function isValidSender(sender: MailSenderIdentity | null | undefined): sender is MailSenderIdentity {
  if (!sender) return false;
  if (!safeEmailAddressSchema.safeParse(sender.fromAddress).success) return false;
  if (sender.fromName !== "" && !hasNoHeaderInjection(sender.fromName)) return false;
  if (sender.replyToAddress && sender.replyToAddress !== "") {
    if (!safeEmailAddressSchema.safeParse(sender.replyToAddress).success) return false;
  }
  return true;
}

function deriveGraphState(
  enabled: boolean,
  configured: boolean,
  egressPresetEnabled: boolean,
  credentialsReady: boolean,
  check: Awaited<ReturnType<ProviderChecksStore["get"]>>,
): { state: ProviderState; verified: boolean; summary: string } {
  if (!credentialsReady && !enabled) {
    return {
      state: "not_configured",
      verified: false,
      summary: "Microsoft Graph mail is not configured — off by default.",
    };
  }
  if (!egressPresetEnabled && (credentialsReady || enabled)) {
    return {
      state: enabled ? "degraded" : "not_configured",
      verified: false,
      summary: "Enable the Microsoft Graph outbound egress preset to allow Graph token and mail requests.",
    };
  }
  if (!configured) {
    return {
      state: "not_configured",
      verified: false,
      summary: "Complete single-tenant Entra credentials, sender identity, and egress preset to finish Graph setup.",
    };
  }
  if (!enabled) {
    return {
      state: "disabled",
      verified: Boolean(check?.verifiedAt),
      summary: "Microsoft Graph settings are saved, but Graph integration is disabled.",
    };
  }
  if (!check) {
    return {
      state: "configured",
      verified: false,
      summary: "Microsoft Graph is configured; test the connection or send a test message to verify live access.",
    };
  }
  if (check.lastOutcome === "succeeded") {
    return {
      state: "configured",
      verified: true,
      summary: "Microsoft Graph credentials and transport verified at last check.",
    };
  }
  if (check.lastOutcome === "unknown") {
    return {
      state: "degraded",
      verified: Boolean(check.verifiedAt),
      summary: "Last Microsoft Graph mail attempt ended with an uncertain upstream outcome.",
    };
  }
  return {
    state: "failing",
    verified: false,
    summary: "Last Microsoft Graph authentication or delivery check failed.",
  };
}

function classifyGraphSendError(error: unknown): {
  outcome: "rejected" | "unknown";
  retryable?: boolean;
  reasonCode: string;
  safeDetail: string;
} {
  if (error instanceof GraphApiError) {
    if (!error.requestSent) {
      return {
        outcome: "rejected",
        retryable: error.retryable,
        reasonCode: error.reasonCode,
        safeDetail: error.retryable ? "graph_preconnect_failed" : "graph_precheck_rejected",
      };
    }
    if (error.status === 429) {
      return {
        outcome: "rejected",
        retryable: true,
        reasonCode: "GRAPH_THROTTLED",
        safeDetail: "graph_throttled",
      };
    }
    if (error.status !== null && error.status >= 400 && error.status < 500) {
      const isAuth = error.status === 401 || error.status === 403;
      return {
        outcome: "rejected",
        retryable: false,
        reasonCode: isAuth ? "GRAPH_MAIL_AUTH_REJECTED" : `GRAPH_MAIL_HTTP_${error.status}`,
        safeDetail: isAuth ? "graph_auth_rejected" : "graph_rejected",
      };
    }
    // `requestSent === true` with `status === null` (mid-flight timeout / stream drop) OR `5xx` gateway ambiguity:
    // Graph `sendMail` carries no provider idempotency guarantee, so treat fail-closed as `unknown` (Decision 8).
    return {
      outcome: "unknown",
      reasonCode: "GRAPH_DELIVERY_UNCERTAIN",
      safeDetail: "graph_delivery_uncertain",
    };
  }

  return {
    outcome: "unknown",
    reasonCode: "GRAPH_DELIVERY_UNCERTAIN",
    safeDetail: "graph_delivery_uncertain",
  };
}

export interface GraphModuleRuntime {
  client: GraphClient;
  admin: GraphAdminService;
  mailTransport: MailTransport;
  createScopedClient(
    credentials?: GraphCredentialsInput | (() => Promise<GraphCredentialsInput | null>),
  ): GraphClient;
}

export function createGraphModuleRuntime(
  deps: ModuleDeps,
  egress: EgressPolicy,
  checks: ProviderChecksStore,
  tokenCache: GraphTokenCache,
): GraphModuleRuntime {
  async function getGraphEgressPresetStates(): Promise<{
    graphEnabled: boolean;
    uploadEnabled: boolean;
  }> {
    const presets = await egress.listPresets();
    const graphPreset = presets.find((p) => p.key === "microsoft_graph");
    const uploadPreset = presets.find((p) => p.key === "microsoft_graph_upload");
    return {
      graphEnabled: Boolean(graphPreset?.enabled),
      uploadEnabled: Boolean(uploadPreset?.enabled),
    };
  }

  async function isGraphPresetEnabled(): Promise<boolean> {
    const states = await getGraphEgressPresetStates();
    return states.graphEnabled;
  }

  async function emitGraphOpsAlert(params: {
    dedupKey: string;
    severity: "warning" | "error" | "critical";
    code: string;
    title: string;
    text?: string;
  }): Promise<void> {
    const opsAlerts = deps.services.opsAlerts;
    if (!opsAlerts) return;
    try {
      await opsAlerts.emit({
        source: "graph",
        severity: params.severity,
        dedupKey: params.dedupKey,
        code: params.code,
        title: params.title,
        ...(params.text ? { text: params.text } : {}),
      });
    } catch {
      // Operational alerts are advisory diagnostics; never fail the caller's request.
    }
  }

  async function resolveGraphOpsAlert(dedupKey: string): Promise<void> {
    const opsAlerts = deps.services.opsAlerts;
    if (!opsAlerts) return;
    try {
      await opsAlerts.resolve({
        source: "graph",
        dedupKey,
      });
    } catch {
      // Non-fatal diagnostic resolution.
    }
  }

  const clientDiagnostics = {
    now: () => deps.clock.now(),
    onResponseDiagnostic: (ev: { kind: "auth_error" | "throttled" | "succeeded"; status: number; reasonCode?: string }) => {
      if (ev.kind === "auth_error") {
        void emitGraphOpsAlert({
          dedupKey: "graph:auth",
          severity: "error",
          code: ev.reasonCode ?? `GRAPH_HTTP_${ev.status}`,
          title: "Microsoft Graph authentication or permission rejected",
          text: `Microsoft Graph returned HTTP ${ev.status}. Verify Entra client credentials and Sites.Selected / Mail.Send permissions.`,
        });
      } else if (ev.kind === "succeeded") {
        void resolveGraphOpsAlert("graph:auth");
      }
    },
  };

  async function resolvePlatformGraphCredentials(): Promise<GraphCredentialsInput | null> {
    const [enabled, cfg, secret, presetEnabled] = await Promise.all([
      readIntegrationFlag(deps.settings, INTEGRATIONS_GRAPH_FLAG),
      readSetting(deps.settings, INTEGRATIONS_GRAPH_CONFIG),
      readSecret(deps.settings, INTEGRATIONS_GRAPH_CLIENT_SECRET),
      isGraphPresetEnabled(),
    ]);
    if (!enabled || !presetEnabled || !secret || !isCompleteGraphCredentials(cfg, true)) {
      return null;
    }
    return {
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      clientSecret: secret,
      credentialVersion: cfg.credentialVersion ?? 0,
    };
  }

  const platformClient = createGraphClientFromResolver(
    egress,
    tokenCache,
    resolvePlatformGraphCredentials,
    async () => (await resolvePlatformGraphCredentials()) !== null,
    clientDiagnostics,
  );

  async function resolveAuthoritativeSenderOutsideTx(): Promise<MailSenderIdentity | null> {
    const sharedStore = await readSharedMailSenderFromStore(deps.settings);
    if (sharedStore) return sharedStore;
    const getShared = deps.services.jobAdmin?.getMailSenderIdentity;
    if (typeof getShared === "function") {
      const candidate = await getShared.call(deps.services.jobAdmin);
      if (isValidSender(candidate)) return candidate;
    }
    const smtpCfg = await readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG);
    if (safeEmailAddressSchema.safeParse(smtpCfg.fromAddress).success) {
      return {
        fromAddress: smtpCfg.fromAddress.trim(),
        fromName: smtpCfg.fromName.trim() || "ReadyPackets Portal",
        ...(smtpCfg.replyToAddress.trim() ? { replyToAddress: smtpCfg.replyToAddress.trim() } : {}),
      };
    }
    return null;
  }

  function isMailboxConstraintSatisfied(senderMailbox: string, fromAddress: string): boolean {
    const trimmed = senderMailbox.trim();
    if (trimmed === "") return true;
    return trimmed.toLowerCase() === fromAddress.trim().toLowerCase();
  }

  async function loadConfigView(includeJobAdminSender = false): Promise<GraphConfigView> {
    const [enabled, cfg, secretConfigured, presetStates, sharedInStore, smtpCfg, check, sharepointCheck] = await Promise.all([
      readIntegrationFlag(deps.settings, INTEGRATIONS_GRAPH_FLAG),
      readSetting(deps.settings, INTEGRATIONS_GRAPH_CONFIG),
      isSecretConfigured(deps.settings, INTEGRATIONS_GRAPH_CLIENT_SECRET),
      getGraphEgressPresetStates(),
      readSharedMailSenderFromStore(deps.settings),
      readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG),
      checks.get("graph"),
      checks.get("sharepoint"),
    ]);
    const presetEnabled = presetStates.graphEnabled;

    let authoritativeSender: MailSenderIdentity | null =
      sharedInStore ??
      (safeEmailAddressSchema.safeParse(smtpCfg.fromAddress).success
        ? {
            fromAddress: smtpCfg.fromAddress.trim(),
            fromName: smtpCfg.fromName.trim() || "ReadyPackets Portal",
          }
        : null);

    if (!authoritativeSender && includeJobAdminSender && typeof deps.services.jobAdmin?.getMailSenderIdentity === "function") {
      const fromJobAdmin = await deps.services.jobAdmin.getMailSenderIdentity();
      if (isValidSender(fromJobAdmin)) authoritativeSender = fromJobAdmin;
    }

    const mailboxMatches = authoritativeSender
      ? isMailboxConstraintSatisfied(cfg.senderMailbox, authoritativeSender.fromAddress)
      : false;

    const credentialsReady = isCompleteGraphCredentials(cfg, secretConfigured);
    const configured = credentialsReady && Boolean(authoritativeSender) && mailboxMatches && presetEnabled;
    const derived = deriveGraphState(enabled, configured, presetEnabled, credentialsReady, check);

    return {
      enabled,
      configured,
      verified: derived.verified,
      state: derived.state,
      summary:
        authoritativeSender && !mailboxMatches
          ? "Configured Graph sender mailbox constraint does not match the shared mail From address."
          : derived.summary,
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      clientSecretConfigured: secretConfigured,
      clientSecretLast4: secretConfigured ? (cfg.clientSecretLast4 ?? null) : null,
      senderMailbox: cfg.senderMailbox,
      egressPresetEnabled: presetEnabled,
      uploadEgressPresetEnabled: presetStates.uploadEnabled,
      egressReady: presetEnabled,
      lastCheckedAt: check?.lastCheckedAt ?? null,
      lastOutcome: check?.lastOutcome ?? null,
      sitesSelectedLastCheckedAt: sharepointCheck?.lastCheckedAt ?? null,
      sitesSelectedLastOutcome: sharepointCheck?.lastOutcome ?? null,
      mailboxRestrictionNote: MAILBOX_RESTRICTION_NOTE,
    };
  }

  function buildSendMailBody(
    mailbox: string,
    sender: MailSenderIdentity,
    to: string,
    subject: string,
    text: string,
    html: string,
    attachments?: MailTransportMessage["attachments"],
  ) {
    const useHtml = html.trim().length > 0;
    return {
      message: {
        subject,
        body: {
          contentType: useHtml ? "HTML" : "Text",
          content: useHtml ? html : text,
        },
        from: {
          emailAddress: {
            address: mailbox,
            ...(sender.fromName ? { name: sender.fromName } : {}),
          },
        },
        ...(sender.replyToAddress
          ? {
              replyTo: [{ emailAddress: { address: sender.replyToAddress } }],
            }
          : {}),
        toRecipients: [
          {
            emailAddress: {
              address: to.trim(),
            },
          },
        ],
        ...(attachments ? { attachments: attachments.map(({ filename, contentType, content }) => ({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: filename,
          contentType,
          contentBytes: content.toString("base64"),
        })) } : {}),
      },
      saveToSentItems: false,
    };
  }

  const admin: GraphAdminService = {
    async getReadiness(): Promise<GraphReadiness> {
      const view = await loadConfigView(true);
      return {
        enabled: view.enabled,
        configured: view.configured,
        verified: view.verified,
        ready: view.enabled && view.configured && view.state !== "failing",
        state: view.state,
        summary: view.summary,
      };
    },

    getConfig(): Promise<GraphConfigView> {
      return loadConfigView(false);
    },

    async updateConfig(principal, input): Promise<GraphConfigView> {
      const now = deps.clock.now();
      assertAdminStepUpAnyPreflight(principal, now, MAIL_ADMIN_CAPABILITIES);

      const tenantId = input.tenantId.trim().toLowerCase();
      const clientId = input.clientId.trim().toLowerCase();
      const suppliedMailbox = input.senderMailbox !== undefined ? input.senderMailbox.trim() : undefined;

      if (tenantId !== "") {
        if (FORBIDDEN_MULTI_TENANT_ALIASES.has(tenantId)) {
          throw validation(
            "GRAPH_MULTI_TENANT_FORBIDDEN",
            "Multi-tenant Entra authorities (common, organizations, consumers) are forbidden; enter your single-tenant directory GUID.",
          );
        }
        if (!isValidSingleTenantGuid(tenantId)) {
          throw validation("GRAPH_INVALID_TENANT_ID", "Enter a valid single-tenant Entra directory GUID.");
        }
      }
      if (clientId !== "" && !isValidEntraClientGuid(clientId)) {
        throw validation("GRAPH_INVALID_CLIENT_ID", "Enter a valid Entra application (client) GUID.");
      }
      if (suppliedMailbox !== undefined && suppliedMailbox !== "") {
        if (!safeEmailAddressSchema.safeParse(suppliedMailbox).success) {
          throw validation("GRAPH_INVALID_SENDER_MAILBOX", "Enter a valid sender mailbox address.");
        }
      }
      if (input.clientSecret !== undefined && input.clientSecret !== null) {
        if (
          input.clientSecret.length === 0 ||
          input.clientSecret.length > 1024 ||
          !hasNoHeaderInjection(input.clientSecret)
        ) {
          throw validation("GRAPH_INVALID_CLIENT_SECRET", "Enter a valid Entra client secret (1–1024 characters).");
        }
      }

      if (input.enableEgressPreset !== undefined) {
        await egress.setPresetEnabled(principal, {
          presetKey: "microsoft_graph",
          enabled: input.enableEgressPreset,
        });
      }

      const presetEnabled = await isGraphPresetEnabled();

      let credentialsChanged = false;
      await deps.db.transaction(async (tx) => {
        await assertAdminStepUpAnyInTx(deps, principal, tx, MAIL_ADMIN_CAPABILITIES);

        const prevCfg = await readSetting(deps.settings, INTEGRATIONS_GRAPH_CONFIG, tx);
        const prevHasSecret = await isSecretConfigured(deps.settings, INTEGRATIONS_GRAPH_CLIENT_SECRET, tx);
        const sharedSender = await readSharedMailSenderFromStore(deps.settings, tx);
        const smtpCfg = await readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG, tx);

        const nextHasSecret =
          input.clientSecret === null
            ? false
            : typeof input.clientSecret === "string"
              ? true
              : prevHasSecret;

        const nextSecretLast4 =
          input.clientSecret === null
            ? null
            : typeof input.clientSecret === "string"
              ? extractSecretLast4(input.clientSecret)
              : (prevCfg.clientSecretLast4 ?? null);

        const nextSenderMailbox = suppliedMailbox !== undefined ? suppliedMailbox : prevCfg.senderMailbox;

        credentialsChanged =
          prevCfg.tenantId !== tenantId ||
          prevCfg.clientId !== clientId ||
          input.clientSecret !== undefined ||
          prevCfg.senderMailbox !== nextSenderMailbox;

        const nextVersion = (prevCfg.credentialVersion ?? 0) + (credentialsChanged ? 1 : 0);

        const nextCfg: GraphConfigSetting = {
          tenantId,
          clientId,
          senderMailbox: nextSenderMailbox,
          clientSecretLast4: nextSecretLast4,
          credentialVersion: nextVersion,
        };

        const authoritativeFrom =
          sharedSender?.fromAddress ||
          (safeEmailAddressSchema.safeParse(smtpCfg.fromAddress).success ? smtpCfg.fromAddress.trim() : "");

        const mailboxMatches =
          authoritativeFrom !== "" && isMailboxConstraintSatisfied(nextSenderMailbox, authoritativeFrom);

        if (nextSenderMailbox !== "" && authoritativeFrom !== "" && !mailboxMatches) {
          throw validation(
            "GRAPH_SENDER_MAILBOX_MISMATCH",
            "The optional Graph sender mailbox constraint must match the shared sender From address.",
          );
        }

        const complete =
          isCompleteGraphCredentials(nextCfg, nextHasSecret) &&
          authoritativeFrom !== "" &&
          mailboxMatches &&
          presetEnabled;
        if (input.enabled && !complete) {
          if (!presetEnabled) {
            throw validation(
              "GRAPH_EGRESS_PRESET_REQUIRED",
              "Enable the Microsoft Graph outbound egress preset before enabling Microsoft Graph delivery.",
            );
          }
          throw validation(
            "GRAPH_CONFIG_INCOMPLETE",
            "Configure the shared mail sender identity and complete single-tenant Entra credentials before enabling Microsoft Graph.",
          );
        }

        await writeSetting(deps.settings, INTEGRATIONS_GRAPH_CONFIG, nextCfg, tx);
        if (input.clientSecret !== undefined) {
          await deps.settings.setSecret(INTEGRATIONS_GRAPH_CLIENT_SECRET.key, input.clientSecret, tx);
        }
        await deps.settings.set(flagKey(INTEGRATIONS_GRAPH_FLAG.flag), input.enabled, tx);

        if (credentialsChanged) {
          await checks.clearVerification("graph", tx);
        }

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.graph.updated",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            provider: "graph",
            resource: { type: "integration_provider", publicId: "graph" },
            attributes: {
              enabled: input.enabled,
              secret_updated: input.clientSecret !== undefined,
              egress_preset_enabled: presetEnabled,
              configured: complete,
            },
          },
          tx,
        );
      });

      if (credentialsChanged) {
        tokenCache.clear();
      }

      return loadConfigView(false);
    },

    async testConnection(principal): Promise<GraphConnectionTestResult> {
      const startedAt = deps.clock.now();
      assertAdminStepUpAnyPreflight(principal, startedAt, MAIL_ADMIN_CAPABILITIES);

      const presetEnabled = await isGraphPresetEnabled();
      const creds = await deps.db.transaction(async (tx) => {
        await assertAdminStepUpAnyInTx(deps, principal, tx, MAIL_ADMIN_CAPABILITIES);
        const cfg = await readSetting(deps.settings, INTEGRATIONS_GRAPH_CONFIG, tx);
        const secret = await readSecret(deps.settings, INTEGRATIONS_GRAPH_CLIENT_SECRET, tx);
        if (!secret || !isCompleteGraphCredentials(cfg, true)) {
          throw new DomainError(
            "NOT_CONFIGURED",
            "GRAPH_NOT_CONFIGURED",
            "Save the single-tenant directory GUID, application client GUID, and client secret before testing the connection.",
          );
        }
        if (!presetEnabled) {
          throw new DomainError(
            "FORBIDDEN",
            "GRAPH_EGRESS_PRESET_REQUIRED",
            "Enable the Microsoft Graph outbound egress preset before testing the connection.",
          );
        }
        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.graph.connection_test_attempted",
            action: "test",
            outcome: "attempted",
            severity: "INFO",
            provider: "graph",
            resource: { type: "integration_provider", publicId: "graph" },
          },
          tx,
        );
        return {
          tenantId: cfg.tenantId,
          clientId: cfg.clientId,
          clientSecret: secret,
          credentialVersion: cfg.credentialVersion ?? 0,
        };
      });

      // Force a live Entra token exchange rather than serving a cached token.
      tokenCache.invalidate(creds);

      let outcome: "succeeded" | "failed";
      let reasonCode: string;
      let safeMessage: string;

      try {
        await tokenCache.getAccessToken(creds);
        outcome = "succeeded";
        reasonCode = "GRAPH_TOKEN_VERIFIED";
        safeMessage =
          "Authenticated to Microsoft Entra single-tenant OAuth 2.0 over verified TLS and obtained an application token.";
      } catch (error) {
        outcome = "failed";
        reasonCode = error instanceof DomainError ? error.reasonCode : "GRAPH_CONNECTION_FAILED";
        safeMessage =
          error instanceof DomainError
            ? error.safeMessage
            : "Microsoft Entra refused the connection or credentials.";
      }

      const finishedAt = deps.clock.now();
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

      await deps.db.transaction(async (tx) => {
        await checks.recordOutcome("graph", outcome, reasonCode, tx);
        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.graph.connection_tested",
            action: "test",
            outcome: outcome === "succeeded" ? "completed" : "failed",
            severity: outcome === "succeeded" ? "INFO" : "WARN",
            reasonCode,
            provider: "graph",
            durationMs,
            resource: { type: "integration_provider", publicId: "graph" },
          },
          tx,
        );
      });

      if (outcome === "succeeded") {
        await resolveGraphOpsAlert("graph:auth");
      } else {
        await emitGraphOpsAlert({
          dedupKey: "graph:auth",
          severity: "error",
          code: reasonCode,
          title: "Microsoft Graph token check failed",
          text: safeMessage,
        });
      }

      return {
        outcome,
        reasonCode,
        safeMessage,
        durationMs,
        checkedAt: finishedAt,
      };
    },

    async sendTestMessage(principal, input): Promise<GraphMailTestResult> {
      const startedAt = deps.clock.now();
      assertAdminStepUpAnyPreflight(principal, startedAt, MAIL_ADMIN_CAPABILITIES);

      const presetEnabled = await isGraphPresetEnabled();

      const { creds, mailbox, sender, recipientAddress } = await deps.db.transaction(async (tx) => {
        await assertAdminStepUpAnyInTx(deps, principal, tx, MAIL_ADMIN_CAPABILITIES);
        // Enforce self-only test recipient inside the same DB transaction (§2.C).
        const selfEmail = await resolveAdminSelfEmail(deps, principal, input?.toAddress, tx);
        const cfg = await readSetting(deps.settings, INTEGRATIONS_GRAPH_CONFIG, tx);
        const secret = await readSecret(deps.settings, INTEGRATIONS_GRAPH_CLIENT_SECRET, tx);
        const sharedSender = await readSharedMailSenderFromStore(deps.settings, tx);
        const smtpCfg = await readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG, tx);

        const authoritativeSender: MailSenderIdentity | null =
          sharedSender ??
          (safeEmailAddressSchema.safeParse(smtpCfg.fromAddress).success
            ? {
                fromAddress: smtpCfg.fromAddress.trim(),
                fromName: smtpCfg.fromName.trim() || "ReadyPackets Portal",
                ...(smtpCfg.replyToAddress.trim() ? { replyToAddress: smtpCfg.replyToAddress.trim() } : {}),
              }
            : null);

        if (!secret || !isCompleteGraphCredentials(cfg, true) || !authoritativeSender) {
          throw new DomainError(
            "NOT_CONFIGURED",
            "GRAPH_NOT_CONFIGURED",
            "Configure the shared mail sender identity and save complete Microsoft Graph credentials before sending a test message.",
          );
        }
        if (!isMailboxConstraintSatisfied(cfg.senderMailbox, authoritativeSender.fromAddress)) {
          throw validation(
            "GRAPH_SENDER_MAILBOX_MISMATCH",
            "The configured Graph sender mailbox constraint does not match the shared sender From address.",
          );
        }
        if (!presetEnabled) {
          throw new DomainError(
            "FORBIDDEN",
            "GRAPH_EGRESS_PRESET_REQUIRED",
            "Enable the Microsoft Graph outbound egress preset before sending a test message.",
          );
        }

        const resolvedMailbox = authoritativeSender.fromAddress.trim();
        const effectiveSender: MailSenderIdentity = authoritativeSender;

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.graph.test_attempted",
            action: "test",
            outcome: "attempted",
            severity: "INFO",
            provider: "graph",
            resource: { type: "integration_provider", publicId: "graph" },
          },
          tx,
        );

        return {
          creds: {
            tenantId: cfg.tenantId,
            clientId: cfg.clientId,
            clientSecret: secret,
            credentialVersion: cfg.credentialVersion ?? 0,
          },
          mailbox: resolvedMailbox,
          sender: effectiveSender,
          recipientAddress: selfEmail,
        };
      });

      const testClient = createGraphClientFromResolver(egress, tokenCache, async () => creds);
      let outcome: "accepted" | "rejected" | "unknown";
      let reasonCode: string;
      let safeMessage: string;

      try {
        const body = buildSendMailBody(
          mailbox,
          sender,
          recipientAddress,
          "ReadyPackets Portal — Microsoft Graph Mail Verification",
          "This is a synthetic administrative test message verifying ReadyPackets outbound mail via Microsoft Graph.",
          "<p>This is a synthetic administrative test message verifying ReadyPackets outbound mail via Microsoft Graph.</p>",
        );
        const res = await testClient.request({
          method: "POST",
          path: `/users/${encodeURIComponent(mailbox)}/sendMail`,
          body,
        });
        if (res.status === 202) {
          outcome = "accepted";
          reasonCode = "GRAPH_MAIL_ACCEPTED";
          safeMessage =
            "Microsoft Graph accepted the test message (HTTP 202) to your administrator address over verified TLS (transport acceptance, not inbox delivery proof).";
        } else {
          outcome = "unknown";
          reasonCode = "GRAPH_UNEXPECTED_STATUS";
          safeMessage =
            "Microsoft Graph returned an unexpected non-202 response status; delivery outcome is unknown.";
        }
      } catch (error) {
        const classified = classifyGraphSendError(error);
        outcome = classified.outcome;
        reasonCode = classified.reasonCode;
        safeMessage =
          outcome === "unknown"
            ? "The Microsoft Graph request ended with an uncertain upstream outcome; delivery status is unknown."
            : error instanceof DomainError
              ? error.safeMessage
              : "Microsoft Graph refused the credentials, sender mailbox, or test message.";
      }

      const finishedAt = deps.clock.now();
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
      const checkOutcome = outcome === "accepted" ? "succeeded" : outcome === "rejected" ? "failed" : "unknown";

      await deps.db.transaction(async (tx) => {
        await checks.recordOutcome("graph", checkOutcome, reasonCode, tx);
        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.graph.tested",
            action: "test",
            outcome: outcome === "accepted" ? "completed" : outcome === "rejected" ? "failed" : "unknown",
            severity: outcome === "accepted" ? "INFO" : "WARN",
            reasonCode,
            provider: "graph",
            durationMs,
            resource: { type: "integration_provider", publicId: "graph" },
          },
          tx,
        );
      });

      return {
        outcome,
        reasonCode,
        safeMessage,
        recipientAddress,
        durationMs,
        checkedAt: finishedAt,
      };
    },

    async verifySitesSelectedWrite(
      principal,
      input: GraphSitesSelectedWriteCheckInput = {},
    ): Promise<GraphSitesSelectedWriteCheckResult> {
      const startedAt = deps.clock.now();
      assertAdminStepUpAnyPreflight(principal, startedAt, SITES_SELECTED_ADMIN_CAPABILITIES);

      const rawSiteUrlOrId = input.siteUrlOrId?.trim() ? input.siteUrlOrId.trim() : null;
      const suppliedDriveId =
        input.driveId !== undefined && input.driveId !== null && input.driveId.trim() !== ""
          ? input.driveId.trim()
          : null;
      if (!rawSiteUrlOrId && !suppliedDriveId) {
        throw validation(
          "GRAPH_SITE_OR_DRIVE_REQUIRED",
          "Enter a SharePoint site URL, Graph site ID, or document library drive ID to test Sites.Selected write access.",
        );
      }

      let siteGraphPath: string | null = null;
      if (rawSiteUrlOrId !== null) {
        if (!hasNoHeaderInjection(rawSiteUrlOrId)) {
          throw validation("GRAPH_INVALID_SITE_ID", "Enter a valid SharePoint site URL or identifier.");
        }
        if (/^https:\/\//i.test(rawSiteUrlOrId)) {
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(rawSiteUrlOrId);
          } catch {
            throw validation("GRAPH_INVALID_SITE_URL", "Enter a valid HTTPS SharePoint site URL.");
          }
          if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname.toLowerCase().endsWith(".sharepoint.com")) {
            throw validation(
              "GRAPH_INVALID_SITE_URL",
              "SharePoint site URL must use https:// on a *.sharepoint.com hostname.",
            );
          }
          const cleanPath = parsedUrl.pathname.replace(/\/+$/, "");
          siteGraphPath = cleanPath && cleanPath !== ""
            ? `/sites/${encodeURIComponent(parsedUrl.hostname)}:${cleanPath}`
            : `/sites/${encodeURIComponent(parsedUrl.hostname)}`;
        } else {
          if (!SAFE_SITE_ID_RE.test(rawSiteUrlOrId)) {
            throw validation(
              "GRAPH_INVALID_SITE_ID",
              "Enter a valid SharePoint site identifier (for example hostname,siteGuid,webGuid) or HTTPS SharePoint URL.",
            );
          }
          siteGraphPath = `/sites/${encodeURIComponent(rawSiteUrlOrId)}`;
        }
      }

      if (suppliedDriveId !== null && (!SAFE_DRIVE_ID_RE.test(suppliedDriveId) || !hasNoHeaderInjection(suppliedDriveId))) {
        throw validation("GRAPH_INVALID_DRIVE_ID", "Enter a valid SharePoint document library drive ID.");
      }

      const folderSegments: string[] = [];
      if (input.probeFolderPath !== undefined && input.probeFolderPath !== null && input.probeFolderPath.trim() !== "") {
        const rawSegments = input.probeFolderPath
          .split("/")
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);
        if (rawSegments.length > 10 || input.probeFolderPath.length > 256) {
          throw validation("GRAPH_INVALID_PROBE_FOLDER", "Probe folder path is too deep or exceeds 256 characters.");
        }
        for (const seg of rawSegments) {
          if (seg === "." || seg === ".." || !SAFE_FOLDER_SEGMENT_RE.test(seg) || !hasNoHeaderInjection(seg)) {
            throw validation(
              "GRAPH_INVALID_PROBE_FOLDER",
              "Probe folder path contains unsupported or relative path characters.",
            );
          }
          folderSegments.push(seg);
        }
      }

      const presetStates = await getGraphEgressPresetStates();
      const creds = await deps.db.transaction(async (tx) => {
        await assertAdminStepUpAnyInTx(deps, principal, tx, SITES_SELECTED_ADMIN_CAPABILITIES);
        if (input.credentials) {
          if (
            !isValidSingleTenantGuid(input.credentials.tenantId) ||
            !isValidEntraClientGuid(input.credentials.clientId) ||
            !input.credentials.clientSecret
          ) {
            throw validation(
              "GRAPH_INVALID_CREDENTIALS",
              "Provide a valid single-tenant Entra directory GUID, client GUID, and client secret.",
            );
          }
          return input.credentials;
        }
        const cfg = await readSetting(deps.settings, INTEGRATIONS_GRAPH_CONFIG, tx);
        const secret = await readSecret(deps.settings, INTEGRATIONS_GRAPH_CLIENT_SECRET, tx);
        if (!secret || !isCompleteGraphCredentials(cfg, true)) {
          throw new DomainError(
            "NOT_CONFIGURED",
            "GRAPH_NOT_CONFIGURED",
            "Save the single-tenant Entra directory GUID, application client GUID, and client secret before testing SharePoint write access.",
          );
        }
        return {
          tenantId: cfg.tenantId,
          clientId: cfg.clientId,
          clientSecret: secret,
          credentialVersion: cfg.credentialVersion ?? 0,
        };
      });

      const steps = {
        egressGraphReady: presetStates.graphEnabled,
        egressUploadReady: presetStates.uploadEnabled,
        tokenAcquired: false,
        siteReadSucceeded: false,
        uploadSessionCreated: false,
        uploadSessionCanceled: false,
      };

      let outcome: "succeeded" | "failed" = "failed";
      let reasonCode = "GRAPH_SITES_SELECTED_FAILED";
      let safeMessage: string;

      if (!presetStates.graphEnabled || !presetStates.uploadEnabled) {
        reasonCode = !presetStates.graphEnabled
          ? "GRAPH_EGRESS_PRESET_REQUIRED"
          : "GRAPH_UPLOAD_EGRESS_PRESET_REQUIRED";
        safeMessage = !presetStates.graphEnabled
          ? "Enable the Microsoft Graph outbound egress preset before testing SharePoint write access."
          : "Enable the SharePoint Upload Session egress preset (*.sharepoint.com, *.files.1drv.com) before testing SharePoint write access.";
      } else {
        tokenCache.invalidate(creds);
        const testClient = createGraphClientFromResolver(
          egress,
          tokenCache,
          async () => creds,
          undefined,
          clientDiagnostics,
        );
        try {
          await tokenCache.getAccessToken(creds);
          steps.tokenAcquired = true;

          let resolvedDriveId = suppliedDriveId;
          if (siteGraphPath !== null) {
            const siteRes = await testClient.request<{ id?: unknown }>({
              method: "GET",
              path: siteGraphPath,
            });
            const siteJson = siteRes.json();
            const canonicalSiteId =
              siteJson && typeof siteJson.id === "string" && SAFE_SITE_ID_RE.test(siteJson.id)
                ? siteJson.id
                : null;
            const effectiveSitePrefix = canonicalSiteId
              ? `/sites/${encodeURIComponent(canonicalSiteId)}`
              : siteGraphPath;

            if (resolvedDriveId) {
              await testClient.request({
                method: "GET",
                path: `${effectiveSitePrefix}/drives/${encodeURIComponent(resolvedDriveId)}`,
              });
            } else {
              const driveRes = await testClient.request<{ id?: unknown }>({
                method: "GET",
                path: `${effectiveSitePrefix}/drive`,
              });
              const driveJson = driveRes.json();
              if (!driveJson || typeof driveJson.id !== "string" || !SAFE_DRIVE_ID_RE.test(driveJson.id)) {
                throw new GraphApiError({
                  code: "VALIDATION",
                  reasonCode: "GRAPH_DRIVE_NOT_RESOLVED",
                  safeMessage: "Microsoft Graph did not return a valid default document library drive ID for the site.",
                  status: driveRes.status,
                  retryable: false,
                  requestSent: true,
                });
              }
              resolvedDriveId = driveJson.id;
            }
          } else if (resolvedDriveId) {
            await testClient.request({
              method: "GET",
              path: `/drives/${encodeURIComponent(resolvedDriveId)}`,
            });
          }

          if (!resolvedDriveId) {
            throw validation("GRAPH_DRIVE_NOT_RESOLVED", "Could not resolve target SharePoint drive ID.");
          }
          steps.siteReadSucceeded = true;

          const probeFileName = `.readypackets-write-probe-${startedAt.getTime()}.tmp`;
          const allSegments = [...folderSegments, probeFileName].map((s) => encodeURIComponent(s));
          const sessionRes = await testClient.request<{ uploadUrl?: unknown }>({
            method: "POST",
            path: `/drives/${encodeURIComponent(resolvedDriveId)}/root:/${allSegments.join("/")}:/createUploadSession`,
            body: {
              item: {
                "@microsoft.graph.conflictBehavior": "fail",
                name: probeFileName,
              },
            },
          });
          const sessionJson = sessionRes.json();
          const uploadUrl = typeof sessionJson?.uploadUrl === "string" ? sessionJson.uploadUrl : "";
          if (!uploadUrl) {
            throw new GraphApiError({
              code: "UNAVAILABLE",
              reasonCode: "GRAPH_UPLOAD_SESSION_MISSING_URL",
              safeMessage: "Microsoft Graph createUploadSession succeeded without returning an upload session URL.",
              status: sessionRes.status,
              retryable: false,
              requestSent: true,
            });
          }
          steps.uploadSessionCreated = true;

          // Immediately cancel the empty upload session via DELETE so zero file bytes are committed in SharePoint.
          await testClient.uploadSessionControl({
            uploadUrl,
            method: "DELETE",
          });
          steps.uploadSessionCanceled = true;

          outcome = "succeeded";
          reasonCode = "GRAPH_SITES_SELECTED_WRITE_VERIFIED";
          safeMessage =
            "Verified single-tenant Entra token, SharePoint site/drive read, and Sites.Selected write permission via non-destructive upload session creation and immediate cancellation.";
        } catch (error) {
          outcome = "failed";
          if (error instanceof GraphApiError) {
            if (error.status === 403 && steps.siteReadSucceeded && !steps.uploadSessionCreated) {
              reasonCode = "GRAPH_SITES_SELECTED_WRITE_DENIED";
              safeMessage =
                "SharePoint site metadata read succeeded, but write permission was denied (HTTP 403). Grant this Entra app registration the 'write' role on the target SharePoint site via Sites.Selected.";
            } else if (error.status === 403) {
              reasonCode = "GRAPH_SITES_SELECTED_ACCESS_DENIED";
              safeMessage =
                "SharePoint denied access to the site (HTTP 403). Ensure Sites.Selected admin consent is granted and this Entra app has explicit site permissions.";
            } else {
              reasonCode = error.reasonCode;
              safeMessage = error.safeMessage;
            }
          } else if (error instanceof DomainError) {
            reasonCode = error.reasonCode;
            safeMessage = error.safeMessage;
          } else {
            reasonCode = "GRAPH_SITES_SELECTED_FAILED";
            safeMessage = "SharePoint Sites.Selected write check failed.";
          }
        }
      }

      const finishedAt = deps.clock.now();
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

      await deps.db.transaction(async (tx) => {
        await checks.recordOutcome("sharepoint", outcome, reasonCode, tx);
        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.graph.sites_selected_checked",
            action: "test",
            outcome: outcome === "succeeded" ? "completed" : "failed",
            severity: outcome === "succeeded" ? "INFO" : "WARN",
            reasonCode,
            provider: "sharepoint",
            durationMs,
            resource: { type: "integration_provider", publicId: "sharepoint" },
            attributes: {
              egress_graph_ready: steps.egressGraphReady,
              egress_upload_ready: steps.egressUploadReady,
              token_acquired: steps.tokenAcquired,
              site_read_succeeded: steps.siteReadSucceeded,
              upload_session_created: steps.uploadSessionCreated,
              upload_session_canceled: steps.uploadSessionCanceled,
            },
          },
          tx,
        );
      });

      if (outcome === "succeeded") {
        await resolveGraphOpsAlert("graph:sites_selected");
      } else {
        await emitGraphOpsAlert({
          dedupKey: "graph:sites_selected",
          severity: "error",
          code: reasonCode,
          title: "SharePoint Sites.Selected write check failed",
          text: safeMessage,
        });
      }

      return {
        outcome,
        reasonCode,
        safeMessage,
        graphEgressEnabled: steps.egressGraphReady,
        uploadEgressEnabled: steps.egressUploadReady,
        tokenAcquired: steps.tokenAcquired,
        readVerified: steps.siteReadSucceeded,
        writeVerified: steps.uploadSessionCreated && steps.uploadSessionCanceled,
        durationMs,
        checkedAt: finishedAt,
      };
    },

    getEntraRunbook(): GraphEntraRunbookView {
      return {
        requiredApplicationPermission: "Sites.Selected",
        discouragedBroadPermissions: [
          "Sites.ReadWrite.All",
          "Sites.FullControl.All",
          "Files.ReadWrite.All",
        ],
        steps: [
          "Register a single-tenant Microsoft Entra application in your organization's directory (Accounts in this organizational directory only).",
          "Add Microsoft Graph Application permission Sites.Selected and grant tenant admin consent (never grant Sites.ReadWrite.All or Files.ReadWrite.All).",
          "Grant explicit 'write' role on each approved SharePoint site to the ReadyPackets application using Microsoft Graph or Microsoft Graph PowerShell.",
          "Enable both 'Microsoft Graph' and 'SharePoint Upload Session' outbound presets on /admin/integrations/egress.",
          "Save the Tenant GUID, Client GUID, and Client Secret, then run the Sites.Selected write check to verify non-destructive upload session creation.",
        ],
        siteGrantEndpointTemplate: "POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions",
        siteGrantPayloadExample: JSON.stringify(
          {
            roles: ["write"],
            grantedToIdentities: [
              {
                application: {
                  id: "<ENTRA_CLIENT_ID_GUID>",
                  displayName: "ReadyPackets Portal",
                },
              },
            ],
          },
          null,
          2,
        ),
        powershellExample: [
          "# Run once per approved SharePoint site as a SharePoint Administrator:",
          "Connect-MgGraph -Scopes 'Sites.FullControl.All'",
          "$SiteId = '<hostname>,<siteCollectionGuid>,<webGuid>'",
          "$Body = @{",
          "  roles = @('write')",
          "  grantedToIdentities = @(@{",
          "    application = @{ id = '<ENTRA_CLIENT_ID_GUID>'; displayName = 'ReadyPackets Portal' }",
          "  })",
          "}",
          "New-MgSitePermission -SiteId $SiteId -BodyParameter $Body",
        ].join("\n"),
        oneDriveNote:
          "OneDrive for Business drives live inside personal SharePoint site collections (https://<tenant>-my.sharepoint.com/personal/<user>); grant Sites.Selected 'write' on that personal site collection rather than Files.ReadWrite.All.",
      };
    },
  };

  const mailTransport: MailTransport = {
    key: "graph",

    async isConfigured(): Promise<boolean> {
      const [enabled, cfg, secretConfigured, presetEnabled] = await Promise.all([
        readIntegrationFlag(deps.settings, INTEGRATIONS_GRAPH_FLAG),
        readSetting(deps.settings, INTEGRATIONS_GRAPH_CONFIG),
        isSecretConfigured(deps.settings, INTEGRATIONS_GRAPH_CLIENT_SECRET),
        isGraphPresetEnabled(),
      ]);
      if (!enabled || !presetEnabled || !isCompleteGraphCredentials(cfg, secretConfigured)) {
        return false;
      }
      const authoritativeSender = await resolveAuthoritativeSenderOutsideTx();
      if (!authoritativeSender) return false;
      return isMailboxConstraintSatisfied(cfg.senderMailbox, authoritativeSender.fromAddress);
    },

    async send(message: MailTransportMessage): Promise<MailTransportResult> {
      if (message.signal.aborted) {
        return { outcome: "rejected", retryable: true, safeDetail: "graph_aborted_before_send" };
      }

      if (
        !safeEmailAddressSchema.safeParse(message.to).success ||
        !hasNoHeaderInjection(message.subject) ||
        !isValidSender(message.sender)
      ) {
        return { outcome: "rejected", retryable: false, safeDetail: "graph_invalid_headers" };
      }

      const [enabled, cfg, secret, presetEnabled] = await Promise.all([
        readIntegrationFlag(deps.settings, INTEGRATIONS_GRAPH_FLAG),
        readSetting(deps.settings, INTEGRATIONS_GRAPH_CONFIG),
        readSecret(deps.settings, INTEGRATIONS_GRAPH_CLIENT_SECRET),
        isGraphPresetEnabled(),
      ]);

      if (!enabled || !presetEnabled || !secret || !isCompleteGraphCredentials(cfg, true)) {
        return { outcome: "not_configured", safeDetail: "graph_not_configured" };
      }

      const mailbox = message.sender.fromAddress.trim();
      if (!isMailboxConstraintSatisfied(cfg.senderMailbox, mailbox)) {
        await checks.recordOutcome("graph", "failed", "GRAPH_SENDER_MAILBOX_MISMATCH").catch(() => {});
        return { outcome: "rejected", retryable: false, safeDetail: "graph_sender_mailbox_mismatch" };
      }

      const scopedClient = createGraphClientFromResolver(egress, tokenCache, async () => ({
        tenantId: cfg.tenantId,
        clientId: cfg.clientId,
        clientSecret: secret,
        credentialVersion: cfg.credentialVersion ?? 0,
      }));

      try {
        const body = buildSendMailBody(
          mailbox,
          message.sender,
          message.to,
          message.subject,
          message.text,
          message.html,
          message.attachments,
        );
        if (message.attachments && Buffer.byteLength(JSON.stringify(body)) > 4_000_000) {
          return { outcome: "rejected", retryable: true, safeDetail: "graph_mail_payload_too_large" };
        }
        const res = await scopedClient.request({
          method: "POST",
          path: `/users/${encodeURIComponent(mailbox)}/sendMail`,
          body,
          signal: message.signal,
        });
        if (res.status !== 202) {
          await checks.recordOutcome("graph", "unknown", "GRAPH_UNEXPECTED_STATUS").catch(() => {});
          return { outcome: "unknown", safeDetail: "graph_unexpected_status" };
        }
        await checks.recordOutcome("graph", "succeeded", "GRAPH_MAIL_ACCEPTED").catch(() => {});
        return { outcome: "accepted", safeDetail: "graph_accepted" };
      } catch (error) {
        const classified = classifyGraphSendError(error);
        await checks
          .recordOutcome("graph", classified.outcome === "unknown" ? "unknown" : "failed", classified.reasonCode)
          .catch(() => {});
        return classified.outcome === "unknown"
          ? { outcome: "unknown", safeDetail: classified.safeDetail }
          : { outcome: "rejected", retryable: classified.retryable, safeDetail: classified.safeDetail };
      }
    },
  };

  return {
    client: platformClient,
    admin,
    mailTransport,
    createScopedClient(credentials) {
      if (credentials === undefined) return platformClient;
      const resolver = typeof credentials === "function" ? credentials : async () => credentials;
      return createGraphClientFromResolver(egress, tokenCache, resolver, undefined, clientDiagnostics);
    },
  };
}
