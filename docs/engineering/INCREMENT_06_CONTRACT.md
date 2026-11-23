# Increment 06 — recording, order tasks, reports, protection, policies, receipts, PWA

Owner request (2026-11-23, prompt 23), fifteen items:

1. The side panel must be more accented and stand out against the page.
2. Orders need recording from any device with a preflight test. Target format WebM; Apple devices record in
   their most compatible format and the recording is converted to WebM without losing anything.
3. A best-practice upsell model built from the products, shipped disabled, editable, with an easy enable
   button in the admin panel.
4. PWA for Apple, Android, Windows and other devices (native Android/iOS apps come later).
5. Discount limits removed or configurable: any percentage, no minimums, carts at $0 for test orders, orders
   at $0.01.
6. Detailed reporting (orders, customers, referrals, support tickets, …) and custom reports from the admin
   panel.
7. Ban IPs that keep failing sign-in, event correlation, rate limiting with back-off.
8. Order phases decide what the customer must do: upload, acknowledge an admin note, record, respond to an
   admin document upload. File and audio types can be restricted.
9. Customers can edit Word documents in the portal.
10. Import and export order workflows, one or several.
11. A typed-name policy signature is checked against the name of the signed-in person.
12. Import a policy from Word, Markdown or PDF. Policy updates prompt users to accept, with a countdown to
    the notice and a button to push the notice to everyone.
13. A user who does not accept a policy can be disconnected, after a customisable warning; they must accept
    to continue.
14. An MNDA must be accepted before a customer places an order or works on one; configurable in admin.
15. Every order confirmed paid produces a logo-branded receipt (customer, company, items, price paid,
    discount codes), e-mailed and kept in the customer's portal.

`BUILD_CONTRACT.md`, `INCREMENT_04_CONTRACT.md` and `INCREMENT_05_CONTRACT.md` still govern everything (module
shape, ownership checks, audit, safe errors, step-up, idempotency, WCAG 2.2 AA in both themes, 320 px, strict
inputs, public ids only across the wire, no secrets or personal data in logs). This file adds only what
increment 06 needs.

## 0. Working rules

- Branch `feat/increment-06` is checked out in the shared tree. Nobody switches branches or pushes.
- Commit only your own paths with `scripts/dev/commit.sh "<message>" <paths>` (it adds the required trailer).
- Never build or start servers (only `/root` and ui_foundation_engineer do). Verify with the FULL typecheck
  (`scripts/dev/tc.sh`), `pnpm exec eslint <your paths> --max-warnings 0`, and your tests one file at a time
  (`scripts/dev/test.sh <file>`).
- `/root` generates `migrations/0006_increment_06.sql` once. Additive only: new tables, new nullable columns
  or columns with defaults, new indexes. Declare tables in your module's `schema.ts`, then report "schema
  final" to `/root`. Do not run `drizzle-kit`.
- Capabilities are already added by `/root` (`shared/capabilities.ts`, block "increment 06"): `reports.read`
  (staff + admin), `reports.manage`, `reports.export` (step-up), `policies.notices.send` (step-up),
  `security.incidents.read`.
- Dependencies already added by `/root`, for the browser only (lazy chunks, never imported by `server/`):
  `mammoth` (DOCX → HTML), `docx` (build DOCX), `pdfjs-dist` (PDF text), `@tiptap/extension-table`,
  `@tiptap/extension-text-align`. No other new dependency without asking `/root`.
- New server modules are mounted by `/root` (`server/trpc/root.ts`, `server/container.ts`); new client
  features in `client/src/app/registry.ts`. Tell `/root` the export names when the module compiles.
- **Defaults in this increment.** The owner could not find features that were shipped switched off. So:
  what the owner asked for is ON after upgrade when it is safe and needs no configuration (recording,
  workflow export/import, document editing, receipts, reports, PWA install prompt, name check, relaxed
  discount limits, sign-in auto-ban with the guards in D7). It is OFF until configured when it can lock
  people out or needs a choice by the owner (policy enforcement, MNDA gate, upsell — the owner asked for
  disabled). Every such feature has its switch on the page where it is used, not only in Platform settings.
  Every switch is audited. Nothing breaks when a feature is off.
- A change to a stored setting shape must read old stored values (parse with defaults; never throw on an
  old value). Installed sites are upgraded in place.
