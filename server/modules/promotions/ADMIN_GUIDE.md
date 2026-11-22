# Discount codes and links

Administrator guide chapter (increment 05, promotions module). Owner: `siem_engineer`. The feature ships switched off.

## Settings and permissions

Manage discount codes at `/admin/promotions` (designed and tested against WCAG 2.2 AA).

| Setting key | Default | Who can change it | Purpose |
| --- | --- | --- | --- |
| `feature.promotions` | Off (`false`) | Administrator (`promotions.manage` + step-up MFA) | Master switch for customer and console discount code entry, validation, and redemption. Switching on or off is audited (`promotion.settings_updated`). |
| `promotions.policy` (`maxDiscountPercent`) | `50`% | Administrator (`promotions.manage` + step-up MFA) | Global **Largest discount per order** hard ceiling (1%–100%, floored to minor units). Caps the combined bundle plus promotion discount so an order total is never negative. |

- **Staff (`promotions.read`)**: view promotions, derived statuses (`active`, `paused`, `revoked`, `scheduled`, `expired`, `exhausted`), redemptions, and aggregate totals. Code values are always masked (`SA••••20`).
- **Administrators (`promotions.manage` + fresh step-up MFA)**: create and update promotions, pause/resume/revoke, generate single-use batches, reveal a single code (`promotion.revealed`), manually release eligible unpaid cancelled redemptions (`promotion.released`), and export formula-safe CSV files (`promotion.exported`).

## Creating single codes and batches

1. Choose **Internal name** (operators only) and **Customer-facing label** (shown on the cart, order, and invoice instead of the secret code; must not match the code).
2. Choose **Percentage** (0.01%–100.00%, optional maximum discount cap) or **Fixed amount** (currency + minor units). Type, amount, percentage, and currency are immutable once created.
3. Configure **Scope** (`all`, selected products, packet tiers `Basic`/`Standard`/`Premium`, or packet numbers), **Minimum subtotal**, **Start / End UTC timestamps**, **Total limit**, **Per-customer limit** (default 1), **First order only** (requires zero prior historical orders for the customer, including cancelled orders), **Customer / e-mail domain allow-list**, and **Combine with bundle discount** (default off — customer receives whichever discount is larger; if the bundle discount equals or exceeds the code, the code is not consumed).
4. **Single code**: enter a 6–32 character code (`A–Z`, `0–9`, internal `-`) or leave blank to generate one from the unambiguous CSPRNG alphabet.
5. **Batch codes**: enable batch mode and generate up to 5,000 single-use codes per call (`promotions.admin.generateBatch`, optional uppercase prefix, 12 random unambiguous characters).
6. **Fragment links**: **Copy link** and CSV exports emit `/promo#promo=<CODE>` so the code stays in the URL fragment and never reaches HTTP access logs or `Referer` headers. Opening `/promo#promo=<CODE>` captures the code into browser session storage, clears the fragment, and offers the code in the cart and order wizard.

## Redemption, cancellation, and manual release (G-C3-02)

- Redemption runs atomically inside the MySQL order-creation transaction under row locks and unique keys on `(code, order)`, `(code, active_slot)`, `(batch, active_slot)`, and `(code, customer, active_slot)`. When a promotion contributes zero discount (for example, when a non-combinable bundle discount is larger or the global ceiling floors to zero), no redemption slot is consumed.
- **Strictly conservative release fence (automatic and manual)**: cancelling an order releases its redemption **only** when the order is in a terminal cancel state of its bound workflow version **and** compliance's authoritative exposure lock (`orderPaymentExposureInTx`) proves inside the transaction that:
  1. `grossPaidMinor === 0` across all invoices of the order;
  2. `payableInvoiceOpen === false` (no invoice is in an issued, open, or partially paid state);
  3. `providerCapturePending === false`; and
  4. `providerAttemptEver === false` (no online payment attempt row was ever created for the order in any status — including failed, cancelled, or expired attempts).
- **Paid, refunded, or attempted-payment orders**: if any partial or full payment ever occurred (including orders later refunded), if an open invoice exists, or if any provider payment attempt was ever started, the redemption **stays used**. To compensate a customer in that case, issue a new single-use code.
- **Manual release (`promotions.admin.releaseRedemption`)**: if an order was cancelled before any online payment attempt was ever started and an administrator subsequently voids an unpaid invoice so all four zero-exposure conditions hold, the administrator may release the redemption from `/admin/promotions` with step-up MFA and a required reason.

## Abuse controls and SIEM telemetry

- Code application (`cart.applyCode`, `orders.quoteWithPromo`, `orders.create`, and `orders.admin.createForCustomer` via `services.promotions.guardAttempt` / `preview`) uses server-computed prices exclusively (no client-priced code check endpoint is exposed) and is rate-limited per account and per blind-indexed normalized IPv4 / IPv6 `/64` address.
- After **any 5 failed checks within 15 minutes** (including failures from rolled-back order submissions, and even if a valid preview occurred in between), code checks for that account pause for 15 minutes (`PROMO_ATTEMPTS_BLOCKED`) and emit `promotion.attempts_blocked` (`WARN`), which forwards to configured SIEM/syslog sinks.
- Unknown, paused, revoked, scheduled, expired, exhausted, and unentitled codes all return the uniform message `"This code cannot be applied."` Cart hints (minimum subtotal or eligible items) appear only after customer entitlement succeeds.
- Customer e-mail must be verified; staff and administrators cannot redeem codes for their own accounts. Raw code strings are encrypted at rest, looked up by HMAC blind index, and never written to logs or audit records.
