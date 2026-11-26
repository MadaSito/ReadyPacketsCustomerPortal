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
4. **Create a Stripe API secret or restricted key** (`sk_test_...` / `rk_test_...` for `test`; `sk_live_...` / `rk_live_...` for `live`) from **Stripe Dashboard > Developers > API keys** (**Publishable keys `pk_...` are not used** by ReadyPackets):
   - If using a **Restricted key (`rk_live_...` / `rk_test_...`)**, grant at least:
     - **Checkout Sessions**: **Write** (includes Read — required to create customer Checkout Sessions and run the setup probe; a Read-only key passes `GET /v1/checkout/sessions?limit=1` yet fails `POST /v1/checkout/sessions` with `HTTP 403 STRIPE_KEY_MISSING_PERMISSION`)
     - **Payment Intents**: **Read** (required for server-to-server double verification)
     - **Charges**: **Read** (grant **Write** as well if staff issue refunds from ReadyPackets)
   - **Hosted Checkout domain requirement:** ReadyPackets redirects customers exclusively to `https://checkout.stripe.com`. Custom Stripe Checkout domains on merchant subdomains are rejected (`STRIPE_UNTRUSTED_REDIRECT_URL`) to preserve strict redirect allowlisting.
5. **Register webhook endpoint** `https://<canonical-host>/api/payments/webhooks/stripe` in **Stripe Dashboard > Developers > Webhooks** (or **Workbench > Webhooks**) subscribed to all **9 required events**:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `payment_intent.payment_failed`
   - `charge.refunded`
   - `refund.created`
   - `refund.updated`
   - `charge.refund.updated`
   Open the created endpoint and click **Signing secret > Reveal** to copy the `whsec_...` value (do **not** copy the `we_...` endpoint ID).
6. **Stage credentials without switching live traffic:** Save the API secret key and **Primary Stripe webhook signing secret** (`whsec_...`) while keeping `provider = "none"`. Paste normalization strips accidental surrounding quotes/backticks, non-breaking spaces, zero-width characters, and wrapped line breaks automatically; invalid shapes (such as `pk_...`, `we_...`, masked values, or wrong-mode keys) are rejected per field without echoing secret content. Leave **Secondary Stripe webhook signing secret** empty during initial setup — to replace your saved signing secret, paste the new `whsec_...` into **Primary**. Secrets are write-only, encrypted at rest with AES-256-GCM (`exportable: false`), and displayed afterward only as masked `last4` indicators.
7. **Run required live diagnostics (step-up MFA required):**
   - Select **Test Stripe API** (`payments.admin.testConnection`) to verify outbound pinned egress and key environment alignment via `GET https://api.stripe.com/v1/checkout/sessions?limit=1`.
   - Select **Verify Checkout session creation** (`payments.admin.verifyCheckoutSession`) to create an unpaid probe Checkout Session (`POST /v1/checkout/sessions`) over pinned egress and immediately expire it (`POST /v1/checkout/sessions/{id}/expire`) at zero cost. This catches read-only restricted keys (`HTTP 403 STRIPE_KEY_MISSING_PERMISSION`) and custom Checkout domains (`STRIPE_UNTRUSTED_REDIRECT_URL`) before customers attempt to pay.
   - Select **Send self-test webhook** (`payments.admin.sendSelfTestWebhook`) to verify HMAC signing secret configuration against ReadyPackets' inbound webhook verifier without booking ledger state. **Note:** The self-test proves ReadyPackets' local verification pipeline using the Primary secret stored in the portal; confirm real Stripe delivery by clicking **Send test event** in Stripe Workbench (or completing a test/live payment) to verify Stripe has the matching endpoint URL and signing secret.
   - Rotating the API secret key, rotating the Primary webhook signing secret, changing `mode`, or changing the `stripe` outbound allowlist preset automatically marks verification stale and pauses online card redirect (`onlineEnabled = false`) until the corresponding verification step is re-run.