- Reports to `/root`: done / commits / not done / needs — at most 150 words. Publish interfaces in your
  module's `API.md`; keep messages to other owners short. Ask the owner of a file before touching it.

## 1. Decisions

### D1. Side panel accent (item 1) — ui_foundation_engineer

- Customer and console side panels use the navy brand panel in both themes (`--color-navy*`,
  `.rp-on-navy`), so the panel is clearly separated from the page in light and dark theme. Section labels
  in teal-light; active item: solid teal accent (filled pill or strong inset bar plus tinted background)
  with text ≥ 4.5:1 and a non-colour cue (bar/weight); hover and focus states distinct (focus ring ≥ 3:1).
- Console panel gets the same stronger active state and a visible edge (accent line or shadow) against the
  page. The mobile drawer and the bottom quick navigation follow the same tokens.
- Tokens only (`client/src/styles/index.css`); no per-page colours. Check axe + contrast in both themes at
  320, 768, 1280 px, forced-colours mode, and the collapsed (icon) state with tooltips/labels.

### D2. Recording on orders (item 2, ADR 0047) — files_engineer

- **Scope.** Audio recording (the existing recorder), from the order's files panel and from a phase task of
  kind `record` (D8). A clear "Record" button is visible wherever audio is accepted.
- **Formats.** Pick at runtime with `MediaRecorder.isTypeSupported`, in this order: `audio/webm;codecs=opus`,
  `audio/webm`, `audio/mp4;codecs=mp4a.40.2`, `audio/mp4`, `audio/ogg;codecs=opus`, browser default. Record
  with a timeslice (1 s) so MP4 on iOS does not stall; label the blob with the type the recorder really
  used. Devices without `MediaRecorder` (or when the microphone is refused) fall back to
  `<input type="file" accept="audio/*" capture>` (the device's own recorder) and to ordinary upload.
- **Conversion.** Anything that is not WebM/Opus (Apple `.m4a`, `.mp4`, `.ogg`, `.wav`, `.mp3`, `.aac`,
  `.caf`) is converted on the server to WebM/Opus by the existing ffmpeg job. `files.audio_conversion`
  default becomes `{ enabled: true, keepOriginal: true, bitrateKbps: 128 (allowed 24–256), maxMinutes: 30
  (allowed 1–120) }`; sample rate and channels preserved up to 48 kHz stereo. The original is always kept
  while `keepOriginal` is on and can be downloaded by staff; the WebM is what the order shows and what goes
  to production. Honest wording everywhere: the conversion is high quality but AAC → Opus is a re-encode,
  not a bit-identical copy; the original file is the lossless record. If ffmpeg is missing the upload is
  still stored, the file is marked "conversion pending/unavailable", and the admin sees a health warning.
- **Preflight** (`RecordingPreflight`, a dialog before the first recording and on demand): secure context,
  recorder support and chosen format, microphone permission (with per-browser recovery text), input device
  picker, live level meter with "we can hear you" threshold, a 5-second test recording with playback
  (including the iOS silent-switch hint), and a server check `files.recording.preflight` → `{ enabled,
  conversionAvailable, maxMinutes, maxBytes, acceptedTypes }`. Each check shows pass / warn / fail in text
  (not colour only), is announced politely, and the result can be re-run. The test recording never leaves
  the device.
- Recording limits come from the phase task when present (D8), else from the setting. The elapsed and
  remaining time are visible; pause/resume stays; a wake-lock is requested while recording when available.
- Admin: `/admin/files` shows the setting with the new bounds and the ffmpeg status.

### D3. Upsell model (item 3) — recovery_ops_engineer

- Seed a starter set of suggestions built from the catalogue (packets 1–6, tiers Basic/Standard/Premium,
  six-packet bundle; see `docs/source-specs` and the offerings matrix): (a) tier upgrade Basic → Standard and
  Standard → Premium for the packet in the cart, (b) complete the bundle when several packets are in the
  cart, (c) the natural next packet for each packet, (d) an add-on style suggestion where the matrix has
  one. Each has a clear headline, a one-line reason and a priority. Seeding is idempotent (stable keys),
  runs at start-up or on demand ("Add suggested offers"), only references catalogue items that exist, never
  overwrites an edited row, and every seeded row is **disabled**.
- `/admin/carts/suggestions`: a switch at the top "Show suggestions in the cart" (turns `feature.cart.upsell`
  on/off, and offers to turn on `feature.cart` when it is off), per-row enable switch, "Enable all" /
  "Disable all", create / edit / duplicate / delete as today. Capability `carts.upsells.manage`; audited.

### D4. PWA (item 4, ADR 0048) — portable_ops_engineer

- Audit and complete the existing PWA: manifest (`id`, `name`, `short_name`, `description`, `start_url`,
  `scope`, `display: standalone`, `display_override`, theme/background colours for both themes, `lang`,
  `dir`, categories, shortcuts to Orders / Create an order / Messages / Support, screenshots if cheap), icons
  192/512 `any` and `maskable`, Apple touch icon 180, Windows tiles as far as the manifest covers them,
  `apple-mobile-web-app-*` and `theme-color` meta, safe-area handling.
- Install experience: an "Install app" entry (account menu and sign-in page footer) using
  `beforeinstallprompt` on Chromium (Android, Windows, ChromeOS, desktop), and step-by-step instructions for
  iOS/iPadOS Safari ("Share → Add to Home Screen") and macOS Safari ("Add to Dock"); hidden when already
  installed (`display-mode: standalone`); dismissible and remembered on the device.
- Service worker rules (zero trust): precache only the static shell; **never** cache `/api`, `/trpc`, file
  downloads, or any authenticated response; no background sync of personal data; sign-out clears runtime
  caches; `offline.html` for navigations without a network; update prompt stays. Document in the ADR what
  is and is not cached and add a test for the route rules.
- Native-app readiness note in the ADR and `APPLICATION_CONTEXT`: what a future Android/iOS app can reuse
  (API v1, auth flows, deep-link paths, `assetlinks.json` / `apple-app-site-association` placeholders are
  NOT published until an app exists). No native app is built in this increment.
- Installer/upgrade: migration 0006 in `deploy/` + CI, nginx (`Service-Worker-Allowed`, cache headers for
  `sw.js`/manifest: no long cache), upload size for recordings up to the new maximum, `UPGRADE.md`.

### D5. Discount limits (item 5) — siem_engineer (server), audit_engineer (client), recovery_ops_engineer (cart), compliance_engineer (payments)

- `promotions.policy` gains configurable limits, all editable on the Discount codes page ("Limits" card)
  and in Platform settings: `maxDiscountPercent` (0.01–100, default **100**), `maxFixedAmountMinor`
  (nullable = no limit, default null), `allowZeroTotal` (default **true**), `minOrderTotalAfterDiscountMinor`
  (default 0). Old stored values still parse. A rejected code names the limit and links to the Limits card
  (staff/admin only).
- Percent supports two decimals (stored as basis points; additive column or reuse — owner's choice, must
  be additive for installed sites). 99.99 % is valid.
- New discount kind **"Set order total to"** (`set_total`): the order total becomes the given amount
  (0.00, 0.01 or any amount not above the cart total). This is the supported way to make $0 test orders and
  $0.01 orders. Fixed amount must still be greater than 0 (a 0.00 fixed discount does nothing); the form
  explains this and points to "Set order total to".
- Money stays integer minor units; rounding half-up once on the discount, never per line drift (allocate
  the remainder to the last line). Property test: total after discount is never negative and matches the
  sum of line allocations.
- **Totals below the card minimum.** Stripe refuses card charges under its minimum (0.50 USD or
  equivalent). New setting `payments.small_totals` `{ belowProviderMinimum: "waive" | "block" }`, default
  `waive`: the remaining amount is recorded as waived, the order is settled as paid without a provider
  call, and the receipt (D15) shows "Amount waived". Provider minimums are a table in the payments module
  (per provider and currency, overridable in settings). `block` shows the customer a clear message.
- $0.00 checkout copy: "Nothing to pay — your discount covers this order." (cart).
- Abuse cases: a 100 % or set-total code is still subject to every existing control (expiry, redemption
  limits, per-customer limit, eligibility, audit); creating one requires `promotions.manage` (step-up); the
  list flags codes that can bring a total to zero.

### D6. Reports (item 6, ADR 0049) — portable_contract_engineer (server `server/modules/reports`), engagement_engineer (client `client/src/features/reports`)

- **Built-in reports** (date range, compare with previous period, chart + table, CSV): Orders (created,
  completed, by status/phase/workflow/product and tier, turnaround time, overdue, revenue), Customers (new,
  active, by lifecycle, top by orders and revenue, policy acceptance state), Referrals (invitations,
  sign-ups, conversions, rewards), Support (tickets opened/closed, by status/category/priority, time to
  first response, time to resolution, backlog age), Payments and discounts (paid, refunded, waived, by
  provider, code redemptions and discount given), Carts (open, abandoned, converted, upsell shown/accepted),
  Files and recordings (uploads, conversions, failures), Sign-ins and security (sign-ins, failures, bans).
- **Custom reports** (admin, `reports.manage`): choose one dataset from a server-side whitelist, columns,
  filters (field + operator + value, typed), optional group-by with count / sum / average / minimum /
  maximum, sort, row limit (≤ 5,000 on screen, ≤ 100,000 in CSV), chart type. Save with name and
  description, private or shared with staff; duplicate, edit, delete; run on demand. No free-form SQL, no
  expressions. The definition is data validated by a strict schema and compiled to parameterised Drizzle
  queries from the whitelist only.
- **Data rules.** Read-only access to other modules' tables following the precedent used by the portable
  module; never encrypted or secret columns; public ids and customer numbers only; personal-data columns
  are flagged in the dataset catalogue and shown only to roles that may already see them (staff see
  aggregates and the customer data they can already read; customers have no access). Query timeout and
  row caps; one running report per user; rate limited.
- CSV: UTF-8 with BOM, RFC 4180, formula-injection guard (same helper as the acceptance log export),
  `reports.export` (step-up), audited `report.exported` with the definition hash and row count.
- Audit `report.run` (key or definition id, filters without personal values). Tables: `report_definitions`
  (+ run log if needed). Portable transfer and backup cover the new tables.
- Client: `/admin/reports` (overview cards → report pages → custom builder). Charts have a data-table
  alternative and text summary; colour is never the only encoding. Staff see built-in reports only.

### D7. Sign-in bans, correlation, back-off (item 7, ADR 0050) — http_security_engineer (server + protection UI), identity_engineer (signals), audit_engineer (correlation), siem_engineer (forwarding)

- **Signals.** identity publishes every failed and successful sign-in step (password, MFA, recovery code,
  passkey, password reset, SSO callback failure) to the protection port: `{ ip, accountRef?: hashed, kind,
  outcome, correlationId, at }`. No passwords, no e-mail in clear in the signal.
- **Automatic bans.** New setting `protection.signin_bans` `{ enabled: true, threshold: 10, windowMinutes:
  10, banMinutes: 15, escalation: { factor: 4, maxMinutes: 1440, memoryHours: 24 }, permanentAfter: null
  (number of bans, admin option), countDistinctAccounts: true }`. Works independently of the firewall
  monitor/enforce mode. A banned IP gets the generic 429/403 safe error before credentials are examined.
- **Guards (lock-out safety).** Never ban: loopback, the configured trusted proxies, allow-listed entries,
  and — while the proxy trust check reports that client addresses cannot be determined — nothing at all
  (the page shows a warning instead). A successful sign-in does not clear strikes of other accounts. Bans
  are listed with reason, strikes, expiry and "Unban"; manual "Ban this IP" (temporary or permanent, CIDR
  allowed) from the list, from an incident and from the audit event. A break-glass command for the
  operator (documented in `docs/operations`) lists and clears bans without the web UI.
- **Back-off.** Rate limiter gains progressive back-off per category: each consecutive exceeded window
  multiplies the wait (`factor`, default 2) up to `maxSeconds`, forgotten after `resetAfterMinutes` of good
  behaviour; `Retry-After` always sent; the client shows a countdown. Controls on
  `/admin/protection/rate-limits` (enable, factor, maximum, reset) with bounds and "restore defaults".
  Sign-in keeps its per-account progressive delay; document how the three layers combine.
- **Event correlation** (audit module, `/admin/audit/incidents`, `security.incidents.read`): rules with
  editable thresholds evaluate recent audit/security events into incidents — brute force on one account,
  password spraying (one IP, many accounts), credential stuffing burst, distributed attempts on one
  account (many IPs), sign-in after many failures (possible compromise), MFA fatigue (repeated MFA
  failures), repeated rate-limit hits, ban evasion (same account from a new IP right after a ban),
  privilege change followed by export. An incident has severity, status (open / acknowledged / closed),
  the correlated events (by correlation id, IP, account, time window), a timeline, and actions (ban IP,
  end sessions, open audit search with the filter). Incidents are audit events themselves and are
  forwarded to SIEM/syslog (`security.incident.*`, `security.ban.*`) by siem_engineer's catalogue.
- Abuse cases: header spoofing of the client IP; shared NAT (short first ban, escalation capped); an
  attacker locking out a victim's account is not made easier (bans are per IP, not per account);
  enumeration through different responses for banned vs unknown; the ban list cannot be flooded
  (cap + oldest temporary first).

### D8. Phase tasks (item 8, ADR 0051) — orders_engineer (with files_engineer for enforcement)

- A status (grouped by phase) carries **customer tasks**. Kinds: `upload` (existing slots), `acknowledge`
  (existing workflow-defined text, plus **order note**: staff write a note on that order for that step and
  the customer must acknowledge it), `record` (audio recorded in the portal or uploaded; `capture:
  "record" | "upload" | "either"`, `maxMinutes`, allowed audio types), `respond_document` (staff upload a
  document for the customer; the customer must respond by `responseMode`: `edit_in_portal` (D9), `upload_reply`,
  `acknowledge`, or any of those the task allows). Each task: label, hint, required/optional, who may do
  it, allowed file types.
- **Type restriction.** Per task `allowedTypes` chosen from the platform's allowed list with presets
  ("Word", "PDF", "Images", "Audio"). Enforced on the server at upload by extension **and** detected
  content type (the existing magic-byte check); the client filters the picker and explains what is
  accepted. A task can never widen the platform list.
- A phase cannot be left by the customer path until required tasks are complete (existing requirement
  gate); staff see task state per order and can waive with a reason (`orders.phase.unlock`, audited).
- Designer: a "Customer tasks" editor per status with the four kinds, validation messages that say what is
  wrong and where ("2 to fix" opens a list that jumps to each finding). Existing definitions stay valid.
- Workflow package `formatVersion` 2 (import accepts 1 and 2).

### D9. Word documents in the portal (item 9, ADR 0052) — integrations_engineer (editor + converters), files_engineer (file ports)

- **In the browser only.** `client/src/lib/docconvert/`: `docxToHtml` (mammoth; output sanitised with the
  existing HTML sanitiser before it reaches the editor), `editorToDocx` (`docx` package), `pdfToText`
  (`pdfjs-dist`, worker from the same origin, `isEvalSupported: false`, no remote fonts/cmaps), `markdown`.
  All lazy-loaded; no parser runs on the server; the server keeps validating every stored file as today.
  Guards: 10 MB input, ZIP entry count/size ratio check before parsing, 200 pages for PDF, a time limit,
  and a clear failure message. CSP stays strict (no `unsafe-eval`); if a library needs it, report to `/root`.
- **Editor** (`client/src/features/docedit`): open a `.docx` the user may read on an order → edit in the
  existing rich-text editor (headings, paragraphs, bold/italic/underline/strike, lists, links, tables,
  alignment, images already in the document) → "Save as new version". The original is never changed: the
  save uploads a new `.docx` through the normal upload path, linked to its source (`derivedFromFileId`,
  version number), visible in the file's version history. Autosave of the draft in memory only (no local
  storage of document content); unsaved-changes warning.
