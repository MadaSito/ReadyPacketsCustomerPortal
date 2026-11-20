# Security and correctness review: HTTP edge, security primitives, jobs

Reviewer: portable_engineer (cross-model review, read-only outside this file).
Scope: `server/http/**`, `server/security/**` (owner http_security_engineer); `server/modules/jobs/**` (owner jobs_engineer); `server/config/env.ts` lines 360–390 where it gates the profiles that these modules depend on.
Method: I traced each code path by hand at the HEAD at the time of review (`678946b`). One finding has an offline reproduction (H-2). No repository tests were added or changed, and no server, browser, or database was run. The evidence class for each finding is listed.

## Summary

| ID | Severity | Area | Evidence |
|----|----------|------|----------|
| H-1 | Medium | Audit writes and session DB lookups happen before any rate limit | code-read |
| H-2 | Medium | Rate-limit slots use an unkeyed hash, which enables targeted lockout; IPv6 /128 keys allow rotation | code-read + offline reproduction |
| H-3 | Low–Medium | Preview profile can run with `NODE_ENV=production` on any non-readypackets host, which relaxes host, CORS, framing, and mail capture | code-read |
| J-1 | Low | Lease and fencing time comes from each process's own clock, so clock skew can cause concurrent execution of retry-safe jobs | code-read |
| I-1 | Info | A missing client IP falls back to a shared `ip:unknown` bucket | code-read |
| I-2 | Info | Fixed-window limiter allows about 2× burst at window edges | code-read |

## Findings

### H-1 (Medium): unthrottled pre-limit work, including audit writes
- `server/http/app.ts:227-241`: step 5 calls `services.sessionResolver.resolve(...)` (a DB lookup) for any request that has a credential of 512 characters or fewer.
- `server/http/app.ts:243-257`: step 6 sends every origin or CSRF failure to `denyBrowserRequest` (`app.ts:113-124`), which writes a durable `security` audit event through `services.audit.record`.
- `server/http/app.ts:259-269`: the per-IP admission limit runs only after steps 5 and 6. `/api/csrf`'s origin denial (`app.ts:283`) also writes an audit event, and the edge limit for it runs earlier.
- Impact: an unauthenticated client can send unlimited cross-origin POSTs (or POSTs without a CSRF token). Each one writes a hash-chained audit row and possibly a SIEM forward, with no budget. This floods the audit store and SIEM and hides real events (OWASP A09/A04). Random session tokens likewise cause one DB lookup per request with no throttle.
- Fix: move a cheap per-IP admission check (for example `standard_browsing`/`api` by `ip:`) before step 5. Keep the stricter tRPC per-category budget in step 7. Also coalesce denial audits: record at most one `http.origin.denied` / `http.csrf.denied` per IP slot per minute with a `safeCounts.suppressed` counter, and log the rest at WARN with sampling.

### H-2 (Medium): predictable rate-limit slot collisions; IPv6 rotation
- `server/security/rateLimiter.ts:59,72`: `slot = sha256(category "\0" key)[0..4] & (2^18-1)`, with primary key `(category, slot)` (`rateLimiterSchema.ts:10`). The hash has no key, and edge keys are `edge:ip:<addr>` / `ip:<addr>` (`app.ts:215,262,269`), so anyone who knows a victim's IP can compute its slot offline.
- Reproduction (offline, Node, same derivation): for `user_login` and the victim key `edge:ip:203.0.113.7`, a search over addresses in one documentation /64 found the colliding address `2001:db8:1:2::5:7ad7` after 359,127 tries in 0.9 s. An attacker who controls one IPv6 /64 can therefore find, in under a second, an address that shares the victim's bucket. They then spend the strictest tRPC budget from it (`user_login`: 15 per 300 s, `app.ts:269`), which locks the victim IP (for example a customer office NAT) out of sign-in and all tRPC calls. The code comment ("collisions … never a limiter bypass") is right about bypass, but it misses this denial-of-service case.
- Related: `server/http/edge.ts:29-31` returns the full IPv6 /128 address. One host with a /64 can rotate through 2^64 subjects and avoid every per-IP edge budget. The per-identity limits in `identity/auth.ts` (keyed by HMAC blind index) remain effective.
- Fix: derive the slot with an HMAC keyed by a server secret (a subkey of `tokenHashKey` with its own label), so slots cannot be predicted. Also normalize IPv6 subjects to the /64 (and IPv4-mapped addresses to IPv4) before building `ip:` keys. If the table size allows, consider widening the slot to more than 2^18.

