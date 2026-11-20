/**
 * Outbound SMTP Service (`services.integrations.smtp`).
 *
 * Security invariants:
 *  - Off by default; never reports `"ok"` in health unless a real TLS check/delivery succeeded.
 *  - Connects ONLY to the pinned IP returned by `egress.assertAllowed(..., "smtp")`, passing the
 *    verified hostname as TLS SNI `servername` with `minVersion: "TLSv1.2"` and `rejectUnauthorized: true`.
 *  - Plaintext SMTP (`ignoreTLS`, `port 25` without TLS, unauthenticated open relay unless credentials set)
 *    is refused.
 *  - Rejects CR/LF/NUL control characters across `from`, `replyTo`, `to` and `subject` (header-injection safe).
 *  - Network/DNS/SMTP I/O never runs inside a database transaction.
 */
import nodemailer from "nodemailer";
import type { ModuleDeps } from "../../container.js";
import { DomainError, validation } from "../../core/errors.js";
import type { SessionPrincipal } from "../../core/types.js";
import { isSecretConfigured, readSecret, readSetting, writeSetting } from "../platform/index.js";
import { flagKey } from "../platform/settingsRegistry.js";
import { assertIntegrationsManageInTx, assertIntegrationsManagePreflight } from "./authz.js";
import type { EgressPolicy, PinnedEgressTarget } from "./egress.js";
import type { ProviderChecksStore } from "./providerChecks.js";
import { readIntegrationFlag } from "./settings.js";
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
  fromAddress: string;
  fromName: string;
  replyToAddress?: string;
}

export interface SmtpSendInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  signal: AbortSignal;
}

export interface SmtpSendResult {
  outcome: "accepted" | "not_configured" | "rejected" | "unknown";
  retryable?: boolean;
}

export interface SmtpTestResult {
  outcome: "accepted" | "rejected" | "unknown";
  reasonCode: string;
  safeMessage: string;
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
  updateConfig(principal: SessionPrincipal, input: UpdateSmtpConfigInput): Promise<SmtpConfigView>;
  sendTestMessage(principal: SessionPrincipal, input: { toAddress: string }): Promise<SmtpTestResult>;
  send(input: SmtpSendInput): Promise<SmtpSendResult>;
}

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

