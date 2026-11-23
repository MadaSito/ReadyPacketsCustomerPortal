# Application Protection verification

The checks below cover the HTTP edge, the service, and administrator pages. They do not constitute full WCAG conformance, browser verification, or deployed-environment acceptance.

| Single-file suite | Local result | Coverage |
| --- | --- | --- |
| `server/modules/protection/protection.test.ts` | 4 cases | Address and CIDR normalization, narrow MFA recovery routing, current authorization and step-up, transactional audit, self-lockout refusal, and subsequent requests. |
| `server/modules/protection/signInBans.test.ts` | 4 cases | Request-bound signals, proxy and protected-address guards, detect-mode independence, cross-instance escalation, IPv6 CIDR, atomic release and capped oldest-temporary eviction. |
| `client/src/features/protection/protection.test.tsx` | 18 cases | Seven pages in both themes with `pageA11y`, rule and rate-back-off draft confirmation, proxy warning, disabled manual ban, and Unban focus on cancel and after row removal. |
| `client/src/lib/RateLimitCountdown.test.tsx` | 2 cases | Bounded authoritative header parsing and timer announcements without per-tick live changes. |
| `tests/http/app.test.ts` | 31 cases | Canonical authority, session and CSRF isolation, body ceilings, Public API adapter dispatch, and batched pre-session generic ban refusal with `Retry-After`. |
| `tests/http/rateLimiter.test.ts` | 5 cases | Legacy budgets, shared durable counters, expiry, normalized subjects, bounded back-off, and failure behavior. |

Independent review confirmed the local recovery safeguards and reserved trusted-proxy country header in `docs/verification/INCREMENT_04_SECURITY_REVIEW.md`. For increment 06, test both single-hop shipped proxy profiles on an installed site: a correct external client address, missing forwarding metadata, active allow-list exemption, audit and SIEM projection, and the local operator list/clear workflow with runtime keys. Also verify browser reflow, keyboard navigation, zoom, and contrast; fixture-level axe is not live browser sign-off.
