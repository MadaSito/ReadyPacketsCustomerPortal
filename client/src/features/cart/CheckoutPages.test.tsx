import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CheckoutCartResult } from "@server/modules/cart/types";
import { invoiceCheckoutNavigation } from "@/features/compliance/customer/InvoicePages";
import type { MeResult, MeUser } from "@/lib/authApi";
import type * as transport from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { fakeAuthApi, renderUi } from "@/ui/testing";
import { CheckoutPage, isHostedCheckoutUrl } from "./CheckoutPage";
import { CheckoutReturnPage, readCheckoutTarget, type CheckoutStatus } from "./CheckoutReturnPage";
import { CheckoutCancelPage } from "./CheckoutCancelPage";
import type { CartViewData } from "./CartPage";

const mocks = vi.hoisted(() => ({
  cart: vi.fn(),
  checkout: vi.fn(),
  status: vi.fn(),
  restore: vi.fn(),
  startInvoiceCheckout: vi.fn(),
  policyMyStatus: vi.fn(),
  policyAccept: vi.fn(),
}));
vi.mock("@/lib/trpc", async (original) => ({
  ...await original<typeof transport>(),
  useTRPC: () => ({
    cart: {
      get: { queryKey: () => ["cart"], queryOptions: () => ({ queryKey: ["cart"], queryFn: mocks.cart }) },
      badgeCount: { queryKey: () => ["badge"] },
      checkoutStatus: { queryOptions: (input: unknown, options: object) => ({
        ...options, queryKey: ["checkout", input], queryFn: () => mocks.status(input),
      }) },
      restoreCheckout: { mutationOptions: () => ({ mutationFn: (input: unknown) => mocks.restore(input) }) },
    },
    payments: {
      startInvoiceCheckout: {
        mutationOptions: () => ({ mutationFn: (input: unknown) => mocks.startInvoiceCheckout(input) }),
      },
    },
    compliance: {
      invoices: {
        pathKey: () => ["compliance.invoices"],
      },
      receipts: {
        pathKey: () => ["compliance.receipts"],
      },
      policies: {
        myStatus: {
          queryKey: () => ["compliance.policies.myStatus"],
          queryOptions: () => ({ queryKey: ["compliance.policies.myStatus"], queryFn: mocks.policyMyStatus }),
        },
        accept: {
          mutationOptions: () => ({ mutationFn: (input: unknown) => mocks.policyAccept(input) }),
        },
      },
    },
  }),
  useTRPCClient: () => ({ cart: { checkout: { mutate: mocks.checkout } } }),
}));

const id = (end: number) => `01J${"0".repeat(22)}${end}`;
const [cartId, attemptId, orderId, invoiceId] = [id(1), id(2), id(3), id(4)];
const mndaDocId = id(9);
const mndaVersionId = id(8);
const date = new Date("2026-11-21T12:00:00Z");
const requiredPolicy: CartViewData["pendingPolicies"][number] = {
  documentPublicId: id(5), slug: "synthetic-policy", title: "Synthetic checkout policy", audience: "customer",
  requiresAcceptance: true, requiresTypedSignature: true, versionPublicId: id(6), versionNumber: 2, versionLabel: "2.0",
  contentFormat: "plain_text", bodyText: "A synthetic policy used by the component test.",
  contentHash: "a".repeat(64), changeSummary: null, effectiveAt: date, publishedAt: date,
};
const cart: CartViewData = {
  cartPublicId: cartId, version: 3, status: "open", itemCount: 1, projectName: "Synthetic project", note: "",
  billing: { fullName: "Synthetic Customer", company: "", email: "billing@example.test", country: "US", region: "",
    addressLine1: "100 Synthetic Way", addressLine2: "", city: "Sample", postalCode: "00001", taxId: "" },
  items: [{ itemPublicId: id(7), productPublicId: id(8), packetNumber: null, groupName: "Sample group", tier: null,
    tierOptions: [], name: "Synthetic add-on", description: "", outcome: "", timeline: "", quantity: 1,
    unitPriceMinor: 1600, lineTotalMinor: 1600, currency: "USD", available: true }],
  hasUnavailableItems: false, mixedCurrency: false, paymentProvider: "none", paymentEnvironment: "test", onlinePaymentEnabled: false,
  promotionsEnabled: false, promoNotice: null, upsells: [],
  smallTotalEvaluation: null,
  totals: { currency: "USD", subtotalMinor: 1600, discountMinor: 200, discountLabel: "Bundle savings", subtotalAfterDiscountMinor: 1400,
    taxRateBps: 1000, taxMinor: 140, totalMinor: 1540, bundle: null, promo: null },
  pendingPolicies: [requiredPolicy], updatedAt: date,
};
const pending: CheckoutStatus = {
  cartPublicId: cartId, confirmationState: "pending_confirmation", paymentMode: "redirect", provider: "square",
  attemptPublicId: attemptId, attemptStatus: "redirected", attemptInFlight: true,
  onlinePaymentAvailable: true, onlinePaymentUnavailableReason: null, lastAttemptFailureClass: null,
  failureReasonCode: null, orderPublicId: orderId,
  orderReference: "RP-SYNTHETIC", invoicePublicId: invoiceId, invoiceNumber: "INV-SYNTHETIC",
  invoiceStatus: "issued", currency: "USD", subtotalMinor: 1600, discountMinor: 200, discountLabel: "Bundle savings",
  promoDiscountMinor: 0, promoLabel: null,
  taxRateBps: 1000, taxMinor: 140, totalMinor: 1540, waivedMinor: 0, balanceDueMinor: 1540,
  receiptPublicId: null, canRestoreToCart: true, alreadyRestored: false,
  checkedOutAt: date,
};
const invoice: CheckoutCartResult = {
  mode: "invoice", cartPublicId: cartId, orderPublicId: orderId, orderReference: "RP-SYNTHETIC", invoicePublicId: invoiceId,
  invoiceNumber: "INV-SYNTHETIC", currency: "USD", totalMinor: 1540,
};

let redirectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  redirectSpy = vi.spyOn(invoiceCheckoutNavigation, "redirectToHostedCheckout").mockImplementation(() => {});
  mocks.cart.mockResolvedValue(cart);
  mocks.checkout.mockResolvedValue(invoice);
  mocks.status.mockResolvedValue(pending);
  mocks.startInvoiceCheckout.mockResolvedValue({
    mode: "redirect",
    attemptPublicId: id(9),
    invoicePublicId: invoiceId,
    provider: "stripe",
    environment: "live",
    redirectUrl: "https://checkout.stripe.com/pay/cs_live_synthetic_retry",
    expiresAt: new Date("2026-11-21T12:30:00Z"),
  });
  mocks.restore.mockImplementation(async () => {
    mocks.status.mockResolvedValue({ ...pending, confirmationState: "cancelled", canRestoreToCart: false, alreadyRestored: true });
    return { restored: true, alreadyRestored: false, cart };
  });
  mocks.policyMyStatus.mockResolvedValue({
    expectedSignerName: "Synthetic Customer",
    published: [
      {
        documentPublicId: mndaDocId,
        title: "Mutual Non-Disclosure Agreement",
        versionPublicId: mndaVersionId,
        versionNumber: 1,
        versionLabel: "1.0",
        effectiveAt: date,
        contentFormat: "plain_text",
        bodyText: "Short MNDA text that fits without scrolling in tests.",
        contentHash: "b".repeat(64),
        requiresTypedSignature: true,
      },
    ],
    accepted: [],
  });
  mocks.policyAccept.mockResolvedValue({ acceptancePublicId: id(9) });
});

afterEach(() => {
  redirectSpy.mockRestore();
});

const review = () => renderUi(<main><title>Checkout · ReadyPackets</title><CheckoutPage /></main>, { path: "/cart/checkout" });
const returned = (search = `?attempt=${attemptId}`) => renderUi(
  <main><title>Checkout status · ReadyPackets</title><CheckoutReturnPage /></main>, { path: `/checkout/return${search}` },
);
const cancelled = (search = `?attempt=${attemptId}`) => renderUi(
  <main><title>Checkout recovery · ReadyPackets</title><CheckoutCancelPage /></main>, { path: `/checkout/cancel${search}` },
);

pageA11y("/cart/checkout review", async () => {
  review();
  await screen.findByRole("heading", { name: "Required policies" });
  await userEvent.click(screen.getByText(/Synthetic checkout policy · Version 2/u));
});
pageA11y("/checkout/return pending confirmation", async () => {
  returned();
  await screen.findByText("Waiting for payment confirmation");
});
pageA11y("/checkout/return waived small total", async () => {
  mocks.status.mockResolvedValue({
    ...pending,
    confirmationState: "no_payment_due",
    paymentMode: "waived_small_total",
    attemptPublicId: null,
    attemptStatus: null,
    invoiceStatus: "paid",
    totalMinor: 40,
    waivedMinor: 40,
    balanceDueMinor: 0,
    canRestoreToCart: false,
  });
  returned(`?cart=${cartId}`);
  await screen.findByText("Order placed — remaining balance waived");
});
pageA11y("/checkout/cancel restore confirmation", async () => {
  cancelled();
  await userEvent.click(await screen.findByRole("button", { name: "Restore items to cart" }));
  await screen.findByRole("alertdialog", { name: "Cancel checkout and restore items?" });
});

it("places an invoice order with versioned policy evidence and profile link hint, and opens the status route", async () => {
  const user = userEvent.setup();
  const { location } = review();
  expect(await screen.findByText("Bundle savings")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "update name in profile" })).toHaveAttribute("href", "/account");
  await user.click(screen.getByRole("checkbox", { name: /I have read and agree/u }));
  await user.type(screen.getByRole("textbox", { name: /^Type your full name/u }), "Synthetic Customer");
  await user.click(screen.getByRole("button", { name: "Place order and receive invoice" }));
  await waitFor(() => expect(location.history?.at(-1)).toBe(`/checkout/return?cart=${cartId}`));
  expect(mocks.checkout.mock.calls[0]?.[0]).toEqual({
    cartPublicId: cartId, expectedVersion: 3, projectName: cart.projectName, note: "", billing: cart.billing,
    policyAcceptances: [{ versionPublicId: requiredPolicy.versionPublicId, contentHash: requiredPolicy.contentHash, signerName: "Synthetic Customer" }],
    idempotencyKey: expect.stringMatching(/^checkout:[a-f0-9-]{36}$/u),
  });
  expect(mocks.checkout).toHaveBeenCalledTimes(1);
}, 10_000);

