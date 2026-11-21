# Payments module — Hosted Stripe & Square Checkout API (Increment 04, Package K)

Owner: `compliance_engineer` (`server/modules/payments/**`, `client/src/features/payments/**`).
Status: Day-one ports published; implementation in progress on `feat/increment-04`.
Import types from `server/modules/payments/index.ts`; reach the runtime instance at call time via `deps.services.payments`.

## 1. Architecture & Security Invariants (ADR 0035, Contract §1.12 & §4)

- **Off by default:** `payments.config.provider` ships as `"none"` (`"none" | "stripe" | "square"`). When `"none"`, `startCheckout` returns `{ mode: "invoice", invoicePublicId }` with zero network calls. Switching providers or rotating keys requires `payments.manage` + fresh step-up authentication and is durably audited (`payments.settings.updated`).
- **Zero card-data handling:** Card details never touch ReadyPackets. Checkout redirects the customer's browser to a hosted Stripe Checkout Session (`https://checkout.stripe.com/...`) or hosted Square Payment Link (`https://square.link/...` / `https://*.squareup.com/...` / `https://*.squareupsandbox.com/...`).
- **No payment SDKs — pinned HTTPS egress only:** All provider calls run through `deps.services.integrations.egress.fetchPinned` (`purpose: "stripe"` for `api.stripe.com`; `purpose: "square"` for `connect.squareup.com` in `live` mode and `connect.squareupsandbox.com` in `test` mode) with `requireAllowlistRule: true`, `publicAddressesOnly: true`, TLS >= 1.2, pinned DNS lookup, and HTTP redirects refused.
- **Double-verification before marking an invoice paid (Decision 12):** An invoice is booked as paid in `compliance` **only after both**:
  1. A provider webhook is received at `/api/payments/webhooks/:provider` with a valid constant-time HMAC-SHA256 signature over the raw `Buffer` and a fresh timestamp within `±300` seconds (±5 minutes), deduplicated in `payment_webhook_events`; **and**
  2. The authoritative payment/session object fetched back from the provider via `fetchPayment` matches the stored `payment_attempts` row (`provider`, `mode`/`livemode`, `providerRef`, exact integer `amountMinor`, uppercase ISO 4217 `currency`, and `invoicePublicId` / `attemptPublicId` metadata).
- **Inert browser return route:** `GET /api/payments/return/:provider/:attemptPublicId` never mutates attempt or invoice state and never trusts query parameters as redirect targets; it issues a `303` redirect only to fixed same-origin portal paths.
- **Write-only secrets:** Provider API secrets and webhook signing keys are stored via `defineSecret(..., { exportable: false })` (AES-256-GCM at rest) and are never returned after save, logged, placed in audit attributes, or included in portable exports.

---

## 2. Cross-Module Service Ports (`PaymentsModule` on `deps.services.payments`)

