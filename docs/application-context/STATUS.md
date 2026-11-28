# ReadyPackets Portal — Status

Last updated: 2026-11-28 (increment 07 merged to `main` as `c337492` through PR #16; fix pack 07.1 merged as `547a31d` through PR #19; fix pack 07.2 merged as `762ea41` through PR #21; increment 08 merged as `1587d11` through PR #23; increment 09 verified by the lead on `feat/increment-09` at `cf02944`, PR and merge pending). Keep this file current; it is the honest state of the build,
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
| Workflow transfer (increment 05) | export of one, several or all workflows as a JSON package with a SHA-256 digest (detects damage, not a signature); import with preview, always as drafts, provenance in `order_workflow_imports`; automations not transferred; off by default (`orders.workflow_transfer.enabled`); ADR 0042 | `server/modules/orders/workflowTransfer*.ts`, `docs/guides/WORKFLOW_TRANSFER.md` |
| Cart suggestions (increment 05) | up to three server-priced add-on, tier-upgrade or bundle-completion suggestions; accept and dismiss; admin page `/admin/carts/suggestions`; off by default (`feature.cart.upsell`); ADR 0043 | `server/modules/cart`, `client/src/features/cart` |
| Discount codes (increment 05) | codes, batches up to 5,000, fragment links (`/promo#promo=<CODE>`); redemption inside order creation; 50 % global guard; uniform refusals, rate limit and pause; conservative release rule; console `/admin/promotions`; off by default (`feature.promotions`); ADR 0044 | `server/modules/promotions`, `client/src/features/promotions`, `server/modules/{cart,orders,compliance}` |
| Policy acceptance log centre (increment 05) | read-only Log, Coverage and Policy updates at `/admin/policy-acceptances`, customer profile Policies tab, step-up CSV export up to 5,000 rows; always on; ADR 0045 | `server/modules/compliance`, `client/src/features/compliance/pages/acceptances` |
| Recording (increment 06) | Record button wherever audio is accepted; runtime format choice with device fallback; preflight; server conversion to WebM/Opus (a re-encode, original kept); on by default; ADR 0047 | `server/modules/files`, `client/src/features/files` |
| Installable app (increment 06) | manifest, install entry for each platform, a service worker limited to an allowlisted public static precache; ADR 0048 | `client/public`, `client/src/app`, `deploy/` |
| Reports (increment 06) | 8 built-in reports, whitelisted custom reports, step-up CSV; ADR 0049 | `server/modules/reports`, `client/src/features/reports` |
| Sign-in bans and incidents (increment 06) | escalating IP bans with lock-out guards, rate-limit back-off, correlated incidents forwarded to SIEM; ADR 0050 | `server/modules/{protection,identity,audit,siem}`, `client/src/features/{protection,audit}` |
| Phase tasks (increment 06) | upload, acknowledge (incl. order note), record, respond to a document; per-task type restrictions; waivers; package format 2; ADR 0051 | `server/modules/orders`, `docs/guides/WORKFLOW_CUSTOMER_TASKS.md` |
| Word editing (increment 06) | browser-only conversion; save as new version, original kept; stated limits; ADR 0052 | `client/src/lib/docconvert`, `client/src/features/docedit`, `server/modules/files` |
| Policies and MNDA (increment 06) | import from Word/Markdown/PDF, timed notices, enforcement with session end and `/accept-policy`, typed-name check, order agreement gate (off by default); ADR 0053 | `server/modules/{compliance,identity,orders,jobs}`, `client/src/features/compliance`, `client/src/lib/agreementGate` |
| Receipts and discount limits (increment 06) | one receipt per confirmed payment with PDF, e-mail and portal tab; small-total waive/block; discount limits up to 100 % and `set_total`; ADR 0054 | `server/modules/{compliance,payments,promotions,cart}`, `client/src/features/{compliance,payments,promotions,cart}` |
| Phases-first workflows (increment 07) | definition format 3 with up to 20 named phases; customer phase wizard (Next, Submit and lock with acknowledgement); staff review and administrator reopen with a reason; questions with versioned answers; administrator checklist; standard workflow starting with "Payment"; ADR 0055 | `server/modules/orders`, `server/modules/orders/questions`, `shared/workflowStages.ts`, `client/src/features/orders/stages` |
| Progress (increment 07) | weighted derived progress capped at 99 until a `done` status, shown as the higher of derived and explicit; `OrderProgress` progressbar on orders, lists, dashboard and console; recalculated by `orders.increment07.startup` at every boot and every 10 minutes; ADR 0055 | `shared/workflowStages.ts`, `server/modules/orders`, `client/src/ui` |
| Status catalogue and attention (increment 07) | `/admin/workflows/statuses`; "Awaiting staff review" and "Awaiting customer response" filters and counts; optional reminder alerts (off); ADR 0056 | `server/modules/orders/statusCatalog*`, `client/src/features/orders` |
| Phase actions and rules (increment 07) | human-confirmed bundle (status, completion fixed or a range drawn once, e-mail, webhook, alert), delays up to 30 days, rule ordering and new triggers; unattended rules never change status; ADR 0057 | `server/modules/automations` |
| Operational alerts and phase webhooks (increment 07) | `/admin/alerts`; P101 / P201 auto-queue (off per workflow; P101 on a real payment record); pipeline signing (off); stop, retry, redeliver; live integrations hub cards; ADR 0058 | `server/modules/{opsAlerts,integrations}` |
| Phase files (increment 07) | phase-bound uploads (`STAGE_REQUIRED` on phases orders), governance, playback grants with range requests, phase and whole-order ZIP; ADR 0059 | `server/modules/files`, `client/src/features/files` |
| Stripe completion (increment 07) | order payment state, Pay online, async payments, `/admin/payments/setup` with gated activation, rejections log; ADR 0060 | `server/modules/{payments,compliance}`, `client/src/features/payments` |
| Microsoft 365 file sync (increment 07) | one-way per phase to SharePoint, write check, bounded resync, health and alerts (off until configured); ADR 0061 | `server/modules/{storage,sharepoint}` |
| SAML with Entra ID (increment 07) | SP-initiated SAML 2.0 with a hardened wrapper, pinned certificates, MFA modes `claim` / `entra` / `portal`, allowed roles, daily metadata check (off until configured); ADR 0062 | `server/modules/identity/sso`, `client/src/features/identity/sso` |
| Migration (increment 07) | `migrations/0007_increment_07.sql`, additive: 16 tables, 40 columns on 11 tables, one widened enum, 96 statements, no `DROP` | `migrations/` |
| Staff ordering handoff and portal switch (increment 07.1) | staff and administrators get a handoff panel on `/orders/new`, `/cart`, `/cart/checkout`, `/checkout/return` and `/checkout/cancel` with **New order for a customer** → `/admin/orders?new=1`; visible **Customer portal** / **Admin portal** / **Staff portal** switch; staff landing on `/admin` with a per-tab choice; discount code hints | `client/src/app/portal.tsx`, `client/src/lib/portal.ts`, `client/src/features/{cart,orders}` |
| Increment 07.2 fix pack | Stripe checkout failure diagnostics, **Verify Checkout session creation**, ACTIVE / NOT ACTIVE banner, **Pay now** recovery; signing secret normalisation and per-field errors; branded invoice / receipt / refund note PDFs with Order and Project; **Set as default** workflow; clearer update prompt. No migration | `server/modules/{payments,cart,compliance,orders,jobs}`, `client/src/features/{payments,cart,compliance,orders}`, `client/src/app/PwaUpdatePrompt.tsx` |
| Documentation | 62 ADRs, threat model, security reviews, guides for customers / staff / admins, runbooks, requirements register | `docs/` |

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

## Verified for increment 04 (integrator's own runs)

Automated, whole project, on branch `feat/increment-04` at commit `b00f8df`:

- type check clean; ESLint clean with `--max-warnings 0`
- full test run: 168 files, 2041 tests passed, 4 placeholders (`todo`), no failures. This includes
  `tests/migrations.test.ts` (committed migrations produce exactly the declared schema). Two earlier full
  runs on the same branch each had one test fail under load and pass when run alone
  (`consent.test.tsx`, `mailTemplates.test.tsx`); neither failed in the last two full runs
- the two code commits after `b00f8df` (`838de62` wrapping of radio option text, and the "New order"
  heading kept visible while the order wizard loads) were checked with the type check, ESLint on the changed
  files and their test files (`ui.test.tsx`, `increment04.test.tsx`, `storage.test.tsx`,
  `complianceCustomer.test.tsx`), not with another full run
- production build succeeds at the head of the branch; preview build succeeded at `efb7fa8`
- `shellcheck -x` clean on the deployment and CI scripts listed in the `native-install` and `container`
  workflows
- migrations `0003_increment_04` and `0004_increment_04_part_b` applied to a populated development
  database with the operator command (`node dist/ops/migrate.js`)

Browser, development profile with cookie sessions and synthetic data, Chromium, by the integrator:

- console order page: rename (header and "Order history" updated with old and new name); draft invoice
  created from the order, issued and paid by a manual payment (step-up with password and authenticator code;
  typed invoice number); partial refund, then refund of the remainder, both "recorded only" — the submit
  button stays disabled until `REFUND ORDER` is typed exactly, the amount is entered in dollars, the
  refundable balance and the header badge ("Partially refunded", then "Refunded") update without a reload
- "Order history": status lane with the rename; activity lane with readable labels and the "Payments"
  category for invoice, payment and refund events
- production pipeline settings page shows the P101 / P201 and optional P301 / P401 endpoints; with no
  endpoint configured the start buttons on the order are disabled (nothing was sent anywhere)
- workflow designer: an acceptance gate added on the canvas, review step lists phases, requirements, gates
  and the folder template, publish with step-up creates version 3
- customer: order placed through the cart and "Pay by invoice" (order and invoice numbers shown); on the
  order page the gate is shown above the checklist at 1280 px and 390 px with no horizontal overflow; upload
  and acknowledgement controls are disabled with an explanation; a direct upload request and a direct
  acknowledgement request are both refused by the server with HTTP 409 `ORDER_ACCEPTANCE_REQUIRED`; after
  acceptance the gate disappears and the receipt link appears
- console "Acceptances (1)" tab shows the record (who, when, policy and version, text fingerprint, receipt)
- customer upload of a PDF into a document requirement and of an M4A file into an audio requirement: both
  accepted, the checklist counts them, and the worker produced the WebM copy ("Converted WebM audio"); the
  console Files tab lists all three; with no storage connection assigned the console "File sync" tab says so
  and nothing is queued
- `/orders/new` keeps its page heading during load (6 of 6 navigations) and `/admin/storage/new` has no
  horizontal overflow at 240 px in both themes, at the head of the branch

Checks on pull request 8 (GitHub-hosted runners): see the pull request for the final run of `ci`,
`security`, `container` and `native-install`. The `native-install` workflow includes an upgrade from the
previous release (`89c5cb8`) that asserts both new migrations are applied.

Reported by the engineering team and reviewed, but not re-run by the integrator: the per-module test
files quoted in each module's `VERIFICATION.md`; the security review
(`docs/verification/INCREMENT_04_SECURITY_REVIEW.md`, no open release blockers); the accessibility and
responsive browser sweeps (`docs/verification/ACCESSIBILITY.md`): a full sweep at build `50a7dd6`
(accessibility 1002 checks, 26 failed; responsive 2672 checks at eight widths from 240 px to 2560 px, 46
failed; 24 fixtures missing in each), fixes, and a targeted recheck of the failed routes at `b00f8df` that
passed except the two items the integrator rechecked above. The routes that passed in the full sweep were
not swept again after the fixes. Browser zoom and assistive technology were not exercised. The integrator
did not exercise the in-browser audio recorder in a browser; it has component tests only.

## Verified after increment 04 — preview tests of 2026-11-22 (integrator's own runs)

Hosted preview (preview profile, in-memory sessions, synthetic data), rebuilt at `main` `b275b59` and
driven through the deployed client with Chromium. Details and the exact payload are in
`docs/session-logs/2026-11-22-session-01.md`.

- referral reward end to end: programme enabled with a fixed USD 50.00 account credit and manual approval;
  a synthetic customer registered through the referrer's link ("Attributed"); first invoice issued and paid
  by a manual payment ("Pending approval", USD 50.00); approval and "Mark credited" with step-up
  ("Credited", two reward-ledger entries); the referrer's page shows the masked account and "Credit
  applied"; the five `referral.*` audit events are present in order
- referral refund rule: a second synthetic referral whose paid first invoice was then fully refunded
  ("recorded only") stayed in "Pending approval" with the note "Qualifying invoice refunded" and the audit
  event `referral.moved_to_manual_review`; nothing was reversed automatically
- Phase I (P101) dispatch from the order's "Automation" tab for synthetic order `RP-2026-000006`, sent to a
  **neutral public echo service** (`postman-echo.com`), not to the owner's pipeline: allow-list rule
  required and matched, dry run `DRY_RUN_ALLOWED`, dispatch "Delivered" with HTTP 200 on attempt 1, the
  stored body hash equals the hash of the documented ten-field payload (`packet "1"`, `tier "Basic"`,
  `bundle_scope_manifest` as a JSON string), request and delivery audit events written, Phase II then
  offered with the three locked fields and not started; the pipeline switch was turned off afterwards
- e-mail confirmation in the preview after the fix below, with two fresh synthetic accounts: demo link,
  "Email confirmed", "Continue", authenticator setup
- type check and ESLint (whole project) clean; `auth.test.tsx` and `consent.test.ts` pass; preview build

Fixed in this pass: the preview's in-app verification link did nothing (token read only at first render);
a dead "Send a new link" after confirming while signed in; a `SecurityError` when cookies are unavailable
during analytics clean-up.

## Verification for increment 05

Integrator's own runs on 2026-11-22, on branch `feat/increment-05` (synthetic data only):

- type check clean; ESLint on the whole project with `--max-warnings 0` clean
- full test suite: 181 files, 2233 tests passed, 4 marked to-do; this includes the new suites for workflow
  transfer, cart suggestions, discount codes and the acceptance log, and the cross-module isolation and
  authorisation suites
- migration `0005_increment_05` applied with `pnpm db:migrate` to an existing development database that
  was at `0004` and held data (tables 164 → 172; `orders.promo_discount_minor` and `promo_label` present);
  production build succeeds
- in a real browser (Chromium) against a disposable development-profile portal with all four features
  switched on:
  - workflows: "Export all" downloaded an integrity-checked package; importing it back offered create /
    add as draft / skip, asked for step-up, created the draft `standard_2` without publishing or changing
    the default; a package edited by hand was refused ("changed or damaged")
  - cart suggestions: an add-on and a tier-upgrade offer created in `/admin/carts/suggestions` appeared in
    the customer's cart; accepting the add-on added the item and updated the counters; a tier upgrade is
    offered only when the lower tier is in the cart
  - discount codes: a 20 % code with a use limit and end date, and a batch of three single-use fixed-amount
    codes with CSV export; a wrong code and a second use by the same customer both answered "This code
    cannot be applied"; the right code reduced a USD 2,410.00 cart to USD 1,928.00; checkout by invoice
    produced an order and an invoice that show the label ("Spring offer"), never the code; the link
    `/promo#promo=…` saved the code for the tab, the fragment was removed from the address and no request
    carried the code in a URL; pause and resume; "Show code and link" behind step-up; a manual release of a
    redemption on an order that is not cancelled was refused by the server
  - acceptance log: Log, Coverage, Policy updates, the exact version text page, CSV export behind step-up,
    and the "Policies" tab on the admin customer profile showed the existing registration and order-gate
    acceptances
- accessibility and reflow: axe-core (WCAG 2.0 / 2.1 / 2.2 A and AA rule tags) and a horizontal-overflow
  check on 18 page states at 320, 768 and 1280 CSS px in light and dark (106 runs): no axe violations;
  one 5 px overflow at 320 px on the cart suggestions list was fixed and the page re-run. See
  `docs/accessibility/INCREMENT_05_REVIEW.md`.

Checks on pull request 10 (GitHub-hosted runners), at commit `788c18c`: `ci`, `security`, `container` and
`native-install` all succeeded. Beyond the usual jobs these runs showed:

- migration `0005_increment_05` applied exactly once on a fresh native install (Ubuntu 26.04, x64 and
  arm64), on the native upgrade from `89c5cb8` with a pre-existing administrator, customer and order, and
  in the Docker Compose stack
- the workflow-import body limit probed through the running proxy (nginx on the native paths, Caddy in
  the Compose stack): the two import paths accept the larger body and reach the application, one byte more
  is refused, and look-alike paths, other methods and batched requests keep the 256 KiB limit
- the first run of this pull request failed in five jobs because the new probe script re-declared a
  read-only shell variable, and in CodeQL because the migration bundle check read a file after checking it
  by name; both were fixed (`788c18c`) and the runs repeated
- a later documentation-only commit (`20e74ed`) failed `ci` on one client test: after verification for a
  workflow import preview, keyboard focus was sometimes left on the page behind the dialog instead of the
  "Review import plan" heading. This was a real timing fault, not only a test problem: the closing
  verification dialog could restore focus after the single check the import dialog made. `13ef9db` repeats
  the check for a short time and stops as soon as the user presses a key or pointer. The integrator ran the
  test file 16 times (4 of them under full processor load) without a failure and confirmed in Chromium that
  focus lands on the heading and that a following Tab is not overridden. The check results for the merged
  commit are on the pull request.

Reported by the engineering team and reviewed, but not re-run individually by the integrator: the
per-package test notes in each module's `VERIFICATION.md`; the security review
(`docs/security/INCREMENT_05_REVIEW.md`: no open findings in scope, one accepted residual and three payment
follow-ups recorded there); the component-level accessibility ledger. The engineering team stopped before the accessibility reviewer
sent a final report, so that ledger is a working record, not a sign-off.

Not verified for increment 05:

- discount codes with online card payment: no Stripe or Square account was used, so the "nothing to pay"
  path of a 100 % discount at a hosted checkout, a refund, and the automatic release of a redemption after
  cancelling an unpaid order were not exercised in a browser (module tests only)
- a discount code entered by staff while ordering for a customer, and the code field in the order wizard
  with the cart switched off (component and server tests only)
- a policy update: publishing a new policy version and watching Coverage change to "outstanding" was not
  exercised in the browser run (server tests only)
- importing a workflow package into a second, separate installation; the import was run against the
  installation that produced the package
- the workflow-import body limit on the owner's own server or behind a separately managed proxy (the
  runner checks above use a fresh machine and the shipped nginx and Caddy configuration)
