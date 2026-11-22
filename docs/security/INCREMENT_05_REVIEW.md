# Increment 05 security review

Scope: Package G review against `docs/engineering/INCREMENT_05_CONTRACT.md`, decisions D1–D4 and abuse cases in §4. This is a defensive source and regression review, not a penetration test or production sign-off. Open findings describe the revisions reviewed, not necessarily the latest owner work in progress.

## Review matrix

| Area | Security checks | Status |
| --- | --- | --- |
| Workflow transfer | Bounded and strict parsing (size, depth, key safety, duplicate keys); recomputed digest as integrity only; reference mapping; no secrets or customer data on export; import capability, live step-up, replay safety, and draft-only persistence. | HTTP bounds and batch refusal verified; source confirms strict schema and draft insertion, with replay and parse-boundary findings below. |
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
| G-A1-01 | Medium | `8021600`, `workflowTransferService.ts`: replay lookup can return success before declared-digest validation. Move digest rejection before replay and cover an invalid declared digest with a previously used idempotency key. |
| G-A1-02 | Medium | `8021600`, `workflowTransfer.ts`: array spread can throw before the node limit. Traverse incrementally with a bounded queue or stack; verify wide input gets a controlled validation response. Also pass the transaction to local policy lookups to avoid borrowing a second pool connection during apply. |
| G-C1-01 | High | `3cc511b`, `promotions/service.ts`: interactive previews skip rate consumption and failed-attempt accounting when passed a transaction, as the real order quote does. Direct raw-code redemption failures also are not counted. Place durable admission/accounting outside the business transaction, distinguishing user entry from passive rechecks. Do not reset the D3 failure window after a success, and normalize addresses before deriving limiter keys. |
| G-C1-02 | Medium | `3cc511b`, `promotions/service.ts`: the hard percentage guard rounds up at half cents; floor the guard and reserve half-up rounding for the discount calculation. Do not redeem a code that contributes no discount. Reuse freed ledger slots from current locking reads rather than allocating `count + 1`, which can reject valid redemptions after a non-last release. |
| G-C3-02 | High | `1527003` correctly requires definitive zero gross paid, no payable invoice, and no pending capture. Downstream evidence and later-payment fences still need verification: exact cancellation-key guards do not cover all workflow-defined terminal cancellations; a locally canceled provider attempt is not proof that capture is impossible; missing provider evidence must not default to no pending capture. Check lock order against all issue, provider-start and booking paths. |
| G-B-01 | Medium | Preliminary Cart source: the mutation locks the owned open cart and uses server prices, but reads the catalogue and bundle rule before opening its transaction. Re-read and verify freshness when applying. Reuse of the same idempotency key for a different offer currently reports success without applying that offer; bind replay to offer intent. |

## Resolved by source review

- **G-C3-01, promo code in quote URL:** `5df8294` makes ordinary GET quotes strict and code-free. The customer wizard and staff dialog use `quoteWithPromo.mutate` in `fbbb126`, `55df1f0`, and `8e6e123`; order creation is also POST. The wizard still keeps the raw code in its in-memory query key. No query persistence was located; prefer an opaque component-local revision or no promo quote cache.
- **G-C2-01, fragment captured after app startup:** `cd7eca6` and `187da97` capture on the exact `/promo` route and remove the fragment synchronously before `createRoot`. Existing analytics paths are limited to exact, fragment-free `/privacy` and `/terms`. These are source checks, not browser or vendor-log verification.

## Accepted residuals

- **Public API v1 replay archive:** API v1 does not accept promotion fields. If an admitted API caller manually supplies a promo value in an unsupported request, the existing exact-replay archive can retain their supplied bytes encrypted even though displayed request-log views apply structured redaction. Replay requires `api.replay` with step-up. This does not disclose a stored promotion value the API caller did not already submit. The lead accepted this residual; the replay archive is unchanged.

## Not verified at this checkpoint

Acceptance Log server implementation, integrated checkout and cancellation concurrency, browser fragment scrubbing and analytics capture, installed-site/proxy logs, and live SIEM receipt. Later entries should distinguish owner-reported tests from independently executed checks.
