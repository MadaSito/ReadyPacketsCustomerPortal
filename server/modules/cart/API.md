# Cart & Checkout Module API (Increments 04–06 — Package L, Package B & Package D)

Owner: `recovery_ops_engineer` (`server/modules/cart/**`, `client/src/features/cart/**`).
Import types from `server/modules/cart/index.ts`; reach the runtime instance at call time via `deps.services.cart`.

## 1. Architecture & Security Invariants (ADR 0035, ADR 0043, ADR 0044, Increment 06 D3/D5/D14)

- **Feature switches (`feature.cart = false` `clientVisible: true`, `feature.cart.upsell = false`):** Both ship off by default. Toggling requires `admin` + fresh step-up (`settings.manage` or `carts.upsells.manage` via `cart.admin.upsells.setFeature`) and is durably audited (`platform.feature.changed` / `cart.upsell_feature_toggled`). When `feature.cart` is disabled, customer cart procedures fail closed with `NOT_FOUND` (`CART_FEATURE_DISABLED`), while `badgeCount` returns `{ enabled: false, itemCount: 0 }`. When `feature.cart.upsell` is disabled, `cart.get` returns `upsells: []` and `cart.upsell.accept`/`dismiss` fail closed with `NOT_FOUND` (`CART_UPSELL_DISABLED`).
- **Single open cart per customer:** Enforced at the database level via `carts.open_customer_key` (`UNIQUE` index `carts_open_customer_uq`), populated strictly while `status = 'open'` and set to `NULL` on transition to `awaiting_payment`, `checked_out`, `restored`, or `expired`.
- **Server-side pricing & transaction-bound catalog locks:** All input schemas are `.strict()` and accept **only** `productPublicId` / `offerPublicId` / `quantity` / `code` (never unit prices, discounts, tax rates, or totals). Inside mutating transactions (`applyCode`, `acceptUpsell`, `checkout`), active catalog rows are read via `orders.listActiveCatalog(tx, { forShare: true })` so product deactivation or repricing cannot race commit and never blocks on single-connection MySQL pools.
- **Cart upsells & catalogue-driven starter seeding (Decision D2 / ADR 0043 & Increment 06 Decision D3):**
  - Stored in `cart_upsell_offers` (`add_on` | `tier_upgrade`, `rule_type` `standard` | `bundle_completion` | `next_packet`, optional `seed_key` (`UNIQUE` `cart_upsell_offer_seed_key_uq`), plain-text `title` <= 120, `short_text` <= 200, `trigger_mode` `any_cart` | `products`, `priority` `1..1000`, active + schedule window, `shown_count` / `accepted_count` / `dismissed_count`) and per-cart state `cart_upsell_cart_states` (`offer_key`, `shown_at`, `dismissed_at`, `accepted_at`, `accepted_idempotency_key`).
  - `ensureDefaultUpsellOffers()` (invoked on startup) and `cart.admin.upsells.seedSuggested` idempotently generate starter rows from the live catalogue and bundle rule across all 4 D3 categories: (a) packet tier upgrades (`Basic -> Standard`, `Standard -> Premium`), (b) complete-the-bundle (`rule_type = "bundle_completion"`), (c) natural next packet (`Packet N -> Packet N+1`, `rule_type = "next_packet"`), and (d) add-on suggestions. Every seeded row ships disabled (`active = false`) and never overwrites administrator edits. `cart.upsell_seeded_keys` tracks startup-seeded keys (resiliently parsed via `parseCartUpsellSeededKeysSetting`) so deleted starter rows are never resurrected on restart, while **Add suggested offers** (`seedSuggested`) restores any missing starter rows on demand.
  - Canonical lock ordering across impression recording, `acceptUpsell`, and `dismissUpsell`: `carts FOR UPDATE` -> `cart_items FOR UPDATE` -> `cart_upsell_offers FOR UPDATE (ORDER BY id ASC)` -> `cart_upsell_cart_states FOR UPDATE (ORDER BY offer_key ASC)`.
  - `acceptUpsell` re-evaluates the full top-3 + conflict-suppression display set so hidden, suppressed, dismissed, or deactivated offers cannot be accepted by direct API call, and rejects `idempotencyKey` reuse across mismatched `offerPublicId` (`CONFLICT:IDEMPOTENCY_KEY_REUSED`).
