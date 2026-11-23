# 0054 — Receipts for confirmed payments

Status: Proposed (drafted from INCREMENT_06_CONTRACT.md D15 and D5; to be corrected against the compliance, payments and jobs modules' API.md)

## Context
The owner asked that every order confirmed paid produces a receipt with the logo. It should show the customer, the company, the items, the price paid and the discount codes, be e-mailed to the customer and be kept in the customer's portal. Increment 05 relaxed discounts to allow $0 and $0.01 orders. Stripe refuses card charges below its minimum (0.50 USD or the equivalent).

## Decision
- **When a receipt is made.** Exactly one receipt is created per confirmed payment, keyed on the payment id. A payment counts as confirmed in three cases:
  - a verified Stripe or Square webhook;
  - a zero or waived total settled at checkout;
  - a manually recorded payment.
- **Contents:**
  - the number `RPR-<year>-<6 digits>` and the issue time;
  - the company block: logo, legal name, address, contact and tax id, from the company profile settings, which gain the missing fields;
  - the customer block: name, company, customer id `RPCUS-…` and e-mail;
  - the order reference(s);
  - the lines: product, tier, quantity and unit price;
  - the subtotal, each discount code with its amount, and the bundle and other discounts;
  - tax if any, the amount waived and the **amount paid**;
  - the payment method summary: brand and last four digits when the provider gives them, never the full number;
  - the provider reference and the currency.
- **PDF.** The PDF comes from the existing generator (`invoicePdf.ts`, extended). It has an embedded logo and real text, sets the document title and language, and is tagged where feasible. It is stored encrypted like other documents. A snapshot of the figures is stored, so the receipt can be reproduced unchanged.
- **Delivery:**
  - by e-mail, with the template `payment_receipt`, the PDF attached and the text editable in mail templates;
  - in the portal, under Invoices → **Receipts** and on the order.

  As implemented by jobs_engineer, a PDF of up to 690 KiB is attached. A larger PDF is not attached; the customer gets the e-mail with a secure link to Invoices instead. The shared encryption size cap is unchanged.

  Staff see receipts on the order and on the customer profile and can **Send again**, which is audited and rate limited.
- **Refunds.** A refund marks the receipt "refunded" or "partially refunded" and produces a refund note. The original receipt is never altered.
- **Settings:**
  - `payments.receipts` `{ enabled: true, emailCustomer: true, footerText }`;
  - `payments.small_totals` `{ belowProviderMinimum: "waive" | "block" }`, default `waive`.
- **Totals below the card minimum** (`payments.small_totals`):
  - with `waive`, an amount below the provider minimum is recorded as waived, the order is settled as paid without a provider call, and the receipt shows **Amount waived**;
  - with `block`, the customer is told clearly why they cannot pay that amount online;
  - the minimums are a table in the payments module (per provider and currency), overridable in settings.

## Assumptions to confirm with the owner
- Receipts and the receipt e-mail are on after upgrade.
- Waiving amounts below the provider minimum is the default; the owner may prefer `block`.

## Consequences
- Every paid, waived or zero-total order has a reproducible receipt.
- A $0.01 order is settled as waived, not charged, because no card provider accepts such a charge. With `waive`, ReadyPackets forgoes amounts below the minimum.
- A receipt is a record of payment produced by the portal. It is not a tax invoice unless the owner's company details and local rules make it one.
