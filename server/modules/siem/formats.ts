import type { Severity } from "../../core/types.js";
import {
  computeSyslogPri,
  formatRfc3339UtcMs,
  frameOctetCounted,
  neutralizeControls,
  otelSeverityToSyslog,
  sanitizePrintUsAscii,
  truncateUtf8Buffer,
} from "./rfc5424.js";
import type { ExternalAuditEvent } from "./types.js";

const CEF_SEVERITY_BY_OTEL: Record<Severity, number> = {
  TRACE: 1,
  DEBUG: 2,
  INFO: 3,
  WARN: 6,
  ERROR: 8,
  FATAL: 10,
};

/**
 * Serializes a projected `ExternalAuditEvent` as a single JSON Lines record (`\n`-delimited UTF-8)
 * with Unicode line separators escaped so each event occupies strictly one line.
 */
export function formatJsonlRecord(event: ExternalAuditEvent, maxMessageBytes = 16_384): Buffer {
  const json = JSON.stringify(event)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const lineBytes = Buffer.from(`${json}\n`, "utf8");
  if (lineBytes.byteLength <= maxMessageBytes) return lineBytes;

  // Safe fallback if attributes pushed JSON past maxMessageBytes: emit minimal valid JSONL envelope.
  const minimal = JSON.stringify({
    schema_version: event.schema_version,
    event_id: event.event_id,
    chain_seq: event.chain_seq,
    occurred_at: event.occurred_at,
    severity_text: event.severity_text,
    severity_number: event.severity_number,
    category: event.category,
    event_name: event.event_name,
    action: event.action,
    outcome: event.outcome,
    reason_code: event.reason_code,
    installation_ref: event.installation_ref,
    truncated: true,
  });
  return Buffer.from(`${minimal}\n`, "utf8");
}

export function escapeCefHeaderField(raw: string): string {
  const escaped = raw.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  return neutralizeControls(escaped);
}

export function escapeCefExtensionValue(raw: string): string {
  const escaped = raw.replace(/\\/g, "\\\\").replace(/=/g, "\\=");
  return neutralizeControls(escaped);
}

export interface CefFormatOptions {
  facility?: number;
  hostname?: string | null;
  appName?: string | null;
  maxMessageBytes?: number;
}

/**
 * Formats a projected `ExternalAuditEvent` as Common Event Format (`CEF:0|...`) inside an RFC 5424
 * syslog envelope framed with RFC 5425 octet-counting. Never includes raw IPs, emails, or numeric user IDs.
 */
export function formatCefSyslogFrame(
  event: ExternalAuditEvent,
  options: CefFormatOptions = {},
): { cefText: string; syslogText: string; frameBytes: Buffer } {
  const facility = options.facility ?? 16;
  const pri = computeSyslogPri(facility, otelSeverityToSyslog(event.severity_text));
  const ts = formatRfc3339UtcMs(event.occurred_at);
  const hostname = sanitizePrintUsAscii(options.hostname ?? event.installation_ref, 255);
  const appName = sanitizePrintUsAscii(options.appName ?? "readypackets", 48);
  const msgId = sanitizePrintUsAscii(event.event_name, 32);

  const cefSeverity = CEF_SEVERITY_BY_OTEL[event.severity_text] ?? 3;
  const occurredMs = Date.parse(event.occurred_at);
  const extPairs: [string, string][] = [
    ["externalId", event.event_id],
    ["rt", Number.isFinite(occurredMs) ? String(occurredMs) : event.occurred_at],
    ["cat", event.category],
    ["act", event.action],
    ["outcome", event.outcome],
    ["spriv", event.actor_role],
  ];
  if (event.reason_code) extPairs.push(["reason", event.reason_code]);
  if (event.actor_ref) extPairs.push(["suid", event.actor_ref]);
  if (event.correlation_id) {
    extPairs.push(["cs1", event.correlation_id], ["cs1Label", "correlationId"]);
  }
  if (event.trace_id) {
    extPairs.push(["cs2", event.trace_id], ["cs2Label", "traceId"]);
  }
  if (event.resource_ref) {
    extPairs.push(["cs3", event.resource_ref], ["cs3Label", "resourceRef"]);
  }
  if (event.chain_seq !== null) {
    extPairs.push(["cn1", String(event.chain_seq)], ["cn1Label", "chainSeq"]);
  }

  const ext = extPairs.map(([k, v]) => `${k}=${escapeCefExtensionValue(v)}`).join(" ");
  const cefHeader = [
    "CEF:0",
    escapeCefHeaderField("ReadyPackets"),
    escapeCefHeaderField(event.service || "Portal"),
    escapeCefHeaderField(event.release_ref || "1.0"),
    escapeCefHeaderField(event.event_name),
    escapeCefHeaderField(`${event.action}:${event.outcome}`),
    String(cefSeverity),
  ].join("|");

  const cefText = `${cefHeader}|${ext}`;
  const maxMessageBytes = Math.min(65_536, Math.max(480, options.maxMessageBytes ?? 8192));
  const fullSyslog = `<${pri}>1 ${ts} ${hostname} ${appName} - ${msgId} - ${cefText}`;
  const syslogBytes = truncateUtf8Buffer(Buffer.from(fullSyslog, "utf8"), maxMessageBytes);
  return {
    cefText,
    syslogText: syslogBytes.toString("utf8"),
    frameBytes: frameOctetCounted(syslogBytes),
  };
}

