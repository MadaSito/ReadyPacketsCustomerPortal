/** Platform console client model. Types mirror the server; labels are presentation only. */
import type { HealthReport, SetupChecklistItem, SetupChecklistId } from "@server/modules/platform/index";
import type { SettingView } from "@server/modules/platform/settingsStore";
import type { ImportPreview } from "@server/modules/platform/configTransfer";
import type { PresentationImageSummary } from "@server/modules/platform/presentation";
import type { HealthState } from "@server/core/types";
import type { OperationState } from "@shared/domain";
import type { Tone } from "@/ui";

export type { HealthReport, ImportPreview, PresentationImageSummary, SettingView, SetupChecklistItem };

export const GROUP_LABELS: Record<string, string> = {
  general: "General",
  presentation: "Sign-in presentation",
  security: "Security",
  identity: "Identity and sign-in",
  mail: "Email",
  integrations: "Integrations",
  observability: "Logging and SIEM",
  backup: "Backup",
  jobs: "Background jobs",
  files: "Files",
  orders: "Orders",
  engagement: "Messages and support",
  compliance: "Compliance",
  portable: "Portable transfer",
  analytics: "Analytics",
  features: "Features",
};
export const groupLabel = (group: string): string => GROUP_LABELS[group] ?? group.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export const HEALTH_META: Record<HealthState, { label: string; tone: Tone }> = {
  ok: { label: "Healthy", tone: "success" },
  degraded: { label: "Degraded", tone: "warning" },
  failing: { label: "Failing", tone: "danger" },
  disabled: { label: "Disabled", tone: "neutral" },
  not_configured: { label: "Not configured", tone: "warning" },
};

export const CHECKLIST_LABELS: Record<SetupChecklistId, string> = {
  admin_exists: "Administrator account",
  mfa_enforced: "Multi-factor authentication enforced",
  canonical_origin: "Canonical HTTPS address",
  keys_distinct: "Distinct encryption and signing keys",
  schema: "Database schema up to date",
  smtp: "Outgoing email (SMTP)",
  backups: "Backups",
  siem: "SIEM / syslog forwarding",
};

export const CHECKLIST_META: Record<SetupChecklistItem["state"], { label: string; state: OperationState }> = {
  complete: { label: "Complete", state: "completed" },
  incomplete: { label: "Action needed", state: "failed" },
  not_configured: { label: "Not configured", state: "refused" },
  unknown: { label: "Unknown", state: "unknown" },
};

/** Editor kind derived from the current/default value (the server re-validates with the declared schema). */
export type EditorKind = "boolean" | "number" | "text" | "json";
export function editorKind(view: Pick<SettingView, "value" | "defaultValue">): EditorKind {
  const sample = view.value ?? view.defaultValue;
  if (typeof sample === "boolean") return "boolean";
  if (typeof sample === "number") return "number";
  if (typeof sample === "string") return "text";
  return "json";
}

/** Short human display of a non-secret value. */
export function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number" || typeof value === "string") return String(value);
  const json = JSON.stringify(value);
  return json.length > 80 ? `${json.slice(0, 77)}…` : json;
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };
export function parseEditorValue(kind: EditorKind, raw: string | boolean): ParseResult {
  if (kind === "boolean") return { ok: true, value: Boolean(raw) };
  const text = String(raw);
  if (kind === "number") {
    if (text.trim() === "" || !Number.isFinite(Number(text))) return { ok: false, error: "Enter a number." };
    return { ok: true, value: Number(text) };
  }
  if (kind === "text") return { ok: true, value: text };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "Enter valid JSON." };
  }
}

/** Strength hint only — the server enforces the real passphrase policy. */
export const MIN_PASSPHRASE = 12;