### H-3 (Low–Medium): preview profile allowed in production runtime
- `server/config/env.ts:377-387`: `NODE_ENV=production` is refused only for profiles other than `preview`, and preview is refused only on `*.readypackets.com`. The production-only checks (`env.ts:363-376`: https, DB password strength, absolute storage) are skipped for preview.
- Effects in preview: every Host header is accepted (`previewProfile.ts:25`, `app.ts:177`); `/api` responds with `Access-Control-Allow-Origin: *` (`previewProfile.ts:28`); `frame-ancestors` and `X-Frame-Options` are dropped (`headers.ts:36,59`); identity responses carry `previewLink` (`identity/auth.ts:56`); and mail capture is allowed because `MailEngine.captureEnabled` refuses only `deploymentProfile === "production"` (`jobs/mail.ts:136`; also `jobs/admin.ts:226`). A self-hosted operator who sets the wrong profile on their own domain silently loses host validation and clickjacking protection, and admins can read captured mail, including reset links.
- Fix: in `env.ts`, refuse `preview` when `NODE_ENV=production`, or require a second explicit acknowledgement variable plus a loopback `HOST`. In `mail.ts`, allow capture only when the profile is in an allowlist (`development`, `test`) instead of using a denylist.

### J-1 (Low): lease time from the process clock
- `server/modules/jobs/queue.ts:297` (claim `leaseUntil = local now + 30 s`), `:335,338` (`#owned` compares with local now), `:348` (heartbeat), `:422` (reaper `leaseUntil <= local now`), and `mail.ts:220` all use `deps.clock.now()` from the calling process, not DB time.
- Impact: with two worker hosts, if the claimer's clock is more than about 24 s behind the reaper's (LEASE_MS 30 s minus HEARTBEAT_MS 6 s), the reaper settles a live claim. Retry-safe handlers then requeue and can run concurrently with the original. The original's DB writes are still correctly fenced (`#owned` checks state and fencing token under `FOR UPDATE`), so impact is limited to external side effects of handlers already declared idempotent. Non-retry-safe jobs, including `jobs.mail.deliver` (`maxAttempts: 1`), move to `unknown`/`MAIL_NOT_STARTED`. The claimer's `#lockedMail → assertStillOwned` then refuses to send, so this causes no double send, only false "unknown" outcomes.
- Fix: compute lease bounds in SQL (`UTC_TIMESTAMP(3)` with `DATE_ADD`) for claim, heartbeat, `#owned`, and reap. Alternatively, at worker start and every N minutes, compare the local clock with `SELECT UTC_TIMESTAMP(3)` and refuse to claim when skew exceeds 5 s.

### I-1 / I-2 (Info)
- `app.ts:215,262`: when `clientAddress` returns `undefined` (socket without an address, or a non-IP `req.ip`), all such requests share `ip:unknown`. This fails closed and is rare. Consider logging it at WARN once per minute.
- `rateLimiter.ts:82-84`: fixed windows allow up to 2× `maxRequests` across a boundary. Acceptable given the separate per-identity limits; document it in the budget table.

## Checked, no issue found
HTTP and security:
- Host validation (`edge.ts` host regex, X-Forwarded-Host ignored, alias redirect only for port-less alias hosts that concatenate an origin-form target, and `//x` stays a path under the canonical origin).
- CSRF: session tokens are HMAC-bound to session id and csrf secret; anonymous tokens use an HMAC with TTL; double-submit uses `secureEqual`; Origin is required on unsafe methods; the only exemption is the signed-webhook router, which is terminal and rate-limited before body parsing.
- Cookies: `__Host-` prefix with Secure, Path=/, and no Domain on https; session cookie is httpOnly; SameSite=Strict.
- Preview transport is reachable only when `previewTransportEnabled` (profile `preview`); production config refuses it.
- CORS: no CORS headers outside preview.
- CSP: per-request nonce, nonce replaced in the SPA shell per response, analytics CSP extension limited to exact https origins.
- Body limits: JSON 256 KiB `inflate:false`; webhook raw 256 KiB.
- Error disclosure: `errors.ts` maps only DomainError and known body-parser types, everything else becomes a generic `INTERNAL`.
- Static/SPA: `send` normalizes paths, dotfiles are ignored, direct `.html` is blocked, fallback only for navigations.
- Limiter failure modes: fails open only for `standard_browsing`, fails closed for every other category including settings read failure.
- Trusted proxy: numeric list only, so Express takes the right-most untrusted XFF hop, and `traceparent` is honored only from trusted proxies.
- Downloads: sanitized RFC 6266 filename, `nosniff`, `sandbox` CSP, no-store.

