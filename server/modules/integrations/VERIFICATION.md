# `integrations` Module — Security & Engineering Verification (`VERIFICATION.md`)

Owner: `integrations_engineer` (`server/modules/integrations/**`, `client/src/features/integrations/consent.tsx`, `client/src/features/integrations/routes.tsx`; admin console UI under `client/src/features/integrations/admin/**` owned by `identity_engineer`).

---

## 1. Scope & Truthful Verification Status

| Subsystem | Status in This Release | Verification Level |
| --- | --- | --- |
| Outbound Egress & SSRF Policy (`egress.ts`, `ipPolicy.ts`) | Active — enforced for all outbound portal sockets (`siem`, `smtp`, `webhook`, `sharepoint`, `stripe`, `antivirus`) | Unit + MariaDB integration tested (IPv4/IPv6/transition/encoding matrix, DNS rebinding, Node 22 `{ all: true }` pinned lookup, 5 s DNS timeout, redirect refusal, allowlist CRUD + optimistic concurrency) |
| Provider Registry & Health (`index.ts`, `providerChecks.ts`) | Active — reports truthful `disabled \| not_configured \| configured \| degraded \| failing` states | MariaDB integration tested (`mail.smtp` never reports `ok` until a real test mail succeeds) |
| Outbound SMTP Transport (`smtp.ts`, `smtpHelpers.ts`) | Active — TLS-mandatory (`starttls` / `implicit`, port 25 forbidden), write-only encrypted secret, header-injection safe, 3-phase pre-I/O authorized test mail | MariaDB integration + transport-double tested (not exercised against an external live SMTP relay in CI) |
| Public-Route Analytics (`analytics.ts`, `consent.tsx`) | Active (OFF by default) — Clarity + PostHog gated by admin flag, clean `/privacy` or `/terms` URL (`search === "" && hash === ""`), anonymous visitor, in-memory session consent, `data-clarity-mask="true"`, and synchronous JS-realm taint isolation | Server CSP/validation + client jsdom + `MutationObserver` + `axe-core` WCAG AA tested (not exercised against live Clarity/PostHog cloud ingestion) |
| Stripe Payment Webhooks (`stripe.ts`, `http.ts`) | **DISABLED SCAFFOLD** (`STRIPE_LEDGER_MUTATION_ENABLED = false as const`) — online checkout unavailable; webhook verifies `Stripe-Signature` HMAC-SHA256 + durably logs inert received event (`status = "ignored"`, `ledgerMutated: false`) with zero compliance ledger mutation | MariaDB integration + Express HTTP tested (`checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded` proven to leave ledger unchanged; IPv6 `/64` rate-limit key folding verified) |
| SAML 2.0 SSO (`scaffolds.ts`) | **DISABLED SCAFFOLD** (`Not available in this release — local sign-in with MFA is the only active method`) — non-active metadata planning + mandatory security requirements note; no assertion processing | MariaDB integration + admin UI tested |
| SharePoint / Microsoft 365 Sync (`scaffolds.ts`) | **DISABLED SCAFFOLD** — read-only target status and architecture requirements | MariaDB integration + admin UI tested |

---

## 2. Security Controls & Reviewer Findings Closed

1. **SSRF, DNS Rebinding & Node 22 Socket Pinning (`ipPolicy.ts`, `egress.ts`)**:
   - Blocks loopback, unspecified, link-local, cloud metadata (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::254`, `metadata.google.internal`), multicast, broadcast, documentation (`2001:db8::/32`, `3fff::/20`), and all IPv4-embedded IPv6 transition prefixes (`::ffff:0:0/96`, SIIT `::ffff:0:0:0/96`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001::/32`), plus octal/hex/decimal/shorthand IPv4 host tricks and IPv6 zone IDs (`%eth0`).
   - Validates **every** A/AAAA record returned by DNS so dual-record rebinding (`[public, 127.0.0.1]`) fails closed.
   - `createPinnedLookup(pinned)` handles both scalar `(ip, family)` and Node 22 `autoSelectFamily` `{ all: true }` `LookupAddress[]` callbacks without touching OS DNS; `https.request` sets `family: pinned.family` and `autoSelectFamily: false`.
   - Enforces a 5 s DNS lookup deadline (`EGRESS_DNS_TIMEOUT`), a total wall-clock HTTP request deadline (`EGRESS_TIMEOUT`), and refuses all HTTP `3xx` redirects (`EGRESS_REDIRECT_REFUSED`).
