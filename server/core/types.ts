/**
 * CORE CONTRACTS — the explicit interfaces every module codes against (dependency injection).
 *
 * Owner: integrator (/root). Module owners may propose changes by message; do not edit unilaterally,
 * except to refine the doc-comments of an interface you implement.
 *
 * Implementations:
 *   Clock, Logger ............ server/core (integrator) + server/modules/audit (logger redaction)
 *   FieldCrypto, SettingsStore platform module
 *   AuditEmitter ............. audit module
 *   Mailer, JobQueue ......... jobs module
 *   ObjectStorage ............ files module
 *   RateLimiter .............. http/security
 *   SessionResolver .......... identity module
 */
import type { Readable } from "node:stream";
import type { MySql2Database } from "drizzle-orm/mysql2";
import type { MySqlTransaction } from "drizzle-orm/mysql-core";
import type { MySql2QueryResultHKT, MySql2PreparedQueryHKT } from "drizzle-orm/mysql2";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { AuthMethod, SessionState, TransitionStep, UserRole } from "../../shared/domain.js";
import type { AppConfig } from "../config/env.js";

/* ------------------------------------------------------------------ database */

// Schema-agnostic handles so modules do not need the full schema type to accept a Db/Tx.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = MySql2Database<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tx = MySqlTransaction<MySql2QueryResultHKT, MySql2PreparedQueryHKT, any, ExtractTablesWithRelations<any>>;
/** Anything a repository can run a query on. */
export type DbOrTx = Db | Tx;

/* --------------------------------------------------------------------- clock */

export interface Clock {
  now(): Date;
}

/* ------------------------------------------------------------ request context */

/**
 * Trusted, server-generated request identity. Inbound trace headers are validated or replaced;
 * a correlation ID is never authority. Available everywhere via `getRequestContext()`
 * (AsyncLocalStorage) and propagated into jobs/outbox rows as plain columns.
 */
export interface RequestContext {
  /** Server-generated ULID. */
  requestId: string;
  /** 32 lowercase hex chars (W3C trace-id format). */
  traceId: string;
  /** 16 lowercase hex chars. */
  spanId: string;
  /** Long-lived workflow correlation (job/import/package). Separate from the request trace. */
  correlationId?: string;
  parentCorrelationId?: string;
  /** Client address after the configured trusted-proxy boundary. Classified sensitive-local. */
  ipAddress?: string;
  userAgent?: string;
  /** Present once the session is resolved. */
  actor?: { userId: number; role: UserRole; sessionId: string };
  /** `http`, `worker`, `cli`, `scheduler`. */
  origin: "http" | "worker" | "cli" | "scheduler" | "test";
  startedAt: Date;
}

/* ------------------------------------------------------------------- session */

/** The verified identity attached to a request. Produced only by the identity module's SessionResolver. */
export interface SessionPrincipal {
  /** Public, non-secret session identifier (safe for audit). The bearer secret never leaves identity. */
  sessionId: string;
  userId: number;
  userPublicId: string;
  role: UserRole;
  /** `remediation` sessions may only call transition endpoints. */
  state: SessionState;
  /** Ordered prerequisites still pending; empty iff state === "full". */
  pendingSteps: readonly TransitionStep[];
  authMethod: AuthMethod;
  authenticatedAt: Date;
  /** When the current session last passed an MFA challenge (null until it has). */
  mfaVerifiedAt: Date | null;
  /** When the session last passed a fresh step-up (password + MFA) for high-impact actions. */
  stepUpAt: Date | null;
  /** Per-session CSRF secret (server-side only). */
  csrfSecret: string;
}

export interface SessionCredentials {
  /** Raw session token from the `__Host-` cookie (production) or the preview header transport. */
  token: string | undefined;
  /** How the token arrived. `preview-header` is accepted only when config.deploymentProfile === "preview". */
  transport: "cookie" | "preview-header";
}

export interface SessionResolver {
  /**
   * Validates the token against authoritative server-side session state (revocation, idle and
   * absolute expiry, account status, current policy) and derives pending transition steps.
   * Returns null for any invalid/expired/revoked session. Never throws for bad input.
   */
  resolve(credentials: SessionCredentials): Promise<SessionPrincipal | null>;
}

/* --------------------------------------------------------------------- audit */

