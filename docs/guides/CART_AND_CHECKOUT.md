# Cart and Checkout Operations Guide

See [`server/modules/cart/ADMIN_GUIDE.md`](../../server/modules/cart/ADMIN_GUIDE.md) and [`server/modules/cart/API.md`](../../server/modules/cart/API.md) for the complete administrator and module contract reference:

- **Feature switch:** `feature.cart` (off by default; audited via platform settings).
- **Abandoned-cart TTL:** `cart.abandoned_ttl_hours` (default `72` hours; enforced by hourly worker job `cart.abandoned.expire` on schedule `cart.abandoned.hourly`).
- **Console view:** `/admin/carts` (`carts.read_all`), strictly read-only with zero decrypted customer notes or billing PII.
- **Checkout & Decision 12:** Atomic order + issued invoice creation in one MySQL transaction, outbound payment initiation outside DB locks, read-only `/checkout/return` polling, and explicit `POST` restoration on `/checkout/cancel`.
- **Accessibility:** All customer and console cart views are designed and tested against WCAG 2.2 AA in light and dark themes.
