/**
 * Canonical versioned audit event envelope (architecture §8.2) + strict input validation.
 * Owner: audit engineer.
 *
 * The envelope is the ONE shape stored, queried, chained, exported and projected for SIEM.
 * Field names are snake_case and aligned with the OpenTelemetry Logs Data Model where applicable.
 */
import { isIP } from "node:net";
import {
  AUDIT_CATEGORIES,
  AUDIT_OUTCOMES,
  SEVERITIES,
  type AuditCategory,
  type AuditEventInput,
  type AuditOutcome,
  type FieldCrypto,
  type RequestContext,
  type SafeAttributeValue,
  type Severity,
} from "../../core/types.js";
import { SENSITIVE_KEY, scanValue } from "../../observability/redact.js";
import { OTEL_SEVERITY_NUMBER } from "../../observability/logger.js";

export const AUDIT_SCHEMA_VERSION = "rp.audit/1";

export const EVENT_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,5}$/;
export const ACTION_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const REASON_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const RESOURCE_TYPE_RE = /^[a-z][a-z0-9_]{0,47}$/;
export const REF_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const ATTRIBUTE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const PROVIDER_RE = /^[a-z][a-z0-9_.-]{0,31}$/;
/** Safe printable charset for attribute strings: no quotes, angle brackets, backslash, control chars, @. */
export const ATTRIBUTE_STRING_RE = /^[A-Za-z0-9 _.,:;/#()+=*~-]{0,128}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const DIGEST_KEY = /_(sha256|hash)$/;
/** Public ids across modules: ULIDs and `[A-Za-z0-9_-]{10,64}` ids (backup, orders). */
const PUBLIC_ID_VALUE = /^[A-Za-z0-9_-]{10,64}$/;

export const MAX_ATTRIBUTES = 24;
export const MAX_SAFE_COUNTS = 16;

export const SEVERITY_NUMBER: Record<Severity, number> = OTEL_SEVERITY_NUMBER;

export type ActorRole = "admin" | "staff" | "customer" | "system" | "anonymous";
export type SourceAddressClass = "loopback" | "private" | "public" | "unknown" | "none";

/** The stored/queried canonical event. `null` means "not applicable/unknown", never omitted. */
export interface AuditEnvelope {
  schema_version: string;
  event_id: string;
  occurred_at: string;
  observed_at: string;
  severity_text: Severity;
  severity_number: number;
  category: AuditCategory;
  event_name: string;
  action: string;
  outcome: AuditOutcome;
  reason_code: string | null;
  durability: "durable" | "best_effort";
  actor_ref: string | null;
  actor_role: ActorRole;
  /** Installation-local numeric id. LOCAL ONLY — never exported externally. */
  actor_user_id: number | null;
  session_ref: string | null;
  resource_type: string | null;
  resource_public_id: string | null;
  resource_ref: string | null;
  /**
   * Order the event belongs to (explicit `orderPublicId`, an order resource, or the `order_public_id` attribute).
   * Optional for envelopes rebuilt from rows written before increment 04 part B. Hashed only when non-null.
   */
  order_public_id?: string | null;
  request_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  correlation_id: string | null;
  parent_correlation_id: string | null;
  job_id: string | null;
  package_id: string | null;
  import_id: string | null;
  delivery_id: string | null;
  provider: string | null;
  duration_ms: number | null;
  origin: RequestContext["origin"] | "unknown";
  service: string;
  installation_ref: string;
  release_ref: string;
  deployment_profile: string;
  source_address_class: SourceAddressClass;
  source_address_ref: string | null;
  safe_counts: Record<string, number>;
  attributes: Record<string, SafeAttributeValue>;
  dropped_attributes: number;
  /** Position in the hash chain; null until sealed. Not part of the hashed canonical bytes. */
  chain_seq: number | null;
}

/** Privacy-safe projection for external destinations (SIEM/syslog/CEF). */
export type ExternalAuditEvent = Omit<
  AuditEnvelope,
  "actor_user_id" | "resource_public_id" | "session_ref" | "source_address_ref" | "durability"
>;

export class AuditValidationError extends Error {
  constructor(public readonly field: string) {
    super(`audit envelope rejected: invalid ${field}`);
    this.name = "AuditValidationError";
  }
}

export function classifyAddress(address: string | undefined): SourceAddressClass {
  if (!address) return "none";
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
  const kind = isIP(ip);
  if (kind === 0) return "unknown";
  if (kind === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    if (a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return "private";
    return "public";
  }
  const lower = ip.toLowerCase();
  if (lower === "::1") return "loopback";
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) return "private";
  return "public";
}

/** Validates one attribute; returns the safe value or undefined if it must be dropped. */
const PII_KEY = /email|name|ip_?addr|address|phone|filename|body|sql|query_text|message|note|comment|user_agent/;

/**
 * Canonical attribute key: lower camelCase (`fromStatus`) becomes snake_case (`from_status`); anything else
 * is returned unchanged and must already match ATTRIBUTE_KEY_RE. Keeps evidence from modules that use camelCase.
 */
export function normaliseAttributeKey(key: string): string {
  return /^[a-z][a-zA-Z0-9]*$/.test(key) && /[A-Z]/.test(key) ? key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : key;
}

export function sanitiseAttribute(key: string, value: unknown): SafeAttributeValue | undefined {
  if (!ATTRIBUTE_KEY_RE.test(key)) return undefined;
  if (SENSITIVE_KEY.test(key)) return typeof value === "boolean" ? value : undefined;
  // Opaque public identifiers (`note_public_id`): the key may contain a personal-field word ("note") but the value is
  // an id, so only an id-shaped value is accepted, and a long id is not mistaken for a token.
  if (key.endsWith("_public_id") && typeof value === "string") return PUBLIC_ID_VALUE.test(value) ? value : undefined;
  if (PII_KEY.test(key)) {
    // A flag ABOUT a secret or personal field (`password_updated: true`, `secrets_included: false`) carries no
    // secret material; any other value type — including a digest of personal data (`email_hash`) — is dropped.
    return typeof value === "boolean" ? value : undefined;
  }
  // Evidence digests: SHA-256 hex under `*_sha256` or `*_hash` keys (`content_hash`, `schema_hash`). 64 hex chars would
  // otherwise trip the long-token scan below; anything else under such a key goes through the normal string rules.
  if (typeof value === "string" && DIGEST_KEY.test(key) && SHA256_HEX.test(value)) return value;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  if (!ATTRIBUTE_STRING_RE.test(value)) return undefined;
  if (scanValue(value).hits.length > 0) return undefined;
  return value;
}

export interface EnvelopeContext {
  config: { serviceName: string; installationId: string; releaseRef: string; deploymentProfile: string };
  crypto: Pick<FieldCrypto, "pseudonym">;
  request: RequestContext | undefined;
  eventId: string;
  observedAt: Date;
  durability: "durable" | "best_effort";
}

const optId = (value: string | undefined | null): string | null =>
  typeof value === "string" && REF_ID_RE.test(value) ? value : null;

/**
 * Validates `input` and builds the envelope. Throws `AuditValidationError` for structural violations
 * (names/enums) — callers translate that to AuditUnavailableError (fail closed). Unsafe attributes are
 * dropped and counted, never stored.
 */
export function buildEnvelope(input: AuditEventInput, ctx: EnvelopeContext): AuditEnvelope {
  if (!AUDIT_CATEGORIES.includes(input.category)) throw new AuditValidationError("category");
  if (typeof input.eventName !== "string" || input.eventName.length > 96 || !EVENT_NAME_RE.test(input.eventName)) throw new AuditValidationError("eventName");
  if (typeof input.action !== "string" || !ACTION_RE.test(input.action)) throw new AuditValidationError("action");
  if (!AUDIT_OUTCOMES.includes(input.outcome)) throw new AuditValidationError("outcome");
  const severity = input.severity ?? defaultSeverity(input.outcome);
  if (!SEVERITIES.includes(severity)) throw new AuditValidationError("severity");
  if (input.reasonCode !== undefined && !REASON_CODE_RE.test(input.reasonCode)) throw new AuditValidationError("reasonCode");
  if (input.resource && !RESOURCE_TYPE_RE.test(input.resource.type)) throw new AuditValidationError("resource.type");
  const occurred = input.occurredAt ?? ctx.observedAt;
  if (!(occurred instanceof Date) || Number.isNaN(occurred.getTime())) throw new AuditValidationError("occurredAt");

  const request = ctx.request;
  const actorRole: ActorRole = input.actor?.role ?? request?.actor?.role ?? (request?.origin === "http" ? "anonymous" : "system");
  if (!["admin", "staff", "customer", "system", "anonymous"].includes(actorRole)) throw new AuditValidationError("actor.role");
  const actorUserId =
    input.actor !== undefined
      ? typeof input.actor.userId === "number" && Number.isSafeInteger(input.actor.userId) && input.actor.userId > 0
        ? input.actor.userId
        : null
      : (request?.actor?.userId ?? null);
  const sessionId = input.actor === undefined || input.actor.userId === request?.actor?.userId ? request?.actor?.sessionId : undefined;

  let resourcePublicId: string | null = null;
  if (input.resource) {
    const candidate = input.resource.publicId ?? (typeof input.resource.id === "string" ? input.resource.id : null);
    resourcePublicId = optId(candidate);
  }
  const resourceRef =
    input.resource && (resourcePublicId || typeof input.resource.id === "number")
      ? ctx.crypto.pseudonym(`${input.resource.type}:${resourcePublicId ?? String(input.resource.id)}`, "audit.resource").slice(0, 32)
      : null;

  const attributes: Record<string, SafeAttributeValue> = {};
  let dropped = 0;
  const orderPublicIdOf = (value: unknown): string | null => (typeof value === "string" && PUBLIC_ID_VALUE.test(value) ? value : null);
  const rawAttributes = input.attributes ?? {};
  const keys = Object.keys(rawAttributes);
  for (const key of keys) {
    if (Object.keys(attributes).length >= MAX_ATTRIBUTES) {
      dropped += 1;
      continue;
    }
    const canonical = normaliseAttributeKey(key);
    const safe = Object.hasOwn(attributes, canonical) ? undefined : sanitiseAttribute(canonical, rawAttributes[key]);
    if (safe === undefined) dropped += 1;
    else attributes[canonical] = safe;
  }
  const safeCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(input.safeCounts ?? {})) {
    if (Object.keys(safeCounts).length >= MAX_SAFE_COUNTS || !ATTRIBUTE_KEY_RE.test(key) || !Number.isSafeInteger(value) || value < 0) {
      dropped += 1;
      continue;
    }
    safeCounts[key] = value;
  }
  const durationMs =
    typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? Math.min(Math.round(input.durationMs), 2_147_483_647)
      : null;

  const address = request?.ipAddress;
  return {
    schema_version: AUDIT_SCHEMA_VERSION,
    event_id: ctx.eventId,
    occurred_at: occurred.toISOString(),
    observed_at: ctx.observedAt.toISOString(),
    severity_text: severity,
    severity_number: SEVERITY_NUMBER[severity],
    category: input.category,
    event_name: input.eventName,
    action: input.action,
    outcome: input.outcome,
    reason_code: input.reasonCode ?? null,
    durability: ctx.durability,
    actor_ref: actorUserId !== null ? ctx.crypto.pseudonym(`user:${actorUserId}`, "audit.actor").slice(0, 32) : null,
    actor_role: actorRole,
    actor_user_id: actorUserId,
    session_ref: sessionId ? ctx.crypto.pseudonym(sessionId, "audit.session").slice(0, 32) : null,
    resource_type: input.resource?.type ?? null,
    resource_public_id: resourcePublicId,
    resource_ref: resourceRef,
    order_public_id:
      orderPublicIdOf(input.orderPublicId) ??
      (input.resource?.type === "order" ? orderPublicIdOf(resourcePublicId) : null) ??
      orderPublicIdOf(attributes.order_public_id),
    request_id: optId(request?.requestId),
    trace_id: request?.traceId && /^[0-9a-f]{32}$/.test(request.traceId) ? request.traceId : null,
    span_id: request?.spanId && /^[0-9a-f]{16}$/.test(request.spanId) ? request.spanId : null,
    correlation_id: optId(input.correlationId ?? request?.correlationId),
    parent_correlation_id: optId(input.parentCorrelationId ?? request?.parentCorrelationId),
    job_id: optId(input.jobId),
    package_id: optId(input.packageId),
    import_id: optId(input.importId),
    delivery_id: optId(input.deliveryId),
    provider: input.provider && PROVIDER_RE.test(input.provider) ? input.provider : null,
    duration_ms: durationMs,
    origin: request?.origin ?? "unknown",
    service: ctx.config.serviceName,
    installation_ref: ctx.config.installationId,
    release_ref: ctx.config.releaseRef.slice(0, 80),
    deployment_profile: ctx.config.deploymentProfile,
    source_address_class: classifyAddress(address),
    source_address_ref: address ? ctx.crypto.pseudonym(address, "audit.source_address").slice(0, 32) : null,
    safe_counts: safeCounts,
    attributes,
    dropped_attributes: dropped,
    chain_seq: null,
  };
}

