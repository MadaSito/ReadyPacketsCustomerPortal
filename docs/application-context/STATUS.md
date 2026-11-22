# ReadyPackets Portal — Status

Last updated: 2026-11-21 (after increment 04, parts A and B). Keep this file current; it is the honest state of the build,
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
| Integrations | PostHog and Microsoft Clarity (configurable project id, consent-gated, off by default); Microsoft Graph (mail, SharePoint, OneDrive) and outbound allow-list presets (increment 03); hosted Stripe / Square checkout lives in `payments` (increment 04) | `server/modules/integrations`, `client/src/features/integrations` |
| UI | design system on the brand kit, light/dark/system themes, customer shell with mobile tab bar, console shell, installable PWA shell with offline page | `client/src/{ui,app,styles}`, `client/public` |
| Deployment | native auto-install on fresh Ubuntu 26.04 (prerequisites, optional swap, fixed host and optional alias, switchable certificate mode, one-time temporary admin password display, offerings); manual install on Ubuntu 24.04/26.04; upgrade and deactivation; Docker Compose for evaluation | `deploy/auto-install.sh`, `deploy/install.sh`, `deploy/nginx/*.conf.template`, `deploy/docker/`, `docs/operations/AUTO_INSTALL.md`, `.github/workflows/native-install.yml` |
| Offerings catalog (increment 02) | Master Offerings Matrix v3.0 as owner-controlled data (`data/catalog/readypackets-offerings-v3.0.json`, 18 products = Packets 1–6 × Basic / Standard / Premium, 112 deliverables), audited `ops:catalog-import`, one tier per packet, server-quoted totals, bundle rule (15% when all six packets are in one order), packet picker in the order wizard, tier / outcome / timeline / deliverables on orders | `data/catalog`, `scripts/ops/catalog*`, `server/modules/orders`, `client/src/features/orders` |
| Production pipeline (increment 02) | manual Phase I (P101) and Phase II (P201) webhook triggers from the console order page, exact field set of the reference documents, encrypted outbox with fenced retries and reconciliation, destination pinning, pre-send order revalidation, admin settings behind step-up, dispatch list; disabled until configured | `server/modules/integrations/production`, `client/src/features/integrations/production`, `docs/integrations/PRODUCTION_WEBHOOKS.md` |
| E-mail delivery (increment 03) | sender and reply-to, audit copy mailbox, SMTP and Microsoft Graph transports with primary / secondary routing, optional encrypted retention of sent content with "View message", form-based configuration | `server/modules/jobs` (mail), `server/modules/integrations/graph`, `client/src/features/mail` |
| E-mail templates (increment 03) | system and custom templates, rich HTML or plain text, declared placeholders, own HTML sanitizer, versions, inert preview, test send | `server/modules/mailTemplates`, `client/src/features/mailTemplates` |
| Settings forms (increment 03) | every setting editable through a generated form; JSON editor kept as a second tab | `client/src/features/platform` |
| Workflow designer (increment 03) | wizard and canvas over one draft, validation, "Tidy layout", versioned publish (existing orders keep their version) | `server/modules/orders`, `client/src/features/orders/pages/workflows` |
| Automations (increment 03) | event / schedule / manual triggers, conditions, actions (templated e-mail, in-app notice, webhook), wizard and canvas, test without sending, run history, portal-wide switch and limits; off by default | `server/modules/automations`, `client/src/features/automations` |
| Entra ID single sign-on (increment 03) | OpenID Connect against one tenant, "Sign in with SSO" button when enabled, linking, optional first-sign-in provisioning (never administrators), local break-glass for administrators, `recover-admin` host command | `server/modules/identity/sso`, `client/src/features/identity/sso`, `scripts/ops/recover-admin.ts` |
| Storage connections (increment 03) | Amazon S3, Wasabi, Backblaze B2, custom S3, Azure Blob, Dropbox, Google Drive, SharePoint library, OneDrive for Business as copy destinations (local storage stays the system of record); assignments for order files, backups and order data | `server/modules/storage`, `client/src/features/storage` |
| SharePoint order sync (increment 03) | one-way mirror of order rows to a SharePoint list, backfill, per-order status | `server/modules/sharepoint`, `client/src/features/storage` |
| Off-site backups (increment 03) | copies of verified encrypted backups to assigned storage connections, 3-2-1 status computed from real verified copies; the backup key never leaves the host | `server/modules/backup`, `client/src/features/backup` |
| Native upgrade (increment 03) | `deploy/upgrade.sh` with typed confirmations, verified pre-upgrade backup, guide | `deploy/upgrade.sh`, `docs/operations/UPGRADE.md` |
| Workflow phases and requirements (increment 04) | phases with locks on exit; requirements per status (file and audio uploads, administrator-set acknowledgements); in-browser audio recording; conversion to WebM/Opus by a sandboxed FFmpeg job (original kept); ADR 0029, 0030 | `server/modules/{orders,files}`, `client/src/features/{orders,files}` |
| Application protection (increment 04) | firewall rules starting in detect mode, rate-limit controls, IP blocking, country blocking from an operator-supplied MMDB; session centre with sign-in log, session view, restrictions and forced end; ADR 0031, 0032 | `server/modules/{protection,identity}`, `client/src/features/{protection,identity}` |
| Customer maintenance (increment 04) | customer sign-in blocked with a banner during a window, separate from worker drain; staff and administrators can still sign in | `server/modules/{jobs,identity}`, `client/src/features/jobs` |
| Knowledge base (increment 04) | versioned articles, categories, search, attachments, feedback, Help Centre at `/help`, console at `/admin/knowledge`; off by default; ADR 0033 | `server/modules/knowledge`, `client/src/features/knowledge` |
| Community forum (increment 04) | moderated forum, reports, categories; off by default; ADR 0033 | `server/modules/community`, `client/src/features/community` |
| Referrals (increment 04) | attribution, link sharing, account credit on the first paid invoice with manual approval; ADR 0033 | `server/modules/referrals`, `client/src/features/referrals` |
| Inbound API and webhooks (increment 04) | inbound API v1 with scoped keys; signed inbound endpoints and outbound subscriptions; searchable redacted logs and audited re-run; ADR 0034 | `server/modules/{publicApi,integrations/webhooks}`, `client/src/features/{publicApi,integrations/webhooks}` |
| Themes (increment 04) | Light, Dark and System through one shared control | `client/src/{app,ui,styles}` |
| Cookies and consent (increment 04) | banner and preference centre; PostHog and Clarity load only after consent; server-side ledger kept 36 months by default (setting, 12–72) with an audited purge; ADR 0036 | `server/modules/platform`, `client/src/lib/consent.ts`, `client/src/features/{platform/consent,integrations}` |
| Customer navigation (increment 04) | desktop sidebar, drawer on smaller screens, phone shortcuts with More; ADR 0037 | `client/src/app` |
| Cart and hosted checkout (increment 04) | server-priced cart; checkout by redirect to Stripe or Square, or pay by invoice; paid only after a signed webhook and a provider read-back; ADR 0035 | `server/modules/{cart,payments}`, `client/src/features/{cart,payments}` |
| Console order administration (increment 04) | administrators create orders for a customer, reassign them and grant delegated access | `server/modules/orders`, `client/src/features/orders` |
| Copy log and mail resend (increment 04, owner follow-ups to increment 03) | storage Copy log with filters, CSV and guarded retries; manual resend of an unknown-outcome mail after step-up and a duplicate-risk acknowledgement | `server/modules/{storage,jobs}`, `client/src/features/{storage,mail}` |
| Accessibility (increment 04) | WCAG 2.2 AA target; public Accessibility page; automated axe checks in both themes and real-browser sweeps; no conformance claim; ADR 0037 | `client/src/features/accessibility`, `docs/verification/ACCESSIBILITY.md` |
| Console order workspace (increment 04 part B) | header action row, thirteen tabs each with its own address, rename with name history (`order_name_history`) | `server/modules/orders`, `client/src/features/orders/pages/AdminOrderDetailPage.tsx` |
| Per-order production pipeline (increment 04 part B) | Automation tab: P101 / P201, optional P301 / P401, reasons for disabled buttons, pipeline history, retry reusing the Idempotency-Key, redeliver with administrator step-up and typed `REDELIVER`, workflow stage actions; ADR 0041 | `server/modules/{integrations/production,automations}`, `client/src/features/{integrations/production,automations,audit}` |
| Order history (increment 04 part B) | status lane and activity lane with categories; reduced customer view | `server/modules/audit`, `client/src/features/audit/OrderHistoryTab.tsx` |
| Order file sync (increment 04 part B) | per-order sync tab with retry; folder template per slot or workflow with tokens `{customer_ref}` `{order_ref}` `{order_name}` `{phase}` `{slot}` `{yyyy}` `{mm}`; ADR 0040 | `server/modules/{storage,files,sharepoint}`, `client/src/features/storage/OrderFileSyncTab.tsx` |
| Refunds (increment 04 part B) | provider refund for Stripe / Square payments, "recorded only" for manual payments, typed `REFUND ORDER` and administrator step-up, reconcile job for unknown outcomes; ADR 0038 | `server/modules/{payments,compliance,jobs}`, `client/src/features/payments/OrderRefundTab.tsx` |
| Policy acceptance gateway (increment 04 part B) | per acting user; append-only evidence; receipt; Acceptances tab; gates uploads, recordings, intake, acknowledgements and phase submission; staff and cancellation not gated; ADR 0039 | `server/modules/compliance` (acceptance), `client/src/features/compliance/acceptance` |
| Migrations (increment 04) | `migrations/0003_increment_04.sql` and `migrations/0004_increment_04_part_b.sql`, both additive | `migrations/` |
| Documentation | 41 ADRs, threat model, security reviews, guides for customers / staff / admins, runbooks, requirements register | `docs/` |

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

