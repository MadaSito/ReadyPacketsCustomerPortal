/**
 * Outbound SMTP Service (`services.integrations.smtp`).
 *
 * Security invariants:
 *  - Off by default; never reports `"ok"` in health unless a real TLS check/delivery succeeded.
 *  - Connects ONLY to the pinned IP returned by `egress.assertAllowed(..., "smtp")`, passing the
 *    verified hostname as TLS SNI `servername` with `minVersion: "TLSv1.2"` and `rejectUnauthorized: true`.
 *  - Plaintext SMTP (`ignoreTLS`, `port 25` without TLS, unauthenticated open relay) is refused.
 *  - Rejects Unicode/ASCII control characters (`CR`/`LF`/`NUL`/`U+2028`/`U+2029`) across `sender`, `to`,
 *    and `subject` (header-injection safe).
 *  - `sendTestMessage` delivers ONLY to the signed-in administrator's own email address (§2.C).
 *  - Network/DNS/SMTP I/O never runs inside a database transaction.
 */
import nodemailer from "nodemailer";
import type { Capability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden, validation } from "../../core/errors.js";
import type { SessionPrincipal, SettingsStore, Tx } from "../../core/types.js";
import { isSecretConfigured, readSecret, readSetting, writeSetting } from "../platform/index.js";
import { flagKey } from "../platform/settingsRegistry.js";
import { assertAdminStepUpAnyInTx, assertAdminStepUpAnyPreflight } from "./authz.js";
import type { EgressPolicy, PinnedEgressTarget } from "./egress.js";
import type { ProviderChecksStore } from "./providerChecks.js";
import { extractSecretLast4, readIntegrationFlag } from "./settings.js";
import {
  hasNoHeaderInjection,
  INTEGRATIONS_SMTP_CONFIG,
  INTEGRATIONS_SMTP_FLAG,
  INTEGRATIONS_SMTP_PASSWORD,
  precheckSmtpPortAndTls,
  safeEmailAddressSchema,
  type SmtpConfigSetting,
} from "./smtpHelpers.js";

export type ProviderState = "disabled" | "not_configured" | "configured" | "degraded" | "failing";

export interface SmtpSenderIdentity {
  fromAddress: string;
  fromName: string;
  replyToAddress?: string;
}

export interface SmtpReadiness {
  enabled: boolean;
  configured: boolean;
  verified: boolean;
  ready: boolean;
  state: ProviderState;
  summary: string;
}

export interface SmtpConfigView {
  enabled: boolean;
  configured: boolean;
  verified: boolean;
  state: ProviderState;
  summary: string;
  host: string;
  port: number;
  tlsMode: "starttls" | "implicit";
  username: string;
  passwordConfigured: boolean;
  passwordLast4: string | null;
  fromAddress: string;
  fromName: string;
  replyToAddress: string;
  lastCheckedAt: Date | null;
  lastOutcome: "succeeded" | "failed" | "unknown" | null;
}

export interface UpdateSmtpConfigInput {
  enabled: boolean;
  host: string;
  port: number;
  tlsMode: "starttls" | "implicit";
  username: string;
  /** Omit or `undefined` to keep existing password; `null` to clear; non-empty string to replace. */
  password?: string | null;
  fromAddress?: string;
  fromName?: string;
  replyToAddress?: string;
}

export interface SmtpSendInput {
  sender?: SmtpSenderIdentity;
  to: string;
  subject: string;
  text: string;
  html: string;
  signal: AbortSignal;
}

export interface SmtpSendResult {
  outcome: "accepted" | "not_configured" | "rejected" | "unknown";
  retryable?: boolean;
  safeDetail?: string;
}

export interface SmtpTestResult {
  outcome: "accepted" | "rejected" | "unknown";
  reasonCode: string;
  safeMessage: string;
  recipientAddress: string;
  durationMs: number;
  checkedAt: Date;
}

