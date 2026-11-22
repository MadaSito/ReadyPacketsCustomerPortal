# Administrator Guide & Customer Help Draft — Increment 05 (Packages D1 & C4)

## 1. Administrator Guide — Policy Acceptance Log Centre (Package D1)

Open **Billing & compliance -> Policy acceptances** (`/admin/policy-acceptances`) or the **Policies** tab on any customer profile (`/admin/customers/:customerId`) to review append-only policy acceptance evidence across account registration, portal re-acceptance prompts, checkout, order acceptance gates, and historical imports. No acceptance evidence row can be edited or deleted from the console.

### Capabilities & Privacy Boundaries

- **`policies.acceptances.read`** (`staff` and `admin`): grants read access to `/admin/policy-acceptances` (**Log**, **Coverage**, and **Policy updates** tabs), standalone version text (`/admin/policy-acceptances/versions/:versionId`), and the customer profile **Policies** tab. Customers receive `404 Not Found` on all acceptance-log procedures; staff accounts without the capability receive `403 Forbidden` and an `authz.compliance.denied` security event.
- **`policies.manage`** (`admin`): required to decrypt a customer's typed legal signature name inside the **View evidence** detail dialog (`compliance.policies.admin.acceptanceLog.detail`). Raw list, customer-profile, and CSV export responses never include or decrypt typed signer names; decryption runs inside a live-session transaction only when an administrator opens a single evidence record.
- **`policies.acceptances.export`** (`admin` + fresh step-up MFA): required to export filtered acceptance records as CSV (`compliance.policies.admin.acceptanceLog.export`). Each export is capped at `5,000` rows (with a `10,000`-row / `3,000` ms scan ceiling for sparse post-refinement filters), neutralizes spreadsheet formula prefixes (`=`, `+`, `-`, `@`, tab, carriage return, including leading whitespace before `=`, `+`, `-`, `@`), and records `policy.acceptance_log.exported` (`row_count`, `truncated`, `max_rows`, `scan_capped`, `filters`).

### Console Views & Procedures

| View / Action | Route | tRPC Procedure |
| --- | --- | --- |
| Filter catalog (policies & versions) | `/admin/policy-acceptances` | `compliance.policies.admin.acceptanceLog.filterOptions` |
| Unified acceptance log (cursor-paginated) | `/admin/policy-acceptances` | `compliance.policies.admin.acceptanceLog.list` |
| Single evidence detail & policy snapshot | Dialog on Log / Customer Policies tab | `compliance.policies.admin.acceptanceLog.detail` |
| Active-customer coverage & outstanding list | `/admin/policy-acceptances/coverage` | `compliance.policies.admin.acceptanceLog.coverage` |
| Published policy version timeline & counts | `/admin/policy-acceptances/updates` | `compliance.policies.admin.acceptanceLog.updates` |
| Per-customer policy status & full history | `/admin/customers/:customerId` (`Policies` tab) | `compliance.policies.admin.acceptanceLog.forCustomer` |
| Standalone exact published version text | `/admin/policy-acceptances/versions/:versionId` | `compliance.policies.admin.acceptanceLog.versionText` |
| Formula-safe CSV export (up to 5,000 rows) | Action on `/admin/policy-acceptances` | `compliance.policies.admin.acceptanceLog.export` |

- **Settings keys added**: none (the log centre is an always-on read-only view over append-only evidence).

---

## 2. Administrator Guide — Invoice Discount Breakdown & Redemption Release Fence (Package C4 & G-C3-02)

### Separate Bundle and Code Discount Lines

When an order includes a promotional discount code (`order.promoDiscountMinor > 0`), order-aligned invoices display the promotional discount as its own labelled row alongside any bundle discount across all three surfaces:

- Console invoice detail (`/admin/invoices/:invoiceId`)
- Customer invoice detail (`/invoices/:invoiceId`)
- Downloadable PDF invoice (`GET /api/compliance/invoices/:invoicePublicId/pdf`)

Invoices display only the promotion's customer-facing label (`Discount (<promoLabel>)`), never the raw secret code. If an administrator creates a supplemental manual invoice on the same order with a custom discount amount unrelated to the checkout breakdown, the invoice displays its custom `Discount` line without misattributing the order's promotional breakdown.

### Zero-Total (`100%` Discount) Invoices

When an issued invoice has `totalMinor === 0` (such as a `100%` promotional discount), the compliance ledger derives `status = "paid"`, `paymentState = "paid"`, `balanceDueMinor = 0`, and `canRecordPayment = false` immediately upon issuance, with no manual or online payment required.

### Conservative Redemption Release Exposure (`orderPaymentExposureInTx`)

When an order is cancelled or an administrator requests manual redemption release (`promotions.admin.releaseRedemption`), `compliance.orderPaymentExposureInTx` checks under non-blocking current reads (`FOR SHARE NOWAIT`) that:

1. `grossPaidMinor === 0` across all invoices of the order;
2. `payableInvoiceOpen === false` (no issued invoice has `balanceDueMinor > 0`);
3. `providerCapturePending === false`; and
4. `providerAttemptEver === false` (no `payment_attempts` row has ever been created for the order in any status, including `failed`, `cancelled`, or `expired`).

If any check fails, if rows are contended, or if the payments port is unavailable, the exposure read fails closed without aborting the outer cancellation transaction, and the promotion redemption stays used. Issue a new single-use code to compensate a customer in that case.

---

## 3. Customer Help Article Draft — Reading Discounts on Your Invoice

### How Bundle and Promotional Discounts Appear

When your order qualifies for the multi-packet **Bundle discount** or a **Promotional discount** applied at checkout, your invoice itemizes each discount on its own line above tax and the invoice total:

- **Bundle discount** shows the multi-packet savings applied before promotional discounts.
- **Discount (`<Promotion Name>`)** shows the savings from the promotional code or link used on your order. For your security, invoices and downloadable PDFs display the promotion's descriptive name rather than the code itself.

Both lines appear on your online invoice page (`/invoices/:invoiceId`) and on the downloadable PDF receipt.

### Full (`100%`) Discounts and `$0.00` Invoices

If a promotion reduces your invoice total to `$0.00`, your issued invoice is automatically marked **Paid** with a `$0.00` balance due, and you can download the PDF receipt immediately for your records.
