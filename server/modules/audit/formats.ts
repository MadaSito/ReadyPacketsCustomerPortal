/**
 * Evidence export encoders: JSONL, CSV (formula-injection safe), CEF (escaped per ArcSight CEF rules).
 * Owner: audit engineer. Pure functions — no I/O.
 */
import type { AuditEnvelope, ExternalAuditEvent } from "./envelope.js";
import { projectForExternal } from "./envelope.js";

export const EXPORT_FORMATS = ["jsonl", "csv", "cef"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_PROFILES = ["external", "local"] as const;
/** `external` = privacy projection (default). `local` adds installation-local refs (user id, resource id, session ref). */
export type ExportProfile = (typeof EXPORT_PROFILES)[number];

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  jsonl: "application/x-ndjson",
  csv: "text/csv",
  cef: "text/plain",
};

type Exported = ExternalAuditEvent & Partial<Pick<AuditEnvelope, "actor_user_id" | "resource_public_id" | "session_ref">>;

export function exportRecord(envelope: AuditEnvelope, profile: ExportProfile): Exported {
  const external = projectForExternal(envelope);
  if (profile === "external") return external;
  return { ...external, actor_user_id: envelope.actor_user_id, resource_public_id: envelope.resource_public_id, session_ref: envelope.session_ref };
}

export function toJsonLine(record: Exported): string {
  // JSON.stringify escapes control characters and U+2028/2029 are escaped explicitly for line safety.
  return `${JSON.stringify(record).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`;
}

/* -------------------------------------------------------------------- CSV */

export const CSV_COLUMNS = [
  "event_id",
  "occurred_at",
  "observed_at",
  "severity_text",
  "category",
  "event_name",
  "action",
  "outcome",
  "reason_code",
  "actor_role",
  "actor_ref",
  "resource_type",
  "resource_ref",
  "request_id",
  "trace_id",
  "correlation_id",
  "job_id",
  "package_id",
  "provider",
  "duration_ms",
  "source_address_class",
  "release_ref",
  "chain_seq",
  "attributes",
  "safe_counts",
] as const;

/** OWASP CSV injection: neutralise cells starting with = + - @ TAB CR (and full-width variants); RFC 4180 quoting. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[ \u00A0]*[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text) || text !== text.trim()) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvHeader(profile: ExportProfile): string {
  const extra = profile === "local" ? ["actor_user_id", "resource_public_id", "session_ref"] : [];
  return `${[...CSV_COLUMNS, ...extra].join(",")}\r\n`;
}

export function toCsvRow(record: Exported, profile: ExportProfile): string {
  const cols: string[] = [...CSV_COLUMNS, ...(profile === "local" ? ["actor_user_id", "resource_public_id", "session_ref"] : [])];
  return `${cols.map((c) => csvCell((record as unknown as Record<string, unknown>)[c])).join(",")}\r\n`;
}

/* -------------------------------------------------------------------- CEF */

export const CEF_SEVERITY: Record<string, number> = { TRACE: 0, DEBUG: 1, INFO: 3, WARN: 6, ERROR: 8, FATAL: 10 };

/** Header fields: escape backslash and pipe; strip newlines. */
export function cefHeader(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/** Extension values: escape backslash and equals; encode CR/LF as \r \n. */
export function cefValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/=/g, "\\=").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

export function toCefLine(record: Exported, version: string): string {
  const ext: [string, string | number | null][] = [
    ["rt", Date.parse(record.occurred_at)],
    ["externalId", record.event_id],
    ["cat", record.category],
    ["act", record.action],
    ["outcome", record.outcome],
    ["reason", record.reason_code],
    ["cs1Label", "actorRef"],
    ["cs1", record.actor_ref],
    ["cs2Label", "actorRole"],
    ["cs2", record.actor_role],
    ["cs3Label", "resource"],
    ["cs3", record.resource_type ? `${record.resource_type}:${record.resource_ref ?? ""}` : null],
    ["cs4Label", "requestId"],
    ["cs4", record.request_id],
    ["cs5Label", "correlationId"],
    ["cs5", record.correlation_id],
    ["cs6Label", "traceId"],
    ["cs6", record.trace_id],
    ["cn1Label", "chainSeq"],
    ["cn1", record.chain_seq],
  ];
  const extension = ext
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${cefValue(String(v))}`)
    .join(" ");
  const severity = CEF_SEVERITY[record.severity_text] ?? 3;
  return `CEF:0|${cefHeader("ReadyPackets")}|${cefHeader("Portal")}|${cefHeader(version)}|${cefHeader(record.event_name)}|${cefHeader(record.event_name)}|${severity}|${extension}\n`;
}

export function encodeRecord(format: ExportFormat, record: Exported, profile: ExportProfile, version: string): string {
  switch (format) {
    case "jsonl":
      return toJsonLine(record);
    case "csv":
      return toCsvRow(record, profile);
    case "cef":
      return toCefLine(record, version);
  }
}