- **Honest limits.** Before editing, the user is told what the editor does not keep (headers/footers,
  tracked changes, comments, text boxes, footnotes, complex fields, exact fonts and page layout). When such
  content is detected the warning lists it. The original remains available.
- Who: customers on their own orders for files they may read and where the order/phase allows uploads (a
  `respond_document` task with `edit_in_portal`, or the order accepts customer documents); staff/admin on
  files they may manage. Setting `files.document_editing` `{ enabled: true, maxBytes }`.
- files_engineer provides: read-as-blob for the editor, `saveEditedVersion` (ownership, phase rules, D14
  gate, type/size checks, audit `file.edited_version_created`), version listing.
- `DocumentImportButton` (reusable): pick `.docx` / `.md` / `.pdf` → returns sanitised editor content plus a
  list of conversion warnings. Used by D12.

### D10. Workflow export/import visible (item 10) — orders_engineer

- `orders.workflow_transfer.enabled` default becomes **true** (import stays admin + step-up, drafts only,
  ADR 0042 unchanged). The Workflows page shows row "Export", selection checkboxes with "Export selected",
  "Export all" and "Import"; when the setting is off, admins see a switch on the page to turn it on.

### D11. Typed name must match (item 11) — compliance_engineer

- Setting `compliance.signature_name_check` `{ mode: "require" | "warn" | "off" }`, default `require`.
  Comparison: Unicode NFKC, case-insensitive, diacritics and punctuation ignored, whitespace collapsed;
  accepted when the typed name equals the account's full name, or first + last name with middle names
  omitted. The server decides; the client shows the user their own account name as the expected value and a
  link to correct their profile name (name change is audited) when it is wrong.
