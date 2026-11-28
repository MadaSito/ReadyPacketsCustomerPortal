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
  "ack_key",
  "ack_policy",
  "action_kind",
  "alert_severity",
  "alert_source",
  "attention",
  "audience",
  "auth_method",
  "bucket",
  "capability",
  "category",
  "check_mode",
  "checkpoint_reason",
  "close_reason",
  "completion_kind",
  "continuity_mode",
  "dataset",
  "decision",
  "derived_invoice_status",
  "destination_key",
  "dimension",
  "discount_type",
  "disposition",
  "enabled_from",
  "enabled_to",
  "event_type",
  "export_kind",
  "field",
  "file_source",
  "file_visibility",
  "flag",
  "format",
  "from_priority",
  "from_role",
  "from_state",
  "from_status",
  "from_value",
  "integrity",
  "key_custody",
  "key_readiness",
  "kind",
  "match_type",
  "method",
  "mfa_method",
  "mfa_mode",
  "mfa_source",
  "min_severity",
  "mode",
  "mode_from",
  "mode_to",
  "next_step",
  "outcome",
  "panel",
  "payment_state",
  "phase",
  "preset",
  "previous_status",
  "priority",
  "probe",
  "procedure",
  "profile",
  "protocol",
  "provider",
  "purpose",
  "rate_limit_bucket",
  "reason_code",
  "receipt_confirmation",
  "record_type",
  "release_reason",
  "report_key",
  "result",
  "role",
  "rule_key",
  "scope",
  "scope_kind",
  "secret_slot",
  "selection",
  "setting_key",
  "severity",
  "slot",
  "stage_key",
  "status",
  "status_key",
  "target",
  "target_key",
  "target_role",
  "task_key",
  "task_kind",
  "template",
  "tls_mode",
  "to_priority",
  "to_role",
  "to_state",
  "to_status",
  "to_value",
  "trigger",
  "via",
  "visibility",
]);

/** Integrity custody SHA-256 hex digest keys permitted on external audit checkpoint/export/spec/template events (never personal data). */
export const EXTERNAL_HEX_DIGEST_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "ack_text_hash",
  "digest",
  "export_sha256",
  "head_link_hmac_sha256",
  "spec_hash",
  "text_sha256",
]);

/**
 * Strict typed allowlist of numeric attribute keys permitted to leave the installation.
 */
export const EXTERNAL_NUMERIC_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "account_count",
  "address_count",
  "answer_version",
  "attempt",
  "attempts",
  "batch_size",
  "bulk_count",
  "bytes_sent",
  "cascaded_orders",
  "checkpoint_seq",
  "completion_revision",
  "confirmed_count",
  "customer_days",
  "customer_retention_days",
  "delay_hours",
  "delay_minutes",
  "dry_run_count",
  "due",
  "due_count",
  "event_count",
  "failed",
  "failed_count",
  "file_count",
  "from_customer_days",
  "from_order_days",
  "generated_count",
  "grace_hours",
  "keep_last_count",
  "kept_count",
  "max_age_days",
  "max_attempts",
  "max_discount_bps",
  "max_discount_percent",
  "note_version",
  "order_days",
  "order_retention_days",
  "pause_minutes",
  "percent",
  "port",
  "progress_percent",
  "purged",
  "recipient_count",
  "retention_days",
  "reviewed_due_count",
  "revision_number",
  "row_count",
  "sessions_ended",
  "settings_version",
  "stage_index",
  "status_code",
  "task_version",
  "threshold",
  "tolerance_seconds",
  "total_batch_size",
  "total_bytes",
  "version",
  "version_number",
  "window_minutes",
  "workflow_version",
]);