export const AUDIT_CATEGORIES = [
  "security",
  "business",
  "admin",
  "system",
  "file",
  "integration",
  "job",
  "backup",
  "portable_transfer",
  "release",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** Truthful outcomes. `attempted` + a later result row is the pattern for external effects. */
export const AUDIT_OUTCOMES = [
  "attempted",
  "completed",
  "refused",
  "denied",
  "failed",
  "canceled",
  "unknown",
] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** OpenTelemetry severity text; the audit module maps to severity_number and to syslog severities. */
export const SEVERITIES = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type SafeAttributeValue = string | number | boolean | null;

export interface AuditEventInput {
  category: AuditCategory;
  /** Fixed dotted lowercase name, e.g. `auth.login.succeeded`, `order.reassigned`. Never interpolated. */
  eventName: string;
  /** Short verb: login, create, update, delete, download, export, import, transition… */
  action: string;
  outcome: AuditOutcome;
  severity?: Severity;
  /** Fixed UPPER_SNAKE reason/error category, e.g. `BAD_CREDENTIALS`, `TARGET_COLLISION`. */
  reasonCode?: string;
  /** Defaults to the request-context actor. Use `{ role: "system" }` for jobs, `{ role: "anonymous" }` pre-auth. */
  actor?: { userId?: number | null; role: UserRole | "system" | "anonymous" };
  resource?: { type: string; id?: number | string | null; publicId?: string | null };
  correlationId?: string;
  parentCorrelationId?: string;
  jobId?: string;
  packageId?: string;
  importId?: string;
  deliveryId?: string;
  provider?: string;
  durationMs?: number;
  /** Bounded numeric facts only, e.g. { customers: 2, orders: 6 }. */
  safeCounts?: Record<string, number>;
  /**
   * Schema-allowlisted safe attributes. NEVER secrets, tokens, passwords, MFA material, raw bodies,
   * SQL, filenames, customer content or exception dumps. The audit module validates and rejects unknown shapes.
   */
  attributes?: Record<string, SafeAttributeValue>;
  occurredAt?: Date;
}

export interface AuditEmitter {
  /**
   * DURABLE record. Pass `tx` so the audit row commits or rolls back atomically with the business change
   * (mandatory for high-impact mutations). Throws `AuditUnavailableError` if the row cannot be persisted —
   * callers MUST let that abort the privileged write (fail closed).
   */
  record(event: AuditEventInput, tx?: Tx): Promise<void>;
  /**
   * Best-effort operational note for low-impact events (never throws, may be dropped under quota).
   * Not transactional evidence; do not use for security or high-impact events.
   */
  note(event: AuditEventInput): void;
}

/* -------------------------------------------------------------------- logger */

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/* ---------------------------------------------------------- crypto / settings */

export interface FieldCrypto {
  /** AES-256-GCM envelope with versioned key id: `rpenc:v1:<keyId>:<iv>:<ct>:<tag>`. `aad` binds table/column/row. */
  encrypt(plaintext: string, aad: string): string;
  /** Throws CryptoError on tamper/unknown key. Supports dual-read of retired-but-retained key ids. */
  decrypt(ciphertext: string, aad: string): string;
  /** Deterministic HMAC-SHA-256 blind index (hex) under the separate index key; `purpose` domain-separates. */
  blindIndex(value: string, purpose: string): string;
  /** HMAC pseudonym for audit/SIEM projection (separate key). Pseudonyms remain potentially personal data. */
  pseudonym(value: string, purpose: string): string;
  /** Constant-time token hashing for stored single-use secrets (session, reset, verification tokens). */
  hashToken(token: string): string;
}

export interface SettingsStore {
  /** Returns the parsed non-secret setting or the provided default. */
  get<T>(key: string, parse: (raw: unknown) => T, fallback: T): Promise<T>;
  set(key: string, value: unknown, tx?: Tx): Promise<void>;
  /** Secrets are encrypted at rest with FieldCrypto and never returned to browsers. */
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string | null, tx?: Tx): Promise<void>;
  isFeatureEnabled(flag: string): Promise<boolean>;
}

/* ---------------------------------------------------------------- mail / jobs */

export interface OutboundMail {
  /** Registered template key, e.g. `auth.verify_email`. No free-form HTML from callers. */
  template: string;
  to: { userId: number } | { address: string };
  /** Template variables. May contain single-use links; the mail module never logs them. */
  vars: Record<string, string | number | boolean>;
  /** Stable key so retries never double-send. */
  idempotencyKey: string;
}

export interface MailTemplate {
  /** Dotted key, e.g. `auth.verify_email`. Registered once by the owning module at construction time. */
  key: string;
  /** Variable names the template accepts; anything else is rejected at enqueue time. */
  vars: readonly string[];
  subject(vars: Record<string, string | number | boolean>): string;
  /** Plain-text body (always required). The mail module derives a simple, escaped HTML alternative. */
  text(vars: Record<string, string | number | boolean>): string;
  /** Variables that carry secrets/single-use links: never logged, never stored in clear after delivery. */
  sensitiveVars?: readonly string[];
}

export interface Mailer {
  /** Call from a module factory (construction time). Duplicate keys throw. */
  registerTemplate(template: MailTemplate): void;
  /** Durable transactional-outbox enqueue. Delivery is asynchronous and at-least-once. */
  enqueue(mail: OutboundMail, tx?: Tx): Promise<void>;
}

