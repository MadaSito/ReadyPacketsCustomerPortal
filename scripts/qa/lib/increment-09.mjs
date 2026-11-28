export const INCREMENT_09 = "increment-09";

const trash = (options = {}) => ({ route: "/admin/trash", role: "admin", ...options });
const emailLink = 'main:has(a[data-rp-email-link][href^="mailto:"])';
const brand = (kind = "") => `html:has(img[data-brand-lockup${kind ? `="${kind}"` : ""}][src*="-v2026101502."]):not(:has(img[src*="readypackets-approved"]))`;
const moveDialog = '[role="alertdialog"]:has(:text-matches("^Move .* to the trash[?]$")):has(:text-matches("^(Moves with it:|Nothing else moves with it[.])$"))';
const button = (name, options = {}) => ({ role: "button", name, ...options });
const customer = (options = {}) => ({ route: "/admin/customers/:customerId", role: "admin", publicIdAtEnd: true, ...options });

// Dialog scenarios only open the confirmation and inspect it. They never submit it.
export const increment09States = Object.freeze({
  "trash-orders": trash({ ready: 'main section[aria-labelledby="trash-order-h"]:has(button:has-text("Delete permanently"))' }),
  "trash-customers": trash({
    interactive: true, steps: [{ role: "tab", name: "Customers", namePrefix: true }],
    ready: 'main section[aria-labelledby="trash-customer-h"]:has(button:has-text("Delete permanently"))',
  }),
  "trash-empty": trash({
    interactive: true, steps: [
      { label: "Search by order number or project", text: "QA-NO-SUCH-SYNTHETIC-PROJECT-09" },
      { label: "Search by order number or project" },
    ],
    ready: 'main :text-is("No orders match these filters")',
  }),
  "trash-restore-dialog": trash({
    interactive: true, steps: [button("Restore ", { namePrefix: true, first: true })],
    ready: '[role="alertdialog"]:has(:text-matches("^Restore .+[?]$")):has(button:text-is("Restore"))',
  }),
  "trash-purge-dialog": trash({
    interactive: true, steps: [button("Delete permanently ", { namePrefix: true, first: true })],
    ready: '[role="alertdialog"]:has(input#rp-confirm-text):has(button:disabled:text-is("Delete permanently"))',
  }),
  "trash-retention": trash({ ready: 'main form:has(button:text-is("Save clean-up settings"))' }),
  "order-row-move-to-trash": {
    route: "/admin/orders", role: "admin", interactive: true,
    steps: [button("Move to trash:", { namePrefix: true, first: true })], ready: moveDialog,
  },
  "order-detail-move-to-trash": {
    route: "/admin/orders/:orderId", role: "admin", publicIdAtEnd: true, interactive: true,
    steps: [{ testId: "order-move-to-trash" }], ready: moveDialog,
  },
  "customer-move-to-trash-blocked": customer({
    ready: 'main:has(button:disabled:text-is("Move to trash")):has(:text-matches("^Suspend this account first[.]?$"))',
  }),
  "customer-move-to-trash-dialog": customer({
    interactive: true, steps: [button("Move to trash")], ready: moveDialog,
  }),
  "customer-email-link": customer({ ready: emailLink }),
  "staff-email-link": { route: "/admin/staff", role: "admin", ready: emailLink },
  "privacy-email-link": { route: "/privacy", role: "anonymous", ready: emailLink },
  "terms-email-link": { route: "/terms", role: "anonymous", ready: emailLink },
  "mail-template-preview": { route: "/admin/email-templates/:templateKey", role: "admin", ready: 'main iframe[title="Preview of Order confirmation"]' },
  "invoice-email-link": { route: "/invoices/:invoiceId", role: "customer", publicIdAtEnd: true, ready: emailLink },
  "admin-invoice-email-link": { route: "/admin/invoices/:invoiceId", role: "admin", publicIdAtEnd: true, ready: emailLink },
  "receipt-email-link": { route: "/receipts/:receiptId", role: "customer", publicIdAtEnd: true, ready: emailLink },
  "admin-receipt-email-link": { route: "/admin/receipts/:receiptId", role: "admin", publicIdAtEnd: true, ready: emailLink },
  "brand-sign-in": { route: "/sign-in", role: "anonymous", ready: brand("square") },
  "brand-registration": { route: "/register", role: "anonymous", ready: brand("square") },
  "brand-privacy": { route: "/privacy", role: "anonymous", ready: brand("square") },
  "brand-terms": { route: "/terms", role: "anonymous", ready: brand("square") },
  "brand-customer-shell": { route: "/", role: "customer", ready: brand() },
  "brand-console-shell": { route: "/admin", role: "admin", ready: brand() },
  "brand-not-found": { route: "/__qa_missing_route__", role: "anonymous", ready: brand("square") },
});
