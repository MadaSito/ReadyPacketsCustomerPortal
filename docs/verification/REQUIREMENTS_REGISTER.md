# ReadyPackets portal — requirements-to-evidence register

Status: first complete draft, 2026-11-20. Owner of this document: orders_engineer. Integration is still in
progress; rows for modules still landing are marked "pending owner report" and will be refreshed once when the
lead declares integration complete.

## How to read this register

Sources walked: `docs/source-specs/MASTER_PROMPT.md` (MP, §2–§11), `docs/source-specs/ARCHITECTURE.md` (ARCH,
only where it adds a requirement not already stated in MP), and the 17 project instructions (PI-01…PI-17, as
condensed in `docs/application-context/APPLICATION_CONTEXT.md`).

Every cited test file was opened and the quoted test name confirmed to exist in the checkout at the time of
writing (`rg` over `it("…")` names). Test names are abbreviated with "…" where long.

Evidence class tags (MP §11 requires evidence categories to stay separate):

| Tag | Meaning | What it does NOT prove |
| --- | --- | --- |
| [unit] | Pure unit test, or module test with injected fakes | Real integration with the faked dependency |
| [db] | Synthetic integration test against a real, isolated MySQL test database | Production configuration, load, real network peers |
| [loopback] | Real sockets on loopback (e.g. TLS test collector, test SMTP) | Real third-party providers, real certificates |
| [jsdom] | React Testing Library in jsdom, optionally with axe-core | A real browser, real layout/zoom, assistive technology |
| [review] | Independent source review recorded in `docs/security/REVIEW-*.md` | Runtime behaviour |

Status values:

- **Verified by automated test** — an automated test asserts the stated behaviour at the tagged evidence class.
  It is never a claim about a deployed system, a browser, or a certification.
- **Implemented, not independently verified** — code exists; no automated test asserts it (or only a reviewer
  read it).
- **Partially implemented** — some of the requirement exists; the gap is stated.
- **Not implemented** — no implementation found in the checkout.
- **Out of scope** — with the reason.
- **Pending owner report** — module still landing; no VERIFICATION.md yet. Whatever could be confirmed from the
  module's own tests is still recorded.

Nothing in this register means "compliant" or "certified". OWASP ASVS 5.0.0 L2 and WCAG 2.2 AA are targets;
no versioned ASVS requirement IDs have been verified and recorded yet (MP §2.7 asks for that after
verification).

Abbreviated paths: `id/` = `server/modules/identity/`, `as/` = `server/modules/assurance/`, `fi/` =
`server/modules/files/`, `jo/` = `server/modules/jobs/`, `au/` = `server/modules/audit/`, `pl/` =
`server/modules/platform/`, `po/` = `server/modules/portable/`, `or/` = `server/modules/orders/`, `en/` =
`server/modules/engagement/`, `co/` = `server/modules/compliance/`, `si/` = `server/modules/siem/`, `bk/` =
`server/modules/backup/`, `in/` = `server/modules/integrations/`, `cl/` = `client/src/`.

## Project instructions (PI)

| ID | Requirement (short quote) | Owner | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| PI-01 | "self hosted application" | platform, backup/deploy | Single Node artefact `RP_ROLE=web\|worker\|all` (ADR 0001); local private object store `fi/storage.ts`; MySQL | `tests/foundation.test.ts` "creates the schema and round-trips an encrypted row" [db] | Partially implemented — the application runs self-contained, but there is no installer, nginx or systemd profile (`deploy/` is empty; see MP-10.3) |
| PI-02 | "Do not include any dependencies to Perplexity" | all | `package.json` dependency list; `docs/engineering/DEPENDENCIES.md` | No automated dependency-denylist check found | Implemented, not independently verified — manual inspection of `package.json` found no Perplexity/Manus package; a CI denylist check is not implemented |
| PI-03 | "DO NOT USE Perplexity OAUTH" | identity | Local accounts only (`id/auth.ts`); SAML is a disabled scaffold (`in/`) | `in/integrations.test.ts` "keeps SAML SSO & SharePoint strictly disabled scaffolds…" [db] | Verified by automated test (absence of any OAuth sign-in route is by inspection) |
| PI-04 | "LOCAL AUTH WITH MFA until other auth types are configured" | identity, assurance | `id/auth.ts`, `id/transitions.ts` (pure), `as/factors.ts` | `id/pure.test.ts` "every combination yields a subsequence of the canonical order…"; `tests/integration/journey-admin.test.ts` "signs in to remediation, enrols TOTP, then must change the bootstrap password…" [db] | Verified by automated test |
| PI-05 | "ADVANCE DETAILED LOGGING, and correlation" | http, observability | `server/observability/` (OTel-shaped JSON, redaction); trusted request IDs in `server/http/app.ts` | `server/observability/redact.test.ts` "filters by level, applies bindings, and writes OTel-shaped JSON"; `tests/http/app.test.ts` "trusts configured peers but not client-supplied request IDs…"; `jo/jobs.test.ts` "…propagates worker correlatio[n]" [unit] | Verified by automated test (log shipping from a real host not verified) |
| PI-06 | "modern SDLC best practices" | all | Build contract, ADRs, per-module API/VERIFICATION docs, independent reviews, typecheck+lint+tests | `docs/engineering/BUILD_CONTRACT.md`; `docs/security/REVIEW-*.md` | Partially implemented — no CI pipeline (`.github/` absent), no SBOM/provenance, no dependency/secret/static scanning recorded |
| PI-07 | "Minimize … OWASP top 10" | all | See `docs/security/THREAT_MODEL.md` §OWASP | See threat model | Partially implemented — controls and tests exist per category; no authorized dynamic testing or scanning yet |
| PI-08 | "advance audit log center with advance filtering … send logs securely to a siem or syslog server" | audit, siem | `au/` (query builder, search, cases, exports); `si/` (RFC 5424/5425, mTLS, OTLP) | `au/module.test.ts` (19 tests); `si/siem.test.ts` "delivers RFC 5424 octet-counted frames over TLS…" [loopback] | Verified by automated test for the module scope; SIEM rows pending owner report and have open High review findings (see MP-9.*) |
| PI-09 | "Zero proof and zero trust" | all | Server-side authz on every procedure (ADR 0005); in-transaction actor re-validation (identity, orders, files, platform, audit, engagement, compliance, siem, backup, integrations); fail-closed audit | `or/orders.test.ts` "a revoked admin session is refused for lock, reference, reassign, catalog and workflow writes…"; `id/identity.test.ts` "re-validates the actor inside the transaction…" [db] | Verified by automated test for the listed modules |
| PI-10 | "professional and elegant" UI | client | `docs/brand/`, `cl/ui/` | `cl/ui/tokens.test.ts` "computes known reference ratios" [unit] | Implemented, not independently verified — aesthetic quality needs owner review, not a test |
| PI-11 | "1000% responsive to any device" | client | `cl/ui/DataTable.tsx` (table + mobile cards), responsive layout | `cl/ui/ui.test.tsx` "renders a captioned table and labelled mobile cards…"; `cl/app/isolation.test.tsx` "offers sort controls sharing the desktop sort state" [jsdom] | Partially implemented — jsdom has no layout engine; no real-browser test at 320–375 px, tablet, desktop or 200 % zoom (REVIEW-client "Manual follow-up") |
| PI-12 | "ada compliant" (web and mobile) | client | Labelled controls, focus traps, live regions, contrast tokens | axe in 11 client suites, e.g. `cl/features/auth/auth.test.tsx` "mfa challenge and enrolment have no axe violations"; `cl/ui/ui.test.tsx` "moves focus in, traps Tab, closes on Escape and restores focus" [jsdom] | Partially implemented — automated checks only; no manual screen-reader/keyboard journey review; native mobile apps do not exist (Day-2) |
| PI-13 | "Push all code to github regularly" | lead | Local Git history (125 commits at time of writing) | `git remote -v` returns no remote | Not implemented — the checkout has no GitHub remote configured |
| PI-14 | "application context file … in its own folder" | lead | `docs/application-context/APPLICATION_CONTEXT.md` | File exists | Implemented, not independently verified (not yet on GitHub — see PI-13) |
| PI-15 | "session log of all prompts and its responses" | lead | `docs/session-logs/2026-11-20-session-01.md`, `README.md` | Files exist | Implemented, not independently verified (completeness of the log not checked; not yet on GitHub) |
| PI-16 | "SEO, GEO, AEO maximized" | public site (separate) / http | Portal side: `noindex` + `robots.txt` (ADR 0010, `server/http/app.ts`) | `tests/http/app.test.ts` "sets a fresh strict CSP, browser protections and no-store on API responses" (covers portal noindex headers) [unit] | Out of scope for the portal — ADR 0010 assigns SEO/GEO/AEO to the separate public site `www.readypackets.com`, which is not in this repository; the portal is deliberately not indexed |
| PI-17 | "integrate with PostHog and Microsoft Clarity … configure the clarity code" | integrations | `in/analytics.ts`, `in/settings.ts`, `cl/features/integrations/consent.tsx` (ADR 0011) | `in/integrations.test.ts` "validates Clarity & PostHog identifiers strictly and scopes analyticsCsp to /privacy and /terms only"; `tests/http/app.test.ts` "permits only exact HTTPS analytics sources…" | Partially implemented — server config and CSP verified; open High finding INT-01 (Clarity runs in the main app realm; purge after render); no client consent test; pending owner report |

