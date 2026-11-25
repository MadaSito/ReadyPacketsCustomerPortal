# Orders, catalog, workflow, locks, sharing: verification

Run: `source scripts/dev/env.sh; scripts/dev/test.sh server/modules/orders` (the dev MySQL instance must be running). Each test file creates and drops its own isolated database and uses only synthetic fixtures. Identity, files and engagement are in-process fakes (`testSupport.ts`). Audit, settings and mailer are the shared in-memory fakes from `tests/helpers/fakes.ts`.

Evidence classes: **automated-test** (a named test asserts it), **manual-check** (someone checked it by hand once; not repeatable), **not-verified**, **target** (designed and documented but not yet built or tested).

| Requirement | Evidence | Test (file › name) |
| --- | --- | --- |
| Ships an empty catalog; health `not_configured`; ordering from an empty catalog is refused | automated-test | orders.test › catalog › ships empty … |
| No legacy catalog or prices; no "Packet 8"; demo seed is synthetic, explicit, idempotent, empty-catalog-only | automated-test | demoSeed.test › synthetic demo seed … |
| Product terms are versioned, and old line items keep their price snapshot (price snapshot immutability) | automated-test | orders.test › catalog › price changes create a new version … |
| Catalog writes are audited inside the transaction | automated-test | orders.test › catalog › admin creates versioned products |
| Order create: generated reference, initial status, audit, idempotency key | automated-test | orders.test › order creation › creates an order … |
| Audit unavailable ⇒ no order written (fail closed); duplicate items refused | automated-test | orders.test › order creation › refuses mixed duplicates … |
| Customer list scoped to own and granted orders; cursor pagination bounded | automated-test | orders.test › order creation › customer list is scoped … |
| Other customer ⇒ NOT_FOUND on read, write and summary, audited `authz.order.denied` | automated-test | orders.test › negative authorization matrix › other customer … |
| Malformed, tampered or unknown ids look the same (no existence oracle) | automated-test | … › tampered / malformed / unknown identifiers … |
| Remediation (non-full) session refused, even for the owner | automated-test | … › remediation session is refused … |
| Staff without the capability: no read; no invoice write without `invoices.manage` | automated-test | … › staff without the capability … |
| Customers never write invoices | automated-test | … › customers can never write invoices |
| Pending invitation grants nothing; acceptance needs a verified, matching email; uniform response for unknown emails | automated-test | orders.test › sharing › pending invitation grants nothing … ; … unverified account … |
| Viewer attempting a write ⇒ FORBIDDEN GRANT_READ_ONLY; contributors write content but cannot share or transition | automated-test | orders.test › sharing › viewer cannot write … |
| Revoked grant ⇒ NOT_FOUND right away; cannot be re-accepted | automated-test | orders.test › sharing › revocation takes effect immediately … |
| Locking re-check (`{tx, forUpdate}`) sees a revocation committed after the caller's REPEATABLE READ snapshot | automated-test (fails when the fix is reverted) | orders.test › sharing › locking re-check sees a revocation … |
| Invitations expire | automated-test | orders.test › sharing › invitations expire |
| Locked order: review blocks customer writes; legal hold blocks everyone; reads continue | automated-test | orders.test › locks › review blocks … |
| Workflow: who may trigger, required notes, history, customer notification | automated-test | orders.test › workflow transitions › enforces who may trigger … |
| Internal notes never shown to customers | automated-test | … › internal notes are never shown to customers |
| Concurrent transition conflict: exactly one of two same-version transitions wins | automated-test | … › concurrent transitions with the same expected version … |
| A retired reference can never be reused (by changeReference, allocation or import) | automated-test | orders.test › order references › retired references are reserved forever |
| Reassignment atomicity: audit failure ⇒ nothing moved | automated-test | orders.test › reassignment › audit failure ⇒ nothing moved |
| Reassignment atomicity: files failure ⇒ nothing moved | automated-test | … › files failure ⇒ nothing moved |
| Reassignment moves the owner, revokes every grant, rebinds files and tickets (via files hook), is audited, and is idempotent per operation id (reuse with different input ⇒ CONFLICT) | automated-test | … › moves ownership, revokes every grant … |
| Reassignment refuses inactive, non-customer or same-owner targets, non-admin callers and stale versions; refusals are audited | automated-test | … › refuses inactive / non-customer … |
| Step-up required for reassign/changeReference, at both router and service level | automated-test | … › refuses inactive … ; router guards › … requires fresh step-up |
| Actor re-validated inside the transaction (suspended admin with a live session is refused) for reassign, changeReference and setLock | automated-test | … › refuses inactive … |
| O-01: revoked session refused in-tx for lock, reference, reassign, catalog and workflow writes; nothing changes | automated-test (identity session fake mirroring assertCurrent) | orders.test › in-transaction actor currency … › a revoked admin session is refused … |
| O-01: authority from PERSISTED session (stale persisted step-up, pending steps, demoted role) | automated-test (fake) | … › authority comes from PERSISTED session state … |
| O-01: customer writes, invite/revoke and invitee respond re-validate the session | automated-test (fake) | … › customer writes and sharing re-validate the session … |
| O-01: fails closed without identity session API | automated-test | … › fails closed when identity cannot verify the session |
| O-01: lock order: concurrent accept and reassign do not deadlock (5 rounds) | automated-test (real MySQL; probabilistic, not a proof) | … › concurrent accept and reassign … never deadlock |
| O-02: detail read uses one snapshot (transfer and new-owner note committed mid-request are not visible to the old owner) | automated-test (real MySQL) | … › detail read uses one snapshot … |
| O-02: getOrderSummary and sharing.list use the same snapshot; search is same-statement | implemented, not independently tested (no mid-request interleaving test) | — |
| `getOrderRefById(…, tx, {forUpdate})` locks the row and refuses without a tx | automated-test | … › refuses inactive … |
| Customer cannot reach admin procedures (tRPC guards) | automated-test | orders.test › router guards |
| Import: read-only lock, idempotent link, validated owner, preserved money and dates, no notifications, link conflict refused, reference collision ⇒ fresh reference | automated-test | orders.test › portable hooks › imports read-only … |
| Import: unknown status refused (IMPORT_STATUS_UNSUPPORTED); `isPortableStatusSupported`; `preflightImportOrder` line and total math | automated-test | orders.test › portable hooks › imports read-only … |
| Search scoped to accessible orders; wildcards treated literally | automated-test | orders.test › search |
| No orders code path uses a second pool connection inside its own transaction | automated-test (partial) | oneSlotPool.test › one-connection pool … |
| Notification e-mail (`orders.notify.mail`) goes through mailer templates | not-verified (templates registered; enqueue path not asserted) | — |
| Compliance gate on customer order create | not-verified (optional port, not configured in tests) | — |
| Admin workflow create/publish procedures | not-verified (service only; covered indirectly by `ensureDefault`) | — |
| Packet catalog fields stored and returned; features = deliverable titles; placement rules (pair, group match, one product per packet+tier, unique packet number and group key) | automated-test | packets.test › packet catalog › stores and returns … ; … rejects incomplete placement … |
| Outcome/timeline/deliverables change ⇒ new version; omitted fields kept | automated-test | packets.test › packet catalog › an outcome/timeline/deliverables change … |
| Offerings import: idempotent by key, versions only changed terms, dry run writes nothing, system actor audited as `system`, invalid doc refused | automated-test | packets.test › … › upsertFromOfferings is idempotent … |
| Bundle rule edit validated, audited, admin + `catalog.manage` only | automated-test | packets.test › … › admin bundle rule edit … |
| Packet quantity 1 and one tier per packet on quote and create; non-packet quantities unchanged | automated-test | packets.test › … › enforces quantity 1 and one tier per packet … |
| Server-side discount (round half up), quote = create figures, snapshot of tier/outcome/timeline/deliverables, amounts survive catalog changes | automated-test | packets.test › … › quotes the bundle hint … ; pricing (pure) › rounds half up … |
| `getProductionScope`: sorted packets, other items counted, caller tx honoured, null when missing | automated-test | packets.test › … › quotes the bundle hint … |
| Disabled rule ⇒ no discount, `bundle: null` | automated-test | packets.test › … › disabled rule … |
| Packet wizard (picker, server-quoted totals, review discount, quantity-1 items), packet rule error message, order detail packet terms and discount, admin packet fields and bundle rule dialog | automated-test (jsdom + axe) | orders.test.tsx › new order wizard › packet catalog … ; increment 02 display › … |
| Portable v3 fields round trip through the portable module | not-verified here (collectors are owned by portable_ops_engineer) | — |
| Customer and console UI renders loading/empty/error states, no built-in catalog, wizard submits once with idempotency key, tab-from-URL, staff-only tabs hidden from customers, transition requires note, reassign requires typed reference, price input validated | automated-test (jsdom) | client/src/features/orders/orders.test.tsx (30 tests) |
| No axe violations per page family (list, detail, admin list, catalog, workflows, widget) | automated-test (jsdom + axe; colour contrast not evaluable in jsdom) | orders.test.tsx › "… without axe violations" |
| Real browser, assistive technology, 320–1920 px layouts | not-verified | — |
| WCAG 2.2 AA in a real browser and assistive technology; 320–1920px layout | not-verified | — |

