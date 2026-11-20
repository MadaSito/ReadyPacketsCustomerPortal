import {
  AUDIT_CATEGORIES,
  AUDIT_OUTCOMES,
  SEVERITIES,
  type AuditCategory,
  type AuditOutcome,
  type SafeAttributeValue,
  type Severity,
} from "../../core/types.js";
import type { AuditEnvelopeLike, ExternalAuditEvent } from "./types.js";

export const OTEL_SEVERITY_NUMBER: Record<Severity, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

const VALID_CATEGORIES = new Set<string>(AUDIT_CATEGORIES);
const VALID_OUTCOMES = new Set<string>(AUDIT_OUTCOMES);
const VALID_SEVERITIES = new Set<string>(SEVERITIES);
const VALID_SOURCE_CLASSES = new Set(["loopback", "private", "public", "unknown"]);

const SAFE_ATTR_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const SENSITIVE_KEY_RE =
  /(?:^|_)(?:password|passwd|pwd|secret|token|api_?key|private_?key|client_?key|passphrase|cookie|csrf|session|mfa|totp|otp|recovery_?code|email|e_?mail|phone|ip|ip_?address|source_?address|user_?agent|file_?name|filename|customer_?name|full_?name|first_?name|last_?name|body|raw|sql|stack|pem|cert|bearer|authorization|credential)(?:$|_)/i;

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const JWT_RE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const PEM_RE = /-----BEGIN [A-Z0-9 ]+-----/;
const URL_CRED_RE = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const BEARER_RE = /^\s*(?:Bearer|Basic)\s+/i;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_LIKE_RE = /^(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
const LONG_SECRET_LIKE_RE = /^[A-Za-z0-9+/_=-]{40,}$/;

const SAFE_ID_RE = /^[A-Za-z0-9_.:/-]{1,80}$/;

function cleanSafeId(value: string | null | undefined, maxLen = 80): string | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  if (!SAFE_ID_RE.test(trimmed)) return null;
  if (EMAIL_RE.test(trimmed) || URL_CRED_RE.test(trimmed)) return null;
  return trimmed;
}

function cleanIsoUtc(value: string | null | undefined, fallbackIso: string): string {
  if (!value || typeof value !== "string") return fallbackIso;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallbackIso;
  return parsed.toISOString();
}

function isUnsafeStringAttributeValue(value: string): boolean {
  if (value.length > 128) return true;
  if (
    EMAIL_RE.test(value) ||
    JWT_RE.test(value) ||
    PEM_RE.test(value) ||
    URL_CRED_RE.test(value) ||
    BEARER_RE.test(value) ||
    IPV4_RE.test(value) ||
    IPV6_LIKE_RE.test(value) ||
    value.startsWith("rpenc:") ||
    LONG_SECRET_LIKE_RE.test(value)
  ) {
    return true;
  }
  return false;
}

/**
 * Defense-in-depth projection sanitizer: enforces the fixed pseudonymous external contract
 * even if an upstream caller passes an unprojected envelope or unexpected attributes.
 */