## MASTER_PROMPT §2 — Non-negotiable engineering constraints

| ID | Requirement (short quote) | Owner | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MP-2.1 | "no Manus runtime, SDK, OAuth, API … dependency" | all | `package.json`; build `scripts/build-server.mjs` | None automated | Implemented, not independently verified (see PI-02) |
| MP-2.2 | "local authentication with mandatory MFA as the default … protected local MFA break-glass" | identity, assurance | `id/`, `as/`; bootstrap `scripts/ops/create-admin.ts` | `id/identity.test.ts` "bootstrap creates an active verified admin (mustChange, no MFA ⇒ first sign-in forces enrolment…)" [db] | Verified by automated test (enterprise IdP absent, so break-glass coexistence is untested) |
| MP-2.3 | "Enforce authentication, MFA assurance, role, resource ownership, current grants, order locks … on the server" | all | Procedure guards `server/trpc/`; per-module policies (e.g. `or/policy.ts`) | `tests/foundation.test.ts` "denies anonymous and remediation sessions access to data procedures and audits the denial"; `or/orders.test.ts` "review blocks customer writes, legal hold blocks everyone, reads continue" [db] | Verified by automated test |
| MP-2.4 | "No secret … committed to Git, embedded in client bundles, printed into logs, passed in URLs or process arguments" | platform, all | `server/config/env.ts` (`_FILE` secrets, permission checks); redaction | `server/config/env.test.ts` "never includes file contents or paths in errors", "refuses world-readable…"; `redact.test.ts` "redacts sensitive KEYS wholesale at any depth…" [unit] | Partially implemented — no secret scanning of Git history or client bundle; bundle contents not tested |
| MP-2.5 | Privileged OS operations in "narrowly scoped, independently reviewed helpers"; no root/sudo/Docker socket | backup/deploy | None found (`deploy/` empty) | — | Not implemented — no privileged helper or controller protocol exists; backup runs `mysqldump` from the application (see MP-8.*) |
| MP-2.6a | "Do not reuse the old logo or restore removed Packet 8. Do not hardcode legacy catalog/pricing" | orders, client | Catalog ships empty, admin-created versioned products (`or/catalog.ts`) | `or/orders.test.ts` "ships empty and reports not_configured; ordering from an empty catalog is refused" [db] | Verified by automated test |
| MP-2.6b | "Target WCAG 2.2 AA … with manual assistive-technology review as well as automation" | client | See PI-12 | See PI-12 | Partially implemented — automation only |
| MP-2.7 | "Target OWASP ASVS 5.0.0 Level 2 … Record exact versioned requirement IDs" | security | Threat model; reviews | — | Partially implemented — target only; no ASVS ID mapping recorded |
| MP-2.8 | Prompts, responses, decisions, context "version controlled in dedicated folders … Push … regularly" | lead | `docs/session-logs/`, `docs/application-context/`, `docs/adr/` | — | Partially implemented — folders exist; no GitHub push (PI-13) |

## MASTER_PROMPT §3 — Product surfaces and user experience