it("handles D14 AGREEMENT_REQUIRED at checkout by opening AgreementDialog, accepting, and retrying checkout automatically", async () => {
  const user = userEvent.setup();
  mocks.cart.mockResolvedValue({ ...cart, pendingPolicies: [] });
  mocks.checkout
    .mockRejectedValueOnce(
      Object.assign(new Error("Please read and accept the agreement to continue."), {
        data: {
          safe: {
            domainCode: "CONFLICT",
            reasonCode: "AGREEMENT_REQUIRED",
            safeMessage: "Please read and accept the agreement to continue.",
            details: { policyPublicId: mndaDocId, signatureMode: "typed_name" },
          },
        },
      }),
    )
    .mockResolvedValueOnce(invoice);

  const { location } = review();
  await user.click(await screen.findByRole("button", { name: "Place order and receive invoice" }));

  // AgreementDialog opens for the required policy
  expect(
    await screen.findByRole("dialog", { name: "Review and accept Mutual Non-Disclosure Agreement" }),
  ).toBeInTheDocument();

  // The agreement controls unlock one animation frame after the dialog opens (end-of-text check).
  const agreementCheckbox = screen.getByRole("checkbox", {
    name: /I have read and agree to Mutual Non-Disclosure Agreement/i,
  });
  await waitFor(() => expect(agreementCheckbox).not.toBeDisabled());
  await user.click(agreementCheckbox);
  await user.type(
    screen.getByRole("textbox", { name: /Type your full name/i }),
    "Synthetic Customer",
  );
  await user.click(screen.getByRole("button", { name: "Accept and continue" }));

  await waitFor(() => {
    expect(mocks.policyAccept).toHaveBeenCalledTimes(1);
    expect(mocks.checkout).toHaveBeenCalledTimes(2);
    expect(location.history?.at(-1)).toBe(`/checkout/return?cart=${cartId}`);
  });
}, 10_000);

it("D14 live QA regression: renders inline typed-name field once (in both requiresTypedSignature worlds), shows SIGNER_NAME_MISMATCH next to the field, and falls back to AgreementDialog on stale/prior-checkbox views", async () => {
  const user = userEvent.setup();
  const qaMndaCheckboxPolicy: CartViewData["pendingPolicies"][number] = {
    documentPublicId: mndaDocId,
    slug: "qa-mutual-nda",
    title: "QA Mutual NDA",
    audience: "customer",
    requiresAcceptance: true,
    requiresTypedSignature: false,
    versionPublicId: mndaVersionId,
    versionNumber: 1,
    versionLabel: "1.0",
    contentFormat: "plain_text",
    bodyText: "Short QA Mutual NDA text that fits without scrolling.",
    contentHash: "b".repeat(64),
    changeSummary: null,
    effectiveAt: date,
    publishedAt: date,
  };

  mocks.policyMyStatus.mockResolvedValue({
    expectedSignerName: "Synthetic Customer",
    published: [
      {
        documentPublicId: mndaDocId,
        title: "QA Mutual NDA",
        versionPublicId: mndaVersionId,
        versionNumber: 1,
        versionLabel: "1.0",
        effectiveAt: date,
        contentFormat: "plain_text",
        bodyText: "Short QA Mutual NDA text that fits without scrolling.",
        contentHash: "b".repeat(64),
        requiresTypedSignature: true,
      },
    ],
    accepted: [],
  });

  // 1. Fresh checkout view (works identically whether `requiresTypedSignature` is false + `placeOrderAgreement`
  // or `requiresTypedSignature: true` from compliance): renders ONE inline typed-name field, shows
  // SIGNER_NAME_MISMATCH error right next to the field, and places the order in one step without opening AgreementDialog!
  mocks.cart.mockResolvedValue({
    ...cart,
    pendingPolicies: [qaMndaCheckboxPolicy],
    placeOrderAgreement: {
      required: true,
      met: false,
      policyPublicId: mndaDocId,
      signatureMode: "typed_name",
    },
  });
  mocks.checkout
    .mockRejectedValueOnce(
      Object.assign(new Error("The typed signature must match your account profile name."), {
        data: {
          safe: {
            domainCode: "VALIDATION",
            reasonCode: "SIGNER_NAME_MISMATCH",
            safeMessage: "The typed signature must match your account profile name.",
            details: { expectedName: "Synthetic Customer", profilePath: "/account" },
          },
        },
      }),
    )
    .mockResolvedValueOnce(invoice);

  const { location, unmount } = review();
  const inlineCheckbox = await screen.findByRole("checkbox", { name: /I have read and agree to QA Mutual NDA/i });
  const inlineSignerInput = screen.getByRole("textbox", { name: /Type your full name to sign QA Mutual NDA/i });

  await user.click(inlineCheckbox);
  await user.type(inlineSignerInput, "Wrong Person");
  await user.click(screen.getByRole("button", { name: "Place order and receive invoice" }));

  // Name-mismatch error is rendered directly next to the field (`aria-invalid="true"` + field error text)
  expect(
    await screen.findByText(
      "The typed signature must match your account profile name. Expected account name: Synthetic Customer.",
    ),
  ).toBeInTheDocument();
  expect(inlineSignerInput).toHaveAttribute("aria-invalid", "true");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  // Typing clears the field error; submitting the matching name completes in ONE step without asking twice!
  await user.clear(inlineSignerInput);
  await user.type(inlineSignerInput, "Synthetic Customer");
  expect(inlineSignerInput).not.toHaveAttribute("aria-invalid");
  await user.click(screen.getByRole("button", { name: "Place order and receive invoice" }));

  await waitFor(() => {
    expect(mocks.checkout).toHaveBeenCalledTimes(2);
    expect(mocks.policyAccept).not.toHaveBeenCalled();
    expect(location.history?.at(-1)).toBe(`/checkout/return?cart=${cartId}`);
  });
  expect(mocks.checkout.mock.calls[1]?.[0]?.policyAcceptances).toEqual([
    {
      versionPublicId: mndaVersionId,
      contentHash: "b".repeat(64),
      signerName: "Synthetic Customer",
    },
  ]);
  unmount();
}, 10_000);

