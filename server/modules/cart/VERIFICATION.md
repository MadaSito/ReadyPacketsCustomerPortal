# Cart, Cart Suggestions & Discount Codes — Verification Record (Increments 04 & 05)

Owner: `recovery_ops_engineer` (`server/modules/cart/**`, `client/src/features/cart/**`)

## 1. Commands Executed & Verified on `feat/increment-05`

- **TypeScript (`scripts/dev/tc.sh`):**
  - Clean (`0` errors) across the entire monorepo (`server`, `client`, `shared`).
- **Server integration & abuse-case suites (real MySQL + real `OrdersModule` + real `ComplianceModule`):**
  - `scripts/dev/test.sh server/modules/cart/cart.test.ts` — **7/7 passing** (Increment 04 baseline invariants, authz matrix, CAS, AES-256-GCM field encryption, atomic checkout, read-only payment return, cancel/restore, abandoned-cart expiry worker).
  - `scripts/dev/test.sh server/modules/cart/cartUpsellPromo.test.ts` — **5/5 passing** (Increment 05 Package B):
    1. 5-actor authorization matrix for `cart.admin.upsells.*` (`staffProcedure.use(requireCapability("carts.upsells.manage"))` enforced before `.input()` parsing so empty `{}` payloads return `UNAUTHORIZED` / `FORBIDDEN`, plus service-side defence in depth), `cart.upsell.accept`/`dismiss` (`feature.cart.upsell` default off -> `NOT_FOUND:CART_UPSELL_DISABLED`), and `cart.applyCode`/`removeCode` (`feature.promotions` gate).
    2. Cart upsells (D2 / ADR 0043): plain-text validation & tier-upgrade target validation (`canBeTierUpgradeTarget`), priority ordering + max-3 cap + automatic `bundle_completion` at priority 50, single-impression-per-cart `shownCount`, dismissal persistence (`dismissedCount`), idempotent `acceptUpsell` + `CONFLICT:IDEMPOTENCY_KEY_REUSED` on mismatched reuse, conflict suppression, and live catalog `FOR SHARE` protection when a target product is deactivated or repriced mid-cart.
    3. Discount codes in cart (D3 / ADR 0044): AES-256-GCM encryption of `promo_code_enc` at rest, zero raw code strings in structured logs or audit attributes, `larger_only` comparison against bundle discount, automatic re-check on `cart.get` (`promoNotice`), `CONFLICT:PROMO_RECONFIRM_TOTAL` at `cart.checkout` (**order not placed** when code expires before checkout, followed by clean order placement on reconfirmation), and atomic `promoCode` pass-through to `orders.createOrderFromCheckoutInTx`.
    4. Single-connection MySQL pool (`connectionLimit: 1`) regression: verifies `cart.get`, `cart.applyCode`, and `cart.upsell.accept` execute `orders.listActiveCatalog(tx, { forShare: true })` strictly on `tx` without pool self-deadlock.
    5. Zero-total checkout (`100%` code with real `PromotionsModule` `maxDiscountPercent: 100`): verifies `cart.checkout` skips `payments.startCheckout`, commits `carts.status = "checked_out"` with `payment_mode: "no_payment_due"` in `cart.checked_out` audit, replays idempotently, reports `confirmationState: "no_payment_due"`, and refuses `restoreCheckout` with `CONFLICT:CHECKOUT_ALREADY_PAID`.
- **Client UI & WCAG 2.2 AA accessibility suites (run one file at a time via `scripts/dev/test.sh`):**
  - `client/src/features/cart/CartPage.test.tsx` — **9/9 passing** (`pageA11y` light & dark).
  - `client/src/features/cart/CheckoutPages.test.tsx` — **11/11 passing** (`pageA11y` light & dark, zero client totals sent on checkout).
  - `client/src/features/cart/AdminOpenCartsPage.test.tsx` — **11/11 passing** (`pageA11y` light & dark, route & capability manifest assertions including `/admin/carts/suggestions`).
  - `client/src/features/cart/CartUpsellPromo.test.tsx` — **11/11 passing** (`pageA11y` light & dark on `/cart` with upsells + applied promo + notice, `/cart/checkout` with `PromoCodeField`, and `/checkout/return` zero-total `no_payment_due` confirmation `"Nothing to pay - your discount covers this order"`; WCAG 2.5.3 Label-in-Name assertions; deterministic focus movement + non-stealing async focus guard + failure focus restoration; `PROMO_RECONFIRM_TOTAL` checkout reconfirmation flow; zero-total checkout -> confirmation flow).
  - `client/src/features/cart/AdminCartUpsellsPage.test.tsx` — **8/8 passing** (`pageA11y` light & dark on `/admin/carts/suggestions` list, open Create `Dialog` with `Trigger products` `<fieldset><legend>`, and open Delete `ConfirmDialog`; `StatCard` counters, `FilterBar`, `tier_upgrade` target product filtering, and Create/Update/SetActive/Delete mutations).
- **ESLint (`./node_modules/.bin/eslint server/modules/cart client/src/features/cart --max-warnings 0`):**
  - `0` errors, `0` warnings.

## 2. What Used Controlled Fakes in Unit/Integration Tests

- In `server/modules/cart/cartUpsellPromo.test.ts`, MySQL transactions, `OrdersModule` (including `listActiveCatalog(tx, { forShare: true })` and `createOrderFromCheckoutInTx`), and `ComplianceModule` are **real**; `PromotionsModule` uses a stateful contract fake (`preview` + `redeemInTx`) to deterministically toggle code expiry mid-checkout, while real promotions DB/redemption concurrency is tested in `server/modules/promotions/`.
- Client tests mock `@/lib/trpc` in JSDOM and run `axe-core` (`pageA11y`) in both light and dark themes (designed and tested against WCAG 2.2 AA).