| ID | Requirement (short quote) | Owner | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MP-3.1 | Public marketing site "separately from the authenticated portal" with SEO/structured data | public site | Not in this repository | — | Out of scope — separate deployment per ADR 0010 |
| MP-3.2 | Canonical `my.readypackets.com`; alias `portal.readypackets.com` redirects | http | `server/http/edge.ts`, `app.ts` (ADR 0008) | `tests/http/app.test.ts` "redirects aliases to the exact canonical origin, preserves the target, and refuses unknown host" [unit] | Verified by automated test (no real DNS/TLS) |
| MP-3.3 | Login right, "owner-configurable slideshow" left; bounded plain copy, self-hosted assets, no admin HTML/JS | platform, client | `pl/presentation.ts`, `pl/imageValidation.ts` | `pl/presentation.example.test.ts` (16 tests) [db]; `cl/features/platform/platform.test.tsx` (11) [jsdom] | Verified by automated test (layout/reduced motion in a real browser not verified) |
| MP-3.4 | "Create an account visible and accessible" | client | `cl/features/auth/pages/` | `cl/features/auth/auth.test.tsx` "offers a Create an account link" [jsdom] | Verified by automated test |
| MP-3.5 | Registration, verification, sign-in, MFA enrolment/challenge, recovery-code acknowledgment, password change/reset | identity, assurance, client | `id/auth.ts`, `as/`, `cl/features/auth/` | `id/identity.test.ts` (41) [db]; `as/assurance.test.ts` (16); `cl/features/auth/auth.test.tsx` "enrolment → recovery codes shown once → explicit acknowledgment → continue" [jsdom]; `tests/integration/journey-customer.test.ts` [db] | Verified by automated test |
| MP-3.6 | Orders, phases/workflows | orders | `or/orderService.ts`, `or/workflows.ts` | `or/orders.test.ts` "enforces who may trigger, requires notes, records history and notifies the customer" [db]; `cl/features/orders/orders.test.tsx` (17) [jsdom] | Verified by automated test |
| MP-3.7 | Required policies/intake | compliance | `co/policiesService.ts`, `co/intakeService.ts` | `co/compliance.test.ts` "enforces immutable published policy versions, SHA-256 hash-bound acceptance…", "validates intake questionnaires…" [db] | Pending owner report — tests exist; open Medium findings COMP-04/05/06; no client tests |
| MP-3.8 | "secure uploads and deliverables" | files | `fi/index.ts`, `fi/storage.ts` | `fi/files.test.ts` (16) [db]; `cl/features/files/files.test.tsx` (4) [jsdom] | Verified by automated test |
| MP-3.9 | Messages, tickets | engagement | `en/` | `en/engagement.test.ts` "supports owner, contributor, viewer (read-only)…", "runs full customer & staff lifecycle…" [db] | Pending owner report — open Medium ENG-01/02, Low ENG-03; no client tests |
| MP-3.10 | Invoices/workspaces | compliance | `co/invoicesService.ts` | `co/compliance.test.ts` "enforces pure minor-unit math, sequential invoice numbering…" [db] | Pending owner report — open High BILL-01 (Stripe paid-state and refund semantics) |
| MP-3.11 | Display loading/queued/progress/empty/failed/canceled/unknown/completed states; bounded verification spinner | client | `cl/ui/` state components | `cl/ui/ui.test.tsx` "every operation state has text (never colour alone); unknown is not failed", "shows empty, loading and error states" [jsdom] | Verified by automated test (component level) |
| MP-3.12 | PWA: authenticated pages/APIs "network-only by default. Cache only approved public/static assets" | client, http | `vite.config.ts` (VitePWA, `navigateFallback: null`, `/api/` NetworkOnly); `cl/app/PwaUpdatePrompt.tsx` | `tests/http/app.test.ts` "serves only navigation fallback, nonces the shell…" [unit] covers server caching headers only | Implemented, not independently verified — the generated service worker's runtime behaviour in a browser is untested |
| MP-3.13 | "Logout and account switching must not reveal the previous user's content" | client | `cl/app/providers.tsx`, `cl/lib/signOut.ts` | `cl/app/isolation.test.tsx` "purges a previous user's private queries across A → 401 → B (same role) before rendering", "does not pretend to sign out when revocation fails…" [jsdom]; `journey-customer.test.ts` "signs out: cookies are cleared and the old session token is dead" [db] | Verified by automated test (no real browser cache/bfcache check) |
| MP-3.14 | Native iOS/Android "Day-2 scope" | mobile | None | — | Out of scope — Day-2 per MP §3 |
| MP-3.15 | Admins see all in-scope customers/orders; customers only owned or shared; "multiple synthetic roles and older paginated records" | orders, identity | `or/policy.ts`, `or/orderService.ts` | `or/orders.test.ts` "customer list is scoped to own orders with bounded cursor pagination", "other customer: NOT_FOUND on read, write, summary and is audited as denied"; `journey-admin.test.ts` "the administrator sees the customer's order in the console" [db] | Verified by automated test |
| MP-3.16 | Versioned catalog | orders | `or/catalog.ts` | `or/orders.test.ts` "price changes create a new version; existing order line items keep their snapshot" [db] | Verified by automated test |
| MP-3.17 | Bounded global search | orders, engagement, identity | `or/orderService.ts` `searchOrders`; `en/searchService.ts`; `id/admin.ts` search | `or/orders.test.ts` "is scoped to accessible orders and treats wildcards literally"; `en/engagement.test.ts` "enforces strict query bounds and rejects remediation sessions" [db] | Verified by automated test for orders and identity; engagement pending owner report (ENG-01) |
| MP-3.18 | Identifier changes "reserve retired references"; reassignment "transactional and revoke inappropriate prior access" | orders, identity | `or/orderService.ts` `changeReference`, `reassign` | `or/orders.test.ts` "retired references are reserved forever", "moves ownership, revokes every grant, rebinds files, audits, and is idempotent", "audit failure ⇒ nothing moved…"; `id/identity.test.ts` "reference change: permanent reservation of retired values…" [db] | Verified by automated test |
| MP-3.19 | Password administration: reset link, generated temporary, admin-entered temporary; same policy, step-up, forced change, revocation, secret-free audit | assurance | `as/` admin credential modes (ADR 0004) | `as/assurance.test.ts` "keeps sessions and password unchanged on invalid temporary input or failed audit", "refuses email reset while SMTP is unavailable…" [db] | Verified by automated test ("clear from UI memory" not tested in a browser) |
| MP-3.20 | Platform setup wizard/versioned import, preview/diff, config export "nonsecret by default"; config files are data only | platform | `pl/configTransfer.ts`, `pl/settingsStore.ts` | `pl/configTransfer.example.test.ts` (8) [db]; REVIEW-platform P5 closed ("default secret export is now opt-in") | Verified by automated test (an accessible wizard UI is only partly present; `platform.test.tsx` covers settings screens) |
| MP-3.21 | Integration discovery, SharePoint site discovery | integrations | `in/` (SharePoint disabled scaffold) | `in/integrations.test.ts` "keeps SAML SSO & SharePoint strictly disabled scaffolds…" | Not implemented — SharePoint is a disabled scaffold |

## MASTER_PROMPT §4 — Technical architecture

