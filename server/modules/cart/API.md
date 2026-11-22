# Cart & Checkout Module API (Increment 04, Package L)

Owner: `recovery_ops_engineer` (`server/modules/cart/**`, `client/src/features/cart/**`).
Status: Day-one ports & final schema published on `feat/increment-04`.
Import types from `server/modules/cart/index.ts`; reach the runtime instance at call time via `deps.services.cart`.

## 1. Architecture & Security Invariants (ADR 0035, Contract §1.12, §1.13 & §4)

- **Off by default (`feature.cart = false`, `clientVisible: true`):** Declared via `defineFeatureFlag({ flag: "cart", clientVisible: true })`. Toggling requires `admin` + fresh step-up and is durably audited (`platform.feature.changed`). When disabled, customer cart procedures fail closed with `NOT_FOUND` (`CART_FEATURE_DISABLED`), while `badgeCount` returns `{ enabled: false, itemCount: 0 }`.
- **Single open cart per customer:** Enforced at the database level via `carts.active_owner_slot` (`UNIQUE` index `cart_active_owner_uq`), populated strictly while `status = 'open'` and set to `NULL` on transition to `awaiting_payment`, `checked_out`, `restored`, or `expired`.
- **Server-side pricing anti-tampering:** All input schemas are `.strict()` and accept **only** `productPublicId` and `quantity` (never unit prices, discounts, tax rates, or totals). On every cart read and inside the atomic checkout transaction, unit prices, packet rules (`quantity === 1`, one tier per packet), the bundle discount (`priceOrder`), and tax (`compliance.quoteTaxMinor`) are recomputed on the server from the live catalogue.
- **Atomic order + invoice creation, then payment attempt:** `cart.checkout` executes a single DB transaction (`tx`) that revalidates the actor session (`identity.sessions.assertCurrent`), locks the open cart `FOR UPDATE` with CAS (`expectedVersion`), records checkout policy acceptances (`compliance.recordCheckoutAcceptances`), asserts all required customer policies are accepted (`compliance.assertRequiredPoliciesAccepted`), creates the order (`orders.createOrderFromCheckoutInTx`), issues one invoice (`compliance.issueCheckoutInvoiceInTx`), and transitions the cart with CAS + durable audit (`cart.checked_out`). After commit, it invokes `payments.startCheckout(invoicePublicId, { successPath: "/checkout/return", cancelPath: "/checkout/cancel" }, { principal, cartPublicId, idempotencyKey })`.
- **Inert return status & safe cancel restoration (Decision 12):**
  - `cart.checkoutStatus` is strictly read-only — it **never** marks an attempt, invoice, or order paid.
  - `cart.restoreCheckout` (`POST` mutation only, never `GET`) verifies caller ownership, calls `payments.cancelAttemptIfUnpaid`, refuses `CONFLICT` (`CHECKOUT_ALREADY_PAID`) if the invoice or attempt is already paid, and idempotently restores the items + draft details into the customer's open cart (`status = "restored"` via CAS).
- **Abandoned-cart expiry worker (`cart.abandoned.expire`):** Registered in `cart.init()` (`retrySafe: true`) with an hourly schedule (`cart.abandoned.hourly`). Uses `job.assertStillOwned(tx)` inside each batch transaction to expire `open` carts inactive past `cart.abandoned_ttl_hours` (default `168` hours), releasing `active_owner_slot` and emitting durable audit records (`cart.expired`).

---

## 2. Cross-Module Service Interface (`CartModule` on `deps.services.cart`)

