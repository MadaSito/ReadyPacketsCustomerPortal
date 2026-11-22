# Increment 05 security review

Scope: Package G review against `docs/engineering/INCREMENT_05_CONTRACT.md`, decisions D1–D4 and abuse cases in §4. This is a defensive source and regression review, not a penetration test or production sign-off. Open findings describe the revisions reviewed, not necessarily the latest owner work in progress.

## Review matrix

| Area | Security checks | Status |
| --- | --- | --- |
| Workflow transfer | Bounded and strict parsing (size, depth, key safety, duplicate keys); recomputed digest as integrity only; reference mapping; no secrets or customer data on export; import capability, live step-up, replay safety, and draft-only persistence. | HTTP bounds and batch refusal verified; source confirms strict schema, persisted step-up and draft insertion. A1 regressions passed after fixes below. |
| Promotions and order pricing | Uniform inaccessible-code errors; IP/account throttling and pause; verified e-mail and staff self-redemption; entitlement before cart tips; atomic redemption limits and cancellation before payment; combined discount guard; fragment-only sharing; log/CSV redaction and formula-safe export. | Shared log redaction and POST transport verified; throttling, redemption, and payment-fence findings below. |
| Cart upsell | Cart ownership and eligibility under lock; server-priced, active products only; safe retry and atomic changes; separate admin capability and default-off setting. | Preliminary source review: owned open cart locked; writes use server catalogue values. Catalogue freshness and replay intent findings below. |
| Policy acceptance log | Capability gates on all evidence reads; customer scope and safe projections; signer names only in authorized detail, never list/export; step-up, bounded and formula-safe CSV; no evidence mutation. | Pending implementation review. |

## Request telemetry

HTTP access logging uses method, route template, response status, timing, and request-correlation IDs rather than query or body contents. The tRPC error boundary logs procedure path, type, and the unexpected error's class, not its input. Shared structured redaction covers explicitly named promotion-code fields and the `promo` link field, plus recognized labelled values in strings. It preserves public promotion identifiers and customer-facing labels; generic diagnostic `code` remains available. Applications must still omit raw code values and complete promotion URLs from logs, including generic `code` fields the redactor cannot distinguish from diagnostic metadata.

The scoped redaction suite passed 22/22, including structured JSON, URL query and fragment examples, and plain-text diagnostic non-regression checks. Scoped lint and diff checks passed.

## Workflow import transport

The default HTTP JSON limit is 256 KiB. The exact unbatched POST routes `orders.admin.workflows.transfer.preview` and `orders.admin.workflows.transfer.applyImport` have a 4 MiB + 256 KiB envelope limit after origin admission, authoritative session resolution, and CSRF validation. This allows a 2 MiB JSON document as escaped text plus apply decisions. Comma-delimited calls and requests with a `batch` query parameter are refused when they target either procedure. The tRPC dependency reserves `apply`, so the procedure is named `applyImport` with no legacy alias. The direct HTTP suite passed 30/30 against synthetic tRPC routers; deployed proxy parity and semantic package validation are separate checks.

## Open findings

| ID | Severity | Finding and status |
| --- | --- | --- |
| G-C1-01 | High | `3cc511b`, `promotions/service.ts`: interactive previews skip rate consumption and failed-attempt accounting when passed a transaction, as the real order quote does. Direct raw-code redemption failures also are not counted. Place durable admission/accounting outside the business transaction, distinguishing user entry from passive rechecks. Do not reset the D3 failure window after a success, and normalize addresses before deriving limiter keys. |
| G-C1-02 | Medium | `3cc511b`, `promotions/service.ts`: the hard percentage guard rounds up at half cents; floor the guard and reserve half-up rounding for the discount calculation. Do not redeem a code that contributes no discount. Reuse freed ledger slots from current locking reads rather than allocating `count + 1`, which can reject valid redemptions after a non-last release. |
| G-C1-03 | Low | `3cc511b`, `promotions/service.ts`: the authorized code CSV builds links with `/#promo=…`, which the exact `/promo` bootstrap capture does not consume. Generate `/promo#promo=…` consistently. The step-up-gated, audited raw-code export is authorized by D3. |
| G-C3-02 | High | Scoped release rule: automatic and manual release both require definitive zero gross paid across all invoices, no payable invoice, and no provider attempt row ever created for the order, regardless of status. Missing evidence or any error keeps the redemption used; administrators can issue a replacement code instead. Verify the authoritative read under the order lock, with compatible lock ordering or a non-blocking fail-closed read; confirm a lock failure does not prevent cancellation or produce a false success. Require an integration check for failed, canceled, expired and ambiguous attempt rows, historical payment/refund, and concurrent attempt creation. Not closed until implementation and tests verify this rule. |
| G-B-01 | Medium | `7ffc405` binds replay to offer intent and re-evaluates the displayed suggestions under locks. The in-transaction calls still use `listActiveCatalog()` without a transaction (`cart/upsell.ts:691`, `cart/service.ts:1241`); the Orders implementation (`orders/catalog.ts:538–540`) uses `deps.db` and can exhaust a one-slot pool. Pass the transaction through and verify current catalogue data and pool behavior. |

