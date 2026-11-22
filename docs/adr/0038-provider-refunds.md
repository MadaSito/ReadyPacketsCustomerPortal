# 0038 — Refunds through the Stripe or Square refund API, with recorded refunds for manual payments (supersedes "refunds are manual" in 0035)

Status: Accepted (2026-11-21; owner confirmation requested)

## Context
ADR 0035 kept refunds and disputes manual. The owner now asks for a Refund button and refund capability on every console order (increment 04 part B, decision B5).

## Decision
- Capability `payments.refund`, held by administrators only, with fresh step-up. There is a Refund tab and a header button on every order.
- For each payment on the order's invoices, the tab shows the provider (Stripe, Square or manual), the amount captured, the amount already refunded and the refundable balance.
- "Prepare refund" takes:
  - an amount, full or partial, in minor units, never above the refundable balance (the server computes it under a row lock);
  - a required reason;
  - whether the customer gets a notice;
  - the typed phrase `REFUND ORDER`.
- Stripe and Square payments go through the provider's refund API:
  - The idempotency key is derived from the refund's public id.
  - The refund intent is committed as `pending` first. The provider call happens outside the database transaction, and the outcome is recorded as `succeeded`, `failed` or `unknown`.
  - An `unknown` refund is never resent automatically. A reconcile job asks the provider by idempotency key or refund id, and the provider's signed refund webhooks also update the record.
  - Provider calls are signed HTTPS requests through the egress policy, with no SDK, as in 0035.
- Manually recorded payments use "Record refund" (the existing `recordRefund`) in the same dialog, labelled "recorded only — no money is moved by the portal".
- Invoice and order payment states follow the refunds (`partially refunded`, `refunded`).
- Referral rewards tied to a fully refunded first invoice go to manual review.
- Every step writes an audit event (refund prepared / sent / failed). When notice is on, the customer e-mail (system template) is queued only after the refund is confirmed by the provider or a manual refund is recorded; mail delivery status is separate from refund status.
- No card data is stored or shown.

## Consequences
- The portal can now move money back to a customer, so the capability is limited to administrators and needs step-up and a typed phrase.
- An `unknown` outcome can leave a refund unconfirmed until reconciliation. Staff must not issue a second refund in the provider's dashboard while it is pending.
- This has not been exercised against real Stripe or Square accounts in development. The owner must test with provider test keys before relying on it.
- Disputes and chargebacks stay manual.
