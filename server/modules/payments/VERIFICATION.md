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
3. **Decision 12 double verification & replay defense:**
   - Raw webhook router (`POST /api/payments/webhooks/:provider`) enforces `<= 256 KiB` raw `Buffer`, verifies Stripe HMAC-SHA256 (`t=...,v1=...`) or Square HMAC-SHA256 (`notificationUrl + rawBody` + `square-environment` consistency check against configured `mode`), enforces `<= 300 s` replay window, and deduplicates `(provider, external_event_id)` with SHA-256 payload-tamper detection (`409 PAYLOAD_TAMPER_CONFLICT`).
   - `finalizeVerifiedPaidAttemptInTx` acquires `FOR UPDATE` row locks on both `payment_attempts` and `payment_webhook_events`, verifies persisted `verifiedWebhookEventId`, `attemptId`, `provider`, `environment`, `providerPaymentRef`, and unconditionally checks `fetched.attemptPublicId` and `fetched.invoicePublicId` before calling `compliance.invoices.bookVerifiedProviderPayment(..., { tx })`.
   - `reconcilePendingAttempts` never marks an invoice paid without a verified webhook receipt (`reconciliationNote = "awaiting_webhook"`).
   - `GET /api/payments/return/:provider/:attemptPublicId` performs zero database reads/writes and issues `303 See Other` (`Cache-Control: no-store`) only to fixed internal paths (`/checkout/return`, `/checkout/cancel`, `/invoices`).
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
3. **Part B Test Results**:
   - `scripts/dev/test.sh server/modules/payments/refunds.test.ts` — 6/6 passed (real MySQL)
   - `scripts/dev/test.sh server/modules/payments/payments.test.ts` — 6/6 passed (real MySQL)
   - `scripts/dev/tc.sh` — 0 diagnostics
   - `./node_modules/.bin/eslint` on owned `payments` paths — 0 errors, 0 warnings
   - **Not verified in this sandbox**: live external network calls to Stripe or Square production/sandbox endpoints; full Vite production bundle or live browser session (verified via jsdom + `axe-core` tests per build contract).
