# Package K (`payments` + `compliance` Increment 04 ports) — Verification Record

## 1. Architecture & Security Invariants Verified

1. **Off-by-default & zero SDKs (`provider = "none"`):**
   - Default `PAYMENTS_CONFIG_SETTING` ships with `provider: "none"`.
   - `startCheckout` returns `{ mode: "pay_by_invoice" }` and `reconcilePendingAttempts` returns immediately with zero outbound network calls when `provider === "none"`.
   - Zero Stripe or Square SDK packages exist in `package.json`; all outbound provider traffic routes exclusively through `services.integrations.egress.fetchPinned` (`purpose: "stripe"` or `"square"`, `requireAllowlistRule: true`, `publicAddressesOnly: true`, pinned `expectedHostSuffixes`).
2. **Write-only AES-256-GCM secrets & fresh-pair mode rotation:**
   - `payments.stripe.secret_key`, `payments.stripe.webhook_secret`, `payments.square.access_token`, and `payments.square.webhook_secret` are registered via `defineSecret(..., exportable: false, writeCapability: "payments.manage")`.
   - Admin read DTOs expose only `{ configured: boolean, last4: string | null }`.
   - Switching `provider` or `mode` (`test` <-> `live`) to an active provider requires supplying a fresh credential pair (`FRESH_CREDENTIALS_REQUIRED`), and Stripe key prefixes (`sk_test_` / `rk_test_` vs `sk_live_` / `rk_live_`) are enforced against `mode`.
3. **Authoritative payment confirmation & replay defense (Increment 08 Decision D5 — supersedes Increment 04 Decision 12 for Stripe):**
   - Raw webhook router (`POST /api/payments/webhooks/:provider`) enforces `<= 256 KiB` raw `Buffer`, verifies Stripe HMAC-SHA256 (`t=...,v1=...`) or Square HMAC-SHA256 (`notificationUrl + rawBody` + `square-environment` consistency check against configured `mode`), enforces `<= 300 s` replay window, and deduplicates `(provider, external_event_id)` with SHA-256 payload-tamper detection (`409 PAYLOAD_TAMPER_CONFLICT`).
   - One idempotent booking path (`bookAuthoritativeAttemptPaymentInTx`) acquires `FOR UPDATE` row locks on `payment_attempts` (and `payment_webhook_events` when webhook-triggered), enforces all strict session verification checks (`id === attempt.providerRef`, explicit boolean `livemode` matching configured `mode` and attempt `environment`, `status === "complete"`, `payment_status === "paid"` or `amountMinor === 0 && amount_total === 0 && payment_status === "no_payment_required"`, exact `amountMinor`, `currency`, `metadata.{attempt_public_id,invoice_public_id,order_public_id}`, non-contradictory `client_reference_id`, and post-egress key/mode stability), records `booking_source` (`"webhook"` or `"provider_lookup"`), and calls `compliance.invoices.bookVerifiedProviderPayment(..., { tx })`.
   - `reconcilePendingAttempts` books verified paid Stripe sessions directly (`booking_source = "provider_lookup"`) rather than parking them at `awaiting_webhook` (Square retains double-verification), and emits deduplicated `STRIPE_WEBHOOK_DELIVERY_MISSING` operational alerts when a `provider_lookup`-booked attempt has still received no verified webhook after 10 minutes.
   - `GET /api/payments/return/:provider/:attemptPublicId` performs zero database reads/writes on the unauthenticated browser redirect and issues `303 See Other` (`Cache-Control: no-store`) only to fixed internal paths (`/checkout/return`, `/checkout/cancel`, `/invoices`), where authenticated `/checkout/return` executes `payments.confirmCheckoutPayment`.
4. **Structured error correlation (K-01):**
   - `server/modules/payments/http.ts` logs only `{ provider, reasonCode, errorName, correlationId, requestId }` on unexpected callback errors and never logs raw exception strings (`err.message`).
5. **Downstream transactional fan-out & privacy disclosure:**
   - `bookVerifiedProviderPayment` records idempotent ledger payment `(provider, providerPaymentRef)` inside the caller's `tx`, emits `invoice.payment.recorded` (`environment` preserved) -> `AuditTap` triggers outbound `"invoice.paid"` automation webhook on commit, invokes `services.referrals.onInvoicePaid(event, { tx })`, and notifies in-process `onInvoicePaid` subscribers after commit.
   - `/privacy` (`client/src/features/auth/pages/PrivacyPage.tsx`) discloses optional Stripe Checkout and Square Payment Links redirect and bounded checkout metadata.

## 2. Targeted Verification Commands & Results