export function defaultSeverity(outcome: AuditOutcome): Severity {
  switch (outcome) {
    case "denied":
    case "refused":
    case "unknown":
      return "WARN";
    case "failed":
      return "ERROR";
    default:
      return "INFO";
  }
}

/** Fields covered by the hash chain, in canonical order. `chain_seq` is excluded (assigned later). */
export const CANONICAL_FIELDS = [
  "schema_version",
  "event_id",
  "occurred_at",
  "observed_at",
  "severity_text",
  "severity_number",
  "category",
  "event_name",
  "action",
  "outcome",
  "reason_code",
  "durability",
  "actor_ref",
  "actor_role",
  "actor_user_id",
  "session_ref",
  "resource_type",
  "resource_public_id",
  "resource_ref",
  "request_id",
  "trace_id",
  "span_id",
  "correlation_id",
  "parent_correlation_id",
  "job_id",
  "package_id",
  "import_id",
  "delivery_id",
  "provider",
  "duration_ms",
  "origin",
  "service",
  "installation_ref",
  "release_ref",
  "deployment_profile",
  "source_address_class",
  "source_address_ref",
  "safe_counts",
  "attributes",
  "dropped_attributes",
] as const satisfies readonly (keyof AuditEnvelope)[];

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalValue((value as Record<string, unknown>)[key]);
  return out;
}