## Verified for increment 03 (integrator's own runs)

Automated, whole project, at the head of `feat/increment-03` before merge:

- type check clean, including a compile-time check that the hand-written client API facades for mail,
  storage and automations match the server router (`client/src/features/facadeContracts.typecheck.ts`);
  ESLint clean
- full test run: 117 files, 1363 tests passed, 5 placeholders (`todo`), no failures
- migration `0002_integrations_mail_sso_automations.sql` applies on a database that already holds rows
- preview build and production client build succeed
- native upgrade on a GitHub-hosted Ubuntu 26.04 runner (`native-install` workflow, job "upgrade from
  d964a3b"), passed at commit `35b0d0b`, tested as the pull request merge with `main` ([run 44947983659](https://github.com/MadaSito/ReadyPacketsCustomerPortal/actions/runs/44947983659)): the previous release is installed, an
  administrator enrols an authenticator, a customer and an order are created, maintenance is drained,
  `deploy/upgrade.sh --yes` runs, and afterwards the sign-in, the customer (old `RP-` reference kept), the
  order, the verified pre-upgrade archive, a new customer with an `RPCUS-` reference and the full install
  smoke test are checked. The first runs of this job failed and found a real defect in `deploy/upgrade.sh`:
  it disabled the services before reading their exit record, systemd had already dropped that record, and
  the upgrade stopped at the draining phase with the services down. Fixed in `35b0d0b` (stop, check, then
  disable); the behaviour was reproduced separately on systemd 259. Three wrong field / procedure names in
  the job's own script were corrected as well.

In a real browser (Chromium) with synthetic data. Preview profile unless stated:

- administrator sign-in with authenticator enrolment and recovery codes; the new "Integrations" navigation group
- E-mail delivery: sender and routing saved, retention saved, audit mailbox saved (pending verification),
  SMTP and Microsoft Graph tabs with their fields and test buttons
- template centre: 17 system templates listed; custom template created; `<script>` and an undeclared
  placeholder refused; toolbar reachable by arrow keys; preview in a sandboxed frame; version 1 published;
  no request left the page
- workflow designer: wizard (five steps) and canvas on the same draft; arrow-key move keeps focus; C then
  Enter connects; "Tidy layout" produced seven steps with no overlap; publish created version 2 while the
  five existing orders stayed on version 1
- automations: recipes, wizard, canvas, "Test without sending", save, detail page; the portal-wide switch
  was turned on from the Automations page and the Settings row points there
- Mail page: attempts dialog; the notice that explains where "View message" is turned on
- Storage connections: page loads; Amazon S3 preset allowed (step-up); nine providers in the wizard with
  their own field names; a connection saved with invented credentials, its test reported "Access denied"
  and "Enable" stayed unavailable
- SharePoint order sync, Backups (off-site copies and 3-2-1 card show "not met" with no destinations),
  Settings (form and JSON tabs; a numeric setting saved through the form)
- 390 px and 320 px: ten new or changed console pages have one `h1` and no horizontal overflow
- no `<style>` element and no Content-Security-Policy violation on these pages after the dialog fix
- development profile (cookie sessions, production client build, a fresh database): bootstrap administrator →
  authenticator enrolment → forced password change → console; single sign-on configured with an invented
  tenant and enabled; the "Sign in with SSO" button appeared under "Sign in" (absent before); pressing it
  redirected to Microsoft's authorize address with `state`, `nonce` and a PKCE S256 challenge (Microsoft
  answered "tenant not found", as expected); a forged callback landed on the "attempt expired" page
