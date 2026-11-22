# 0043 — Cart upsell: server-priced suggestions the customer must choose, never pre-selected

Status: Accepted (2026-11-22; owner confirmation requested)

## Context
The owner asks for upsell in the cart (increment 05, decision D2). The cart (ADR 0035, increment 04) is server-priced and has a bundle rule of 15% when all six packets are in one order (ADR 0022).

## Decision
- **Switch.** The feature sits behind the setting `feature.cart.upsell`, which is off by default and needs `feature.cart`. Switching it on is audited.
- **Offers** live in a cart-owned table and come in two kinds:
  - `add_on` suggests a product when trigger products are in the cart, or for any cart;
  - `tier_upgrade` replaces a packet's tier with a higher tier of the same packet.

  Each offer has a title, a short plain-text description (200 characters), triggers, a target, a priority, an active flag and an optional start and end time.
- **Bundle completion.** A suggestion is derived automatically from the bundle rule, for example "Add Packets 3 and 5 to save 15%", with the computed saving.
- **Suggestions.** The server returns at most three suggestions with the cart (`cart.get` → `upsells`), each with server prices; an upgrade shows the price difference. It never suggests something already in the cart, an inactive product, or a selection that breaks the packet rules.
- **Accept and dismiss.** `cart.upsell.accept({offerPublicId, idempotencyKey})` adds the target or swaps the tier atomically at the server price. `cart.upsell.dismiss` hides an offer for this cart.
- **No dark patterns.** Nothing is added without the customer's action. There are no countdown timers, pre-ticked boxes or confirm-shaming wording.
  - The suggestions are a labelled region after the cart lines. Each card has a heading, the price in text and one button with a specific accessible name, such as "Add Packet 3 Standard for $499.00".
  - Changes are announced through the existing live region.
- **Administration.** The admin page "Cart suggestions" needs `carts.upsells.manage` (administrators). It lists, creates, edits, activates, deactivates and deletes offers, and shows how often each was shown, accepted and dismissed.
- **Audit events:** `cart.upsell_offer.created|updated|activated|deactivated|deleted` and `cart.upsell.accepted`.

## As implemented

Package B, as reported by the owner:

- **Pages:**
  - `/admin/carts/suggestions` (Operations → Cart suggestions, `carts.upsells.manage`);
  - `/admin/carts` (Open carts, `carts.read_all`);
  - for customers, the suggestions section on `/cart`.
- **Settings:**
  - `feature.cart.upsell` (default off), which needs `feature.cart`;
  - `cart.abandoned_ttl_hours` (1–2160, default 72), applied by the hourly job `cart.abandoned.expire`.
- **Procedures:**
  - `cart.upsell.{accept,dismiss}`;
  - `cart.admin.upsells.{list,create,update,setActive,delete}`.
- **Bundle completion:** automatic suggestions use priority 50.
- **Offer copy:** plain text of at most 200 characters.

## Consequences
- Suggestions follow the same pricing and packet rules as the cart, so an accepted offer can never produce a price the customer did not see.
- The counters are operational figures, not analytics, and need no consent beyond the existing session.