| ID | Requirement (short quote) | Owner | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MP-4.1 | Stack continuity (React 19, TS, Tailwind, Vite, Node LTS, Express 5, tRPC, Zod, MySQL 8, Drizzle) | platform | `package.json`; ADR 0001, 0012 | — | Implemented, not independently verified |
| MP-4.2 | Modular monolith; no Redis/search engines/cloud | all | `server/modules/*` | — | Implemented, not independently verified |
| MP-4.3 | Explicit interfaces + DI for synthetic tests | all | `deps` injection, `testSupport` fakes | Every module suite runs with injected clock/fakes | Implemented, not independently verified (pattern, not a single assertion) |
| MP-4.4 | Versioned migrations; "Verify a schema contract before traffic" | platform | `pl/schemaContract.ts`; `scripts/ops/migrate.ts`; `drizzle.config.ts` (`out: ./migrations`) | `pl/module.example.test.ts` (10) [db] | Partially implemented — the schema contract compares migration ledgers; the `migrations/` directory does not exist in the checkout (tests build the schema directly); `package.json` names `scripts/ops/seed-demo.ts`, which is absent |
| MP-4.5 | Least-privilege DB users, systemd restrictions, container hardening | deploy | None | — | Not implemented — pending owner report (backup/deploy) |
| MP-4.6 | DB connection hardening (TLS with identity verification, no URI overrides) | platform | `server/db/connectionOptions.ts` | `tests/connectionOptions.test.ts` (2) [unit]; REVIEW-http-identity C-01/C-02/C-03 closed | Verified by automated test (no live MySQL TLS handshake) |

## MASTER_PROMPT §5 — Identity, sessions, authorization

| ID | Requirement (short quote) | Owner | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MP-5.1 | Argon2id, rehash after successful verification | identity | `id/credentials.ts` (`argon2` package) | `id/identity.test.ts` "transparently rehashes legacy parameters with compare-and-set (ID-01)" [db] | Verified by automated test (deployment benchmarking of parameters not done) |
| MP-5.2 | "minimum 15-character … at least 64 … maximum such as 128, count Unicode code points … do not silently truncate"; blocked/common list; no composition rules | identity | `id/password/` (pure policy) | `id/pure.test.ts` "counts Unicode code points after NFC (15 minimum, 128 maximum, never truncates)", "rejects common passwords…", "accepts a long passphrase with no composition rules" [unit] | Verified by automated test (no compromised-password service; local list only) |
| MP-5.3 | TOTP enrolment, bounded retries, replay prevention, single-use hashed recovery codes, explicit acknowledgment | assurance | `as/factors.ts` | `as/assurance.test.ts` "rejects enrollment-code replay, serializes fresh code replay, and throttles per account", "redeems a recovery code exactly once concurrently…", "invalidates the old recovery batch on regeneration and binds explicit acknowledgment…" [db] | Verified by automated test |
| MP-5.4 | WebAuthn/passkeys with RP-ID/origin validation | assurance | `as/` WebAuthn | `as/assurance.test.ts` "supports a signed WebAuthn registration and authentication, binding origin, purpose, TTL…" [unit, synthetic ES256 fixture] | Verified by automated test — synthetic authenticator only; no real authenticator/browser |
| MP-5.5 | `__Host-` cookies (Secure, HttpOnly, Path=/, no Domain); CSRF session-bound with strict origin | http, identity | `server/http/`, ADR 0002 | `tests/http/app.test.ts` "checks origins before session lookup and validates CSRF against the resolved session", "applies identical CSRF controls to raw module routes and refuses mutation over GET"; `journey-customer.test.ts` "…cookies carry __Host- attributes…" [db] | Verified by automated test |
| MP-5.6 | Revocable sessions, idle/absolute lifetimes, rotation on login/privilege/password change, fresh step-up | identity, assurance | `id/sessions.ts` | `id/identity.test.ts` "rejects malformed, unknown, revoked, idle and absolute-expired sessions", "rotation invalidates the previous token…", "requires the current password, revokes other sessions and rotates the current one" [db] | Verified by automated test |
| MP-5.7 | "Do not store browser bearer credentials in local storage" | client | `cl/lib/sessionTransport.ts` | `tests/http/sessionTransport.test.ts` "holds preview credentials in memory, sends no ambient credentials…" [jsdom] | Verified by automated test (preview profile holds header token in memory by design, ADR 0002) |
| MP-5.8 | Single account-transition service; remediation sessions cannot see data; no MFA bypass via reset/batching/direct calls | identity | `id/transitions.ts`, `server/trpc/` guards | `id/pure.test.ts` "completing the head step re-derives the next one until none remain (every starting state)"; `tests/foundation.test.ts` "denies anonymous and remediation sessions…"; `or/orders.test.ts` "remediation session is refused even for the owner"; `tests/http/app.test.ts` "rejects excessive batches…" [db] | Verified by automated test |
| MP-5.9 | Enterprise SAML/Entra optional, disabled until configured, with full validation | identity, integrations | Disabled scaffold `in/` | `in/integrations.test.ts` "keeps SAML SSO … strictly disabled scaffolds…" | Not implemented — scaffold only (disabled, which is the required default) |
| MP-5.10 | Authorization on every list/detail/search/share/export/upload/download/workflow/admin/background task; reject IDOR, mass assignment, stale grants, cross-order uploads, edits on read-only imports | all | `or/policy.ts`, `fi/`, strict Zod schemas | `or/orders.test.ts` "tampered / malformed / unknown identifiers are indistinguishable NOT_FOUND", "locking re-check sees a revocation committed after the caller's REPEATABLE READ snapshot", "imports read-only…"; `id/identity.test.ts` "rejects unknown input keys (strict schemas)"; `fi/files.test.ts` "binds owner and current order stage before and after a streamed upload"; `journey-admin.test.ts` "no staff/admin-guarded procedure accepts a full customer session or an anonymous caller" [db] | Verified by automated test for orders, files, identity; other modules pending owner report |
| MP-5.11 | Last-admin invariant and actor re-validation for privilege changes | identity | `id/admin.ts` | `id/identity.test.ts` "two admins demoting each other concurrently: exactly one succeeds…", "last-admin protection and self-change refusal" [db] | Verified by automated test |
| MP-5.12 | Uniform registration / sign-in / reset responses (no enumeration) | identity | `id/auth.ts` | `id/identity.test.ts` "existing address: same response shape, no link…", "uniform error for unknown account, wrong password…", "public response is identical for known, unknown and ineligible accounts…" [db]; `cl/app/review.test.tsx` "never renders a preview verification link…" [jsdom] | Partially implemented — response shapes verified; ID-04 open in part (registration still performs different DB/outbox work per branch; timing uniformity not measured) |

## MASTER_PROMPT §6 — Application, file and integration defenses