/** Explicit allowlist of boolean/null flag keys permitted in external audit projections. */
export const EXTERNAL_BOOLEAN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "active",
  "affects_current_audience",
  "allow_private_address",
  "allow_private_network",
  "allow_zero_total",
  "attention",
  "auto_cleanup_enabled",
  "auto_purge_enabled",
  "automatic",
  "can_reach_zero",
  "compare",
  "digest_matches",
  "email_verified",
  "enabled",
  "endpoint_changed",
  "escalated",
  "expired",
  "from_auto_purge_enabled",
  "gates_removed",
  "has_auth_secret",
  "has_client_cert",
  "has_client_key",
  "has_custom_ca",
  "has_mtls",
  "include_bom",
  "is_batch",
  "locked",
  "manual",
  "mfa_enrolled",
  "mfa_required",
  "mfa_verified",
  "migrate_backlog",
  "must_change_password",
  "password_updated",
  "permanent",
  "probe",
  "reason_present",
  "recovery_used",
  "remember_device",
  "required",
  "revoked",
  "secrets_included",
  "secrets_modified",
  "step_up",
  "step_up_verified",
  "synthetic",
  "totp_enrolled",
  "truncated",
  "typed_name_present",
  "uncertain_delivery",
  "was_enabled",
]);

/** Explicit allowlist of `safe_counts` metric keys permitted in external audit projections. */
export const EXTERNAL_SAFE_COUNT_KEYS: ReadonlySet<string> = new Set([
  "active_spool",
  "alerts",
  "api_keys",
  "attached",
  "attempts",
  "backlog_migrated",
  "backlog_quarantined",
  "bytes",
  "bytes_sent",
  "cascaded_orders",
  "categories",
  "characters",
  "count",
  "created",
  "customers",
  "deleted",
  "deleted_total",
  "delivered",
  "drafted",
  "dropped",
  "dry_run_count",
  "due",
  "due_customers",
  "due_orders",
  "events",
  "events_added",
  "expired_tickets",
  "failed",
  "file_count",
  "files",
  "filtered_queued",
  "invoices",
  "items",
  "kept",
  "kept_count",
  "kept_total",
  "matched",
  "messages",
  "migrated_queued",
  "missing",
  "notifications",
  "orders",
  "participants",
  "payments",
  "policy_references",
  "pruned",
  "purged",
  "purged_customers",
  "purged_orders",
  "quarantined_queued",
  "recipients",
  "records",
  "reminders",
  "removed_outbox_items",
  "replayed",
  "requested",
  "returned",
  "rows",
  "runs",
  "sessions_revoked",
  "skipped",
  "spool_max",
  "staging_removed",
  "succeeded",
  "tickets",
  "total",
  "total_bytes",
  "uncertain_events",
  "unpublished",
  "workflows",
]);

const SAFE_PURGE_COUNT_KEY_RE = /^(?:deleted|kept)_[a-z0-9_]{1,31}$/;

/**
 * Closed value vocabularies for discrete enum attributes; remaining allowlisted string keys require strict lowercase identifier syntax.
 */
