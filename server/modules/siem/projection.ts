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
const VALID_SOURCE_CLASSES = new Set(["loopback", "private", "public", "unknown", "none"]);

const SAFE_ATTR_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Strict typed allowlist of string attribute keys permitted to leave the installation
 * (aligned with `server/modules/audit/envelope.ts` `EXTERNAL_ATTRIBUTE_KEYS` + SIEM probe/receipt enums).
 * Arbitrary free-form text keys (`note`, `comment`, `summary`, `customer_label`, etc.) are NEVER exported.
 */
export const EXTERNAL_STRING_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "action_kind",
  "audience",
  "auth_method",
  "bucket",
  "capability",
  "category",
  "checkpoint_reason",
  "continuity_mode",
  "decision",
  "derived_invoice_status",
  "dimension",
  "disposition",
  "event_type",
  "field",
  "flag",
  "format",
  "from_priority",
  "from_role",
  "from_state",
  "from_status",
  "integrity",
  "key_custody",
  "key_readiness",
  "kind",
  "match_type",
  "method",
  "mfa_method",
  "min_severity",
  "mode",
  "mode_from",
  "mode_to",
  "next_step",
  "phase",
  "previous_status",
  "priority",
  "probe",
  "procedure",
  "profile",
  "protocol",
  "purpose",
  "receipt_confirmation",
  "record_type",
  "role",
  "scope_kind",
  "setting_key",
  "status",
  "target",
  "template",
  "tls_mode",
  "to_priority",
  "to_role",
  "to_state",
  "to_status",
]);

/** Integrity custody SHA-256 hex digest keys permitted on external audit checkpoint/export events. */
export const EXTERNAL_HEX_DIGEST_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "head_link_hmac_sha256",
  "export_sha256",
]);

/**
 * Strict typed allowlist of numeric attribute keys permitted to leave the installation.
 */
export const EXTERNAL_NUMERIC_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "attempt",
  "attempts",
  "checkpoint_seq",
  "keep_last_count",
  "max_age_days",
  "max_attempts",
  "port",
  "revision_number",
  "status_code",
  "tolerance_seconds",
  "version",
  "version_number",
  "workflow_version",
]);

/** Explicit allowlist of boolean/null flag keys permitted in external audit projections. */
export const EXTERNAL_BOOLEAN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "active",
  "allow_private_address",
  "allow_private_network",
  "email_verified",
  "enabled",
  "endpoint_changed",
  "expired",
  "has_auth_secret",
  "has_client_cert",
  "has_client_key",
  "has_custom_ca",
  "has_mtls",
  "include_bom",
  "locked",
  "mfa_enrolled",
  "mfa_required",
  "mfa_verified",
  "migrate_backlog",
  "must_change_password",
  "password_updated",
  "probe",
  "recovery_used",
  "remember_device",
  "revoked",
  "secrets_included",
  "secrets_modified",
  "step_up",
  "step_up_verified",
  "synthetic",
  "totp_enrolled",
  "truncated",
  "uncertain_delivery",
  "was_enabled",
]);

/** Explicit allowlist of `safe_counts` metric keys permitted in external audit projections. */
export const EXTERNAL_SAFE_COUNT_KEYS: ReadonlySet<string> = new Set([
  "active_spool",
  "attempts",
  "backlog_migrated",
  "backlog_quarantined",
  "bytes",
  "categories",
  "count",
  "delivered",
  "dropped",
  "events",
  "failed",
  "files",
  "filtered_queued",
  "items",
  "matched",
  "migrated_queued",
  "missing",
  "pruned",
  "purged",
  "quarantined_queued",
  "recipients",
  "records",
  "removed_outbox_items",
  "replayed",
  "returned",
  "sessions_revoked",
  "spool_max",
  "succeeded",
  "total",
  "uncertain_events",
]);