- `scripts/dev/tc.sh server/modules/payments` — 0 diagnostics
- `scripts/dev/tc.sh server/modules/compliance` — 0 diagnostics
- `scripts/dev/test.sh server/modules/payments/payments.test.ts` — 6/6 passed (real MySQL + Express raw HTTP)
- `scripts/dev/test.sh server/modules/payments/providers/square.test.ts` — 4/4 passed (`files_engineer`)
- `scripts/dev/test.sh client/src/features/payments/payments.test.tsx` — passed (`files_engineer`)
- `scripts/dev/test.sh client/src/features/auth/legal.test.tsx` — passed (including `axe-core` accessibility verification)

## 3. Increment 04 Part B — Package U (`payments.refunds`) Verification

1. **RBAC, Step-Up, Confirmation Phrase & PAN Rejection**:
   - `payments.refunds.forOrder` enforces `staffProcedure` + `invoices.read_all`, re-validates order read scope (`NOT_FOUND` on restricted orders), and redacts decrypted `reason` (`null`) when the caller lacks `payments.refund`.
   - `payments.refunds.create` enforces `staffProcedure` + `payments.refund` + fresh step-up (`<= 10 min`), live-actor re-validation inside `tx`, exact `"REFUND ORDER"` server check, PAN-like digit-sequence rejection on `reason`, and `amountMinor <= refundableMinor` computed under `SELECT ... FOR UPDATE` across `compliance_invoices`, `compliance_invoice_payments`, and `payment_refunds`.
   - Cross-customer `getCheckoutStatus({ attemptPublicId })` and `cancelAttemptIfUnpaid({ attemptPublicId })` normalize to `NOT_FOUND:PAYMENT_ATTEMPT_NOT_FOUND`.
2. **Manual `"recorded_only"` vs Provider Refunds (`Stripe` & `Square`)**:
   - Manual payments book synchronously in `tx` (`executionKind = "recorded_only"`) with zero outbound calls, optional customer notice email (`compliance.refund_notice` inside `tx`), customer-safe `payment.refund.succeeded` audit attributes (`{ order_public_id, invoice_public_id, provider, execution_kind }`), and transactional `services.referrals.onInvoiceRefunded(event, { tx })` when an invoice becomes fully refunded.
   - Provider refunds commit `payment_refunds` (`status: "pending"`, `providerIdempotencyKey: "rp-refund-" + refundPublicId`) + enqueue `compliance.refund.reconcile` before calling `createRefund` over pinned egress outside `tx`.
   - `unknown` transport/5xx/409/429 outcomes never re-POST, hold `reservedPendingOrUnknownMinor`, block concurrent refunds on that payment (`CONFLICT:REFUND_OUTCOME_UNKNOWN_PENDING`), and settle exclusively via read-only `GET` reconciliation (`lookupRefund`, fenced by `context.assertStillOwned(tx)` before `FOR UPDATE`) or double-verified `refund.created` / `refund.updated` webhooks.
   - Stripe refund settlement (`createRefund`, direct `GET /v1/refunds/:id`, and list scan) unconditionally enforces exact portal metadata (`metadata.refund_public_id === refundPublicId`), non-empty matching `payment_intent` (`pi_...`) or `charge` (`ch_...`), exact `amount` + `currency`, and requested-vs-returned refund ID equality; webhook candidate lookup matches only by `refundPublicIdHint` or persisted `providerRefundRef` (never by payment fallback), preventing separate Stripe Dashboard refunds from settling portal refund rows.
   - Legacy `compliance.invoices.admin.recordRefund` enforces `payments.refund` (admin + step-up), server-checked `confirmationPhrase === "REFUND ORDER"`, PAN rejection, `CONFLICT:PROVIDER_PAYMENT_USE_ORDER_REFUNDS` on `provider_online` payments (audited via `invoice.refund.refused`), and `FOR UPDATE` locking on `compliance_invoice_payments` so provider reservations in `payment_refunds` can never be bypassed or overdrawn via the legacy invoice route.
3. **Part B Test Results**:
   - `scripts/dev/test.sh server/modules/payments/refunds.test.ts` — 8/8 passed (real MySQL)
   - `scripts/dev/test.sh server/modules/payments/payments.test.ts` — 6/6 passed (real MySQL)
   - `scripts/dev/tc.sh` — 0 diagnostics
   - `./node_modules/.bin/eslint` on owned `payments` paths — 0 errors, 0 warnings
   - **Not verified in this sandbox**: live external network calls to Stripe or Square production/sandbox endpoints; full Vite production bundle or live browser session (verified via jsdom + `axe-core` tests per build contract).

## 4. Increment 07 — Package M (`D9` Stripe Completion, `D12` Receipt Sync Port, `D5` Payment/Intake Triggers)

