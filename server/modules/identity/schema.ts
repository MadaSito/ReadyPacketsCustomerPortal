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
    /*
     * Increment 08 (D1): name parts, encrypted (aad `users.first_name:<publicId>` / `users.last_name:` /
     * `users.preferred_name:`). NULL = an account from before 08 (parts derived lazily from name_enc and stored at
     * the next profile save). name_enc stays "<First> <Last>" so every existing consumer keeps working.
     */
    firstNameEnc: text("first_name_enc"),
    lastNameEnc: text("last_name_enc"),
    preferredNameEnc: text("preferred_name_enc"),
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
    /*
     * Increment 09 (D2.1): trash state, orthogonal to `status` (restore returns the account suspended). All NULL =
     * live. `purged_at` set = tombstone (personal columns overwritten; never listed, never restorable).
     * `trashed_by_user_id` is a plain reference (no self foreign key) so purging the actor never cascades.
     */
    trashedAt: utcDateTime("trashed_at"),
    trashedByUserId: refColumn("trashed_by_user_id"),
    trashBatchId: char("trash_batch_id", { length: 26 }),
    trashReason: varchar("trash_reason", { length: 200 }),
    purgeStartedAt: utcDateTime("purge_started_at"),
    purgedAt: utcDateTime("purged_at"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("users_email_index_uq").on(table.emailIndex),
    index("users_role_status_idx").on(table.role, table.status),
    index("users_name_first_idx").on(table.nameFirstPrefixIndex),
    index("users_name_last_idx").on(table.nameLastPrefixIndex),
    index("users_trashed_idx").on(table.trashedAt, table.id),
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
    /** Increment 04: client address at sign-in, encrypted (aad `user_sessions.ip:<publicId>`). Admin session centre only. */
    ipAddressEnc: text("ip_address_enc"),
    /** Increment 04: ISO 3166-1 alpha-2 at sign-in (protection.clientCountry), null = unknown. */
    country: char("country", { length: 2 }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("user_sessions_token_hash_uq").on(table.tokenHash),
    index("user_sessions_user_idx").on(table.userId, table.revokedAt),
    index("user_sessions_live_idx").on(table.revokedAt, table.lastSeenAt),
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
export const SSO_PROTOCOLS = ["oidc", "saml"] as const;
export type SsoProtocol = (typeof SSO_PROTOCOLS)[number];
export const ENTRA_MFA_MODES = ["claim", "entra", "portal"] as const;
export type EntraMfaMode = (typeof ENTRA_MFA_MODES)[number];

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
  /* increment 07 (D10): SAML 2.0 and the Entra MFA mode. All nullable or defaulted (additive). */
  /** Active protocol. Both resolve to the same identity (tenant id, object id). */
  protocol: mysqlEnum("protocol", SSO_PROTOCOLS).notNull().default("oidc"),
  /** SP Identifier (Entity ID). NULL = the derived default `<origin>/api/identity/saml/metadata`. */
  samlEntityId: varchar("saml_entity_id", { length: 255 }),
  /** Entra federation metadata URL (https, host login.microsoftonline.com only). */
  samlMetadataUrl: varchar("saml_metadata_url", { length: 512 }),
  samlMetadataRefreshedAt: utcDateTime("saml_metadata_refreshed_at"),
  /** Safe outcome code of the last metadata refresh (e.g. OK, FETCH_FAILED, TENANT_MISMATCH). */
  samlMetadataStatus: varchar("saml_metadata_status", { length: 40 }),
  /**
   * claim | entra | portal. NULL = a row written before increment 07: read as trust_entra_mfa ? claim : portal
   * (trust_entra_mfa is kept, deprecated, and still written for compatibility).
   */
  entraMfaMode: mysqlEnum("entra_mfa_mode", ENTRA_MFA_MODES),
  /** JSON array of accepted SAML AuthnContextClassRef URIs that prove MFA (claim mode). NULL = none. */
  acceptedAuthnContexts: text("accepted_authn_contexts"),
  /** JSON array of roles that may sign in with SSO. NULL = a pre-increment-07 row: every role (unchanged). */
  allowedRoles: text("sso_allowed_roles"),
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
    /* increment 07 (D10). For SAML, `state_hash` holds the hash of the AuthnRequest ID (InResponseTo). */
    protocol: mysqlEnum("protocol", SSO_PROTOCOLS).notNull().default("oidc"),
    /** SAML step-up / link: the AuthnRequest carried ForceAuthn="true". */
    forceAuthn: boolean("force_authn").notNull().default(false),
    /** Hash of the accepted assertion ID (replay defence in depth; unique while the row is kept, ≥ 24 h). */
    assertionIdHash: char("assertion_id_hash", { length: 64 }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("sso_auth_requests_state_uq").on(table.stateHash),
    uniqueIndex("sso_auth_requests_ticket_uq").on(table.ticketHash),
    uniqueIndex("sso_auth_requests_assertion_uq").on(table.assertionIdHash),
    index("sso_auth_requests_browser_idx").on(table.browserHash, table.status),
    index("sso_auth_requests_expiry_idx").on(table.expiresAt),
  ],
);
export type SsoAuthRequestRow = typeof ssoAuthRequests.$inferSelect;

export const SAML_CERT_SOURCES = ["manual", "metadata"] as const;
export type SamlCertSource = (typeof SAML_CERT_SOURCES)[number];

/**
 * Pinned Entra SAML signing certificates (increment 07, D10). At most two are trusted at once (current + next
 * for rollover); a retired row is kept for history and never trusted. Public certificates only — no keys.
 */
export const ssoSamlCertificates = mysqlTable(
  "sso_saml_certificates",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    fingerprintSha256: char("fingerprint_sha256", { length: 64 }).notNull(),
    certificatePem: text("certificate_pem").notNull(),
    /** Display only (bounded, sanitized subject common name). */
    subject: varchar("subject", { length: 255 }),
    notBefore: utcDateTime("not_before").notNull(),
    notAfter: utcDateTime("not_after").notNull(),
    source: mysqlEnum("source", SAML_CERT_SOURCES).notNull(),
    addedByUserId: refColumn("added_by_user_id"),
    lastUsedAt: utcDateTime("last_used_at"),
    retiredAt: utcDateTime("retired_at"),
    retiredByUserId: refColumn("retired_by_user_id"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("sso_saml_certificates_fp_uq").on(table.fingerprintSha256),
    index("sso_saml_certificates_active_idx").on(table.retiredAt, table.notAfter),
  ],
);
export type SsoSamlCertificateRow = typeof ssoSamlCertificates.$inferSelect;

export const SSO_MAPPED_ROLES = ["staff", "customer"] as const;
export type SsoMappedRole = (typeof SSO_MAPPED_ROLES)[number];

/**
 * Entra app-role value → portal role for just-in-time accounts (increment 07, D10). Never administrator.
 * Up to 20 rows; staff mappings win over customer mappings when a user holds several app roles.
 */
export const ssoRoleMappings = mysqlTable(
  "sso_role_mappings",
  {
    id: idColumn(),
    appRoleValue: varchar("app_role_value", { length: 120 }).notNull(),
    role: mysqlEnum("role", SSO_MAPPED_ROLES).notNull(),
    createdByUserId: refColumn("created_by_user_id"),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex("sso_role_mappings_value_uq").on(table.appRoleValue)],
);
export type SsoRoleMappingRow = typeof ssoRoleMappings.$inferSelect;

/* ------------------------------------------------------------------ increment 04: session centre (package D) */

export const SIGN_IN_EVENT_KINDS = ["success", "failure", "lock", "sign_out", "forced_end", "expiry", "refused"] as const;
export type SignInEventKind = (typeof SIGN_IN_EVENT_KINDS)[number];

/**
 * Sign-in / session log. Never holds the typed e-mail, a password, a token or a raw user agent. The IP is
 * encrypted (aad `identity_sign_in_events.ip:<publicId>`) with a blind index for exact-match filtering.
 */
export const signInEvents = mysqlTable(
  "identity_sign_in_events",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    occurredAt: utcDateTime("occurred_at").notNull(),
    kind: mysqlEnum("kind", SIGN_IN_EVENT_KINDS).notNull(),
    reasonCode: varchar("reason_code", { length: 40 }),
    userId: refColumn("user_id").references(() => users.id),
    role: mysqlEnum("role", USER_ROLES),
    authMethod: mysqlEnum("auth_method", AUTH_METHODS),
    sessionPublicId: char("session_public_id", { length: 26 }),
    ipAddressEnc: text("ip_address_enc"),
    ipIndex: char("ip_index", { length: 64 }),
    country: char("country", { length: 2 }),
    deviceSummary: varchar("device_summary", { length: 80 }),
    /** Administrator who forced the end (forced_end only). */
    actorUserId: refColumn("actor_user_id").references(() => users.id),
    requestId: char("request_id", { length: 26 }),
  },
  (table) => [
    index("identity_sign_in_events_time_idx").on(table.occurredAt),
    index("identity_sign_in_events_user_idx").on(table.userId, table.occurredAt),
    index("identity_sign_in_events_kind_idx").on(table.kind, table.occurredAt),
    index("identity_sign_in_events_ip_idx").on(table.ipIndex, table.occurredAt),
  ],
);
export type SignInEventRow = typeof signInEvents.$inferSelect;