it("D14 live QA regression: opens AgreementDialog when server raises AGREEMENT_REQUIRED on a stale checkbox-only view or prior checkbox acceptance, then completes checkout once signed", async () => {
  const user = userEvent.setup();
  const qaMndaCheckboxPolicy: CartViewData["pendingPolicies"][number] = {
    documentPublicId: mndaDocId,
    slug: "qa-mutual-nda",
    title: "QA Mutual NDA",
    audience: "customer",
    requiresAcceptance: true,
    requiresTypedSignature: false,
    versionPublicId: mndaVersionId,
    versionNumber: 1,
    versionLabel: "1.0",
    contentFormat: "plain_text",
    bodyText: "Short QA Mutual NDA text that fits without scrolling.",
    contentHash: "b".repeat(64),
    changeSummary: null,
    effectiveAt: date,
    publishedAt: date,
  };
  mocks.policyMyStatus.mockResolvedValue({
    expectedSignerName: "Synthetic Customer",
    published: [
      {
        documentPublicId: mndaDocId,
        title: "QA Mutual NDA",
        versionPublicId: mndaVersionId,
        versionNumber: 1,
        versionLabel: "1.0",
        effectiveAt: date,
        contentFormat: "plain_text",
        bodyText: "Short QA Mutual NDA text that fits without scrolling.",
        contentHash: "b".repeat(64),
        requiresTypedSignature: false,
      },
    ],
    accepted: [],
  });
  mocks.cart.mockResolvedValue({
    ...cart,
    pendingPolicies: [qaMndaCheckboxPolicy],
  });
  mocks.checkout
    .mockRejectedValueOnce(
      Object.assign(new Error("Please read and accept the agreement to continue."), {
        data: {
          safe: {
            domainCode: "CONFLICT",
            reasonCode: "AGREEMENT_REQUIRED",
            safeMessage: "Please read and accept the agreement to continue.",
            details: { policyPublicId: mndaDocId, signatureMode: "typed_name" },
          },
        },
      }),
    )
    .mockResolvedValueOnce(invoice);

  const staleRender = review();
  await user.click(await screen.findByRole("checkbox", { name: /I have read and agree to QA Mutual NDA/i }));
  await user.click(screen.getByRole("button", { name: "Place order and receive invoice" }));

  const dialog = await screen.findByRole("dialog", { name: "Review and accept QA Mutual NDA" });
  const dialogCheckbox = within(dialog).getByRole("checkbox", { name: /I have read and agree to QA Mutual NDA/i });
  await waitFor(() => expect(dialogCheckbox).not.toBeDisabled());
  await user.click(dialogCheckbox);
  await user.type(within(dialog).getByRole("textbox", { name: /Type your full name/i }), "Synthetic Customer");
  await user.click(within(dialog).getByRole("button", { name: "Accept and continue" }));

  await waitFor(() => {
    expect(mocks.policyAccept).toHaveBeenCalledTimes(1);
    expect(mocks.checkout).toHaveBeenCalledTimes(2);
    expect(staleRender.location.history?.at(-1)).toBe(`/checkout/return?cart=${cartId}`);
  });
  expect(mocks.checkout.mock.calls[1]?.[0]?.policyAcceptances).toEqual([]);
}, 10_000);

