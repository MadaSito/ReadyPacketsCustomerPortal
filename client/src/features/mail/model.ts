/**
 * Client-side domain types, validation rules, and human-friendly status labels
 * for Package E: E-mail delivery administration (`client/src/features/mail/**`).
 */
import type { Tone } from "@/ui";

export const EMAIL_DELIVERY_PATH = "/admin/email-delivery" as const;

export type MailTransportKey = "smtp" | "graph";
export type MailSecondaryTransportKey = "none" | MailTransportKey;
export type ProviderState = "disabled" | "not_configured" | "configured" | "degraded" | "failing";
export type ProviderTestOutcome = "accepted" | "rejected" | "unknown";
export type LastCheckOutcome = "succeeded" | "failed" | "unknown";

export const MAIL_SETTING_KEYS = {
  sender: "jobs.mail.sender",
  routing: "jobs.mail.routing",
  auditCopy: "jobs.mail.audit_copy",
  retainContent: "jobs.mail.retain_content",
  retentionDays: "jobs.mail.retention_days",
} as const;

export interface MailSenderSetting {
  fromAddress: string;
  fromName: string;
  replyToAddress: string;
}

export interface MailRoutingSetting {
  primary: MailTransportKey;
  secondary: MailSecondaryTransportKey;
}

export interface MailAuditCopySetting {
  enabled: boolean;
  address: string;
}

export interface PlatformSettingRow {
  key: string;
  label: string;
  description: string;
  group: string;
  kind: "value" | "secret";
  value?: unknown;
  configured?: boolean;
  invalidStored?: boolean;
  version: number;
  updatedAt: Date | string | null;
}

export interface SmtpConfigView {
  enabled: boolean;
  configured: boolean;
  verified: boolean;
  state: ProviderState;
  summary: string;
  host: string | null;
  port: number | null;
  tlsMode: "starttls" | "implicit" | null;
  username: string | null;
  passwordConfigured: boolean;
  fromAddress: string | null;
  fromName: string | null;
  replyToAddress: string | null;
  lastCheckedAt: Date | string | null;
  lastOutcome: LastCheckOutcome | null;
}

export interface SmtpUpdateInput {
  enabled: boolean;
  host: string;
  port: number;
  tlsMode: "starttls" | "implicit";
  username: string;
  password?: string | null;
  fromAddress?: string;
  fromName?: string;
  replyToAddress?: string;
}

export interface GraphMailConfigView {
  enabled: boolean;
  configured: boolean;
  verified: boolean;
  state: ProviderState;
  summary: string;
  tenantId: string;
  clientId: string;
  clientSecretConfigured: boolean;
  clientSecretLast4: string | null;
  senderMailbox: string;
  egressPresetEnabled: boolean;
  egressReady: boolean;
  lastCheckedAt: Date | string | null;
  lastOutcome: LastCheckOutcome | null;
  mailboxRestrictionNote: string;
}

export interface GraphMailUpdateInput {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecret?: string | null;
  senderMailbox: string;
  egressPresetEnabled?: boolean;
}

export interface MailTransportTestResult {
  outcome: ProviderTestOutcome;
  reasonCode?: string;
  safeMessage: string;
  durationMs?: number;
  checkedAt: Date | string;
}

export interface AuditCopyVerificationStatus {
  verified: boolean;
}

export const TRANSPORT_LABELS: Record<MailTransportKey, string> = {
  smtp: "SMTP relay",
  graph: "Microsoft Graph",
};

export const SECONDARY_TRANSPORT_OPTIONS: ReadonlyArray<{ value: MailSecondaryTransportKey; label: string }> = [
  { value: "none", label: "None (do not fail over)" },
  { value: "smtp", label: "SMTP relay" },
  { value: "graph", label: "Microsoft Graph" },
];

export const LAST_OUTCOME_LABELS: Record<LastCheckOutcome, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  unknown: "Unknown outcome (not confirmed)",
};

export const TEST_OUTCOME_META: Record<ProviderTestOutcome, { tone: "success" | "danger" | "warning"; title: string }> = {
  accepted: { tone: "success", title: "Transport accepted the test message" },
  rejected: { tone: "danger", title: "Transport refused the test message" },
  unknown: { tone: "warning", title: "Outcome unknown — the transport did not confirm acceptance" },
};

