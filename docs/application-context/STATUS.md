# ReadyPackets Portal — Status

Last updated: 2026-11-20 (end of session 01, after increment 02). Keep this file current; it is the honest state of the build,
not a certification. "Verified" below means the integrator ran the check and saw the result. Anything not
listed under "Verified" has not been proven and must not be described as working in production.

## Implemented

| Area | What exists | Where |
| --- | --- | --- |
| Identity | local accounts, Argon2id passwords, invitation and reset flows, sessions with idle and absolute limits, session list and revocation, staff administration | `server/modules/identity`, `client/src/features/{auth,identity}` |
| Assurance (MFA) | mandatory TOTP enrolment, recovery codes, passkeys (WebAuthn), step-up for sensitive actions and sensitive admin reads | `server/modules/assurance`, `client/src/features/assurance` |
| HTTP edge | host allow-list, security headers and CSP, cookie session + CSRF, layered rate limiting, batch and URL limits, safe error mapping | `server/http`, `server/security`, `shared/apiLimits.ts` |
| Orders | catalog, workflows, order wizard, status transitions with notes, locks, reference change with history, reassignment, sharing | `server/modules/orders`, `client/src/features/orders` |
| Files | quarantined upload, type rules, storage outside the web root, authorised download, retention | `server/modules/files`, `client/src/features/files` |
| Engagement | order messages, support tickets and queue, notifications, global search (customer and console) | `server/modules/engagement`, `client/src/features/engagement` |
| Compliance | policies with versioned acceptance, intake questionnaires, invoices with PDF, manual payment recording (step-up) | `server/modules/compliance`, `client/src/features/compliance` |
| Audit | append-only audit events with correlation ids, hash chain with checkpoints, audit center (filters, saved views, cases, exports, integrity, retention) | `server/modules/audit`, `client/src/features/audit` |
| SIEM | destinations (syslog over TLS per RFC 5425, HTTPS collectors), queue, retries, dead letters, health view | `server/modules/siem`, `client/src/features/siem` |
| Logging | structured JSON logs with redaction, request / trace / correlation ids on every line | `server/observability`, `docs/operations/LOGGING_AND_AUDIT.md` |
| Jobs and mail | fenced job queue, scheduled jobs, mail outbox (held when SMTP is not configured), admin controls | `server/modules/jobs`, `client/src/features/jobs` |
| Platform | health, setup checklist, settings, admin overview widgets | `server/modules/platform`, `client/src/features/{platform,dashboard}` |
| Portable data | vendor-neutral export/import package, verifier CLI, reference importer | `portable/`, `server/modules/portable` |
| Backup | encrypted backups, offline `.rpbk` restore by operator CLI only | `server/modules/backup`, `docs/operations/BACKUP_AND_RESTORE.md` |
| Integrations | PostHog and Microsoft Clarity (configurable project id, consent-gated, off by default); Stripe, SAML and SharePoint are disabled scaffolds | `server/modules/integrations`, `client/src/features/integrations` |
| UI | design system on the brand kit, light/dark/system themes, customer shell with mobile tab bar, console shell, installable PWA shell with offline page | `client/src/{ui,app,styles}`, `client/public` |
| Deployment | native auto-install on fresh Ubuntu 26.04 (prerequisites, optional swap, fixed host and optional alias, switchable certificate mode, one-time temporary admin password display, offerings); manual install on Ubuntu 24.04/26.04; upgrade and deactivation; Docker Compose for evaluation | `deploy/auto-install.sh`, `deploy/install.sh`, `deploy/nginx/*.conf.template`, `deploy/docker/`, `docs/operations/AUTO_INSTALL.md`, `.github/workflows/native-install.yml` |
| Offerings catalog (increment 02) | Master Offerings Matrix v3.0 as owner-controlled data (`data/catalog/readypackets-offerings-v3.0.json`, 18 products = Packets 1–6 × Basic / Standard / Premium, 112 deliverables), audited `ops:catalog-import`, one tier per packet, server-quoted totals, bundle rule (15% when all six packets are in one order), packet picker in the order wizard, tier / outcome / timeline / deliverables on orders | `data/catalog`, `scripts/ops/catalog*`, `server/modules/orders`, `client/src/features/orders` |
| Production pipeline (increment 02) | manual Phase I (P101) and Phase II (P201) webhook triggers from the console order page, exact field set of the reference documents, encrypted outbox with fenced retries and reconciliation, destination pinning, pre-send order revalidation, admin settings behind step-up, dispatch list; disabled until configured | `server/modules/integrations/production`, `client/src/features/integrations/production`, `docs/integrations/PRODUCTION_WEBHOOKS.md` |
| Documentation | 23 ADRs, threat model, security reviews, guides for customers / staff / admins, runbooks, requirements register | `docs/` |

## Verified in session 01 (integrator's own runs)

Automated, whole project, at the final commit of the session:

- type check clean; ESLint clean
- full test run: see the session log for the exact file and test counts of the final run
- migrations test passes; schema generator reports no drift against `migrations/0000_baseline.sql`
- production-style preview build succeeds

In a real browser against the preview build with synthetic data:

- customer: sign-in, authenticator enrolment and recovery codes, dashboard, 17 routes at 375 px with one
  `h1` each and no horizontal overflow, file upload and download, three-step new order, support ticket reply,
  invoice detail and PDF, dark theme, sign-out
- isolation: customer A cannot open customer B's order; customers and staff get "Page not found" on
  console routes they are not entitled to; staff see only their eight console routes
- administrator: 25 console routes at 1440 px and 390 px, overview widgets, status transition with note,
  reference change (with step-up, audit events and history), policy and staff pages behind step-up,
  audit event detail, audit chain verification, SIEM page, console search on a phone, sign-out and
  redirect of a protected route back to sign-in