## Known limits

- The one-connection pool test only covers this module's own SQL. Audit, settings and mailer are in-memory fakes, so it cannot catch a second connection used through those adapters. The code passes `tx` to every settings read and high-impact `audit.record` inside a transaction. Denials raised while the caller holds a transaction are queued as a durable `audit.record` and not awaited (otherwise a one-slot pool would deadlock). Such a denial can be lost if the process exits before the write.
- Actor re-validation runs against a test fake of `identity.sessions.assertCurrent`; it is exercised against the real identity module only in the integration suite (not owned here).

## Increment 03 — workflow designer

Server tests use a test database with fake identity, audit, files and engagement adapters (not the real identity module). Counts are as run by orders_engineer at commits bc092eb, e19a222 and 039ce05, one file at a time.

| Requirement | Evidence | Where |
| --- | --- | --- |
| Validation with precise messages and field paths (standard clean, blank explained, every problem reported, unreachable/no-notice warnings, no path to finish) | automated-test | server/modules/orders/workflowDesigner.test.ts (16 tests) |
| Only admins with `workflows.manage` reach the designer; customers/staff refused; unauthenticated refused | automated-test | workflowDesigner.test.ts › "customers and staff cannot reach the designer…" |
| Save invalid work in progress, refuse to publish it, publish a NEW version with fresh step-up; existing orders keep their version | automated-test | workflowDesigner.test.ts › "drafts an edit, saves invalid work in progress…" |
| Concurrent publish: draft refused after the workflow was published again; stale discard refused | automated-test | workflowDesigner.test.ts › "refuses to publish a draft whose workflow was published again…" |
| Explicit standard install (step-up, audited, idempotent) | automated-test | workflowDesigner.test.ts › "installs the standard workflow explicitly…" |
| Legacy direct create/publish not mounted; internal paths need step-up and designer validation | automated-test | workflowDesigner.test.ts › "legacy direct create/publish are not mounted…" |
| Change listener in-tx (throw aborts), sync view, order ref, keyset id listing, automation trigger context | automated-test | workflowDesigner.test.ts |
| Existing order behaviour unchanged | automated-test | server/modules/orders/orders.test.ts (35 tests) |
| Workflows page (install standard, list, drafts, edit-as-copy, new workflow dialog), wizard (step blocking from server issues, all steps, publish payload), conflict message, canvas (form-based add transition, side panel edit, same draft as wizard), versions list, read-only version view; axe on each | automated-test (jsdom + axe; colour contrast not evaluable) | client/src/features/orders/pages/workflows/workflows.test.tsx (8 tests); client/src/features/orders/orders.test.tsx (29 tests) |
| Canvas "Tidy layout" action (left-to-right arrangement) | automated-test (owned by ui_foundation) | client/src/ui/flow/types.ts `arrangeFlow`; client/src/ui/flow/arrange.test.ts |
| Wizard + canvas + publish (new version; existing orders keep theirs) in a real browser | manual check by the lead on the preview build | — |