export function providerBadgeMeta(state: ProviderState, verified: boolean): { label: string; tone: Tone } {
  switch (state) {
    case "configured":
      return verified
        ? { label: "Configured", tone: "success" }
        : { label: "Configured — not yet verified", tone: "info" };
    case "degraded":
      return { label: "Configured — degraded", tone: "warning" };
    case "failing":
      return { label: "Configured — failing", tone: "danger" };
    case "disabled":
      return { label: "Not configured (switched off)", tone: "neutral" };
    case "not_configured":
    default:
      return { label: "Not configured", tone: "neutral" };
  }
}

const EMAIL_RE = /^[^\s@\p{C}]+@[^\s@\p{C}]+\.[^\s@\p{C}]+$/u;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_TENANTS = new Set(["common", "organizations", "consumers"]);

export function hasControlChars(value: string): boolean {
  return /[\r\n\0\p{C}]/u.test(value);
}

export function isValidEmailAddress(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 254 && !hasControlChars(trimmed) && EMAIL_RE.test(trimmed);
}

export function isValidHostname(value: string): boolean {
  return HOST_RE.test(value.trim());
}

export function isValidEntraGuid(value: string): { ok: true } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (FORBIDDEN_TENANTS.has(trimmed.toLowerCase())) {
    return { ok: false, message: "Multi-tenant aliases (common, organizations, consumers) are not allowed. Enter a single-tenant GUID." };
  }
  if (!GUID_RE.test(trimmed)) {
    return { ok: false, message: "Enter a valid Microsoft Entra GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)." };
  }
  return { ok: true };
}

export function readSenderSetting(rows: readonly PlatformSettingRow[]): { row?: PlatformSettingRow; value: MailSenderSetting } {
  const row = rows.find((item) => item.key === MAIL_SETTING_KEYS.sender);
  const raw = (row?.value && typeof row.value === "object" ? row.value : {}) as Record<string, unknown>;
  return {
    row,
    value: {
      fromAddress: typeof raw.fromAddress === "string" ? raw.fromAddress : "",
      fromName: typeof raw.fromName === "string" ? raw.fromName : "",
      replyToAddress: typeof raw.replyToAddress === "string" ? raw.replyToAddress : "",
    },
  };
}

export function readRoutingSetting(rows: readonly PlatformSettingRow[]): { row?: PlatformSettingRow; value: MailRoutingSetting } {
  const row = rows.find((item) => item.key === MAIL_SETTING_KEYS.routing);
  const raw = (row?.value && typeof row.value === "object" ? row.value : {}) as Record<string, unknown>;
  const primary: MailTransportKey = raw.primary === "graph" ? "graph" : "smtp";
  const secondary: MailSecondaryTransportKey =
    raw.secondary === "smtp" || raw.secondary === "graph" ? raw.secondary : "none";
  return { row, value: { primary, secondary } };
}

export function readAuditCopySetting(rows: readonly PlatformSettingRow[]): { row?: PlatformSettingRow; value: MailAuditCopySetting } {
  const row = rows.find((item) => item.key === MAIL_SETTING_KEYS.auditCopy);
  const raw = (row?.value && typeof row.value === "object" ? row.value : {}) as Record<string, unknown>;
  return {
    row,
    value: {
      enabled: raw.enabled === true,
      address: typeof raw.address === "string" ? raw.address : "",
    },
  };
}

export function readRetentionSettings(rows: readonly PlatformSettingRow[]): {
  retainRow?: PlatformSettingRow;
  daysRow?: PlatformSettingRow;
  retainContent: boolean;
  retentionDays: number;
} {
  const retainRow = rows.find((item) => item.key === MAIL_SETTING_KEYS.retainContent);
  const daysRow = rows.find((item) => item.key === MAIL_SETTING_KEYS.retentionDays);
  const retainContent = retainRow?.value === true;
  const retentionDays =
    typeof daysRow?.value === "number" && Number.isInteger(daysRow.value) && daysRow.value >= 0 && daysRow.value <= 90
      ? daysRow.value
      : 30;
  return { retainRow, daysRow, retainContent, retentionDays };
}
