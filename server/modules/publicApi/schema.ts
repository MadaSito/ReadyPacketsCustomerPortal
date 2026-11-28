/**
 * Public API v1 (increment 04 package H). Additive tables only. Secrets are never stored in clear: key tokens
 * as `hashToken`, signing secrets encrypted (AAD bound to the key), log payloads encrypted after redaction.
 */
import {
  boolean,
  char,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime, versionColumn } from "../../db/columns.js";

/** Single row (id = 1). Ships disabled. */
export const apiSettings = mysqlTable("api_settings", {
  id: tinyint("id", { unsigned: true }).primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  retentionDays: smallint("retention_days", { unsigned: true }).notNull().default(30),
  version: versionColumn(),
  updatedByUserId: refColumn("updated_by_user_id"),
  updatedAt: updatedAtColumn(),
});

export const API_KEY_STATES = ["active", "revoked"] as const;

export const apiKeys = mysqlTable(
  "api_keys",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    name: varchar("name", { length: 120 }).notNull(),
    /** Lookup prefix (public part of the token). */
    prefix: char("prefix", { length: 12 }).notNull(),
    /** hashToken(full token). */
    secretHash: varchar("secret_hash", { length: 128 }).notNull(),
    scopes: json("scopes").$type<string[]>().notNull(),
    ipAllowList: json("ip_allow_list").$type<string[]>().notNull(),
    expiresAt: utcDateTime("expires_at"),
    rateLimitPerMinute: smallint("rate_limit_per_minute", { unsigned: true }).notNull().default(60),
    requireSigning: boolean("require_signing").notNull().default(false),
    /** FieldCrypto envelope, AAD `api_keys.signing_secret:<publicId>`. */
    signingSecretEnc: varchar("signing_secret_enc", { length: 512 }),
    state: mysqlEnum("state", API_KEY_STATES).notNull().default("active"),
    version: versionColumn(),
    createdByUserId: refColumn("created_by_user_id").notNull(),
    lastUsedAt: utcDateTime("last_used_at"),
    rotatedAt: utcDateTime("rotated_at"),
    revokedAt: utcDateTime("revoked_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("api_keys_prefix_uq").on(t.prefix),
    index("api_keys_state_idx").on(t.state, t.id),
    index("api_keys_creator_idx").on(t.createdByUserId),
  ],
);

export const apiRequestLog = mysqlTable(
  "api_request_log",
  {
    id: idColumn(),
    /** The request id (also `X-Request-Id`). */
    publicId: char("public_id", { length: 26 }).notNull(),
    keyId: refColumn("key_id"),
    keyPublicId: char("key_public_id", { length: 26 }),
    method: varchar("method", { length: 8 }).notNull(),
    /** Fixed route template, e.g. `/orders/{id}`; `unmatched` otherwise. */
    route: varchar("route", { length: 128 }).notNull(),
    /** Path without query (ids are public ids; no secrets travel in paths). */
    path: varchar("path", { length: 512 }).notNull(),
    status: smallint("status", { unsigned: true }).notNull(),
    durationMs: int("duration_ms", { unsigned: true }).notNull(),
    correlationId: varchar("correlation_id", { length: 64 }).notNull(),
    errorCode: varchar("error_code", { length: 64 }),
    requestBytes: int("request_bytes", { unsigned: true }).notNull(),
    responseBytes: int("response_bytes", { unsigned: true }).notNull(),
    /** Encrypted redacted view `{ headers, query, body }` for display (bounded 64 KiB before encryption). */
    requestViewEnc: mediumtext("request_view_enc"),
    responseViewEnc: mediumtext("response_view_enc"),
    /** Encrypted exact `{ target, body }` for replay; null when the body exceeded 64 KiB (truncated). */
    replayEnc: mediumtext("replay_enc"),
    bodyTruncated: boolean("body_truncated").notNull().default(false),
    ipEnc: varchar("ip_enc", { length: 255 }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    replayOf: char("replay_of", { length: 26 }),
    replayedByUserId: refColumn("replayed_by_user_id"),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("api_request_log_public_uq").on(t.publicId),
    index("api_request_log_created_idx").on(t.createdAt, t.id),
    index("api_request_log_key_idx").on(t.keyId, t.id),
    index("api_request_log_status_idx").on(t.status, t.id),
    index("api_request_log_corr_idx").on(t.correlationId),
  ],
);

export const apiIdempotency = mysqlTable(
  "api_idempotency",
  {
    id: idColumn(),
    keyId: refColumn("key_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    /** SHA-256 of method + target + body. */
    requestHash: char("request_hash", { length: 64 }).notNull(),
    state: mysqlEnum("state", ["in_progress", "completed"]).notNull(),
    status: smallint("status", { unsigned: true }),
    /** Encrypted response body, AAD `api_idempotency.response:<keyId>:<idempotencyKey>`. */
    responseEnc: mediumtext("response_enc"),
    expiresAt: utcDateTime("expires_at").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [uniqueIndex("api_idempotency_uq").on(t.keyId, t.idempotencyKey), index("api_idempotency_exp_idx").on(t.expiresAt)],
);

export const apiSignatureNonces = mysqlTable(
  "api_signature_nonces",
  {
    id: idColumn(),
    keyId: refColumn("key_id").notNull(),
    signatureHash: char("signature_hash", { length: 64 }).notNull(),
    expiresAt: utcDateTime("expires_at").notNull(),
  },
  (t) => [uniqueIndex("api_signature_nonces_uq").on(t.keyId, t.signatureHash), index("api_signature_nonces_exp_idx").on(t.expiresAt)],
);

export const apiRateWindows = mysqlTable(
  "api_rate_windows",
  {
    keyId: refColumn("key_id").notNull(),
    windowStart: utcDateTime("window_start").notNull(),
    count: int("count", { unsigned: true }).notNull().default(0),
  },
  (t) => [primaryKey({ name: "api_rate_windows_pk", columns: [t.keyId, t.windowStart] }), index("api_rate_windows_ws_idx").on(t.windowStart)],
);
