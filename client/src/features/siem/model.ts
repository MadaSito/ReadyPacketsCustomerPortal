import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";

type Inputs = inferRouterInputs<AppRouter>;
type Outputs = inferRouterOutputs<AppRouter>;
export type Destination = Outputs["siem"]["admin"]["destinations"]["get"];
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