export interface SmtpTransportConnectionOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  ignoreTLS: false;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  tls: {
    minVersion: "TLSv1.2";
    rejectUnauthorized: true;
    servername?: string;
  };
}

export interface SmtpTransportMessage {
  from: string | { name: string; address: string };
  replyTo?: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SmtpTransportAdapter {
  sendMail(message: SmtpTransportMessage): Promise<{ accepted?: unknown[]; rejected?: unknown[] }>;
  close?(): void;
}

export type SmtpTransportFactory = (options: SmtpTransportConnectionOptions) => SmtpTransportAdapter;

export interface SmtpService {
  getReadiness(): Promise<SmtpReadiness>;
  getConfig(): Promise<SmtpConfigView>;
  getDefaultSender(): Promise<SmtpSenderIdentity | null>;
  updateConfig(principal: SessionPrincipal, input: UpdateSmtpConfigInput): Promise<SmtpConfigView>;
  sendTestMessage(principal: SessionPrincipal, input?: { toAddress?: string }): Promise<SmtpTestResult>;
  send(input: SmtpSendInput): Promise<SmtpSendResult>;
}

const MAIL_ADMIN_CAPABILITIES: readonly Capability[] = ["integrations.manage", "mail.manage"];

const defaultTransportFactory: SmtpTransportFactory = (options) =>
  nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    requireTLS: options.requireTLS,
    ignoreTLS: options.ignoreTLS,
    auth: options.auth,
    connectionTimeout: options.connectionTimeout,
    greetingTimeout: options.greetingTimeout,
    socketTimeout: options.socketTimeout,
    tls: options.tls,
  });

function isCompleteSmtpEndpoint(cfg: SmtpConfigSetting, hasPassword: boolean): boolean {
  return (
    cfg.host.trim().length > 0 &&
    cfg.port >= 1 &&
    cfg.port <= 65535 &&
    cfg.port !== 25 &&
    cfg.username.trim().length > 0 &&
    hasPassword
  );
}

function isValidSenderIdentity(sender: SmtpSenderIdentity | null | undefined): sender is SmtpSenderIdentity {
  if (!sender) return false;
  if (!safeEmailAddressSchema.safeParse(sender.fromAddress).success) return false;
  if (sender.fromName !== "" && !hasNoHeaderInjection(sender.fromName)) return false;
  if (sender.replyToAddress && sender.replyToAddress !== "") {
    if (!safeEmailAddressSchema.safeParse(sender.replyToAddress).success) return false;
  }
  return true;
}

function legacySenderFromCfg(cfg: SmtpConfigSetting): SmtpSenderIdentity | null {
  if (!safeEmailAddressSchema.safeParse(cfg.fromAddress).success) return null;
  if (cfg.fromName !== "" && !hasNoHeaderInjection(cfg.fromName)) return null;
  const reply = cfg.replyToAddress.trim();
  if (reply !== "" && !safeEmailAddressSchema.safeParse(reply).success) return null;
  return {
    fromAddress: cfg.fromAddress.trim(),
    fromName: cfg.fromName.trim(),
    ...(reply !== "" ? { replyToAddress: reply } : {}),
  };
}

/**
 * Reads `jobs.mail.sender` directly from `SettingsStore` (preserving `tx` and avoiding any cross-module
 * recursion with `jobAdmin.getMailSenderIdentity()`, which reads `smtp.getConfig()` for legacy fallback).
 */
export async function readSharedMailSenderFromStore(
  settings: SettingsStore,
  tx?: Tx,
): Promise<SmtpSenderIdentity | null> {
  const raw = await settings.get<Record<string, unknown> | null>(
    "jobs.mail.sender",
    (val) => (typeof val === "object" && val !== null ? (val as Record<string, unknown>) : null),
    null,
    tx,
  );
  if (!raw || typeof raw.fromAddress !== "string" || raw.fromAddress.trim() === "") {
    return null;
  }
  const candidate: SmtpSenderIdentity = {
    fromAddress: raw.fromAddress.trim(),
    fromName: typeof raw.fromName === "string" ? raw.fromName.trim() : "",
    ...(typeof raw.replyToAddress === "string" && raw.replyToAddress.trim() !== ""
      ? { replyToAddress: raw.replyToAddress.trim() }
      : {}),
  };
  return isValidSenderIdentity(candidate) ? candidate : null;
}