- Applies to policy acceptance and to workflow acceptance gates with `typed_name` (through the compliance
  acceptance port — one implementation). The acceptance record stores the match result. The acceptance log
  centre shows it. Mismatch attempts are audited without storing the typed text in clear.

### D12. Policy import and update notices (item 12, ADR 0053) — compliance_engineer (dialog wiring), integrations_engineer (import component), assurance_engineer (notices), jobs_engineer (mail + schedule)

- **Import.** The New policy / New version dialog gets "Import from file" (`DocumentImportButton`): Word and
  Markdown keep headings, lists, emphasis, links and tables; PDF import extracts text only (said so in the
  dialog). The imported text lands in the editor for review; nothing is published by an import. The server
  sanitises as for typed content.
- **Update notice.** Publishing a version of a policy with "acceptance required" creates a notice for the
  policy version: `scheduledAt` = publish time + `noticeDelayHours` (per policy, default 24, 0 = at once;
  admin picks date/time). The policy page shows a live **countdown** to the notice, "Send notice to everyone
  now" (`policies.notices.send`, step-up, confirmation with the audience count), "Change time", "Cancel
  notice". Sending queues e-mail (template `policy_update_notice`) in batches to every user in the audience
  who has not accepted the current version, creates an in-portal notification, and is idempotent per
  version and user; "Remind those who have not accepted" re-sends only to them (rate limited per version).
  Progress (queued / sent / failed / accepted) is shown. Audit `policy.notice.*`.
