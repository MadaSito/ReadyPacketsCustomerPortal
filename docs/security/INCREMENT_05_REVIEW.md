# Increment 05 security review

Scope: Package G review against `docs/engineering/INCREMENT_05_CONTRACT.md`, decisions D1–D4 and abuse cases in §4. This is a source and regression review, not a penetration test or production sign-off. The initial checkpoint records the baseline and separates pending implementation review from verified controls.

## Review matrix

| Area | Security checks | Status |
| --- | --- | --- |
| Workflow transfer | Bounded and strict parsing (size, depth, key safety, duplicate keys); recomputed digest as integrity only; reference mapping; no secrets or customer data on export; import capability, live step-up, replay safety, and draft-only persistence. | HTTP bounds and batch refusal verified; package semantics pending. |
| Promotions and order pricing | Uniform inaccessible-code errors; IP/account throttling and pause; verified e-mail and staff self-redemption; entitlement before cart tips; atomic redemption limits and cancellation before payment; combined discount guard; fragment-only sharing; log/CSV redaction and formula-safe export. | Shared log redaction reviewed; module, cart, orders, and client integration still pending. |
| Cart upsell | Cart ownership and eligibility under lock; server-priced, active products only; safe retry and atomic changes; separate admin capability and default-off setting. | Pending implementation review. |
| Policy acceptance log | Capability gates on all evidence reads; customer scope and safe projections; signer names only in authorized detail, never list/export; step-up, bounded and formula-safe CSV; no evidence mutation. | Pending implementation review. |

## Request telemetry

HTTP access logging uses method, route template, response status, timing, and request-correlation IDs rather than query or body contents. The tRPC error boundary logs procedure path, type, and the unexpected error's class, not its input. Shared structured redaction covers explicitly named promotion-code fields and the `promo` link field, plus recognized labelled values in strings. It preserves public promotion identifiers and customer-facing labels; generic diagnostic `code` remains available. Applications must still omit raw code values and complete promotion URLs from logs, including generic `code` fields the redactor cannot distinguish from diagnostic metadata.

The scoped redaction suite passed 22/22, including structured JSON, URL query and fragment examples, and plain-text diagnostic non-regression checks. Scoped lint and diff checks passed.

## Workflow import transport

The default HTTP JSON limit is 256 KiB. The exact unbatched POST routes `orders.admin.workflows.transfer.preview` and `orders.admin.workflows.transfer.applyImport` have a 4 MiB + 256 KiB envelope limit after origin admission, authoritative session resolution, and CSRF validation. This allows a 2 MiB JSON document as escaped text plus apply decisions. Comma-delimited calls and requests with a `batch` query parameter are refused when they target either procedure. The tRPC dependency reserves `apply`, so the procedure is named `applyImport` with no legacy alias. The direct HTTP suite passed 30/30 against synthetic tRPC routers; deployed proxy parity and semantic package validation are separate checks.

## Open findings

| ID | Severity | Finding and status |
| --- | --- | --- |
| G-C3-01 | High | In `ce15ead`, `orders.quote` accepts a raw `promoCode` but uses tRPC GET. The browser transport can include that code in the URL's `input` query parameter. Orders is moving code-bearing quotes to a dedicated POST mutation; pending fix review. |
| G-C3-02 | High | In `ce15ead`, cancellation can release a use when the payment provider or payment result is absent. Orders is changing this to require a definitive unpaid/void payment result. The release/settlement ordering still needs review. |
| G-C2-01 | Low | The fragment is stripped by a lazily loaded landing component in `198e593`, not before route initialization. The existing analytics vendor paths are limited to exact, fragment-free `/privacy` and `/terms`, so no vendor exposure was established. A bootstrap change is recommended and pending owner review. |

## Accepted residuals

- **Public API v1 replay archive:** API v1 does not accept promotion fields. If an admitted API caller manually supplies a promo value in an unsupported request, the existing exact-replay archive can retain their supplied bytes encrypted even though displayed request-log views apply structured redaction. Replay requires `api.replay` with step-up. This does not disclose a stored promotion value the API caller did not already submit. The lead accepted this residual; the replay archive is unchanged.

## Not verified at this checkpoint

Feature implementation, integrated checkout and cancellation concurrency, browser fragment scrubbing and analytics capture, installed-site/proxy logs, and live SIEM receipt. Later entries should distinguish owner-reported tests from independently executed checks.