Jobs:
- Fencing CAS: `#owned` checks publicId, state=running, fencing token, and lease under `FOR UPDATE`, rechecked after the lock wait. finish, interrupt, and reap serialize on the row lock.
- Unknown-outcome handling: a handler throw becomes `interrupted`, which becomes `unknown` unless retry-safe; `interruptionPending` carries forward; only a completion clears it; admin cancel of an uncertain retry yields `unknown`; acknowledge purges the payload.
- Scheduler: duplicate firing is prevented by the unique `(schedule_name, schedule_slot)` index plus the upsert and select `FOR UPDATE`.
- Mail: subject and address reject control characters and U+2028/2029, so there is no header injection; HTML alternative is escaped. The sending marker commits before the provider call. A crash while `sending` resolves to `unknown` and the payload is purged. Accepted, unknown, and non-retryable failed messages purge the payload; the expiry job purges queued, held, failed, and captured payloads. Resend requires held/failed with a retained payload, before expiry, and generation below 20.
- Admin: every operation re-authorizes (role admin, full session, capability, fresh step-up for step-up capabilities) and audits denials. Capture view is a POST, gated by capability and capture setting, with not-found when disabled.

## Limitations
I did not run code against MySQL and added no tests, so the race and skew analysis rests on reading the code. I did not review `fieldCrypto.ts` in depth, the trpc context, or the sessionResolver internals.

## Remediation re-verification

### H-1 / H-2, fixed in `70555c1` (re-verified by code-read; `rateLimitAddress` exercised offline)
- **H-1 resolved.** `app.ts` now places a process-local pre-gate (`edgeAdmission.ts`) after host validation. The pre-gate is HMAC-slotted with an HKDF subkey (2^16 slots, 120 requests per 10 s) and checks the canonical Origin for unsafe methods and for `/api/csrf`. It runs before the webhook route, the durable limiter, body parsing and session resolution. The durable per-IP and tRPC budgets now also run before `express.json` and `sessionResolver.resolve`. Denials go through `audit.note`, which is a bounded, never-throwing in-memory queue that counts drops. Notes are sampled at one per address slot per minute per kind. Nothing touches the database, looks up credentials or writes a durable audit row before the gate.
- **H-2 resolved.** In `rateLimiter.ts`, slots are now `HMAC(HKDF(tokenHashKey, "readypackets/http/durable-rate-limit-slot/v1"), category‖0‖normalizedKey)`, so they can no longer be computed offline. `rateLimitAddress` maps IPv6 to its /64 and IPv4-mapped addresses to IPv4, and `normalizeRateLimitKey` also covers `ip:`/`edge:ip:` keys built by other modules. I ran the function on these inputs: `2001:db8:1:2::5:7ad7` and `2001:0db8:0001:0002:ffff::1` both become `2001:db8:1:2::/64`, `::ffff:203.0.113.7` becomes `203.0.113.7`, `fe80::1%eth0` becomes `fe80:0:0:0::/64`, and `2001:db8::` becomes `2001:db8:0:0::/64`. Every spelling of the same /64 gives the same output.
- **Residual (Info).** A client holding a /48 has 65,536 /64s. It can still create up to about one origin note and one CSRF note per pre-gate slot per minute, which could fill the bounded note queue and drop other best-effort notes. The durable audit chain and the decision to deny are not affected. Optional fix: a global token bucket for `http.*.denied` notes, plus a periodic aggregate "suppressed" count. Separately, honest users who share a pre-gate slot share its 120 requests per 10 s. With HMAC keying, collisions are random and cannot be targeted.

### J-1 / jobs H-3, fixed in `4055453` (spot-checked by code-read)
- Lease bounds now come from the database clock (`UTC_TIMESTAMP(3)` / `TIMESTAMPADD`) in the claim, heartbeat, ownership and reap paths I sampled. Mail capture is now an allowlist: `allowsMailCapture` permits only `development` and `test`. I did not re-run the owner's MySQL tests.
- **Still open: the `env.ts` part of H-3.** NODE_ENV=production with the preview profile on a non-readypackets host is still allowed. This belongs to the config owner.

### H-3 env part — `86d4ec1`: mitigated + accepted residual (code-read)
- `env.ts` now refuses the preview profile in every NODE_ENV unless `RP_PREVIEW_ACKNOWLEDGED` is exactly `synthetic-data-only`; readypackets.com origins and aliases remain refused; a stray acknowledgement outside preview warns.
- `platform/module.ts` logs one startup WARN (`platform.preview_profile.active`) and exposes `preview: true` to the shell for a permanent banner.
- Accepted residual (ADR 0002): preview with NODE_ENV=production on a non-readypackets host remains the intended hosted-demo configuration, with relaxed host/CORS/framing by design. It now requires a deliberate, exact operator acknowledgement, so the accidental-misconfiguration path in the original finding is closed. Mail capture is independently refused in preview (`4055453`).

