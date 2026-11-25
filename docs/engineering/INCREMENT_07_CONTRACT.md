# Increment 07 — phases-first order workflow, statuses, progress, Stripe completion, SAML, Microsoft 365 file sync

Owner request (2026-11-24, prompt 26). In short:

1. Revamp the order workflow system around **named phases the customer sees**, with a **percentage** per order
   based on phase and actions, shown in a clean, professional, animated progress bar, and a **status system**
   that workflows call on and that the administrator can extend.
2. Three lists of "potential features, you choose what's best": phase jobs and outbound integrations (15),
   documents / audio / deliverables (10), customer stage workspaces (10).
3. Complete: the **Stripe payment webhook** so orders can be completed; **SAML 2.0 SSO for Microsoft Entra ID**
   (administrators sign in; no portal MFA for SSO users whose MFA is managed by Entra); **Microsoft 365 /
   SharePoint sync** so order files sync properly.

Eight screenshots of the owner's earlier editor are the reference for the administrator experience (kept
outside the repository). The gap analyses of eight owners decided what exists and what is new.

`BUILD_CONTRACT.md` and the contracts of increments 04–06 still govern everything (module shape, ownership
checks, audit, safe errors, step-up, idempotency, WCAG 2.2 AA in both themes, 320 px, strict inputs, public
ids only across the wire, no secrets or personal data in logs). This file adds only what increment 07 needs.

## 0. Working rules

- Branch `feat/increment-07` is checked out in the shared tree. Nobody switches branches or pushes.
- Commit only your own paths with `scripts/dev/commit.sh "<message>" <paths>`.
- Never build or start servers (only `/root` and ui_foundation_engineer do). Verify with the FULL type check
  (`scripts/dev/tc.sh`), `pnpm exec eslint <your paths> --max-warnings 0`, and your tests one file at a time
  (`scripts/dev/test.sh <file>`).
- `/root` generates `migrations/0007_increment_07.sql` once. **Additive only**: new tables, new nullable
  columns or columns with defaults, new indexes, enum widening. Declare tables in your module's `schema.ts`,
  then report "schema final" to `/root`. Do not run `drizzle-kit`. Data seeding and backfill run in code at
  start-up (idempotent), not in SQL.
- Capabilities already added by `/root` (`shared/capabilities.ts`, block "increment 07"): `orders.stage.run`
  (staff + admin, step-up), `orders.stage.review` (staff + admin), `orders.stage.reopen` (admin, step-up),
  `orders.questions.manage` (staff + admin), `orders.statuses.manage` (admin, step-up), `ops.alerts.read` and
  `ops.alerts.manage` (staff + admin), `files.archive.order` (admin, step-up).
- Further capabilities, dependencies, module mounts (`server/trpc/root.ts`, `server/container.ts`,
  `client/src/app/registry.ts`) and raw HTTP routes are added by `/root` (routes with http_security_engineer).
  Ask with the exact names.
- **Words.** The customer and the administrator read **"Phase"**. In code the new model is `stages` (the
  word `phases` is already taken by the status groupings of definition formats 1 and 2). One stage = one
  phase the customer sees.
- **Defaults.** What the owner asked for and is safe is ON after upgrade without configuration: phase
  stepper and progress bar on every order (derived for old workflow versions), status catalogue, phase
  editor, attention filters, range playback, phase ZIP, payment state on orders. OFF until configured,
  because it sends something outside or changes orders by itself: stage action bundles on a workflow (empty
  = nothing runs), unattended rules (as today), lifecycle auto-queue of P101 / P201, file sync targets,
  receipts to Microsoft 365, SAML, attention reminder alerts. Every switch sits on the page where the
  feature is used and is audited.
- **Existing orders are never re-pinned** and nothing fires retroactively on upgrade, publish or import.
- A change to a stored setting or definition shape must read old stored values (parse with defaults).
- Reports to `/root`: done / commits / not done / needs — at most 150 words. Publish interfaces in your
  module's `API.md`. Ask the owner of a file before touching it. Short messages between owners.