1. **D9 Server & Protocol Completion (`server/modules/payments/*`, `server/modules/compliance/*`)**:
   - Async bank-debit Checkout Sessions (`checkout.session.completed` with `payment_status = "unpaid"`) record `payment_webhook_events.status = "awaiting_settlement"` (`AWAITING_ASYNC_SETTLEMENT`), transition `orders.paymentState -> "pending_async"` via `orders.payments.onPaymentEventInTx`, and return `200 OK`; subsequent `checkout.session.async_payment_succeeded` books the invoice, advances the order (`INVOICE_PAID`), transitions the cart (`checked_out`), and issues immutable receipt `RPR-...`; `checkout.session.async_payment_failed` marks the attempt `failed` and reverts `orders.paymentState -> "unpaid"`.
   - `charge.refunded` queries `GET /v1/refunds?payment_intent=...` (or `charge=...`) over pinned egress (`listRefundsForPayment`), settles matching portal refunds, and flags unlinked external/Dashboard refunds (`status = "attention_required"`, `reasonCode = "UNLINKED_PROVIDER_REFUND"`, `payment.refund.flagged` audit, and `opsAlerts.emit` with hashed dedup key and zero raw provider IDs) without auto-booking.
   - Secondary Stripe webhook signing secret (`payments.stripe.webhook_secret_secondary`), staged credential save while `provider = "none"`, `payments.admin.readiness`, `payments.admin.testConnection` (`GET /v1/checkout/sessions?limit=1`), `payments.admin.sendSelfTestWebhook` (`SELF_TEST_OK`), and zero-secret `payment_webhook_rejections` diagnostics with 14-day retention pruning.
   - Backward-compatible `parsePaymentsConfigSetting` defaults verified for pre-Increment-07 stored settings shapes; router guard ordering verified (`UNAUTHORIZED` / `FORBIDDEN` before Zod input parsing).
2. **D12 Receipt PDF Sync Port & D5 Automation Triggers (`server/modules/compliance/*`)**:
   - `compliance.receipts.getFileSyncPdf({ receiptPublicId, orderPublicId }, tx)` verifies parent-order binding and renders deterministic `%PDF-` bytes for `managedFileSync`.
   - Registered `payment.succeeded`, `payment.failed`, `payment.refunded`, `intake.submitted`, and `intake.reviewed` automation triggers in `server/modules/compliance/automationTriggers.ts`.
3. **Admin & Customer Client Surfaces (designed and tested against WCAG 2.2 AA)**:
   - `/admin/payments/setup` (`PaymentSetupPage.tsx`), `/admin/payments` incomplete-setup banner (`PaymentsPage.tsx`), secondary signing secret input (`PaymentSettings.tsx`), and customer `/invoices` `"Pay online"` action + read-only return banner (`InvoicePages.tsx`).
4. **Increment 07 Verification Commands & Results**:
   - `scripts/dev/test.sh server/modules/payments/stripeCompletion.e2e.test.ts` — 4/4 passed (real MySQL + protocol-fake Stripe + Express raw HTTP)
   - `scripts/dev/test.sh server/modules/payments/refunds.test.ts` — 8/8 passed
   - `scripts/dev/test.sh server/modules/payments/payments.test.ts` — 7/7 passed
   - `scripts/dev/test.sh server/modules/payments/providers/square.test.ts` — 5/5 passed
   - `scripts/dev/test.sh server/modules/payments/providers/square-refund.test.ts` — 5/5 passed
   - `scripts/dev/test.sh client/src/features/payments/payments.test.tsx` — 12/12 passed (light + dark `axe-core`)
   - `scripts/dev/test.sh client/src/features/compliance/customer/complianceCustomer.test.tsx` — 16/16 passed
   - `scripts/dev/test.sh server/modules/compliance/receiptsAndSmallTotals.test.ts` — 6/6 passed
   - `scripts/dev/test.sh server/modules/compliance/compliance.test.ts` — 13/13 passed
   - `pnpm exec eslint` (`--max-warnings 0`) across all owned `compliance` and `payments` server/client files — 0 errors, 0 warnings
   - Full `scripts/dev/tc.sh` — verified

## 5. Increment 08 — Package D5 (`Payment Confirmation`, `Booking Source`, `Step-Up Stripe Repair` & `Missing-Webhook Diagnostics`)

