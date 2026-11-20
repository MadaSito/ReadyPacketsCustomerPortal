import type { Severity } from "../../core/types.js";
import type { ExternalAuditEvent } from "./types.js";

/**
 * Explicit OpenTelemetry -> RFC 5424 Table 2 severity mapping.
 * OpenTelemetry numbers increase with severity (1..21); syslog numbers decrease (7..0).
 */
export const SYSLOG_SEVERITY_BY_OTEL: Record<Severity, 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7> = {
  TRACE: 7, // Debug
  DEBUG: 7, // Debug
  INFO: 6, // Informational
  WARN: 4, // Warning  (local0=16 => 16*8 + 4 = 132 => <132>)
  ERROR: 3, // Error
  FATAL: 2, // Critical
};

export const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF8_BOM_CHAR = "\uFEFF";

export interface Rfc5424FormatOptions {
  /** Syslog facility 0..23. Default 16 (`local0`). */
  facility?: number;
  /** Override RFC 5424 HOSTNAME (max 255 PRINTUSASCII). Defaults to `event.installation_ref`. */
  hostname?: string | null;
  /** Override RFC 5424 APP-NAME (max 48 PRINTUSASCII). Defaults to `"readypackets"`. */
  appName?: string | null;
  /** Override RFC 5424 PROCID (max 128 PRINTUSASCII). Defaults to `event.origin` or `"-"`. */
  procId?: string | null;
  /** Override RFC 5424 MSGID (max 32 PRINTUSASCII). Defaults to `event.event_name`. */
  msgId?: string | null;
  /**
   * Optional IANA Private Enterprise Number (`1..2147483647`).
   * When null/undefined, STRUCTURED-DATA is `-` (NILVALUE) rather than inventing an unassigned PEN.
   * When set, emits `[<sdIdName>@<enterpriseNumber> ...]` in the STRUCTURED-DATA slot.
   */
  enterpriseNumber?: number | null;
  /** SD-ID prefix before `@<enterpriseNumber>`. Default `"rp"`. */
  sdIdName?: string;
  /** Include RFC 5424 §6.4 UTF-8 BOM (`0xEF 0xBB 0xBF`) before MSG. Default `true`. */
  includeBom?: boolean;
  /** Maximum total RFC 5424 message bytes (excluding octet-count prefix). Range `480..65536`, default `8192`. */
  maxMessageBytes?: number;
}

export interface FormattedSyslogMessage {
  text: string;
  bytes: Buffer;
  pri: number;
  facility: number;
  syslogSeverity: number;
  truncated: boolean;
}

export function otelSeverityToSyslog(severity: Severity): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  return SYSLOG_SEVERITY_BY_OTEL[severity] ?? 6;
}

/**
 * RFC 5424 §6.2.1: PRIVAL = facility * 8 + severity.
 */
export function computeSyslogPri(facility: number, syslogSeverity: number): number {
  if (!Number.isInteger(facility) || facility < 0 || facility > 23) {
    throw new RangeError(`Invalid syslog facility: ${facility}`);
  }
  if (!Number.isInteger(syslogSeverity) || syslogSeverity < 0 || syslogSeverity > 7) {
    throw new RangeError(`Invalid syslog severity: ${syslogSeverity}`);
  }
  return facility * 8 + syslogSeverity;
}

/**
 * RFC 5424 PRINTUSASCII = %d33-126 (no spaces, controls, DEL, or non-ASCII).
 * Empty or `"-"` yields NILVALUE `"-"`.
 */
export function sanitizePrintUsAscii(value: string | null | undefined, maxLen: number): string {
  if (!value) return "-";
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "-") return "-";
  let out = "";
  for (let i = 0; i < trimmed.length && out.length < maxLen; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code >= 33 && code <= 126) {
      out += trimmed[i]!;
    } else {
      out += "_";
    }
  }
  return out.length > 0 ? out : "-";
}

/**
 * Sanitizes an SD-NAME / PARAM-NAME token per RFC 5424 §6.3.2:
 * 1..32 PRINTUSASCII excluding `=`, SP, `]`, `"`, `\`.
 */
