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

## 3. Configuring Stripe Checkout

1. Create a restricted Stripe secret key (`sk_test_...` / `rk_test_...` for `test`; `sk_live_...` / `rk_live_...` for `live`) with Checkout Sessions read/write and PaymentIntents read permissions.
2. Register webhook endpoint `https://<canonical-host>/api/payments/webhooks/stripe` for events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
3. Copy the endpoint signing secret (`whsec_...`).
4. In `/admin/payments`, select **Stripe Checkout**, choose matching environment (`test` or `live`), enter both secrets, and save. Secrets are write-only, encrypted at rest with AES-256-GCM (`exportable: false`), and displayed afterward only as masked `last4` indicators.

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
- **Reconciliation (`payments.reconcile_pending` & Reconcile now):** Scheduled reconciliation (`every 5 minutes`) and manual **Reconcile now** recover attempts where a verified webhook arrived during a transient upstream outage (`retry_pending`), and expire abandoned sessions. If a provider reports paid before a verified webhook has been received, the attempt records `reconciliationNote = "awaiting_webhook"` and leaves the invoice unpaid until the signed webhook arrives or an administrator records an offline payment on the invoice.
