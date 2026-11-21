# Identity module verification

Test files: `server/modules/identity/pure.test.ts` (pure functions) and `server/modules/identity/identity.test.ts`
(isolated MySQL database, synthetic data, real Argon2id with reduced test-profile parameters; preview/production
profile cases use production parameters). Fakes: audit, mailer, jobs, rate limiter, settings, assurance state.

| Requirement | Evidence | Classification |
| --- | --- | --- |
| Password policy 15–128 code points after NFC, no composition rules, no truncation, blocklist + context words | `pure.test.ts` "password policy" (emoji/NFD counting, 128 boundary, common/sequence/repetition, brand/e-mail/name) | automated-test |
| Ordered transition steps; every ordering; completing a step re-derives the next | `pure.test.ts` "transition derivation" (all 32 fact combinations; walk-to-empty from every start) | automated-test |
| E-mail/name/reference normalization, cursor tamper rejection | `pure.test.ts` "normalization" | automated-test |
| Registration: uniform response, existing-address mail, policy before lookup, closed registration, blind-index throttle key, audit failure ⇒ no row | `identity.test.ts` "registration" | automated-test |
| Sign-in: uniform error (unknown / wrong password / inactive), audit reasons, `user_login` keyed by blind index, token stored only hashed, first step `mfa_challenge` | `identity.test.ts` "sign-in" | automated-test |
| Client-address throttle key for sign-in | Applied by the HTTP/tRPC rate-limit middleware via procedure meta `user_login`; not exercised in this module's tests | target (integration owner) |
| Transparent rehash with compare-and-set (review ID-01) | "transparently rehashes legacy parameters with compare-and-set (ID-01)" incl. concurrent-change CAS miss ⇒ false, newer hash preserved | automated-test |
| Session resolver: malformed/unknown/revoked/idle/absolute expiry, policy change applies to existing sessions, inactive account revoked, preview header refused outside preview, rotation invalidates old token, assurance failure ⇒ fail closed | `identity.test.ts` "session resolver" | automated-test |
| No settings read on a second pool connection inside a transaction (ID-06) | "never reads settings through the pool while holding a transaction (ID-06)" (instrumented settings fake asserts every session-policy read inside tx carries tx) | automated-test |
| E-mail verification single-use + 24 h expiry; resend eligibility + cooldown under row lock, concurrent resends ⇒ one token (ID-03) | "e-mail verification" | automated-test |
| Forgot-password never returns a link, identical response/work for known/unknown/ineligible in preview/test/production; durable job payload `{ emailIndex }` only; intake + audit in one tx; retry-safe handler (ID-02, ID-04) | "password reset (ID-02, ID-03, ID-04)", router "forgot-password via the API never carries a link, even in preview" | automated-test |
| Reset link single use, 30 min expiry, revokes all sessions, refuses non-local accounts; job cooldown incl. concurrent dispatch ⇒ one issue (ID-03) | "redeem …", "cooldown inside the job" | automated-test |
| Change password: current password required, others revoked, current rotated; remediation only when `change_password` is next | "change password" | automated-test |
| Admin authz negatives: customer, staff without capability, remediation session, missing step-up | "admin authorization (ID-05)" | automated-test |
| In-transaction actor re-validation (persisted role, pending steps, persisted step-up) and canonical actor/target lock order; mutual concurrent demotion and mutual suspension leave exactly one active admin, loser gets `SESSION_NOT_CURRENT` (ID-05) | "re-validates the actor inside the transaction", "two admins demoting/suspending each other concurrently" | automated-test |
| Last-admin and self-change refusal | "last-admin protection and self-change refusal" | automated-test |
| Customer create (invitation) → activate single use; preview link only to the admin and only in preview; none in test/production | "create (invitation) → activate …" | automated-test |
| Suspend revokes sessions; reactivate; audited | "suspend revokes …" | automated-test |
| Reference change: optimistic version, permanent retired-reference reservation, history | "reference change …" | automated-test |
| Audit failure ⇒ no status change and no session revocation | "audit failure ⇒ no status change …" | automated-test |
| Customer search (blind-index e-mail, name prefix, cursor) | "search …" | automated-test |
| Router: session issuance only via transport (no token in body), `me` requires session, strict input | `identity.test.ts` "router" | automated-test |
| Ops provisioning: bootstrap admin (active, verified, mustChange, first sign-in ⇒ enroll_mfa, system audit without e-mail), ADMIN_EXISTS refusal, concurrent bootstraps ⇒ one succeeds, demo_seed refused in production, policy/duplicate errors, audit failure ⇒ no account | `identity.test.ts` "provisionLocalAccount (ops scripts)" | automated-test |
| Uniform timing between registration branches and between reset outcomes | Both registration branches perform hash + one transaction + one mail enqueue + one audit row; the create branch additionally inserts rows. Public reset does identical work for every address (lookup is in the job). Timing has NOT been benchmarked; a small residual difference on registration is possible. | not-verified |
| Account, sessions, customers (list, create, detail with role-filtered CUSTOMER_TABS), staff pages; client-side password validation; axe on every page family | `client/src/features/identity/identity.test.tsx` (8 tests, jsdom + axe-core) | automated-test |
| Real-browser rendering, responsive layout, screen-reader and keyboard walkthrough | not run (contract forbids browsers here) | not-verified |
| Real browser / assistive technology | not run in this environment | not-verified |

## Single sign-on (Entra ID) — local fakes only
- `server/modules/identity/sso/sso.test.ts` (36 tests, MySQL): FAKE identity provider (`sso/testing.ts`: synthetic RSA keys, JWKS and token endpoint behind a fake egress `fetchPinned`). No real tenant, no network.
- Covers replayed state, wrong browser, wrong tenant/audience/issuer, alg none/HS256, bad signature, unknown kid bounded refetch, expiry, nonce mismatch, unlinked, deactivated, e-mail collision, JIT never admin + daily limit, allowed domains, `mustChangePassword`, parked-code negatives (no session, other session, replayed handle, expired park), the I-A02 races (deterministic audit-gate interleaving both orders + epoch bump), no code/state/secret in audit.
- `tests/integration/sso-http.test.ts` (assembled pipeline, fake IdP): cross-site callback admitted, binder cookie attributes, no-store/no-referrer, CSRF required on completion, replay refused, aliases not served, no auth material in responses or audit rows.
- Not verified against a real Entra tenant.
