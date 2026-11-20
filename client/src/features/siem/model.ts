import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import type { Tone } from "@/ui";

type Inputs = inferRouterInputs<AppRouter>;
type Outputs = inferRouterOutputs<AppRouter>;
export type Destination = Outputs["siem"]["admin"]["destinations"]["get"];
export type SiemHealthComponent = Outputs["siem"]["admin"]["health"]["components"][number];
export type SiemHealthState = SiemHealthComponent["state"];
export type Quarantined = Outputs["siem"]["admin"]["deadLetters"]["list"]["items"][number];
export type AuditItem = Outputs["audit"]["search"]["items"][number];
export type TestResult = Outputs["siem"]["admin"]["destinations"]["test"];
export type DestinationInput = Inputs["siem"]["admin"]["destinations"]["create"];
export type Secrets = NonNullable<DestinationInput["secrets"]>;

export const BASE = "/admin/siem";
export const ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const FORMATS: Record<Destination["format"], string> = {
  syslog_rfc5425: "RFC 5424 syslog over TLS (RFC 5425)",
  cef_tls: "CEF over TLS",
  jsonl_tls: "JSON Lines over TLS",
  otlp_https: "OTLP over HTTPS",
};
export const CATEGORIES: Record<Destination["categories"][number], string> = {
  security: "Security", business: "Business", admin: "Administration", system: "System", file: "Files",
  integration: "Integrations", job: "Jobs", backup: "Backup", portable_transfer: "Portable transfers", release: "Releases",
};
export const SEVERITIES = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const satisfies readonly Destination["minSeverity"][];
export const categoryKeys = Object.keys(CATEGORIES) as (keyof typeof CATEGORIES)[];
export const receipt = {
  none: "No receipt recorded",
  transport_accepted: "Accepted by transport, not confirmed indexed",
  collector_2xx: "Collector HTTP acceptance, not confirmed indexed",
} satisfies Record<TestResult["receiptConfirmation"], string>;
export function auditLink(id: string) {
  return `/admin/audit?${new URLSearchParams({ correlationId: id })}`;
}

export const SIEM_HEALTH_META: Record<SiemHealthState, { label: string; tone: Tone }> = {
  ok: { label: "Healthy", tone: "success" },
  degraded: { label: "Degraded", tone: "warning" },
  failing: { label: "Failing", tone: "danger" },
  disabled: { label: "Disabled", tone: "neutral" },
  not_configured: { label: "Not configured", tone: "warning" },
};

export const SIEM_COMPONENT_TITLES: Record<string, string> = {
  "siem.delivery": "Delivery status",
};

export const SIEM_METRIC_LABELS: Record<string, string> = {
  configuredDestinations: "Configured destinations",
  enabledDestinations: "Enabled destinations",
  queueDepth: "Queue depth",
  deadLetters: "Dead letters",
  oldestPendingAgeSeconds: "Oldest pending (age)",
  maxLagSeq: "Max sequence lag",
  maxCursorLagAgeSeconds: "Max cursor lag (age)",
  missingAuditGaps: "Missing audit gaps",
  prunedAuditEvents: "Pruned audit events",
};

const DURATION_SECOND_METRICS = new Set(["oldestPendingAgeSeconds", "maxCursorLagAgeSeconds"]);

export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatAgeSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 s";
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded} s`;
  const minutes = Math.floor(rounded / 60);
  const remSeconds = rounded % 60;
  if (minutes < 60) return remSeconds > 0 ? `${minutes} min ${remSeconds} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 48) return remMinutes > 0 ? `${hours} h ${remMinutes} min` : `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export function siemComponentTitle(component: string): string {
  return SIEM_COMPONENT_TITLES[component] ?? humanizeKey(component);
}

export function formatSiemMetric(key: string, value: number): { label: string; display: string } {
  const label = SIEM_METRIC_LABELS[key] ?? humanizeKey(key);
  const display = DURATION_SECOND_METRICS.has(key) ? formatAgeSeconds(value) : value.toLocaleString();
  return { label, display };
}