function isoToUnixNanoString(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "0";
  return (BigInt(ms) * 1_000_000n).toString(10);
}

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  boolValue?: boolean;
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

function toOtlpAnyValue(val: string | number | boolean): OtlpAnyValue {
  if (typeof val === "boolean") return { boolValue: val };
  if (typeof val === "number") {
    if (Number.isSafeInteger(val)) return { intValue: String(val) };
    return { stringValue: String(val) };
  }
  return { stringValue: neutralizeControls(val) };
}

/**
 * Formats a batch of projected `ExternalAuditEvent` items into OTLP/HTTP JSON (`ExportLogsServiceRequest`).
 */
export function formatOtlpLogsPayload(events: readonly ExternalAuditEvent[]): Buffer {
  const first = events[0];
  const resourceAttrs: OtlpKeyValue[] = [
    { key: "service.name", value: { stringValue: first?.service ?? "portal" } },
    { key: "service.version", value: { stringValue: first?.release_ref ?? "unknown" } },
    { key: "service.instance.id", value: { stringValue: first?.installation_ref ?? "unknown" } },
    { key: "deployment.environment.name", value: { stringValue: first?.deployment_profile ?? "production" } },
  ];

  const logRecords = events.map((event) => {
    const attributes: OtlpKeyValue[] = [
      { key: "event.id", value: { stringValue: event.event_id } },
      { key: "event.name", value: { stringValue: event.event_name } },
      { key: "rp.category", value: { stringValue: event.category } },
      { key: "rp.action", value: { stringValue: event.action } },
      { key: "rp.outcome", value: { stringValue: event.outcome } },
      { key: "rp.actor_role", value: { stringValue: event.actor_role } },
      { key: "rp.origin", value: { stringValue: event.origin } },
    ];
    if (event.chain_seq !== null) attributes.push({ key: "rp.chain_seq", value: { intValue: String(event.chain_seq) } });
    if (event.reason_code) attributes.push({ key: "rp.reason_code", value: { stringValue: event.reason_code } });
    if (event.actor_ref) attributes.push({ key: "rp.actor_ref", value: { stringValue: event.actor_ref } });
    if (event.resource_type) attributes.push({ key: "rp.resource_type", value: { stringValue: event.resource_type } });
    if (event.resource_ref) attributes.push({ key: "rp.resource_ref", value: { stringValue: event.resource_ref } });
    if (event.source_address_class) {
      attributes.push({ key: "rp.source_address_class", value: { stringValue: event.source_address_class } });
    }
    if (event.request_id) attributes.push({ key: "rp.request_id", value: { stringValue: event.request_id } });
    if (event.correlation_id) {
      attributes.push({ key: "rp.correlation_id", value: { stringValue: event.correlation_id } });
    }
    for (const [k, v] of Object.entries(event.safe_counts)) {
      attributes.push({ key: `rp.count.${k}`, value: { intValue: String(v) } });
    }
    for (const [k, v] of Object.entries(event.attributes)) {
      if (v !== null) attributes.push({ key: `rp.attr.${k}`, value: toOtlpAnyValue(v) });
    }

    const record: Record<string, unknown> = {
      timeUnixNano: isoToUnixNanoString(event.occurred_at),
      observedTimeUnixNano: isoToUnixNanoString(event.observed_at),
      severityNumber: event.severity_number,
      severityText: event.severity_text,
      body: { stringValue: event.event_name },
      attributes,
    };
    if (event.trace_id && /^[0-9a-f]{32}$/.test(event.trace_id)) {
      record.traceId = event.trace_id;
    }
    if (event.span_id && /^[0-9a-f]{16}$/.test(event.span_id)) {
      record.spanId = event.span_id;
    }
    return record;
  });

  const payload = {
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs },
        scopeLogs: [
          {
            scope: { name: "readypackets.audit", version: "1.0.0" },
            logRecords,
          },
        ],
      },
    ],
  };

  return Buffer.from(JSON.stringify(payload), "utf8");
}