```ts
export type PaymentProviderChoice = "none" | "stripe" | "square";
export type ActivePaymentProvider = "stripe" | "square";
export type PaymentEnvironmentMode = "test" | "live";

export type PaymentAttemptStatus =
  | "created"
  | "redirected"
  | "paid"
  | "failed"
  | "expired"
  | "cancelled";

export interface CheckoutReturnPaths {
  /** Optional safe relative path override (must match allowlisted internal prefix, e.g. `/checkout/return`). */
  successPath?: string | undefined;
  /** Optional safe relative path override (must match allowlisted internal prefix, e.g. `/checkout/cancel`). */
  cancelPath?: string | undefined;
}

export interface StartCheckoutOptions {
  /** Required when initiated by a customer/staff session to enforce order/invoice ownership before redirect. */
  principal?: SessionPrincipal | undefined;
  /** Optional originating cart ULID (`cart` module) recorded on the attempt for return/cancel correlation. */
  cartPublicId?: string | undefined;
  /** Optional caller idempotency key (8..128 chars); reuses an active `created`/`redirected` attempt when matching. */
  idempotencyKey?: string | undefined;
}

export type StartCheckoutResult =
  | {
      mode: "invoice";
      invoicePublicId: string;
    }
  | {
      mode: "redirect";
      attemptPublicId: string;
      invoicePublicId: string;
      provider: ActivePaymentProvider;
      environment: PaymentEnvironmentMode;
      redirectUrl: string;
      expiresAt: Date | null;
    };

export interface CheckoutStatusView {
  invoicePublicId: string;
  invoiceNumber: string | null;
  invoiceStatus: "draft" | "issued" | "paid" | "void";
  amountMinor: number;
  balanceDueMinor: number;
  currency: string;
  providerConfigured: PaymentProviderChoice;
  environment: PaymentEnvironmentMode;
  attempt: {
    attemptPublicId: string;
    provider: ActivePaymentProvider;
    environment: PaymentEnvironmentMode;
    status: PaymentAttemptStatus;
    cartPublicId: string | null;
    amountMinor: number;
    currency: string;
    createdAt: Date;
    redirectedAt: Date | null;
    paidAt: Date | null;
    expiresAt: Date | null;
    failureReasonCode: string | null;
  } | null;
}

export interface CancelAttemptResult {
  cancelled: boolean;
  attemptPublicId: string | null;
  status: PaymentAttemptStatus | null;
}

export interface PaymentWebhookResult {
  httpStatus: 200 | 400 | 409 | 503;
  accepted: boolean;
  duplicate: boolean;
  booked: boolean;
  reasonCode: string;
}

export interface ReconcilePaymentsResult {
  scanned: number;
  booked: number;
  expired: number;
  failed: number;
  stillPending: number;
}

export interface PaymentsModule extends ModuleLifecycle {
  /** True when `provider` is `"stripe"` or `"square"` and all required keys for that provider are configured. */
  isOnlineCheckoutEnabled(tx?: DbOrTx): Promise<boolean>;

  /** Safe non-secret configuration summary for checkout UIs (`provider`, `mode`, `currency`). */
  getPublicCheckoutConfig(tx?: DbOrTx): Promise<{
    provider: PaymentProviderChoice;
    mode: PaymentEnvironmentMode;
    currency: string;
  }>;

  /**
   * Contract §3 port for `cart` (`recovery_ops_engineer`) and customer invoice pay-now:
   * - Call AFTER the checkout transaction that created/issued the invoice has committed (performs outbound egress).
   * - When `provider === "none"`, returns `{ mode: "invoice", invoicePublicId }`.
   * - When `provider` is `"stripe"` or `"square"`, creates a `payment_attempts` row (`created`), creates the hosted
   *   session/payment-link over pinned egress, transitions the attempt `created -> redirected`, and returns
   *   `{ mode: "redirect", attemptPublicId, invoicePublicId, provider, environment, redirectUrl, expiresAt }`.
   */
  startCheckout(
    invoicePublicId: string,
    returnPaths?: CheckoutReturnPaths,
    options?: StartCheckoutOptions,
  ): Promise<StartCheckoutResult>;

  /**
   * Read-only status query for return pages (`/checkout/return`, `/invoices/:id`).
   * Enforces owner/staff resource scope (`NOT_FOUND` for other customers). Never mutates attempt or invoice state.
   */
  getCheckoutStatus(
    principal: SessionPrincipal,
    query: { invoicePublicId?: string; attemptPublicId?: string },
  ): Promise<CheckoutStatusView>;

  /**
   * Customer/cart cancellation port: compare-and-set transitions an unpaid (`created` | `redirected`) attempt
   * to `cancelled` so `cart` can safely restore the customer's cart. If already `paid`, returns
   * `{ cancelled: false, attemptPublicId, status: "paid" }` without altering ledger state.
   */
  cancelAttemptIfUnpaid(
    principal: SessionPrincipal,
    target: { invoicePublicId?: string; attemptPublicId?: string },
    tx?: Tx,
  ): Promise<CancelAttemptResult>;

  /** Verified raw webhook entry point invoked by `createPaymentWebhooksHttpRouter`. */
  handleSignedWebhook(input: {
    provider: ActivePaymentProvider;
    rawBody: Buffer;
    headers: Readonly<Record<string, string | undefined>>;
    notificationUrl: string;
  }): Promise<PaymentWebhookResult>;

  /** Worker/admin reconciliation pass for `redirected` attempts and `retry_pending` verified webhooks. */
  reconcilePendingAttempts(options?: {
    limit?: number;
    signal?: AbortSignal;
  }): Promise<ReconcilePaymentsResult>;
}
```

---

## 3. Provider Adapter Interface (`server/modules/payments/providers/types.ts`)

