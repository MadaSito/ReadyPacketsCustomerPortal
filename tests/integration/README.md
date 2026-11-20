# Assembled-system integration suite (`tests/integration/**`)

These are journey tests that drive the REAL system the way a browser does:

- `createContainer(testConfig(...))` on a real MySQL test database (`tests/helpers/testDb.ts`, full schema).
- The real `createApp` from `server/http/app.ts`, driven with Supertest.
- The `__Host-` cookie transport plus the double-submit CSRF header.
- Canonical `Host`, `Origin` and `Sec-Fetch-Site` on every request.

The only substitutions are a `FakeClock` (so TOTP codes, cooldowns and expiries are deterministic) and a storage directory under a temporary folder.

Owner: identity_engineer.

## Running

Run one journey at a time (each file is independent and builds its own database):

```sh
source scripts/dev/env.sh
scripts/dev/test.sh tests/integration/journey-customer.test.ts
scripts/dev/test.sh tests/integration/journey-admin.test.ts
scripts/dev/test.sh tests/integration/isolation.test.ts
scripts/dev/test.sh tests/integration/transport-negative.test.ts
```

## Files

| File | Covers |
| --- | --- |
| `harness.ts` | Builds the system (`createSystem`), plus a `Browser` with a cookie jar, CSRF and per-browser client address. Other helpers: `drainJobs`, `inbox` (captured outbox mail, never preview links), `audit` (audit_events by request id or event), TOTP helpers, `bootstrapAdmin` (identity.provisionLocalAccount), `registerCustomer`, `seedProduct`, and `responseLog` (every response a browser saw). |
| `journey-customer.test.ts` | Register, then verify via the mailed link and sign in to a remediation session (`__Host-` cookie attributes asserted). Next: forced TOTP enrolment, recovery-code acknowledgement and a full session. Then: catalog, order, note, upload, single-use download ticket (in the POST body), an order message (idempotent), and sign-out. Every mutation is refused without CSRF (with an `http.csrf.denied` audit note), and every step's audit events carry the response's `X-Request-Id`. |
| `journey-admin.test.ts` | Bootstrap admin (only once), forced TOTP plus password change, step-up gate, then invite a customer (link by mail only). The customer activates and orders; the admin sees the order. Least-privilege staff get FORBIDDEN/NOT_FOUND on admin capabilities, and the audit center filters (event name in/prefix, actor role, request id, outcome) are checked. A sweep over the live `appRouter` confirms every `.admin.` or staff/admin-guarded procedure refuses a full customer session (FORBIDDEN/NOT_FOUND) and an anonymous caller (UNAUTHENTICATED). |
| `isolation.test.ts` | Two customers. B presents A's order, file, grant, message, ticket, notification, invoice and session ids to every customer-reachable by-id procedure and gets NOT_FOUND. B's lists and search never surface A's data. B cannot attach A's file, upload to A's order or redeem A's download ticket. A's data is unchanged. A coverage sweep fails when a new customer-reachable procedure takes a resource id that is not probed. |
| `transport-negative.test.ts` | Runs in the `test` (non-preview) profile. The `x-rp-preview-session` header is ignored even with a live token. No response in a link-issuing run (register, reset, customer/staff invite and resend) contains `previewLink` or a preview transport header. An unknown Host gets 400 `HOST_NOT_ALLOWED`, and the alias host gets 308 to canonical. Cross-site, same-site sibling, scheme-downgrade, `null` and missing Origins get 403 `ORIGIN_NOT_ALLOWED`, each with an `http.origin.denied` note. Missing or mismatched CSRF gets 403 `CSRF_INVALID`, each with an `http.csrf.denied` note. |
| `journey-integrations.test.ts` | Uses `createSystem({}, { spaShell: true })`, which serves a minimal `index.html` so HTML navigations reach the shell and its analytics-CSP hook. Analytics updates are refused before step-up, and malformed Clarity ids or `phx_` keys get 400. `integrations.publicAnalyticsConfig` exposes only `{clarity:{enabled,projectId}, posthog:{enabled,key,host}}`. The CSP has no vendor origins while analytics is off. Enabling Clarity adds only Clarity origins, and enabling PostHog adds only its host to `connect-src` (never `script-src`). This happens only on anonymous navigations to `/privacy` and `/terms`: never on `/login`, `/account`, `/admin` or `/orders`, never for a signed-in session and never on non-HTML requests. Switching both off removes the origins again. SMTP to a private relay is refused until an egress rule allows it. The password is write-only: `smtp.get` shows `passwordConfigured` only, omitting it keeps the stored value, `null` clears it (refused as incomplete while enabled), and the secret never appears in any response body or audit row. Scaffolds report `scaffoldOnly`, and Stripe refuses `enabled: true`. |

## Harness decisions (and why)

- **Rate limits.** Every durable `http.rate_limit.<category>` setting is raised to 100000/60 s for the test system. Journeys make more calls per minute than any human, and the limiter itself is covered by `tests/http`.
- **Edge pre-gate.** The process-local edge pre-gate (`server/http/edgeAdmission.ts`, 120 requests per 10 s per address) is not relaxed. Instead, each `Browser` advances the fake clock by 10 s every 100 requests, and every browser presents its own documentation-range client address via `X-Forwarded-For` (loopback is a trusted proxy in the harness config).
- **Denial audit notes.** These are de-duplicated per address per minute, by design against audit flooding. Probes that must each be audited use `freshProbeAddress()`.
- **Mail.** `jobs.mail.capture` is on, and links are read from the captured outbox after `drainJobs()`, exactly as delivered.
- **Notification fixture.** The isolation suite emits A's notification through the service-internal `engagement.notify` (the same path every module uses).

## Not yet exercised (`it.todo`)

- Passkey cross-account probe: needs a virtual WebAuthn authenticator fixture. Today `assurance.renamePasskey` and `assurance.removePasskey` are probed with an unknown id only.
- Published-policy acceptance against another customer's order: needs an admin-published policy fixture. Today `compliance.policies.accept` is probed with an unknown version.
- SIEM/syslog forwarding end to end: needs a local TLS syslog sink fixture.
- Backup and integrations admin flows through the assembled app: covered by the owners' module suites today.
- Audit center UI: client-side, out of scope for this server suite.

## Defects found by this suite (routed to owners)

- orders: the O-02 snapshot transaction was rendered as invalid MySQL (`START TRANSACTION WITH CONSISTENT SNAPSHOT READ ONLY`), so `orders.admin.get` returned 500. Fixed in ad377b8.
- compliance: an over-long generated FK identifier blocked creating the full schema. Fixed in e400060; the harness now uses the full schema.
