# Cart, Cart Suggestions & Discount Codes — Verification Record (Increments 04–06)

Owner: `recovery_ops_engineer` (`server/modules/cart/**`, `client/src/features/cart/**`)

## 1. Commands Executed & Verified on `feat/increment-06`

- **TypeScript (`scripts/dev/tc.sh`):**
  - Clean (`0` errors) across the entire monorepo (`server`, `client`, `shared`).
- **Server integration & abuse-case suites (real MySQL + real `OrdersModule` + real `ComplianceModule` + real `PromotionsModule`):**
  - `scripts/dev/test.sh server/modules/cart/cart.test.ts` — **7/7 passing** (Increment 04 baseline invariants, authz matrix, CAS, AES-256-GCM field encryption, atomic checkout, read-only payment return, cancel/restore, abandoned-cart expiry worker).
  - `scripts/dev/test.sh server/modules/cart/cartUpsellPromo.test.ts` — **5/5 passing** (Increment 05 Package B: 5-actor authz matrix, upsell evaluation & lock ordering, `FOR SHARE` single-connection pool regression, AES-256-GCM promo encryption, `PROMO_RECONFIRM_TOTAL`, and zero-total checkout).
  - `scripts/dev/test.sh server/modules/cart/cartIncrement06.test.ts` — **6/6 passing** (Increment 06 Package D):
    1. Legacy/corrupt stored setting resilience for `cart.upsell_seeded_keys` (`parseCartUpsellSeededKeysSetting` handles `undefined`, `null`, primitives, malformed objects, duplicate keys, blank strings, and overlong entries without throwing).
    2. Pre-input router authorization on all new D3 admin procedures (`setFeature`, `setAllActive`, `seedSuggested`, `duplicate` reject anonymous with `401 UNAUTHORIZED` and customer/unprivileged staff with `403 FORBIDDEN` before `.input()` validation).
    3. Decision D3: deterministic starter seeding across all 4 categories (`tier_upgrade`, `bundle_completion`, `next_packet`, `add_on`) with `active = false`, idempotent re-seeding, non-destructive preservation of admin edits and deletions on startup, `seedSuggested` restoring missing starter rows disabled, `setFeature` (`feature.cart.upsell` + optional `feature.cart`), `setAllActive`, `duplicate`, and live `bundle_completion` evaluation.
    4. Decision D5: two-decimal percentage discounts (`12.50%`), `PROMO_LIMIT_MAX_PERCENT` notice & `PROMO_RECONFIRM_TOTAL` checkout block when limits are lowered, `set_total` (`$0.40` and `$0.00`), `payments.small_totals` `"block"` (`AMOUNT_BELOW_PROVIDER_MINIMUM` full rollback) and `"waive"` (`waived_small_total` receipt + `waivedMinor` status + `CHECKOUT_ALREADY_PAID` restore guard), and Wave-2 `zero_total` settled receipt.
    5. Decision D14 (+ D11 signature check): `orders.gates.assertCustomerMayPlaceOrder` enforced inside `cart.checkout`, rolling back on `CONFLICT:AGREEMENT_REQUIRED` (`{ policyPublicId, signatureMode }`), rejecting mismatched typed signature (`SIGNER_NAME_MISMATCH`), and placing the order cleanly once accepted.
    6. Decision D5 Phase 1 / Phase 2 waiver consistency regression (against real `PaymentsService` + `ComplianceModule` + `PromotionsModule` + `OrdersModule` + MySQL): verifies `checked_out_waived_minor` is `0` and `status` is `awaiting_payment` after a Phase 2 failure before settlement; retry settles and reconciles once; flipping `payments.small_totals` (`waive -> block`, lowered minimum `-> redirect`) or provider (`stripe -> none` invoice) before settlement never claims a fake waiver; and flipping `payments.small_totals` or provider after actual settlement (including crash-before-cart-update recovery) returns the ledger-settled `waived_small_total` outcome on idempotent replay.
- **Client UI & WCAG 2.2 AA accessibility suites (run one file at a time via `scripts/dev/test.sh`):**
  - `client/src/features/cart/CartPage.test.tsx` — **9/9 passing** (`pageA11y` light & dark).
  - `client/src/features/cart/CheckoutPages.test.tsx` — **15/15 passing** (`pageA11y` light & dark, zero client totals sent on checkout, D5 small-total waive/block notices & waived confirmation, D14 `AGREEMENT_REQUIRED` modal acceptance + automatic checkout retry).
  - `client/src/features/cart/AdminOpenCartsPage.test.tsx` — **11/11 passing** (`pageA11y` light & dark, route & capability manifest assertions including `/admin/carts/suggestions`).
  - `client/src/features/cart/CartUpsellPromo.test.tsx` — **11/11 passing** (`pageA11y` light & dark on `/cart`, `/cart/checkout`, and `/checkout/return` `"Nothing to pay — your discount covers this order."`, focus management, `PROMO_RECONFIRM_TOTAL`, and zero-total checkout).
  - `client/src/features/cart/AdminCartUpsellsPage.test.tsx` — **11/11 passing** (`pageA11y` light & dark on `/admin/carts/suggestions`, `"Show suggestions in the cart"` switch + `"Turn on shopping cart as well?"` dialog, per-row `<Switch>`, `Enable all`, `Disable all`, `Add suggested offers`, `Duplicate`, and Create/Edit/Delete flows).
- **ESLint (`./node_modules/.bin/eslint server/modules/cart client/src/features/cart --max-warnings 0`):**
  - `0` errors, `0` warnings.

## 2. What Used Controlled Fakes in Unit/Integration Tests

- In `server/modules/cart/cartUpsellPromo.test.ts`, MySQL transactions, `OrdersModule` (including `listActiveCatalog(tx, { forShare: true })` and `createOrderFromCheckoutInTx`), and `ComplianceModule` are **real**; `PromotionsModule` uses a stateful contract fake (`preview` + `redeemInTx`) to deterministically toggle code expiry mid-checkout, while real promotions DB/redemption concurrency is tested in `server/modules/promotions/`.
- Client tests mock `@/lib/trpc` in JSDOM and run `axe-core` (`pageA11y`) in both light and dark themes (designed and tested against WCAG 2.2 AA).