8. **Activate Stripe Checkout (or switch back to Pay by invoice):** The top banner on `/admin/payments/setup` states plainly whether online card checkout is **ACTIVE** or **NOT ACTIVE**, what customers experience right now, and which readiness gate is missing. Once all gates report ready, select **Activate Stripe Checkout** and confirm customer impact (in `live` mode, type `ACTIVATE LIVE PAYMENTS` to confirm). New activations (switching `provider` to `"stripe"` or switching `mode` while `provider = "stripe"`) are refused with `STRIPE_EGRESS_NOT_ALLOWLISTED`, `STRIPE_API_NOT_VERIFIED`, `STRIPE_CHECKOUT_SESSION_NOT_VERIFIED`, or `STRIPE_WEBHOOK_NOT_VERIFIED` if any prerequisite — including a passing **Verify Checkout session creation** probe for the current API fingerprint and mode — is missing, stale, or failing. An already-activated Stripe setup upgraded from an earlier version (or after in-place key rotation once **Test Stripe API** and **Send self-test webhook** pass) stays **ACTIVE** (`onlineEnabled = true`) even with no probe on record; the banner and checklist mark **Verify Checkout session creation** as a recommended check unless a probe for the current key/mode explicitly failed. To switch back to invoice-only checkout at any time, select **Switch to Pay by invoice** on `/admin/payments/setup` (single confirmation) or choose **Pay by invoice** under `/admin/payments` -> **Configuration** -> **Save payment settings**.
9. **Zero-downtime signing secret rotation:** During Stripe webhook secret rotation while Stripe temporarily signs events with both old and new secrets, paste the incoming `whsec_...` into **Secondary Stripe webhook signing secret (optional rollover)** and save. Inbound webhooks accept signatures valid under either Primary or Secondary until you paste the new secret into **Primary**, re-run **Send self-test webhook**, and retire Secondary.
10. **Checkout session failure alerts & recovery:** If creating a customer Checkout Session ever fails after an order/invoice commits (for example, revoked key, missing restricted-key permission, disabled allowlist, or upstream Stripe 5xx), ReadyPackets marks the `payment_attempts` row `failed` with a specific reason code, emits `payments.attempt.failed` with sanitized upstream status/code diagnostics (never raw provider prose or keys), surfaces **Last checkout-session failure** on `/admin/payments/setup`, and posts an operational alert in `/admin/alerts` (`"Customers cannot reach Stripe Checkout"`). The customer's order and issued invoice remain intact so the buyer can select **Pay now** once online checkout is healthy.
11. **Local Stripe CLI forwarding (development / staging):** `/admin/payments/setup` provides copyable `stripe listen --forward-to` and `stripe trigger` commands pre-populated with the 9 required events.

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
- **Unlinked provider refunds, unmatched portal sessions & diagnostics:** On `charge.refunded`, the portal queries `GET /v1/refunds` over pinned egress. Refunds created outside the portal (missing `metadata.refund_public_id`) are never auto-booked into invoice ledgers; they record `UNLINKED_PROVIDER_REFUND` and emit a warning operational alert in `/admin/operations` for manual staff review. Similarly, signed payment webhooks carrying ReadyPackets metadata (`attempt_public_id`, `invoice_public_id`, or `order_public_id`) that cannot be matched to a portal attempt or invoice record `status = "attention_required"` (`UNMATCHED_PORTAL_PAYMENT`) and emit a warning operational alert, whereas webhooks without portal metadata (from external apps sharing the Stripe account) are ignored quietly (`200 IGNORED`). Rejected webhook deliveries record human-labeled reasons, secondary raw codes, and clock skew in `/admin/payments/setup` without storing raw request bodies, headers, IP addresses, or secrets; non-JSON media types (`HTTP 400`) and payloads over `256 KiB` (`HTTP 413`) are refused at the HTTP transport layer before webhook verification and do not appear in the rejection table. All administrative and customer payment views are designed and tested against WCAG 2.2 AA.