/** Closed value vocabularies for discrete enum attributes; remaining allowlisted string keys require strict lowercase identifier syntax. */
const EXTERNAL_ENUM_VOCABULARIES: Readonly<Record<string, ReadonlySet<string>>> = {
  category: VALID_CATEGORIES,
  min_severity: VALID_SEVERITIES,
  role: new Set(["admin", "staff", "customer", "system", "anonymous"]),
  from_role: new Set(["admin", "staff", "customer", "system", "anonymous"]),
  to_role: new Set(["admin", "staff", "customer", "system", "anonymous"]),
  format: new Set(["syslog_rfc5425", "jsonl_tls", "cef_tls", "otlp_https", "json", "ndjson", "csv", "pdf", "zip"]),
  receipt_confirmation: new Set(["none", "transport_accepted", "collector_2xx"]),
  tls_mode: new Set(["strict", "mtls", "starttls", "tls"]),
  auth_method: new Set(["password", "totp", "passkey", "webauthn", "recovery_code", "session", "token"]),
  mfa_method: new Set(["totp", "passkey", "webauthn", "recovery_code"]),
  decision: new Set(["allow", "deny", "challenge", "step_up", "quarantine"]),
};

/** Strict lowercase identifier syntax for open-enum technical vocabulary keys (never mixed-case tokens, base64, or prose). */
const SAFE_VOCAB_IDENTIFIER_RE = /^[a-z0-9][a-z0-9_.:/-]{0,47}$/;
const SAFE_SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9_.:/-]{1,80}$/;

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const URL_CRED_RE = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_LIKE_RE = /^(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

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

function isSafeAllowlistedStringValue(key: string, value: string): boolean {
  const closedVocab = EXTERNAL_ENUM_VOCABULARIES[key];
  if (closedVocab) {
    return closedVocab.has(value);
  }
  if (!SAFE_VOCAB_IDENTIFIER_RE.test(value)) return false;
  if (
    EMAIL_RE.test(value) ||
    URL_CRED_RE.test(value) ||
    IPV4_RE.test(value) ||
    IPV6_LIKE_RE.test(value) ||
    value.startsWith("rpenc:")
  ) {
    return false;
  }
  return true;
}

/**
 * Defense-in-depth projection sanitizer: enforces the fixed pseudonymous external contract
 * with a strict typed attribute allowlist (never a permissive regex denylist).
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
      if (countKeys >= 16) {
        dropped += 1;
        continue;
      }
      if (
        SAFE_ATTR_KEY.test(key) &&
        EXTERNAL_SAFE_COUNT_KEYS.has(key) &&
        typeof val === "number" &&
        Number.isSafeInteger(val) &&
        val >= 0
      ) {
        cleanCounts[key] = val;
        countKeys += 1;
      } else {
        dropped += 1;
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
      if (!SAFE_ATTR_KEY.test(key)) {
        dropped += 1;
        continue;
      }
      if (val === null || typeof val === "boolean") {
        if (
          EXTERNAL_BOOLEAN_ATTRIBUTE_KEYS.has(key) ||
          EXTERNAL_STRING_ATTRIBUTE_KEYS.has(key) ||
          EXTERNAL_NUMERIC_ATTRIBUTE_KEYS.has(key)
        ) {
          cleanAttributes[key] = val;
          attrKeys += 1;
        } else {
          dropped += 1;
        }
      } else if (typeof val === "number") {
        if (
          EXTERNAL_NUMERIC_ATTRIBUTE_KEYS.has(key) &&
          Number.isFinite(val) &&
          Math.abs(val) <= Number.MAX_SAFE_INTEGER
        ) {
          cleanAttributes[key] = val;
          attrKeys += 1;
        } else {
          dropped += 1;
        }
      } else if (typeof val === "string") {
        if (EXTERNAL_HEX_DIGEST_ATTRIBUTE_KEYS.has(key) && SAFE_SHA256_HEX_RE.test(val)) {
          cleanAttributes[key] = val;
          attrKeys += 1;
        } else if (EXTERNAL_STRING_ATTRIBUTE_KEYS.has(key) && isSafeAllowlistedStringValue(key, val)) {
          cleanAttributes[key] = val;
          attrKeys += 1;
        } else {
          dropped += 1;
        }
      } else {
        dropped += 1;
      }
    }
  }

  const sourceClass =
    typeof input.source_address_class === "string" && VALID_SOURCE_CLASSES.has(input.source_address_class)
      ? (input.source_address_class as ExternalAuditEvent["source_address_class"])
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
 * Prevents SIEM's own operational delivery/spool/cursor diagnostics from recursively re-spooling
 * into failing destinations while preserving SIEM admin configuration and dead-letter audit events.
 */
export function isSiemOperationalSelfEvent(eventName: string): boolean {
  return (
    eventName.startsWith("siem.delivery.") ||
    eventName.startsWith("siem.spool.") ||
    eventName.startsWith("siem.cursor.")
  );
}
