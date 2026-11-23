# Identity module — API (v1, signatures first)

Owner: identity_engineer. Reach the instance as `deps.services.identity` (only inside methods / `init()`).
Types are exported from `server/modules/identity/index.ts`.

## Types

```ts
type UserStatus = "pending_activation" | "active" | "suspended" | "deactivated";
type AuthSource = "local" | "saml";            // only "local" is active in this release

interface UserView {                            // decrypted SERVER-SIDE view — never send whole to browsers
  id: number; publicId: string; role: UserRole; status: UserStatus;
  email: string; name: string; customerRef: string | null;
  emailVerified: boolean; authSource: AuthSource; mustChangePassword: boolean;
  hasPassword: boolean; createdAt: Date;
}

interface IssuedSession { token: string; csrfToken: string; absoluteExpiresAt: Date }
// Caller passes it to ctx.transport.issue(issued) AFTER its transaction commits.
// csrfToken = deriveSessionCsrfToken(sessionId, csrfSecret) from server/security/csrf.ts (http_security).
```

## Service interface (`IdentityModule`)

```ts
sessionResolver: SessionResolver;  // authoritative: token hash, revocation, idle+absolute expiry, account status, pendingSteps

getUser(userId: number, opts?: { tx?: DbOrTx; forUpdate?: boolean }): Promise<UserView | null>;
getUserByPublicId(publicId: string, opts?: { tx?: DbOrTx; forUpdate?: boolean }): Promise<UserView | null>;
// forUpdate requires tx (SELECT … FOR UPDATE — serial admin locks).

verifyPassword(userId: number, password: string, opts?: { tx?: Tx }): Promise<boolean>;   // constant-ish timing, transparent Argon2id rehash
setPassword(userId: number, password: string, opts: {
  mustChange: boolean; tx?: Tx;
  revokeSessions?: { exceptSessionId?: string; reason: string };   // omitted = no revocation
}): Promise<void>;   // enforces policy (throws DomainError VALIDATION/PASSWORD_*); retires all outstanding reset/set-password tokens
generateTemporaryPassword(): string;            // policy-compliant, 20 chars from an unambiguous alphabet
issueAdminSetPasswordLink(userId: number, opts: { tx: Tx }): Promise<{ previewLink?: string }>;
// retires prior tokens, makes the old password unusable (hash cleared), sets must_change, queues
// `auth.admin_set_password` mail in tx. Redeeming the link is the user-chosen change and clears must_change
// (integrator decision). Callers revoke sessions themselves first (lock order users → sessions → tokens).
hasActiveAdministrator(): Promise<boolean>;     // ≥1 user role=admin status=active

// SERVICE-INTERNAL — ops scripts only (scripts/ops/create-admin.ts, seed-demo.ts); never on tRPC/HTTP.
provisionLocalAccount(input: {
  email: string; name: string; role: UserRole; password: string; mustChangePassword: boolean; customerRef?: string | null;
}, opts: { tx: Tx; reason: "bootstrap_admin" | "demo_seed" }): Promise<{ userId: number; publicId: string; customerRef: string | null }>;
// ACTIVE + e-mail-verified local account, Argon2id after the normal policy (VALIDATION PASSWORD_* / CONFLICT
// EMAIL_IN_USE); no session; MFA not enrolled (first sign-in ⇒ enroll_mfa). Audit `identity.account.provisioned`
// (actor system, attributes { reason, role, must_change_password }) in the same tx (audit failure ⇒ no account).
// bootstrap_admin: role must be admin (VALIDATION BOOTSTRAP_ROLE_INVALID); CONFLICT ADMIN_EXISTS when an active
// admin exists — serialized by a per-database MySQL named lock + FOR UPDATE read of the active-admin set
// (CONFLICT BOOTSTRAP_BUSY if the lock is not obtained in 15 s). demo_seed: FORBIDDEN DEMO_SEED_FORBIDDEN in production.

sessions: {
  timing(sessionId: string, opts?: { tx?: DbOrTx }): Promise<{ idleTimeoutSeconds: number; absoluteExpiresAt: Date } | null>;
  // current idle policy (identity.session.idle_minutes) + effective absolute expiry = min(stored expiry, authenticatedAt + current absolute policy)
  // SERVICE-INTERNAL — ops scripts only (scripts/ops/seed-demo.ts); never on tRPC/HTTP. See "Ops sessions".
  openOpsSession(userId: number, opts: { reason: "demo_seed"; tx?: Tx }): Promise<SessionPrincipal>;
  markMfaVerified(sessionId: string, opts?: { tx?: Tx }): Promise<IssuedSession>;  // sets mfaVerifiedAt + rotates
  markStepUp(sessionId: string, opts?: { tx?: Tx }): Promise<IssuedSession>;       // sets stepUpAt (+mfaVerifiedAt) + rotates
  rotate(sessionId: string, opts?: { tx?: Tx }): Promise<IssuedSession>;
  revoke(sessionId: string, reason: string, opts?: { tx?: Tx }): Promise<void>;
  revokeAllForUser(userId: number, opts: { exceptSessionId?: string; reason: string; tx?: Tx }): Promise<number>;
  /** Locks users row FOR UPDATE, then the session row FOR UPDATE; throws UNAUTHENTICATED SESSION_NOT_CURRENT if
   *  revoked/expired/user not active. Use at the start of authenticated credential mutators. */
  assertCurrent(principal: SessionPrincipal, tx: Tx): Promise<{
    pendingSteps: TransitionStep[]; role: UserRole; stepUpAt: Date | null; mfaVerifiedAt: Date | null;
  }>;
  // also rejects if the persisted role or csrfSecret differs from the principal (in-flight rotation/role change);
  // returns PERSISTED authority re-derived inside tx (assurance.getAssuranceState(userId, tx)). Session-policy
  // settings are read through `tx` (never a second pool connection while a transaction is held).
  /** Service-internal (workers): current state of a session by PUBLIC id, without its token. */
  getState(sessionId: string, opts?: { tx?: DbOrTx }): Promise<{
    sessionId: string; userId: number; userPublicId: string; role: UserRole; userStatus: UserStatus;
    live: boolean;            // not revoked, not idle/absolute-expired, user active
    revokedAt: Date | null; mfaVerifiedAt: Date | null; stepUpAt: Date | null; absoluteExpiresAt: Date;
  } | null>;
};
// sessionId is the PUBLIC session id (SessionPrincipal.sessionId), never the bearer token.

transitions: {
  /** Ordered pending steps from identity state + services.assurance.getAssuranceState(userId). */
  derive(userId: number, session?: { mfaVerifiedAt: Date | null; tx?: DbOrTx }): Promise<TransitionStep[]>;
  // calls services.assurance.getAssuranceState(userId, tx)
};

createPendingCustomer(input: {
  email: string; name: string; customerRef?: string | null; publicId?: string;   // publicId = preserve portable identity
  createdAt?: Date;                                                                 // preserve archive creation time
}, opts: { tx: Tx }): Promise<{ userId: number; publicId: string; customerRef: string }>;

isCustomerRefAvailable(reference: string, tx?: DbOrTx): Promise<boolean>;  // false for current OR retired references

// CustomerListItem = { publicId, customerRef, name, email, status, role, emailVerified, createdAt, version }
// status pending_activation, role customer (never admin/staff), NO password/MFA/session material.
// Throws CONFLICT EMAIL_IN_USE / REFERENCE_IN_USE (incl. retired references) / PUBLIC_ID_IN_USE.

findUserIdByEmail(email: string, opts?: { tx?: DbOrTx }): Promise<{ userId: number; publicId: string; role: UserRole; status: UserStatus } | null>;
// blind-index exact match. For explicit portable plan decisions ONLY — never link silently by e-mail.

portableCustomers(tx: DbOrTx, after: string | null, limit: number, publicIds?: readonly string[]):
  Promise<{ publicId: string; email: string; name: string; customerRef: string | null; createdAt: Date }[]>;
// role=customer only, ordered by publicId, `after` = last publicId, limit ≤ 500.

searchCustomers(principal: SessionPrincipal, input: { query?: string; status?: UserStatus; cursor?: string; limit?: number }):
  Promise<{ items: CustomerListItem[]; nextCursor: string | null }>;
// requires customers.read_all. Strategy: query containing "@" → blind-index exact e-mail match;
// otherwise customerRef prefix (case-insensitive, uppercase-normalised) OR name-index prefix (first 3 chars blind index — see below).
```