```ts
export interface PaymentProviderAdapter {
  readonly key: ActivePaymentProvider;
  createCheckout(input: ProviderCreateCheckoutInput): Promise<{
    redirectUrl: string;
    providerRef: string;
    providerOrderRef?: string | null;
    providerPaymentRef?: string | null;
    expiresAt?: Date | null;
  }>;
  verifyWebhook(input: {
    rawBody: Buffer;
    headers: Readonly<Record<string, string | undefined>>;
    webhookSecret: string;
    notificationUrl: string;
    now: Date;
    toleranceSeconds: number;
  }):
    | {
        ok: true;
        externalEventId: string;
        eventType: string;
        occurredAt: Date;
        livemode: boolean;
        attemptPublicId: string | null;
        providerRef: string | null;
        providerOrderRef: string | null;
        providerPaymentRef: string | null;
        outcomeHint: "paid" | "failed" | "expired" | "ignored";
      }
    | { ok: false; reasonCode: string };
  fetchPayment(input: {
    providerRef: string;
    providerOrderRef?: string | null;
    providerPaymentRef?: string | null;
    mode: PaymentEnvironmentMode;
    secretKey: string;
    signal?: AbortSignal;
    beforeSend?: () => Promise<void>;
  }): Promise<{
    providerRef: string;
    providerPaymentId: string | null;
    status: "paid" | "open" | "failed" | "expired";
    amountMinor: number;
    currency: string;
    livemode: boolean;
    attemptPublicId: string | null;
    invoicePublicId: string | null;
  }>;
}
```

---

## 4. Raw HTTP Router Factories (`server/modules/payments/http.ts`)

Mounted by `http_security_engineer` (`server/http/API.md` slots `K webhook` and `K return`):

- `createPaymentWebhooksHttpRouter(services: Services): Router` (mounted at `/api/payments/webhooks`, `POST` only, raw `Buffer` up to 256 KiB, canonical host, no cookie auth or CSRF):
  - `POST /stripe` — verifies `Stripe-Signature` (`t=...,v1=...`, ±300s) before JSON parsing.
  - `POST /square` — verifies `x-square-hmacsha256-signature` (`Base64(HMAC-SHA256(key, notificationUrl + rawBody))`, ±300s on `created_at`) before JSON parsing.
- `createPaymentReturnHttpRouter(services: Services): Router` (mounted at `/api/payments/return`, `GET` only, no body, canonical host, no cookie auth or CSRF):
  - `GET /:provider/:attemptPublicId` — validates `:provider` (`stripe` | `square`) and `:attemptPublicId` (ULID), mutates nothing, discloses no state, and responds `303 See Other` to `<successPath>?attempt=<attemptPublicId>&result=return` or `<cancelPath>?attempt=<attemptPublicId>&result=cancelled`.

---

## 5. tRPC Procedures (`trpc.payments.*`)

| Procedure | Guard | Summary |
| --- | --- | --- |
| `payments.publicConfig` | `protectedProcedure` | `{ provider, mode, currency, onlineEnabled }` |
| `payments.createInvoiceCheckout` | `protectedProcedure` | `{ invoicePublicId, returnPaths?, idempotencyKey? }` -> `StartCheckoutResult` (verifies caller owns the invoice's order) |
| `payments.getCheckoutStatus` | `protectedProcedure` | `{ invoicePublicId?, attemptPublicId? }` -> `CheckoutStatusView` (read-only; `NOT_FOUND` for other customers) |
| `payments.cancelAttempt` | `protectedProcedure` | `{ invoicePublicId?, attemptPublicId? }` -> `CancelAttemptResult` |
| `payments.admin.getSettings` | `payments.manage` | Non-secret settings view + key configured/last4 indicators + webhook URLs + egress status |
| `payments.admin.updateSettings` | `payments.manage` (step-up) | Updates provider (`none` \| `stripe` \| `square`), `mode` (`test` \| `live`), `currency`, return paths, tolerance, and write-only secrets |
| `payments.admin.listAttempts` | `payments.manage` | Cursor-paginated attempts (`status?`, `provider?`, `invoicePublicId?`, `cursor?`, `limit?`) |
| `payments.admin.getAttempt` | `payments.manage` | Detailed attempt view + linked verified webhook receipts |
| `payments.admin.listWebhooks` | `payments.manage` | Cursor-paginated `payment_webhook_events` (`provider?`, `status?`, `cursor?`, `limit?`) |
| `payments.admin.reconcileNow` | `payments.manage` (step-up) | Triggers an audited immediate reconciliation pass (`ReconcilePaymentsResult`) |

---

## 6. Capabilities, Jobs & Exports for `/root`

- Capability: `payments.manage` (`admin`, in `STEP_UP_CAPABILITIES`).
- Background job: `payments.reconcile_redirected` (registered on `deps.jobs` in `payments.init()`).
- Server exports (for `/root` container & tRPC wiring):
  - `createPaymentsModule`, `type PaymentsModule` from `server/modules/payments/index.ts`
  - `paymentsRouter` from `server/modules/payments/router.ts`
  - Drizzle tables `paymentAttempts`, `paymentWebhookEvents` from `server/modules/payments/schema.ts`
- Client export (for `/root` `client/src/app/registry.ts`):
  - `paymentsFeature` from `client/src/features/payments/routes.tsx` (`/admin/payments`, Console group `"Billing & compliance"`, `order: 41`, `capability: "payments.manage"`).