- In the portal, a user with a pending required policy is prompted on sign-in and on the next navigation
  (existing acceptance prompt), with the changes summary when the admin wrote one.

### D13. Enforcement and session end (item 13, ADR 0053) — assurance_engineer (server in `server/modules/compliance/policyEnforcement*.ts` + UI), identity_engineer (session end + remediation step), compliance_engineer (review)

- Per policy: `enforcement { mode: "none" | "required_to_continue", graceHours (0–720), warningText (plain
  text ≤ 1,000 chars, placeholders {policy}, {deadline}, {timeLeft}), appliesTo: audience }`, default
  `none`. A site-wide default warning text is editable on the Policies page.
- While within the grace period the user sees the warning (their text) with a countdown and Accept /
  Read / Later. On "I do not accept", or when the grace period ends, every session of that user is ended
  (identity port `endSessionsForUser(userId, reason)`), audit `policy.enforcement.session_ended`.
- At the next sign-in the session is in the existing `remediation` state with a new transition step
  `accept_policy`: the user can read and accept the policy, change nothing else, or sign out. Accepting
  completes the step and the session becomes full. Server-side enforcement (the client is only display).
- Admin: on the acceptance log centre and the customer profile, "End sessions now" for a user who has not
  accepted (`sessions.revoke_any`, step-up).