export function sanitizeSdToken(value: string, maxLen = 32, allowAt = false): string {
  let out = "";
  for (let i = 0; i < value.length && out.length < maxLen; i += 1) {
    const ch = value[i]!;
    const code = value.charCodeAt(i);
    if (
      code >= 33 &&
      code <= 126 &&
      ch !== "=" &&
      ch !== "]" &&
      ch !== '"' &&
      ch !== "\\" &&
      (allowAt || ch !== "@")
    ) {
      out += ch;
    } else {
      out += "_";
    }
  }
  return out.length > 0 ? out : "rp";
}

/**
 * Allocates a unique 1..32-byte RFC 5424 PARAM-NAME within an SD-ELEMENT so 40-char keys
 * that share a 32-char prefix never emit duplicate PARAM-NAMEs.
 */
function allocateUniqueSdParamName(candidate: string, used: Set<string>): string {
  const base = sanitizeSdToken(candidate, 32, false);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; n < 1_000; n += 1) {
    const suffix = `_${n}`;
    const stem = base.slice(0, Math.max(1, 32 - suffix.length));
    const disambiguated = `${stem}${suffix}`;
    if (!used.has(disambiguated)) {
      used.add(disambiguated);
      return disambiguated;
    }
  }
  return base;
}

/**
 * Neutralizes C0 (`0x00..0x1F`), DEL (`0x7F`), C1 (`0x80..0x9F`), and Unicode line/bidi
 * control characters so CR/LF/NUL/frame/log injection is impossible.
 */
export function neutralizeControls(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a) {
      out += "\\n";
    } else if (cp === 0x0d) {
      out += "\\r";
    } else if (cp === 0x09) {
      out += "\\t";
    } else if (cp === 0x00) {
      out += "\\0";
    } else if (
      cp < 0x20 ||
      cp === 0x7f ||
      (cp >= 0x80 && cp <= 0x9f) ||
      cp === 0x2028 ||
      cp === 0x2029 ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069)
    ) {
      const hex = cp <= 0xff ? `\\x${cp.toString(16).padStart(2, "0")}` : `\\u${cp.toString(16).padStart(4, "0")}`;
      out += hex;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * RFC 5424 §6.3.3 PARAM-VALUE escaping:
 * Escapes literal `\`, `"`, and `]` first, then neutralizes control characters (`\n`, `\r`, `\0`, etc.).
 */
export function escapeSdParamValue(raw: string): string {
  const escaped = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\]/g, "\\]");
  return neutralizeControls(escaped);
}

/**
 * Formats a Date or ISO timestamp as RFC 3339 UTC with millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 */
export function formatRfc3339UtcMs(input: Date | string | null | undefined): string {
  if (!input) return "-";
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString();
}

/**
 * Slices a UTF-8 Buffer to at most `maxBytes` without splitting multi-byte UTF-8 codepoints.
 */
