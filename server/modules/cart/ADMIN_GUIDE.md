# Administrator Guide — Cart & Checkout (`cart`)

## Overview

The server-side cart and checkout module (`feature.cart`) allows customers to combine packet tiers and add-ons into a single open cart, preview bundle discounts and tax calculated on the server, accept required customer policies, and place an order either by issued invoice or through the configured online payment provider (`payments`).

All cart and checkout screens are designed and tested against WCAG 2.2 AA in both light and dark themes.

## Enabling & Configuring Cart and Checkout

Cart ships **disabled by default** so existing single-order workflows remain unchanged until an administrator turns it on.

1. Open **Console -> Platform -> Feature flags** (requires `settings.manage` and fresh step-up verification).
2. Enable **`feature.cart`** (*Customer shopping cart & multi-item checkout*). Switching the flag on or off emits a durable audit event.
3. Configure **`cart.abandoned_ttl_hours`** (*Abandoned cart expiry (hours)*, range `1..2160`, default `72`). The background job `cart.abandoned.expire` runs hourly (`cart.abandoned.hourly`) under fenced worker leases and marks open carts inactive longer than this threshold as `expired` (`cart.expired` audit event).
4. Optional related settings:
   - **Bundle rule (`orders.bundle_rule`):** Controls automatic multi-packet percentage discounts shown in the cart and locked into checkout invoices.
   - **Default tax rate (`compliance.invoices.default_tax_rate_bps`):** Integer basis points (`100` = `1.00%`) applied on the server during cart preview and checkout.
   - **Online payments (`payments.config.provider`):** Defaults to `"none"` (*Pay by invoice*). When `"stripe"` or `"square"` is configured and enabled, checkout creates the order and issued invoice first and then redirects the customer to the hosted payment page.

## Viewing Open Carts (`/admin/carts`)

Staff and administrators granted **`carts.read_all`** can open **Console -> Operations -> Open carts** (`/admin/carts`):

- Search open carts by cart public ID, customer reference, or project label.
- Review packet/tier selections, unavailable-product warnings, bundle-discount indicators, live server totals, last activity timestamps, and scheduled expiry times.
- Open the **Inspect** drawer on any row for a read-only line-item and totals breakdown.
- **Privacy boundary:** Customer draft notes (`note_enc`) and draft billing details (`billing_enc`) are encrypted at rest with `FieldCrypto` (`AES-256-GCM`) and are never decrypted or displayed on `/admin/carts`. Staff cannot mutate a customer's cart.

## Payment Return & Abandonment Semantics

- Returning to `/checkout/return` is **strictly read-only**: an invoice is marked `paid` only after verified payment webhook or provider reconciliation in `payments`, never by loading the return URL.
- Visiting `/checkout/cancel` inspects checkout state on `GET` without side effects; clicking **Restore items to cart** sends an explicit `POST` (`cart.restoreCheckout`) that cancels any unpaid payment attempt and restores the items to the customer's open cart unless payment has already completed.
