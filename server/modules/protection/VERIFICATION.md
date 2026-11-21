# Application Protection verification

The local checks below cover the HTTP edge, the service, and the six administrator pages. They do not constitute full WCAG conformance, browser verification, or deployed-environment acceptance.

| Single-file suite | Local result | Coverage |
| --- | --- | --- |
| `server/modules/protection/protection.test.ts` | 3 passed | Address and CIDR normalization, narrow MFA recovery routing, current authorization and step-up, transactional audit, self-lockout refusal, and subsequent requests. |
| `client/src/features/protection/protection.test.tsx` | 13 passed | Six pages in light and dark with `pageA11y`, plus draft confirmation and focus return on cancel. |
| `tests/http/app.test.ts` | 23 passed | Canonical authority, session and CSRF isolation, bounded raw request bodies, Public API adapter dispatch, early problem responses, and security headers. |
| `tests/http/rateLimiter.test.ts` | 4 passed | Shared durable counters, expiry, normalized subjects, and failure behavior. |

Independent review confirmed the local recovery safeguards and reserved trusted-proxy country header in `docs/verification/INCREMENT_04_SECURITY_REVIEW.md`. Remaining deployment checks include end-to-end MFA recovery with restrictive policies, real country MMDB and custom proxy behavior, and browser reflow, keyboard navigation, zoom, and color contrast.
