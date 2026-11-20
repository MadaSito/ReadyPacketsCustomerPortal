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