- audit trail after a clean seed and a QA pass contains no routine scheduler noise and no anonymous
  session-probe refusals

## Verified for increment 02 (integrator's own runs)

Automated, whole project, at commit `888e7eb` (commit `949d00c` afterwards changed two UI files; for it the
type check, the lint of the touched folders and the two touched test files were rerun, not the full suite):

- type check clean; ESLint clean
- full test run: 86 files, 1056 tests passed, 5 placeholders (`todo`), no failures
- migrations test 4 of 4, including an upgrade of a baseline database that already holds orders and catalog
  rows (existing orders get subtotal = total, no discount; existing rows get an empty deliverables list);
  the same upgrade was also run once against the preview database holding session-01 data; the schema
  generator reports no drift after `migrations/0001_offerings_and_production_dispatch.sql`
- preview build succeeds; a clean database was migrated and seeded with the offerings file

In a real browser against the preview build with synthetic data:

- customer: packet picker at 1440 px and 320 px (six packets, one radio group each, arrow keys change the
  tier, deliverables disclosure, no horizontal overflow), server-quoted summary, "add all six for 15% off"
  hint, all six packets → subtotal $7,740.00, bundle −$1,161.00, total $6,579.00 on the review step and on
  the placed order; order detail shows tier, timeline, outcome and deliverables; customers have no
  "Production" tab
- administrator: catalog page with packet groups, tiers, deliverable counts and the bundle rule; production
  pipeline page (settings save requires step-up; dispatch list); console order "Production" tab with the
  P101 preview — one packet → `packet "1"`, `tier "Premium"`; two packets → `packet "7"`, `tier "Mixed"`
  and a `bundle_scope_manifest` string listing each packet; all six → `"7"` / `"Mixed"` with six entries;
  "Start Phase I" stays disabled while the endpoints are not configured
- staff: see the "Production" tab with client name and email masked in the preview; the production
  settings page is "Page not found" for staff

Reviewed by a second engineer (not the author): production webhooks, findings PW-01 to PW-08, all closed
(`docs/security/REVIEW-production-webhooks.md`).

## Not verified

- production webhooks against the real P101 / P201 endpoints: no HTTP request has been sent to any real
  receiver; TLS to the real host, receiver-side de-duplication across retries, and a full
  P101 → artifacts → P201 run are untested. Keep the pipeline disabled until an operator has tested it
  with a synthetic order.

- installation on a real VPS or issuance through the live Let's Encrypt service; the [native-install CI scope](../operations/AUTO_INSTALL.md#verification-status) uses self-signed and local Pebble certificates. It does not exercise native upgrade or uninstall.
- outbound mail through a real SMTP server (mail is held in the outbox until configured)
- delivery to a real SIEM or syslog collector (covered by tests against local fakes only)
- PostHog and Microsoft Clarity against real projects
- passkeys on a physical authenticator
- assistive technology: no screen reader pass and no third-party audit; the target is WCAG 2.2 AA and no
  conformance claim is made
- restore of a backup onto a second machine
- load, soak and penetration testing
- native iOS / Android applications (not built; see ADR 0020)

## Outstanding and known limits

- Increment 02 decisions the owner should confirm: Packet 8 is not loaded or offered; the 15% bundle
  discount applies only when all six packets are in one order; `order_scope_mode` is never sent (per the
  corrected P101 document); P101 / P201 are started by staff by hand and there is no callback from the
  pipeline; `customer_id` is the customer's portal reference and `order_id` is the order reference at the
  time P101 is sent (the reference documents show a different identifier format in their examples).
- The packet summary shows no figures when an order contains only non-packet catalog items.

- Five tests are placeholders (`todo`): passkey cross-user isolation fixture, policy acceptance cross-order
  fixture, and three admin journeys through the fully assembled app (SIEM, backup/integrations, audit
  center UI). The underlying module behaviour has its own tests.
- Sensitive admin reads (staff, policies) ask for step-up even right after sign-in. This is intended.
- Orders pipeline widget shows loaded counts ("N+") because there is no count endpoint yet.
- Compliance: no acceptance-statistics endpoint; the intake "sensitive" flag is stored but not yet used
  for extra handling; voiding an invoice has no idempotency key.
- Privacy notice and terms of use are drafts pending legal review.
- Analytics is off by default; the accepted residual risk is recorded in ADR 0021.
- Stripe is hard-disabled (payments are recorded manually); SAML and SharePoint are scaffolds only.
- Search indexing: the portal is private and `noindex` by design (ADR 0010). SEO / GEO / AEO work belongs
  on the public marketing site.
- Native mobile apps are a later phase. The portal is responsive and installable as a PWA (ADR 0020).
- GitHub: pushed to the private repository `MadaSito/ReadyPacketsCustomerPortal` (`main` plus tags). The
  repository named in the specifications (`readypackets/ReadyPackets-SiteSplit`) was not accessible to the
  connected account and was not touched. Both workflows (`ci`, `security`) pass on `main` as of commit
  `d920612`. CodeQL results are gated inside the job because GitHub code scanning is unavailable on this
  private repository; dependency review is skipped for the same reason (set the repository variable
  `CODE_SCANNING_ENABLED=true` if the feature becomes available). Branch protection is not configured yet,
  and actions are not yet pinned by commit SHA.

## How to continue

1. Read `docs/engineering/BUILD_CONTRACT.md` and the ADR index in `docs/adr/README.md`.
2. `source scripts/dev/env.sh`, then `scripts/dev/tc.sh`, `pnpm exec eslint .`, `pnpm exec vitest run --maxWorkers=1`.
3. For a first real installation follow `docs/operations/INSTALL.md`.