- new customer references in the seeded database have the form `RPCUS-` plus nine characters

Found and fixed during this pass: dialogs triggered a Content-Security-Policy report (scroll lock added a
`<style>` element); the Storage connections page crashed because its client facade had drifted from the
server (now covered by the compile-time check); the automations switch could not be reached from any page;
canvas fit padding, focus loss after a keyboard move and cramped default spacing; unclear "View message"
availability; a preset label that said "Active" while off.

Reported by the engineers, not rerun individually by the integrator beyond the full suite: the per-module
checks listed in each module's `VERIFICATION.md`, and the second-engineer security review
(`docs/security/INCREMENT_03_REVIEW.md`).

## Not verified

- increment 03 against real services: nothing was sent to or received from a real Microsoft 365 / Entra ID
  tenant (Graph mail, SharePoint, OneDrive, sign-in completion), Amazon S3, Wasabi, Backblaze B2, Azure
  Blob, Dropbox or Google Drive. These are covered by tests against local protocol fakes only. A complete
  single sign-on round trip (code exchange, token validation, session) was not run in a browser.
- "View message" for a delivered e-mail and an off-site backup copy were not exercised in a browser (both
  need a working external service); they are covered by the module tests.
- the native upgrade on a real server. The runner check above uses a fresh machine, a self-signed
  certificate, one customer and one order, and the unattended `--yes` mode; the typed confirmations of the
  interactive mode and an installation older than `d964a3b` were not exercised.

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
- no real Stripe or Square account: checkout, payment webhooks and provider refunds
- no real n8n / production receiver for P101 / P201 / P301 / P401
- no real SharePoint or other storage provider for order file sync
- audio recording and conversion on real phones
- country blocking with a real MMDB
- no assistive-technology (screen reader) manual audit of the increment 04 pages
- behaviour of the firewall and rate limits under real attack traffic
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
- Hosted Stripe / Square checkout and provider refunds exist but are off until an administrator configures a
  provider; they have never been tested against a real provider account. Single sign-on is OpenID Connect against one
  Entra ID tenant; SAML is not implemented.