```ts
export interface BillingDetailsInput {
  fullName: string;        // 1..160
  company?: string;        // 0..160
  email: string;           // 3..254
  country: string;         // 2-char uppercase ISO 3166-1 alpha-2
  region?: string;         // 0..64
  addressLine1: string;    // 1..200
  addressLine2?: string;   // 0..200
  city: string;            // 1..120
  postalCode: string;      // 1..32
  taxId?: string;          // 0..64
}

export interface CartLineView {
  itemPublicId: string;
  productPublicId: string;
  packetNumber: number | null;
  tier: "Basic" | "Standard" | "Premium" | null;
  name: string;
  description: string;
  outcome: string;
  timeline: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  currency: string;
  available: boolean;
}

export interface CartTotalsView {
  currency: string | null;
  subtotalMinor: number;
  discountMinor: number;
  discountLabel: string | null;
  subtotalAfterDiscountMinor: number;
  taxRateBps: number;
  taxMinor: number;
  totalMinor: number;
  bundle: {
    enabled: true;
    label: string;
    discountPercent: number;
    requiredPacketNumbers: number[];
    missingPacketNumbers: number[];
    applied: boolean;
  } | null;
}

export interface CartView {
  cartPublicId: string | null;
  version: number;
  status: "open";
  itemCount: number;
  projectName: string;
  note: string;
  billing: BillingDetailsInput | null;
  items: CartLineView[];
  hasUnavailableItems: boolean;
  mixedCurrency: boolean;
  totals: CartTotalsView;
  paymentProvider: "none" | "stripe" | "square";
  onlinePaymentEnabled: boolean;
  updatedAt: Date | null;
}

export type CheckoutCartResult =
  | {
      mode: "invoice";
      cartPublicId: string;
      orderPublicId: string;
      orderReference: string;
      invoicePublicId: string;
      invoiceNumber: string;
      currency: string;
      totalMinor: number;
    }
  | {
      mode: "redirect";
      cartPublicId: string;
      orderPublicId: string;
      orderReference: string;
      invoicePublicId: string;
      invoiceNumber: string;
      attemptPublicId: string;
      provider: "stripe" | "square";
      environment: "test" | "live";
      redirectUrl: string;
      currency: string;
      totalMinor: number;
    };

export interface CartModule extends ModuleLifecycle {
  init(): void;
  getBadgeCount(principal: SessionPrincipal): Promise<{ enabled: boolean; itemCount: number }>;
  getMyCart(principal: SessionPrincipal): Promise<CartView>;
  addItems(
    principal: SessionPrincipal,
    input: {
      items: readonly { productPublicId: string; quantity: number }[];
      projectName?: string;
      note?: string;
      replacePacketTiers?: boolean;
    },
  ): Promise<CartView>;
  expireAbandonedCarts(options?: { limit?: number }): Promise<{ expiredCount: number }>;
}
```

---

## 3. tRPC Procedures (`trpc.cart.*`)

### Customer procedures (`protectedProcedure`, customer role / resource owner)

| Procedure | Kind | Input (`.strict()`) | Output / Notes |
| --- | --- | --- | --- |
| `cart.badgeCount` | query | — | `{ enabled: boolean, itemCount: number }` (`{ enabled: false, itemCount: 0 }` when `feature.cart` is off or non-customer) |
| `cart.get` | query | — | `CartView` + `pendingPolicies` from `compliance.requiredAcceptancesFor` |
| `cart.addItems` | mutation | `{ items: { productPublicId, quantity }[] (1..50), projectName? (≤160), note? (≤4000), replacePacketTiers?: boolean (default true) }` | Adds/updates items in the caller's open cart (packet items enforce `quantity === 1` and replace existing tier for the same packet when `replacePacketTiers !== false`). Used by `/orders/new` (`orders_engineer`) and `/cart`. Returns `CartView`. |
| `cart.updateItem` | mutation | `{ itemPublicId, expectedVersion, productPublicId?, quantity? (1..1000) }` | Updates tier (`productPublicId` within same packet) or non-packet `quantity` with CAS on `carts.version`. Returns `CartView`. |
| `cart.removeItem` | mutation | `{ itemPublicId, expectedVersion }` | Removes item with CAS on `carts.version`. Returns `CartView`. |
| `cart.clear` | mutation | `{ expectedVersion }` | Empties open cart items with CAS. Returns `CartView`. |
| `cart.saveDraftDetails` | mutation | `{ expectedVersion, projectName (0..160), note? (0..4000), billing?: BillingDetailsInput \| null }` | Encrypts note & billing details (`AES-256-GCM`), updates `billingCountry`/`billingRegion` for live server tax calculation, and returns `CartView`. |
| `cart.checkout` | mutation | `{ cartPublicId, expectedVersion, projectName (1..160), note? (0..4000), billing: BillingDetailsInput, policyAcceptances?: { versionPublicId, contentHash, signerName? }[], idempotencyKey (8..128) }` | Atomic order + issued invoice creation in `tx`, then `payments.startCheckout` -> `CheckoutCartResult`. |
| `cart.checkoutStatus` | query | `{ cartPublicId?, attemptPublicId? }` (at least one required) | Read-only return-page status (`confirmationState: "pending_confirmation" \| "paid" \| "invoice_issued" \| "cancelled" \| "failed"`). **Never marks anything paid.** `NOT_FOUND` for other customers. |
| `cart.restoreCheckout` | mutation | `{ cartPublicId?, attemptPublicId? }` | Cancels unpaid payment attempt (`payments.cancelAttemptIfUnpaid`), refuses `CHECKOUT_ALREADY_PAID` if paid, and idempotently restores items + draft fields to the caller's open cart. Returns `{ restored: boolean, alreadyRestored: boolean, cart: CartView }`. |