## Addendum: assurance (WebAuthn + TOTP + recovery codes)

Scope: `server/modules/assurance/{passkeys,factors,store,policy,schema}.ts` (owner assurance_engineer), reviewed at `8c549b3` by
code-read only (no tests added or run). Severity summary: **1 Medium, 3 Info.**

### A-1 (Medium): no consecutive-failure limit on TOTP; budget-only throttling allows slow online guessing
- `policy.ts:43-45` throttles every second-factor attempt with the per-account `auth_high_risk` budget, whose default is
  30 per 300 s (`server/security/rateLimiter.ts` `DEFAULT_BUDGETS`). `factors.ts:57-67` accepts any of 3 steps (`store.ts:82`
  `window: 1`). `assurance_accounts` (`schema.ts:6-22`) has no failure counter, and nothing escalates, locks or notifies on
  repeated wrong codes; each denial is only audited (`factors.ts:96-98`).
- Impact: an attacker who has the password (the precondition for an `mfa_challenge` remediation session) can submit
  30 codes / 5 min ≈ 8,640/day indefinitely. With p ≈ 3·10⁻⁶ per guess that is ≈ 2.6 % per day and ≈ 54 % over 30 days of
  sustained guessing. NIST SP 800-63B §5.2.2 requires limiting consecutive failed attempts (≤ 100) for OTP authenticators.
- Fix: add `totp_failures` (and `totp_locked_until`) to `assurance_accounts`, incremented under the existing account lock and
  reset on success; after e.g. 10 consecutive failures require a passkey or recovery code (or apply an exponential delay),
  notify the user via `engagement.notify`, and audit `auth.totp.locked`. Recovery codes (128-bit random) need no such limit.

### A-2..A-4 (Info)
- A-2: authenticator data backup flags (BE/BS, `credentialDeviceType`, `credentialBackedUp`) are neither stored nor used
  (`passkeys.ts:96-114`). Synced passkeys are therefore accepted silently; storing the flags would let the audit center
  and a future policy distinguish device-bound from synced credentials.
- A-3: `window: 1` accepts the next step; using it advances `lastTotpStep`, so the legitimate user's current-step code is then
  refused as replay for up to 30 s (`factors.ts:62`). Usability only; consider `window` past-only (−1..0).
- A-4: `beginRegistration` uses the account e-mail as the WebAuthn `userName` (`factors.ts:274` → `passkeys.ts:76`), which is
  stored on the authenticator and may be shown on shared devices. Acceptable; a customer reference would disclose less.

### Checked, no issue found
- Ceremony binding: challenges are hashed, bound to user + session + purpose (unique index), 2-minute TTL, created and taken
  under the per-account `FOR UPDATE` lock, deleted on take, and the deletion commits even for invalid proofs (callers return
  `null`/`false` inside the transaction and throw only after commit) — single use holds for challenge, step-up, recovery-reissue
  and registration.
- Origin / RP ID: `expectedOrigin` = canonical origin, `expectedRPID` = canonical hostname; `crossOrigin: true` and any
  `topOrigin` are refused before verification; alias hosts redirect, so no second RP ID exists.
- User verification `required` in options and enforced (`requireUserVerification: true`) for registration and assertion;
  attestation `none` with `fmt === "none"` enforced; algorithms limited to ES256/EdDSA/RS256; `excludeCredentials` and a
  10-key limit re-checked inside the lock; global credential uniqueness by blind index + unique key.
- Credential lookup is scoped to the session's user; `userHandle`, when present, must equal the user's publicId.
- Signature counter: verified with the library counter at 0, then a stored counter > 0 requires a strictly greater signed
  counter; regressions are denied and audited (`auth.passkey.counter_regression`). Counterless (0/0) authenticators work.
- TOTP replay: the matched step must be strictly greater than `last_totp_step`, updated in the same locked transaction;
  enrolment binds the pending secret to the session, expires in 10 minutes, and seeds `last_totp_step` on confirmation.
- Recovery codes: 10 × 128-bit random, stored only as keyed `hashToken` bound to the user id, format-validated before hashing;
  redemption is a conditional `UPDATE … WHERE used_at IS NULL` with `affectedRows === 1` under the account lock (safe under
  concurrency); regeneration deletes the old set and resets acknowledgement; use triggers an in-app notification and audit.
- Step-up verifies the password against the locked current credential, then the factor, in one transaction.