## 1. Decisions

### D1. Phases-first model (definition format 3) — orders_engineer

- A workflow version may carry `stages[]` (≤ 20). Each stage: `key` (stable), `customerLabel`, `staffLabel`,
  `statusKeys[]` (≥ 1, from the catalogue, D2), `actions { uploadDocuments, answerQuestions, recordAudio,
  uploadAudio, teamFileReview }`, `governance` (D8), `folders { documents, audio }` and `fileSync` (D12),
  `acknowledgement { policy: required | optional | none, message ≤ 2000 }`, `content { markdown ≤ 4000 }`,
  `progression: next | submit_lock`, `adminTasks[]` ⊆ { upload_team_document, assign_questions,
  review_submission, run_automation }, `stageActions` (D5), `completesOn: manual | payment` (D10),
  `weight` (1–100, default 1, for progress).
- Stages **compile onto the existing machinery** (requirement slots, `order_phase_locks`, gates). Formats 1
  and 2 stay valid and show **derived stages** (one per phase group, else one per status). No data migration.
- Runtime per order: `order_stage_progress` (state `open | submitted | in_review | accepted | reopened`,
  submission, acknowledgement evidence = policy + text hash + time + actor, review outcome, reopen reason).
- Customer procedures `orders.stages.{workspace, next, submit}`; staff `review`; administrator `reopen`
  (reason 10–500 characters, explicit confirmation, step-up). Working ahead is refused (`STAGE_NOT_OPEN`);
  completed stages stay readable. "Next" advances without locking; "Submit and lock" completes the stage and
  locks customer editing until an administrator reopens it.
- A status change made for a stage must be an allowed transition of the pinned version, or an audited
  administrator override. Nothing bypasses policy-acceptance or agreement gates.
- New installs are seeded with a published format-3 "ReadyPackets standard workflow" (Payment confirmed,
  Phase 1 intake, Phase 2 synthesis, Phase 3 review, Phase 4 delivery, Delivered, Closed). On upgrade the
  existing workflow is untouched; a format-3 **draft** of the standard workflow is prepared and
  `/admin/workflows` says so ("Phases version ready to review and publish").

### D2. Status catalogue — recovery_ops_engineer (in `server/modules/orders/statusCatalog*.ts` + admin page)

- Table `order_status_catalog`: `key` (immutable), `staffLabel`, `customerLabel`, `tone`, `category`
  (`start | working | waiting | done | canceled`), `attention` (`none | staff_review | customer_response`),
  position, retired, row version. Seeded at start-up from every status key in published versions plus the
  built-in ones.
- Page `/admin/workflows/statuses`: add, rename, reorder (buttons, not only drag), retire, restore. Retire
  is refused while a draft uses the status; orders already in it keep and display it.
- `orders.status_key` stays a string: reports, exports and P101 / P201 keep working. A key containing
  `cancel` must have category `canceled` and the reverse (integrations relies on it).
- Format-3 versions take labels and attention from the catalogue (a rename shows everywhere); formats 1 and
  2 keep their snapshot labels.
- Attention on orders (`orders.attention`, `attention_since`; orders_engineer writes them in the same
  transaction as every status or stage change): `/admin/orders` gets "Awaiting staff review" and "Awaiting
  customer response" filter chips with counts, and the pipeline widget shows both.

### D3. Progress — orders_engineer (calculation), ui_foundation_engineer (bar)

- Derived: weight of completed actionable stages ÷ weight of all actionable stages; a status of category
  `done` gives 100. Explicit: `orders.completion_percent` set by a stage action or a rule (D5).
- Shown = max(derived, explicit). It only goes down on an audited administrator reopen. A canceled order
  shows the last value, frozen, with the word "Canceled".
- Stored in `orders.progress_percent` and recalculated in the same transaction as transition, submit,
  review, reopen, waive and completion apply. Old orders are filled on first read.