2. **SMTP Pre-I/O Actor Authorization, Durable Attempt Audit & Persisted/Pre-Dial Port-25 Refusal (`settings.ts`, `smtp.ts`)**:
   - `smtpConfigSettingSchema` rejects `port === 25` during persisted-setting parse (`not_configured` health), `isCompleteSmtpConfig` requires `cfg.port !== 25`, and `buildPinnedTransportOptions` / `send` / `sendTestMessage` enforce `precheckSmtpPortAndTls` (`SMTP_PORT_25_FORBIDDEN`, `failing` health) immediately before dialing so even directly seeded or restored port-25 DB settings never open a DNS lookup or socket.
   - `sendTestMessage` runs a short DB transaction **before** revealing secrets or opening network sockets: re-validates the actor via `identity.sessions.assertCurrent(principal, tx)`, reads SMTP config/secret inside `tx`, and writes a durable `integration.smtp.test_attempted` (`outcome: "attempted"`) audit event. Revoked sessions or unavailable audit stores abort with zero outbound SMTP connection attempts and zero DB locks held across network I/O.
   - Outbox `send()` distinguishes pre-connection errors (`retryable: true`) from post-connection drops without an SMTP status code (`outcome: "unknown"`) so mail workers never auto-duplicate ambiguous deliveries.
3. **Synchronous Analytics JS-Realm Quarantine (`INT-01`) & Clean URL Gate (`consent.tsx`, `client/src/lib/realmTaint.ts`)**:
   - Clarity and PostHog remain disabled by default.
   - Refuses to render or mount Clarity/PostHog whenever `window.location.search !== ""` or `window.location.hash !== ""` so query/fragment tokens on legal URLs can never be read by vendor code.
   - Sets `data-clarity-mask="true"` on `document.documentElement` before mounting the Clarity script tag.
   - Calls `markRealmTainted("clarity")` **synchronously immediately before** appending the `<script>` tag and `markRealmTainted("posthog")` **synchronously immediately before** sending `fetch(...)`. App-root `<RealmTaintBoundary>` and `<TaintedRouteGate>` (`client/src/app/RealmTaint.tsx`) refuse to render any non-public or authenticated DOM in a tainted realm and trigger a full-document navigation (`requestCleanRealm`) instead.
   - Keeps a latched `history.pushState`/`replaceState` guard armed for the lifetime of the tainted document so programmatic SPA navigations to non-public paths or `?search`/`#hash` URLs are refused before `pushState` mutates `window.location` (including repeated attempts while async document replacement is in flight). Browser-driven `popstate`/`hashchange` events fire after the browser updates `window.location`; capture-phase listeners stop router propagation and request a clean realm. Same-origin script/API authority in a vendor-loaded document remains an acknowledged residual outside the React DOM quarantine.
4. **Stripe Hard-Disabled Scaffold (`stripe.ts`, `http.ts`)**:
   - Hard-disabled behind `STRIPE_LEDGER_MUTATION_ENABLED = false as const`. `isOnlinePaymentConfigured()` always returns `false`; `updateConfig({ enabled: true })` fails with `STRIPE_NOT_AVAILABLE_IN_RELEASE`.
   - Signed webhooks verify `Stripe-Signature` over raw bytes, normalize client IP rate-limit keys via `rateLimitAddress(req.ip)`, record inert `ignored` rows + audit notes with `ledgerMutated: false`, and never invoke ledger booking.
5. **Cross-Model Transaction & Zero-Trust Invariants**:
   - All `db.transaction(...)` blocks pass `tx` to `settings`, `audit.record(..., tx)`, and `identity.sessions.assertCurrent(principal, tx)` — verified non-deadlocking on a `connectionLimit: 1` MySQL pool.
   - `deleteAllowlistRule` writes its durable `integration.egress.rule_deleted` audit record inside the same transaction **before** executing `DELETE`, and rolls back fail-closed if audit persistence fails.

---

## 3. Automated Test Suites Executed

```bash
source scripts/dev/env.sh
scripts/dev/tc.sh
scripts/dev/lint.sh server/modules/integrations client/src/features/integrations/consent.tsx client/src/features/integrations/consent.test.tsx client/src/features/integrations/routes.tsx
scripts/dev/test.sh server/modules/integrations/integrations.test.ts client/src/features/integrations/consent.test.tsx client/src/features/integrations/admin/integrationsAdmin.test.tsx
```

- `server/modules/integrations/integrations.test.ts` — **10/10 passing** (including seeded DB + pre-dial port-25 zero-socket regression)
- `client/src/features/integrations/consent.test.tsx` — **5/5 passing** (including `markRealmTainted` pre-script/pre-fetch ordering, `RealmTaintBoundary` + `TaintedRouteGate` `MutationObserver` zero-private-DOM-commit proof, & `axe-core` WCAG AA check)
- `client/src/features/integrations/admin/integrationsAdmin.test.tsx` — **7/7 passing**