Not verified here: the real identity module's step-up and actor re-validation (integration suite); assistive-technology use and 320–1920 px layouts beyond the lead's browser check; drag interactions on the canvas (jsdom tests use keyboard/form alternatives); behaviour under real concurrent connections (tests are sequential).

## Increment 04 — workflow rules, phase locks, console order actions (package A + item 13)

Run by orders_engineer one file at a time on `feat/increment-04`. The server suites use the test database with migration 0003 (provisional, 4961345). Identity, audit, files and notifications are fake adapters, not the real modules. The client suites use jsdom with a fake tRPC proxy and axe-core. Colour contrast is not checked in jsdom.

| Requirement | Evidence | Where |
| --- | --- | --- |
| Definition extension (phases, uploads, acknowledgements, `api` actor) validated with precise codes and paths; feature off by default refuses publishing, on publishes | automated-test | server/modules/orders/requirements.test.ts (18 tests) › "accepts a sound rules definition", "reports precise codes…", "refuses while off…" |
| Requirements block leaving a status (`REQUIREMENTS_UNMET`), cancel exempt, fail closed without Files | automated-test | requirements.test.ts › "shows the checklist and refuses…", "does not block cancellation", "allows the transition once uploads are counted…" |
| Authorisation matrix for read/acknowledge (anonymous, customer, other customer, viewer, contributor, staff, admin) | automated-test | requirements.test.ts › "authorisation matrix…" |
| Acknowledgement of the exact text (hash), once, typed name encrypted, wrong side / changed text refused | automated-test | requirements.test.ts › "records an acknowledgement of the exact text, once" |
| Phase lock on leaving, enforcement, staff unlock with reason (internal note), re-lock at next change, reopen on re-entry; audit events | automated-test | requirements.test.ts › "locks the phase being left…", "re-locks at the next status change…" |
| Files ports (writable slots per side, status writable, custody slot) | automated-test | requirements.test.ts › "files ports expose writable slots per actor side" |
| Console access grants: off by default, admin + step-up, uniform refusal for unknown/ineligible/owner, order and customer-wide scope, future orders, revoke together, both notified, viewers read-only | automated-test | requirements.test.ts › five "access" tests |
| Customer lookup staff-only with masked e-mail | automated-test | requirements.test.ts › "customer lookup is staff-only and masks e-mail" |
| Checkout creates the order in the caller's tx, idempotent, customers only | automated-test | requirements.test.ts › "creates inside the caller's transaction…" |
| Public API provider: list/get/create as system; transitions only where the workflow lists `api` | automated-test | requirements.test.ts › "lists, gets, creates as system…" |
| Existing order and designer behaviour unchanged | automated-test | orders.test.ts (35), workflowDesigner.test.ts (16): last run at 83728a7 / a7049a1; server code unchanged since |
| Order page: phase rail, checklist (upload link, read-and-accept), nothing shown without rules; acknowledgement dialog (scrollable focusable full text, explicit checkbox, typed name, sends the shown hash, server refusal shown); staff unlock dialog (reason ≥ 10, notify switch) | automated-test | client/src/features/orders/rules.test.tsx (19 tests) |
| Console: new order for a customer (picker, quantities, one idempotent submit); access dialog (list, grant, revoke for admin; view-only for staff); customer tab lists that customer's orders; reassign uses the customer picker (no raw id) | automated-test | rules.test.tsx; orders.test.tsx (29 tests) |
| Nav "My orders" (10) and "Create an order" (12); `/orders/new` adds to the cart when the `cart` flag is on, otherwise creates the order | automated-test | rules.test.tsx › "navigation and new-order cart handoff" |
| Designer: "Phases and requirements" wizard step, canvas side panel, API integration actor, helper edits keep phases | automated-test | workflows.test.tsx (8 tests), rules.test.tsx › "designer rule helpers" |
| WCAG 2.2 AA page checks in light and dark: order page with rules, acknowledgement dialog open, console customer orders tab (axe, single h1/main, theme applied) | automated-test (`pageA11y`) | rules.test.tsx › "increment 04 page accessibility" (6 cases) |

