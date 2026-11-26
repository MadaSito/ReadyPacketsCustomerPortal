# ReadyPackets go-live worksheet

This is an **unexecuted plan** for your server, not a record of a passed release. Use the actual portal and Stripe endpoint for delivery proof; use an isolated copy for backup restoration, fault simulations and upgrade rehearsals. Do not disable live webhooks to test recovery.

## Before you start

- **People and equipment:** Two synthetic customer accounts, one staff account, two separate admin accounts, an approved test mailbox, an enrolled authenticator, a laptop and phone, and a screen reader available on one device. Use separate browser profiles for roles. Ask your server operator to help with receipts, DNS/TLS, headers, jobs, backup and restore evidence.
- **Test data:** Use Zeus Greene (preferred name `Z`) and a second synthetic customer. Use `Ice Queen`, synthetic packet numbers 1, 2 and 4, a harmless sample PDF, and a short recording with no personal content. The reference example assumes the synthetic customer key ends in `JJG5`; if the server assigns another key, substitute its final four characters.
- **Payments:** Have Stripe test-mode API credentials and the endpoint’s own signing secret available securely. Use the [Stripe-documented test card](https://docs.stripe.com/testing#cards) `4242 4242 4242 4242` in test mode only, any future expiry and any three-digit CVC. Keep live Stripe credentials separate. A live charge and refund require written owner approval and an authorized operator-controlled payment method; do not use test cards in live mode.
- **Time:** Set aside about 30–60 minutes for smoke checks and 1–2 working days for the full worksheet and operator drills. Provider delivery, settlement and the missing-webhook grace period may add waiting time. These are planning allowances, not measured runtimes.
- **Run record:** Candidate SHA/tag: ____ | Environment alias: ____ | Run ID: ____ | UTC window: ____ | Owner: ____
- **Evidence:** Mark exactly one of Pass or Fail after observing the expected result. Leave both unchecked if unrun or blocked and record `Blocked: <why>` in Evidence. For out-of-scope features record `Excluded: <owner decision/evidence ID>` and verify they are disabled. Use access-controlled, redacted evidence IDs; never paste credentials, sign-in/verification codes, card data, personal details, private endpoints or signed URLs. Record tester role/alias and UTC date in each row.

Paths beginning with `/` go after your portal hostname. `:id` means open the synthetic record by clicking it, not by typing that literal text. An **Operator** row has no portal button; use the linked runbook and request the stated output.

## Smoke test after every upgrade

Run these 15 checks, marking the results in the main worksheet below. For Stripe, run the checks against the actual mode in scope; retain separate test and live evidence on first launch or after payment configuration changes. If cards are not offered, record that exclusion and check the invoice-only path.

| # | Worksheet row | Quick check |
| --- | --- | --- |
| 1 | SRV-01 | Web process responds. |
| 2 | SRV-02 | Portal is ready. |
| 3 | SRV-03 | Certificate is trusted. |
| 4 | SRV-05 | Worker finishes a job. |
| 5 | ACC-01 | Local admin sign-in reaches MFA. |
| 6 | ACC-02 | MFA opens the portal. |
| 7 | REG-01 | Registration has the three name fields. |
| 8 | CAT-02 | A selected tier expands. |
| 9 | ORD-04 | Historical order opens by its existing reference. |
| 10 | BIL-05 | Checkout offers saved billing. |
| 11 | PAY-08 or PAY-28 | Stripe Checkout event delivery is 2xx. |
| 12 | PAY-09 or PAY-29 | Return says Payment received. |
| 13 | PAY-10 or PAY-30 | Matching invoice is Paid. |
| 14 | WIZ-01 | Purchased order opens the wizard. |
| 15 | AUD-01 | Audit Center records the synthetic action. |

## Server and TLS

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| SRV-01 | Blocker | Open `/healthz` in the browser. | HTTP 200. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| SRV-02 | Blocker | Open `/readyz` on the public HTTPS portal. | HTTP 200. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| SRV-03 | Blocker | Open the portal on HTTPS. Inspect the site certificate. | Canonical host matches the trusted, unexpired certificate. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| SRV-04 | Blocker | Enter the portal address with `http://`. | Redirects to the canonical HTTPS site. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| SRV-05 | Blocker | Generate a synthetic verification email; ask the operator to inspect its background job. | Worker records completion. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| SRV-06 | Important | Operator: follow [Install checks](INSTALL.md#go-live-checklist) for certificate renewal. | Renewal dry run succeeds. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| SRV-07 | Blocker | Operator: check internet-facing listeners against the [install guide](INSTALL.md). | DB and application listeners are not directly reachable. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| SRV-08 | Blocker | Operator: inspect the edge TLS profile. | TLS 1.2 and 1.3 allowed; older versions rejected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Accounts and MFA

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| ACC-01 | Blocker | `/sign-in` → **Sign in** with synthetic admin password. | Second-factor screen opens; console not yet accessible. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ACC-02 | Blocker | On the MFA screen enter the current **6-digit code** → **Verify**. | Admin console opens. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ACC-03 | Blocker | Start a new sign-in and enter a known incorrect second factor. | Console stays locked. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ACC-04 | Blocker | Sign in with one unused **Recovery code**. Repeat ACC-01 and reuse it → **Verify**. | Used code is refused. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ACC-05 | Important | `/admin/staff` → locate the backup administrator. Sign in separately as that admin. | Second admin can reach the console with their own MFA. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ACC-06 | Blocker | Trigger fresh MFA on an approved test admin change, then dismiss the dialog. | Setting does not change. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ACC-07 | Optional-if-enabled | `/sign-in` → use the configured SSO provider displayed for your organization. | Synthetic user signs in with expected mapped identity. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Registration and names

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| REG-01 | Blocker | Open `/register`. | First name, Last name, and Preferred name inputs appear. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| REG-02 | Blocker | `/register` → leave First name blank; fill other required fields → **Create account**. | First name is flagged; no account created. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| REG-03 | Blocker | `/register` → leave Last name blank; fill other required fields → **Create account**. | Last name is flagged; no account created. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| REG-04 | Important | `/register` → try 81 `A` characters in each name input. | No name longer than 80 is accepted. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| REG-05 | Blocker | `/register` → `Zeus`, `Greene`, `Z` → **Create account**; verify and sign in. | Customer greeting uses `Z`. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| REG-06 | Important | Register the second synthetic customer with Preferred name empty; verify and sign in. | Greeting falls back to First name. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| REG-07 | Important | `/account` → open a synthetic pre-upgrade profile and save its displayed name parts. | Derived parts persist after reload. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Catalogue and ordering

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| CAT-01 | Blocker | `/orders/new` → compare one approved packet and tier price against the launch price sheet. | Correct tier price for the launch currency. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| CAT-02 | Blocker | `/orders/new` → select a different tier for packet 1. | Its outcome/deliverables expand; the previous tier collapses. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| CAT-03 | Important | `/orders/new` → click **[tier]: outcome and deliverables** twice. | Details can be closed and reopened manually. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| CAT-04 | Important | `/orders/new` → choose **Not included** for packet 1. | No tier details stay expanded for that packet. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| CAT-05 | Blocker | Add a qualifying bundle in `/orders/new` and compare `/cart` and `/cart/checkout`. | The same approved bundle total appears in both. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Order numbers

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| ORD-01 | Blocker | Place the first `Ice Queen` order on an unused stem; open it from `/orders`. | Default reference `RP-JJG5-ZEUGRE-ICEQUE-001` with matching fixture key. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ORD-02 | Important | Order a project named `Élan` using synthetic name `Li Á`. | Reference name/project parts are `LIXAXX` and `ELANXX`. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ORD-03 | Blocker | Use two authorized sessions to create orders on the same synthetic stem with distinct permitted contents. | The two references have different sequence numbers. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ORD-04 | Blocker | `/orders` → open a synthetic historical order. | Its original `RP-YYYY-NNNNNN` reference is unchanged. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ORD-05 | Important | `/admin/search` → search for the new-format reference. | Search finds the matching synthetic order. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ORD-06 | Important | Review the [administrator order-number privacy guidance](../guides/ADMIN_GUIDE.md#order-numbers-increment-08) against your notice and authorized destinations. | The notice explains that references reveal name and project fragments. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Add-on orders

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| ADD-01 | Blocker | Open the first `Ice Queen` order → **Add packets to this project**. | `/orders/new?addTo=…` shows the fixed project name. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ADD-02 | Blocker | In that picker try choosing a different tier of packet 1. | **Already in this project**; packet 1 cannot be selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ADD-03 | Important | Select packets 2 and 4; go from `/cart` to `/cart/checkout`. | Summary identifies `Ice Queen` and the root reference. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ADD-04 | Blocker | Finish the addition; open it from `/orders`. | A distinct reference shares the root stem and uses the next unused suffix. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ADD-05 | Blocker | Compare the root and addition invoice links. | The addition has its own invoice. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ADD-06 | Blocker | In customer B’s session, open customer A’s synthetic add-on URL. | No project details exposed and no addition can be placed. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ADD-07 | Important | `/admin/orders` → open the synthetic root → open its related addition. | Console link opens the correct related order. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Billing

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| BIL-01 | Blocker | `/register` → leave the optional billing section collapsed → **Create account**. | Valid registration succeeds without a billing profile. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| BIL-02 | Blocker | `/register` → enter only part of an approved synthetic billing address → **Create account**. | Missing billing fields are identified and submission is blocked. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| BIL-03 | Important | `/register` → use an existing synthetic mailbox and different billing values. | Existing account’s billing profile is unchanged. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| BIL-04 | Blocker | `/account/billing` → **Billing name** `Zeus Greene`; **Billing email** = test mailbox.<br>**Address line 1** `100 Test Street`; **City or locality** `Testville`; **Postal code** `12345`; **Country code** `US`.<br>Click **Save billing information**; reload. | **Saved billing summary** shows the new address. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| BIL-05 | Blocker | Sign in as a customer with saved billing and open `/cart/checkout`. | Saved billing choice is selected by default and shows its summary. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| BIL-06 | Blocker | `/cart/checkout` → choose different billing details; leave save unchecked and finish checkout. | Invoice uses the new details without replacing the profile. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| BIL-07 | Important | As a customer without saved billing, open `/cart/checkout` and inspect the save checkbox. | Save is initially checked; customer can uncheck it. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| BIL-08 | Important | `/account/billing` → **Clear billing information**.<br>In **Clear saved billing information?**, click **Clear billing information**. | **No saved billing information**. This clears billing only. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Stripe test mode and live mode

Start with **test mode** in isolation. The portal’s **Send self-test webhook** does not prove that Stripe can reach your endpoint. In Stripe Dashboard/Workbench, open the endpoint in the correct mode and inspect **Event deliveries** for the actual payment and refund. Record mode, event type, redacted event reference, time, and HTTP status. Keep **live mode** out of scope only by explicit owner decision with card checkout disabled. If live cards are in scope all live Blockers apply.

### Stripe test mode

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| PAY-01 | Blocker | `/admin/payments/setup` → **Webhook endpoint & required events**; compare URL with Stripe test endpoint. | Exact portal HTTPS endpoint, in Stripe test mode. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-02 | Blocker | Stripe test endpoint → verify the endpoint’s **Signing secret** was entered in portal **Primary Stripe webhook signing secret**. | Secret belongs to this precise endpoint in test mode. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-03 | Blocker | `/admin/payments/setup` → **Test Stripe API** with the test credential. | API readiness check passes. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-04 | Blocker | `/admin/payments/setup` → **Verify Checkout session creation**. | Session verification passes for the current test key. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-05 | Blocker | `/admin/payments/setup` → **Send self-test webhook**. | Portal local signature check passes. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-06 | Blocker | `/admin/payments/setup` → **Activate Stripe Checkout** in test mode. | Portal marks card checkout active in test mode. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-07 | Blocker | `/cart/checkout` → **Place order and continue to payment**.<br>On Stripe, pay with the documented test card. | Stripe completes the test Checkout session. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-08 | Blocker | Stripe Dashboard test endpoint → **Event deliveries** → open the actual Checkout event. | Delivery to this endpoint is HTTP **2xx**. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-09 | Blocker | Follow Stripe’s return to `/checkout/return`. | **Payment received**. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-10 | Blocker | `/invoices` → open the invoice for that order. | Invoice status is **Paid**. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-11 | Blocker | `/checkout/return` → open the receipt offered after confirmation. | A receipt for that order and amount is available. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-12 | Blocker | `/checkout/return` → follow the link to the matching order. | The wizard opens with the payment gate cleared. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-13 | Blocker | Operator, isolated test mode only: disable the Stripe endpoint; pay a fresh order and return. | Lookup books the matching payment without a webhook. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-14 | Blocker | Keep PAY-13 isolated until the grace period elapses; open `/admin/alerts`. | One **Stripe is not delivering webhooks to this server** alert. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-15 | Blocker | Pay a separate test order without returning; admin opens its invoice/attempt → **Check with Stripe now** → fresh MFA. | Previously pending matching payment is booked. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-16 | Blocker | Re-enable delivery and resend PAY-13’s verified provider event from Stripe. | One payment remains; no second booking. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-17 | Important | If offered, complete a test asynchronous Checkout whose final payment is still unpaid. | Return shows processing; invoice remains unpaid. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-18 | Blocker | `/admin/orders/:id/refund` → **Prepare refund**.<br>Enter approved amount and **Refund reason** `Go-live test`.<br>Type `REFUND ORDER` → **Send refund** → fresh MFA. | **Refund history** records one matching test refund. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-19 | Blocker | Stripe test endpoint → **Event deliveries** → open the event for that refund. | Test refund delivery is HTTP **2xx**. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

### Stripe live mode

Do not reuse a test endpoint secret or intentionally interrupt live delivery. Run the live payment only with explicit approval for the small real charge and refund, and with general customer access still controlled.

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| PAY-21 | Blocker | `/admin/payments/setup` → **Webhook endpoint & required events**; compare URL with Stripe’s live endpoint. | Exact portal HTTPS endpoint, in Stripe live mode. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-22 | Blocker | Stripe live endpoint → verify its **Signing secret** was entered in portal **Primary Stripe webhook signing secret**. | Secret belongs to this exact live endpoint. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-23 | Blocker | `/admin/payments/setup` → **Test Stripe API** with live credential. | Live API readiness check passes. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-24 | Blocker | `/admin/payments/setup` → **Verify Checkout session creation**. | Session verification passes for the live key. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-25 | Blocker | `/admin/payments/setup` → **Send self-test webhook**. | Portal local signature check passes for live configuration. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-26 | Blocker | `/admin/payments/setup` → **Activate Stripe Checkout**; type `ACTIVATE LIVE PAYMENTS` → **Activate live Stripe Checkout**. | Portal marks card checkout active in live mode. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-27 | Blocker | With approval, pay the synthetic order’s small supported amount on Stripe with an authorized live method. | Stripe records a real live payment for the approved amount. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-28 | Blocker | Stripe Dashboard live endpoint → **Event deliveries** → open the actual Checkout event. | Delivery to this endpoint is HTTP **2xx** in live mode. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-29 | Blocker | Follow Stripe’s return to `/checkout/return`. | **Payment received**. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-30 | Blocker | `/invoices` → open the matching live order invoice. | Invoice status is **Paid**. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-31 | Blocker | `/checkout/return` → open the receipt offered after live confirmation. | A receipt for that order and amount is available. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-32 | Blocker | `/checkout/return` → follow the link to the matching order. | The wizard opens with the payment gate cleared. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-33 | Blocker | `/admin/orders/:id/refund` → **Prepare refund**.<br>Enter approved amount and **Refund reason** `Go-live verification`.<br>Type `REFUND ORDER` → **Send refund** → fresh MFA. | **Refund history** records one matching live refund. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-34 | Blocker | Stripe live endpoint → **Event deliveries** → open the event for that refund. | Live refund delivery is HTTP **2xx**. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-35 | Blocker | Open the refund in Stripe after processing finishes. | Live refund status and amount match the portal. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PAY-36 | Optional-if-enabled | If Square is the chosen provider, follow [its setup guide](../../server/modules/payments/providers/SQUARE.md) and make a synthetic payment in its sandbox. | Matching invoice is Paid on verified provider confirmation. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

### Required Stripe event selection

In Stripe, open **each** configured endpoint and compare its subscribed events with **Webhook endpoint & required events** in `/admin/payments/setup`. Each row represents one event in one mode. Record a redacted screenshot reference for the selection (the same evidence ID can cover multiple rows).

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| EVT-T01 | Blocker | Test endpoint: find `checkout.session.completed`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-T02 | Blocker | Test endpoint: find `checkout.session.async_payment_succeeded`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-T03 | Blocker | Test endpoint: find `checkout.session.async_payment_failed`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-T04 | Blocker | Test endpoint: find `checkout.session.expired`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-T05 | Blocker | Test endpoint: find `payment_intent.payment_failed`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-T06 | Blocker | Test endpoint: find `charge.refunded`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-T07 | Blocker | Test endpoint: find `refund.created`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-T08 | Blocker | Test endpoint: find `refund.updated`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-T09 | Blocker | Test endpoint: find `charge.refund.updated`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-L01 | Blocker | Live endpoint: find `checkout.session.completed`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-L02 | Blocker | Live endpoint: find `checkout.session.async_payment_succeeded`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-L03 | Blocker | Live endpoint: find `checkout.session.async_payment_failed`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-L04 | Blocker | Live endpoint: find `checkout.session.expired`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-L05 | Blocker | Live endpoint: find `payment_intent.payment_failed`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-L06 | Blocker | Live endpoint: find `charge.refunded`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-L07 | Blocker | Live endpoint: find `refund.created`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-L08 | Blocker | Live endpoint: find `refund.updated`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| EVT-L09 | Blocker | Live endpoint: find `charge.refund.updated`. | Selected. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Invoices and receipts

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| INV-01 | Blocker | Place an invoice-only order; open it from `/invoices` before paying. | **Issued**, not Paid. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| INV-02 | Blocker | Open the invoice PDF; compare the total with checkout. | Same amount and currency. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| INV-03 | Important | Inspect the synthetic name printed on the invoice PDF. | Full billing name, not preferred name. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| INV-04 | Blocker | Open the invoice URL from customer A’s session in customer B’s browser profile. | Invoice and PDF are inaccessible. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| INV-05 | Important | Open a receipt issued before upgrade and compare with its archived copy. | Original receipt PDF unchanged. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Order workflow wizard and publishing

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| WIZ-01 | Blocker | `/orders` → open a purchased synthetic order. | Wizard is the first view, not order details. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| WIZ-02 | Blocker | Open a phase requiring acceptance; leave it unaccepted. | **Next** cannot advance and shows a visible reason. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| WIZ-03 | Blocker | Complete acceptance on a configured full phase → **Next**. | Questions follow acceptance; no unrelated step appears. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| WIZ-04 | Blocker | Save a question answer, advance and reload mid-phase. | Resumes at first incomplete step. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| WIZ-05 | Blocker | On an order with a locking phase, complete its steps.<br>**Review and submit** → **Submit**. | Phase is **Submitted** and customer edits are locked. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| WIZ-06 | Important | Open a legacy order with a permitted intake form but no configured phase actions. | The wizard offers its existing intake action. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| WIZ-07 | Blocker | Open a purchased order that is waiting on the team. | Screen explains who acts next rather than showing a dead end. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| WIZ-08 | Important | Open an existing former-tab deep link for the synthetic order. | Correct order-detail content is still reachable. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PUB-01 | Blocker | `/admin/workflows` → open a draft designer and visit each step. | **Publish** remains in the header. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PUB-02 | Blocker | With an invalid synthetic draft, inspect **Publish**. | Cannot publish; validation reason is visible. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PUB-03 | Blocker | `/admin/workflows` → valid draft row → **Publish**.<br>Set **Change note (optional)** to `Go-live exercise`.<br>Click **Publish** and complete fresh MFA. | **Workflow published** names the version and default status. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| PUB-04 | Blocker | In isolated QA, publish with **Use for new orders (default workflow)** checked; place a new order. | New order uses that default version. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Files and audio

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| FIL-01 | Blocker | Purchased order → **Upload documents** step → choose the prepared synthetic PDF. | Its upload completes and appears in the phase. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| FIL-02 | Important | In that step select an unsupported synthetic file type. | Upload rejected with an understandable reason. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| FIL-03 | Blocker | `/orders/:id` → **Record or upload audio** → **Start recording**.<br>Deny access in the browser prompt. | **Upload audio** remains available in a phase configured with both actions. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| FIL-04 | Blocker | **Record or upload audio** → **Start recording**; allow access.<br>Speak a brief synthetic phrase → **Stop recording**.<br>Play the local recording. | The phrase is audible in the preview. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| FIL-05 | Blocker | Open the synthetic order’s file or phase ZIP as its owner, then try with customer B. | Customer B cannot download it. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| FIL-06 | Optional-if-enabled | `/admin/sharepoint-sync` → check the synthetic order’s run and matching SharePoint destination. | One matching item in the authorized destination. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Mail

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| MAIL-01 | Blocker | `/register` → **Create account** using the test mailbox. | Verification email arrives with the canonical portal host. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| MAIL-02 | Blocker | `/sign-in` → **Forgot password?**<br>Enter test **Email** → **Send reset link**. | Password reset mail arrives in the test mailbox. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| MAIL-03 | Important | Complete the test payment in PAY-07; inspect the receipt mailbox. | One receipt email for the test order. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| MAIL-04 | Important | `/admin/email-templates` → open a template → **Send test to me** from a test admin mailbox. | Test message reaches that mailbox. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Staff console

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| STF-01 | Blocker | Sign in as customer A and open `/admin/orders`. | Customer is denied the admin route. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| STF-02 | Blocker | Sign in as staff and open `/admin/staff`. | Staff cannot access admin staff management. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| STF-03 | Important | `/admin/tickets` → open test ticket → **Customer-visible reply**.<br>Type `Go-live reply` → **Send reply**. | Customer sees that reply in their ticket. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| STF-04 | Blocker | `/admin/tickets/:id` → type `Go-live internal` into **Internal note** → **Save internal note**. View as customer. | Internal note is not visible to the customer. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Audit, logging, and SIEM

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| AUD-01 | Blocker | After AUD-03, open `/admin/audit`.<br>**Time range** → **Last 24 hours** → **Apply filters**. | The `audit.integrity.verified` event appears. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| AUD-02 | Important | Operator: follow [Correlation](LOGGING_AND_AUDIT.md#2-correlation-following-one-workflow) for one synthetic request. | The same request/correlation ID connects app and edge evidence. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| AUD-03 | Blocker | `/admin/audit/integrity` → **Verify now**. | **Chain verified**. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| AUD-04 | Blocker | Inspect a redacted audit record for a synthetic billing profile change. | Action is logged without the billing values. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| AUD-05 | Optional-if-enabled | `/admin/siem` → open approved TLS destination; send its test using [forwarding guidance](LOGGING_AND_AUDIT.md#6-siem--syslog-forwarding). | Approved collector receives the test event over verified TLS. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Backup and restore drill

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| BAK-01 | Blocker | Operator: follow [backup verification](BACKUP_AND_RESTORE.md#4-routine-operations-web-admin--cli) for a new encrypted archive. | Archive verification succeeds. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| BAK-02 | Blocker | Operator: retrieve the encrypted off-host copy and compare digest. | Copy digest matches the verified archive. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| BAK-03 | Blocker | Operator: follow the [isolated restore](BACKUP_AND_RESTORE.md#5-operator-cli-isolated-restore-procedure) into clean DB/storage with outbound delivery blocked. | Restore exits successfully with no integrity mismatches. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| BAK-04 | Blocker | On that restored copy, open the synthetic customer’s billing profile. | Expected synthetic profile recovered without exposing it in evidence. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| BAK-05 | Blocker | Operator: compare drill recovery point and completion time with agreed RPO/RTO. | Both are within the agreed limits. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Upgrade and rollback

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| UPG-01 | Blocker | Operator: follow [Upgrade](UPGRADE.md) on a restored pre-08 copy; inspect edge after fencing. | Public app access is blocked while fenced. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| UPG-02 | Blocker | Operator: review the candidate upgrade record on the isolated copy. | Migration `0008` applied successfully after verified backup. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| UPG-03 | Blocker | Operator: rehearse stopped upgrade before migration per [recovery guidance](UPGRADE.md#6-recovery-if-an-upgrade-stops-mid-way). | Healthy old release can be recovered without changing schema. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| UPG-04 | Blocker | Operator: separately rehearse an interruption after migration may have begun. | Site stays fenced pending approved forward repair or isolated compatible restore. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Security headers and rate limits

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| SEC-01 | Blocker | Operator: inspect HTTPS response headers on `/sign-in`. | `Strict-Transport-Security` present for the production HTTPS profile. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| SEC-02 | Blocker | Operator: inspect `Content-Security-Policy` on `/sign-in`. | Expected nonce policy and framing restrictions present. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| SEC-03 | Blocker | Operator: inspect authenticated response cache headers for the synthetic invoice. | Private invoice data is not cacheable. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| SEC-04 | Blocker | In isolated QA, use the agreed small sign-in limit; submit wrong synthetic credentials at `/sign-in` until limited. | Safe limit response, no diagnostic secrets. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Accessibility

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| A11-01 | Blocker | `/orders/:id` → press Tab and activate wizard **Next** using only keyboard. | Focus moves to the new step heading. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| A11-02 | Blocker | Use a screen reader on the wizard step list. | Current step is announced, not conveyed by color alone. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| A11-03 | Blocker | `/orders/new` → use arrows to select a tier with screen reader on. | Radio focus stays put and expanded content is announced. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| A11-04 | Blocker | `/admin/workflows` → open **Publish** with keyboard and dismiss it. | Focus returns to the invoking control or a sensible successor. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| A11-05 | Blocker | `/register` → submit an incomplete name/billing form with screen reader on. | Errors identify their fields and are discoverable without color. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| A11-06 | Blocker | In a laptop browser at 1280 CSS px, zoom to 400% and finish a wizard step. | Controls remain usable without two-dimensional page scrolling. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| A11-07 | Important | Operator: run `a11y-check.mjs` after the responsive check, per the [Increment 08 QA runbook](../../scripts/qa/README.md#increment-08-focused-sweep). | No WCAG 2.2 AA-tagged axe failures in tested states. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Responsive devices

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| RSP-01 | Blocker | Operator: run `responsive-check.mjs` with private fixtures from the [Increment 08 QA runbook](../../scripts/qa/README.md#increment-08-focused-sweep). | No page-level overflow at 240 CSS px in either theme. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| RSP-02 | Blocker | Inspect the RSP-01 results at 320/390/640/768/1024/1280/1440 CSS px in both themes. | No page-level overflow at those widths. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| RSP-03 | Important | On a phone, open `/register` and enter names with the on-screen keyboard. | Focused inputs and primary action can be reached. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| RSP-04 | Important | On a phone, rotate an order wizard between portrait and landscape. | The same step and actions remain available. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## SEO and indexing

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| SEO-01 | Blocker | Open portal `/robots.txt`. | Contains `Disallow: /`. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| SEO-02 | Important | Operator: inspect portal HTML response for `/sign-in`. | `X-Robots-Tag` includes `noindex`. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| SEO-03 | Optional-if-enabled | If public marketing is in scope, inspect that site’s public sitemap. | Approved public URLs only; no private portal links. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Analytics

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| ANA-01 | Blocker | Operator: on `/privacy`, open a new private browser window; inspect network before accepting cookies. | No PostHog or Clarity requests. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ANA-02 | Optional-if-enabled | `/admin/integrations/analytics` → configure approved PostHog; opt in anonymously on `/privacy`. | Only approved PostHog endpoint receives the test visit. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ANA-03 | Optional-if-enabled | `/admin/integrations/analytics` → configure approved Clarity project ID; opt in anonymously on `/terms`. | Correct Clarity project receives the test visit. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| ANA-04 | Blocker | After consent, sign in and open a synthetic `/orders/:id`. Inspect network. | Neither vendor loads on a private order path. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

## Final sign-off

| Section | Passed | Failed | Blocked | Excluded |
| --- | --- | --- | --- | --- |
| Server and TLS | ___ | ___ | ___ | ___ |
| Accounts and MFA | ___ | ___ | ___ | ___ |
| Registration and names | ___ | ___ | ___ | ___ |
| Catalogue and ordering | ___ | ___ | ___ | ___ |
| Order numbers | ___ | ___ | ___ | ___ |
| Add-on orders | ___ | ___ | ___ | ___ |
| Billing | ___ | ___ | ___ | ___ |
| Stripe test mode and test events | ___ | ___ | ___ | ___ |
| Stripe live mode and live events | ___ | ___ | ___ | ___ |
| Invoices and receipts | ___ | ___ | ___ | ___ |
| Order workflow wizard and publishing | ___ | ___ | ___ | ___ |
| Files and audio | ___ | ___ | ___ | ___ |
| Mail | ___ | ___ | ___ | ___ |
| Staff console | ___ | ___ | ___ | ___ |
| Audit, logging, and SIEM | ___ | ___ | ___ | ___ |
| Backup and restore drill | ___ | ___ | ___ | ___ |
| Upgrade and rollback | ___ | ___ | ___ | ___ |
| Security headers and rate limits | ___ | ___ | ___ | ___ |
| Accessibility | ___ | ___ | ___ | ___ |
| Responsive devices | ___ | ___ | ___ | ___ |
| SEO and indexing | ___ | ___ | ___ | ___ |
| Analytics | ___ | ___ | ___ | ___ |

| ID | Priority | Where and what to do | Expected | Result / evidence / tester |
| --- | --- | --- | --- | --- |
| GO-01 | Blocker | Release owner: review evidence against every in-scope Blocker. | All pass on the identified release and applicable environment. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |
| GO-02 | Blocker | Release owner: record a written decision for each failed Important row and every scope exclusion. | Each decision names an owner, mitigation, and retest or review date. | ☐ Pass ☐ Fail<br>Evidence: ___<br>Tester/date: ___ |

**GO** only when all in-scope Blockers pass and every failed Important has a written owner decision. Treat a blocked or unrun Blocker as **NO-GO**, not a waiver. Mark an Optional-if-enabled row excluded only when the capability is verified off or not part of the deployment. If live card payments are in scope, no live GO without Stripe Dashboard 2xx delivery, return-page confirmation, Paid invoice, receipt, wizard continuation, and refund evidence. Otherwise keep the release fenced or the explicitly excluded capability off and retest.

**Decision:** ☐ GO ☐ NO-GO | Candidate/environment: ____ | Release owner / UTC date: ____ | Operations: ____ | Payment approver if applicable: ____ | Security/accessibility reviewer: ____ | Evidence and issue references: ____

### Not covered by this checklist

- **Penetration test:** Arrange a separate authorized assessment.
- **Load test:** Test capacity in an isolated environment with an approved plan.
- **Legal review:** Have the owner arrange privacy, payment, tax and contractual review.
- **Real screen-reader users:** Operator checks are not a substitute for testing with people who rely on assistive technology.

### TODO for release lead: confirm final Increment 08 labels

- **D1/D4:** Confirm registration billing disclosure and checkout radio and checkbox copy (BIL-01–02, BIL-05–07).
- **D3:** Confirm final checkout project-target text and console related-orders heading (ADD-03, ADD-07).
- **D5:** Confirm admin repair placement and the new paid banner, receipt and wizard actions (PAY-09, PAY-11–12, PAY-15, PAY-29, PAY-31–32).