- Lock-out safety: enforcement never applies to a policy that is not published; switching it on shows the
  number of affected users and needs confirmation; administrators are prompted like everyone in the
  audience but can always reach the acceptance step; the break-glass note in `docs/operations` explains how
  to switch enforcement off from the server.

### D14. MNDA before ordering or working (item 14) — orders_engineer (gate), compliance_engineer (admin card + port), recovery_ops_engineer (cart), files_engineer (uploads/recording/editing)

- Setting `orders.agreement_gate` `{ enabled: false, policyPublicId: null, applyTo: { placeOrder: true,
  workOnOrder: true }, signatureMode: "typed_name" | "checkbox", askAgainOnNewVersion: true }`. Admin card
  "Order agreement (MNDA)" on the Policies page and in the workflow settings: pick a published policy,
  choose where it applies, switch on. It cannot be switched on without a published policy.
- Implemented as an implicit acceptance gate on top of the ADR 0039 gateway (one mechanism). Server checks
  for customer actors: cart checkout and order creation (`placeOrder`); uploads, recordings, document
  edits, task acknowledgements and customer transitions on an order (`workOnOrder`). Safe error
  `AGREEMENT_REQUIRED` with the policy public id; the client opens the acceptance dialog and then repeats
  the action. Orders port `assertCustomerMayWork(orderRef, user)` for files and cart.