| ID | Requirement (short quote) | Owner | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MP-6.1 | Strict schemas, parameterized SQL, bounded body/query sizes | all | Zod `.strict()`; Drizzle; `server/http/app.ts` body limits | `au/module.test.ts` "binds hostile values as parameters (SQL injection attempts match nothing and do not error)"; `tests/http/app.test.ts` "passes only narrow webhook bytes ahead of JSON parsing and enforces request body limits" | Verified by automated test |
| MP-6.2 | Trusted proxy, safe host validation | http | `server/http/edge.ts`; `RP_TRUSTED_PROXIES` | `tests/http/app.test.ts` "trusts configured peers but not client-supplied request IDs, unrelated forwarding…"; `env.test.ts` "accepts only exact numeric trusted-proxy IPs/CIDRs" | Verified by automated test (no nginx in front) |
| MP-6.3 | Rate limits and quotas | http | `server/security/rateLimiter.ts`, `edgeAdmission.ts` (ADR 0009) | `tests/http/rateLimiter.test.ts` "serializes concurrent consumption across instances…", "fails closed for API/security traffic…"; `tests/http/app.test.ts` "stops repeated denials at the local gate before the durable limiter, session, or audit" | Verified by automated test (fixed-window 2× edge burst accepted, REVIEW-http-jobs I-2) |
| MP-6.4 | Route-specific nonce CSP, no unsafe-inline/eval; HSTS staged, no preload | http | `server/security/headers.ts` | `tests/http/app.test.ts` "sets a fresh strict CSP, browser protections and no-store on API responses" | Verified by automated test (CSP enforcement in a real browser not tested) |
| MP-6.5 | Uploads: extension + magic agreement, no executable formats, bounded sizes/counts, authorization | files | `fi/classification.ts`, `fi/index.ts` | `fi/files.test.ts` "rejects empty, extension/magic mismatch, and disallowed types without retaining staged bytes", "refuses too many or unexpected parts…", "refuses excessive per-file and total request sizes…" | Verified by automated test |
| MP-6.6 | Malware/quarantine policy | files | Scanner hook in `fi/index.ts` | `fi/files.test.ts` "requires a configured scan to consume all bytes and fails closed on incomplete scanning" [unit fake scanner] | Partially implemented — hook verified with a fake; no scanner is configured or shipped |
| MP-6.7 | WebM/MP4/M4A/Ogg normalized across upload/export/verify/import | files, portable | `fi/classification.ts`; `po/` | `fi/files.test.ts` "reclassifies staged bytes canonically and binds the owner/order on adoption"; `fi/classification.test.ts` "accepts only known legacy declaration aliases after actual classification" | Verified by automated test (browser recording differences not tested) |
| MP-6.8 | Private storage outside web root, opaque keys, no traversal/symlink/hardlink | files, http | `fi/storage.ts`; `server/http/static.ts` | `fi/storage.test.ts` "rejects traversal, malformed keys, symlink namespaces and linked leaves"; `tests/http/app.test.ts` "refuses static roots that overlap private storage…" | Verified by automated test |
| MP-6.9 | Downloads reauthorize; attachment/nosniff; short-lived tickets bound to current authority | files | `fi/` tickets | `fi/files.test.ts` "stores only a hash, denies other people/sessions, and redeems exactly once", "rechecks live grants and reassignment…", "sets safe attachment headers…"; `journey-customer.test.ts` "uploads a file … downloads it with a single-use ticket sent in the POST body" | Verified by automated test |
| MP-6.10 | Optional SMTP / Graph / SharePoint / Stripe / workflow endpoints; no hardcoded secrets | integrations | `in/smtp.ts`, `in/stripe.ts` | `in/integrations.test.ts` "enforces SMTP TLS, blocks plaintext & CRLF header injection…", "reports truthful provider states and never emits health 'ok' until a real check succeeds" [loopback] | Partially implemented — SMTP and Stripe exist; Graph mail and workflow endpoints not implemented; SharePoint scaffold; pending owner report (INT-03 open) |
| MP-6.11 | Naming rule for remote folders (2 first-name chars + last name + customer ID) | integrations | None found | — | Not implemented (depends on SharePoint) |
| MP-6.12 | Egress/SSRF policy: allowlist, resolution and redirect validation, no metadata/private targets | integrations | `in/egress.ts`, `in/ipPolicy.ts` | `in/integrations.test.ts` "classifies loopback, private, link-local, CGNAT, multicast, metadata…", "enforces egress SSRF policy, blocks DNS rebinding & redirects…"; `si/siem.test.ts` "blocks SSRF / forbidden egress targets…" | Verified by automated test — pending owner report; open Medium INT-02 (HTTPS pinning callback) and SIEM pooled-socket egress finding |
| MP-6.13 | Signed inbound webhooks, replay protection, durable inbox, async processing | integrations, compliance | `in/stripe.ts`; narrow raw-body route | `in/integrations.test.ts` "verifies Stripe webhook signatures, enforces replay window & idempotency…"; `co/compliance.test.ts` "handles verified provider payment & refund webhooks idempotently" | Partially implemented — open High BILL-01 (paid-state and cumulative refund semantics) |
| MP-6.14 | Transactional outbox and idempotency for outbound effects; never claim exactly-once | jobs | `jo/` outbox | `jo/jobs.test.ts` "deduplicates across transactions, encrypts variables…", "records SMTP acceptance, not delivery…", "keeps ambiguous transport outcomes unknown with no payload or resend" [loopback] | Verified by automated test |
| MP-6.15 | Analytics off by default, opt-in/revoke, route exclusion, masked inputs, no snippets, disabled ⇒ no network request | integrations, client | ADR 0011; `in/analytics.ts`; `cl/features/integrations/consent.tsx` | See PI-17 | Partially implemented — open High INT-01; no client test for consent/revoke/no-request |

## MASTER_PROMPT §7 — Portable customers, orders and files