- keyboard-only operation, browser zoom and screen readers for the new pages

## Verified after increment 05 — fix and P101 test of 2026-11-22 (integrator's own runs)

Details are in `docs/session-logs/2026-11-22-session-03.md`.

- authenticator setup no longer locks ([ADR 0046](../adr/0046-authenticator-setup-supersede.md)):
  - type check and ESLint (whole project) clean; full test suite 181 files, 2,235 tests passed (4 todo);
  - in Chromium against the QA environment (development profile, synthetic account), with two sign-ins of
    one account that has no second factor: the second sign-in received a different setup key at once and no
    refusal; the first sign-in's code was answered with "A newer setup was started from another sign-in, so
    a new QR code is shown…", a new key, an empty code field and focus on the message; the same at 390 px
    with no horizontal overflow; the last setup then confirmed and reached "Save your recovery codes";
  - the expired case (`TOTP_SETUP_EXPIRED`, including a setup already removed by the clean-up job) is
    covered by the unit tests only, not by a browser run.
- Phase I (P101) sent to the owner's webhook.site address from the QA environment for synthetic two-packet
  order `RP-2026-000009`: allow-list rule required and matched, dry run `DRY_RUN_ALLOWED`, dispatch
  "Delivered" with HTTP 200 on attempt 1; webhook.site shows exactly one `POST` carrying
  `Idempotency-Key: rp-prod:p101:<dispatch id>`, `X-ReadyPackets-Delivery` and `X-Correlation-Id`, and a
  ten-field body whose SHA-256 equals the hash stored by the portal (`packet "7"`, `tier "Mixed"`,
  `bundle_scope_manifest` as a JSON string); a second "Start Phase I" was refused; Phase II was offered and
  not started; the pipeline switch was turned off afterwards. webhook.site is a request inspector, so this
  proves delivery and format, not the production receiver.