export async function resolveAdminSelfEmail(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  suppliedToAddress?: string,
  tx?: Tx,
): Promise<string> {
  const getUser = deps.services.identity?.getUser;
  if (typeof getUser !== "function") {
    throw forbidden("ACTOR_UNVERIFIABLE");
  }
  const actor = await getUser.call(deps.services.identity, principal.userId, tx ? { tx } : undefined);
  if (!actor || actor.status !== "active" || !safeEmailAddressSchema.safeParse(actor.email).success) {
    throw forbidden("ACTOR_UNVERIFIABLE");
  }
  const adminEmail = actor.email.trim();
  if (suppliedToAddress !== undefined && suppliedToAddress.trim() !== "") {
    if (suppliedToAddress.trim().toLowerCase() !== adminEmail.toLowerCase()) {
      throw new DomainError(
        "FORBIDDEN",
        "TEST_RECIPIENT_MUST_BE_SELF",
        "Administrative test messages can be sent only to your own signed-in administrator email address.",
      );
    }
  }
  return adminEmail;
}

function deriveSmtpState(
  enabled: boolean,
  configured: boolean,
  port: number,
  check: Awaited<ReturnType<ProviderChecksStore["get"]>>,
): { state: ProviderState; verified: boolean; summary: string } {
  if (port === 25) {
    return {
      state: "failing",
      verified: false,
      summary: "Plaintext SMTP port 25 is forbidden; configure TLS on port 587 or 465.",
    };
  }
  if (!configured) {
    return {
      state: "not_configured",
      verified: false,
      summary: "SMTP transport is not configured — off by default.",
    };
  }
  if (!enabled) {
    return {
      state: "disabled",
      verified: Boolean(check?.verifiedAt),
      summary: "SMTP settings are saved, but outbound SMTP delivery is disabled.",
    };
  }
  if (!check) {
    return {
      state: "configured",
      verified: false,
      summary: "SMTP is configured; run a test message to verify live TLS connectivity.",
    };
  }
  if (check.lastOutcome === "succeeded") {
    return {
      state: "configured",
      verified: true,
      summary: "SMTP TLS transport verified at last check.",
    };
  }
  if (check.lastOutcome === "unknown") {
    return {
      state: "degraded",
      verified: Boolean(check.verifiedAt),
      summary: "Last SMTP delivery attempt ended with an uncertain network outcome.",
    };
  }
  return {
    state: "failing",
    verified: false,
    summary: "Last SMTP connection or authentication check failed.",
  };
}

const DEFINITIVE_PRECONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EDNS",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

const AFFIRMATIVE_PRE_DATA_COMMANDS = new Set(["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL FROM", "RCPT TO"]);