- Shared component `OrderProgress`: `role="progressbar"` with `aria-valuenow / min / max` and
  `aria-valuetext` ("40 percent, phase 2 of 5: Intake"), the number as text, a phase stepper with customer
  labels, smooth fill and count-up, **no animation with reduced motion**, never colour alone, both themes,
  320 px. Used on the customer order page, the order list, the dashboard and the console.

### D4. Customer phase workspace — audit_engineer (client), assurance_engineer (questions, tasks, review)

- Customer order page becomes a guided wizard: progress, stepper, the current phase with its instructions
  (safe Markdown renderer only), the enabled actions (documents, questions, record, upload audio, team
  files) with remaining allowances, then "Next" or "Submit and lock" with the acknowledgement dialog.
- `order_questions` and append-only `order_question_answers` (staff ask per order and phase; the customer
  answers; every edit is a new version; bodies encrypted, ≤ 8000 characters, never logged).
- `order_admin_tasks`: the phase's administrator checklist ticks (who, when; untick audited).
- Console order page: a per-phase panel with submission, review (accept / changes requested + note),
  reopen, questions with answer history, the checklist, and "Run phase actions" with history (D5).

### D5. Phase actions, completion, rules — engagement_engineer (server), siem_engineer (client)

- `stageActions { emailTemplateKey?, setStatusKey?, completion?, webhookTargetKey?, dashboardAlert? }`,
  `completion = { kind: fixed, percent } | { kind: range, min, max }` plus `delayMinutes` 0–43 200 (30 days).
- "Run phase actions" (capability `orders.stage.run`, step-up, preview then confirm) runs the pinned bundle
  and writes `order_stage_runs` (snapshot, per-action result, correlation id). A status change is allowed
  **only** here (human-confirmed, also needs `orders.transition`). Unattended rules may never change status.
- `order_completion_jobs`: the percentage of a range is drawn **once** on the server (`crypto.randomInt`)
  and stored; delayed updates are one-shot jobs of the existing queue, fenced by
  `orders.completion_revision`; cancel by an administrator; superseded by a newer write, a reopen, leaving
  the phase or cancellation. Bounded retries (3), then a failure alert (D6).
- Rules (existing automations): `sort_order` with `automations.reorder`; new actions `order.set_completion`,
  `webhook.enqueue_subscription` (managed subscription outbox, never a raw URL), `dashboard.create_alert`;
  new triggers `payment.succeeded`, `payment.failed`, `payment.refunded`, `intake.submitted`,
  `intake.reviewed`, `order.stage_submitted`; the editor offers "All occurrences" or "Specific value" with
  real option lists (statuses from the catalogue, phases, payment outcomes).
- `automations.stageBundlesEnabled` (default on) lets administrators run bundles while unattended rules stay
  off. Customers never see ranges, pending jobs, deliveries or alerts.

### D6. Operational alerts — jobs_engineer (new module `server/modules/opsAlerts`)

- Table `operational_alerts` (severity `warning | error | critical`, source, order / run references, dedup
  key, safe title and text, state `open | acknowledged | resolved`). Port `opsAlerts.emit(...)` /
  `resolve(...)` for stage bundles, completion jobs, webhooks, Graph, file sync, payments, certificates.
- `/admin` widget (counts by severity, links) and page `/admin/alerts` (filter, acknowledge, resolve).
  Forwarded to the audit trail and SIEM with safe codes only. One alert per failure, not per retry.
- Mail: `mailTemplates.listForPhaseActions` (published, variable-compatible templates) and a neutral
  built-in `orders.phase_update` template. Optional reminder when an order waits on staff or customer longer
  than `orders.attention_alert_hours` (default 48, off).

### D7. Outbound integrations — integrations_engineer

- Ports for the editor and the runner: `workflowWebhooks.listOptions` (P101–P401 and named subscriptions; no
  URLs or secrets), `validateTargetKey`, `enqueueStageWebhook(input, tx)` (P201 still requires a delivered
  P101 and the intake lock; a refused precondition is a recorded outcome, never a rollback of the customer's
  payment or submission).
