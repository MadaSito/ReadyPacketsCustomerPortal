# Payments module — Hosted Stripe & Square Checkout API (Increment 04, Package K)

Owner: `compliance_engineer` (`server/modules/payments/**`, `client/src/features/payments/**`).
Status: Day-one ports published; implementation in progress on `feat/increment-04`.
Import types from `server/modules/payments/index.ts`; reach the runtime instance at call time via `deps.services.payments`.

## 1. Architecture & Security Invariants (ADR 0035, Contract §1.12 & §4)

- **Off by default:** `payments.config.provider` ships as `"none"` (`"none" | "stripe" | "square"`). When `"none"`, `startCheckout` returns `{ mode: "invoice", invoicePublicId }` with zero network calls. Switching providers or rotating keys requires `payments.manage` + fresh step-up authentication and is durably audited (`payments.settings.updated`).
- **Zero card-data handling:** Card details never touch ReadyPackets. Checkout redirects the customer's browser to a hosted Stripe Checkout Session (`https://checkout.stripe.com/...`) or hosted Square Payment Link (`https://square.link/...` / `https://*.squareup.com/...` / `https://*.squareupsandbox.com/...`).
- **No payment SDKs — pinned HTTPS egress only:** All provider calls run through `deps.services.integrations.egress.fetchPinned` (`purpose: "stripe"` for `api.stripe.com`; `purpose: "square"` for `connect.squareup.com` in `live` mode and `connect.squareupsandbox.com` in `test` mode) with `requireAllowlistRule: true`, `publicAddressesOnly: true`, TLS >= 1.2, pinned DNS lookup, and HTTP redirects refused.
- **Authoritative payment confirmation before marking an invoice paid (Increment 08 Decision D5 — replaces Increment 04 Decision 12):** An invoice is booked as paid in `compliance` through one idempotent `FOR UPDATE` booking function (`bookAuthoritativeAttemptPaymentInTx` -> `compliance.invoices.bookVerifiedProviderPayment`):
  - **Stripe (`provider === "stripe"`)**: booked by **either** a verified signed webhook at `/api/payments/webhooks/stripe` (`bookingSource = "webhook"`) **or** an authoritative read-only provider lookup (`GET /v1/checkout/sessions/{id}?expand[]=payment_intent.latest_charge`, `bookingSource = "provider_lookup"`) triggered by customer `payments.confirmCheckoutPayment`, scheduled/manual `reconcilePendingAttempts`, or admin step-up `payments.admin.checkWithStripeNow`, **only after** strict verification passes on the fetched session (`id === attempt.providerRef`, explicit boolean `livemode` matching configured `mode` and attempt `environment`, `status === "complete"`, `payment_status === "paid"` or `amountMinor === 0 && amount_total === 0 && payment_status === "no_payment_required"`, exact integer `amountMinor`, uppercase ISO 4217 `currency`, exact `metadata.{attempt_public_id,invoice_public_id,order_public_id}`, non-contradictory `client_reference_id`, and unchanged active Stripe key/mode post-egress). Late webhooks arriving after `provider_lookup` booking stamp `verifiedWebhookEventId` and settle cleanly as `ALREADY_PAID` with zero duplicate ledger rows; missing webhooks past the 10-minute grace window emit an operational warning alert (`STRIPE_WEBHOOK_DELIVERY_MISSING`) and surface diagnostics on `/admin/payments/setup`.
  - **Square (`provider === "square"`)**: retains double-verification (verified HMAC-SHA256 webhook + `fetchPayment` match).
