# 0060 — Stripe completion and order payment state

Status: Accepted (2026-11-25, after the lead's integrated QA of increment 07 at `7c6bb71`; verification in [STATUS.md](../application-context/STATUS.md#verification-for-increment-07))

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

## As implemented

From the owner's [payments API](../../server/modules/payments/API.md) and [admin guide](../../server/modules/payments/ADMIN_GUIDE.md), and the lead's QA rulings:

- **Activation.** Turning Stripe on needs three things for the current staged key and mode, matched by fingerprint: the egress preset, a successful API check and a self-test. It also needs a confirmation dialog, and live mode needs the typed words `ACTIVATE LIVE PAYMENTS`. A refusal gives `STRIPE_EGRESS_NOT_ALLOWLISTED`, `STRIPE_API_NOT_VERIFIED` or `STRIPE_WEBHOOK_NOT_VERIFIED`.
- **Events.** The nine events are `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.payment_failed`, `charge.refunded`, `refund.created`, `refund.updated` and `charge.refund.updated`.
- **Unmatched payments.** A paid session that carries portal metadata but matches no order is recorded as `attention_required`, with a warning alert (`UNMATCHED_PORTAL_PAYMENT`).
- **Rejections.** The log keeps reason codes only and is pruned after 14 days. A non-JSON body (400) or one over 256 KiB (413) stops at the HTTP layer and is not in the rejection log.
- **Rotation.** A secondary signing secret is accepted alongside the primary one.
- **Lead QA.** In a browser, the lead checked the setup page gates, a fake-key API test failing gracefully with 401, a signed webhook end to end with a locally signed event, and the rejection log. No real Stripe account was used.

## Assumptions to confirm with the owner
- The nine subscribed events are the set listed on the setup page.
- Refunds made in the Stripe dashboard are reviewed by staff, not booked automatically.

## Consequences
- A verified Stripe payment completes the order's payment phase without staff action.
- Card payments below Stripe's minimum still follow `payments.small_totals` ([ADR 0054](0054-receipts.md)).
