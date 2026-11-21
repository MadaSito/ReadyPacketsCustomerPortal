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
  type GraphMailTestResult,
  type GraphReadiness,
} from "./types.js";

const MAIL_ADMIN_CAPABILITIES: readonly Capability[] = ["integrations.manage", "mail.manage"];

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
  async function isGraphPresetEnabled(): Promise<boolean> {
    const presets = await egress.listPresets();
    const graphPreset = presets.find((p) => p.key === "microsoft_graph");
    return Boolean(graphPreset?.enabled);
  }

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
  );

  async function resolveEffectiveMailSenderOutsideTx(cfg: GraphConfigSetting): Promise<MailSenderIdentity | null> {
    const sharedStore = await readSharedMailSenderFromStore(deps.settings);
    const getShared = deps.services.jobAdmin?.getMailSenderIdentity;
    let jobSender: MailSenderIdentity | null = null;
    if (!sharedStore && typeof getShared === "function") {
      const candidate = await getShared.call(deps.services.jobAdmin);
      if (isValidSender(candidate)) jobSender = candidate;
    }
    if (cfg.senderMailbox && safeEmailAddressSchema.safeParse(cfg.senderMailbox).success) {
      const base = sharedStore ?? jobSender;
      return {
        fromAddress: cfg.senderMailbox.trim(),
        fromName: base?.fromName || "ReadyPackets Portal",
        ...(base?.replyToAddress ? { replyToAddress: base.replyToAddress } : {}),
      };
    }
    if (sharedStore) return sharedStore;
    if (jobSender) return jobSender;
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

  async function loadConfigView(includeJobAdminSender = false): Promise<GraphConfigView> {
    const [enabled, cfg, secretConfigured, presetEnabled, sharedInStore, smtpCfg, check] = await Promise.all([
      readIntegrationFlag(deps.settings, INTEGRATIONS_GRAPH_FLAG),
      readSetting(deps.settings, INTEGRATIONS_GRAPH_CONFIG),
      isSecretConfigured(deps.settings, INTEGRATIONS_GRAPH_CLIENT_SECRET),
      isGraphPresetEnabled(),
      readSharedMailSenderFromStore(deps.settings),
      readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG),
      checks.get("graph"),
    ]);

    let hasSender =
      safeEmailAddressSchema.safeParse(cfg.senderMailbox).success ||
      Boolean(sharedInStore) ||
      safeEmailAddressSchema.safeParse(smtpCfg.fromAddress).success;

    if (!hasSender && includeJobAdminSender && typeof deps.services.jobAdmin?.getMailSenderIdentity === "function") {
      const fromJobAdmin = await deps.services.jobAdmin.getMailSenderIdentity();
      hasSender = isValidSender(fromJobAdmin);
    }

    const credentialsReady = isCompleteGraphCredentials(cfg, secretConfigured);
    const configured = credentialsReady && hasSender && presetEnabled;
    const derived = deriveGraphState(enabled, configured, presetEnabled, credentialsReady, check);

    return {
      enabled,
      configured,
      verified: derived.verified,
      state: derived.state,
      summary: derived.summary,
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      clientSecretConfigured: secretConfigured,
      clientSecretLast4: secretConfigured ? (cfg.clientSecretLast4 ?? null) : null,
      senderMailbox: cfg.senderMailbox,
      egressPresetEnabled: presetEnabled,
      egressReady: presetEnabled,
      lastCheckedAt: check?.lastCheckedAt ?? null,
      lastOutcome: check?.lastOutcome ?? null,
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

        const hasSender =
          safeEmailAddressSchema.safeParse(nextSenderMailbox).success ||
          Boolean(sharedSender) ||
          safeEmailAddressSchema.safeParse(smtpCfg.fromAddress).success;

        const complete = isCompleteGraphCredentials(nextCfg, nextHasSecret) && hasSender && presetEnabled;
        if (input.enabled && !complete) {
          if (!presetEnabled) {
            throw validation(
              "GRAPH_EGRESS_PRESET_REQUIRED",
              "Enable the Microsoft Graph outbound egress preset before enabling Microsoft Graph delivery.",
            );
          }
          throw validation(
            "GRAPH_CONFIG_INCOMPLETE",
            "Complete the single-tenant directory GUID, client GUID, client secret, and sender mailbox before enabling Microsoft Graph.",
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

        const fallbackSender: MailSenderIdentity | null =
          sharedSender ??
          (safeEmailAddressSchema.safeParse(smtpCfg.fromAddress).success
            ? {
                fromAddress: smtpCfg.fromAddress.trim(),
                fromName: smtpCfg.fromName.trim() || "ReadyPackets Portal",
                ...(smtpCfg.replyToAddress.trim() ? { replyToAddress: smtpCfg.replyToAddress.trim() } : {}),
              }
            : null);

        const resolvedMailbox =
          cfg.senderMailbox && safeEmailAddressSchema.safeParse(cfg.senderMailbox).success
            ? cfg.senderMailbox.trim()
            : (fallbackSender?.fromAddress ?? "");

        if (!secret || !isCompleteGraphCredentials(cfg, true) || !resolvedMailbox) {
          throw new DomainError(
            "NOT_CONFIGURED",
            "GRAPH_NOT_CONFIGURED",
            "Save complete Microsoft Graph credentials and a sender mailbox before sending a test message.",
          );
        }
        if (!presetEnabled) {
          throw new DomainError(
            "FORBIDDEN",
            "GRAPH_EGRESS_PRESET_REQUIRED",
            "Enable the Microsoft Graph outbound egress preset before sending a test message.",
          );
        }

        const effectiveSender: MailSenderIdentity = {
          fromAddress: resolvedMailbox,
          fromName: fallbackSender?.fromName || "ReadyPackets Portal",
          ...(fallbackSender?.replyToAddress ? { replyToAddress: fallbackSender.replyToAddress } : {}),
        };

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
        await testClient.request({
          method: "POST",
          path: `/users/${encodeURIComponent(mailbox)}/sendMail`,
          body,
        });
        outcome = "accepted";
        reasonCode = "GRAPH_MAIL_ACCEPTED";
        safeMessage =
          "Microsoft Graph accepted the test message to your administrator address over verified TLS (transport acceptance, not inbox delivery proof).";
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
      const effectiveSender = await resolveEffectiveMailSenderOutsideTx(cfg);
      return effectiveSender !== null;
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

      const mailbox =
        cfg.senderMailbox && safeEmailAddressSchema.safeParse(cfg.senderMailbox).success
          ? cfg.senderMailbox.trim()
          : message.sender.fromAddress.trim();

      if (!safeEmailAddressSchema.safeParse(mailbox).success) {
        return { outcome: "rejected", retryable: false, safeDetail: "graph_invalid_sender_mailbox" };
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
        );
        await scopedClient.request({
          method: "POST",
          path: `/users/${encodeURIComponent(mailbox)}/sendMail`,
          body,
          signal: message.signal,
        });
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
      return createGraphClientFromResolver(egress, tokenCache, resolver);
    },
  };
}