### Console procedures (`staffProcedure` + `carts.read_all`, strictly read-only)

| Procedure | Kind | Guard | Output / Notes |
| --- | --- | --- | --- |
| `cart.admin.listOpen` | query | `staff`/`admin` + `carts.read_all` | `{ search?, cursor?, limit? (1..100, default 25) }` -> `{ featureEnabled, abandonedTtlHours, items: AdminOpenCartSummary[], nextCursor }` (`customerRef` + `customerPublicId`, item count, live server subtotal/discount/total, lastActivityAt, expiresAt; **no decrypted billing PII or order notes**) |
| `cart.admin.getOpen` | query | `staff`/`admin` + `carts.read_all` | `{ cartPublicId }` -> `AdminOpenCartDetail` (read-only line items + live bundle/tax/total breakdown; no billing PII) |

---

## 4. Audit Events (`snake_case` attributes, no PII / card / secret data)

- `cart.item_added`, `cart.item_updated`, `cart.item_removed`, `cart.cleared`, `cart.details_saved` (`category: "business"`)
- `cart.checked_out` (`category: "business"`, attributes: `order_public_id`, `invoice_public_id`, `payment_mode`, `currency`, `subtotal_minor`, `discount_minor`, `tax_minor`, `total_minor`)
- `cart.checkout_payment_started` (`category: "business"`, attributes: `order_public_id`, `invoice_public_id`, `payment_mode`, `provider`, `attempt_public_id`)
- `cart.checkout_restored` (`category: "business"`, attributes: `source_cart_public_id`, `restored_into_cart_public_id`, `invoice_public_id`)
- `cart.expired` (`category: "business"`, actor `{ role: "system" }`, attributes: `inactivity_hours`)
- `authz.cart.denied` (`category: "security"`, `outcome: "denied"`, `severity: "WARN"`)

---

## 5. Exports for `/root` (Container, tRPC, Schema, Client Registry)

- **Schema (`server/db/schema/index.ts`):** `export * from "../../modules/cart/schema.js";` (`carts`, `cartItems`) — **schema final: yes**.
- **Server module (`server/container.ts`):** `createCartModule`, `type CartModule` from `server/modules/cart/index.js` -> `services.cart = createCartModule(deps)` (with `services.cart.init()` called in startup init alongside other scheduled-job modules).
- **tRPC router (`server/trpc/root.ts`):** `cartRouter` from `server/modules/cart/router.js` -> `cart: cartRouter`.
- **Client feature (`client/src/app/registry.ts`):** `cartFeature` from `@/features/cart/routes` + shell badge `CartBadge` from `client/src/features/cart/CartBadge.tsx`.
