/**
 * Identity module — Drizzle MySQL tables. Owner: identity engineer.
 *
 * `users` is the ONE cross-module foreign-key target. Its core columns below are a team contract
 * (seeded by the integrator): identity may ADD columns/tables freely but must not rename/remove these
 * without telling /root. Authentication material (password hashes, MFA secrets, recovery codes,
 * sessions) is never part of portable business data.
 */
import { boolean, char, index, int, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { USER_ROLES } from "../../../shared/domain.js";
import { AUTH_METHODS } from "../../../shared/domain.js";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime, versionColumn } from "../../db/columns.js";

export const USER_STATUSES = ["pending_activation", "active", "suspended", "deactivated"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const users = mysqlTable(
  "users",
  {
    id: idColumn(),
    /** Stable portable identity reference. */
    publicId: publicIdColumn(),
    /** Mutable, human-facing business reference (e.g. customer number). Retired values stay reserved. */
    customerRef: varchar("customer_ref", { length: 32 }).unique(),
    role: mysqlEnum("role", USER_ROLES).notNull().default("customer"),
    status: mysqlEnum("status", USER_STATUSES).notNull().default("pending_activation"),
    /** AES-256-GCM envelope (FieldCrypto.encrypt, aad `users.email:<publicId>`). */
    emailEnc: text("email_enc").notNull(),
    /** HMAC blind index of the normalized email (FieldCrypto.blindIndex(value, "users.email")). */
    emailIndex: char("email_index", { length: 64 }).notNull(),
    emailVerifiedAt: utcDateTime("email_verified_at"),
    /** Encrypted display name (aad `users.name:<publicId>`). */
    nameEnc: text("name_enc").notNull(),
    /* ---- identity-owned additions (not part of the seeded contract) ---- */
    /** Argon2id PHC string. NULL = no usable password (invited, imported, admin link pending). Never exported. */
    passwordHash: varchar("password_hash", { length: 255 }),
    passwordChangedAt: utcDateTime("password_changed_at"),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /** Authentication source. Only `local` is active in this release. */
    authSource: mysqlEnum("auth_source", AUTH_METHODS).notNull().default("local"),
    /** Blind indexes of the first 3 lower-cased letters of the first/last name tokens (bounded name search). */
    nameFirstPrefixIndex: char("name_first_prefix_index", { length: 64 }),
    nameLastPrefixIndex: char("name_last_prefix_index", { length: 64 }),
    /** How the account came to exist: register | admin | import | bootstrap. */
    origin: varchar("origin", { length: 16 }).notNull().default("register"),
    statusReasonCode: varchar("status_reason_code", { length: 40 }),
    statusChangedAt: utcDateTime("status_changed_at"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("users_email_index_uq").on(table.emailIndex),
    index("users_role_status_idx").on(table.role, table.status),
    index("users_name_first_idx").on(table.nameFirstPrefixIndex),
    index("users_name_last_idx").on(table.nameLastPrefixIndex),
  ],
);
export type UserRow = typeof users.$inferSelect;

/**
 * Server-side sessions. The bearer token is stored ONLY as FieldCrypto.hashToken(token). `public_id` is the
 * non-secret session id (SessionPrincipal.sessionId). Rotation replaces token hash + CSRF secret in place.
 */
export const userSessions = mysqlTable(
  "user_sessions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    userId: refColumn("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    /** Encrypted per-session CSRF secret (aad `user_sessions.csrf:<publicId>`). */
    csrfSecretEnc: text("csrf_secret_enc").notNull(),
    authMethod: mysqlEnum("auth_method", AUTH_METHODS).notNull().default("local"),
    authenticatedAt: utcDateTime("authenticated_at").notNull(),
    lastSeenAt: utcDateTime("last_seen_at").notNull(),
    absoluteExpiresAt: utcDateTime("absolute_expires_at").notNull(),
    mfaVerifiedAt: utcDateTime("mfa_verified_at"),
    stepUpAt: utcDateTime("step_up_at"),
    rotatedAt: utcDateTime("rotated_at"),
    revokedAt: utcDateTime("revoked_at"),
    revokeReason: varchar("revoke_reason", { length: 40 }),
    /** Coarse "Browser on OS" summary derived server-side; no raw user agent, no IP. */
    deviceSummary: varchar("device_summary", { length: 80 }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("user_sessions_token_hash_uq").on(table.tokenHash),
    index("user_sessions_user_idx").on(table.userId, table.revokedAt),
  ],
);
export type UserSessionRow = typeof userSessions.$inferSelect;

export const IDENTITY_TOKEN_PURPOSES = ["verify_email", "password_reset", "invitation", "admin_set_password"] as const;
export type IdentityTokenPurpose = (typeof IDENTITY_TOKEN_PURPOSES)[number];

/** Single-use e-mail link tokens, stored only as hashToken(token). Newest-only per (user, purpose). */
export const identityTokens = mysqlTable(
  "identity_tokens",
  {
    id: idColumn(),
    userId: refColumn("user_id")
      .notNull()
      .references(() => users.id),
    purpose: mysqlEnum("purpose", IDENTITY_TOKEN_PURPOSES).notNull(),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    expiresAt: utcDateTime("expires_at").notNull(),
    consumedAt: utcDateTime("consumed_at"),
    /** consumed | superseded | password_set | expired_cleanup */
    retiredReason: varchar("retired_reason", { length: 24 }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("identity_tokens_hash_uq").on(table.tokenHash),
    index("identity_tokens_user_purpose_idx").on(table.userId, table.purpose, table.consumedAt),
  ],
);

/** Every customer reference ever used (current and retired). Retired references stay reserved forever. */
export const customerRefReservations = mysqlTable(
  "customer_ref_reservations",
  {
    id: idColumn(),
    reference: varchar("reference", { length: 32 }).notNull(),
    userId: refColumn("user_id")
      .notNull()
      .references(() => users.id),
    retiredAt: utcDateTime("retired_at"),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex("customer_ref_reservations_ref_uq").on(table.reference)],
);

export const customerRefHistory = mysqlTable(
  "customer_ref_history",
  {
    id: idColumn(),
    userId: refColumn("user_id")
      .notNull()
      .references(() => users.id),
    previousReference: varchar("previous_reference", { length: 32 }),
    newReference: varchar("new_reference", { length: 32 }).notNull(),
    changedByUserId: refColumn("changed_by_user_id"),
    reasonCode: varchar("reason_code", { length: 40 }).notNull(),
    changedAt: utcDateTime("changed_at").notNull(),
  },
  (table) => [index("customer_ref_history_user_idx").on(table.userId, table.changedAt)],
);

/* ------------------------------------------------------------------------------------------------------
 * Microsoft Entra ID single sign-on (increment 03, package I). Additive tables only.
 * ------------------------------------------------------------------------------------------------------ */

export const SSO_JIT_MODES = ["off", "customers", "staff"] as const;
export type SsoJitMode = (typeof SSO_JIT_MODES)[number];

/**
 * Single-row SSO configuration (id = 1). The client secret is encrypted (aad `sso_configuration.client_secret`)
 * and write-only through the API (only "configured" + last 4 characters are ever returned). `epoch` increments
 * whenever tenant, client id or secret change, which invalidates every pending authorization request.
 */
export const ssoConfiguration = mysqlTable("sso_configuration", {
  id: idColumn(),
  enabled: boolean("enabled").notNull().default(false),
  tenantId: char("tenant_id", { length: 36 }),
  clientId: char("client_id", { length: 36 }),
  clientSecretEnc: text("client_secret_enc"),
  clientSecretLast4: varchar("client_secret_last4", { length: 4 }),
  buttonLabel: varchar("button_label", { length: 40 }),
  /** JSON array of lower-case domains; NULL/empty = no domain restriction inside the tenant. */
  allowedDomains: text("allowed_domains"),
  trustEntraMfa: boolean("trust_entra_mfa").notNull().default(false),
  jitMode: mysqlEnum("jit_mode", SSO_JIT_MODES).notNull().default("off"),
  /** Entra app-role value that qualifies for staff provisioning (jit_mode = staff). Never yields admin. */
  jitStaffAppRole: varchar("jit_staff_app_role", { length: 120 }),
  jitDailyLimit: int("jit_daily_limit", { unsigned: true }).notNull().default(25),
  epoch: int("epoch", { unsigned: true }).notNull().default(1),
  updatedByUserId: refColumn("updated_by_user_id"),
  version: versionColumn(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});
export type SsoConfigurationRow = typeof ssoConfiguration.$inferSelect;

export const SSO_LINK_METHODS = ["self", "admin", "jit"] as const;
export type SsoLinkMethod = (typeof SSO_LINK_METHODS)[number];

/**
 * An Entra identity is (tenant id, object id) — never an e-mail address. One link per user and one user per
 * identity. `verified_at` NULL = an administrator binding that becomes usable only after a completed Entra
 * callback for exactly that object id in the configured tenant.
 */
export const ssoIdentities = mysqlTable(
  "sso_identities",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    userId: refColumn("user_id")
      .notNull()
      .references(() => users.id),
    provider: varchar("provider", { length: 16 }).notNull().default("entra"),
    tenantId: char("tenant_id", { length: 36 }).notNull(),
    objectId: char("object_id", { length: 36 }).notNull(),
    linkMethod: mysqlEnum("link_method", SSO_LINK_METHODS).notNull(),
    linkedByUserId: refColumn("linked_by_user_id"),
    linkedAt: utcDateTime("linked_at").notNull(),
    verifiedAt: utcDateTime("verified_at"),
    lastSignInAt: utcDateTime("last_sign_in_at"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("sso_identities_subject_uq").on(table.provider, table.tenantId, table.objectId),
    uniqueIndex("sso_identities_user_uq").on(table.userId, table.provider),
    index("sso_identities_created_idx").on(table.linkMethod, table.createdAt),
  ],
);
export type SsoIdentityRow = typeof ssoIdentities.$inferSelect;

export const SSO_PURPOSES = ["sign_in", "link", "step_up", "test"] as const;
export type SsoPurpose = (typeof SSO_PURPOSES)[number];
export const SSO_REQUEST_STATUSES = ["prepared", "pending", "verified", "refused", "completed"] as const;
export type SsoRequestStatus = (typeof SSO_REQUEST_STATUSES)[number];

/**
 * Server-side OIDC authorization requests. state, nonce, browser binding and start ticket are stored only as
 * hashes; the PKCE verifier and the verified-claims result are encrypted (aad `sso_auth_requests.*:<publicId>`).
 * Rows are single use: every transition is a conditional UPDATE on `status`. Link / step-up / test rows are
 * `prepared` with only a session-bound start ticket; state, nonce and verifier are generated at start.
 */
export const ssoAuthRequests = mysqlTable(
  "sso_auth_requests",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    purpose: mysqlEnum("purpose", SSO_PURPOSES).notNull(),
    status: mysqlEnum("status", SSO_REQUEST_STATUSES).notNull(),
    stateHash: char("state_hash", { length: 64 }),
    nonceHash: char("nonce_hash", { length: 64 }),
    verifierEnc: text("verifier_enc"),
    ticketHash: char("ticket_hash", { length: 64 }),
    browserHash: char("browser_hash", { length: 64 }),
    /** Initiating session (link / step-up / test); NULL for sign-in. */
    sessionPublicId: char("session_public_id", { length: 26 }),
    userId: refColumn("user_id"),
    configEpoch: int("config_epoch", { unsigned: true }).notNull(),
    nextPath: varchar("next_path", { length: 512 }),
    /** Parked authorization code (session-bound purposes only, ≤ 2 minutes, single use). */
    codeEnc: text("code_enc"),
    resultEnc: text("result_enc"),
    refusalCode: varchar("refusal_code", { length: 40 }),
    requestedAt: utcDateTime("requested_at").notNull(),
    expiresAt: utcDateTime("expires_at").notNull(),
    callbackAt: utcDateTime("callback_at"),
    completedAt: utcDateTime("completed_at"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("sso_auth_requests_state_uq").on(table.stateHash),
    uniqueIndex("sso_auth_requests_ticket_uq").on(table.ticketHash),
    index("sso_auth_requests_browser_idx").on(table.browserHash, table.status),
    index("sso_auth_requests_expiry_idx").on(table.expiresAt),
  ],
);
export type SsoAuthRequestRow = typeof ssoAuthRequests.$inferSelect;