## Increment 09

Owner's prompt 37 of 2026-11-27 ([session log](../session-logs/2026-11-27-session-01.md), [contract](../engineering/INCREMENT_09_CONTRACT.md)). Migration `0009_increment_09` (final at `d358237`), additive only: 56 statements, see [UPGRADE.md](../operations/UPGRADE.md#increment-09-and-migration-0009).

| Decision | What | Owner | State |
| --- | --- | --- | --- |
| D1 | Clickable links in e-mail; e-mail addresses in the console as `mailto` links | jobs_engineer, ui_foundation_engineer, page owners | implemented; the UI `mailto` links were verified by the lead on QA. Mail anchors are checked by tests only (eeee72e, 69378d7, cd822d3, bfca43a, eb57918) |
| D2 | Trash centre: move to trash, restore, permanent deletion, retention clean-up, legal hold | recovery_ops_engineer, audit_engineer, identity_engineer, orders_engineer, every data-owning module | implemented; verified by the lead on QA (3ed7b75, 1acae2c, a764b69, 851cf45, 9d9a0ba, fc4562b, 700ff9c, 0413d5a, 164b9c4, 33d8ac5, 6d93d94, e3b9e92, d7497b5, 8837890, 13f2a1d, 5c94588, 21b4149, 980f4ec, bcd27cc, cf02944) |
| D3 | New square logo and brand files, package 2026.10.15.2 | ui_foundation_engineer, compliance_engineer | implemented; verified by the lead on QA (da419de, 14dcade, 8bfdf73, aad7083, 6ed8d1c, 884213d, cf02944) |
| D4 | Documents; go-live checklist; security review record | platform_engineer, assurance_engineer | documents a22e302, acd4ab4, 465427a, 980f4ec, 5aa212a, ee46c7c, c97c86f and this update; checklist 8f4155a (to be run on the owner's server); [security review record](../verification/INCREMENT_09_SECURITY_REVIEW.md) |

### Verification for increment 09

Branch HEAD `cf02944`, 104 commits ahead of `main` (`44d04bf`). PR and merge commit: (filled at merge).

**Verified by the lead** on a QA production build of `feat/increment-09` at `cf02944`, in Chromium only. The build ran on a copy of the QA database with synthetic data, in pay-by-invoice mode, with mail not configured and local storage only.
- **Static checks.**
  - The type check was clean at `cf02944`, and eslint over the whole repository exited 0.
  - Full vitest run before `cf02944`: 254 files, 3,399 passed, 4 todo. After `cf02944`, the 5 touched test files were run again: 125 passed.
  - gitleaks found no leaks, and the production build exited 0.
  - Migration 0009 applied to the QA copy: "Migrations are up to date (10 applied)".
- **D1, links in e-mail.** Not checked in a real mail client. The evidence is at test level only:
  - In the lead's full run, `deliveryLinks.test.ts` renders every registered shipped template. It asserts an anchor for each link variable, and no anchor for free-form or hostile values.
  - Anchors are produced only when the portal address is HTTPS. QA runs on http, and the development mail capture stores only the text part, so no live anchor was inspected.
  - In the console, e-mail addresses on the customers list and on the customer page are `mailto` links.
- **D2, orders.**
  - Shown and working: the **Move to trash** dialog (what moves with the order, the due date, the reason), the **Undo** message, the Trash centre list, the sidebar badge and the restore dialog.
  - **Delete permanently** needs the typed order number (the button stays disabled otherwise) and a fresh two-step check (403, then "Confirm it's you").
  - After the deletion:
    - the order row is a tombstone: the project shows "Deleted order" and `purged_at` is set;
    - the working data is gone, while line items, invoice and receipt are kept;
    - the administrator view returns 404.
- **D2, customers.**
  - An account that is not suspended gets 409 "Suspend this account first.", and the button is disabled with a hint.
  - After suspending and moving the account to the trash, it returns 404, and sign-in is refused with the generic message.
  - **Restore** brings the account back suspended, with its orders, and the restore dialog lists what returns.
  - An order that went to the trash with its account shows **Restore** disabled, with "Restore the customer account first." This was checked again on the `cf02944` build.
  - Permanent deletion needs the typed customer ID.
  - A large synthetic account (20 orders with files, invoices and receipts) was deleted in about 3.6 s:
    - all 21 orders became tombstones;
    - notes, files, history, messages, intake, sessions and the billing profile all counted 0;
    - 8 unpaid invoices were voided, and 5 paid invoices and 4 receipts were kept;
    - the account row became a tombstone with its password cleared.
  - The same e-mail address registered again and received a new customer ID. Reusing the old customer ID returned 409.
- **Legal hold.**
  - Moving an order on hold to the trash returns 409 "Release the legal hold first.", shown in the dialog.
  - Moving a customer who owns a held order returns 409.
- **Bulk actions.** Restoring 3 selected items worked. A bulk permanent deletion needs exactly `DELETE 3`.
- **Retention settings.**
  - A value of 0 shows "Enter a whole number of days from 1 to 3650."
  - Every change needs a fresh two-step check.
  - Lengthening a period saves directly.
  - Shortening one shows how many items become due and asks for `DELETE <count>`. The due count and the row dates update.
- **Kept invoice.** The detail of a kept invoice shows the "Retained finance record" banner, with the frozen buyer name, e-mail and address.
- **Audit events seen:**
  - `order.trashed`, `order.restored`, `order.purge_started`, `order.purged`;
  - `customer.trashed`, `customer.restored`, `customer.purge_started`, `customer.purged`;
  - `trash.retention_changed`, `trash.cleanup_completed`.
- **D3, logo.**
  - The new square logo appears in light and dark on sign-in, registration, forgot password, the 404 page and the sidebar.
  - The web manifest lists the square 192 and 512 px icons and the maskable utility icon.
  - These return 200 with the right content type: the favicon (`.ico`, plus light and dark 32 px), the Apple touch icon, the 800 px square share image, the offline page logos and every manifest icon.
  - Sign-in has no sideways scrolling at 240 and 390 px.
- **Accessibility and widths.** The pages are designed and tested against WCAG 2.2 AA.
  - The axe-core WCAG 2.0, 2.1 and 2.2 A and AA rules found 0 violations in light and dark themes on `/admin/trash`, `/admin/customers`, the customer page, `/admin/orders`, the order page and the permanent-deletion dialog (390 px light, 240 px dark).
  - No sideways scrolling at 240, 320, 390, 768, 1024 or 1440 px on those routes.
- **Security review.** http_security_engineer gave D1, D2 and D3 CLEAR after several rounds. It was a source review, not a penetration test. See the [security review record](../verification/INCREMENT_09_SECURITY_REVIEW.md).

<!-- ADDENDUM-PENDING-LEAD: automatic clean-up sweep and customer-side checks. /root sends the wording; insert it here unchanged. -->
> **Addendum (pending from /root):** automatic clean-up sweep and customer-side checks.

**Reported by owners, not re-run individually by the lead.** These test files are part of the lead's full vitest run above, but the lead did not exercise them one by one.
- **Cross-module journey.** `tests/integration/journey-trash.test.ts` (ede33a1, 14c63ab) covers Trash isolation, the lifecycle and scheduled retention across modules. Every Trash capability is probed against a customer and a staff member who completed the two-step check.
- **Participants.** Each module that owns data registers a trash participant and tests its own purge. Since 700ff9c this includes a test that a lost purge fence (`PURGE_FENCE_LOST`) leaves data unchanged. The modules are: identity, orders, files and storage, compliance, billing profile, payments, integrations, SharePoint, engagement, community, knowledge, public API, promotions, referrals, automations, cart, portable, assurance and platform.
- **Platform** (platform_engineer's own runs):
  - `consent.test.ts` 14/14, including the fence case;
  - `settingFields.test.ts` 8/8, `router.example.test.ts` 7/7 and `configTransfer.example.test.ts` 9/9, which cover owner-managed settings: the generic write and configuration import refuse the trash retention keys;
  - `module.example.test.ts` 10/10.
- **QA scaffold.** `QA_SUITE=increment-09` (7774033, e5fe15e, 5fb8c3b, 2457541; portable_ops_engineer) holds the Trash and contact-link routes and fixtures for named-state checks at narrow and wide widths.
- **Go-live checklist.** 47 new rows, 210 IDs in total (8f4155a; assurance_engineer), to be run on the owner's server.

**Not verified by anyone:**
- real mail clients (Outlook, Gmail, Apple Mail), and therefore clickable anchors in a delivered message;
- real storage providers and real payment providers;
- Windows forced colours and screen readers;
- browsers other than Chromium;
- a real backup and restore after a permanent deletion;
- install or upgrade with migration 0009 on the owner's server.

## Accepted risks and known gaps (increment 09)

Each item is a limit of what was built, recorded by /root, not a defect that blocks release.

1. **Share image path.** The share image path in `index.html` is relative. Some link-preview services need an absolute URL. The portal is `noindex` and sign-in only.
2. **Mail links need HTTPS.** Links in e-mail become clickable only when the portal address is HTTPS.
3. **Old password resets.** Password-reset requests queued before the upgrade are refused. Users request a new one.
4. **Old queued mail.** Queued mail from before the upgrade that has no customer binding may be suppressed after that customer is deleted permanently. The portal does not send what it cannot check.
5. **No manual clean-up retry.** A manual retry of the retention clean-up job is refused. The job runs on its hourly schedule, and failed items are retried from the Trash centre.
6. **Unreachable storage copies.** These stop a permanent deletion until an administrator chooses "Finish and leave N external copies in place" (two-step check, typed order number, audited).
7. **What permanent deletion does not reach.** Backups, SIEM copies, delivered mail, Stripe objects and SharePoint folders. Backups keep deleted data until they expire, and a restore brings deleted items back ([BACKUP_AND_RESTORE.md](../operations/BACKUP_AND_RESTORE.md)).
8. **No legal hold inside the Trash centre** (lead ruling). To hold a trashed order, restore it, then place the hold. The clean-up job still skips a held row in the trash.

## Increment 08

Owner's prompt 34 of 2026-11-26 ([session log](../session-logs/2026-11-26-session-02.md), [contract](../engineering/INCREMENT_08_CONTRACT.md)). Migration `0008_increment_08`, additive only.

| Decision | What | Owner | State |
| --- | --- | --- | --- |
| D1 | First, last and preferred name | identity_engineer | implemented; verified by the lead on QA (8d73893, a6cc951, 1f96d68) |
| D2 | Order numbers `RP-<C4>-<F3><L3>-<P6>-<NNN>` | orders_engineer | implemented; verified by the lead on QA (acdd2ac) |
| D3 | Add packets to an earlier order (order group) | orders_engineer, recovery_ops_engineer | implemented; verified by the lead on QA (acdd2ac, 35df3ed, 88a3e90, b332d1b, 331a3e4, 3f8bcf3, 76e767f) |
| D4 | Saved billing profile; choice at checkout | compliance_engineer, recovery_ops_engineer, identity_engineer | implemented; verified by the lead on QA (faab6fe, dfcc89a, 8d73893, 35df3ed, 331a3e4, 56b222a, b7ae064, 472ca21) |
| D5 | Payment booked by webhook or provider lookup; missing-webhook alert | integrations_engineer | implemented; settings and admin check seen on QA, paid path covered by tests only (4331010, b4962ee, 07883a2, 62e0ddc, 4c5a1a3, 868cab4, 0630885) |
| D6 | Customer order wizard | audit_engineer | implemented; verified by the lead on QA (f12afdc, a2450b9, 4d0914f, 80cc19d) |
| D7 | Workflow **Publish** button; tier expansion | ui_foundation_engineer | implemented; verified by the lead on QA (09654b4, b332d1b) |
| D8 | Go-live checklist; documents | assurance_engineer, platform_engineer | checklist written, to be run on the owner's server (8b5e70c, c0349d6, 48d1ead, 531db76, bc6ee9b; QA scenarios f9c95cd); documents fc2654d–df0c0d7 and this update |

### Verification for increment 08

Branch HEAD `76e767f`. PR #23, merge commit `1587d11` on `main`, 2026-11-26; the four workflows (ci, security, container, native-install) passed on `85a8184`, including the full test suite.

**Verified by the lead** on a running QA build of the branch, in Chromium, with synthetic data in pay-by-invoice mode. Migration 0008 was applied to a copy of the QA database, which then reported 9 migrations.
- **Registration and home page (D1, D4).** Registration shows **First name**, **Last name**, **Preferred name (optional)** and a collapsed optional billing section. Submitting it empty shows an error summary and moves focus to it. The home page greets the customer by preferred name, or by first name.
- **Tiers (D7).** Choosing a tier expands its outcome and deliverables and collapses the others. "Not included" collapses them all.
- **Billing at checkout (D4).**
  - Without a saved profile, checkout shows the billing form with **Save as my billing information**.
  - With one, it offers **Use my saved billing information** or **Enter different billing information**.
  - `/account/billing` shows, edits and clears the profile.
- **Order numbers and add-ons (D2, D3).**
  - A synthetic customer's new order got a reference of the form `RP-<C4>-<F3><L3>-ICEQUE-001`.
  - Adding packet 2 to the same project created `…-002`, a linked order with its own invoice.
  - The order page lists **Orders in this project**.
  - A packet already in the project is refused with 409 and "A selected packet is already part of this project".
- **Wizard (D6).**
  - The customer order page opens on the wizard: a progress stepper and the current phase with **Back** and **Next**. Focus moves to each step heading.
  - The steps were Review and accept, Upload documents, Record or upload audio, then Review and submit. Questions appears only when the phase has questions.
  - An order waiting for payment shows "Waiting for your payment" with **Pay now** as the main button.
  - Orders in the old format get wizard steps too. With an agreement still pending, they show only "Accept the agreement above to continue."
- **Publish (D7).**
  - `/admin/workflows` has **Publish** in the designer header on every step and a "Publish draft <name>" row action.
  - The dialog offers the default-workflow choice and a change note, then shows a success dialog, and focus returns to the page.
  - The published workflow appears as version 1.
- **Payment setup (D5).** `/admin/payments/setup` shows the endpoint URL, the 9 required events, the last verified webhook, the last self-test, rejections in the last 24 hours and the three usual causes. The admin invoice page shows **Check with Stripe now**.
- **Accessibility.** The axe-core WCAG 2.0, 2.1 and 2.2 A and AA rules found no violations in light and dark themes on 19 changed pages. Those pages showed no horizontal overflow at 240–1440 px, after one fix in 76e767f.
- **Tests.**
  - The lead ran the full vitest suite at 0630885: 242 files, 3,137 passed, 2 failed, 4 todo. Both failures were gaps in the tests themselves, fixed in 76e767f and re-run green individually:
    - `tests/integration/isolation.test.ts` now has cross-customer probes for the new procedures. Customer B gets 404 or null for A's orders, cart target and payment attempt, and 409 for A's billing-profile token. A's data stays unchanged.
    - `adminOrdersPhase.test.tsx`: the reference link now wraps.
  - The type check and eslint over the whole repository were clean at 0630885 plus the lead's changes.
  - gitleaks v8.30.1 over the full history found no leaks.
  - The final full-suite pass is the CI run on the PR.

**Reported by owners, not re-run by the lead individually.**
- **Tests:**
  - paymentConfirmationD5 12/12, payments 11/11, stripeCompletion.e2e 5/5, refunds 8/8, PaymentReturnConfirmation 9/9;
  - cartIncrement08 6/6 (with a forced InnoDB REPEATABLE READ overlap), cart 8/8, CheckoutPages 34/34;
  - billingProfile server 6/6 and client 10/10, receiptsAndSmallTotals 7/7, complianceAdmin 20/20;
  - customerWizard 14/14, wizard 36/36.
- **Security review.** http_security_engineer cleared the D4 and D5 findings at 0630885 by source review.

**Not verified:**
- a real Stripe payment. QA keys are synthetic, so the paid path, return-page confirmation, reconciliation job and admin check are covered only by tests against a fake Stripe;
- the owner's server and its Stripe endpoint;
- real mail, Entra, SharePoint and the production receiver;
- a Docker or VPS upgrade with migration 0008 on real data;
- screen readers, physical devices, and browsers other than Chromium;
- webhook, customer check and worker all overlapping under real row locks. The tests start concurrent calls but do not force the locks to overlap.

## Accepted risks and known gaps (increment 08)

Accepted by /root for this increment. Each item is a limit of what was built, not a defect that blocks release.

1. **Webhooks on cancelled attempts.** A verified signed "paid" webhook can still book a payment on a cancelled or expired attempt, which is the historical recovery behaviour. A lookup alone never does: it raises `PAID_ON_CANCELLED_ATTEMPT` and waits for an administrator's step-up **Check with Stripe now**.
2. **Per-process cool-down.** The cool-down on a customer repeatedly checking a cancelled attempt is kept per server process, not shared between processes.
3. **Old Stripe sessions.** Stripe sessions created before increment 07.2 lack the three metadata IDs. A lookup does not book them automatically, so they need manual review.
4. **Registration timing.** The timing or outcome of a registration can reveal whether the billing store is unavailable.
5. **Zero-width characters in names.** Existed before increment 08. A name containing ZWJ or ZWNJ passes name validation, but the typed-signature validator rejects these characters, so typed signatures can mismatch the account name.
6. **Fast replay of order creation.** Existed before increment 08. A fast idempotent replay of order creation does not re-check the actor after waiting.
7. **No export or erasure.** There is no self-service account export or erasure, including of saved billing details. An administrator handles privacy requests, and a customer can clear their own saved billing information under **Account → Billing information**.
8. **Name fragments in order references.** This is by the owner's requirement. References appear wherever they already appeared: e-mails, invoices, audit events and their export. See the [threat model](../security/THREAT_MODEL.md).
9. **Shared counters.** Orders of different projects that share the same reference stem (the same customer and the same first six project characters) share one counter.
10. **Square** is still booked only from webhooks. There is no provider lookup or administrator check for it.

## Verification for increment 07.2

Fix pack for the owner's prompt 30 of 2026-11-26 ([session log](../session-logs/2026-11-26-session-01.md)). Code commits: `1be1cc2`, `4fb93be`, `8a9901b`, `fdd5583`, `c082b4e`, `8d20507`, `53786b0`, `c90b183` (Pay now hidden on the placed-order page when online payment is unavailable), `47872b8` (a passing probe is required for new Stripe activations; servers already active stay active), `c565487` (the compliance test helper runs the probe before activation), `dd5ddfa` (isolation test: online payment off means `ONLINE_PAYMENT_DISABLED`), `0cb03fa` (long reason codes wrap at 240 px; the disabled Activate button has `aria-describedby`). Nothing under `migrations/` changed (checked with `git diff main..HEAD --stat -- migrations`), and the upgrade commands are unchanged.

### What changed

| Owner point | Change | Where |
| --- | --- | --- |
| 1. Update message | Explains that the server was updated and this tab runs the previous version. **Later** re-shows it on the next in-app navigation, and it never reloads by itself | `client/src/app/PwaUpdatePrompt.tsx` |
| 2. No redirect to Stripe | Typed `payment_unavailable` after the order commits; the browser allowlist matches the server's; the return and cancel pages tell awaiting payment from pending confirmation, with **Pay now**; classified session failures, `payments.attempt.failed`, the alert "Customers cannot reach Stripe Checkout", the ACTIVE / NOT ACTIVE banner, **Last checkout-session failure**, and **Verify Checkout session creation** | `server/modules/{cart,payments}`, `/admin/payments/setup` |
| 3. Branding, order and project | Branded PDFs with an Order + Project block; pages, lists and e-mails; WinAnsi fix; invoices drawn on demand; stored receipts keep their bytes | `server/modules/compliance`, `/admin/invoices` → **Company profile**, `/admin/payments` → **Receipt footer note** |
| 4. Signing secret format | Paste normalisation, per-field shape errors, show/hide, no autofill, hints; Primary and Secondary explained | `client/src/features/payments`, `server/modules/payments/settings.ts` |
| 5. Default workflow | **Set as default** with step-up and the audit event `workflow.default.changed`; existing orders keep their version | `/admin/workflows`, `orders.admin.workflows.setDefault` |

### Root cause of point 2

**Not confirmed.** There was no access to the owner's server logs, and a real Stripe account cannot be tested here. On the owner's server, the banner and **Last checkout-session failure** on `/admin/payments/setup` should now name the cause.

### Verified by the lead

The lead ran these checks in Chromium only, on a running production build of `fix/increment-07-2` on the QA instance. The Stripe keys were placeholders in the test format, which Stripe does not accept.

- **Stripe setup** (`/admin/payments/setup`):
  - the banner read "Online card checkout: NOT ACTIVE (Pay by invoice)", with the missing readiness gates;
  - the checklist has 8 steps;
  - **Activate Stripe Checkout** stays blocked until the API test, the Checkout session probe and the webhook self-test pass.
- **Credential fields.** Each field showed its own error, with focus moved to the first invalid field, for these pastes:
  - a publishable key in a secret field;
  - an API key in the signing-secret field;
  - a signing secret in the API-key field;
  - an endpoint ID (`we_…`);
  - a value without the `whsec_` prefix.

  The note for a Secondary-only entry and the Show/Hide buttons worked.
- **Verify Checkout session creation** ran against the real Stripe API from QA with the placeholder key.
  - Stripe answered HTTP 401, and the page showed "Stripe rejected the staged secret key (HTTP 401)…".
  - The gate changed to "Checkout session creation check failed (STRIPE_AUTH_INVALID_KEY)".
- **Simulated "Stripe selected but verification stale".** The provider was set directly in the QA database and restored afterwards.
  - **Customer checkout** showed "Your order … is placed, but we could not open the secure payment page", with focus on the message and the order and invoice references. Nothing was resubmitted, and there was no **Pay now** button while online payment was unavailable.
  - **`/checkout/return`** showed "Payment not completed yet — your order is placed and waiting for payment".
  - **Admin side:**
    - the banner read "NOT ACTIVE (paused pending verification)";
    - **Last checkout-session failure** showed the diagnostics, with reason `PROVIDER_VERIFICATION_STALE`;
    - `/admin/alerts` showed an alert with the next step;
    - the audit events `payments.attempt.failed` and `cart.checkout_payment_start_failed` were recorded.
- **PDFs.** An invoice PDF and a newly issued receipt PDF were opened and inspected.
  - They showed the logo, the brand colour band, the legal name, the tagline, the Order and Project block, and a footer with page numbers.
  - "·" renders correctly, and the PDF title is set and the document tagged.
  - A receipt issued before 07.2 keeps its original stored PDF, while its page shows Order and Project.
  - The invoice list, the invoice page and the receipt page show Order and Project, for both customers and admins.
- **Workflows** (`/admin/workflows`):
  - the default summary line, and **Set as default** on published workflows that are not the default;
  - the confirmation dialog's wording, and **Cancel** returns focus to the button;
  - confirming, after step-up, moved the Default badge, showed the success message and moved focus to the summary;
  - `workflow.default.changed` was recorded.
- **App update prompt**, with a service worker holding a waiting version:
  - the new title and body appear, above the phone tab bar at 390 px;
  - **Later** and **Reload** are 44 px high;
  - **Later** hides the prompt, and it returns on the next in-app navigation;
  - **Reload** loads the new version and keeps the session.
- **axe-core and overflow.** axe-core (WCAG 2.0, 2.1 and 2.2 A and AA rule tags) reported 0 violations in light and dark. There was no horizontal overflow at 240, 320, 390, 768, 1024 and 1440 px. The pages checked were:
  - `/admin/payments/setup`, including the failed-probe state;
  - `/admin/payments`, `/admin/workflows`, `/admin/alerts`, `/admin/invoices` and an admin invoice page;
  - `/checkout/return`, `/checkout/cancel` and `/cart`;
  - `/invoices`, a customer invoice page and a receipt page.
- **Tests.** The lead ran vitest for payments, cart, integrations, automations phase actions, `tests/http` and `tests/integration`.
  - One failure was found, in the isolation test.
  - It was fixed in `dd5ddfa`, and the re-run passed.

### Peer-reported (engineers' own runs, not re-run individually by the lead)

- **Payments:**
  - payments server 11/11;
  - refunds 8/8;
  - stripeCompletion e2e 5/5;
  - client payments 22/22, and OrderRefundTab 12/12.
- **Cart and checkout:** cart 8/8; CheckoutPages 30/30.
- **Compliance:** compliance folder 128/128 (10 files).
- **Workflows:** workflowDefault 8/8; workflows page 28/28.
- **Other client:** PwaUpdatePrompt 3/3.
- **Jobs and mail:** jobs 59; mail templates 6.
- **Static checks:** type check and eslint clean on the folders touched.

### Gates

- **Full test suite:** run by the lead at `0cb03fa`: 234 test files, 2,991 tests passed, 4 todo; type check and eslint clean. The jobs folder (60 tests) was re-run after `568a45f`.
- **CI:** on PR #21 the first run failed the security workflow twice over: gitleaks flagged a synthetic `productKey` fixture in `workflowDefault.test.ts` (reviewed, baselined in `06aa20c`), and CodeQL flagged a single-pass tag strip used only for comparison in `server/modules/jobs/mail.ts` (replaced by a linear scanner in `568a45f`, no baseline exception). The ci, security, container and native-install workflows then passed on `568a45f`.

### Not verified

- **Real Stripe.** A successful redirect to Stripe Checkout and a paid webhook round trip with real keys, because there is no valid Stripe account here.
- **Restricted-key error.** The HTTP 403 path against real Stripe; only unit tests with fakes cover it.
- **The owner's server.** The root cause there, because we have no access to its logs. The build now records the cause and shows it.
- **Mail.** The invoice and receipt e-mails in a real mail client.
- **Refund notes.** The refund note PDF, visually.
- **Screen reader on the Activate button.** The `aria-describedby` on the disabled **Activate Stripe Checkout** button, with a screen reader.
- **Other platforms.** Any screen reader, physical device or non-Chromium browser pass.

The interfaces are designed and tested against WCAG 2.2 AA. This is not a certification or conformance claim, and PDF/UA is not claimed.

## Verification for increment 07.1

Fix pack for the owner's prompts 28 and 29 of 2026-11-25 ([session log](../session-logs/2026-11-25-session-01.md)). Mostly client-side. The one server change is the single-page app fallback for dotted mail template keys (`916f52a`). There is no server permission, schema or migration change, and the upgrade commands are unchanged. PR #19, merged to `main` as `547a31d`.

### What changed

- **Portal separation rule (unchanged on the server).** Staff and administrator accounts cannot own orders or carts. This is kept as zero-trust separation between the customer and staff roles.
  - On older builds, an administrator in the customer portal saw "You do not have permission to perform this action" on step 3 of `/orders/new` and on `/cart`.
  - Now `/orders/new`, `/cart`, `/cart/checkout`, `/checkout/return` and `/checkout/cancel` show staff the panel "Orders are placed for a customer", with **New order for a customer**. That button goes to `/admin/orders?new=1`, which opens the console dialog. Focus moves into the dialog, and closing it removes `?new=1` and returns focus. The dialog accepts a discount code.
  - No cart requests are made for staff. The customer navigation hides **Create an order** and **Cart** from non-customers.
- **Portal switch.**
  - In the console, **Customer portal** is in the top bar (medium screens and up) and the drawer.
  - In the customer shell, **Admin portal** (administrators) or **Staff portal** (staff) is in the top bar (medium screens and up) and the drawer, and in a staff notice that cannot be dismissed: "You are viewing the customer portal as {role}. Orders, carts and checkout belong to customer accounts."
  - Staff and administrators opening `/` land on `/admin`, unless this browser tab chose the customer portal (stored in `sessionStorage`). Switching back, signing out or clearing the client caches removes the choice.
  - Customers never see the switch.
- **Discount codes.** The field needs two things switched on: **Discount codes** at `/admin/promotions` (`feature.promotions`, off when shipped) and **Cart** at `/admin/settings/features` (`feature.cart`).
  - With both on, the field is in the cart summary once the cart has an item, and at checkout.
  - An empty cart shows "Have a discount code? Add an item first to apply it here or at checkout." The order form's Review step shows "Have a discount code? You can enter it in your cart and at checkout."
  - With the cart off, the code field stays on the order form's Review step (the direct order path).
- **Navigation rails.** Both rails have a thin themed scrollbar, with a forced-colours fallback.
- **QA tools.** `scripts/qa` has an opt-in context-reuse mode and deferred retries. It also has fixtures for staff in the customer portal and for forms ([scripts/qa/README.md](../../scripts/qa/README.md)).
- **Shell, layout, accessibility and server fixes from the sweep.** These are listed under Sweep results below.

### Sweep results

All runs used Chromium with synthetic QA data, against QA builds of `fix/increment-07-1`. The QA sweep runner reported the numbers, and the lead spot-checked them in a browser. During the sweep, the QA rate budgets were raised temporarily and then restored. That applied to the QA environment only and is not a product change.

**Full responsive matrix (first fix build).**
- 3,712 cases were scheduled: 232 route and role states × 8 widths (240, 320, 390, 768, 1024, 1440, 1920, 2560 px) × light and dark.
- 3,656 passed, 24 failed, and 32 were not checked at that point.
- The 24 failures were 12 distinct route states, and all but two failed only at 240 px. Two were within the WCAG reflow scope:
  - **Graph & SharePoint** overflowed by 8 px at 320 px;
  - the cart suggestion "Add-on" badge clipped at 1024 px.

**axe (WCAG 2.2 A and AA plus best practice), at 1280, 640 and 320 px in both themes.**
- 1,392 cases were scheduled. 1,351 passed, 33 had violations, 2 failed reflow (the Graph page), and 6 were not checked.
- The 33 cases with violations were:
  - 30 `region`, from the new staff notice;
  - 2 `aria-prohibited-attr`, on the SharePoint order sync loading state;
  - 1 intermittent `target-size`, on the workflow version canvas.
- 712 cases had axe "incomplete" items that need human judgement: 704 colour contrast, 18 heading order and 6 `aria-hidden-focus`, and one case can have more than one. These items were not reviewed one by one.

**Fixes made after the first build.**
- **Notices and the switch** (`92d3c3b`, `cf39e10`):
  - the staff, preview and maintenance notices are now named complementary landmarks, which clears the `region` cases;
  - the portal switch is first in both mobile drawers;
  - the phone tab bar labels are Home / Orders / New order / Messages / More;
  - the staff notice shows its switch button only below medium width.
- **Layout fixes at narrow widths:**
  - the progress bar on the customer `/orders` list (`6856d8b`);
  - the cart suggestion card, which now wraps so the "Add-on" badge no longer clips at 1024 px (`6afac07`);
  - the policy acceptances log, the coverage tab and the customer Policies tab (`e0aeb58`, `42f0fac`);
  - Graph & SharePoint, where the long URL now wraps and the 8 px overflow at 320 px is gone, and the production pipeline (`7cef9cb`);
  - the custom report builder's query-mode control (`21a1e30`);
  - the shared DataTable phone cards, which cap the label column at 40% and stack below 320 px (`3178353`);
  - the mail template sensitive-variable badge, which wraps below 320 px (`b6bd3cf`).
- **Accessible names:** prohibited accessible names were removed in 8 files, with a source guard test (`6e215e6`).
- **Canvas zoom:** the flow canvas fit zoom floor went from 0.75 to 0.8, so step and transition targets stay above 24 px (`389dfa6`).
- **Server:** a full page load, reload or bookmark of a mail template editor whose key contains a dot (for example `/admin/email-templates/auth.password_reset`) returned 404 (`916f52a`, `d9f9c50`).
  - The single-page app now serves its page for registered built-in keys and `custom.<slug>` keys only.
  - Other dotted or extension paths, and dotfiles, still return 404.

**Confirmation runs on later builds.**
- **Responsive:** 384 cases over 24 states, covering every route with a finding, DataTable samples, the order form's Review step with the hint, and an administrator inside the customer shell. All passed except the mail badge clip at 240 px, which was fixed afterwards in `b6bd3cf`.
- **Mail editor confirmation** (on the build with `b6bd3cf`): responsive 16 of 16 passed, including 240 px in both themes. axe 6 of 6 with no violations, and 2 colour-contrast incompletes.
- **Outcome:** after the fixes, there is no known open responsive or axe failure in the set of routes that was checked. The NOT CHECKED routes below are outside that set.
- **axe:** 144 of 144 with no violations, and all 30 `region` cases cleared. On the final build, 54 of 54 with no violations and no `aria-prohibited-attr`.
- **Workflow canvas:** 15 transition targets, the shortest 25.6 px, with no violation in 3 runs per theme.

**Manual keyboard and zoom pass.**
- 32 of 32 samples: the skip link reaches the main content, with no overflow.
- Order form step headings receive focus: 4 of 4.
- Dialog focus stays inside, and Escape returns focus:
  - 4 of 4 when opened with a button;
  - 4 of 4 from `/admin/orders?new=1`, including clearing the address parameter.
- Native browser zoom at 200% and 400% on eight routes: 16 of 16 with no overflow.

**Lead browser checks.**
- The portal switch both ways, the landing rule and the handoff pages.
- The `?new=1` dialog.
- The customer cart and checkout discount field.
- The empty-cart hint at 240, 320 and 768 px in both themes.
- Every route with a finding, measured again after the fixes.
- A dotted template deep link returned 200, while `/missing.png`, `/.env`, `/foo.php` and `/admin/email-templates/x.png` still return 404.

**NOT CHECKED (16 route states without a fixture).**
- **Need a live token or callback:** `/reset-password`, `/activate`, `/verify-email`, `/sso/complete`.
- **Need a mid-sign-in session:** `/mfa/enrol`, `/mfa/recovery-codes`, `/change-password`, `/accept-policy`.
- **No seeded resource:** `/admin/siem/:id` and its `/edit`, `/admin/automations/:automationId` and its `/edit`, `/admin/storage/:publicId/edit`.
- **No operation record:** `/admin/portable/import/:importId`, `/admin/backups/:backupId`, `/admin/api/log/:requestId`.
- **Also not measured:** the order Messages tab with an attachment.

### Limits

- **Browsers:** Chromium only. No Safari or Firefox run was done.
- **Devices:** no physical phones or tablets were used.
- **Screen readers:** no pass with NVDA, JAWS, VoiceOver or TalkBack was done.
- **axe incompletes:** the items flagged as incomplete, mainly colour contrast, were not reviewed by hand.
- **No conformance claim:** this is not a legal or ADA conformance claim. The interfaces are designed and tested against WCAG 2.2 AA.

## Verification for increment 07

The lead's QA of 2026-11-25 (QA 5044), on a production build against MySQL in a real Chromium browser, with synthetic data. The three groups below are kept apart on purpose.

### Verified by the lead in a browser

- **SAML:** round trips against a local fake IdP in all three MFA modes (`claim`, `entra`, `portal`).
- **Phase lifecycle**, as administrator and customer:
  - Next, and Submit and lock with acknowledgement;
  - review accept and changes requested;
  - reopen with a reason;
  - the guards answering 409.
- **Progress bar:** values including weights, and the recalculation at boot. The boot run finished about 200 ms after the server started listening.
- **Phase action bundles:**
  - preview and confirm;
  - a fixed completion, and a delayed range completion that survived a restart;
  - the e-mail queued and the alert created;
  - the P201 skip reason, the run summary toast and the counts.
- **Alerts:** acknowledge and resolve on `/admin/alerts`.
- **Status catalogue:** add and retire.
- **Stripe:**
  - the setup page gates;
  - a fake-key API test failing gracefully with 401;
  - a signed webhook end to end, with a locally signed event;
  - the rejection log.
- **Customer uploads in a phase:**
  - a PDF accepted and a disguised file refused;
  - WAV to a WebM copy;
  - the allowance countdown.
- **Downloads:** a single download, audio playback with a 206 range answer, phase ZIP as customer and as staff, and a whole-order ZIP behind step-up.
- **Webhooks:** a subscription test delivery, the delivery detail, and Retry (attempt count 2).
- **Lifecycle auto-queue:** P101 queued after a recorded manual payment. The dispatch reached `https://example.com` and got 405, which proves the transport, not the receiver.
- **Integrations hub:** every link answered 200.

### Peer-reported (automated tests, not driven by the lead in a browser)

- SharePoint / OneDrive managed file sync against mocked Graph;
- the Graph `Sites.Selected` write check;
- redelivery records;
- stop controls;
- inbound endpoints;
- delayed completion of up to 30 days;
- rule ordering, enabling and deleting;
- clarification question versioning;
- receipts to Microsoft 365.

### Not verifiable in this environment

- a real Stripe account (live or test-mode keys);
- a real Microsoft Entra tenant;
- a real SharePoint site;
- the owner's production P101 / P201 receiver;
- the Docker image build;
- a reverse proxy with TLS on the VPS;
- real SMTP.

### Gates

- **Full vitest at `7c6bb71`:** 229 files, with 2,894 tests passed, 1 flaky client test (being fixed) and 4 todo.
- **Final gates** on `fa9780a` (`54c6f26` plus a gitleaks baseline commit): full vitest 229 files, 2,896 passed, 4 todo, 0 failed; type check clean; `eslint . --max-warnings 0` clean; `pnpm audit --prod` reported no known vulnerabilities; gitleaks found no leaks (five reviewed synthetic fixtures were added to `.gitleaksignore` in `fa9780a`). The branch is on [PR #16](https://github.com/MadaSito/ReadyPacketsCustomerPortal/pull/16), to be merged with a merge commit once the four workflows (ci, security, container, native-install) pass; CI results live on the PR.
- **Since the QA pass:** `54c6f26` shows production dispatches as "Failed" or "Failed (retrying)" with the next attempt time, uses readable trigger labels and adds a "Switched off" badge on the integrations hub; `fd20503` makes the pending-upload guard use layout effects. ui_foundation's sweep on `7c6bb71` found no axe violations and no overflow at 320, 768 and 1280 px in both themes on all changed pages, with reduced motion honoured and one polite announcement per progress change; the Stripe activation confirm dialog and the run-summary callout were not swept. No screen-reader or physical-phone pass was done.
- **Merge record (2026-11-25):** on PR #16 the ci, container and native-install workflows passed on `194979a`; the security workflow failed its CodeQL gate with five findings at or above severity 7.0. `ec9837b` resolved them:
  - the SAML multi-factor claim check now tests exact membership of the claim value instead of `Array.includes` on a URL-shaped constant (no behaviour change);
  - the Graph write-check test compares the parsed hostname instead of a URL substring;
  - the QA-only fake identity provider (`scripts/qa/saml-fake-idp.ts`) now requires an explicit private `--state` directory and creates its key files exclusively, instead of defaulting to a shared temporary folder;
  - the audio playback grant cookie was added to `.github/codeql-baseline.json` with a reviewed justification (an opaque random grant token, hashed server-side, HttpOnly, SameSite=Strict, path-scoped; not stored personal or credential data).

  All four workflows then passed on `ec9837b`, and PR #16 was merged to `main` with merge commit `c337492`. The sandbox preview was rebuilt from `ec9837b` on a database migrated to 0007 and smoke-checked in a browser as a customer and as an administrator (every new administration page loads). The preview administrator account was still on a temporary password from an earlier recovery test; it was moved to a new password through the normal forced-change flow.

## Verified for increment 06 (integrator's own runs)

The lead checked these live in a real Chromium browser, against a QA build with strict CSP and synthetic data, on 2026-11-23.

- **D1 side panel:** the customer side panel is navy.
- **D2 recording:**
  - preflight, then record, pause, stop, review and upload (`recording.webm`);
  - an `.m4a` upload produced a WebM/Opus derivative, with the original kept.
- **D3 cart suggestions:** the seeded suggestions are all inactive, with the per-row Enable, Enable all and the master switch.
- **D4 PWA:** the manifest, `sw.js`, the offline page and the Apple meta tags are served, with `Permissions-Policy: microphone=(self)`.
- **D5 discount limits:**
  - the Limits card;
  - codes at 99.99 %, at 100 %, and `set_total` at 0 and at 1 cent;
  - a $0.00 checkout places a Paid order;
  - a $0.01 order becomes a one-cent invoice when no payment provider is enabled.
- **D6 reports:** the 8 built-in reports, the Orders report with CSV export, and the custom builder loading 12 datasets.
- **D7 protection:** the bans, rate-limit and incident pages render. Ban and back-off behaviour is covered by automated tests only, because loopback is exempt in QA.
- **D8 phase tasks:** customer tasks with type restrictions.
- **D9 Word editing:** a customer uploaded a `.docx`, edited it in the portal editor and saved it as v2, with the original kept. Headings, a list and a table were preserved.
- **D10 workflow transfer:** the Import, Export selected and Export all controls.
- **D11 name check:** a mismatched name was refused with the expected-name message, and a case-insensitive match was accepted.
- **D12 policy import and notices:**
  - `.docx`, `.md` and `.pdf` were imported into a draft;
  - publishing scheduled a notice with a countdown;
  - "Send now" queued it.
- **D13 enforcement:** with 0 h grace, the next sign-in landed on `/accept-policy`, and every other API call was refused until the policy was accepted.
- **D14 order agreement:** working on an order went upload → agreement dialog → typed name → upload resumed automatically.
- **D15 receipts:** receipts `RPR-2026-000001` and `-000002` with a branded PDF, the portal Receipts tab, and the receipt e-mail queued.
- **Gates (lead's own run, quiet machine):** type check clean, lint clean (zero warnings), full suite 203 of 203 files and 2,599 tests passed (4 todo) at `8243000`, `pnpm audit --prod` clean, gitleaks clean at `84f7379`. PR #13. The merge commit is the PR #13 merge on `main` (see `git log --merges main`).

Defects found in lead QA and fixed before merge:

- **Receipts deep link:** fixed to `/invoices?tab=receipts` (`36a486e`).
- **Checkout dead end:** checkout stopped when the gate policy used a typed name (recovery_ops_engineer, `8243000`; rechecked live by the lead: one inline typed-name field, mismatch message beside it, order placed).
- **Tick box shown for a typed-name gate:** `/accept-policy` and the policy prompt showed only a tick box when the gate required a typed name, so the customer could not accept (compliance_engineer, `672e900`; UI feedback `7a39164` and `4810201`; rechecked live by the lead).
- **Prompt re-opening:** the policy prompt re-opened on every navigation after "Later" (`39fb16e`).
- **Notice copy:** singular and plural in the notice dialog (`7a39164`).
- **CodeQL on PR #13:** two findings at or above the gate were fixed before merge: table-cell escaping in the document importer and a check-then-read race on the brand logo file (`a10cc50`, with an escape-aware table reader shared by the policy renderer and the Markdown importer). Policy links now also refuse backslash-prefixed paths (`d14a34c`). All four workflows (ci, security, container, native-install) passed at `d14a34c`.
- **After the merge (PR #14):** the `ci` run on `main` at `ee40772` failed on one client test (`CheckoutPages.test.tsx`, agreement retry at checkout). The agreement dialog enables its controls one animation frame after it opens and the test clicked without waiting, so it lost the race on a slower runner. The test now waits for the control (`2cd30fe`); no product code changed for it. The same PR moved the install-dismissed preference to a guarded storage helper (`410cae4`). All four workflows passed at `2cd30fe` before PR #14 was merged.
- **Test timeouts:** hardened (`0e63c94`, `4614c02`).
- **Layout and focus:** the PageHeader wrap and the install dialog focus (`751fccc`, `80af96e`).

## Not verified

- increment 07:
  - a real Stripe account, so Stripe completion was tested only with a locally signed event and a fake key;
  - a real Microsoft Entra tenant, so SAML was tested only against a local fake IdP;
  - a real SharePoint site, so file sync was tested only against mocked Graph;
  - the owner's production P101 / P201 receiver;
  - the Docker image build, a reverse proxy with TLS on the VPS, and real SMTP;
  - physical phones and a screen-reader pass over the phase wizard.
- increment 06:
  - no real Stripe or Square account, so the waive path for totals below the provider minimum is covered by tests only;
  - receipt e-mail delivery end to end (mail is not configured in QA);
  - physical Apple, Android and Windows devices, including Safari recording and PWA install;
  - automatic sign-in bans live (loopback is exempt in QA);
  - real Microsoft 365, Entra ID and cloud storage, and the real P101 / P201 receiver, remain untested as before.
- increment 03 against real services: nothing was sent to or received from a real Microsoft 365 / Entra ID
  tenant (Graph mail, SharePoint, OneDrive, sign-in completion), Amazon S3, Wasabi, Backblaze B2, Azure
  Blob, Dropbox or Google Drive. These are covered by tests against local protocol fakes only. A complete
  single sign-on round trip (code exchange, token validation, session) was not run in a browser.
- "View message" for a delivered e-mail and an off-site backup copy were not exercised in a browser (both
  need a working external service); they are covered by the module tests.
- the native upgrade on a real server. The runner check above uses a fresh machine, a self-signed
  certificate, one customer and one order, and the unattended `--yes` mode; the typed confirmations of the
  interactive mode and an installation older than `d964a3b` were not exercised.

- production webhooks against the real P101 / P201 endpoints: no HTTP request has been sent to the owner's
  receiver (synthetic P101 requests went to a public echo service and to the owner's webhook.site address
  on 2026-11-22, which proves the portal side only); TLS to the real host, receiver-side de-duplication across retries, and a full
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

- **Increment 08 known gaps:** see [Accepted risks and known gaps (increment 08)](#accepted-risks-and-known-gaps-increment-08).
- Increment 07 decisions the owner should confirm (ADRs 0055–0062):
  - the progress formula: weighted, capped at 99 until a `done` status, and the higher of derived and explicit;
  - publishing the prepared phases draft of the default workflow; running orders keep their version;
  - the 250-file, 500 MiB and 30-minute ZIP limits;
  - the nine Stripe events, and staff review of refunds made in the Stripe dashboard;
  - the MFA mode for SSO: upgraded configurations start in `portal`, and `entra` makes MFA depend entirely on the Entra tenant's policies.
  - **Not built:** document conversion profiles, two-way SharePoint sync, unattended status changes, IdP-initiated SAML, single logout, encrypted assertions, and Stripe Elements.
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
  - **Order rename.** Customers see a generic "Order renamed".
  - **File sync.** The default folder template is `customers/{customer_ref}/orders/{order_ref}/{phase}`.
  - **Protection.** Country blocking needs an operator-supplied MMDB, and the firewall starts in detect mode.
  - **Referrals.** The reward is account credit on the first paid invoice, with manual approval.
  - **Defaults.** The community forum is off by default. The consent ledger is kept 36 months.
  - **Accessibility.** Accessibility is a WCAG 2.2 AA target, not a certification.
- Increment 04 decisions confirmed by the owner on 2026-11-22:
  - **Redelivery and retry (confirmed in prompt 22).** Redelivery needs administrator step-up and the typed `REDELIVER`. A staff retry reuses the original Idempotency-Key and is refused when the destination has changed. An administrator re-send authorises the new destination, so duplicates across two different receivers are an operator risk. No code change was needed.
  - **Later phases.** Only P101 and P201 are called today, each through a webhook URL. Later phases may be built in the future; P301 / P401 stay optional and hidden until a URL is configured, and their payload `{customer_id, order_id, run_mode}` is a placeholder until a contract exists.
  - **Acceptance.** Staff are never gated, and cancelling an order is never blocked by a gate.
  - **Referrals.** A fully refunded first invoice sends the reward to manual review; it is not reversed automatically.
- Follow-ups (not blocking):
  - binding-set drift on a same-key automation replay;
  - Graph remote-file reuse is keyed on the QuickXor hash only;
  - no account-erasure path;
  - community search uses `LIKE`;
  - the Activity lane labels a recorded-only refund "Refund issued".
  - "Order history" shows the pipeline events as "Integration production dispatch requested / delivered";
  - the `dispatch.requested` audit event does not carry the dispatch correlation reference;
  - a referral reward is recorded as credited by an administrator; the portal does not apply it to an invoice by itself.
- Increment 05 assumptions awaiting owner confirmation (ADRs 0042–0045 are "Accepted (owner confirmation requested)"):
  - workflow imports are always drafts, and automations are not transferred;
  - when a code and the bundle discount both apply, the larger discount wins unless the code allows combining;
  - the global guard caps discounts at 50 % of the subtotal;
  - a redemption stays used after a refund. It is released only if nothing was paid, no invoice is payable and no provider payment attempt ever existed; anything else, including an error, keeps it used. To compensate a customer, the administrator issues a new code;
  - API v1 does not accept discount codes;
  - staff (not only administrators) can read the acceptance log.
- Increment 05 follow-ups are tracked in `docs/security/INCREMENT_05_REVIEW.md`.
- Increment 06 assumptions awaiting owner confirmation (listed in ADRs 0047–0054):
  - recording, editing, receipts, reports, the name check and automatic bans are on after upgrade; enforcement, the MNDA gate and cart suggestions are off;
  - amounts below the provider minimum are waived by default (`payments.small_totals`), and the owner may prefer `block`;
  - shared custom reports are visible to administrators only;
  - no legal text is shipped for the MNDA; the owner imports their own.
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
