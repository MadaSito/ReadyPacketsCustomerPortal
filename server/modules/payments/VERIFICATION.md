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