export function sanitizeProjectedEvent(input: AuditEnvelopeLike | ExternalAuditEvent): ExternalAuditEvent {
  const severityText: Severity = VALID_SEVERITIES.has(input.severity_text) ? input.severity_text : "INFO";
  const category: AuditCategory = VALID_CATEGORIES.has(input.category) ? input.category : "system";
  const outcome: AuditOutcome = VALID_OUTCOMES.has(input.outcome) ? input.outcome : "unknown";
  const fallbackIso = "1970-01-01T00:00:00.000Z";
  const occurredAt = cleanIsoUtc(input.occurred_at, fallbackIso);
  const observedAt = cleanIsoUtc(input.observed_at, occurredAt);

  let dropped = typeof input.dropped_attributes === "number" && input.dropped_attributes >= 0 ? input.dropped_attributes : 0;

  const cleanCounts: Record<string, number> = {};
  if (input.safe_counts && typeof input.safe_counts === "object") {
    let countKeys = 0;
    for (const [key, val] of Object.entries(input.safe_counts)) {
      if (countKeys >= 16) break;
      if (SAFE_ATTR_KEY.test(key) && typeof val === "number" && Number.isSafeInteger(val) && val >= 0) {
        cleanCounts[key] = val;
        countKeys += 1;
      }
    }
  }

  const cleanAttributes: Record<string, SafeAttributeValue> = {};
  if (input.attributes && typeof input.attributes === "object") {
    let attrKeys = 0;
    for (const [key, val] of Object.entries(input.attributes)) {
      if (attrKeys >= 24) {
        dropped += 1;
        continue;
      }
      if (!SAFE_ATTR_KEY.test(key) || SENSITIVE_KEY_RE.test(key)) {
        dropped += 1;
        continue;
      }
      if (val === null || typeof val === "boolean") {
        cleanAttributes[key] = val;
        attrKeys += 1;
      } else if (typeof val === "number") {
        if (Number.isFinite(val)) {
          cleanAttributes[key] = val;
          attrKeys += 1;
        } else {
          dropped += 1;
        }
      } else if (typeof val === "string") {
        if (isUnsafeStringAttributeValue(val)) {
          dropped += 1;
        } else {
          cleanAttributes[key] = val;
          attrKeys += 1;
        }
      } else {
        dropped += 1;
      }
    }
  }

  const sourceClass =
    typeof input.source_address_class === "string" && VALID_SOURCE_CLASSES.has(input.source_address_class)
      ? input.source_address_class
      : null;

  return {
    schema_version: cleanSafeId(input.schema_version, 32) ?? "rp.audit/1",
    event_id: cleanSafeId(input.event_id, 64) ?? "unknown-event",
    chain_seq:
      typeof input.chain_seq === "number" && Number.isSafeInteger(input.chain_seq) && input.chain_seq >= 0
        ? input.chain_seq
        : null,
    occurred_at: occurredAt,
    observed_at: observedAt,
    severity_text: severityText,
    severity_number: OTEL_SEVERITY_NUMBER[severityText],
    category,
    event_name: cleanSafeId(input.event_name, 96) ?? "system.unknown",
    action: cleanSafeId(input.action, 32) ?? "observe",
    outcome,
    reason_code: cleanSafeId(input.reason_code, 64),
    service: cleanSafeId(input.service, 40) ?? "portal",
    installation_ref: cleanSafeId(input.installation_ref, 64) ?? "unknown-install",
    release_ref: cleanSafeId(input.release_ref, 80) ?? "unknown",
    deployment_profile: cleanSafeId(input.deployment_profile, 32) ?? "production",
    origin: cleanSafeId(input.origin, 24) ?? "http",
    actor_ref: cleanSafeId(input.actor_ref, 80),
    actor_role: cleanSafeId(input.actor_role, 24) ?? "anonymous",
    resource_type: cleanSafeId(input.resource_type, 48),
    resource_ref: cleanSafeId(input.resource_ref, 80),
    source_address_class: sourceClass,
    request_id: cleanSafeId(input.request_id, 64),
    trace_id: cleanSafeId(input.trace_id, 32),
    span_id: cleanSafeId(input.span_id, 16),
    correlation_id: cleanSafeId(input.correlation_id, 64),
    parent_correlation_id: cleanSafeId(input.parent_correlation_id, 64),
    job_id: cleanSafeId(input.job_id, 64),
    package_id: cleanSafeId(input.package_id, 64),
    import_id: cleanSafeId(input.import_id, 64),
    delivery_id: cleanSafeId(input.delivery_id, 64),
    provider: cleanSafeId(input.provider, 48),
    duration_ms:
      typeof input.duration_ms === "number" && Number.isFinite(input.duration_ms) && input.duration_ms >= 0
        ? Math.round(input.duration_ms)
        : null,
    safe_counts: cleanCounts,
    attributes: cleanAttributes,
    dropped_attributes: dropped,
  };
}

export function matchesDestinationFilter(
  event: ExternalAuditEvent,
  filter: { minSeverity: Severity; categories: readonly AuditCategory[] },
): boolean {
  const eventRank = OTEL_SEVERITY_NUMBER[event.severity_text] ?? OTEL_SEVERITY_NUMBER.INFO;
  const minRank = OTEL_SEVERITY_NUMBER[filter.minSeverity] ?? OTEL_SEVERITY_NUMBER.INFO;
  if (eventRank < minRank) return false;
  return filter.categories.includes(event.category);
}

/**
 * Prevents SIEM's own operational delivery/spool diagnostics from recursively re-spooling
 * into failing destinations while preserving SIEM admin configuration and dead-letter audit events.
 */
export function isSiemOperationalSelfEvent(eventName: string): boolean {
  return eventName.startsWith("siem.delivery.") || eventName.startsWith("siem.spool.");
}
