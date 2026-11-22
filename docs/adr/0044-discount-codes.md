# 0044 — Discount codes and links with atomic redemption, a global discount guard and uniform refusals

Status: Accepted (2026-11-22; owner confirmation requested)

## Context
The owner asks for discount codes for orders: the administrator hands out codes or links with an expiry and other controls that minimise abuse (increment 05, decision D3).

## Decision
- **Module and switch.** The new module is `server/modules/promotions`, with the client in `client/src/features/promotions`. It sits behind the setting `feature.promotions`, which is off by default; switching it on is audited.
- **A code definition** has:
  - an internal name, and a customer-facing label that is shown on the order and invoice instead of the code;
  - a type: `percent` (0.01–100%, with an optional maximum amount) or `fixed` (an amount and currency);
  - a scope: all products, chosen products, tiers or packet numbers;
  - limits: a minimum subtotal, a start and end time, a maximum number of redemptions in total and per customer (default 1), first order only, and an allow-list of customers or e-mail domains;
  - "may be combined with the bundle discount", which defaults to no;
  - a status (`active`, `paused` or `revoked`, plus the derived `scheduled`, `expired` and `exhausted`) and a note.
- **Codes.** An administrator chooses a code (6–32 characters, A–Z, 0–9 and hyphen, normalised to upper case) or has one generated.
  - Batches hold up to 5,000 single-use codes drawn from the CSPRNG, from an alphabet without ambiguous characters, with at least 12 characters after an optional prefix.
  - Codes are looked up by a keyed hash. The value is stored with field encryption so an administrator can see it again, and staff with `promotions.read` see masked codes.
- **Links.** "Copy link" carries the code in the URL fragment, so it does not reach server access logs or referrers.
  - Opening the link stores the code in session storage for this browser session and shows "Code saved — it is applied when you place an order".
  - The code survives sign-in and registration and is offered in the cart and the order wizard.
  - A link never applies anything silently and never bypasses a rule.
- **Pricing.**
  - The bundle discount is applied first.
  - A percent code then applies to the eligible lines (after the bundle discount when combining is allowed), rounded half up to whole minor units. A fixed code is capped at the eligible amount.
  - When combining is not allowed, the larger of the bundle discount and the code wins and the other is not applied.
  - The setting "Largest discount per order" (default 50%, up to 100%, changed only by an administrator with step-up) caps the combined discount, and a total is never negative.
  - Tax is computed after discounts.
- **Atomic redemption.** Redemption happens inside the order-creation transaction through the promotions port (`preview`, `redeemInTx`, `releaseForOrderInTx`).
  - The code row is locked and the limits are counted again. Then the redemption and the order are written together, or nothing is written.
  - Unique keys on (code, order) and (code, customer, sequence) prevent double use under concurrency.
  - **Release fails closed.** A redemption can be released, automatically on cancellation or manually, only when all three of the following hold. They are checked under the order lock, in the cancellation transaction or in the manual release transaction, through compliance's exposure read (`orderPaymentExposureInTx`):
    1. gross paid is 0 across the order's invoices;
    2. no invoice of the order is payable (issued, open or partially paid);
    3. no provider payment attempt has ever been created for the order, whatever its status, including failed, cancelled, expired and ambiguous attempts.
  - In every other case the redemption stays used and the cancellation still succeeds. That includes an error, a missing port, and a lock timeout or deadlock on the exposure read. Release never depends on a provider saying a payment is final.
  - **Manual release.** `promotions.admin.releaseRedemption` needs `promotions.manage`, step-up and a reason, and is audited as `promotion.released` with the actor. It is subject to the same three conditions.
  - **Compensation.** To compensate a customer whose redemption cannot be released, an administrator issues a new code.
  - A redemption stays used after a refund.
- **Abuse controls.**
  - Every code check is rate limited per account and per address. After 5 failed checks in 15 minutes, the account is paused from checking codes for 15 minutes, and the event `promotion.attempts_blocked` is sent to the SIEM as a warning.
  - Every reason a code cannot be used gets the same message: "This code cannot be applied." Cart-specific hints, such as the minimum subtotal, appear only for a code the customer is entitled to.
  - The customer's e-mail must be verified. Staff and administrators cannot redeem codes for themselves.
  - A code is never logged. Audit events carry its public id and label.
- **Where codes apply.**
  - Customers enter codes in the cart and in the direct order wizard, through the same component.
  - Staff creating an order for a customer may enter a code, and eligibility is judged for the customer.
  - API v1 order creation does not accept codes.
  - If a code stops being valid between applying it and placing the order, the order is not placed and the customer confirms the new total.
- **Administration.** Staff with `promotions.read` can view the pages. Administrators with `promotions.manage` and step-up can manage codes:
  - list with filters, create and edit, generate batches, copy a code or link;
  - pause, resume and revoke;
  - view redemptions and totals;
  - export codes and redemptions as CSV (formula-safe, step-up, audited).

## Assumptions to confirm with the owner
- When a code cannot be combined with the bundle discount, the larger discount wins by default.
- The global guard defaults to 50% per order.
- A redemption stays used after a refund. It is released only when nothing was paid, no invoice is payable and no provider payment attempt ever existed. Otherwise the administrator issues a new code.
- API v1 order creation does not accept codes in this increment.

## As implemented

Packages C1/C2 and B, as reported by the owners:

- **Link format:** `https://<portal>/promo#promo=<CODE>`. The client keeps the code in `sessionStorage` under `rp.promotions.savedCode` and strips the fragment before routing.
- **Settings:**
  - `feature.promotions` (default off);
  - `promotions.policy.maxDiscountPercent` (default 50).
- **Pages:**
  - `/admin/promotions` (with `/new`, `/redemptions`, `/:promotionId` and `/:promotionId/edit`), under Operations → Discount codes;
  - `/promo` (public);
  - the code field on `/cart` and `/cart/checkout`.
- **Procedures:**
  - `promotions.admin.{list,get,stats,create,update,pause,resume,revoke,generateBatch,reveal,redemptions,releaseRedemption,exportCodes,exportRedemptions,getSettings,updateSettings}`;
  - `cart.applyCode` and `cart.removeCode`.
- **Manual release:** needs a reason of at least 5 characters, and the client shows the server's refusal as returned.
- **Stale code at checkout:** returns `PROMO_RECONFIRM_TOTAL`, and the order is not placed.
- **Cart code storage:** the code is stored encrypted on the cart (`promo_code_enc`).

## Consequences
- The uniform refusal message makes customer support harder, by design. Staff can see the exact reason in the console.
- Session storage means a saved code is lost when the browser session ends.
- Some customers whose order is cancelled after a payment attempt keep a used redemption. This is deliberate: payment finality is not rebuilt in this increment. Late payments on cancelled orders and the related lock-ordering questions are follow-ups in `docs/security/INCREMENT_05_REVIEW.md`.