- Lifecycle auto-queue, opt-in per workflow: payment confirmed → P101; phase 1 submitted and locked → P201.
- Optional HMAC-SHA256 signing on production endpoints (off for existing ones until a secret is set);
  `signing_enabled` on subscriptions (default on, as today).
- Stop a queued or retrying delivery; "retry" (eligible, same record chain) separate from "redeliver" (new
  record); order filter on deliveries. Alerts through D6.
- Graph readiness: live SharePoint card on `/admin/integrations` (the "scaffold" text goes), write-capability
  check for `Sites.Selected`, `Retry-After` honoured, token evicted on 401, copyable Entra instructions.
- Egress presets (Stripe, Graph, Graph upload) get visible one-click switches on `/admin/integrations/egress`.

### D8. Documents, audio, deliverables — files_engineer; ZIP archives — portable_contract_engineer

- Uploads are bound to a phase (`stage_key` stored on the file, never derived from the current status
  later). Separate intents: document, recording, prerecorded audio.
- Per-phase governance: `documentCount`, `documentMaxBytes`, `audioCount`, `audioMaxBytes`,
  `recordingMaxSeconds`, `totalAudioMaxSeconds`; blank = platform limit; the tightest of platform, phase and
  task applies; audio duration is verified on the server, never trusted, never treated as zero.
- Files views grouped by phase, category, visibility and version, for the customer and the console.
- Playback: short-lived, account- and session-bound playback grants and `GET` with one byte range (206),
  revoked on hide, replacement, removal and session end. No bearer token in a URL.
- ZIP: phase ZIP for anyone who may see the phase's files; whole-order ZIP for administrators with step-up
  (`file_archives`, built by a job from a fixed manifest, re-authorised at build and at download, capped at
  250 files / 500 MiB, expires after 30 minutes, safe entry names). Placeholders, removed rows and
  superseded versions are never included. Every access is logged.

### D9. Stripe completion — compliance_engineer (server and payments pages), recovery_ops_engineer (cart),
orders_engineer (order side), http_security_engineer (route protection)

- Blockers found and fixed: Stripe egress preset has no switch (D7 adds it, the payments page links it and
  shows the truth); `/invoices/:id` gets a working "Pay online" button and a return banner; `completed`
  with `payment_status = unpaid` (bank debits) answers 200 and waits for `async_payment_succeeded`;
  refunds are read from `/v1/refunds` when the event omits them; dashboard refunds without our metadata are
  flagged for staff, never auto-booked.
- `orders.payment_state` (`not_required | unpaid | pending_async | paid | partially_refunded | refunded`)
  and `paid_at`. Inside the transaction that books a verified payment: the cart becomes checked out, the
  order becomes paid, a stage with `completesOn: payment` completes and the order advances
  (history reason `INVOICE_PAID`), receipt as today, payment triggers fire (D5). Manual payments use the
  same path. Existing orders are backfilled `paid` or `not_required`, never gated retroactively.
- `/admin/payments/setup`: checklist with the webhook URL, the nine events to subscribe, egress switch,
  "Test Stripe API", "Send self-test webhook", last verified event, and a rejections log
  (`payment_webhook_rejections`: reason codes only, no body, headers or addresses; 14 days). A second
  signing secret slot for rotation and the Stripe CLI. The dead Stripe card on `/admin/integrations` links
  here instead.
- The signed webhook route is exempt from the country allow-list only (IP deny, rate limit and the 256 KiB
  cap stay). A browser return never marks anything paid.

### D10. SAML 2.0 for Microsoft Entra ID — identity_engineer (ADR 0062)

- One tenant, one active protocol (`oidc | saml`); both resolve to the same identity (tenant id, object id),
  so links survive a switch. `@node-saml/node-saml` used directly, with overrides to patched `xml-crypto`
  and `@xmldom/xmldom`; our wrapper enforces every check itself.
- `GET /api/identity/saml/metadata`, `GET /api/identity/saml/start`, `POST /api/identity/saml/acs` (the only
  CSRF / Origin exemption: exact path and method, form body ≤ 256 KiB, rate-limited, sets no session; it
  redirects to the existing same-origin completion step).
