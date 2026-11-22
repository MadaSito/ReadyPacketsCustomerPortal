# Cart & Checkout Module API (Increments 04 & 05 — Package L & Package B)

Owner: `recovery_ops_engineer` (`server/modules/cart/**`, `client/src/features/cart/**`).
Import types from `server/modules/cart/index.ts`; reach the runtime instance at call time via `deps.services.cart`.

## 1. Architecture & Security Invariants (ADR 0035, ADR 0043, ADR 0044)

- **Feature switches (`feature.cart = false` `clientVisible: true`, `feature.cart.upsell = false`):** Both ship off by default. Toggling requires `admin` + fresh step-up (`settings.manage`) and is durably audited (`platform.feature.changed`). When `feature.cart` is disabled, customer cart procedures fail closed with `NOT_FOUND` (`CART_FEATURE_DISABLED`), while `badgeCount` returns `{ enabled: false, itemCount: 0 }`. When `feature.cart.upsell` is disabled, `cart.get` returns `upsells: []` and `cart.upsell.accept`/`dismiss` fail closed with `NOT_FOUND` (`CART_UPSELL_DISABLED`).
- **Single open cart per customer:** Enforced at the database level via `carts.open_customer_key` (`UNIQUE` index `carts_open_customer_uq`), populated strictly while `status = 'open'` and set to `NULL` on transition to `awaiting_payment`, `checked_out`, `restored`, or `expired`.
- **Server-side pricing & transaction-bound catalog locks:** All input schemas are `.strict()` and accept **only** `productPublicId` / `offerPublicId` / `quantity` / `code` (never unit prices, discounts, tax rates, or totals). Inside mutating transactions (`applyCode`, `acceptUpsell`, `checkout`), active catalog rows are read via `orders.listActiveCatalog(tx, { forShare: true })` so product deactivation or repricing cannot race commit and never blocks on single-connection MySQL pools.
- **Cart upsells (Decision D2 / ADR 0043):**
  - Stored in `cart_upsell_offers` (`add_on` | `tier_upgrade`, plain-text `title` <= 120, `short_text` <= 200, `trigger_mode` `any_cart` | `products`, `priority` `1..1000`, active + schedule window, `shown_count` / `accepted_count` / `dismissed_count`) and per-cart state `cart_upsell_cart_states` (`offer_key`, `shown_at`, `dismissed_at`, `accepted_at`, `accepted_idempotency_key`).
  - Automatic `bundle_completion` suggestion runs at priority `50` when `orders.bundle_rule` is enabled and the cart is 1 or 2 packets short of the bundle rule.
  - Canonical lock ordering across impression recording, `acceptUpsell`, and `dismissUpsell`: `carts FOR UPDATE` -> `cart_items FOR UPDATE` -> `cart_upsell_offers FOR UPDATE (ORDER BY id ASC)` -> `cart_upsell_cart_states FOR UPDATE (ORDER BY offer_key ASC)`.
  - `acceptUpsell` re-evaluates the full top-3 + conflict-suppression display set so hidden, suppressed, dismissed, or deactivated offers cannot be accepted by direct API call, and rejects `idempotencyKey` reuse across mismatched `offerPublicId` (`CONFLICT:IDEMPOTENCY_KEY_REUSED`).
- **Cart discount codes & checkout reconfirmation (Decision D3 / ADR 0044):**
  - `cart.applyCode` calls `promotions.preview({ code, customerUserId, currency, lines }, { recordAttempt: true, ipHash, tx })`, encrypts the normalized code into `carts.promo_code_enc` (`FieldCrypto`, AAD `{ table: "carts", column: "promo_code_enc", recordId: cart.publicId }`), stores non-secret `promo_public_id` + `promo_label`, and never logs raw code strings.
  - Every `cart.get` re-evaluates an applied code with `{ recordAttempt: false, tx }`. If the code became invalid, `cart.get` clears the stale code in `tx` and returns a structured `promoNotice` (`CartPromoNoticeView`).
  - At `cart.checkout`, if the cart had an applied promo code that is now rejected by `promotions.preview` (or `expectedTotalMinor` changed), `cart.checkout` clears the invalid code in a committed transaction, emits `cart.promo.invalidated_at_checkout`, and throws `CONFLICT:PROMO_RECONFIRM_TOTAL` (**order not placed**). When valid, `promoCode` is passed directly into `orders.createOrderFromCheckoutInTx(..., promoCode)` so `promotions.redeemInTx` runs atomically inside the order+invoice transaction. When the issued invoice total is `0` (for example, a `100%` discount with `promotions.policy.maxDiscountPercent = 100`), `cart.checkout` skips `payments.startCheckout`, commits `carts.status = "checked_out"` (`payment_mode = "no_payment_due"` in `cart.checked_out` audit), returns `{ mode: "no_payment_due", totalMinor: 0, ... }` idempotently on replay, and `cart.checkoutStatus` reports `confirmationState: "no_payment_due"`.

---

## 2. tRPC Procedures (`trpc.cart.*`)

### Customer procedures (`protectedProcedure`, customer role / resource owner)

