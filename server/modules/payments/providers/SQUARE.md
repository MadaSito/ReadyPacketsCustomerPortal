# Square hosted checkout

Square is optional. Leave the provider set to Pay by invoice until staging checkout and booking are verified. Use Console → Payments to choose the environment and enter the corresponding Square location ID, access token, and webhook signature key. Configure an exact Square egress allowlist rule for `connect.squareupsandbox.com` (test) or `connect.squareup.com` (live); no custom API hosts are accepted by the adapter.

Register the exact HTTPS notification URL displayed in the console and subscribe to `payment.created`, `payment.updated`, `refund.created`, and `refund.updated`. The verifier binds the configured URL and raw request bytes using Square's HMAC-SHA256 mechanism, checks `square-environment`, and enforces the portal's configured freshness window (at most five minutes) ([Square webhook validation](https://developer.squareup.com/docs/webhooks/step3validate), [Square refund webhooks](https://developer.squareup.com/docs/refunds-api/webhooks)).

The adapter creates a hosted [Square Order Checkout](https://developer.squareup.com/docs/checkout-api/square-order-checkout) with a single fixed-price line and portal references. Before the service can consider a verified webhook for booking, the adapter retrieves the payment link, order, and payment over the selected environment's pinned API. It checks their identities, the order's bound invoice and attempt references, exact amount and currency, and the absence of tips or refunds. A missing or pending payment is not paid. Browser returns do not confirm payment ([Square payment retrieval](https://developer.squareup.com/docs/payments-api/retrieve-payments)).

Protocol tests use an in-process fake and synthetic credentials. They do not confirm Square Sandbox or production account setup. Use the sandbox account to verify a successful booking, rejection of duplicate or mismatched events, and an inert return. Never put access tokens, signing keys, customer payment payloads, or real card data in logs or tickets.

## Refunds

The adapter sends [RefundPayment](https://developer.squareup.com/reference/square/refunds-api/refund-payment) only for the linked original payment, with deterministic key `rp-refund-<refundPublicId>` and opaque reason `ReadyPackets refund <refundPublicId>`. It never sends the operator's reason or attempts an unlinked refund. `PENDING` preserves the reservation; a timeout, response mismatch, or ambiguous error remains unknown. Never issue another refund to resolve an unknown outcome.

Reconciliation is read-only. It retrieves the known refund ID or enumerates the original payment's bounded `refund_ids` and requires an exact marker, payment, amount, and currency match ([Square refund retrieval](https://developer.squareup.com/docs/refunds-api/retrieve-refunds)). An absent match after an uncertain POST is not treated as proof it never happened. Refund webhook hints must be checked against the provider before the portal updates the ledger.