- **Cart discount codes, `set_total`, two-decimal `%`, and small-total settlement (Increment 05 D3 / Increment 06 Decision D5):**
  - `cart.applyCode` calls `promotions.preview({ code, customerUserId, currency, lines }, { recordAttempt: true, ipHash, tx })`, supporting `percent` (`percentBps` `1..10_000`, two-decimal `%`), `fixed`, and `set_total` (`setTotalMinor >= 0`), encrypts the normalized code into `carts.promo_code_enc` (`FieldCrypto`, AAD `{ table: "carts", column: "promo_code_enc", recordId: cart.publicId }`), stores non-secret `promo_public_id` + `promo_label`, and surfaces explicit `PROMO_LIMIT_MAX_PERCENT`, `PROMO_LIMIT_MAX_FIXED`, `PROMO_LIMIT_ZERO_TOTAL`, and `PROMO_LIMIT_MIN_TOTAL` validation refusals.
  - Every `cart.get` re-evaluates an applied code with `{ recordAttempt: false, tx }` and calls `payments.evaluateCheckoutAmount(totalMinor, currency, tx)` (when exposed by `payments`) to return `smallTotalEvaluation` (`minimumMinor`, `belowMinimum`, `smallTotalAction`: `"none" | "zero_total" | "waive" | "block"`).
  - At `cart.checkout`, if an applied code became invalid (including lowered `PROMO_LIMIT_*` guardrails), `cart.checkout` clears the stale code, emits `cart.promo.invalidated_at_checkout`, and throws `CONFLICT:PROMO_RECONFIRM_TOTAL` (**order not placed**). When `totalMinor === 0`, customer copy shows `"Nothing to pay — your discount covers this order."`, checkout settles the zero-balance invoice immediately (and records a `zero_total` receipt when Wave-2 `payments.startCheckout` supports settled receipts), and returns `{ mode: "no_payment_due", totalMinor: 0, ... }`. When `0 < totalMinor < minimumMinor` under an online provider: `"waive"` (`payments.small_totals`) waives the remaining sub-minimum balance (`carts.checked_out_waived_minor`) and returns `{ mode: "waived_small_total", waivedMinor, ... }`; `"block"` rejects checkout inside `tx` with `VALIDATION:AMOUNT_BELOW_PROVIDER_MINIMUM` so the order, invoice, and promo redemption roll back cleanly.
- **Order agreement gate at checkout (Increment 06 Decision D14):**
  - Inside `cart.checkout`'s serializable transaction, `orders.gates.assertCustomerMayPlaceOrder({ tx, actor })` runs before order/invoice creation. When the configured account-level agreement (MNDA) is unmet, checkout rolls back cleanly and throws `CONFLICT:AGREEMENT_REQUIRED` (`{ policyPublicId, signatureMode }`); `CheckoutPage` opens `AgreementDialog` so the customer can read, sign/accept, and automatically retry checkout.

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
| `cart.admin.upsells.setFeature` | mutation | `staffProcedure` + `carts.upsells.manage` (before `.input()`) | Toggles `feature.cart.upsell` and optionally `feature.cart` (`alsoEnableCart`) -> `{ featureCartEnabled, featureUpsellEnabled }` |
| `cart.admin.upsells.setAllActive` | mutation | `staffProcedure` + `carts.upsells.manage` (before `.input()`) | Enables or disables all available offers -> `{ active, updatedCount, skippedUnavailableCount }` |
| `cart.admin.upsells.seedSuggested` | mutation | `staffProcedure` + `carts.upsells.manage` (before `.input()`) | Idempotently inserts any missing catalogue starter rows (disabled) without overwriting edits -> `{ addedCount, skippedExistingCount }` |
| `cart.admin.upsells.duplicate` | mutation | `staffProcedure` + `carts.upsells.manage` (before `.input()`) | Clones an existing offer into a new disabled custom row (`seedKey: null`) -> `AdminCartUpsellOfferView` |
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