- Staff creating an order for a customer is allowed; the customer must accept before working on it. API v1
  keys are not customers and are not gated (documented).
- No legal text is shipped. The owner imports their MNDA (D12).

### D15. Receipts (item 15, ADR 0054) — compliance_engineer (payments + PDF + portal), jobs_engineer (mail with attachment)

- When a payment is confirmed (verified Stripe/Square webhook, or a zero/waived total settled at checkout,
  or a manually recorded payment), create exactly one receipt per payment (idempotent on the payment id):
  number `RPR-<year>-<6 digits>`, issue time, company block (logo, legal name, address, contact, tax id —
  from the company profile settings; add the missing fields), customer block (name, company, customer id
  `RPCUS-…`, e-mail), order reference(s), lines (product, tier, quantity, unit price), subtotal, each
  discount code with its amount, bundle/other discounts, tax if any, amount waived, **amount paid**,
  payment method summary (brand and last four when the provider gives them, never the full number),
  provider reference, currency.
- PDF from the existing generator (`invoicePdf.ts` extended: embedded logo, tagged where feasible, text is
  real text, document title and language set); stored encrypted like other documents; the snapshot of the
  figures is stored so the receipt can be reproduced unchanged later.
- Delivered: e-mail (template `payment_receipt`, PDF attached, editable in mail templates) and the
  customer portal (Invoices → "Receipts", and on the order). Staff see receipts on the order and customer
  profile and can "Send again" (audited, rate limited). Refunds mark the receipt "refunded/partially
  refunded" and produce a refund note; the original receipt is never altered.
- Setting `payments.receipts` `{ enabled: true, emailCustomer: true, footerText }`.

## 2. Packages and owners

| Package | Owner | Items |
| --- | --- | --- |
| A | ui_foundation_engineer | D1; shared UI needs of others (countdown, switch-with-confirm, chart frame); browser QA |
| B | files_engineer | D2; file ports for D8, D9, D14 |
| C | integrations_engineer | D9 editor and converters; `DocumentImportButton` (D12) |
| D | recovery_ops_engineer | D3; cart side of D5 and D14 |
| E | portable_ops_engineer | D4; installer/upgrade/CI/nginx for 0006 and larger recordings |
| F | siem_engineer | D5 server; SIEM catalogue for D7 events |
| G | audit_engineer | D5 client; D7 correlation and incidents |
| H | portable_contract_engineer | D6 server; portable/backup coverage of every new table |
| I | engagement_engineer | D6 client; support-ticket metrics inputs |
| J | http_security_engineer | D7 bans + back-off + protection UI; security review of the increment |
| K | identity_engineer | D7 signals; D13 session end + `accept_policy` step |
| L | orders_engineer | D8, D10, D14 gate |
| M | compliance_engineer | D11, D15, payments part of D5, policy dialog wiring for D12, admin card for D14 |
| N | assurance_engineer | D12 notices, D13 enforcement; accessibility review of the increment |
| O | jobs_engineer | mail templates (receipt, policy notice, enforcement warning), attachments, scheduled notice job |
| P | platform_engineer | ADRs 0047–0054, guides, CHANGELOG, STATUS, APPLICATION_CONTEXT, session log; pending doc edits |

## 3. Definition of done (every package)

- Server enforces everything; the client only displays. Ownership and capability checks on every procedure,
  strict input schemas, safe errors, audit events with correlation id, no personal data or secrets in logs.
- Tests: unit tests for rules and abuse cases listed above, router authorisation tests, and at least one
  test that an old stored setting value still parses.
- UI: keyboard operable, visible focus, names/roles/states, errors tied to fields, status messages
  announced, 320 px reflow, both themes, target size ≥ 24 px (44 px for primary touch targets), reduced
  motion respected, no information by colour alone.
- `API.md` and `VERIFICATION.md` of the module updated; an admin guide section for each admin-facing
  feature (platform_engineer collects them).
- Report honestly what was run and what was not.
