# ReadyPackets Portal — Status

Last updated: 2026-11-20 (end of session 01). Keep this file current; it is the honest state of the build,
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
| Deployment | one installer for a VPS (nginx + systemd), upgrade and uninstall scripts, optional Docker profile, CI and security workflows | `deploy/`, `.github/workflows` |
| Documentation | 21 ADRs, threat model, security reviews, guides for customers / staff / admins, runbooks, requirements register | `docs/` |

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

## Not verified

- installation on a real host with `deploy/install.sh`, nginx, TLS certificates and systemd
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
- GitHub: see the session log for whether the repository was pushed in this session.

## How to continue

1. Read `docs/engineering/BUILD_CONTRACT.md` and the ADR index in `docs/adr/README.md`.
2. `source scripts/dev/env.sh`, then `scripts/dev/tc.sh`, `pnpm exec eslint .`, `pnpm exec vitest run --maxWorkers=1`.
3. For a first real installation follow `docs/operations/INSTALL.md`.
