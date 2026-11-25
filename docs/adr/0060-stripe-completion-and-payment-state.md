# 0060 — Stripe completion and order payment state

Status: Proposed (drafted from INCREMENT_07_CONTRACT.md; to be corrected against the owners' API.md as packages land)

## Context
The owner asked for the Stripe payment webhook to be completed "so orders can be completed". Hosted checkout and verified webhooks exist ([ADR 0035](0035-hosted-checkout-payments.md), [ADR 0038](0038-provider-refunds.md), [ADR 0054](0054-receipts.md)). The gap analysis found these blockers:
- the Stripe egress preset had no switch;
- `/invoices/:id` had no working "Pay online";
- bank debits (`completed` with `payment_status = unpaid`) were not handled;
- refunds missing from the event were not read;
- dashboard refunds without our metadata were not separated.

## Decision
- **Blockers fixed:**
  - the egress switch ([ADR 0058](0058-outbound-webhooks-and-operational-alerts.md)) is linked from the payments page, which shows its true state;
  - `/invoices/:id` gets **Pay online** and a return banner;
  - `completed` with `unpaid` answers 200 and waits for `async_payment_succeeded`;
  - refunds are read from `/v1/refunds` when the event omits them;
  - dashboard refunds without our metadata are flagged for staff and never booked automatically.
- **Order payment state.** `orders.payment_state` is one of `not_required | unpaid | pending_async | paid | partially_refunded | refunded`, with `paid_at`.
  - **Booking a payment.** One transaction books a verified payment, and in it:
    1. the cart becomes checked out;
    2. the order becomes paid;
    3. a phase with `completesOn: payment` completes, and the order advances (history reason `INVOICE_PAID`);
    4. the receipt is made as today;
    5. the payment triggers fire ([ADR 0057](0057-phase-actions-completion-rules.md)).

    Manual payments use the same path.
  - **Existing orders.** They are backfilled `paid` or `not_required` and are never gated retroactively.
- **Setup page** (`/admin/payments/setup`):
  - a checklist with the webhook URL and the nine events to subscribe;
  - the egress switch;
  - **Test Stripe API** and **Send self-test webhook**;
  - the last verified event;
  - a rejections log (`payment_webhook_rejections`: reason codes only, with no body, headers or addresses; kept 14 days);
  - a second signing-secret slot, for rotation and the Stripe CLI.

  The old Stripe card on `/admin/integrations` links here.
- **Route protection:**
  - the signed webhook route is exempt from the country allow-list only;
  - the IP deny list, rate limit and the 256 KiB cap stay;
  - a browser return never marks anything paid.
- **Not built.** Embedded card fields (Stripe Elements), and payment confirmation from the browser return.

## Assumptions to confirm with the owner
- The nine subscribed events are the set listed on the setup page.
- Refunds made in the Stripe dashboard are reviewed by staff, not booked automatically.

## Consequences
- A verified Stripe payment completes the order's payment phase without staff action.
- Card payments below Stripe's minimum still follow `payments.small_totals` ([ADR 0054](0054-receipts.md)).
