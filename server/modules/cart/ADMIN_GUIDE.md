# Administrator Guide — Cart, Cart Suggestions & Discount Codes (`cart`)

## Overview

The server-side cart and checkout module (`feature.cart`) allows customers to combine packet tiers and add-ons into a single open cart, enter discount codes (`feature.promotions`), review optional server-evaluated cart suggestions (`feature.cart.upsell`), accept required customer policies, and place an order either by issued invoice or through the configured online payment provider (`payments`).

All cart, cart-suggestion, and checkout screens are designed and tested against WCAG 2.2 AA in both light and dark themes.

## Enabling & Configuring Cart, Suggestions, and Discount Codes

Both `feature.cart` and `feature.cart.upsell` ship **disabled by default** so existing single-order workflows remain unchanged until an administrator turns them on.

1. Open **Console -> Platform -> Feature flags** (requires `settings.manage` and fresh step-up verification).
2. Enable **`feature.cart`** (*Customer shopping cart & multi-item checkout*). Switching the flag on or off emits a durable audit event.
3. Optional — Enable **`feature.cart.upsell`** (*Cart suggestions & bundle-completion offers*). When off, customer carts never display suggestion cards, while administrators can still prepare offers in advance on `/admin/carts/suggestions`.
4. Configure **`cart.abandoned_ttl_hours`** (*Abandoned cart expiry (hours)*, range `1..2160`, default `72`). The background job `cart.abandoned.expire` runs hourly (`cart.abandoned.hourly`) under fenced worker leases and marks open carts inactive longer than this threshold as `expired` (`cart.expired` audit event).
5. Related settings:
   - **Bundle rule (`orders.bundle_rule`):** Controls automatic multi-packet percentage discounts shown in the cart and locked into checkout invoices. When `feature.cart.upsell` is enabled and a customer's cart is 1 or 2 packets short of the bundle rule, ReadyPackets automatically generates a `bundle_completion` suggestion at priority `50`.
   - **Promotions (`feature.promotions`):** When enabled, customers see a **Discount code** field on both `/cart` and `/cart/checkout`. Applied codes are encrypted at rest on the cart (`promo_code_enc` via `FieldCrypto` AES-256-GCM), never written to application logs or audit attributes, and re-evaluated on every cart read and inside the checkout transaction (`larger_only`: whichever of bundle savings or promo savings is larger wins).
   - **Default tax rate (`compliance.invoices.default_tax_rate_bps`):** Integer basis points (`100` = `1.00%`) applied on the server during cart preview and checkout.
   - **Online payments (`payments.config.provider`):** Defaults to `"none"` (*Pay by invoice*). When `"stripe"` or `"square"` is configured and enabled, checkout creates the order and issued invoice first and then redirects the customer to the hosted payment page.

## Managing Cart Suggestions (`/admin/carts/suggestions`)

Administrators granted **`carts.upsells.manage`** can open **Console -> Operations -> Cart suggestions** (`/admin/carts/suggestions`):

- Review aggregated **Shown**, **Accepted**, and **Dismissed** counters across configured offers (each offer is counted as shown at most once per cart).
- Create, edit, activate/deactivate, or delete two kinds of plain-text offers (up to 3 suggestions are shown per cart, ordered by ascending priority `1..1000`):
  - **Add-on product (`add_on`):** Suggests an active catalogue product not yet in the cart.
  - **Packet tier upgrade (`tier_upgrade`):** Suggests stepping up from a lower-priced tier of the same packet already in the cart; only higher-priced packet tiers can be selected as targets, and the customer sees the exact `+price` difference.
- Configure trigger conditions (**Any non-empty cart** or **When specific products are in the cart**), optional start/end windows, and active status.
- **Anti-dark-pattern & pricing guarantees:** Copy is plain text only (`<= 200` characters, no HTML, countdown timers, pre-ticked checkboxes, or confirm-shaming labels). If a target product is deactivated or repriced in the catalogue, eligibility and prices update live on the server and stale offers disappear automatically without breaking customer carts.

## Viewing Open Carts (`/admin/carts`)

Staff and administrators granted **`carts.read_all`** can open **Console -> Operations -> Open carts** (`/admin/carts`):

- Search open carts by cart public ID, customer reference, or project label.
- Review packet/tier selections, unavailable-product warnings, bundle/promo discount totals, live server totals, last activity timestamps, and scheduled expiry times.
- Open the **Inspect** drawer on any row for a read-only line-item and totals breakdown.
- **Privacy boundary:** Customer draft notes (`note_enc`), draft billing details (`billing_enc`), and applied discount code strings (`promo_code_enc`) are encrypted at rest with `FieldCrypto` (`AES-256-GCM`) and are never decrypted or displayed on `/admin/carts`. Staff cannot mutate a customer's cart.

## Checkout Reconfirmation, Payment Return & Abandonment Semantics

- **Discount code expiry or change before checkout (`PROMO_RECONFIRM_TOTAL`):** If an applied discount code expires, reaches its redemption cap, or becomes ineligible before the customer submits checkout, ReadyPackets **does not place the order**. Instead, it clears the stale code, refreshes the cart total, and prompts the customer to review and confirm the updated total before placing the order.
- Returning to `/checkout/return` is **strictly read-only**: an invoice is marked `paid` only after verified payment webhook or provider reconciliation in `payments`, never by loading the return URL.
- Visiting `/checkout/cancel` inspects checkout state on `GET` without side effects; clicking **Restore items to cart** sends an explicit `POST` (`cart.restoreCheckout`) that cancels any unpaid payment attempt and restores the items to the customer's open cart unless payment has already completed.
