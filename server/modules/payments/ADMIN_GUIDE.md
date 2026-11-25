# Hosted Online Payments — Operator Guide (`/admin/payments`)

ReadyPackets ships with online payment providers **off by default** (`provider = "none"` — **Pay by invoice**). No payment SDKs are bundled on the server or in the browser, card/bank details never enter portal infrastructure (PCI SAQ-A posture), and outbound HTTPS calls occur only through the pinned egress layer (`server/modules/integrations/egress.ts`) after an administrator explicitly enables a provider and allowlists its host preset.

## 1. Prerequisites before enabling a provider

1. **Outbound egress preset (`/admin/integrations`):**
   - For **Stripe Checkout** (`test` or `live`): enable the `stripe` preset (`api.stripe.com`, purpose `stripe`).
   - For **Square Payment Links (`test` / Sandbox)**: enable the `square_sandbox` preset (`connect.squareupsandbox.com`, purpose `square`).
   - For **Square Payment Links (`live` / Production)**: enable the `square` preset (`connect.squareup.com`, purpose `square`).
2. **Step-up authentication:** Updating payment configuration, rotating secrets, or triggering manual reconciliation requires an active `admin` session with a fresh step-up verification (`payments.manage`).
3. **Canonical public HTTPS origin (`CANONICAL_ORIGIN`):** Hosted provider return URLs and webhook signature verification depend on the portal's canonical HTTPS origin:
   - Stripe webhook endpoint: `https://<canonical-host>/api/payments/webhooks/stripe`
   - Square webhook endpoint: `https://<canonical-host>/api/payments/webhooks/square`

## 2. Sandbox / Test mode caveat (staging vs. production)

> **Important:** Use `mode = "test"` (Stripe test keys or Square Sandbox credentials) **only on a dedicated staging instance or against designated test invoices**. When `mode = "test"` is active on an instance, a test-card charge completed in that sandbox provider still satisfies double verification for that configured `test` mode and marks the corresponding portal invoice `paid` (emitting `environment: "test"` on the audit trail). Switching between `test` and `live` or changing the active provider requires entering a fresh credential pair so test and live credentials are never mixed.

## 3. Guided Stripe Checkout setup (`/admin/payments/setup`)

Administrators can stage and verify Stripe credentials while keeping **Pay by invoice** (`provider = "none"`) active until every prerequisite is green:

1. Open `/admin/payments/setup` (or follow the setup checklist banner on `/admin/payments`).
2. **Allowlist Stripe outbound egress:** Use the inline toggle on `/admin/payments/setup` (or `/admin/integrations`) to enable the `stripe` egress preset (`api.stripe.com`, port `443`, purpose `stripe`).
3. **Inbound country allow-list exemption:** Signed deliveries to `/api/payments/webhooks/stripe` are exempt from geo/country filtering while retaining rate limiting, the `256 KiB` raw-body cap, and HMAC-SHA256 verification.
4. **Create a restricted Stripe secret key** (`sk_test_...` / `rk_test_...` for `test`; `sk_live_...` / `rk_live_...` for `live`) with Checkout Sessions read/write, PaymentIntents read, and Refunds read/write permissions.
5. **Register webhook endpoint** `https://<canonical-host>/api/payments/webhooks/stripe` subscribed to all **9 required events**:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `payment_intent.payment_failed`
   - `charge.refunded`
   - `refund.created`
   - `refund.updated`
   - `charge.refund.updated`
6. **Stage credentials without switching live traffic:** Save the API secret key and primary signing secret (`whsec_...`) while keeping `provider = "none"`. Secrets are write-only, encrypted at rest with AES-256-GCM (`exportable: false`), and displayed afterward only as masked `last4` indicators.
7. **Run live diagnostics (step-up MFA required):**
   - Select **Test Stripe API** (`payments.admin.testConnection`) to verify outbound pinned egress and key validity via `GET https://api.stripe.com/v1/checkout/sessions?limit=1`.
   - Select **Send self-test webhook** (`payments.admin.sendSelfTestWebhook`) to verify HMAC signing secret configuration against the inbound webhook verifier without booking ledger state.
