// Focused release evidence: an ordinary page load must never impersonate an interactive fixture.
export const INCREMENT_08 = "increment-08";
export const INCREMENT_08_WIDTHS = Object.freeze([240, 320, 390, 640, 768, 1024, 1280, 1440]);

const paymentReturn = (state) => ({
  route: "/checkout/return", role: "customer", query: "attempt", sandbox: true,
  ready: `main [data-testid="payment-return-confirmation"][data-payment-return-state="${state}"]`,
});
const billingChoice = (hasSaved, mode, summary) => (
  `main form[aria-label="Checkout details"] [data-testid="checkout-billing-section"][data-has-saved-profile="${hasSaved}"][data-billing-mode="${mode}"] [data-testid="${summary}"]`
);
const billingSettings = (state, summary) => ({
  route: "/account/billing", role: "customer",
  ready: `main [data-testid="billing-profile-page"][data-profile-state="${state}"] [data-testid="${summary}"]`,
});
const publishDialog = '[role="dialog"]:has([data-testid="publish-draft-confirm"])';

// Data-dependent states need a concrete URL and a readiness locator that proves the intended state loaded.
// Fixture setup may open controls, but it must never submit, purchase, accept a policy, upload or publish.
export const increment08States = Object.freeze({
  "registration-names": { route: "/register", role: "anonymous", ready: 'main:has(input[autocomplete="given-name"]):has(input[autocomplete="family-name"]):has(input[autocomplete="nickname"])' },
  "registration-billing": { route: "/register", role: "anonymous", interactive: true, ready: 'main input[autocomplete="billing street-address"]' },
  "billing-settings-empty": billingSettings("empty", "billing-profile-empty"),
  "billing-settings-saved": billingSettings("saved", "billing-profile-summary"),
  "packet-tier-expanded": { route: "/orders/new", role: "customer", interactive: true, ready: 'main [data-packet-card="1"] [data-tier-disclosure="Basic"] button[aria-expanded="true"]' },
  "add-to-order": { route: "/orders/new", role: "customer", query: "addTo", ready: 'main [data-testid="packet-1-owned"]' },
  "order-wizard": { route: "/orders/:orderId", role: "customer", publicIdAtEnd: true, ready: 'main ol li[aria-current="step"]' },
  "order-wizard-waiting": { route: "/orders/:orderId", role: "customer", publicIdAtEnd: true, ready: 'main [data-wizard-waiting="team"]' },
  "cart-add-to-order": { route: "/cart", role: "customer", ready: 'main [data-testid="cart-adding-to-project"]' },
  "checkout-add-to-order": { route: "/cart/checkout", role: "customer", ready: 'main form[aria-label="Checkout details"]:has([data-testid="checkout-adding-to-project"]):has([data-testid="checkout-target-project-lock"])' },
  "checkout-saved-billing": { route: "/cart/checkout", role: "customer", ready: billingChoice(true, "saved", "checkout-saved-billing-summary") },
  "checkout-different-billing": { route: "/cart/checkout", role: "customer", interactive: true, ready: billingChoice(true, "custom", "checkout-custom-billing-fields") },
  "checkout-no-saved-billing": { route: "/cart/checkout", role: "customer", ready: billingChoice(false, "custom", "checkout-custom-billing-fields") },
  "checkout-return-paid": paymentReturn("paid"),
  "checkout-return-pending": paymentReturn("processing"),
  "checkout-return-unpaid": paymentReturn("unpaid"),
  "checkout-return-invalid": paymentReturn("invalid"),
  "checkout-return-missing-target": { route: "/checkout/return", role: "customer", noPaymentTarget: true, ready: 'main :text-is("Checkout reference unavailable")' },
  "stripe-webhook-diagnostics": { route: "/admin/payments/setup", role: "admin", ready: 'main [data-testid="stripe-webhook-diagnostics"]' },
  "workflows-publish-dialog": { route: "/admin/workflows", role: "admin", interactive: true, ready: publishDialog },
  "workflow-draft-publish-dialog": { route: "/admin/workflows/drafts/:draftId", role: "admin", publicIdAtEnd: true, interactive: true, ready: publishDialog },
  "workflow-draft-blocked-publish": { route: "/admin/workflows/drafts/:draftId", role: "admin", publicIdAtEnd: true, ready: 'main:has([data-testid="workflow-publish"]:disabled) [data-testid="workflow-publish-reasons"] li:text-matches("^Fix [0-9]+ problems? in the draft first[.]$")' },
});

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function increment08FixtureProblem(spec, item, path, attemptsUseSandbox) {
  if (typeof item?.ready !== "string" || !item.ready.trim()) return "supply a state-specific readiness selector";
  if (spec.interactive && (!Array.isArray(item.steps) || item.steps.length === 0)) return "supply non-submitting steps that open or select the intended state";
  const { pathname, searchParams: params } = new URL(path, "https://qa.invalid");
  if (spec.publicIdAtEnd && !ULID.test(pathname.split("/").at(-1))) return "supply a seeded public ID in the fixture path";
  if (spec.noPaymentTarget && (params.has("attempt") || params.has("cart"))) return "leave the checkout attempt and cart parameters absent";
  if (spec.query) {
    const values = params.getAll(spec.query);
    if (values.length !== 1 || !ULID.test(values[0])) return `supply one seeded ${spec.query} public ID`;
    if (spec.query === "attempt" && params.has("cart")) return "do not combine attempt and cart parameters";
  }
  if (spec.sandbox && attemptsUseSandbox !== true) return "confirm the seeded attempt uses a disposable sandbox provider (opening this state can trigger reconciliation)";
  return undefined;
}
