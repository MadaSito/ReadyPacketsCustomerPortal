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
| `getOrderRefById(…, tx, {forUpdate})` locks the row and refuses without a tx | automated-test | … › refuses inactive … |
| Customer cannot reach admin procedures (tRPC guards) | automated-test | orders.test › router guards |
| Import: read-only lock, idempotent link, validated owner, preserved money and dates, no notifications, link conflict refused, reference collision ⇒ fresh reference | automated-test | orders.test › portable hooks › imports read-only … |
| Import: unknown status refused (IMPORT_STATUS_UNSUPPORTED); `isPortableStatusSupported`; `preflightImportOrder` line and total math | automated-test | orders.test › portable hooks › imports read-only … |
| Search scoped to accessible orders; wildcards treated literally | automated-test | orders.test › search |
| No orders code path uses a second pool connection inside its own transaction | automated-test (partial) | oneSlotPool.test › one-connection pool … |
| Notification e-mail (`orders.notify.mail`) goes through mailer templates | not-verified (templates registered; enqueue path not asserted) | — |
| Compliance gate on customer order create | not-verified (optional port, not configured in tests) | — |
| Admin workflow create/publish procedures | not-verified (service only; covered indirectly by `ensureDefault`) | — |
| Customer and console UI (`client/src/features/orders`) | target (see that folder's tests once built) | — |
| WCAG 2.2 AA in a real browser and assistive technology; 320–1920px layout | not-verified | — |

## Known limits

- The one-connection pool test only covers this module's own SQL. Audit, settings and mailer are in-memory fakes, so it cannot catch a second connection used through those adapters. The code passes `tx` to every settings read and high-impact `audit.record` inside a transaction. Denials raised while the caller holds a transaction are queued as a durable `audit.record` and not awaited (otherwise a one-slot pool would deadlock). Such a denial can be lost if the process exits before the write.
- Actor re-validation checks status, role and role capability. Session revocation is enforced by the session layer, not re-read here.
- Catalog and workflow admin writes rely on router guards (`adminProcedure` + capability) and are not re-validated against the actor row inside the transaction.