Search strategy for names: names are encrypted, so the module stores `name_search` blind indexes of the
lower-cased NFC first token prefix (3 chars). Name search therefore matches the first 3+ letters of the
first or last name token and is post-filtered after decryption within the bounded page. Documented
limitation: no substring search on encrypted names.

## tRPC procedures (`trpc.identity.*`)

| Procedure | Guard | Input → Output |
| --- | --- | --- |
| `passwordPolicy` (query) | public | → `{ minLength, maxLength }` |
| `register` | public (`auth_high_risk`) | `{ email, name, password }` → `{ accepted: true, previewLink? }` (uniform, never reveals existence) |
| `signIn` | public (`user_login`) | `{ email, password }` → `{ nextStep: TransitionStep \| null }` + session issued via transport |
| `verifyEmail` | public (`auth_high_risk`) | `{ token }` → `{ verified: true }` (rotates the caller's session if present) |
| `requestPasswordReset` | public (`auth_high_risk`) | `{ email }` → `{ accepted: true }` — identical in EVERY profile, never a link. Enqueues job `identity.password_reset.dispatch` `{ emailIndex }` + `attempted` audit in one tx; the retry-safe handler locks the user, checks active + local + 60 s cooldown, issues the token and queues mail |
| `resetPassword` | public (`auth_high_risk`) | `{ token, password }` → `{ reset: true }` (revokes ALL sessions; user signs in again) |
| `activateAccount` | public (`auth_high_risk`) | `{ token, password }` → `{ activated: true }` (invitation; verifies e-mail) |
| `me` (query) | session | → `{ user: { publicId, role, name, email, customerRef, status }, state, pendingSteps, nextStep, session: { idleTimeoutSeconds, absoluteExpiresAt /* ISO */ } }` |
| `resendVerification` | session | → `{ accepted: true, previewLink? }` (throttled; eligibility + 60 s cooldown under the users row lock; preview link is the caller's own) |
| `changePassword` | session (only when full or nextStep = `change_password`) | `{ currentPassword, newPassword }` → `{ nextStep }` (revokes other sessions, rotates current) |
| `signOut` | public | → `{ ok: true }` (revokes server-side session if any + transport.clear) |
| `profile.update` | protected | `{ name }` → `{ ok }` |
| `sessions.list` (query) | protected | → `{ items: { sessionId, current, createdAt, lastSeenAt, expiresAt, userAgentSummary }[] }` |
| `sessions.revoke` | protected | `{ sessionId }` → `{ ok }` (own sessions only, else NOT_FOUND) |
| `sessions.revokeOthers` | protected | → `{ revoked: number }` |
| `admin.customers.list` (query) | staff + `customers.read_all` | `{ query?, status?, cursor?, limit? }` → page |
| `admin.customers.get` (query) | staff + `customers.read_all` | `{ customerId }` → detail (+ reference history) |
| `admin.customers.create` | admin + `customers.manage` | `{ email, name, customerRef? }` → `{ customerId, previewLink? }` (invitation) |
| `admin.customers.resendInvitation` | admin + `customers.manage` | `{ customerId }` → `{ previewLink? }` |
| `admin.customers.setStatus` | admin + `customers.manage` | `{ customerId, status: "active"\|"suspended"\|"deactivated", reasonCode }` |
| `admin.customers.changeReference` | admin + `customers.reference.change` (step-up) | `{ customerId, newReference, expectedVersion }` |
| `admin.users.revokeSessions` | admin + `sessions.revoke_any` (step-up) | `{ userId }` → `{ revoked }` |
| `admin.staff.list` (query) | admin + `staff.manage` | page of staff/admin users |
| `admin.staff.create` | admin + `staff.manage` (step-up) | `{ email, name, role }` → `{ userId, previewLink? }` |
| `admin.staff.changeRole` | admin + `staff.manage` (step-up) | `{ userId, role, expectedVersion }` (last-admin protection, revokes sessions) |

`customerId` / `userId` / `sessionId` in API payloads are always publicIds.

## Single-use links (mail templates)

| Template | Var | Link | TTL |
| --- | --- | --- | --- |
| `auth.verify_email` | `link` (sensitive), `name` | `/verify-email?token=…` | 24 h |
| `auth.password_reset` | `link` (sensitive) | `/reset-password?token=…` | 30 min |
| `auth.account_exists` | `signInLink` | `/sign-in` (no token) | — |
| `auth.invitation` | `link` (sensitive), `name` | `/activate?token=…` | 72 h |
| `auth.admin_set_password` | `link` (sensitive) | `/reset-password?token=…` | 24 h |
| `auth.password_changed` | — | — | notice |

Tokens: 256-bit random, stored only as `crypto.hashToken`, single-use, newest-only per (user,purpose).
`previewLink` (relative app path, e.g. `/activate?token=…`) exists ONLY when `deploymentProfile === "preview"`, and only for:
(a) the verification link in the response to the `register` call that just created that account (and the
caller's own `resendVerification`), and (b) links created by an authenticated administrator action (invitation,
admin-initiated set-password) returned to that administrator. Never for `requestPasswordReset`, never in
`test`/`production` (negative tests in `identity.test.ts`). Mail idempotency key: `identity.token:<tokenId>`.

## Audit events (category security unless stated)
`auth.register.requested`, `auth.login.succeeded|failed|refused`, `auth.logout`, `auth.email.verified`,
`auth.password.reset_requested` (outcome attempted), `auth.password.reset_dispatch` (system; completed/refused), `auth.password.reset_completed|changed|set_by_admin`, `auth.session.rotated|revoked|revoked_all`,
`admin.customer.created|status_changed|reference_changed|invitation_sent` (admin), `admin.staff.created|role_changed` (admin),
`identity.customer.imported_pending` (portable_transfer).
Denials recorded durably AFTER the failed tx rolls back (outside it, so they survive; degrade to a note only if the
durable write fails; the original error is always rethrown): `auth.password.change_denied` (CURRENT_PASSWORD_INCORRECT),
`auth.token.rejected` { purpose: verify_email | password_reset | activation } (LINK_INVALID; never the token),
`auth.login.failed` CREDENTIAL_CHANGED_CONCURRENTLY (hash changed between verification and the locked re-check).
`auth.rate_limited` { category, subject: register|acct|verify|reset|pwchange } — sampled best-effort note, at most one per
subject per minute per process; the subject key itself is never recorded. `admin.customer.searched|viewed` are durable
`record()` calls awaited before any data is returned (audit unavailable ⇒ the read fails closed).

## Session activity (idle clock)
Every authenticated request the resolver accepts (background refetches included) refreshes `last_seen_at`, at most
once per 60 s. The server idle timeout therefore measures inactivity of the client, not of the person; the client's
own input-idle timer is the "user idle" signal and should sign out / warn on its own (`me.session` gives the policy).

## Ops sessions (demo seeder only)
`sessions.openOpsSession(userId, { reason: "demo_seed", tx? })` returns a FULL `SessionPrincipal` so the seeder can
call module services that run `assertCurrent`. Guarantees: FORBIDDEN `OPS_SESSION_FORBIDDEN` in production and for
any account whose `users.origin` is not `demo_seed` (or inactive); the row carries `device_summary = "ops:demo_seed"`
(unreachable via `deviceSummary()`), a 10-minute absolute expiry, mfaVerifiedAt/stepUpAt = now; its bearer token is
never returned (hash of a discarded random value) and the resolver refuses ops rows, so it cannot be used over HTTP.
`assertCurrent` waives only `enroll_mfa`, `acknowledge_recovery_codes`, `change_password` for such rows (the human
still enrols at first sign-in), and re-checks profile + origin every call. Audit `identity.session.ops_opened`
(actor system, attributes { reason, user_public_id, ttl_seconds }) in the same tx. Revoke with
`sessions.revoke(sessionId, "demo_seed_complete")`.

## Lock ordering (all modules)
`users` row(s) → `user_sessions` row(s) → `identity_tokens` → other modules' rows (e.g. assurance account).
Exception (orders/files, agreed with http_security): order-scoped mutations lock the `orders` row FIRST, then
`users` → `user_sessions` (via `assertCurrent`) → grants → files. Identity itself never locks an orders row, so the
two orders cannot interleave into a cycle with identity's own transactions.
Identity never locks another module's rows. Admin mutations lock the ACTOR and TARGET users rows together in
ascending `users.id` order (`SELECT … WHERE id IN (…) ORDER BY id FOR UPDATE`), then call `assertCurrent` and
re-check: no pending steps, persisted role grants the capability, persisted step-up ≤ 10 min for
`STEP_UP_CAPABILITIES`. Last-admin checks lock the candidate set (`role=admin AND status=active FOR UPDATE`).
Password rehash is compare-and-set on the verified hash (`WHERE id AND password_hash = <old> AND status = active`).

## Settings keys
`identity.session.idle_minutes` (default 30), `identity.session.absolute_hours` (default 12),
`identity.registration.enabled` (default true; when false `register` returns FORBIDDEN REGISTRATION_DISABLED —
admin-created invitations and provisioning are unaffected). Sign-in throttling is the rate limiter's `user_login` category
(keys `acct:<emailIndex>`; the HTTP layer adds the client-address key); other public flows use `auth_high_risk`.

## Jobs
`identity.password_reset.dispatch` — payload `{ emailIndex }` only (no address, no auth material);
idempotency key `<emailIndex>:<minute slot>`; `retrySafe: true` (pure DB work + transactional outbox mail).

## Health
`identity.sessions` — ok + active session count.

## Single sign-on (Microsoft Entra ID)

Ships **disabled**. Single tenant only (`common`/`organizations` refused). Never available in the preview profile.

Redirect URI to register in Entra (shown read-only to admins): `{canonicalOrigin}/api/identity/sso/callback`.

### HTTP routes (canonical only; `/api/auth/sso/*`, trailing slashes and case variants are not served)
| Route | Notes |
|---|---|
| `GET /api/identity/sso/start?next=` | Plain sign-in. Sets binder cookie `__Host-rp_sso` (dev `rp_sso_dev`): HttpOnly, Secure, SameSite=Lax, Path=/, 10 min. 303 to Entra (PKCE S256, state, nonce held server-side as hashes / encrypted). |
| `GET /api/identity/sso/start?ticket=` | Session-bound start (link / step_up / test) from `identity.sso.prepare`; the ticket's session must be the browser's live session. |
| `GET /api/identity/sso/callback` | Provider redirect (cross-site GET). Consumes state atomically, bound to the binder. `no-store`, `Referrer-Policy: no-referrer`. 303 to `/sso/complete?attempt=<publicId>` or `/sso/refused?reason=<SSO_*>`. |
| `POST /api/identity/sso/complete` `{attempt}` | CSRF-protected JSON. Burns the attempt first. Returns `{purpose, next, nextStep?, test?}`; sign-in signs out any existing session, then issues the new one. |

Rate-limit category: `auth_high_risk`. Access log uses route templates (no query). nginx: pass `/api/identity/sso/callback` with its raw query to the app unchanged and do not log `$request_uri`/`$args` for it.

### Two-step pattern (G-O01)
- `sign_in`: code exchanged at the callback; verified claims stored encrypted (≤ 2 min, single use).
- `link`, `step_up`, `test`: the callback **parks** the code (encrypted, aad `sso_auth_requests.code:<publicId>`, ≤ 2 min) and never exchanges it. `complete` requires the same binder, the live session equal to the initiating session and user, a full session, unchanged config epoch; only then is the code exchanged. Any mismatch fails closed and burns the attempt.

### ID-token validation
RS256 only (node:crypto), `crit` refused, kid lookup with one bounded refetch per 5 min; iss/aud/azp/tid, exp/nbf/iat (120 s skew, 10 min max age), nonce (hash compare), oid GUID. JWKS/token via egress purpose `entra_oidc` (preset must be enabled).

### Linking
By (tid, oid) only — never by e-mail. Self link (fresh step-up + Entra re-auth), admin bind by object ID (pending until the first Entra sign-in verifies it), JIT (`off` / `customers` / `staff` with an app role; never admin; daily limit). Deactivated / suspended accounts and pending local remediation (`mustChangePassword`) are refused.

### tRPC
`identity.sso.publicConfig` (public), `identity.sso.prepare({purpose, next?}) → {startUrl}`, `identity.sso.myLink`, `identity.sso.unlinkSelf`; `identity.admin.sso.{get, update, setEnabled, bindUser, unbindUser}` (capability `identity.sso.manage`). `identity.me.session.authMethod`; staff/customer list items carry `signInMethods {password, sso: "linked"|"pending"|null}`.

### Lock order (I-A02)
`[assurance policy] → sso_configuration FOR UPDATE → users (ascending id) → user_sessions → sso_identities`. Final completion re-reads the configuration under its lock and re-checks enabled / epoch / tenant / MFA trust; `updateConfig` and `setEnabled` take the same lock before the actor re-validation. A config change either precedes the completion (refused or evaluated under the new policy) or follows it (its revocation covers the new session).

### Break-glass
Admin view includes `breakGlass {localMfaAdministrators, soleLocalMfaAdministratorHasPasskey}` from assurance; enabling requires `assertLocalAdministratorRemains`. Host recovery: `recoverLocalAdministratorPassword` returns `{sessionsRevoked}`.

## Increment 04 — session centre, sign-in log, restrictions (package D)

Everything here ships **disabled** (restrictions `enabled=false`); the sign-in log and session centre are read
views and are always on for holders of the capability.

### Ports provided
```ts
// deps.services.identity.sessions
endAllCustomers(actor: SessionPrincipal, input: { reasonCode: string /* ^[A-Z][A-Z0-9_]{2,39}$ */ }): Promise<{ ended: number }>;
```
Opens its own transaction: `authorizeInTx(actor, "sessions.revoke_any")` (fresh step-up) → actor `users` row →
customer `user_sessions` rows (bounded batches). Never touches staff/admin sessions. Audited
`auth.session.ended_all_customers`; one sign-in-log `forced_end` row per session. Callers must NOT hold other
module locks (call after your own transaction commits). Every forced end (one / user / all customers) records the
acting admin explicitly on the sign-in-log row and the audit event.

```ts
// deps.services.publicApi.registerProvider("customers", …) — registered in IdentityModule.init()
list(query: ApiListQuery, caller: ApiCaller): Promise<ApiPage<CustomerDto>>; // role=customer only
get(publicId: string, caller: ApiCaller): Promise<CustomerDto | null>;      // staff/admin ⇒ null
```
Filters `status` (unknown ⇒ `VALIDATION / FILTER_INVALID`), `search` (≤ 100 chars; exact e-mail via blind index,
reference prefix, name-token prefix — same strategy as the admin customer search), `updatedSince`, cursor (id
desc). Each call is durably audited (`api.customer.listed` / `api.customer.read`, actor system, correlationId =
`caller.requestId`, key public id; never e-mail).

### Ports consumed
- `jobAdmin.maintenance.customerAccess(tx?)` (package E) — local sign-in, registration and SSO refuse customers
  with `FORBIDDEN / CUSTOMER_MAINTENANCE`; SSO refusal code `SSO_MAINTENANCE`. Authoritative call inside the
  session-creating transaction after the users row lock.
- SSO refusal codes `SSO_MAINTENANCE` / `SSO_RESTRICTED` (client messages in `sso/messages.ts`).
- `protection.clientCountry()` (package C) — stored on the session and the sign-in log; `null` = unknown.
- `referrals.attributeRegistration(code, newUserId, tx)` (package G) — optional; called only when a NEW customer
  row is created with `referralCode`. Missing module ⇒ ignored.

### tRPC
| Procedure | Guard | Notes |
|---|---|---|
| `identity.security.overview` | protected | Own live sessions (device, method, country, IP, current) + last 20 own sign-in-log rows. |
| `identity.admin.sessions.list` | admin + `sessions.read_all` (not granted to staff) | Live sessions of all users; filters `role, authMethod, country, userId`; cursor, limit ≤ 100. |
| `identity.admin.sessions.end` | admin + `sessions.revoke_any` (step-up) | `{ sessionId, reasonCode }`. Own current session refused (`OWN_SESSION`). |
| `identity.admin.sessions.endForUser` | admin + `sessions.revoke_any` (step-up) | `{ userId, reasonCode }`; keeps the actor's current session. |
| `identity.admin.sessions.endAllCustomers` | admin + `sessions.revoke_any` (step-up) | `{ reasonCode }` → `{ ended }`. |
| `identity.admin.signInLog.list` | admin + `sessions.read_all` | Filters `kind, userId, role, authMethod, country, ip, from, to`; cursor, limit ≤ 100; newest first. |
| `identity.admin.signInLog.export` (mutation) | admin + `sessions.read_all` + fresh step-up | Same filters, ≤ 5 000 rows CSV text (formula cells prefixed `'`); durably audited. |
| `identity.admin.restrictions.get` / `update` | admin + `sessions.policy.manage` (+ fresh step-up for update) | Versioned (`expectedVersion`). Update refused with `WOULD_LOCK_OUT` when the candidate would refuse the acting admin's current IP/country. |

Sign-in log kinds: `success | failure | lock | sign_out | forced_end | expiry | refused`. Rows hold user (when
known; never the typed e-mail), role, method, session id, IP (encrypted; blind index for exact-IP filter),
country, device summary, reason code, actor (forced ends). Retention 180 days (`identity.signin_log.prune`).

### Restrictions (enforced at session creation and on every request)
Concurrent sessions per user (oldest ended, `concurrency_limit`), idle / absolute lifetime per role (replace
the global settings for that role, same bounds), console IP allow-list (CIDR, staff + admin; unknown IP is
refused), country rule (`off | allow | deny`, scope `all | customers | console`, unknown-country policy).
Per-request violations end the session (`restriction_ip` / `restriction_country`). Cached ≤ 5 s per process.
Break-glass: host recovery (`recoverLocalAdministratorPassword`) also clears restrictions; `PROTECTION_DISABLED=1`
disables enforcement.

## Increment 06 — sign-in signals (D7), policy remediation (D13), profile audit (D11) (package K)

### Ports provided

- `signInSignals.publish({ kind, outcome, userId? }): Promise<void>`: never throws. Call it AFTER the transaction that decided the
  outcome. Kinds: `password | mfa | recovery_code | passkey | password_reset | sso_callback`; outcomes: `success | failure`.
  Forwards `{ ip (trusted request context), accountRef?, kind, outcome, correlationId, at }` to
  `services.protection.recordSignInSignal` when it is mounted. It never carries an e-mail, password, token or name.
- `signInSignals.forEmail(kind, outcome, email)`: the same, keyed by the sign-in identifier, including unknown accounts.
- `signInSignals.accountRefForEmail(email): string | undefined` and
  `signInSignals.accountRefForUser(userId, { tx? }): Promise<string | null>` return the keyed blind index of the normalized
  e-mail (purpose `protection.account_ref`). It is the same value as the audit attribute `account_ref`.
- `endSessionsForUser(userId, reason, { tx? }): Promise<void>` ends every session of the user. `reason` must match
  `^[a-z][a-z0-9_]{2,39}$` (e.g. `policy_deadline`, `policy_declined`, `policy_admin_ended`); otherwise it fails with VALIDATION
  `REASON_INVALID`. An unknown user fails with NOT_FOUND `USER_NOT_FOUND`. It is audited as `auth.session.revoked_all`
  (reasonCode = upper-cased reason, `source: "policy_enforcement"`).
- Batch reads (since increment 05): `getUsersByIds(ids)` (at most 500 ids; returns decrypted views for authorised callers) and
  `findCustomerIds(filter)` (customer audience ids for compliance/policy enforcement).

### Ports consumed

- `services.compliance.policyEnforcement.requiresRemediation(userId, role, tx?) → boolean` (assurance_engineer). When it is
  true, transition step `accept_policy` (always last in TRANSITION_STEPS) holds the session in remediation. It is
  evaluated on every resolve, so an extant full session past the deadline is held before any sweeper runs.
  Fail closed: the check throws if compliance is mounted without the port, if the role is missing, or if the port
  throws. Only a container without a compliance module (isolated harnesses) skips the step.
- `services.protection.recordSignInSignal(signal)` (http_security_engineer). Optional. The banned-IP precheck runs at the HTTP
  entry points, before credentials are examined.

### Audit attributes

- `step` (`password | password_reset | sso`) and `account_ref` on `auth.login.failed / succeeded`,
  `auth.password.reset_completed`, `auth.token.rejected` (non-verify purposes), `auth.password.change_denied` and
  `identity.sso.callback_refused / completion_refused`. `account_ref` is kept in the local store only (never sent to SIEM).
- `identity.profile.updated` carries `name_changed: true`. It records that the name changed, never the name itself (D11).

### Client

- Route `/accept-policy` (transition) and guard `STEP_PATHS.accept_policy`. The page owns the h1 and an always-visible Sign
  out. The compliance forms mount through `PolicyRemediationSlot` (app/slots.tsx). The only possible actions are reading/accepting
  or signing out (the server enforces this: only sessionProcedure endpoints that check `pendingSteps[0] === "accept_policy"`).
