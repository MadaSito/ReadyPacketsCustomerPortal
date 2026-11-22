# Promotions client feature (increment 05, D3 / package C2)

Owner: audit engineer. Server: `server/modules/promotions` (siem_engineer, see its `API.md`, `contracts.ts`).

## Registry

- Export: `promotionsFeature` from `client/src/features/promotions/routes.tsx`.
- Routes:
  - `/promo` (public): link landing.
  - `/admin/promotions` (staff, `promotions.read`): Discount codes.
  - `/admin/promotions/new` (admin, `promotions.manage`): new code.
  - `/admin/promotions/redemptions` (staff, read): all redemptions.
  - `/admin/promotions/:promotionId` (staff, read): one code.
  - `/admin/promotions/:promotionId/edit` (admin, manage): edit.
- Nav: "Discount codes", console / Operations, order 20. It has deliberately no `enabledBy`, because the on/off switch is on that page.
- Startup: `capturePromoLinkAtStartup()` (savedCode.ts) is called in `client/src/main.tsx` before `createRoot` (ui_foundation 187da97).

## Shared component: `PromoCodeField`

`import { PromoCodeField } from "@/features/promotions/PromoCodeField"`. It has no imports from orders or cart.

| Prop | Type | Notes |
| --- | --- | --- |
| `applied` | `{ label, discountMinor, currency } \| null` | Applied state shows the label and amount, never the code. |
| `onApply(code)` | `Promise<void>` | Caller runs its POST mutation and rethrows the tRPC error. |
| `onRemove()` | `Promise<void>` | |
| `disabled?`, `label?` (default "Discount code"), `onAnnounce?(msg)`, `className?` | | Without `onAnnounce` it uses its own polite region. |

- Errors:
  - The uniform message is "This code cannot be applied."
  - The server text is shown only for `PROMO_MIN_SUBTOTAL` and `PROMO_NOT_ELIGIBLE_ITEMS`.
  - `PROMO_ATTEMPTS_BLOCKED` / `RATE_LIMITED` show a wait message.
- Focus:
  - After apply it moves to Remove, and after remove to the input.
  - Focus moves only while it is still inside the field (or on body).
- Masking: the root has `ph-no-capture` and `data-clarity-mask="true"`.
- Saved code: shows "Use saved code" without speaking the code, and clears the saved code once it is applied.

## Link format and storage

- Link format: `https://<portal>/promo#promo=<CODE>`. The code is in the fragment, so it never reaches the server, access logs or referrers.
- Storage: `sessionStorage["rp.promotions.savedCode"]`, for this tab only. It is never a cookie and never a query string. It survives sign-in and registration in the same tab.
- The fragment is stripped with `history.replaceState` before the router and analytics start.

## Procedures used (`trpc.promotions.admin.*`)

`list` (infinite), `get`, `stats`, `create`, `update`, `pause`, `resume`, `revoke`, `generateBatch`, `reveal`, `redemptions` (infinite), `releaseRedemption`, `exportCodes`, `exportRedemptions`, `getSettings`, `updateSettings`.

Every write, reveal, release and export runs through `useStepUp().run`. The typed bridge is in `api.ts`, with view types `import type` from `@server/modules/promotions/contracts`.

## Settings keys

- `feature.promotions`: the master switch, the "Discount codes" switch on the page.
- `promotions.policy.maxDiscountPercent`: "Largest discount per order (%)", default 50.

## Admin guide section (draft for platform_engineer)

### Discount codes

Console → Operations → Discount codes (`/admin/promotions`).

**Who can do what**
- Staff with `promotions.read` see the list, masked codes and redemptions.
- Administrators (`promotions.manage`) create, edit, pause, resume, revoke, show codes, generate batches, export CSV, release redemptions and change the settings.
- Every change asks for your password and second factor again (step-up) and is recorded in the audit log.

**Switching it on**
- The Discount codes switch on the page is off by default.
- While it is off, no code can be applied anywhere, and existing orders keep their discounts.

**Creating a code**
1. Choose New discount code.
2. Enter an internal name (staff only) and the label customers see. The label must not be the code itself.
3. Choose percentage (with an optional largest amount) or fixed amount (with currency). These cannot be changed later.
4. Choose what it applies to (everything, products, tiers or packet sizes) and the conditions: minimum subtotal, start/end, total uses, uses per customer (default 1), first order only, only these customers or e-mail domains, and whether it combines with a bundle discount (otherwise the larger applies).
5. Choose a code (6–32 letters, digits or hyphens), a generated code, or many single-use codes (up to 5,000, optional prefix of 1–12 letters or digits).

After creation, copy the code or its link. Later, Show code and link reveals it again; each reveal is audited.

**Largest discount per order.** Bundle and code discounts together never exceed this share of the subtotal (default 50 %).

**Pause, resume, revoke**
- Pause and resume can be undone.
- Revoke is permanent.
- Orders already placed always keep their discount.

**Redemptions and release**
- A redemption is released automatically only when an order is cancelled and nothing was ever paid, with no invoice or payment left open.
- Otherwise it stays used.
- After you void or settle the invoice by hand, an administrator can choose Release, which needs a reason. The server checks the same rule and refuses otherwise (ADR 0044).

**Exports.** Codes and redemptions CSV are built by the server (formula-safe), need step-up and are audited. Store them as secrets.

## Help article (draft, customers)

### Using a discount code

- Enter the code in your cart (Discount code → Apply).
- When it applies, you see its name and the amount; the code itself is not shown on your order or invoice.
- If a code cannot be used, you see "This code cannot be applied." For a minimum amount or ineligible items, you are told what is missing.
- After several unsuccessful tries, code entry pauses for 15 minutes.
- **If you received a link:** opening it saves the code in this browser tab only ("Code saved"). Sign in or create an account in the same tab, then choose Use saved code in your cart. Closing the tab forgets it, and Forget the saved code removes it at any time.