| ID | Requirement (short quote) | Owner | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MP-7.1 | Open data contract, independent verifier/extractor, adapter interface | portable | `portable/` (schemas, `cli/verify.ts`, `src/legacy/adapter.ts`) | `portable/tests/cli-policy.test.ts` (16), `golden.test.ts` (4) [unit] | Verified by automated test |
| MP-7.2 | Versioned schemas, field dictionaries, test vectors; v1/v2 compatibility only via passing adapters | portable | `portable/src/contract/`, `src/legacy/` | `portable/tests/legacy.test.ts` (13) [unit, synthesized v2 fixtures] | Verified by automated test (no real historical v1/v2 package tested) |
| MP-7.3 | Selectable single/multiple/all customers and orders, file selection, profiles | portable (server) | `po/` | `po/portable.test.ts` "includes standalone profiles only for all-records scope while selected customers include their…", "exports a selected complete order…" [db] | Verified by automated test |
| MP-7.4 | Separately versioned historical-evidence modules (invoices, acceptances, intake, messages) | portable, compliance, engagement | `co/` portable v3 evidence; `en/` export | `co/compliance.test.ts` "exports normative portable v3 evidence…"; `en/engagement.test.ts` "exports only customer-visible records and imports idempotently…" | Partially implemented — compliance/engagement export exist (pending owner report); server portable VERIFICATION states historical modules are not exported by the server orchestrator yet |
| MP-7.5 | File-only package must reference existing verified target order; "an orphan is never silently created" | portable | `po/` planner | `po/portable.test.ts` "preflights exact line totals, current workflow status…" | Implemented, not independently verified — no test named specifically for file-only packages |
| MP-7.6 | Secrets "must never travel in a business portable package" | portable | `portable/src/contract/exclusions.ts` | `portable/tests/archive-exclusions.test.ts` (11) [unit] | Verified by automated test |
| MP-7.7 | No auto-link by email; imported identities need activation and local MFA | portable, orders | `po/` import | `po/portable.test.ts` "refuses email-based linking to an existing account in a different package…" [db] | Verified by automated test |
| MP-7.8 | Authenticated encryption envelope; checksum ≠ authenticity; "trusted signatures where source authenticity is required" | portable | `portable/src/crypto/envelope.ts` | `portable/tests/tamper.test.ts` (23), `roundtrip.test.ts` (8) | Partially implemented — authenticated encryption verified; no asymmetric signature / sender authenticity (portable VERIFICATION) |
| MP-7.9 | Import into quarantine; verify everything before mutation; dry run default, collision refusal, read-only orders | portable, orders | `po/importWorker.ts`; `or/` import adapter | `po/portable.test.ts` "refuses tampering before planning or writing business rows", "verifies and dry-plans…"; `or/orders.test.ts` "imports read-only, idempotently, with validated owner…" | Verified by automated test |
| MP-7.10 | Approval bound to package/plan hash, target, scope, expiry, one-time op ID | portable | `po/` approvals | `po/portable.test.ts` "verifies and dry-plans, rolls back unaudited approval, resumes a lost fencing claim…" | Verified by automated test |
| MP-7.11 | Durable reservations, fenced jobs, prepared/committed/finalized state machine; unknown on timeout | portable, jobs | `po/importWorker.ts` | `po/portable.test.ts` "…resumes a lost fencing claim…", "reimports the exact same package as immutable links…" | Partially implemented — crash at every durable boundary not exhaustively tested |
| MP-7.12 | Required evidence: cross-hostname/key roundtrip, old readers, reference importer to different model, archive bombs/traversal, replay | portable | `portable/` | `portable/tests/archive-exclusions.test.ts`, `tamper.test.ts`, `legacy.test.ts`; server portable VERIFICATION "two-schema real-module roundtrip" | Partially implemented — "crash before/after each durable boundary" and actual authorized download comparison after import are not fully covered |

## MASTER_PROMPT §8 — Backup, restore, corruption, key custody

| ID | Requirement (short quote) | Owner | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MP-8.1 | Consistent full backups (DB, objects, config evidence, key custody refs); "Never silently fall back to plaintext" | backup | `bk/` | `bk/backup.test.ts` "refuses backup fail-closed when encryption key is missing, weak, or stored in a world-readable file", "completes real mysqldump + object backup, byte-level verify, isolated restore…" [db] | Pending owner report — tests exist; no independent review yet ("Backup and deployment: pending owner handoff") |
| MP-8.2 | Off-host + immutable/offline copies, separate key custody, RPO/RTO measured by isolated restores | backup, ops | Key tooling `scripts/ops/keys/` | `scripts/ops/keys/lib.test.ts` (4) [unit] | Not implemented — no off-host/immutable copy mechanism, no RPO/RTO definition or drill |
| MP-8.3 | No restore over a populated target; exact confirmation | backup | `bk/` restore | `bk/backup.test.ts` "refuses live database target, non-empty target database, overlapping storage dir, and wrong confirmation phrase" [db] | Pending owner report |
| MP-8.4 | Security-state continuity (never rewind spent MFA codes, tokens, revocations) | backup | `bk/` continuity | `bk/backup.test.ts` "…isolated restore, and §7.3 security-state continuity" [db] | Pending owner report |
| MP-8.5 | Tampered/corrupt archive detection before touching targets | backup | `bk/` | `bk/backup.test.ts` "detects header bit-flips, ciphertext tampering, truncation, trailing bytes, and wrong keys before touching restore targets" | Pending owner report |
| MP-8.6 | Documented corruption handling runbook | backup, ops | `scripts/ops/keys/RUNBOOK.md` (keys only) | — | Not implemented — no corruption/recovery runbook beyond key handling |
| MP-8.7 | Retention with holds, durable results, explicit activation; no unexpected timers | backup, audit, files | `bk/` retention; `au/retention.ts`; `fi/` retention | `bk/backup.test.ts` "protects last-known-good verified backup, active legal holds, and unknown outcomes during retention…"; `au/module.test.ts` "removes only eligible sealed events, keeps held ones, audits each batch in-tx…"; `fi/files.test.ts` "rechecks holds under lock and refuses to unlink without durable intent" | Verified by automated test for audit and files; backup pending owner report |

## MASTER_PROMPT §9 — Logging, audit center, forwarding

