# Increment 05 security review

Scope: Package G review against `docs/engineering/INCREMENT_05_CONTRACT.md`, decisions D1–D4 and abuse cases in §4. This is a source and regression review, not a penetration test or production sign-off. The initial checkpoint records the baseline and separates pending implementation review from verified controls.

## Review matrix

| Area | Security checks | Status |
| --- | --- | --- |
| Workflow transfer | Bounded and strict parsing (size, depth, key safety, duplicate keys); recomputed digest as integrity only; reference mapping; no secrets or customer data on export; import capability, live step-up, replay safety, and draft-only persistence. | Pending implementation review. |
| Promotions and order pricing | Uniform inaccessible-code errors; IP/account throttling and pause; verified e-mail and staff self-redemption; entitlement before cart tips; atomic redemption limits and cancellation before payment; combined discount guard; fragment-only sharing; log/CSV redaction and formula-safe export. | Shared log redaction reviewed; module, cart, orders, and client integration still pending. |
| Cart upsell | Cart ownership and eligibility under lock; server-priced, active products only; safe retry and atomic changes; separate admin capability and default-off setting. | Pending implementation review. |
| Policy acceptance log | Capability gates on all evidence reads; customer scope and safe projections; signer names only in authorized detail, never list/export; step-up, bounded and formula-safe CSV; no evidence mutation. | Pending implementation review. |

## Request telemetry

HTTP access logging uses method, route template, response status, timing, and request-correlation IDs rather than query or body contents. The tRPC error boundary logs procedure path, type, and the unexpected error's class, not its input. Shared structured redaction covers explicitly named promotion-code fields and the `promo` link field, plus recognized labelled values in strings. It preserves public promotion identifiers and customer-facing labels; generic diagnostic `code` remains available. Applications must still omit raw code values and complete promotion URLs from logs, including generic `code` fields the redactor cannot distinguish from diagnostic metadata.

The scoped redaction suite passed 22/22, including structured JSON, URL query and fragment examples, and plain-text diagnostic non-regression checks. Scoped lint and diff checks passed.

## Accepted residuals

- **Public API v1 replay archive:** API v1 does not accept promotion fields. If an admitted API caller manually supplies a promo value in an unsupported request, the existing exact-replay archive can retain their supplied bytes encrypted even though displayed request-log views apply structured redaction. Replay requires `api.replay` with step-up. This does not disclose a stored promotion value the API caller did not already submit. The lead accepted this residual; the replay archive is unchanged.

## Not verified at this checkpoint

Feature implementation, integrated checkout and cancellation concurrency, browser fragment scrubbing and analytics capture, installed-site/proxy logs, and live SIEM receipt. Later entries should distinguish owner-reported tests from independently executed checks.