export interface EnqueueOptions {
  idempotencyKey?: string;
  runAt?: Date;
  maxAttempts?: number;
  correlationId?: string;
}

export interface ClaimedJob<P = unknown> {
  jobId: string;
  type: string;
  payload: P;
  attempt: number;
  /** Monotonic fencing token; pass to writers so stale claimants cannot publish. */
  fencingToken: number;
  correlationId: string;
  signal: AbortSignal;
  /** Throws if the claim was lost; call before each durable boundary. */
  assertStillOwned(): Promise<void>;
}

export type JobResult =
  | { outcome: "completed"; safeCounts?: Record<string, number> }
  | { outcome: "failed"; reasonCode: string; retryable: boolean }
  | { outcome: "unknown"; reasonCode: string }
  | { outcome: "canceled"; reasonCode: string };

export interface JobQueue {
  enqueue<P>(type: string, payload: P, options?: EnqueueOptions, tx?: Tx): Promise<{ jobId: string }>;
  /** Register at composition time. Handlers must be idempotent and honor `job.signal`. */
  register<P>(type: string, handler: (job: ClaimedJob<P>) => Promise<JobResult>): void;
  /**
   * Declares a recurring job (construction time). The scheduler enqueues `type` at most once per interval
   * across all workers (durable, idempotent per slot). `name` must be unique.
   */
  registerSchedule(schedule: { name: string; type: string; everyMs: number; payload?: unknown }): void;
}

/* ------------------------------------------------------------------- storage */

export interface StoredObjectInfo {
  key: string;
  size: number;
  sha256: string;
}

/** Private object storage: opaque keys, outside the web root, no path traversal, no links. */
export interface ObjectStorage {
  /** Generates a fresh opaque key (never derived from user input). */
  newKey(namespace: "files" | "staging" | "exports" | "backups" | "quarantine"): string;
  put(key: string, body: Readable | Buffer, options?: { maxBytes?: number }): Promise<StoredObjectInfo>;
  get(key: string, range?: { start: number; end: number }): Promise<Readable>;
  stat(key: string): Promise<StoredObjectInfo | null>;
  delete(key: string): Promise<void>;
  /** Atomic move within the store (staging → files). */
  move(fromKey: string, toKey: string): Promise<void>;
}

/* ---------------------------------------------------------------- rate limit */

export const RATE_LIMIT_CATEGORIES = [
  "auth_high_risk",
  "user_login",
  "form_submission",
  "api",
  "expensive",
  "standard_browsing",
] as const;
export type RateLimitCategory = (typeof RATE_LIMIT_CATEGORIES)[number];

export interface RateLimiter {
  /** `key` is an already-normalized subject (ip, account blind index, session). */
  consume(category: RateLimitCategory, key: string, cost?: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

/* ------------------------------------------------------------- core deps bag */

/** Infrastructure handed to every module factory. Module-to-module dependencies are passed explicitly. */
export interface CoreDeps {
  config: AppConfig;
  db: Db;
  clock: Clock;
  logger: Logger;
  audit: AuditEmitter;
  crypto: FieldCrypto;
  settings: SettingsStore;
  mailer: Mailer;
  jobs: JobQueue;
  storage: ObjectStorage;
  rateLimiter: RateLimiter;
}

/* ------------------------------------------------------------ module contract */

export const HEALTH_STATES = ["ok", "degraded", "failing", "disabled", "not_configured"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export interface ModuleHealth {
  /** Stable component key, e.g. `siem.delivery`, `jobs.queue`, `storage.local`. */
  component: string;
  state: HealthState;
  /** Fixed safe summary — no hostnames, paths, secrets or exception text. */
  summary: string;
  /** Bounded numeric facts (queue depth, oldest age seconds, dead letters…). */
  metrics?: Record<string, number>;
  checkedAt: Date;
}

/** Optional lifecycle every module object may implement. Called by the container / platform health aggregator. */
export interface ModuleLifecycle {
  /** Runs once after ALL modules are constructed (safe place to touch `deps.services.*`). Must not do I/O that can block startup indefinitely. */
  init?(): void;
  /** Cheap, bounded health probes for the admin health page and readiness endpoint. */
  health?(): Promise<ModuleHealth[]>;
}

/* ---------------------------------------------------------- session transport */

/**
 * How a freshly issued/rotated session reaches the browser. Implemented by the HTTP layer.
 *  - production/development/test: `__Host-` Secure HttpOnly SameSite=Strict cookie + CSRF double-submit
 *    cookie bound to the server-side session secret.
 *  - preview profile ONLY: response headers read into JS memory (sandboxed iframes have no cookies).
 * The identity module calls these; it never touches cookies or headers directly.
 */
export interface SessionTransport {
  issue(session: { token: string; csrfToken: string; absoluteExpiresAt: Date }): void;
  clear(): void;
}