- Mandatory: signed assertion, RSA-SHA256 or stronger, pinned certificates (two for rollover; metadata URL
  refresh on `login.microsoftonline.com` only), issuer and tenant, audience, destination / recipient,
  `InResponseTo` consumed once, time bounds with 2 minutes skew, object id required. SP-initiated only. No
  single logout. Any failure: generic message, audit, sign-in signal.
- Who: administrators and staff by default; customers opt-in. Just-in-time accounts never become
  administrators; app-role mapping to staff or customer only.
- **MFA** (`entra_mfa_mode`):
  - `claim` (default): no portal MFA when the assertion proves MFA at Entra
    (`authnmethodsreferences` contains `…/claims/multipleauthn`, or an accepted `AuthnContextClassRef`);
    otherwise the portal factor is asked.
  - `entra`: Entra manages MFA; the portal never asks SSO users. This is what the owner asked for. It is
    selectable for every SSO role behind a typed confirmation, audited as a warning, and the page recommends
    a Conditional Access policy "require MFA" for the application.
  - `portal`: always the portal factor.
  - Local sign-in keeps MFA and at least one local administrator with MFA must remain (break-glass).
  - Step-up for SSO users without a portal factor: re-authentication at Entra with `ForceAuthn`.
- `/admin/settings/sso`: protocol switch, copy buttons (Identifier, Reply URL, Sign-on URL), required claims,
  metadata URL or XML upload, certificates with expiry, MFA mode, allowed roles, mappings, "Test sign-in"
  (shows claim names and yes / no facts, never values). Certificate expiry alerts through D6.

### D11. Deploy and ingress — http_security_engineer

- Installer, upgrader, Compose and CI know migration 0007 (hash checked once; seeded pre-0007 upgrade case).
- Nginx and Caddy: the SAML ACS and metadata paths (exact, no redirects on HTTP or alias hosts, no body or
  header logging, ACS not cached); playback range requests pass through unbuffered.
- Security review of the increment (ACS, XML, webhook exemption, range requests, ZIP, stage runs, IDOR on
  every `orders.stages.*` procedure) with abuse tests in the owners' folders by agreement.

### D12. Microsoft 365 file sync — portable_ops_engineer (with integrations_engineer for Graph)

- **One-way**: the portal stays authoritative; nothing done in SharePoint changes the portal.
- Per phase in the editor: document folder and audio folder (defaults `{phase_key}/Docs`, `{phase_key}/Audio`)
  and three targets — originals, conversion staging, intake delivery — each an approved destination or
  "Do not transfer". Managed layout `CustomerName-CustomerID/OrderNumber/<phase folder>`, root segments frozen
  at first export. New tokens `{phase_key}`, `{order_number}`, `{customer_folder}`; old workflows keep theirs.
- Sources: scanned originals (customer and staff), recordings, the WebM derivative **and** its original,
  saved Word edits as new versions, and — off by default — receipt PDFs to a restricted "Receipts" target.
- Destination test proves write (not only read). Resync one file, one order, or a bounded run with a dry-run
  count first. Health (last success, backlog, blocked) and alerts through D6. The File sync tab shows role,
  destination and state.
- Uploads never fail because Graph is offline. Unknown outcomes are reconciled, never blindly replayed.

### D13. Documents — platform_engineer