export const EXTERNAL_ENUM_VOCABULARIES: Readonly<Record<string, ReadonlySet<string>>> = {
  category: new Set([...VALID_CATEGORIES, "start", "working", "waiting", "done", "canceled"]),
  min_severity: VALID_SEVERITIES,
  severity: new Set(["low", "medium", "high", "critical", ...SEVERITIES]),
  alert_severity: new Set(["warning", "error", "critical"]),
  ack_policy: new Set(["required", "optional", "none"]),
  completion_kind: new Set(["fixed", "range"]),
  attention: new Set(["none", "staff_review", "customer_response", "true", "false"]),
  scope: new Set(["phase", "order", "all", "selected"]),
  outcome: new Set([...VALID_OUTCOMES, "accepted", "changes_requested", "partial_failed"]),
  payment_state: new Set([
    "not_required",
    "unpaid",
    "awaiting_settlement",
    "pending_async",
    "paid",
    "payment_failed",
    "failed",
    "refunded",
    "partially_refunded",
    "attention_required",
    "not_applicable",
    "canceled",
  ]),
  target_key: new Set([
    "production:P101",
    "production:P201",
    "production:P301",
    "production:P401",
    "p101",
    "p201",
    "p301",
    "p401",
  ]),
  mfa_source: new Set(["entra_claim", "portal", "entra_managed"]),
  mfa_mode: new Set([
    "entra_or_portal",
    "always_portal",
    "entra",
    "entra_claim_or_portal",
    "portal_always",
    "entra_managed",
  ]),
  rule_key: new Set([
    "brute_force_account",
    "password_spraying",
    "credential_stuffing",
    "distributed_account",
    "success_after_failures",
    "mfa_fatigue",
    "rate_limit_repeated",
    "ban_evasion",
    "privilege_then_export",
  ]),
  close_reason: new Set(["resolved", "false_positive", "duplicate", "accepted_risk"]),
  check_mode: new Set(["off", "warn", "require"]),
  discount_type: new Set(["percent", "fixed", "set_total"]),
  export_kind: new Set(["codes", "redemptions", "builtin", "custom"]),
  visibility: new Set(["private", "shared", "internal", "customer", "customer_visible", "staff_only", "public"]),
  file_visibility: new Set(["private", "shared", "internal", "customer", "customer_visible", "staff_only", "public"]),
  task_kind: new Set(["upload", "acknowledge", "order_note", "record", "respond_document"]),
  selection: new Set(["all", "keys"]),
  trigger: new Set(["admin", "deadline", "decline", "manual", "retention", "schedule"]),
  enabled_from: new Set(["true", "false"]),
  enabled_to: new Set(["true", "false"]),
  from_value: new Set(["true", "false"]),
  to_value: new Set(["true", "false"]),
  role: new Set(["admin", "staff", "customer", "system", "anonymous"]),
  from_role: new Set(["admin", "staff", "customer", "system", "anonymous"]),
  to_role: new Set(["admin", "staff", "customer", "system", "anonymous"]),
  format: new Set(["syslog_rfc5425", "jsonl_tls", "cef_tls", "otlp_https", "json", "ndjson", "csv", "pdf", "zip"]),
  receipt_confirmation: new Set(["none", "transport_accepted", "collector_2xx"]),
  tls_mode: new Set(["strict", "mtls", "starttls", "tls"]),
  auth_method: new Set(["password", "totp", "passkey", "webauthn", "recovery_code", "session", "token", "oidc", "saml"]),
  mfa_method: new Set(["totp", "passkey", "webauthn", "recovery_code", "entra_claim", "entra_managed"]),
  decision: new Set(["allow", "deny", "challenge", "step_up", "quarantine"]),
};

/** Strict lowercase identifier syntax for open-enum technical vocabulary keys (never mixed-case tokens, base64, or prose). */
const SAFE_VOCAB_IDENTIFIER_RE = /^[a-z0-9][a-z0-9_.:/-]{0,47}$/;
/** Controlled machine reason codes (all-uppercase or all-lowercase identifier; never mixed-case tokens or prose). */
const SAFE_REASON_CODE_RE = /^(?:[A-Z0-9][A-Z0-9_.:-]{0,63}|[a-z0-9][a-z0-9_.:/-]{0,63})$/;
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
  const pattern = key === "reason_code" ? SAFE_REASON_CODE_RE : SAFE_VOCAB_IDENTIFIER_RE;
  if (!pattern.test(value)) return false;
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
        (EXTERNAL_SAFE_COUNT_KEYS.has(key) || SAFE_PURGE_COUNT_KEY_RE.test(key)) &&
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
 * Projects a raw `AuditEnvelopeLike` for external SIEM delivery: applies the audit module's
 * envelope identity/address-class projection while evaluating `attributes` and `safe_counts`
 * against SIEM's strict typed allowlists and closed vocabularies without double-counting drops.
 */
export function projectAuditEnvelopeForSiem(
  rawEvent: AuditEnvelopeLike,
  externalProjector?: (event: AuditEnvelopeLike) => ExternalAuditEvent,
): ExternalAuditEvent {
  if (!externalProjector) {
    return sanitizeProjectedEvent(rawEvent);
  }
  const base = externalProjector(rawEvent);
  return sanitizeProjectedEvent({
    ...base,
    attributes: rawEvent.attributes,
    safe_counts: rawEvent.safe_counts,
    dropped_attributes: rawEvent.dropped_attributes,
  });
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