it("renders D5 small-total waive and block callouts and shows waived amount on CheckoutReturnPage", async () => {
  mocks.cart.mockResolvedValue({
    ...cart,
    pendingPolicies: [],
    onlinePaymentEnabled: true,
    paymentProvider: "stripe",
    totals: {
      ...cart.totals,
      totalMinor: 40,
    },
    smallTotalEvaluation: {
      belowMinimum: true,
      minimumMinor: 50,
      smallTotalAction: "waive",
    },
  });
  review();
  expect(await screen.findByText("Remaining balance will be waived")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Place order" })).toBeInTheDocument();

  mocks.status.mockResolvedValue({
    ...pending,
    confirmationState: "no_payment_due",
    paymentMode: "waived_small_total",
    attemptPublicId: null,
    attemptStatus: null,
    invoiceStatus: "paid",
    totalMinor: 40,
    waivedMinor: 40,
    balanceDueMinor: 0,
    canRestoreToCart: false,
  });
  returned(`?cart=${cartId}`);
  expect(await screen.findByText("Order placed — remaining balance waived")).toBeInTheDocument();
  expect(screen.getByText("Amount waived")).toBeInTheDocument();
});

it("polls read-only until the server confirms payment, and does not perform a write on return", async () => {
  mocks.status.mockResolvedValueOnce(pending).mockResolvedValue({
    ...pending, confirmationState: "paid", attemptStatus: "paid", invoiceStatus: "paid", balanceDueMinor: 0, canRestoreToCart: false,
  });
  returned();
  expect(await screen.findByText("Waiting for payment confirmation")).toBeInTheDocument();
  expect(await screen.findByText("Payment confirmed", {}, { timeout: 4500 })).toBeInTheDocument();
  expect(mocks.status).toHaveBeenNthCalledWith(1, { attemptPublicId: attemptId });
  expect(mocks.status).toHaveBeenNthCalledWith(2, { attemptPublicId: attemptId });
  expect(mocks.restore).not.toHaveBeenCalled();
}, 10_000);

it("shows invoice instructions without implying payment and links to the invoice", async () => {
  mocks.status.mockResolvedValue({ ...pending, confirmationState: "invoice_issued", paymentMode: "invoice", canRestoreToCart: false });
  returned(`?cart=${cartId}`);
  expect(await screen.findByText("Order placed and invoice issued")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View invoice" })).toHaveAttribute("href", `/invoices/${invoiceId}`);
  expect(screen.queryByText("Payment confirmed")).not.toBeInTheDocument();
});

it("never restores on return or on opening confirmation; restores once after explicit consent", async () => {
  const user = userEvent.setup();
  cancelled();
  const restore = await screen.findByRole("button", { name: "Restore items to cart" });
  expect(mocks.restore).not.toHaveBeenCalled();
  await user.click(restore);
  expect(mocks.restore).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Restore items" }));
  expect(await screen.findByRole("link", { name: "Open restored cart" })).toHaveAttribute("href", "/cart");
  expect(mocks.restore).toHaveBeenCalledExactlyOnceWith({ attemptPublicId: attemptId });
});

const asRole = (role: MeUser["role"]) => ({
  api: fakeAuthApi({
    me: async (): Promise<MeResult> => ({
      user: { publicId: `u_${role}`, role, name: "Synthetic Viewer", email: `${role}@example.test`, status: "active" },
      state: "full",
      pendingSteps: [],
      nextStep: null,
    }),
  }),
});

pageA11y("/cart/checkout staff handoff", async () => {
  renderUi(<main><title>Checkout · ReadyPackets</title><CheckoutPage /></main>, { path: "/cart/checkout", ...asRole("admin") });
  await screen.findByRole("heading", { level: 1, name: "Checkout belongs to customer accounts" });
});

it("renders StaffOrderHandoff on /cart/checkout, /checkout/return, and /checkout/cancel for staff and admin without calling cart procedures", async () => {
  for (const [role, portalLabel] of [["admin", "Admin portal"], ["staff", "Staff portal"]] as const) {
    mocks.cart.mockClear();
    mocks.status.mockClear();
    mocks.restore.mockClear();
    mocks.checkout.mockClear();

    const checkoutView = renderUi(<CheckoutPage />, { path: "/cart/checkout", ...asRole(role) });
    expect(await screen.findByRole("heading", { level: 1, name: "Checkout belongs to customer accounts" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New order for a customer" })).toHaveAttribute("href", "/admin/orders?new=1");
    expect(screen.getByRole("link", { name: portalLabel })).toHaveAttribute("href", "/admin");
    checkoutView.unmount();

    const returnView = renderUi(<CheckoutReturnPage />, { path: `/checkout/return?attempt=${attemptId}`, ...asRole(role) });
    expect(await screen.findByRole("heading", { level: 1, name: "Checkout belongs to customer accounts" })).toBeInTheDocument();
    returnView.unmount();

    const cancelView = renderUi(<CheckoutCancelPage />, { path: `/checkout/cancel?attempt=${attemptId}`, ...asRole(role) });
    expect(await screen.findByRole("heading", { level: 1, name: "Checkout belongs to customer accounts" })).toBeInTheDocument();
    cancelView.unmount();

    expect(mocks.cart).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
  }
});

it("never offers to restore a paid checkout and rejects ambiguous references or untrusted redirects", async () => {
  mocks.status.mockResolvedValue({ ...pending, confirmationState: "paid", invoiceStatus: "paid", canRestoreToCart: false });
  cancelled();
  await screen.findByText("Payment confirmed");
  expect(screen.queryByRole("button", { name: "Restore items to cart" })).not.toBeInTheDocument();
  expect(readCheckoutTarget(`attempt=${attemptId}&cart=${cartId}`)).toBeNull();
  expect(readCheckoutTarget(`attempt=${attemptId}&attempt=${attemptId}`)).toBeNull();
  expect(isHostedCheckoutUrl("https://checkout.stripe.com/c/pay/session#token", "stripe", "test")).toBe(true);
  expect(isHostedCheckoutUrl("https://checkout.stripe.com/pay/cs_live_synthetic", "stripe", "live")).toBe(true);
  expect(isHostedCheckoutUrl("https://checkout.stripe.com/", "stripe", "live")).toBe(false);
  expect(isHostedCheckoutUrl("http://checkout.stripe.com/pay/cs_live_synthetic", "stripe", "live")).toBe(false);
  expect(isHostedCheckoutUrl("https://user:pass@checkout.stripe.com/pay/cs_live_synthetic", "stripe", "live")).toBe(false);
  expect(isHostedCheckoutUrl("https://checkout.stripe.com:8443/pay/cs_live_synthetic", "stripe", "live")).toBe(false);
  expect(isHostedCheckoutUrl("https://checkout.stripe.com.untrusted.test/c/pay/session", "stripe", "live")).toBe(false);
  expect(isHostedCheckoutUrl("https://square.link/u/session", "square", "test")).toBe(false);
  expect(isHostedCheckoutUrl("https://sandbox.square.link/u/session", "square", "test")).toBe(true);
});

pageA11y("/cart/checkout placed-order payment handoff", async () => {
  const user = userEvent.setup();
  mocks.cart.mockResolvedValue({
    ...cart,
    pendingPolicies: [],
    onlinePaymentEnabled: true,
    paymentProvider: "stripe",
    paymentEnvironment: "live",
  });
  mocks.checkout.mockResolvedValue({
    mode: "payment_unavailable",
    cartPublicId: cartId,
    orderPublicId: orderId,
    orderReference: "RP-SYNTHETIC",
    invoicePublicId: invoiceId,
    invoiceNumber: "INV-SYNTHETIC",
    currency: "USD",
    totalMinor: 1540,
    onlinePaymentAvailable: true,
    reasonCode: "STRIPE_UPSTREAM_5XX",
    failureClass: "provider_transient",
    safeMessage: "The payment provider could not open a checkout session right now.",
  });
  review();
  await user.click(await screen.findByRole("button", { name: "Place order and continue to payment" }));
  await screen.findByText("Your order RP-SYNTHETIC is placed, but we could not open the secure payment page");
});

pageA11y("/checkout/return awaiting payment with Pay now", async () => {
  mocks.status.mockResolvedValue({
    ...pending,
    confirmationState: "awaiting_payment",
    attemptPublicId: null,
    attemptStatus: null,
    attemptInFlight: false,
    onlinePaymentAvailable: true,
  });
  returned(`?cart=${cartId}`);
  await screen.findByText("Payment not completed yet — your order is placed and waiting for payment");
});

it("Fix pack 07.2: redirects valid live Stripe URLs (including /pay/...) and NEVER falls through silently on rejected redirect URLs", async () => {
  const user = userEvent.setup();
  mocks.cart.mockResolvedValue({
    ...cart,
    pendingPolicies: [],
    onlinePaymentEnabled: true,
    paymentProvider: "stripe",
    paymentEnvironment: "live",
  });

  // 1. Valid Stripe live URL (`/pay/cs_live_...`, not `/c/pay/...`) redirects directly to Stripe
  mocks.checkout.mockResolvedValueOnce({
    mode: "redirect",
    cartPublicId: cartId,
    attemptPublicId: attemptId,
    provider: "stripe",
    environment: "live",
    redirectUrl: "https://checkout.stripe.com/pay/cs_live_synthetic",
    expiresAt: new Date("2026-11-21T12:30:00Z"),
    orderPublicId: orderId,
    orderReference: "RP-SYNTHETIC",
    invoicePublicId: invoiceId,
    invoiceNumber: "INV-SYNTHETIC",
    currency: "USD",
    totalMinor: 1540,
  });

  const okRender = review();
  await user.click(await screen.findByRole("button", { name: "Place order and continue to payment" }));
  await waitFor(() => {
    expect(redirectSpy).toHaveBeenCalledWith("https://checkout.stripe.com/pay/cs_live_synthetic");
  });
  expect(okRender.location.history?.at(-1)).toBe("/cart/checkout");
  okRender.unmount();

  // 2. Rejected redirect URL NEVER falls through to `/checkout/return?cart=...`; focuses explicit placed-order alert with Pay now + View invoice
  redirectSpy.mockClear();
  mocks.checkout.mockResolvedValueOnce({
    mode: "redirect",
    cartPublicId: cartId,
    attemptPublicId: attemptId,
    provider: "stripe",
    environment: "live",
    redirectUrl: "https://untrusted.example.test/pay/cs_live_synthetic",
    expiresAt: new Date("2026-11-21T12:30:00Z"),
    orderPublicId: orderId,
    orderReference: "RP-SYNTHETIC",
    invoicePublicId: invoiceId,
    invoiceNumber: "INV-SYNTHETIC",
    currency: "USD",
    totalMinor: 1540,
  });

  const rejectedRender = review();
  await user.click(await screen.findByRole("button", { name: "Place order and continue to payment" }));

  const alertHeading = await screen.findByText(
    "Your order RP-SYNTHETIC is placed, but we could not open the secure payment page",
  );
  expect(alertHeading).toBeInTheDocument();
  expect(redirectSpy).not.toHaveBeenCalled();
  expect(rejectedRender.location.history?.at(-1)).toBe("/cart/checkout");
  expect(document.activeElement).toContainElement(alertHeading);
  expect(screen.queryByRole("button", { name: /Place order/i })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View invoice" })).toHaveAttribute("href", `/invoices/${invoiceId}`);

  // Clicking "Pay now" starts invoice checkout and redirects to the verified Stripe session
  await user.click(screen.getByRole("button", { name: "Pay now" }));
  await waitFor(() => {
    expect(mocks.startInvoiceCheckout).toHaveBeenCalledWith({
      invoicePublicId: invoiceId,
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
    });
    expect(redirectSpy).toHaveBeenCalledWith("https://checkout.stripe.com/pay/cs_live_synthetic_retry");
  });
});

it("Fix pack 07.2: handles post-commit provider failure (payment_unavailable) with focus-managed placed-order handoff and never invites cart resubmission", async () => {
  const user = userEvent.setup();
  mocks.cart.mockResolvedValueOnce({
    ...cart,
    pendingPolicies: [],
    onlinePaymentEnabled: true,
    paymentProvider: "stripe",
    paymentEnvironment: "live",
  }).mockResolvedValue({
    ...cart,
    cartPublicId: null,
    itemCount: 0,
    items: [],
  });
  mocks.checkout.mockResolvedValueOnce({
    mode: "payment_unavailable",
    cartPublicId: cartId,
    orderPublicId: orderId,
    orderReference: "RP-SYNTHETIC-LIVE",
    invoicePublicId: invoiceId,
    invoiceNumber: "INV-SYNTHETIC-LIVE",
    currency: "USD",
    totalMinor: 120,
    onlinePaymentAvailable: true,
    reasonCode: "STRIPE_UPSTREAM_5XX",
    failureClass: "provider_transient",
    safeMessage: "The payment provider could not open a checkout session right now.",
  });

  review();
  await user.click(await screen.findByRole("button", { name: "Place order and continue to payment" }));

  const alertHeading = await screen.findByText(
    "Your order RP-SYNTHETIC-LIVE is placed, but we could not open the secure payment page",
  );
  expect(document.activeElement).toContainElement(alertHeading);
  expect(screen.queryByText("Review your cart before checking out")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Place order/i })).not.toBeInTheDocument();
  expect(screen.getByText(/do not submit this cart again/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View invoice" })).toHaveAttribute("href", `/invoices/${invoiceId}`);
  expect(screen.getByRole("link", { name: "View order" })).toHaveAttribute("href", `/orders/${orderId}`);

  // If clicking "Pay now" fails first, the danger callout "Could not open online payment" is shown and focused; retry succeeds
  mocks.startInvoiceCheckout
    .mockRejectedValueOnce(new Error("Online payment temporarily unavailable."))
    .mockResolvedValueOnce({
      mode: "redirect",
      attemptPublicId: id(9),
      invoicePublicId: invoiceId,
      provider: "stripe",
      environment: "live",
      redirectUrl: "https://checkout.stripe.com/pay/cs_live_synthetic_retry",
      expiresAt: new Date("2026-11-21T12:30:00Z"),
    });

  await user.click(screen.getByRole("button", { name: "Pay now" }));
  expect(await screen.findByText("Could not open online payment")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Pay now" }));
  await waitFor(() => {
    expect(mocks.startInvoiceCheckout).toHaveBeenCalledTimes(2);
    expect(redirectSpy).toHaveBeenCalledWith("https://checkout.stripe.com/pay/cs_live_synthetic_retry");
  });
});

pageA11y("/cart/checkout placed-order handoff when online payment unavailable", async () => {
  const user = userEvent.setup();
  mocks.cart.mockResolvedValue({
    ...cart,
    pendingPolicies: [],
    onlinePaymentEnabled: true,
    paymentProvider: "stripe",
    paymentEnvironment: "live",
  });
  mocks.checkout.mockResolvedValue({
    mode: "payment_unavailable",
    cartPublicId: cartId,
    orderPublicId: orderId,
    orderReference: "RP-SYNTHETIC-STALE",
    invoicePublicId: invoiceId,
    invoiceNumber: "INV-SYNTHETIC-STALE",
    currency: "USD",
    totalMinor: 120,
    onlinePaymentAvailable: false,
    reasonCode: "PROVIDER_VERIFICATION_STALE",
    failureClass: "configuration",
    safeMessage: "Online card payment is temporarily unavailable while payment settings are being updated. Your order and invoice are ready.",
  });
  review();
  await user.click(await screen.findByRole("button", { name: "Place order and continue to payment" }));
  await screen.findByText("Your order RP-SYNTHETIC-STALE is placed, but we could not open the secure payment page");
});

it("Fix pack 07.2: hides Pay now on /cart/checkout handoff when onlinePaymentAvailable is false (making View invoice primary with invoice instructions), while still showing Pay now when onlinePaymentAvailable is undefined", async () => {
  const user = userEvent.setup();
  const onlineCart = {
    ...cart,
    pendingPolicies: [],
    onlinePaymentEnabled: true,
    paymentProvider: "stripe" as const,
    paymentEnvironment: "live" as const,
  };

  // 1. `onlinePaymentAvailable === false` (e.g. PROVIDER_VERIFICATION_STALE): hides Pay now, makes View invoice primary, shows invoice instructions
  mocks.cart.mockResolvedValueOnce(onlineCart);
  mocks.checkout.mockResolvedValueOnce({
    mode: "payment_unavailable",
    cartPublicId: cartId,
    orderPublicId: orderId,
    orderReference: "RP-SYNTHETIC-STALE",
    invoicePublicId: invoiceId,
    invoiceNumber: "INV-SYNTHETIC-STALE",
    currency: "USD",
    totalMinor: 120,
    onlinePaymentAvailable: false,
    reasonCode: "PROVIDER_VERIFICATION_STALE",
    failureClass: "configuration",
    safeMessage: "Online card payment is temporarily unavailable while payment settings are being updated. Your order and invoice are ready.",
  });

  const staleView = review();
  await user.click(await screen.findByRole("button", { name: "Place order and continue to payment" }));
  expect(
    await screen.findByText("Your order RP-SYNTHETIC-STALE is placed, but we could not open the secure payment page"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Pay now" })).not.toBeInTheDocument();
  expect(screen.getByText(/Open your invoice for the balance due and payment instructions/i)).toBeInTheDocument();
  const viewInvoiceLink = screen.getByRole("link", { name: "View invoice" });
  expect(viewInvoiceLink).toHaveAttribute("href", `/invoices/${invoiceId}`);
  expect(viewInvoiceLink.className).toContain("bg-action");
  staleView.unmount();

  // 2. Older server payload where `onlinePaymentAvailable` is omitted/undefined still shows primary "Pay now"
  mocks.cart.mockResolvedValueOnce(onlineCart);
  mocks.checkout.mockResolvedValueOnce({
    mode: "payment_unavailable",
    cartPublicId: cartId,
    orderPublicId: orderId,
    orderReference: "RP-SYNTHETIC-COMPAT",
    invoicePublicId: invoiceId,
    invoiceNumber: "INV-SYNTHETIC-COMPAT",
    currency: "USD",
    totalMinor: 120,
    reasonCode: "STRIPE_UPSTREAM_5XX",
    failureClass: "provider_transient",
    safeMessage: "We could not open the secure payment page right now.",
  } as unknown as CheckoutCartResult);

  const compatView = review();
  await user.click(await screen.findByRole("button", { name: "Place order and continue to payment" }));
  expect(
    await screen.findByText("Your order RP-SYNTHETIC-COMPAT is placed, but we could not open the secure payment page"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pay now" })).toBeInTheDocument();
  compatView.unmount();
});

it("Fix pack 07.2: distinguishes waiting-for-provider (?attempt= redirected) from awaiting_payment (?cart= / failed / no attempt) with Pay now, in-flight warning, and offline instructions fallback", async () => {
  const user = userEvent.setup();

  // 1. `/checkout/return?cart=...` with unpaid order & online payment available -> "Payment not completed yet..." + primary "Pay now"
  mocks.status.mockResolvedValueOnce({
    ...pending,
    confirmationState: "awaiting_payment",
    provider: "stripe",
    attemptPublicId: null,
    attemptStatus: null,
    attemptInFlight: false,
    onlinePaymentAvailable: true,
    totalMinor: 120,
    balanceDueMinor: 120,
  });
  const returnCartView = returned(`?cart=${cartId}`);
  expect(
    await screen.findByText("Payment not completed yet — your order is placed and waiting for payment"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Waiting for payment confirmation")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Pay now" }));
  await waitFor(() => {
    expect(mocks.startInvoiceCheckout).toHaveBeenCalledWith({
      invoicePublicId: invoiceId,
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
    });
    expect(redirectSpy).toHaveBeenCalledWith("https://checkout.stripe.com/pay/cs_live_synthetic_retry");
  });
  returnCartView.unmount();

  // 2. Duplicate-payment warning is shown when an earlier attempt is genuinely in flight (`attemptInFlight: true`)
  mocks.status.mockResolvedValueOnce({
    ...pending,
    confirmationState: "awaiting_payment",
    provider: "stripe",
    attemptStatus: "redirected",
    attemptInFlight: true,
    onlinePaymentAvailable: true,
  });
  const inFlightView = returned(`?cart=${cartId}`);
  expect(
    await screen.findByText("Payment not completed yet — your order is placed and waiting for payment"),
  ).toBeInTheDocument();
  expect(screen.getByText(/avoid submitting a duplicate payment/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check payment status" })).toBeInTheDocument();
  inFlightView.unmount();

  // 3. `/checkout/cancel?cart=...` when online payment is NOT available -> shows invoice payment instructions without "Pay now"
  mocks.status.mockResolvedValueOnce({
    ...pending,
    confirmationState: "awaiting_payment",
    provider: "stripe",
    attemptPublicId: null,
    attemptStatus: null,
    attemptInFlight: false,
    onlinePaymentAvailable: false,
    onlinePaymentUnavailableReason: "provider_misconfigured",
  });
  const offlineCancelView = cancelled(`?cart=${cartId}`);
  expect(
    await screen.findByText("Payment not completed yet — your order is placed and waiting for payment"),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Open your invoice for the balance due and payment instructions/i),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Pay now" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View invoice" })).toHaveAttribute("href", `/invoices/${invoiceId}`);
  offlineCancelView.unmount();
});
