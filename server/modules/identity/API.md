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

verifyPassword(userId: number, password: string): Promise<boolean>;   // constant-ish timing, transparent Argon2id rehash
setPassword(userId: number, password: string, opts: {
  mustChange: boolean; tx?: Tx;
  revokeSessions?: { exceptSessionId?: string; reason: string };   // omitted = no revocation
}): Promise<void>;   // enforces policy (throws DomainError VALIDATION/PASSWORD_*); retires all outstanding reset/set-password tokens
generateTemporaryPassword(): string;            // policy-compliant, 20 chars from an unambiguous alphabet
issueAdminSetPasswordLink(userId: number, opts: { tx: Tx }): Promise<{ previewLink?: string }>;
// retires prior tokens, makes the old password unusable (hash cleared), queues `auth.admin_set_password` mail in tx.
// The password the user chooses through the link is their own, so must_change is cleared when they use it.

sessions: {
  markMfaVerified(sessionId: string, opts?: { tx?: Tx }): Promise<IssuedSession>;  // sets mfaVerifiedAt + rotates
  markStepUp(sessionId: string, opts?: { tx?: Tx }): Promise<IssuedSession>;       // sets stepUpAt (+mfaVerifiedAt) + rotates
  rotate(sessionId: string, opts?: { tx?: Tx }): Promise<IssuedSession>;
  revoke(sessionId: string, reason: string, opts?: { tx?: Tx }): Promise<void>;
  revokeAllForUser(userId: number, opts: { exceptSessionId?: string; reason: string; tx?: Tx }): Promise<number>;
  /** Locks users row FOR UPDATE, then the session row FOR UPDATE; throws UNAUTHENTICATED SESSION_NOT_CURRENT if
   *  revoked/expired/user not active. Use at the start of authenticated credential mutators. */
  assertCurrent(principal: SessionPrincipal, tx: Tx): Promise<void>;
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
  derive(userId: number, session?: { mfaVerifiedAt: Date | null }): Promise<TransitionStep[]>;
};

createPendingCustomer(input: {
  email: string; name: string; customerRef?: string | null; publicId?: string;   // publicId = preserve portable identity
}, opts: { tx: Tx }): Promise<{ userId: number; publicId: string; customerRef: string }>;
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
| `requestPasswordReset` | public (`auth_high_risk`) | `{ email }` → `{ accepted: true, previewLink? }` |
| `resetPassword` | public (`auth_high_risk`) | `{ token, password }` → `{ reset: true }` (revokes ALL sessions; user signs in again) |
| `activateAccount` | public (`auth_high_risk`) | `{ token, password }` → `{ activated: true }` (invitation; verifies e-mail) |
| `me` (query) | session | → `{ user: { publicId, role, name, email, customerRef, status }, state, pendingSteps, nextStep }` |
| `resendVerification` | session | → `{ accepted: true, previewLink? }` (throttled) |
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
Preview profile ONLY: `previewLink` is returned in responses so the sandbox demo can proceed without SMTP.

## Audit events (category security unless stated)
`auth.register.requested`, `auth.login.succeeded|failed|refused`, `auth.logout`, `auth.email.verified`,
`auth.password.reset_requested|reset_completed|changed|set_by_admin`, `auth.session.rotated|revoked|revoked_all`,
`admin.customer.created|status_changed|reference_changed|invitation_sent` (admin), `admin.staff.created|role_changed` (admin),
`identity.customer.imported_pending` (portable_transfer).

## Lock ordering (all modules)
`users` row → `user_sessions` row(s) → `identity_tokens` → other modules' rows (e.g. assurance account).
Identity never locks another module's rows. Admin flows lock the TARGET users row first.

## Settings keys
`identity.session.idleMinutes` (default 30, 5–240), `identity.session.absoluteHours` (default 12, 1–72),
`identity.login.maxFailures` (default 10 per 15 min per account).

## Health
`identity.sessions` — ok + active session count.