export function truncateUtf8Buffer(buf: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  if (buf.byteLength <= maxBytes) return buf;
  let end = maxBytes;
  // Walk back past UTF-8 continuation bytes (10xxxxxx).
  while (end > 0 && (buf[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return buf.subarray(0, end);
}

function buildStructuredData(
  event: ExternalAuditEvent,
  enterpriseNumber: number | null | undefined,
  sdIdName: string,
  minimalOnly = false,
): string {
  if (enterpriseNumber === null || enterpriseNumber === undefined) {
    return "-";
  }
  if (!Number.isInteger(enterpriseNumber) || enterpriseNumber < 1 || enterpriseNumber > 2_147_483_647) {
    throw new RangeError(`Invalid IANA Private Enterprise Number: ${enterpriseNumber}`);
  }
  const penSuffix = `@${enterpriseNumber}`;
  const maxPrefixLen = Math.max(1, 32 - penSuffix.length);
  const sdId = `${sanitizeSdToken(sdIdName, maxPrefixLen, false)}${penSuffix}`;

  const usedNames = new Set<string>();
  const pairs: [string, string][] = [];
  const pushParam = (rawKey: string, rawVal: string) => {
    const paramName = allocateUniqueSdParamName(rawKey, usedNames);
    pairs.push([paramName, escapeSdParamValue(rawVal)]);
  };

  pushParam("event_id", event.event_id);
  pushParam("category", event.category);
  pushParam("event", event.event_name);
  pushParam("action", event.action);
  pushParam("outcome", event.outcome);

  if (!minimalOnly) {
    if (event.reason_code) pushParam("reason", event.reason_code);
    if (event.chain_seq !== null) pushParam("seq", String(event.chain_seq));
    if (event.actor_ref) pushParam("actor_ref", event.actor_ref);
    if (event.actor_role) pushParam("actor_role", event.actor_role);
    if (event.resource_type) pushParam("resource_type", event.resource_type);
    if (event.resource_ref) pushParam("resource_ref", event.resource_ref);
    if (event.correlation_id) pushParam("correlation_id", event.correlation_id);
    if (event.trace_id) pushParam("trace_id", event.trace_id);
    if (event.request_id) pushParam("request_id", event.request_id);
    for (const key of Object.keys(event.safe_counts).sort()) {
      pushParam(`cnt_${key}`, String(event.safe_counts[key]!));
    }
    for (const key of Object.keys(event.attributes).sort()) {
      const v = event.attributes[key];
      if (v !== null && v !== undefined) {
        pushParam(`attr_${key}`, String(v));
      }
    }
  } else {
    pushParam("truncated", "1");
  }

  const formattedParams = pairs.map(([k, v]) => `${k}="${v}"`).join(" ");
  return `[${sdId} ${formattedParams}]`;
}

/**
 * Builds a structured single-line JSON `MSG` body so dynamic attributes are isolated inside
 * `"attributes"` and JSON-quoted, preventing core-field collisions or unquoted `key=value` spoofing.
 */
function buildMsgBody(event: ExternalAuditEvent): string {
  const cleanAttributes: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(event.attributes).sort()) {
    const val = event.attributes[key];
    if (val === null || val === undefined) continue;
    const safeKey = neutralizeControls(key);
    cleanAttributes[safeKey] = typeof val === "string" ? neutralizeControls(val) : val;
  }

  const cleanCounts: Record<string, number> = {};
  for (const key of Object.keys(event.safe_counts).sort()) {
    cleanCounts[neutralizeControls(key)] = event.safe_counts[key]!;
  }

  const payload: Record<string, unknown> = {
    schema_version: neutralizeControls(event.schema_version),
    event_id: neutralizeControls(event.event_id),
    event: neutralizeControls(event.event_name),
    category: neutralizeControls(event.category),
    action: neutralizeControls(event.action),
    outcome: neutralizeControls(event.outcome),
  };
  if (event.chain_seq !== null) payload.chain_seq = event.chain_seq;
  if (event.reason_code) payload.reason = neutralizeControls(event.reason_code);
  if (event.actor_role) payload.role = neutralizeControls(event.actor_role);
  if (event.actor_ref) payload.actor_ref = neutralizeControls(event.actor_ref);
  if (event.resource_type) payload.resource_type = neutralizeControls(event.resource_type);
  if (event.resource_ref) payload.resource_ref = neutralizeControls(event.resource_ref);
  if (event.correlation_id) payload.correlation_id = neutralizeControls(event.correlation_id);
  if (event.trace_id) payload.trace_id = neutralizeControls(event.trace_id);
  if (event.request_id) payload.request_id = neutralizeControls(event.request_id);
  if (Object.keys(cleanCounts).length > 0) payload.safe_counts = cleanCounts;
  if (Object.keys(cleanAttributes).length > 0) payload.attributes = cleanAttributes;
  if (event.dropped_attributes > 0) payload.dropped_attributes = event.dropped_attributes;

  // Escape U+2028 / U+2029 / bidi controls if any survived into JSON string literals.
  return JSON.stringify(payload)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}

/**
 * Formats an `ExternalAuditEvent` into a compliant RFC 5424 message with safe UTF-8 byte truncation.
 */
export function formatRfc5424Message(
  event: ExternalAuditEvent,
  options: Rfc5424FormatOptions = {},
): FormattedSyslogMessage {
  const facility = options.facility ?? 16;
  const syslogSeverity = otelSeverityToSyslog(event.severity_text);
  const pri = computeSyslogPri(facility, syslogSeverity);
  const maxMessageBytes = Math.min(65_536, Math.max(480, options.maxMessageBytes ?? 8192));
  const includeBom = options.includeBom ?? true;

  const timestamp = formatRfc3339UtcMs(event.occurred_at);
  const hostname = sanitizePrintUsAscii(options.hostname ?? event.installation_ref, 255);
  const appName = sanitizePrintUsAscii(options.appName ?? "readypackets", 48);
  const procId = sanitizePrintUsAscii(options.procId ?? event.origin, 128);
  const msgId = sanitizePrintUsAscii(options.msgId ?? event.event_name, 32);

  const header = `<${pri}>1 ${timestamp} ${hostname} ${appName} ${procId} ${msgId}`;
  const sdIdName = options.sdIdName ?? "rp";
  let structuredData = buildStructuredData(event, options.enterpriseNumber, sdIdName, false);
  const msgBody = buildMsgBody(event);
  const bomPrefix = includeBom ? UTF8_BOM_CHAR : "";

  const fullText = `${header} ${structuredData} ${bomPrefix}${msgBody}`;
  const fullBytes = Buffer.from(fullText, "utf8");
  if (fullBytes.byteLength <= maxMessageBytes) {
    return { text: fullText, bytes: fullBytes, pri, facility, syslogSeverity, truncated: false };
  }

  // Safe truncation: ensure HEADER + SP + STRUCTURED-DATA fits with room for MSG + ` [truncated]`.
  const suffix = " [truncated]";
  const suffixBytes = Buffer.from(suffix, "utf8");
  const bomBytes = includeBom ? UTF8_BOM_BYTES : Buffer.alloc(0);

  let prefix = `${header} ${structuredData} `;
  let prefixBytes = Buffer.from(prefix, "utf8");
  if (prefixBytes.byteLength + bomBytes.byteLength + suffixBytes.byteLength > maxMessageBytes) {
    structuredData = buildStructuredData(event, options.enterpriseNumber, sdIdName, true);
    prefix = `${header} ${structuredData} `;
    prefixBytes = Buffer.from(prefix, "utf8");
  }

  if (prefixBytes.byteLength >= maxMessageBytes) {
    const fallbackPrefix = Buffer.from(`${header} - `, "utf8");
    const remaining = maxMessageBytes - fallbackPrefix.byteLength - bomBytes.byteLength - suffixBytes.byteLength;
    if (remaining <= 0) {
      const bare = truncateUtf8Buffer(Buffer.from(`${header} -`, "utf8"), maxMessageBytes);
      return {
        text: bare.toString("utf8"),
        bytes: bare,
        pri,
        facility,
        syslogSeverity,
        truncated: true,
      };
    }
    const bodySlice = truncateUtf8Buffer(Buffer.from(msgBody, "utf8"), remaining);
    const combined = Buffer.concat([fallbackPrefix, bomBytes, bodySlice, suffixBytes]);
    return {
      text: combined.toString("utf8"),
      bytes: combined,
      pri,
      facility,
      syslogSeverity,
      truncated: true,
    };
  }

  const bodyBudget = maxMessageBytes - prefixBytes.byteLength - bomBytes.byteLength - suffixBytes.byteLength;
  const bodySlice = bodyBudget > 0 ? truncateUtf8Buffer(Buffer.from(msgBody, "utf8"), bodyBudget) : Buffer.alloc(0);
  const truncatedBytes = Buffer.concat([prefixBytes, bomBytes, bodySlice, suffixBytes]);
  return {
    text: truncatedBytes.toString("utf8"),
    bytes: truncatedBytes,
    pri,
    facility,
    syslogSeverity,
    truncated: true,
  };
}

/**
 * RFC 5425 §4.3.1 octet-counting framing: `MSG-LEN SP SYSLOG-MSG` where `MSG-LEN` is the exact UTF-8 byte length.
 */
export function frameOctetCounted(syslogMsgBytes: Buffer): Buffer {
  const lenPrefix = Buffer.from(`${syslogMsgBytes.byteLength} `, "ascii");
  return Buffer.concat([lenPrefix, syslogMsgBytes]);
}
