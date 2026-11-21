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