## Resolved findings

- **G-A1-01 and G-A1-02, replay and parse bounds:** `529f4af` checks the supplied digest before replay and bounds traversal before enqueueing, without array spread. Published policy lookups run before the transaction to avoid borrowing a second connection while holding one. Concurrent withdrawal can leave a stale reference on a draft; runtime gate enforcement fails closed. Independently ran `workflowTransfer.test.ts`, 14/14, including the same-key invalid-digest replay and wide-document regressions.
- **G-C3-01, promo code in quote URL:** `5df8294` makes ordinary GET quotes strict and code-free. The customer wizard and staff dialog use `quoteWithPromo.mutate` in `fbbb126`, `55df1f0`, and `8e6e123`; order creation is also POST. `2571ac5` replaces the raw value in query keys with an opaque page-scoped revision and removes that page's promo queries when cleared.
- **G-C2-01, fragment captured after app startup:** `cd7eca6` and `187da97` capture on the exact `/promo` route and remove the fragment synchronously before `createRoot`. Existing analytics paths are limited to exact, fragment-free `/privacy` and `/terms`. These are source checks, not browser or vendor-log verification.

## Accepted residuals

- **Public API v1 replay archive:** API v1 does not accept promotion fields. If an admitted API caller manually supplies a promo value in an unsupported request, the existing exact-replay archive can retain their supplied bytes encrypted even though displayed request-log views apply structured redaction. Replay requires `api.replay` with step-up. This does not disclose a stored promotion value the API caller did not already submit. The lead accepted this residual; the replay archive is unchanged.

## Payment follow-ups outside the increment release fence

These references identify the code inspected in `76ad28d`; line numbers may move if the general payment changes are pared back. The lead deferred broader payment finality and invoice lifecycle work. It is not a substitute for verifying the narrower G-C3-02 rule.

- **Provider finality and late payment:** `server/modules/payments/service.ts:930–945,1697–1714` conflates payment-attempt failures or uncertain checkout creation with terminal provider state. Stripe's payment-intent failure fallback (`server/modules/payments/providers/stripe.ts:297–306`) and Square's individual payment failure handling (`server/modules/payments/providers/square.ts:104–106,168–178`) do not establish that the hosted checkout or order cannot take another payment. Define checkout-level closure evidence and how late paid events on canceled orders are reconciled.
- **Payment booking lock order:** `server/modules/payments/service.ts:1247–1267,1340` locks attempt and receipt before invoking Compliance booking, which acquires order and invoice. Standardize locks across finalization, webhook staging, reconciliation and Compliance, then test overlapping payment and invoice/order writes.
- **Invoice and checkout after cancellation:** `server/modules/compliance/invoicesService.ts:1210–1231` may establish a consistent snapshot before locking the order; the workflow gate then uses `server/modules/orders/orderService.ts:1521–1533`, which re-reads order status without locking. Define when issuance and checkout are allowed after cancellation and derive terminal status from the locked order row and its bound workflow, not a potentially stale snapshot.

## Not verified at this checkpoint

Acceptance Log server implementation, integrated checkout and cancellation concurrency, browser fragment scrubbing and analytics capture, installed-site/proxy logs, and live SIEM receipt. The workflow edge configuration test passed 3/3; this is not a running proxy check. The shared-tree full typecheck at this checkpoint was not clean, with diagnostics in in-progress Cart implementation and Cart/Promotions tests, not in Package G paths.