1. **Server Confirmation, Strict Verification, Concurrency & Repair (`server/modules/payments/*`)**:
   - Single idempotent `FOR UPDATE` booking function (`bookAuthoritativeAttemptPaymentInTx`) fed by verified Stripe webhooks (`bookingSource = "webhook"`) OR authoritative provider lookups (`bookingSource = "provider_lookup"`) from customer `payments.confirmCheckoutPayment`, scheduled/manual `reconcilePendingAttempts`, and admin step-up `payments.admin.checkWithStripeNow`.
   - Strict checks enforced on every lookup before booking: explicit non-empty session `id === attempt.providerRef` (never falling back to input `providerRef`), explicit boolean `livemode` matching configured `mode` and attempt `environment`, `status === "complete"`, `payment_status === "paid"` (or `amountMinor === 0 && amount_total === 0 && payment_status === "no_payment_required"`), exact integer `amountMinor`, uppercase `currency`, exact `metadata.attempt_public_id` / `invoice_public_id` / `order_public_id`, non-contradictory `client_reference_id`, and post-egress key/mode drift check.
   - Async payment methods (`status === "complete"`, `payment_status === "unpaid"`, e.g. ACH/SEPA) return `state = "processing"`, record `reconciliationNote = "awaiting_async_settlement"`, advance `orders.paymentState -> "pending_async"`, and never book prematurely or mark failed.
   - Customer `payments.confirmCheckoutPayment` enforces `role === "customer"` (`FORBIDDEN:CUSTOMER_ONLY` for staff/admin), verifies order ownership before any Stripe call (`NOT_FOUND:PAYMENT_ATTEMPT_NOT_FOUND` indistinguishable from unknown ULID, zero egress), and enforces a per-attempt 3-second lookup cooldown (`last_customer_lookup_at`).
   - Both `webhook -> lookup` and `lookup -> webhook` sequences, as well as concurrent `confirmCheckoutPayment` races synchronized at the pinned fetch boundary, produce exactly 1 `compliance_invoice_payments` row and 1 `invoice.paid` domain event; late webhooks after `provider_lookup` stamp `verified_webhook_event_id`, preserve `booking_source = "provider_lookup"`, and record `status = "processed"` (`ALREADY_PAID`).
   - `reconcilePendingAttempts` books verified paid Stripe attempts directly instead of `awaiting_webhook` and emits deduplicated `STRIPE_WEBHOOK_DELIVERY_MISSING` alerts via `services.opsAlerts.emit` after the 10-minute grace window; `payments.admin.readiness` / `getSettings` surfaces `stripe.webhookDelivery` (`missingWebhookDetected`, `lastVerifiedWebhookAt`, 24h `recentRejectionReasons`, `endpointUrl`, `requiredEvents`, and the 3 `usualCauses`).
   - `payments.admin.checkWithStripeNow` (`payments.manage` + step-up MFA) repairs pre-upgrade payments across `redirected`, `expired`, `cancelled`, and `failed` attempts on an unpaid portal invoice (`payments.admin.stripe_checked`).
2. **Client Surfaces (`client/src/features/payments/*`, designed and tested against WCAG 2.2 AA)**:
   - `PaymentReturnConfirmation.tsx`: immediate `confirmCheckoutPayment` on `/checkout/return?attempt=...`, exponential back-off auto-rechecks (`2.5s, 5s, 10s, 20s, 30s`), manual `"Check payment status"` button, honest async-settlement guidance without false failure messaging, and `"Continue to your order"` + `"View receipt"`.
   - `AdminCheckStripePaymentButton.tsx`: admin-only step-up `"Check with Stripe now"` action on issued portal invoices (`/admin/invoices/:invoiceId` and `/admin/payments` attempt drawer).
   - `PaymentSetupPage.tsx`: missing-webhook warning callout (`data-testid="stripe-missing-webhook-banner"`) and diagnostic card (`data-testid="stripe-webhook-diagnostics"`) showing last verified webhook, 24h rejection reasons, canonical endpoint URL, 9 required events, and the 3 usual causes.
3. **Increment 08 Targeted Verification Commands & Results**:
   - `NO_COLOR=1 flock /tmp/rp-light.lock pnpm exec vitest run server/modules/payments/paymentConfirmationD5.test.ts` — passed (real MySQL + protocol-fake pinned fetch)
   - `NO_COLOR=1 flock /tmp/rp-light.lock pnpm exec vitest run server/modules/payments/payments.test.ts` — 11/11 passed
   - `NO_COLOR=1 flock /tmp/rp-light.lock pnpm exec vitest run client/src/features/payments/PaymentReturnConfirmation.test.tsx` — passed (light + dark `axe-core` + 240px container)
   - `NO_COLOR=1 flock /tmp/rp-light.lock pnpm exec vitest run client/src/features/payments/payments.test.tsx` — 22/22 passed
   - `NO_COLOR=1 flock /tmp/rp-light.lock pnpm exec vitest run server/modules/integrations/production/payload.test.ts` — passed (including max-length 161-UTF-16-unit D1 composed name test)
   - `flock /tmp/rp-light.lock pnpm exec eslint server/modules/payments client/src/features/payments server/modules/integrations/production/payload.test.ts --max-warnings 0` — 0 errors, 0 warnings
   - `scripts/dev/tc.sh` — 0 diagnostics
   - **Not verified in this sandbox**: live external Stripe network traffic (exercised via protocol-level fake pinned fetch); full production Vite build or live browser session (verified via jsdom + `axe-core` per Increment 08 working rules).