function classifyNodemailerError(error: unknown): {
  outcome: "rejected" | "unknown";
  retryable?: boolean;
  reasonCode: string;
  safeDetail: string;
} {
  const err = error as { code?: string; responseCode?: number; command?: string } | null;
  const responseCode = typeof err?.responseCode === "number" ? err.responseCode : undefined;
  const code = typeof err?.code === "string" ? err.code.toUpperCase() : "";
  const command = typeof err?.command === "string" ? err.command.trim().toUpperCase() : "";

  if (command === "DATA" && (code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNRESET" || code === "EPIPE")) {
    return {
      outcome: "unknown",
      reasonCode: "SMTP_DATA_OUTCOME_UNKNOWN",
      safeDetail: "smtp_data_outcome_unknown",
    };
  }

  if (code === "EAUTH" || (responseCode !== undefined && responseCode === 535)) {
    return {
      outcome: "rejected",
      retryable: false,
      reasonCode: "SMTP_AUTH_REJECTED",
      safeDetail: "smtp_auth_rejected",
    };
  }

  if (code.includes("CERT") || code.includes("TLS") || code.includes("SSL")) {
    return {
      outcome: "rejected",
      retryable: false,
      reasonCode: "SMTP_TLS_VALIDATION_FAILED",
      safeDetail: "smtp_tls_validation_failed",
    };
  }

  // Definitive OS/DNS pre-connect failures never established an SMTP session.
  if (DEFINITIVE_PRECONNECT_CODES.has(code) && command !== "DATA") {
    return {
      outcome: "rejected",
      retryable: true,
      reasonCode: "SMTP_CONNECT_FAILED",
      safeDetail: "smtp_connect_failed",
    };
  }

  // Generic socket/timeout errors are rejected ONLY when Nodemailer affirmatively reports a pre-DATA command phase.
  // Absent (`""`) or DATA/QUIT command phase is treated fail-closed as `unknown` so failover never duplicates mail.
  if (code === "ESOCKET" || code === "ECONNECTION" || code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EPIPE") {
    if (command !== "" && AFFIRMATIVE_PRE_DATA_COMMANDS.has(command)) {
      return {
        outcome: "rejected",
        retryable: true,
        reasonCode: "SMTP_CONNECT_FAILED",
        safeDetail: "smtp_connect_failed",
      };
    }
    return {
      outcome: "unknown",
      reasonCode: "SMTP_TRANSPORT_UNCERTAIN",
      safeDetail: "smtp_transport_uncertain",
    };
  }

  if (responseCode !== undefined) {
    if (responseCode >= 500 && responseCode < 600) {
      return {
        outcome: "rejected",
        retryable: false,
        reasonCode: "SMTP_PERMANENT_REJECTION",
        safeDetail: "smtp_permanent_rejection",
      };
    }
    if (responseCode >= 400 && responseCode < 500) {
      return {
        outcome: "rejected",
        retryable: true,
        reasonCode: "SMTP_TRANSIENT_REJECTION",
        safeDetail: "smtp_transient_rejection",
      };
    }
  }

  return {
    outcome: "unknown",
    reasonCode: "SMTP_OUTCOME_UNKNOWN",
    safeDetail: "smtp_outcome_unknown",
  };
}

export function createSmtpService(
  deps: ModuleDeps,
  egress: EgressPolicy,
  checks: ProviderChecksStore,
  transportFactory: SmtpTransportFactory = defaultTransportFactory,
): SmtpService {
  async function buildPinnedTransportOptions(
    cfg: SmtpConfigSetting,
    password: string,
  ): Promise<{ pinned: PinnedEgressTarget; options: SmtpTransportConnectionOptions }> {
    precheckSmtpPortAndTls(cfg.port, cfg.tlsMode);
    const protocol = cfg.tlsMode === "implicit" ? "smtps:" : "smtp:";
    const pinned = await egress.assertAllowed({ host: cfg.host, port: cfg.port, protocol }, "smtp");
    const options: SmtpTransportConnectionOptions = {
      host: pinned.address,
      port: pinned.port,
      secure: cfg.tlsMode === "implicit",
      requireTLS: true,
      ignoreTLS: false,
      auth: {
        user: cfg.username,
        pass: password,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      tls: {
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        servername: pinned.servername,
      },
    };
    return { pinned, options };
  }

  async function resolveEffectiveSenderOutsideTx(cfg: SmtpConfigSetting): Promise<SmtpSenderIdentity | null> {
    const storeShared = await readSharedMailSenderFromStore(deps.settings);
    if (storeShared) return storeShared;
    const legacy = legacySenderFromCfg(cfg);
    if (legacy) return legacy;
    const getShared = deps.services.jobAdmin?.getMailSenderIdentity;
    if (typeof getShared === "function") {
      const fromJobAdmin = await getShared.call(deps.services.jobAdmin);
      if (isValidSenderIdentity(fromJobAdmin)) return fromJobAdmin;
    }
    return null;
  }

  async function loadConfigView(includeJobAdminSender = false): Promise<SmtpConfigView> {
    const [enabled, cfg, passwordConfigured, sharedInStore, check] = await Promise.all([
      readIntegrationFlag(deps.settings, INTEGRATIONS_SMTP_FLAG),
      readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG),
      isSecretConfigured(deps.settings, INTEGRATIONS_SMTP_PASSWORD),
      readSharedMailSenderFromStore(deps.settings),
      checks.get("smtp"),
    ]);
    let hasValidSender = Boolean(sharedInStore || legacySenderFromCfg(cfg));
    if (!hasValidSender && includeJobAdminSender && typeof deps.services.jobAdmin?.getMailSenderIdentity === "function") {
      const jobSender = await deps.services.jobAdmin.getMailSenderIdentity();
      hasValidSender = isValidSenderIdentity(jobSender);
    }
    const configured = isCompleteSmtpEndpoint(cfg, passwordConfigured) && hasValidSender;
    const derived = deriveSmtpState(enabled, configured, cfg.port, check);
    return {
      enabled,
      configured,
      verified: derived.verified,
      state: derived.state,
      summary: derived.summary,
      host: cfg.host,
      port: cfg.port,
      tlsMode: cfg.tlsMode,
      username: cfg.username,
      passwordConfigured,
      passwordLast4: passwordConfigured ? (cfg.passwordLast4 ?? null) : null,
      fromAddress: cfg.fromAddress,
      fromName: cfg.fromName,
      replyToAddress: cfg.replyToAddress,
      lastCheckedAt: check?.lastCheckedAt ?? null,
      lastOutcome: check?.lastOutcome ?? null,
    };
  }

  return {
    async getReadiness(): Promise<SmtpReadiness> {
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

    getConfig(): Promise<SmtpConfigView> {
      // Never call `jobAdmin.getMailSenderIdentity()` here so `jobs` legacy sender fallback cannot recurse.
      return loadConfigView(false);
    },

    async getDefaultSender(): Promise<SmtpSenderIdentity | null> {
      const cfg = await readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG);
      return legacySenderFromCfg(cfg);
    },

    async updateConfig(principal, input): Promise<SmtpConfigView> {
      const now = deps.clock.now();
      assertAdminStepUpAnyPreflight(principal, now, MAIL_ADMIN_CAPABILITIES);

      const host = input.host.trim();
      const username = input.username.trim();
      const suppliedFromAddress = input.fromAddress !== undefined ? input.fromAddress.trim() : undefined;
      const suppliedFromName = input.fromName !== undefined ? input.fromName.trim() : undefined;
      const suppliedReplyTo = input.replyToAddress !== undefined ? input.replyToAddress.trim() : undefined;

      precheckSmtpPortAndTls(input.port, input.tlsMode);

      if (host !== "" && !hasNoHeaderInjection(host)) {
        throw validation("INVALID_SMTP_HOST", "The SMTP host contains invalid characters.");
      }
      if (username !== "" && !hasNoHeaderInjection(username)) {
        throw validation("INVALID_SMTP_USERNAME", "The SMTP username contains invalid characters.");
      }
      if (suppliedFromName !== undefined && suppliedFromName !== "" && !hasNoHeaderInjection(suppliedFromName)) {
        throw validation("INVALID_FROM_NAME", "The sender display name contains invalid control characters.");
      }
      if (suppliedFromAddress !== undefined && suppliedFromAddress !== "") {
        if (!safeEmailAddressSchema.safeParse(suppliedFromAddress).success) {
          throw validation("INVALID_FROM_ADDRESS", "Enter a valid sender email address.");
        }
      }
      if (suppliedReplyTo !== undefined && suppliedReplyTo !== "") {
        if (!safeEmailAddressSchema.safeParse(suppliedReplyTo).success) {
          throw validation("INVALID_REPLY_TO", "Enter a valid reply-to email address.");
        }
      }
      if (input.password !== undefined && input.password !== null) {
        if (input.password.length === 0 || input.password.length > 1024 || !hasNoHeaderInjection(input.password)) {
          throw validation("INVALID_SMTP_PASSWORD", "Enter a valid SMTP password (1–1024 characters).");
        }
      }

      if (host !== "") {
        const protocol = input.tlsMode === "implicit" ? "smtps:" : "smtp:";
        await egress.assertAllowed({ host, port: input.port, protocol }, "smtp");
      }

      await deps.db.transaction(async (tx) => {
        await assertAdminStepUpAnyInTx(deps, principal, tx, MAIL_ADMIN_CAPABILITIES);

        const prevCfg = await readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG, tx);
        const prevHasPassword = await isSecretConfigured(deps.settings, INTEGRATIONS_SMTP_PASSWORD, tx);
        const sharedSender = await readSharedMailSenderFromStore(deps.settings, tx);

        const nextHasPassword =
          input.password === null
            ? false
            : typeof input.password === "string"
              ? true
              : prevHasPassword;

        const nextPasswordLast4 =
          input.password === null
            ? null
            : typeof input.password === "string"
              ? extractSecretLast4(input.password)
              : (prevCfg.passwordLast4 ?? null);

        const nextFromAddress = suppliedFromAddress !== undefined ? suppliedFromAddress : prevCfg.fromAddress;
        const nextFromName =
          suppliedFromName !== undefined ? suppliedFromName || "ReadyPackets Portal" : prevCfg.fromName;
        const nextReplyTo = suppliedReplyTo !== undefined ? suppliedReplyTo : prevCfg.replyToAddress;

        const nextCfg: SmtpConfigSetting = {
          host,
          port: input.port,
          tlsMode: input.tlsMode,
          username,
          fromAddress: nextFromAddress,
          fromName: nextFromName || "ReadyPackets Portal",
          replyToAddress: nextReplyTo,
          passwordLast4: nextPasswordLast4,
        };

        const hasSender = Boolean(sharedSender || legacySenderFromCfg(nextCfg));
        const complete = isCompleteSmtpEndpoint(nextCfg, nextHasPassword) && hasSender;
        if (input.enabled && !complete) {
          throw validation(
            "SMTP_CONFIG_INCOMPLETE",
            "Complete the SMTP host, port, TLS mode, username, password, and sender identity before enabling SMTP.",
          );
        }

        await writeSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG, nextCfg, tx);
        if (input.password !== undefined) {
          await deps.settings.setSecret(INTEGRATIONS_SMTP_PASSWORD.key, input.password, tx);
        }
        await deps.settings.set(flagKey(INTEGRATIONS_SMTP_FLAG.flag), input.enabled, tx);

        const endpointChanged =
          prevCfg.host !== nextCfg.host ||
          prevCfg.port !== nextCfg.port ||
          prevCfg.tlsMode !== nextCfg.tlsMode ||
          prevCfg.username !== nextCfg.username ||
          input.password !== undefined;

        if (endpointChanged) {
          await checks.clearVerification("smtp", tx);
        }

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.smtp.updated",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            provider: "smtp",
            resource: { type: "integration_provider", publicId: "smtp" },
            attributes: {
              enabled: input.enabled,
              port: nextCfg.port,
              tls_mode: nextCfg.tlsMode,
              password_updated: input.password !== undefined,
              configured: complete,
            },
          },
          tx,
        );
      });

      return loadConfigView(false);
    },

    async sendTestMessage(principal, input): Promise<SmtpTestResult> {
      const startedAt = deps.clock.now();
      assertAdminStepUpAnyPreflight(principal, startedAt, MAIL_ADMIN_CAPABILITIES);

      const { cfg, password, sender, recipientAddress } = await deps.db.transaction(async (tx) => {
        await assertAdminStepUpAnyInTx(deps, principal, tx, MAIL_ADMIN_CAPABILITIES);
        const selfEmail = await resolveAdminSelfEmail(deps, principal, input?.toAddress, tx);
        const storedCfg = await readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG, tx);
        precheckSmtpPortAndTls(storedCfg.port, storedCfg.tlsMode);
        const storedPassword = await readSecret(deps.settings, INTEGRATIONS_SMTP_PASSWORD, tx);
        const sharedSender = await readSharedMailSenderFromStore(deps.settings, tx);
        const effectiveSender = sharedSender ?? legacySenderFromCfg(storedCfg);
        if (!storedPassword || !isCompleteSmtpEndpoint(storedCfg, true) || !effectiveSender) {
          throw new DomainError(
            "NOT_CONFIGURED",
            "SMTP_NOT_CONFIGURED",
            "Save complete SMTP settings, credentials, and a sender identity before sending a test message.",
          );
        }
        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.smtp.test_attempted",
            action: "test",
            outcome: "attempted",
            severity: "INFO",
            provider: "smtp",
            resource: { type: "integration_provider", publicId: "smtp" },
            attributes: {
              port: storedCfg.port,
              tls_mode: storedCfg.tlsMode,
            },
          },
          tx,
        );
        return { cfg: storedCfg, password: storedPassword, sender: effectiveSender, recipientAddress: selfEmail };
      });

      let outcome: "accepted" | "rejected" | "unknown";
      let reasonCode: string;
      let safeMessage: string;

      let pinnedOptions: SmtpTransportConnectionOptions | null = null;
      try {
        const built = await buildPinnedTransportOptions(cfg, password);
        pinnedOptions = built.options;
      } catch (error) {
        outcome = "rejected";
        reasonCode = error instanceof DomainError ? error.reasonCode : "SMTP_PRECHECK_FAILED";
        safeMessage =
          error instanceof DomainError
            ? error.safeMessage
            : "The outbound egress check failed before dialing the SMTP server.";
      }

      if (pinnedOptions !== null) {
        const transport = transportFactory(pinnedOptions);
        try {
          const info = await transport.sendMail({
            from: sender.fromName ? { name: sender.fromName, address: sender.fromAddress } : sender.fromAddress,
            replyTo: sender.replyToAddress || undefined,
            to: recipientAddress,
            subject: "ReadyPackets Portal — SMTP TLS Verification",
            text: "This is a synthetic administrative test message verifying ReadyPackets outbound SMTP over TLS.",
            html: "<p>This is a synthetic administrative test message verifying ReadyPackets outbound SMTP over TLS.</p>",
          });
          const acceptedCount = Array.isArray(info.accepted) ? info.accepted.length : 0;
          if (acceptedCount > 0) {
            outcome = "accepted";
            reasonCode = "SMTP_ACCEPTED";
            safeMessage =
              "The SMTP server accepted the test message to your administrator address over verified TLS (transport acceptance, not inbox delivery proof).";
          } else {
            outcome = "rejected";
            reasonCode = "SMTP_NO_RECIPIENT_ACCEPTED";
            safeMessage = "The SMTP server did not accept the recipient address.";
          }
        } catch (error) {
          const classified = classifyNodemailerError(error);
          outcome = classified.outcome;
          reasonCode = classified.reasonCode;
          safeMessage =
            outcome === "unknown"
              ? "The SMTP connection closed ambiguously; delivery outcome is unknown."
              : "The SMTP server refused the TLS connection, credentials, or test message.";
        } finally {
          transport.close?.();
        }
      } else {
        outcome = "rejected";
        reasonCode = reasonCode!;
        safeMessage = safeMessage!;
      }

      const finishedAt = deps.clock.now();
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
      const checkOutcome = outcome === "accepted" ? "succeeded" : outcome === "rejected" ? "failed" : "unknown";

      await deps.db.transaction(async (tx) => {
        await checks.recordOutcome("smtp", checkOutcome, reasonCode, tx);
        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.smtp.tested",
            action: "test",
            outcome: outcome === "accepted" ? "completed" : outcome === "rejected" ? "failed" : "unknown",
            severity: outcome === "accepted" ? "INFO" : "WARN",
            reasonCode,
            provider: "smtp",
            durationMs,
            resource: { type: "integration_provider", publicId: "smtp" },
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

    async send(input: SmtpSendInput): Promise<SmtpSendResult> {
      if (input.signal.aborted) {
        return { outcome: "rejected", retryable: true };
      }

      if (!safeEmailAddressSchema.safeParse(input.to).success || !hasNoHeaderInjection(input.subject)) {
        return { outcome: "rejected", retryable: false };
      }

      if (input.sender !== undefined && !isValidSenderIdentity(input.sender)) {
        return { outcome: "rejected", retryable: false };
      }

      const [enabled, cfg, password] = await Promise.all([
        readIntegrationFlag(deps.settings, INTEGRATIONS_SMTP_FLAG),
        readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG),
        readSecret(deps.settings, INTEGRATIONS_SMTP_PASSWORD),
      ]);

      if (cfg.port === 25) {
        await checks.recordOutcome("smtp", "failed", "SMTP_PORT_25_FORBIDDEN").catch(() => {});
        return { outcome: "rejected", retryable: false };
      }

      const effectiveSender = input.sender ?? (await resolveEffectiveSenderOutsideTx(cfg));
      if (!enabled || !password || !isCompleteSmtpEndpoint(cfg, true) || !effectiveSender) {
        return { outcome: "not_configured" };
      }

      let options: SmtpTransportConnectionOptions;
      try {
        ({ options } = await buildPinnedTransportOptions(cfg, password));
      } catch (error) {
        if (error instanceof DomainError) {
          const retryable = error.code === "UNAVAILABLE";
          await checks.recordOutcome("smtp", "failed", error.reasonCode).catch(() => {});
          return { outcome: "rejected", retryable };
        }
        await checks.recordOutcome("smtp", "failed", "SMTP_PRECHECK_FAILED").catch(() => {});
        return { outcome: "rejected", retryable: false };
      }

      if (input.signal.aborted) {
        return { outcome: "rejected", retryable: true };
      }

      const transport = transportFactory(options);
      const onAbort = () => transport.close?.();
      input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const info = await transport.sendMail({
          from: effectiveSender.fromName
            ? { name: effectiveSender.fromName, address: effectiveSender.fromAddress }
            : effectiveSender.fromAddress,
          replyTo: effectiveSender.replyToAddress || undefined,
          to: input.to.trim(),
          subject: input.subject,
          text: input.text,
          html: input.html,
        });
        const acceptedCount = Array.isArray(info.accepted) ? info.accepted.length : 0;
        if (acceptedCount > 0) {
          await checks.recordOutcome("smtp", "succeeded", "SMTP_ACCEPTED").catch(() => {});
          return { outcome: "accepted" };
        }
        await checks.recordOutcome("smtp", "failed", "SMTP_NO_RECIPIENT_ACCEPTED").catch(() => {});
        return { outcome: "rejected", retryable: false };
      } catch (error) {
        const classified = classifyNodemailerError(error);
        await checks
          .recordOutcome("smtp", classified.outcome === "unknown" ? "unknown" : "failed", classified.reasonCode)
          .catch(() => {});
        return classified.outcome === "unknown"
          ? { outcome: "unknown" }
          : { outcome: "rejected", retryable: classified.retryable };
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        transport.close?.();
      }
    },
  };
}