| ID | Requirement (short quote) | Owner | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MP-9.1 | One versioned allowlisted event envelope aligned with OTel; syslog mappings | audit | `au/envelope.ts`, `au/emitter.ts` | `au/emitter.test.ts` "writes the canonical envelope with request correlation and actor pseudonym", "drops unsafe attributes instead of storing them" [db] | Partially implemented — envelope verified; attributes are pattern-checked, not an event-specific allow-list (open Medium finding in REVIEW-audit-siem-backup) |
| MP-9.2 | Trusted request IDs propagated through async work; workflow correlation separate | http, jobs | `server/http/app.ts`; `jo/` | `tests/http/app.test.ts` "trusts configured peers but not client-supplied request IDs…"; `jo/jobs.test.ts` "writes canonically correlated audit rows…" | Verified by automated test |
| MP-9.3 | Redact before persistence/transport/display; never log secrets; log-injection safe | observability, audit | `server/observability/redact.ts` | `redact.test.ts` "neutralises CR/LF/U+2028/ESC so a value cannot forge a second line", "errors: name + safe codes only…"; `au/emitter.test.ts` "normalises camelCase keys and keeps boolean flags about secrets, never their values" | Verified by automated test |
| MP-9.4 | Deny unauditable high-impact writes; no fire-and-forget masquerading as evidence | audit, all | `au/emitter.ts` `record(event, tx)` | `au/emitter.test.ts` "fails closed: an audit store failure aborts the business transaction", "best-effort notes never throw…"; `or/orders.test.ts` "refuses mixed duplicates and writes nothing when audit is unavailable"; `id/identity.test.ts` "audit failure ⇒ no account row" | Verified by automated test |
| MP-9.5 | Audit center filters, AND/OR groups, bounded builder (no raw SQL/regex), cursor pagination, saved queries, cases, exports; search/export self-audited; field-level authz | audit, client | `au/query.ts`, `au/search.ts`, `au/cases.ts`, `au/exports.ts`; `cl/features/audit/` | `au/module.test.ts` "returns newest first, is self-audited…", "cursor pagination is stable while new events arrive", "rejects unknown fields, deep nesting, oversized queries…", "creates cases with events…", "saved queries are owner-scoped for deletion", "denies customers, staff, remediation sessions and stale step-up"; `cl/features/audit/audit.test.tsx` (16) [jsdom] | Verified by automated test (open Medium on JSON-attribute query cost; no `MAX_EXECUTION_TIME`) |
| MP-9.6 | Freshness/coverage display; signed hash-chain checkpoints; state compromised key holders can still affect evidence | audit | `au/chain.ts`, `au/integrity.ts` | `au/chain.test.ts` (12) e.g. "detects tail truncation via head and via signed checkpoints", "a partial-range success never overwrites the global verifier status…"; `au/module.test.ts` "a DB-only actor cannot disguise a deletion as pruning (tombstone receipts are keyed)", "refuses to extend a chain under a different key" | Partially implemented — chain/checkpoints verified; no independent immutable retention copy; symmetric host chain key without rotation; no DB-level append-only grants; open review items (fast backlog count; export manifest completeness) |
| MP-9.7 | RFC 5424 over RFC 5425 TLS 6514, octet framing, cert/hostname validation, mTLS; optional OTLP/JSONL/CEF; never plaintext fallback | siem | `si/rfc5424.ts`, `si/transport.ts`, `si/formats.ts` | `si/siem.test.ts` "refuses untrusted CA and wrong-hostname certificates with ZERO delivery…", "enforces mutual TLS (mTLS)…", "delivers JSON Lines over TLS, CEF over TLS, and OTLP/HTTP JSON…"; `si/rfc5424.test.ts` (8) [loopback] | Pending owner report — tests exist; open Medium RFC 5424 key-collision finding |
| MP-9.8 | Persistent privacy-projected spool, retry/backoff, dead-letter, restart recovery, dedup, at-least-once wording, health display | siem | `si/index.ts`, `si/projection.ts` | `si/siem.test.ts` "handles retry/backoff, circuit breaking, dead-lettering…", "prevents concurrent multi-worker double-sends…", "reports truthful health states…" | Partially implemented — four open High review findings (collector identity/credential binding, concurrent secret updates, retention stalling forwarding, destination lease fence identity); pending owner report |
| MP-9.9 | Test receiver outage, bad certs, mTLS rejection, restart, saturation, disk full, duplicate, framing, privacy | siem | `si/` | As MP-9.7/9.8 | Partially implemented — "disk full" and receiver-side reconciliation not tested |

## MASTER_PROMPT §10 — Jobs, maintenance, installation, delivery trust

| ID | Requirement (short quote) | Owner | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MP-10.1 | Durable jobs, claims, monotonic fencing, unknown-outcome reconciliation | jobs | `jo/` (ADR 0007) | `jo/jobs.test.ts` "claims once across independent concurrent workers…", "uses lease renewal, retries an explicit safe type, and fences stale publication", "marks expired unsafe jobs unknown…" [db] | Verified by automated test (lease time from DB clock fix spot-checked, REVIEW-http-jobs J-1) |
| MP-10.2 | Maintenance drains every started writer; fail-closed shutdown | jobs | `jo/` drain | `jo/jobs.test.ts` "waits for cooperative active work before worker stop resolves", "refuses to confirm shutdown and marks still-unsettled work unknown" | Partially implemented — jobs drain verified; a platform-wide drain registry for all writers is a stated target (jobs VERIFICATION) |
| MP-10.3 | Guided native VPS installer, Docker path, health/maintenance CLI, uninstall plan | deploy | `deploy/` empty; `scripts/ops/{migrate,create-admin}.ts` | — | Not implemented — pending owner report (backup/deploy) |
| MP-10.4 | Fresh install anti-downgrade floor; update verification; no fabricated receipts | deploy | None | — | Not implemented |
| MP-10.5 | First-admin bootstrap host-only, atomic, audited, MFA required | identity | `scripts/ops/create-admin.ts`; `id/` provisioning | `id/identity.test.ts` "two concurrent bootstraps on an empty install: exactly one succeeds", "bootstrap refuses when an active administrator exists"; `journey-admin.test.ts` "bootstraps exactly one administrator…" [db] | Verified by automated test (CLI file handling verified by review only) |

## MASTER_PROMPT §11 — Testing, acceptance and delivery

| ID | Requirement (short quote) | Owner | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| MP-11.1 | Deliver source, lockfiles, migrations, API specs, portable schemas, runbooks, deployment profiles, threat models, ADRs, SBOM/provenance, guides, diagrams | all | Source, `pnpm-lock`, `*/API.md`, `portable/`, ADRs, `docs/security/THREAT_MODEL.md` | — | Partially implemented — missing: migrations directory, deployment profiles, SBOM/provenance, operator/admin/customer guides, recovery runbook |
| MP-11.2 | Separate evidence categories; record SHA, environment, commands, pass/fail/skip | all | Per-module VERIFICATION.md; this register | — | Partially implemented — no CI or installed-host, customer-workflow-in-browser or recovery-drill evidence |
| MP-11.3 | Negative authorization across all roles/resources | all | — | `journey-admin.test.ts` "no staff/admin-guarded procedure accepts a full customer session or an anonymous caller"; orders, files, identity, audit, jobs, backup, siem, integrations suites | Verified by automated test for the modules listed; others pending owner report |
| MP-11.4 | CSRF/proxy/header/host attacks; injection/SSRF/upload/archive; encryption tamper/key rotation | http, files, integrations, portable, platform | — | See MP-5.5, 6.1–6.12, 7.8; `pl/fieldCrypto.test.ts` "detects tampering of IV, ciphertext and tag", "dual-reads retired-but-retained keys…"; `pl/reencrypt.example.test.ts` (5) | Verified by automated test (unit/db classes only) |
| MP-11.5 | PWA logout/update/cache safety; complete accessibility journeys at mobile/tablet/desktop widths and zoom | client | — | See MP-3.12/3.13, PI-11/12 | Partially implemented — no real-browser or assistive-technology journey |
| MP-11.6 | Dependency/secret/static scans, authorized dynamic testing; resolve reachable Critical/High before production | security | — | — | Not implemented — no scans or dynamic testing recorded; open High findings: BILL-01, INT-01, four SIEM highs |
| MP-11.7 | Existing Portal plus full Android/iOS CI not silently reduced | lead | — | — | Not implemented — no CI exists in this checkout |
| MP-11.8 | Go-live gate: canonical HTTPS, verified encrypted independent backups and isolated recovery, forwarding evidence, no open launch-enabled Critical/High | lead | — | — | Not implemented — go-live gate not met (no host, no TLS, no drill, open Highs) |