/** Canonical bytes "c1": JSON array of [field, value] pairs in CANONICAL_FIELDS order, nested keys sorted. */
export function canonicalBytes(envelope: AuditEnvelope): string {
  const pairs: [string, unknown][] = CANONICAL_FIELDS.map((field) => [field, canonicalValue(envelope[field])]);
  // Appended only when present, so rows written before the column existed keep their original bytes ("c1").
  if (envelope.order_public_id !== null && envelope.order_public_id !== undefined) pairs.push(["order_public_id", envelope.order_public_id]);
  return JSON.stringify(pairs);
}

/**
 * Attribute keys whose string/number values may leave the installation (SIEM, syslog, "external" exports).
 * They carry fixed vocabularies (states, roles, formats, modes) or small technical numbers — never identifiers,
 * references, names, amounts or hashes. Booleans under any accepted key are flags and are always forwarded.
 * Everything else stays local (local exports and the audit center) and is counted in `dropped_attributes`.
 */
export const EXTERNAL_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "action_kind", "audience", "auth_method", "category", "continuity_mode", "decision", "disposition", "field", "format",
  "from_priority", "from_role", "from_state", "from_status", "integrity", "key_custody", "key_readiness", "match_type",
  "method", "min_severity", "mode", "next_step", "phase", "previous_status", "priority", "procedure", "profile",
  "protocol", "purpose", "record_type", "role", "scope_kind", "status", "target", "tls_mode", "to_priority", "to_role",
  "to_state", "to_status", "event_type", "derived_invoice_status", "port", "version", "version_number",
  "revision_number", "workflow_version", "keep_last_count", "max_age_days", "tolerance_seconds", "setting_key", "flag",
  "kind", "template", "bucket", "dimension", "mode_from", "mode_to",
  // Integrity custody: checkpoint position and head link, export digest (hashes, not secrets).
  "checkpoint_seq", "checkpoint_reason", "head_link_hmac_sha256", "export_sha256",
]);

export function projectForExternal(envelope: AuditEnvelope): ExternalAuditEvent {
  const { actor_user_id: _a, resource_public_id: _r, session_ref: _s, source_address_ref: _ip, durability: _d, ...rest } = envelope;
  const attributes: Record<string, SafeAttributeValue> = {};
  let withheld = 0;
  for (const [key, value] of Object.entries(rest.attributes)) {
    if (typeof value === "boolean" || value === null || EXTERNAL_ATTRIBUTE_KEYS.has(key)) attributes[key] = value;
    else withheld += 1;
  }
  return { ...rest, attributes, safe_counts: { ...rest.safe_counts }, dropped_attributes: rest.dropped_attributes + withheld };
}