Not checked here: the real identity step-up and session re-validation (integration suite); the real Files slot counting (fake adapter); real notification delivery; colour contrast, 320 px layout, 400 % zoom and screen-reader use in a real browser (those are for the lead's browser pass); behaviour under truly concurrent connections. The `/cart` page that the wizard hands off to belongs to the cart package and is not tested here.


## Increment 04 part B (S1) — console order workspace

| Requirement | Method | Evidence |
| --- | --- | --- |
| Rename: NFC, version bump, reference unchanged, history row, name-free audit in the tx; no-op, stale, invalid names, customers refused; audit failure rolls back | automated-test | consoleOrder.test.ts › "orders.console.rename (B2)" (3 tests) |
| Name history: staff old → new across pages, stable order, customer view generic, bad cursor refused | automated-test | consoleOrder.test.ts › "listNameHistory…" |
| Status transitions port, customer view notes | automated-test | consoleOrder.test.ts › "listStatusTransitions (S2 port)" |
| Gates: no provider → UNAVAILABLE; customer blocked with CONFLICT ORDER_ACCEPTANCE_REQUIRED until accepted; staff pass; cancel never gated; step gates at the FROM status; API checked against the owner; context scoped; invalid provider refused | automated-test | consoleOrder.test.ts › "orders.gates (B6)" (6 tests) |
| Folder routing port | automated-test | consoleOrder.test.ts › "getOrderFileFolderRouting" |
| Designer validation of gates and folders (including traversal, absolute, backslash, unknown token, control characters, reserved names); gates need workflow rules on | automated-test | workflowDesigner.test.ts (20 tests) |
| Console header (reference · customer · placed, badges), B1 action row order, tab order, `/activity` → Notes, banners per area, Rename dialog (keyboard open, Escape returns focus, validation, success keeps reference), staff vs admin actions, page axe light and dark incl. dialog open | automated-test | client/src/features/orders/orders.test.tsx (39 tests) |
| Rules panel in the console Phases tab; hint punctuation not doubled | automated-test | rules.test.tsx (20 tests) |
| Designer gate editor (published policies only, final steps not offered, server issue at field, payload), storage folder fields with live example (invalid shows a message), slot override, policy list failure | automated-test | workflows.test.tsx (12 tests, incl. pageA11y light and dark of the rules step) |

Not checked here: a real browser (RouteTabs overflow and select below 480 px, focus, contrast, 320 px, zoom); the real acceptance provider (compliance), tested only with a fake provider; the real payment-summary provider; real SharePoint copies using the folder templates; behaviour under truly concurrent connections.

## Increment 05 — C3 discount codes, A1 workflow export / import

| Requirement | Method | Evidence |
| --- | --- | --- |
| Code refused uniformly when the promotions module is absent or `feature.promotions` is off; no code still works | automated-test (fake port) | promotions.test.ts |
| Quote previews the code with server lines and the owner; nothing redeemed | automated-test (fake port) | promotions.test.ts |
| Redeem in the create tx before the order row; promo figures stored; the last redemption goes once; a later failure (audit) rolls the redemption back with the order | automated-test (fake port, real tx) | promotions.test.ts |
| Staff for a customer: eligibility for the customer; staff cannot use a code for themselves | automated-test | promotions.test.ts |
| Checkout in the caller's tx accepts a code and returns the figures | automated-test | promotions.test.ts |
| Release on cancel only on exact zero exposure, including no provider attempt ever (`providerAttemptEver: false`). Exposure, an attempt, a missing field or port, or an error keeps the redemption, and the cancel succeeds | automated-test (fake exposure port) | promotions.test.ts |
| A code never travels in a URL (`quote` GET refuses it; `quoteWithPromo` is a POST mutation); inconsistent outcome refused; API v1 refuses codes | automated-test | promotions.test.ts (10 tests in total) |
| Wizard: field outside the wizard form (no nested forms); Enter and Apply only quote, never create; total announced in an always-mounted polite region; code sent on create; a code dropped after a selection change stays removed | automated-test | client orders.test.tsx (41 tests, incl. 2 C3 and axe on the review step) |
| Staff new-order dialog: code priced for the customer (`forCustomerPublicId`), un-applied on any change of customer or items | code review only | ConsoleOrderTools.tsx (rules.test.tsx 21 pass; no dedicated promo test) |
| Transfer auth matrix: anonymous, customer, staff refused; admin needs step-up for preview/apply; off by default (every step refused, status says so) | automated-test | workflowTransfer.test.ts |
| Export: published definitions with layout, portable policy refs, no local ids; selection; audited | automated-test | workflowTransfer.test.ts |
| Abuse cases: oversized, too deep, not JSON, wrong format version, `__proto__`/`constructor`/`prototype`, unknown keys, digest mismatch (no override), duplicate keys, 51 workflows, HTML/script in names, unknown references, unmatched slugs | automated-test | workflowTransfer.test.ts (14 tests) |
| Apply: drafts only, unique keys, draft of existing, decisions complete, nothing published, idempotent replay | automated-test | workflowTransfer.test.ts |
| C1 attempt guard wraps quote / create / staff-for-customer outside the tx; a refusal reaches it after rollback (no rows); checkout and code-less calls are not wrapped; a zero-contribution code leaves no promo figures | automated-test (fake guard) | promotions.test.ts (12 tests) |
| `catalog.listActive(tx, { forShare })` returns the same catalog on the caller's connection | automated-test | packets.test.ts (9) |
| Existing order and designer behaviour unchanged | automated-test | orders.test.ts (35), workflowDesigner.test.ts (20) |

Run: `scripts/dev/test.sh` per file (above), `scripts/dev/tc.sh` (no errors under `orders/`; errors at the time were in other packages' in-progress files), ESLint on all changed paths.

Tested only against fakes: the promotions port (real module is audit_engineer's); the compliance `orderPaymentExposureInTx` port (real implementation with `providerAttemptEver` in 97f2178, using `FOR SHARE NOWAIT` that fails closed; orders tests use a fake exposure port, and the end-to-end cancel → compliance → release path has not been run here); the real `guardAttempt` (siem_engineer); `compliance.listPublishedPolicies` for policy mapping.

Not verified: real concurrent redemptions across connections; the HTTP body cap for transfer procedures; a real browser (320 px, zoom, dark mode contrast, screen-reader reading of the announcement); the transfer UI (files_engineer).

## Increment 06 — D8 customer tasks, D10 transfer default, D14 order agreement gate

| Requirement | Method | Evidence |
| --- | --- | --- |
| Old definitions and settings parse unchanged; new fields optional; ranges (`RECORD_MINUTES_RANGE` incl. > 120), ≤ 5 documents, `edit_in_portal` needs docx | automated-test | requirements.test.ts (18), requirementsTasks.test.ts (8), workflowDesigner.test.ts (20) |
| Order note: staff only, plain text ≤ 4000, stale version refused, cannot change after acknowledgement; customer cannot accept before the note exists | automated-test | requirementsTasks.test.ts |
| Waive: staff with `orders.phase.unlock`, reason 10–500, once; audited in the tx | automated-test | requirementsTasks.test.ts |
| Transfer: default on, old stored `false` respected, `setEnabled` admin + capability, audited with `via=workflows_page`; format 2 export, import accepts 1 and 2 | automated-test | workflowTransfer.test.ts (17) |
| Agreement gate: off by default, enable needs a published policy, optimistic `expectedEnabled`, place / work scopes, staff and API v1 exempt, damaged value fails closed | automated-test | agreementGate.test.ts (11) |
| Existing order behaviour unchanged | automated-test | orders.test.ts (35), consoleOrder.test.ts (13) |
| Client: record / document links to the right slot, note in the acknowledgement dialog, staff note and waive dialogs, paused-by-agreement callout, axe | automated-test | client rules.test.tsx (27) |
| Designer: record and document task editor, presets, response modes saved; "N to fix" opens a findings list; Show opens the step and focuses the field, falling back to the step's problem list | automated-test | client workflows.test.tsx (16) |
| On-page transfer switch with confirmation when turning off | automated-test | client workflowTransfer.test.tsx (21) |
| Wizard: `AGREEMENT_REQUIRED` opens the agreement; Not now explains; accepting retries with the same idempotency key | automated-test (dialog stubbed) | client orders.test.tsx (43) |
| Order page transition: `AGREEMENT_REQUIRED` opens the agreement; Not now keeps the note and explains; accepting resends the identical request (same `expectedVersion`, so it cannot apply twice) | automated-test (dialog stubbed) | client orders.test.tsx |
| Agreement setting: admin + `policies.manage` (a step-up capability, re-checked from the database in the tx); a stale step-up is refused with nothing written; every change audited in the tx with `enabled_from/to`, `policy_from`, `policy_public_id` | automated-test | agreementGate.test.ts (11) |

Run: `scripts/dev/test.sh` per file, `scripts/dev/tc.sh` (no errors under `orders/`), ESLint on changed paths.

Not verified: a real browser (320 px, zoom, both themes, screen-reader reading of the findings jump and pause callout); the real `AgreementDialog` inside the order pages (stubbed in orders.test.tsx); the Files recorder and edit-in-portal end to end (files / integrations).

## Increment 07 — package B: phases-first workflows (D1), progress (D3), attention and payment state

| Requirement | Method | Evidence |
| --- | --- | --- |
| Old stored definitions (format 1/2) and old phase shapes parse; folders / fileSync / acknowledgement / progression get defaults | automated-test | stages.test.ts "stored shapes"; workflowDesigner.test.ts (20); requirements.test.ts (18) |
| Foreign customer: `NOT_FOUND`; staff cannot `submit` for the owner; customer cannot `review`; staff cannot `reopen`; admin without fresh step-up: `STEP_UP_REQUIRED` | automated-test | stages.test.ts (end to end, real router + MySQL) |
| Submit and lock: acknowledgement required and bound to the shown text (`ACK_REQUIRED`, `ACK_TEXT_CHANGED`); stale version refused; stage locked; attention `staff_review` | automated-test | stages.test.ts |
| Review: `changes_requested` needs a note; accept moves to the next phase; progress never lowers except on reopen (audited `order.progress.lowered`) | automated-test | stages.test.ts; questions.test.ts (assurance) |
| Payment port: paid completes the payment phase and advances once; a repeat is a no-op | automated-test | stages.test.ts |
| List rows: progress, phase label / index / total, payment state, attention; `attention` filter on admin list; null progress filled on first read | automated-test | stages.test.ts |
| Derived workflows refuse stage writes (`STAGE_ACTION_OFF`); legacy unlock refuses format 3 (`USE_STAGE_REOPEN`) | automated-test | stages.test.ts |
| Start-up job installs the standard phases once on a fresh install; idempotent | automated-test | stages.test.ts |
| Transfer: version 3 only when phases exist; import accepts 1–3; version 4 refused | automated-test | stages.test.ts; workflowTransfer.test.ts (17) |
| Existing behaviour unchanged | automated-test | orders.test.ts (35), consoleOrder.test.ts (13), requirementsTasks.test.ts (8), client workflows.test.tsx (16) |

Run: `scripts/dev/test.sh` per file, `scripts/dev/tc.sh` (no errors in orders-owned files), ESLint on changed paths.

Not verified: the upgrade-draft branch of the start-up job and the phase target checks (webhook / file sync) have no automated test yet; a real browser for the designer's Phases view (keyboard, 320 px, both themes, screen reader); the paid backfill for existing orders is not implemented (existing orders keep `not_required`).

## Increment 07 D4: phase questions, checklist and submission panel

See [D4 verification](./questions/VERIFICATION.md) for automated coverage and browser checks.