## ARCHITECTURE additions not already covered above

| ID | Requirement (short quote) | Owner | Implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| ARCH-2.3 | Scale/availability: "load-test the actual connection/resource budget" | platform | Pool sizing in `env.ts`; one-slot pool regressions | `or/oneSlotPool.test.ts` (1); `en/engagement.test.ts` "completes all transactional mutations on a strict 1-connection pool without self-deadlock" [db] | Partially implemented — single-connection safety verified; no load test |
| ARCH-3.2 | Identity data separate from portable customer profiles | identity, portable | `po/`, exclusions | `po/portable.test.ts` "refuses email-based linking…"; `portable/tests/archive-exclusions.test.ts` | Verified by automated test |
| ARCH-3.3 | DB constraints for ownership, stable IDs, idempotency | all | `server/db/schema/` | `or/orders.test.ts` "creates an order with a generated reference, initial status and audit; is idempotent"; `jo/jobs.test.ts` "uniques enqueue keys per type…" | Verified by automated test |
| ARCH-4.5 | Not-found for unauthorized resources (no existence oracle) | all | ADR 0005 | `or/orders.test.ts` "tampered / malformed / unknown identifiers are indistinguishable NOT_FOUND" | Verified by automated test (orders) |
| ARCH-5.1 | Field encryption with key IDs, AAD binding, rotation, blind indexes | platform | `server/security/fieldCrypto.ts`, `pl/reencrypt.ts` | `pl/fieldCrypto.test.ts` "refuses AAD mismatch (moved to another row, column or table)", "refuses a relabelled key id…", "offers previous-key blind-index candidates only during a transition" | Verified by automated test |
| ARCH-5.2 | Private object lifecycle (staging, promotion, sweep) | files | `fi/storage.ts` | `fi/storage.test.ts` "sweeps only upload-owned staging keys and associated abandoned partials" | Verified by automated test (no distributed transaction across filesystem and DB, by design) |
| ARCH-8.1 | Mail capture refused in production | jobs | `jo/` | `jo/jobs.test.ts` "allows an explicit capture in test, encrypts it, and denies expired data" | Verified by automated test |
| ARCH-9.3 | Preview profile cannot run on readypackets.com | platform | `server/config/env.ts` | `env.test.ts` "never allows the preview profile on readypackets.com or any subdomain, in any NODE_ENV…", "requires the exact synthetic-data acknowledgement…"; `cl/app/review.test.tsx` "shows a permanent, non-dismissible banner…" | Partially implemented — H-3 residual: preview with `NODE_ENV=production` on a non-readypackets host is still allowed |
| ARCH-10 | Portal `noindex`, analytics consent | http, integrations | ADR 0010, 0011 | See PI-16, PI-17 | Partially implemented — inherits PI-17 (INT-01 open); noindex verified per PI-16 |

## Summary

Counts by primary status across all 130 rows above (PI 17, MP 104, ARCH 9), computed from the Status column:

| Status | Count |
| --- | --- |
| Verified by automated test | 65 |
| Partially implemented | 31 |
| Not implemented | 13 |
| Implemented, not independently verified | 10 |
| Pending owner report (primary status) | 8 |
| Out of scope | 3 |
| **Total** | **130** |

Primary "Pending owner report" rows are MP-3.7, 3.9, 3.10, 8.1, 8.3, 8.4, 8.5 and 9.7. Another 12 rows have a
different primary status but also carry a pending note (PI-08, PI-17, MP-3.17, 4.5, 5.10, 6.10, 6.12, 7.4, 8.7,
9.8, 10.3, 11.3). "Verified by automated test" always means the tagged evidence class (unit, db, loopback, jsdom),
never a deployed system. These counts will be recomputed on refresh.

### Not implemented

- PI-13 GitHub push (no remote configured).
- MP-2.5 Narrow privileged helpers / controller protocol.
- MP-3.21 Integration discovery and SharePoint (disabled scaffold).
- MP-4.5 Least-privilege DB users, systemd and container hardening.
- MP-5.9 Enterprise SAML/Entra (disabled scaffold; disabled is the required default).
- MP-6.11 Remote-folder naming rule.
- MP-8.2 Off-host/immutable copies, RPO/RTO, restore drills.
- MP-8.6 Corruption-handling runbook.
- MP-10.3 Installer, Docker path, maintenance CLI, uninstall plan.
- MP-10.4 Anti-downgrade floor and update verification.
- MP-11.6 Dependency/secret/static scans and dynamic testing.
- MP-11.7 CI (portal and mobile).
- MP-11.8 Go-live gate.

### Partially implemented

- PI-01 self-hosting (no deploy profile); PI-06 SDLC (no CI/SBOM/scans); PI-07 OWASP (no dynamic test);
  PI-11 responsive (jsdom only); PI-12 accessibility (no manual AT review, no mobile apps); PI-17 analytics
  (INT-01 open, no client consent test).
- MP-2.4 secret hygiene (no scanning); MP-2.6b WCAG; MP-2.7 ASVS IDs; MP-2.8 version-controlled records.
- MP-4.4 migrations directory and `seed-demo.ts` absent.
- MP-5.12 enumeration resistance (ID-04 open in part; timing not measured).
- MP-6.6 malware scanning (hook only); MP-6.10 integrations (no Graph/workflow endpoints; INT-03);
  MP-6.13 webhooks (BILL-01); MP-6.15 analytics consent (INT-01).
- MP-7.4 historical-evidence modules; MP-7.8 no sender signatures; MP-7.11 crash-boundary coverage;
  MP-7.12 portability evidence gaps.
- MP-9.1 attribute allow-list; MP-9.6 tamper evidence (no immutable copy, key rotation); MP-9.8 SIEM spool
  (four open Highs); MP-9.9 SIEM failure-mode tests.
- MP-10.2 platform-wide drain registry.
- MP-11.1 deliverables; MP-11.2 evidence categories; MP-11.5 browser/AT journeys.
- ARCH-2.3 load testing; ARCH-9.3 preview with `NODE_ENV=production` (H-3 residual); ARCH-10 (via PI-17).

## Refresh log

- 2026-11-20 — first complete draft (orders_engineer). Next refresh: when the lead declares integration
  complete (engagement, compliance, siem, backup/deploy, integrations, audit centre).