export const COUNTRY_RULE_MODES = ["off", "allow", "deny"] as const;
export const RESTRICTION_SCOPES = ["all", "customers", "console"] as const;

/** Single row (id = 1). Ships disabled. Per-role lifetimes null = use the global identity settings. */
export const sessionRestrictions = mysqlTable("identity_session_restrictions", {
  id: int("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  maxConcurrentPerUser: int("max_concurrent_per_user"),
  idleMinutesCustomer: int("idle_minutes_customer"),
  idleMinutesStaff: int("idle_minutes_staff"),
  idleMinutesAdmin: int("idle_minutes_admin"),
  absoluteHoursCustomer: int("absolute_hours_customer"),
  absoluteHoursStaff: int("absolute_hours_staff"),
  absoluteHoursAdmin: int("absolute_hours_admin"),
  /** JSON array of normalised CIDR strings (≤ 100). Empty = no console IP restriction. */
  consoleIpAllowList: text("console_ip_allow_list"),
  countryMode: mysqlEnum("country_mode", COUNTRY_RULE_MODES).notNull().default("off"),
  countryScope: mysqlEnum("country_scope", RESTRICTION_SCOPES).notNull().default("all"),
  /** Comma-separated ISO alpha-2 codes (≤ 250). */
  countries: varchar("countries", { length: 750 }),
  allowUnknownCountry: boolean("allow_unknown_country").notNull().default(true),
  version: versionColumn(),
  updatedBy: refColumn("updated_by").references(() => users.id),
  updatedAt: updatedAtColumn(),
});
export type SessionRestrictionsRow = typeof sessionRestrictions.$inferSelect;
