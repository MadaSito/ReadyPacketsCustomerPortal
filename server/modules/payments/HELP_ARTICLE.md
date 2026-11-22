# Paying Your Invoice in ReadyPackets

Every order in ReadyPackets generates an itemized invoice under **Invoices** (`/invoices`), where you can review line items, discounts, applicable tax, payments, refunds, and download your invoice summary.

## Payment options

Depending on how your administrator has configured the portal, one of two checkout modes is active:

1. **Pay by invoice (offline settlement):**
   - Your order and invoice are issued immediately at checkout with payment instructions.
   - Follow the remittance instructions on your invoice (such as ACH, wire transfer, or check). Once our team confirms receipt, your invoice status updates to **Paid** automatically.
2. **Pay online (Stripe Checkout or Square Payment Links):**
   - Selecting **Pay online** redirects your browser over HTTPS to our payment provider's hosted checkout page (**Stripe Checkout** or **Square**).
   - ReadyPackets never collects or stores your card or wallet credentials on portal servers.

## What happens after you return from hosted checkout

- Returning to the portal from Stripe or Square displays your live checkout confirmation status while we verify payment confirmation directly with the payment provider.
- In most cases confirmation completes within a few seconds. If network delivery of the provider confirmation is briefly delayed, your invoice temporarily shows **Processing confirmation** and updates to **Paid** automatically once verification completes — you do not need to submit payment a second time.
- If you cancel on the hosted payment page or your checkout session expires, your invoice remains open under **Invoices** so you can start a fresh payment session whenever you are ready.

All checkout, return, and invoice views are designed and tested against WCAG 2.2 AA for keyboard, screen-reader, and responsive mobile/desktop use.