- Increment 03 decisions the owner should confirm: cloud storage holds copies only and local storage stays
  the system of record; the audit copy mailbox also receives password-reset and activation mail with the
  one-time link removed; a message whose outcome is unknown is never resent or failed over automatically;
  automations cannot change order status or permissions; publishing a workflow creates a new version and
  existing orders keep theirs; retention of sent content and the automations engine are off by default.
- Increment 04 decisions the owner should confirm:
  - **Payments and refunds.** Hosted checkout is by redirect, so no card data reaches the portal. Refunds go to the provider and need the typed `REFUND ORDER` plus administrator step-up. Refunds of manual payments are recorded only and move no money.
  - **Later phases (an assumption).** Phase III / IV are optional P301 / P401 endpoints with the payload `{customer_id, order_id, run_mode}`. The reference documents define only P101 / P201.
  - **Redelivery and retry.** Redelivery needs administrator step-up and the typed `REDELIVER`. A staff retry reuses the original Idempotency-Key and is refused when the destination has changed. An administrator re-send authorises the new destination, so duplicates across two different receivers are an operator risk.
  - **Acceptance.** Acceptance is per acting user. Staff are not gated, and cancellation is never gated. Customers see a generic "Order renamed".
  - **File sync.** The default folder template is `customers/{customer_ref}/orders/{order_ref}/{phase}`.
  - **Protection.** Country blocking needs an operator-supplied MMDB, and the firewall starts in detect mode.
  - **Referrals.** The reward is account credit on the first paid invoice, with manual approval. A refunded first invoice sends the reward to manual review.
  - **Defaults.** The community forum is off by default. The consent ledger is kept 36 months.
  - **Accessibility.** Accessibility is a WCAG 2.2 AA target, not a certification.
- Follow-ups (not blocking):
  - binding-set drift on a same-key automation replay;
  - Graph remote-file reuse is keyed on the QuickXor hash only;
  - no account-erasure path;
  - community search uses `LIKE`;
  - the Activity lane labels a recorded-only refund "Refund issued".
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