ADRs 0055–0062, administrator guide ("Phases", "Statuses", "Progress", "Phase actions", "Alerts", "Stripe
setup", "SAML with Entra", "Microsoft 365 file sync"), customer help, CHANGELOG, STATUS, APPLICATION_CONTEXT,
UPGRADE (with http_security_engineer), session log `docs/session-logs/2026-11-24-session-01.md`.

## 2. Not built in this increment (and why)

- Document conversion profiles from the old editor (PDF compression, PDF ↔ Word ↔ text): they need
  LibreOffice / Ghostscript on the server. Audio to WebM stays. Proposed as a later increment.
- Two-way SharePoint sync, remote delete or move, placeholder files, shared links.
- Unattended rules that change order status; raw URLs or secrets inside a workflow.
- IdP-initiated SAML, SAML single logout, encrypted assertions, group-claim mapping, several tenants.
- Embedded card fields (Stripe Elements); payment confirmation from the browser return.
- Free-form graph editing of phases (an ordered list is clearer and keyboard-accessible; the status graph
  stays under "Statuses and transitions (advanced)").

## 3. Packages and owners

| Package | Owner | Scope |
| --- | --- | --- |
| A | ui_foundation_engineer | Phase editor (`Edit order workflow`: phase cards canvas + guided designer, one shared phase form; slots for D7 webhook selector, D12 file sync, D5 actions); `OrderProgress` + stepper; browser QA of the increment |
| B | orders_engineer | D1 server, D3 calculation, attention + payment-state writes, ports for C–M, seeded format-3 workflow and upgrade draft |
| C | recovery_ops_engineer | D2 server + `/admin/workflows/statuses`; attention chips on `/admin/orders` + pipeline widget; cart side of D9 |
| D | assurance_engineer | D4 questions / answers / admin tasks (server + panels); console per-phase panel (submission, review, reopen); accessibility review |
| E | audit_engineer | D4 customer wizard client; audit event names and trigger catalogue entries for every new event |
| F | engagement_engineer | D5 server (bundle runner, completion jobs, rule order / actions / triggers) |
| G | siem_engineer | D5 client (Automation tab panel, rule editor pickers, ordering); SIEM catalogue |
| H | jobs_engineer | D6 module, widget and page; mail selector + template; reminder job; certificate / metadata job slot |
| I | files_engineer | D8 phase binding, governance, prerecorded intent, playback grants + range, grouped views |
| J | portable_contract_engineer | D8 ZIP archives; portable export / import and backup coverage of every new table |
| K | integrations_engineer | D7 |
| L | portable_ops_engineer | D12 |
| M | compliance_engineer | D9 server + `/admin/payments/setup` + invoice "Pay online" |
| N | identity_engineer | D10 |
| O | http_security_engineer | D11; ACS and webhook route work; security review |
| P | platform_engineer | D13 |

## 4. Interfaces to settle first (owners publish in `API.md` within the first hour)

| Interface | Provider | Consumers |
| --- | --- | --- |
| Format-3 `stages[]` zod schema and TypeScript types in `shared/` (editor and server use the same) | B | A, E, F, G, I, K, L |
| `orders.stages.*` procedure shapes; `resolveStageForUpload(order, stageKey, intent)` | B | E, D, I |
| `applyStageStatus`, `applyCompletionPercent(order, percent, expectedRevision, tx)` | B | F |
| `onInvoicePaidInTx`, `onPaymentEventInTx` | B, C (cart) | M |
| status catalogue list port | C | A, B, G |
| `opsAlerts.emit / resolve` | H | F, K, L, M, N |
| `mailTemplates.listForPhaseActions` | H | A, F |
| `workflowWebhooks.listOptions / validateTargetKey / enqueueStageWebhook` | K | A, B, F |
| file sync target list + phase plan validation | L | A, B |
| registry slots in the phase form (webhook, file sync, actions) | A | G, K, L |

## 5. Definition of done (every package)

- Server enforces everything; the client only displays. Ownership and capability checks on every procedure,
  strict input schemas, safe errors, audit events with correlation id, no personal data or secrets in logs.
- Tests: rules and abuse cases, router authorisation tests, and one test that an old stored value or an old
  workflow version still works.
- UI: keyboard operable, visible focus, names / roles / states, errors tied to fields, status messages
  announced, 320 px reflow, both themes, target size ≥ 24 px (44 px for primary touch targets), reduced
  motion respected, no information by colour alone.
- `API.md` and `VERIFICATION.md` of the module updated; an administrator guide section for each
  administrator-facing feature (platform_engineer collects them).
- Report honestly what was run and what was not.