8. **Activate Stripe Checkout:** Once all checklist items report ready, switch active provider to `stripe` on `/admin/payments` and save.
9. **Zero-downtime signing secret rotation:** During Stripe webhook secret rotation, paste the new `whsec_...` into **Secondary webhook signing secret** and save. Inbound webhooks accept signatures valid under either the primary or secondary secret until you promote the new secret to primary and clear the secondary slot.
10. **Local Stripe CLI forwarding (development / staging):** `/admin/payments/setup` provides copyable `stripe listen --forward-to` and `stripe trigger` commands pre-populated with the 9 required events.

## 4. Configuring Square Payment Links

1. In the Square Developer Console, select Sandbox (`test`) or Production (`live`), copy the target **Location ID** and **Access Token**.
2. Register webhook notification URL `https://<canonical-host>/api/payments/webhooks/square` subscribed to `payment.created` and `payment.updated`, and copy the **Signature Key**.
3. Ensure your reverse proxy forwards the `x-square-hmacsha256-signature` and `square-environment` headers unmodified alongside the exact raw request body (`<= 256 KiB`).
4. In `/admin/payments`, select **Square Payment Links**, choose matching environment, enter the Location ID, Access Token, and Webhook Signature Key, and save.

## 5. Double-verification & reconciliation model

- **Browser return URLs are untrusted navigation hints:** `GET /api/payments/return/:provider/:attemptPublicId` performs zero database mutations and redirects (`303 See Other`) only to fixed internal portal routes (`/checkout/return`, `/checkout/cancel`, or `/invoices`).
- **Dual proof before booking:** An invoice is marked `paid` only when **both**:
  1. A cryptographically verified, replay-bounded (`<= 300 s`), SHA-256-deduplicated webhook event is persisted in `payment_webhook_events`, **and**
  2. An authoritative server-to-server `GET` over `egress.fetchPinned` confirms paid status, exact minor-unit balance, ISO-4217 currency, environment (`test` vs. `live`), and `attemptPublicId` / `invoicePublicId` bindings.
- **Reconciliation (`payments.reconcile_pending` & Reconcile now):** Scheduled reconciliation (`every 5 minutes`) and manual **Reconcile now** recover attempts where a verified webhook arrived during a transient upstream outage (`retry_pending`), expire abandoned sessions, and prune `payment_webhook_rejections` rows older than 14 days. If a provider reports paid before a verified webhook has been received, the attempt records `reconciliationNote = "awaiting_webhook"` and leaves the invoice unpaid until the signed webhook arrives or an administrator records an offline payment on the invoice.
- **Asynchronous bank-debit settlement (ACH / SEPA / bank transfer):** When `checkout.session.completed` arrives with `payment_status = "unpaid"` while funds clear, the portal records `status = "awaiting_settlement"` (`AWAITING_ASYNC_SETTLEMENT`), marks the order `paymentState = "pending_async"`, and returns `200 OK` so Stripe does not retry prematurely. Final settlement books when `checkout.session.async_payment_succeeded` arrives; `checkout.session.async_payment_failed` marks the attempt `failed` and returns the order `paymentState` to `"unpaid"`.
- **Unlinked provider refunds & diagnostics:** On `charge.refunded`, the portal queries `GET /v1/refunds` over pinned egress. Refunds created outside the portal (missing `metadata.refund_public_id`) are never auto-booked into invoice ledgers; they record `UNLINKED_PROVIDER_REFUND` and emit a warning operational alert in `/admin/operations` for manual staff review. Rejected webhook deliveries record safe reason codes and clock skew in `/admin/payments/setup` without storing raw request bodies, headers, IP addresses, or secrets. All administrative and customer payment views are designed and tested against WCAG 2.2 AA.