function isCompleteSmtpConfig(cfg: SmtpConfigSetting, hasPassword: boolean): boolean {
  return (
    cfg.host.trim().length > 0 &&
    cfg.port >= 1 &&
    cfg.port <= 65535 &&
    cfg.port !== 25 &&
    cfg.username.trim().length > 0 &&
    hasPassword &&
    safeEmailAddressSchema.safeParse(cfg.fromAddress).success
  );
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

function classifyNodemailerError(error: unknown): {
  outcome: "rejected" | "unknown";
  retryable?: boolean;
  reasonCode: string;
} {
  const err = error as { code?: string; responseCode?: number; command?: string } | null;
  const responseCode = typeof err?.responseCode === "number" ? err.responseCode : undefined;
  const code = typeof err?.code === "string" ? err.code : "";
  const command = typeof err?.command === "string" ? err.command.toUpperCase() : "";

  // Post-DATA timeout or reset leaves delivery outcome genuinely uncertain!
  if (command === "DATA" && (code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNRESET")) {
    return { outcome: "unknown", reasonCode: "SMTP_DATA_OUTCOME_UNKNOWN" };
  }

  // Definite pre-delivery TLS / auth / connect failures
  if (code === "EAUTH" || (responseCode !== undefined && responseCode === 535)) {
    return { outcome: "rejected", retryable: false, reasonCode: "SMTP_AUTH_REJECTED" };
  }
  if (code === "ESOCKET" || code === "ECONNECTION" || code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    if (command === "" || command === "CONN" || command === "EHLO" || command === "STARTTLS") {
      return { outcome: "rejected", retryable: true, reasonCode: "SMTP_CONNECT_FAILED" };
    }
    return { outcome: "unknown", reasonCode: "SMTP_TRANSPORT_UNCERTAIN" };
  }
  if (code.includes("CERT") || code.includes("TLS") || code.includes("SSL")) {
    return { outcome: "rejected", retryable: false, reasonCode: "SMTP_TLS_VALIDATION_FAILED" };
  }

  if (responseCode !== undefined) {
    if (responseCode >= 500 && responseCode < 600) {
      return { outcome: "rejected", retryable: false, reasonCode: "SMTP_PERMANENT_REJECTION" };
    }
    if (responseCode >= 400 && responseCode < 500) {
      return { outcome: "rejected", retryable: true, reasonCode: "SMTP_TRANSIENT_REJECTION" };
    }
  }

  return { outcome: "unknown", reasonCode: "SMTP_OUTCOME_UNKNOWN" };
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
    // Defense-in-depth: refuse port 25 or invalid TLS framing immediately before dialing even if settings were seeded/restored directly.
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

  async function loadConfigView(): Promise<SmtpConfigView> {
    const [enabled, cfg, passwordConfigured, check] = await Promise.all([
      readIntegrationFlag(deps.settings, INTEGRATIONS_SMTP_FLAG),
      readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG),
      isSecretConfigured(deps.settings, INTEGRATIONS_SMTP_PASSWORD),
      checks.get("smtp"),
    ]);
    const configured = isCompleteSmtpConfig(cfg, passwordConfigured);
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
      fromAddress: cfg.fromAddress,
      fromName: cfg.fromName,
      replyToAddress: cfg.replyToAddress,
      lastCheckedAt: check?.lastCheckedAt ?? null,
      lastOutcome: check?.lastOutcome ?? null,
    };
  }

  return {
    async getReadiness(): Promise<SmtpReadiness> {
      const view = await loadConfigView();
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
      return loadConfigView();
    },

    async updateConfig(principal, input): Promise<SmtpConfigView> {
      const now = deps.clock.now();
      assertIntegrationsManagePreflight(principal, now);

      const host = input.host.trim();
      const username = input.username.trim();
      const fromAddress = input.fromAddress.trim();
      const fromName = input.fromName.trim();
      const replyToAddress = (input.replyToAddress ?? "").trim();

      precheckSmtpPortAndTls(input.port, input.tlsMode);

      if (host !== "" && !hasNoHeaderInjection(host)) {
        throw validation("INVALID_SMTP_HOST", "The SMTP host contains invalid characters.");
      }
      if (username !== "" && !hasNoHeaderInjection(username)) {
        throw validation("INVALID_SMTP_USERNAME", "The SMTP username contains invalid characters.");
      }
      if (fromName !== "" && !hasNoHeaderInjection(fromName)) {
        throw validation("INVALID_FROM_NAME", "The sender display name contains invalid control characters.");
      }
      if (fromAddress !== "") {
        const parsedFrom = safeEmailAddressSchema.safeParse(fromAddress);
        if (!parsedFrom.success) {
          throw validation("INVALID_FROM_ADDRESS", "Enter a valid sender email address.");
        }
      }
      if (replyToAddress !== "") {
        const parsedReplyTo = safeEmailAddressSchema.safeParse(replyToAddress);
        if (!parsedReplyTo.success) {
          throw validation("INVALID_REPLY_TO", "Enter a valid reply-to email address.");
        }
      }
      if (input.password !== undefined && input.password !== null) {
        if (input.password.length === 0 || input.password.length > 1024 || !hasNoHeaderInjection(input.password)) {
          throw validation("INVALID_SMTP_PASSWORD", "Enter a valid SMTP password (1–1024 characters).");
        }
      }

      // If a non-empty host is supplied, validate it against egress policy BEFORE opening the DB transaction!
      if (host !== "") {
        const protocol = input.tlsMode === "implicit" ? "smtps:" : "smtp:";
        await egress.assertAllowed({ host, port: input.port, protocol }, "smtp");
      }

      await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);

        const prevCfg = await readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG, tx);
        const prevHasPassword = await isSecretConfigured(deps.settings, INTEGRATIONS_SMTP_PASSWORD, tx);

        const nextHasPassword =
          input.password === null
            ? false
            : typeof input.password === "string"
              ? true
              : prevHasPassword;

        const nextCfg: SmtpConfigSetting = {
          host,
          port: input.port,
          tlsMode: input.tlsMode,
          username,
          fromAddress,
          fromName: fromName || "ReadyPackets Portal",
          replyToAddress,
        };

        const complete = isCompleteSmtpConfig(nextCfg, nextHasPassword);
        if (input.enabled && !complete) {
          throw validation(
            "SMTP_CONFIG_INCOMPLETE",
            "Complete the SMTP host, port, TLS mode, username, password and sender address before enabling SMTP.",
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

      return loadConfigView();
    },

    async sendTestMessage(principal, input): Promise<SmtpTestResult> {
      const startedAt = deps.clock.now();
      assertIntegrationsManagePreflight(principal, startedAt);

      const parsedTo = safeEmailAddressSchema.safeParse(input.toAddress);
      if (!parsedTo.success) {
        throw validation("INVALID_RECIPIENT", "Enter a valid recipient email address for the test message.");
      }

      // Phase 1: Short authoritative DB transaction BEFORE revealing secrets or opening network sockets.
      // Re-validates the actor + session + fresh step-up under lock and persists a durable `attempted` audit row.
      const { cfg, password } = await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);
        const storedCfg = await readSetting(deps.settings, INTEGRATIONS_SMTP_CONFIG, tx);
        precheckSmtpPortAndTls(storedCfg.port, storedCfg.tlsMode);
        const storedPassword = await readSecret(deps.settings, INTEGRATIONS_SMTP_PASSWORD, tx);
        if (!storedPassword || !isCompleteSmtpConfig(storedCfg, true)) {
          throw new DomainError(
            "NOT_CONFIGURED",
            "SMTP_NOT_CONFIGURED",
            "Save complete SMTP settings and credentials before sending a test message.",
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
        return { cfg: storedCfg, password: storedPassword };
      });

      let outcome: "accepted" | "rejected" | "unknown";
      let reasonCode: string;
      let safeMessage: string;

      try {
        const { options } = await buildPinnedTransportOptions(cfg, password);
        const transport = transportFactory(options);
        try {
          const info = await transport.sendMail({
            from: cfg.fromName ? { name: cfg.fromName, address: cfg.fromAddress } : cfg.fromAddress,
            replyTo: cfg.replyToAddress || undefined,
            to: parsedTo.data,
            subject: "ReadyPackets Portal — SMTP TLS Verification",
            text: "This is a synthetic administrative test message verifying ReadyPackets outbound SMTP over TLS.",
            html: "<p>This is a synthetic administrative test message verifying ReadyPackets outbound SMTP over TLS.</p>",
          });
          const acceptedCount = Array.isArray(info.accepted) ? info.accepted.length : 0;
          if (acceptedCount > 0) {
            outcome = "accepted";
            reasonCode = "SMTP_ACCEPTED";
            safeMessage = "The SMTP server accepted the test message over verified TLS (transport acceptance, not inbox delivery proof).";
          } else {
            outcome = "rejected";
            reasonCode = "SMTP_NO_RECIPIENT_ACCEPTED";
            safeMessage = "The SMTP server did not accept the recipient address.";
          }
        } finally {
          transport.close?.();
        }
      } catch (error) {
        if (error instanceof DomainError) {
          outcome = "rejected";
          reasonCode = error.reasonCode;
          safeMessage = error.safeMessage;
        } else {
          const classified = classifyNodemailerError(error);
          outcome = classified.outcome;
          reasonCode = classified.reasonCode;
          safeMessage =
            outcome === "unknown"
              ? "The SMTP connection closed ambiguously; delivery outcome is unknown."
              : "The SMTP server refused the TLS connection, credentials, or test message.";
        }
      }

      const finishedAt = deps.clock.now();
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
      const checkOutcome = outcome === "accepted" ? "succeeded" : outcome === "rejected" ? "failed" : "unknown";

      // Phase 3: Persist truthful check outcome and completion audit row (authorization already committed in Phase 1).
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
        durationMs,
        checkedAt: finishedAt,
      };
    },

    async send(input: SmtpSendInput): Promise<SmtpSendResult> {
      if (input.signal.aborted) {
        return { outcome: "rejected", retryable: true };
      }

      // Header injection defense on caller-supplied recipient and subject
      if (!safeEmailAddressSchema.safeParse(input.to).success || !hasNoHeaderInjection(input.subject)) {
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

      if (!enabled || !password || !isCompleteSmtpConfig(cfg, true)) {
        return { outcome: "not_configured" };
      }

      try {
        const { options } = await buildPinnedTransportOptions(cfg, password);
        if (input.signal.aborted) {
          return { outcome: "rejected", retryable: true };
        }
        const transport = transportFactory(options);
        const onAbort = () => transport.close?.();
        input.signal.addEventListener("abort", onAbort, { once: true });
        try {
          const info = await transport.sendMail({
            from: cfg.fromName ? { name: cfg.fromName, address: cfg.fromAddress } : cfg.fromAddress,
            replyTo: cfg.replyToAddress || undefined,
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
        } finally {
          input.signal.removeEventListener("abort", onAbort);
          transport.close?.();
        }
      } catch (error) {
        if (error instanceof DomainError) {
          const retryable = error.code === "UNAVAILABLE";
          await checks.recordOutcome("smtp", "failed", error.reasonCode).catch(() => {});
          return { outcome: "rejected", retryable };
        }
        const classified = classifyNodemailerError(error);
        await checks
          .recordOutcome("smtp", classified.outcome === "unknown" ? "unknown" : "failed", classified.reasonCode)
          .catch(() => {});
        return classified.outcome === "unknown"
          ? { outcome: "unknown" }
          : { outcome: "rejected", retryable: classified.retryable };
      }
    },
  };
}