| Procedure | Kind | Input (`.strict()`) | Output / Notes |
| --- | --- | --- | --- |
| `cart.badgeCount` | query | — | `{ enabled: boolean, itemCount: number }` |
| `cart.get` | query | — | `CartView` (`items`, `totals` with `bundle` + `promo`, `promotionsEnabled`, `promoNotice`, `upsells` up to 3) + `pendingPolicies` |
| `cart.addItems` | mutation | `{ items: { productPublicId, quantity }[] (1..50), projectName?, note?, replacePacketTiers? }` | Adds/updates items in caller's open cart -> `CartView` |
| `cart.updateItem` | mutation | `{ itemPublicId, expectedVersion, productPublicId?, quantity? }` | Updates packet tier or add-on quantity with CAS -> `CartView` |
| `cart.removeItem` | mutation | `{ itemPublicId, expectedVersion }` | Removes item with CAS -> `CartView` |
| `cart.clear` | mutation | `{ expectedVersion }` | Empties open cart items with CAS -> `CartView` |
| `cart.saveDraftDetails` | mutation | `{ expectedVersion, projectName, note?, billing? }` | Encrypts note & billing details (`AES-256-GCM`) -> `CartView` |
| `cart.applyCode` | mutation | `{ code (1..64), idempotencyKey (8..128) }` | Validates & applies discount code via `promotions.preview` (`recordAttempt: true`), stores encrypted `promo_code_enc` -> `CartView` |
| `cart.removeCode` | mutation | `{ expectedVersion? }?` | Clears applied discount code from caller's open cart -> `CartView` |
| `cart.upsell.accept` | mutation | `{ offerPublicId (ULID \| "bundle_completion"), expectedVersion, idempotencyKey (8..128) }` | Atomically adds/upgrades target product(s) from live catalog (`FOR SHARE`) and increments `acceptedCount` -> `CartView` |
| `cart.upsell.dismiss` | mutation | `{ offerPublicId (ULID \| "bundle_completion"), expectedVersion? }` | Marks suggestion dismissed for this cart and increments `dismissedCount` -> `CartView` |
| `cart.checkout` | mutation | `{ cartPublicId, expectedVersion, expectedTotalMinor?, projectName, note?, billing, policyAcceptances?, idempotencyKey }` | Atomic promo redemption + order + issued invoice creation in `tx`, or `CONFLICT:PROMO_RECONFIRM_TOTAL` if promo became invalid -> `CheckoutCartResult` |
| `cart.checkoutStatus` | query | `{ cartPublicId?, attemptPublicId? }` | Strictly read-only return-page status (`CheckoutStatusResult` incl. `promoDiscountMinor`, `promoLabel`) |
| `cart.restoreCheckout` | mutation | `{ cartPublicId?, attemptPublicId? }` | Cancels unpaid payment attempt and restores items + draft fields to open cart |

### Console & Admin procedures

| Procedure | Kind | Guard | Output / Notes |
| --- | --- | --- | --- |
| `cart.admin.listOpen` | query | `staff`/`admin` + `carts.read_all` | Paginated read-only open carts (`AdminOpenCartSummary[]`; zero decrypted notes, billing PII, or raw promo codes) |
| `cart.admin.getOpen` | query | `staff`/`admin` + `carts.read_all` | Read-only open cart detail (`AdminOpenCartDetail`) |
| `cart.admin.upsells.list` | query | `staffProcedure` + `carts.upsells.manage` | `AdminCartUpsellsListResult` (`featureCartEnabled`, `featureUpsellEnabled`, `bundleRuleEnabled`, `bundleRuleLabel`, `offers`, `catalogProducts` with `canBeTierUpgradeTarget`) |
| `cart.admin.upsells.create` | mutation | `staffProcedure` + `carts.upsells.manage` (before `.input()`) | Creates plain-text add-on or tier-upgrade offer -> `AdminCartUpsellOfferView` |
| `cart.admin.upsells.update` | mutation | `staffProcedure` + `carts.upsells.manage` (before `.input()`) | Updates offer with `expectedVersion` CAS -> `AdminCartUpsellOfferView` |
| `cart.admin.upsells.setActive` | mutation | `staffProcedure` + `carts.upsells.manage` (before `.input()`) | Toggles offer `active` with `expectedVersion` CAS -> `AdminCartUpsellOfferView` |
| `cart.admin.upsells.delete` | mutation | `staffProcedure` + `carts.upsells.manage` (before `.input()`) | Deletes offer -> `{ deleted: true, offerPublicId }` |

---

## 3. Audit Events (`snake_case` attributes, zero PII / raw promo code strings)

- Customer cart & checkout (`category: "business"`): `cart.item_added`, `cart.item_updated`, `cart.item_removed`, `cart.cleared`, `cart.details_saved`, `cart.promo_applied`, `cart.promo_removed`, `cart.promo_invalidated_at_checkout`, `cart.upsell_accepted`, `cart.upsell_dismissed`, `cart.checked_out`, `cart.checkout_payment_started`, `cart.checkout_restored`, `cart.expired`.
- Admin cart suggestions (`category: "admin"`): `cart.upsell_offer_created`, `cart.upsell_offer_updated`, `cart.upsell_offer_toggled`, `cart.upsell_offer_deleted`.
- Security (`category: "security"`, `outcome: "denied"`, `severity: "WARN"`): `authz.cart.denied`.

---

## 4. Client Routes (`cartFeature` in `client/src/features/cart/routes.tsx`)

- `/cart` (`customer`, `CartPage`, includes `CartUpsellSection` and `PromoCodeField`)
- `/cart/checkout` (`customer`, `CheckoutPage`, includes `PromoCodeField` and `PROMO_RECONFIRM_TOTAL` reconfirmation notice)
- `/checkout/return` (`customer`, `CheckoutReturnPage`)
- `/checkout/cancel` (`customer`, `CheckoutCancelPage`)
- `/admin/carts` (`staff`, capability `carts.read_all`, `AdminOpenCartsPage`)
- `/admin/carts/suggestions` (`admin`, capability `carts.upsells.manage`, `AdminCartUpsellsPage`, Console -> Operations -> Cart suggestions)