- **Inert browser return route:** `GET /api/payments/return/:provider/:attemptPublicId` never mutates attempt or invoice state on the unauthenticated `GET` redirect itself and never trusts query parameters as redirect targets; it issues a `303` redirect only to fixed same-origin portal paths, where authenticated `/checkout/return` runs `payments.confirmCheckoutPayment`.
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
| `payments.publicConfig` | `protectedProcedure` | `{ provider, mode, currency, onlineEnabled }` (`onlineEnabled` is `true` only when active provider keys, webhook secret, outbound egress allowlist rule, and current-fingerprint verifications are all satisfied) |
| `payments.startInvoiceCheckout` | `protectedProcedure` | `{ invoicePublicId, returnPaths?, cartPublicId?, idempotencyKey? }` -> `StartCheckoutResult` (verifies caller owns the invoice's order; inherits `cartPublicId` when retrying a failed/cancelled cart checkout; throws customer-safe `UNAVAILABLE` / `ONLINE_PAYMENT_DISABLED` when online payment is off) |
| `payments.checkoutStatus` | `protectedProcedure` | `{ invoicePublicId?, attemptPublicId? }` -> `CheckoutStatusView` (read-only; includes `onlinePaymentAvailable`, `onlinePaymentUnavailableReason`, `attemptInFlight`, and `lastAttemptFailureClass`; `NOT_FOUND` for other customers) |
| `payments.confirmCheckoutPayment` | `protectedProcedure` (customer-only) | `{ attemptPublicId }` -> `ConfirmCheckoutPaymentResult` (verifies caller `role === "customer"` and order ownership before any provider call; enforces per-attempt 3s cooldown; books confirmed Stripe payments via `bookAuthoritativeAttemptPaymentInTx` with `bookingSource = "provider_lookup"`; returns `state: "paid" \| "processing" \| "unpaid"`) |
| `payments.cancelAttempt` | `protectedProcedure` | `{ invoicePublicId?, attemptPublicId? }` -> `CancelAttemptResult` |
| `payments.admin.getSettings` | `payments.manage` | Non-secret settings view + key configured/last4 indicators + active/not-active `statusHeadline`, `customerExperienceSummary`, `missingGates`, `reverificationNeeded`, `reverificationReasons`, `lastCheckoutFailure`, and `lastCheckoutProbe` |
| `payments.admin.updateSettings` | `payments.manage` (step-up) | Normalizes pasted secret inputs, validates shape per field (`DomainError.details = { field, reason }` without echoing content), updates provider (`none` \| `stripe` \| `square`), `mode` (`test` \| `live`), `currency`, return paths, tolerance, and write-only secrets; rotating an active Stripe key pauses `onlineEnabled` until re-verified |
| `payments.admin.readiness` | `payments.manage` | Live setup readiness checklist (`onlineEnabled`, `statusHeadline`, `customerExperienceSummary`, `missingGates`, `reverificationNeeded`, `lastCheckoutFailure`, `lastCheckoutProbe`, canonical webhook URL, required 9 Stripe events, egress preset status, protection country-allowlist exemption status, primary/secondary secret status, last API verification, last real/self-test webhook, recent rejection summary) |
| `payments.admin.testConnection` | `payments.manage` (step-up) | Non-mutating live Stripe API check (`GET /v1/checkout/sessions?limit=1` over pinned egress) verifying secret key + test/live mode match + egress rule; updates `stripeLastApiVerifiedAt` |
| `payments.admin.verifyCheckoutSession` | `payments.manage` (step-up) | Zero-cost live Checkout Session creation probe (`POST /v1/checkout/sessions` + immediate `POST /v1/checkout/sessions/{id}/expire` over pinned egress) catching read-only restricted keys (`STRIPE_KEY_MISSING_PERMISSION`) and custom Checkout domains (`STRIPE_UNTRUSTED_REDIRECT_URL`) before activation; audited `payments.setup.checkout_probe` |
| `payments.admin.sendSelfTestWebhook` | `payments.manage` (step-up) | Generates a synthetic `evt_test_rp_selftest_<ulid>` payload signed with the stored primary `whsec_` and runs `handleSignedWebhook` end-to-end (`status: "ignored"`, `reasonCode: "SELF_TEST_OK"`, zero ledger mutation); audited `payments.setup.self_test` |
| `payments.admin.listWebhookRejections` | `payments.manage` | Cursor-paginated `payment_webhook_rejections` (`provider?`, `cursor?`, `limit?`) — safe reason codes, HTTP status, skew seconds, environment hint, timestamp only |
| `payments.admin.listAttempts` | `payments.manage` | Cursor-paginated attempts (`status?`, `provider?`, `invoicePublicId?`, `cursor?`, `limit?`) |
| `payments.admin.getAttempt` | `payments.manage` | Detailed attempt view + linked verified webhook receipts |
| `payments.admin.listWebhooks` | `payments.manage` | Cursor-paginated `payment_webhook_events` (`provider?`, `status?`, `cursor?`, `limit?`) |
| `payments.admin.reconcileNow` | `payments.manage` (step-up) | Triggers an audited immediate reconciliation pass (`ReconcilePaymentsResult`) |
| `payments.admin.checkWithStripeNow` | `payments.manage` (step-up) | `{ attemptPublicId?, invoicePublicId? }` -> `AdminCheckWithStripeResult` (queries Stripe directly for any non-paid Stripe attempt on the invoice — including `redirected`, `expired`, `cancelled`, and `failed` pre-upgrade attempts — and books confirmed payments idempotently with `bookingSource = "provider_lookup"`, audited `payments.admin.stripe_checked`) |
| `payments.refunds.forOrder` | `staffProcedure` + `invoices.read_all` | `{ orderPublicId }` -> `OrderRefundWorkspaceView` (per-payment captured, refunded, reserved, refundable balances & refund history; reason redacted when caller lacks `payments.refund`) |
| `payments.refunds.create` | `staffProcedure` + `payments.refund` (step-up) | `{ orderPublicId, paymentPublicId, amountMinor, currency, reason, sendCustomerNotice, confirmationPhrase: "REFUND ORDER", idempotencyKey }` -> `CreateOrderRefundResult` |

---

## 6. Capabilities, Jobs & Exports for `/root`

- Capabilities:
  - `payments.manage` (`admin`, in `STEP_UP_CAPABILITIES`)
  - `payments.refund` (`admin`, in `STEP_UP_CAPABILITIES`)
- Background jobs:
  - `payments.reconcile_redirected` (registered on `deps.jobs` in `payments.init()`)
  - `compliance.refund.reconcile` (registered via `registerRefundReconciliation` in `payments.init()`; performs read-only `GET` lookup on `pending` / `unknown` provider refunds and never re-POSTs)
- Increment 04 Part B refund architecture (`server/modules/payments/service.ts`, `providers/stripe.ts`, `providers/square-refund.ts`):
  - `payment_refunds` stores encrypted `reasonEnc` (never PAN), `providerIdempotencyKey = "rp-refund-" + refundPublicId`, `status` (`pending` | `succeeded` | `failed` | `unknown`), and `complianceRefundPublicId`.
  - Intent is committed as `pending` under `FOR UPDATE` locks before outbound provider egress; `unknown` transport/5xx/409/429 outcomes reserve refundable balance and never resend `POST`.
  - Verified `refund.created` / `refund.updated` webhooks re-query the provider via `lookupRefund` before settling.
  - Manual payments execute synchronously inside `tx` with `executionKind = "recorded_only"` and zero external calls.
- Server exports (for `/root` container & tRPC wiring):
  - `createPaymentsModule`, `type PaymentsModule` from `server/modules/payments/index.ts`
  - `paymentsRouter` from `server/modules/payments/router.ts`
  - Drizzle tables `paymentAttempts`, `paymentWebhookEvents`, `paymentRefunds` from `server/modules/payments/schema.ts`
- Client export (for `/root` `client/src/app/registry.ts`):
  - `paymentsFeature` from `client/src/features/payments/routes.tsx` (`/admin/payments`, Console group `"Billing & compliance"`, `order: 41`, `capability: "payments.manage"`, plus Console order workspace Refunds tab).

---

## 7. Increment 06 — D5 Small Totals & Provider Minimums + D15 Receipt Preferences

- Settings (`server/modules/payments/settings.ts`):
  - `payments.small_totals`: `{ belowProviderMinimum: "waive" | "block" }` (default `"waive"`, backward-compatible parse with defaults).
  - `payments.receipts`: `{ enabled: boolean, emailCustomer: boolean, footerText: string }` (default `{ enabled: true, emailCustomer: true, footerText: "" }`).
- Provider minimum table (`server/modules/payments/providerMinimums.ts`):
  - Exports `providerMinimumMinor(provider, currency)` (`50` minor units USD/EUR/CAD/AUD, `30` GBP for Stripe; `100` minor units for Square; `0` when `provider === "none"`), `evaluateSmallTotalForProvider`, and `PaymentsModule.evaluateSmallTotal(amountMinor, currency, opts?)`.
- Checkout settlement (`StartCheckoutResult` in `server/modules/payments/types.ts`):
  - `{ mode: "settled_zero", invoicePublicId, receiptPublicId }` when `balanceDueMinor === 0` (`$0.00` order/promo total) — settles immediately with zero provider calls and issues a `$0.00` receipt (`RPR-...`).
  - `{ mode: "settled_waived", invoicePublicId, waivedMinor, receiptPublicId }` when `0 < balanceDueMinor < providerMinimumMinor` and `belowProviderMinimum === "waive"` — acquires `FOR UPDATE` on the invoice row, checks `payment_attempts` under `FOR SHARE NOWAIT`, refuses waiver (`CONFLICT` / `PRIOR_PAYMENT_EXPOSURE`) if **any** prior provider attempt row exists or if lock contention occurs, and records an idempotent `"waiver"` settlement row + receipt (`waivedMinor` settles balance while keeping `grossPaidMinor = 0`).
  - Throws `VALIDATION_ERROR` (`BELOW_PROVIDER_MINIMUM`, `{ minimumMinor, currency, provider }`) when `0 < balanceDueMinor < providerMinimumMinor` and `belowProviderMinimum === "block"`.
- `payments.getCheckoutStatus` exposes `waivedMinor`, `settlementKind`, and `receiptPublicId` (including `settled_zero` / `settled_waived` invoices that never created a provider attempt) for `cart` return/confirmation surfaces.
- Admin UI (`client/src/features/payments/PaymentSettings.tsx`, designed and tested against WCAG 2.2 AA) configures both `smallTotals.belowProviderMinimum` and `receipts.{enabled,emailCustomer,footerText}` behind `payments.admin.updateSettings` (`payments.manage` + step-up MFA).

---

## 8. Increment 07 — Package M (Decision D9: Stripe Completion, Setup Diagnostics & Order/Cart Advancement)

- **Additive schema (`server/modules/payments/schema.ts`)**:
  - `payment_webhook_events`: widens `status` enum with `'awaiting_settlement'` and `'attention_required'`, and adds `last_error_code varchar(64) null` and `attempt_count int unsigned not null default 1`.
  - `payment_webhook_rejections`: diagnostic row per pre-verify or post-verify failure (`id`, `public_id`, `provider`, `environment_hint`, `reason_code`, `http_status`, `skew_seconds`, `received_at`); stores safe reason codes only — zero raw body, headers, IP addresses, or secret material; pruned after 14 days during `payments.reconcile_redirected`.
- **Settings & secrets (`server/modules/payments/settings.ts`, backward-compatible defaults)**:
  - `payments.stripe.webhook_secret_secondary` (`defineSecret`, `exportable: false`, `whsec_...`) for zero-downtime signing secret rotation; `verifyWebhook` accepts signatures valid under either the primary or secondary secret.
  - `payments.config` adds `stripeWebhookSecretSecondaryLast4: string | null` (default `null`), `stripeLastApiVerifiedAt: string | null` (default `null`), `stripeApiVerifiedFingerprint: string | null` (default `null`), and `stripeSelfTestedFingerprint: string | null` (default `null`).
  - Staged setup & strict activation gate: administrators stage `sk_*` / `rk_*` and `whsec_*` while keeping `provider: "none"`, enable the `stripe` egress preset, run `testConnection` (records `stripeLastApiVerifiedAt` + `stripeApiVerifiedFingerprint` bound to `{ mode, stripeSecretKey, stripeEgressStamp }`), run `verifyCheckoutSession` (records `lastStripeCheckoutProbe` bound to `{ mode, apiFingerprint }`), and run `sendSelfTestWebhook` (records `stripeLastSelfTestAt` + `stripeSelfTestedFingerprint` bound to `{ mode, stripeWebhookSecret }`).
  - `payments.admin.updateSettings` refuses **new** Stripe activations (switching `provider` to `"stripe"` or switching `mode` while `provider === "stripe"`) unless all prerequisites — including a passing `verifyCheckoutSession` probe for the **current** API fingerprint and mode — are verified (`STRIPE_EGRESS_NOT_ALLOWLISTED`, `STRIPE_API_NOT_VERIFIED`, `STRIPE_CHECKOUT_SESSION_NOT_VERIFIED`, `STRIPE_WEBHOOK_NOT_VERIFIED`). An already-activated Stripe setup (`prev.provider === "stripe"` and same `mode`) stays active after upgrade even with no probe on record, and in-place secret rotation keeps its current rules (saving the new secret pauses `onlineEnabled` until `testConnection` / `sendSelfTestWebhook` re-runs; only a failed probe for the current key/mode blocks or pauses readiness).
  - `isOnlineCheckoutEnabled` / `publicConfig.onlineEnabled` returns `true` when the active provider's credentials, webhook signing secret, outbound egress allowlist rule, and (for Stripe) current-fingerprint API + self-test verifications are all satisfied and no Checkout-session probe for the current key/mode has failed (it does not depend on a probe being present on upgraded servers).
- **Webhook protocol fixes (`server/modules/payments/providers/stripe.ts`, `service.ts`)**:
  - **Async payment methods (`ACH`, `SEPA`, bank transfer)**: when `checkout.session.completed` arrives while `payment_status === "unpaid"` (`fetched.status === "open"`), `handleSignedWebhook` records `payment_webhook_events.status = "awaiting_settlement"` (`reasonCode: "AWAITING_ASYNC_SETTLEMENT"`), calls `services.orders.payments.onPaymentEventInTx({ orderPublicId, kind: "pending_async", eventRef }, tx)`, emits `payments.attempt.pending_async`, and returns `200 OK` (never `503` retry storm). Subsequent `checkout.session.async_payment_succeeded` re-fetches `paid` and books the ledger.
  - **Unmatched portal sessions vs. shared Stripe accounts**: when a verified payment webhook cannot be matched to any portal attempt or invoice:
    - If the event carries ReadyPackets metadata (`metadata.attempt_public_id`, `metadata.invoice_public_id`, or `metadata.order_public_id`), `handleSignedWebhook` records `status = "attention_required"`, `reasonCode = "UNMATCHED_PORTAL_PAYMENT"` (incrementing `attentionRequiredWebhookCount`), audits `payments.webhook.unmatched_portal_session` (`WARN`), emits an operational warning alert via `services.opsAlerts.emit({ source: "payment", severity: "warning", code: "UNMATCHED_PORTAL_PAYMENT", ... })`, and returns `200 UNMATCHED_PORTAL_PAYMENT`.
    - If the event carries no portal metadata (shared Stripe account used by external tools), it is recorded quietly as `status = "ignored"`, `reasonCode = "ATTEMPT_NOT_FOUND"` (`200 IGNORED`) without incrementing `attentionRequiredWebhookCount` or alerting.
  - **Rejection diagnostics (`payments.admin.listWebhookRejections`)**: returns human `reasonLabel`, human `detail`, and secondary raw `reasonCode` (`INVALID_SIGNATURE`, `MISSING_SIGNATURE`, `TIMESTAMP_OUT_OF_RANGE`, `INVALID_JSON`, `WEBHOOK_MODE_MISMATCH`, `WEBHOOK_NOT_CONFIGURED`, `PAYLOAD_TAMPER_CONFLICT`, `WEBHOOK_EMPTY_BODY`). Non-JSON media types (`HTTP 400`) and payloads over `256 KiB` (`HTTP 413`) are refused at the HTTP transport layer before webhook verification and are not written to `payment_webhook_rejections`.
  - **Refund listing & unlinked refunds**: when `charge.refunded` omits `refunds.data` (modern Stripe API versions), `stripe` queries `GET /v1/refunds?payment_intent=...` (or `charge=...`) over pinned egress. Any upstream provider refund without a matching portal `payment_refunds` row / `metadata.refund_public_id` (e.g. manual refund in Stripe Dashboard) is **never auto-booked**: the webhook row is marked `status = "attention_required"`, `reasonCode = "UNLINKED_PROVIDER_REFUND"`, audited (`payment.refund.flagged`), and surfaces an operational alert via `services.opsAlerts.emit({ source: "payment", severity: "warning", code: "UNLINKED_PROVIDER_REFUND", ... })`.
  - **Required 9 Stripe webhook events**: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.payment_failed`, `charge.refunded`, `refund.created`, `refund.updated`, `charge.refund.updated`.
- **Client routes (`client/src/features/payments/routes.tsx`)**:
  - `/admin/payments` (`PaymentsPage`) — adds persistent readiness warning banner when `provider === "stripe"` and any checklist prerequisite is incomplete, linking to `/admin/payments/setup`.
  - `/admin/payments/setup` (`PaymentSetupPage`, `payments.manage`) — guided Stripe checklist, copyable canonical webhook URL and 9-event list, egress preset toggle (`integrations.egress`), staged primary/secondary key save, `"Test Stripe API"` and `"Send self-test webhook"` buttons (step-up), last verified event status, `"Webhook rejections"` table, and copyable `stripe listen` / `stripe trigger` CLI commands.

---

## 9. Increment 08 — Package D5 (Authoritative Payment Confirmation, Booking Source & Missing-Webhook Diagnostics)

- **Decision 12 replaced for Stripe (`docs/engineering/INCREMENT_08_CONTRACT.md` §1 D5)**:
  - Additive columns on `payment_attempts` (`server/modules/payments/schema.ts`, Migration 0008): `booking_source enum('webhook','provider_lookup','manual') null`, `last_customer_lookup_at datetime(3) null`, `missing_webhook_alerted_at datetime(3) null`, and index `pmt_att_bk_wh_idx (booking_source, verified_webhook_event_id, paid_at)`.
  - One idempotent booking path (`bookAuthoritativeAttemptPaymentInTx`) acquires `SELECT ... FOR UPDATE` on `payment_attempts`, verifies strict provider checks (`validateFetchedStripePaymentAgainstAttempt`), books via `compliance.invoices.bookVerifiedProviderPayment(..., { tx })`, stamps `bookingSource` (`"webhook"` vs `"provider_lookup"`), advances order payment state (`INVOICE_PAID`), and transitions linked carts (`checked_out`).
  - Strict verification checks on `GET /v1/checkout/sessions/{id}?expand[]=payment_intent.latest_charge`:
    - Explicit non-empty returned `id` matching `attempt.providerRef` (`PROVIDER_REF_MISMATCH`; never falls back to caller input).
    - Explicit boolean `livemode` matching both configured `mode` (`test` -> `false`, `live` -> `true`) and `attempt.environment` (`LIVEMODE_MISMATCH`).
    - `status === "complete"` and (`payment_status === "paid"` or (`attempt.amountMinor === 0 && amount_total === 0 && payment_status === "no_payment_required"`)). `status === "complete"` with `payment_status === "unpaid"` (ACH/SEPA async debit) records `reconciliationNote = "awaiting_async_settlement"` and returns `state: "processing"` without booking or failing.
    - Exact integer `amountMinor` (`AMOUNT_MISMATCH`) and uppercase ISO 4217 `currency` (`CURRENCY_MISMATCH`).
    - Exact `metadata.attempt_public_id`, `metadata.invoice_public_id`, and `metadata.order_public_id` (`METADATA_MISMATCH`), plus non-contradictory `client_reference_id` (`REFERENCE_CONFLICT`).
    - Post-egress drift guard (`PROVIDER_DISABLED_DURING_LOOKUP` / `KEY_OR_MODE_ROTATED_DURING_LOOKUP`).
    - Mismatches are durably audited (`payments.verification.mismatch`) and emit operational alert `PAYMENT_VERIFICATION_MISMATCH`.
- **Reconciliation & missing-webhook operational alerting**:
  - `reconcilePendingAttempts` books verified paid Stripe sessions directly (`bookingSource = "provider_lookup"`) instead of leaving them at `awaiting_webhook`.
  - Any attempt with `booking_source = "provider_lookup"`, `verified_webhook_event_id IS NULL`, and `paid_at` older than 10 minutes (`600s` grace window) triggers a deduplicated warning alert (`STRIPE_WEBHOOK_DELIVERY_MISSING`) via `services.opsAlerts.emit`, stamps `missing_webhook_alerted_at`, and sets `stripe.webhookDelivery.missingWebhookDetected = true` on `payments.admin.getSettings` / `payments.admin.readiness` (exposing `lastVerifiedWebhookAt`, 24h `recentRejectionReasons`, `endpointUrl`, `requiredEvents`, and the 3 `usualCauses`).
- **Shared client exports (`client/src/features/payments/index.ts`)**:
  - `PaymentReturnConfirmation` (`PaymentReturnConfirmation.tsx`) — rendered by `CheckoutReturnPage` on `/checkout/return?attempt=...`; invokes `payments.confirmCheckoutPayment` on mount, auto-rechecks with exponential back-off (`CONFIRM_BACKOFF_DELAYS_MS`), supports manual `"Check payment status"`, and presents `"Continue to your order"` + `"View receipt"`.
  - `AdminCheckStripePaymentButton` (`AdminCheckStripePaymentButton.tsx`) — rendered on Console invoice detail (`/admin/invoices/:invoiceId`) and `/admin/payments` attempt drawer; gated to `admin` (`payments.manage`) on `issued` `portal` invoices, enforces step-up MFA, and repairs pre-upgrade payments as well.



