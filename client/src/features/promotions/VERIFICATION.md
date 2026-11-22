# Promotions client — verification (C2)

| Check | Where | Result |
| --- | --- | --- |
| PromoCodeField, landing and saved-code helpers (focus after apply/remove, uniform error, live announcements, saved-code offer, fragment capture/strip, never a cookie, startup capture on exact `/promo` only) | `promoCode.test.tsx` | 30/30 |
| Admin: model validation (every D3 control), routes/capabilities, list (filters, masked codes, per-currency totals, staff read-only), pause/revoke confirm and focus after the row changes or leaves, settings validation with focus/announce, create (error summary, success focus, copy code/link), LABEL_MATCHES_CODE, edit locks, reveal focus, batch idempotency on retry, CSV export, release reason/refusal/focus | `promotionsAdmin.test.tsx` | 36/36 |
| axe light and dark: landing, field states, list, revoke dialog, new form (clean and with errors), detail (single), detail (batch + generate dialog), redemptions, release dialog | both files (`pageA11y`) | pass |
| Order activity: `promotion.redeemed` / `promotion.released` (payments, customer-visible label) | `server/modules/audit/orderActivity.test.ts` | 16/16 |
| Trigger catalogue: `promotion.redeemed`, `promotion.attempts_blocked` (staff-only, role recipients, no code fields) | `server/modules/audit/tap.test.ts` | 22/22 |

Not verified here:
- Real browser 320 px layout and screen-reader output. Stacked DataTable and the FilterBar drawer come from @/ui.
- Live server: the router mount and real step-up.
- That the startup capture precedes the analytics loader in a production build.
