import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { CheckoutCartResult } from "@server/modules/cart/types";
import type * as transport from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import { CheckoutPage, isHostedCheckoutUrl } from "./CheckoutPage";
import { CheckoutReturnPage, readCheckoutTarget, type CheckoutStatus } from "./CheckoutReturnPage";
import { CheckoutCancelPage } from "./CheckoutCancelPage";
import type { CartViewData } from "./CartPage";

const mocks = vi.hoisted(() => ({
  cart: vi.fn(),
  checkout: vi.fn(),
  status: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("@/lib/trpc", async (original) => ({
  ...await original<typeof transport>(),
  useTRPC: () => ({ cart: {
    get: { queryKey: () => ["cart"], queryOptions: () => ({ queryKey: ["cart"], queryFn: mocks.cart }) },
    badgeCount: { queryKey: () => ["badge"] },
    checkoutStatus: { queryOptions: (input: unknown, options: object) => ({
      ...options, queryKey: ["checkout", input], queryFn: () => mocks.status(input),
    }) },
    restoreCheckout: { mutationOptions: () => ({ mutationFn: (input: unknown) => mocks.restore(input) }) },
  } }),
  useTRPCClient: () => ({ cart: { checkout: { mutate: mocks.checkout } } }),
}));

const id = (end: number) => `01J${"0".repeat(22)}${end}`;
const [cartId, attemptId, orderId, invoiceId] = [id(1), id(2), id(3), id(4)];
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
  totals: { currency: "USD", subtotalMinor: 1600, discountMinor: 200, discountLabel: "Bundle savings", subtotalAfterDiscountMinor: 1400,
    taxRateBps: 1000, taxMinor: 140, totalMinor: 1540, bundle: null },
  pendingPolicies: [requiredPolicy], updatedAt: date,
};
const pending: CheckoutStatus = {
  cartPublicId: cartId, confirmationState: "pending_confirmation", paymentMode: "redirect", provider: "square",
  attemptPublicId: attemptId, attemptStatus: "redirected", failureReasonCode: null, orderPublicId: orderId,
  orderReference: "RP-SYNTHETIC", invoicePublicId: invoiceId, invoiceNumber: "INV-SYNTHETIC",
  invoiceStatus: "issued", currency: "USD", subtotalMinor: 1600, discountMinor: 200, discountLabel: "Bundle savings",
  taxRateBps: 1000, taxMinor: 140, totalMinor: 1540, balanceDueMinor: 1540, canRestoreToCart: true, alreadyRestored: false,
  checkedOutAt: date,
};
const invoice: CheckoutCartResult = {
  mode: "invoice", cartPublicId: cartId, orderPublicId: orderId, orderReference: "RP-SYNTHETIC", invoicePublicId: invoiceId,
  invoiceNumber: "INV-SYNTHETIC", currency: "USD", totalMinor: 1540,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.cart.mockResolvedValue(cart);
  mocks.checkout.mockResolvedValue(invoice);
  mocks.status.mockResolvedValue(pending);
  mocks.restore.mockImplementation(async () => {
    mocks.status.mockResolvedValue({ ...pending, confirmationState: "cancelled", canRestoreToCart: false, alreadyRestored: true });
    return { restored: true, alreadyRestored: false, cart };
  });
});

const review = () => renderUi(<main><title>Checkout · ReadyPackets</title><CheckoutPage /></main>, { path: "/cart/checkout" });
const returned = (search = `?attempt=${attemptId}`) => renderUi(
  <main><title>Checkout status · ReadyPackets</title><CheckoutReturnPage /></main>, { path: `/checkout/return${search}` },
);
const cancelled = () => renderUi(
  <main><title>Checkout recovery · ReadyPackets</title><CheckoutCancelPage /></main>, { path: `/checkout/cancel?attempt=${attemptId}` },
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
pageA11y("/checkout/cancel restore confirmation", async () => {
  cancelled();
  await userEvent.click(await screen.findByRole("button", { name: "Restore items to cart" }));
  await screen.findByRole("alertdialog", { name: "Cancel checkout and restore items?" });
});

it("places an invoice order with versioned policy evidence but no client totals and opens the status route", async () => {
  const user = userEvent.setup();
  const { location } = review();
  expect(await screen.findByText("Bundle savings")).toBeInTheDocument();
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

it("never offers to restore a paid checkout and rejects ambiguous references or untrusted redirects", async () => {
  mocks.status.mockResolvedValue({ ...pending, confirmationState: "paid", invoiceStatus: "paid", canRestoreToCart: false });
  cancelled();
  await screen.findByText("Payment confirmed");
  expect(screen.queryByRole("button", { name: "Restore items to cart" })).not.toBeInTheDocument();
  expect(readCheckoutTarget(`attempt=${attemptId}&cart=${cartId}`)).toBeNull();
  expect(readCheckoutTarget(`attempt=${attemptId}&attempt=${attemptId}`)).toBeNull();
  expect(isHostedCheckoutUrl("https://checkout.stripe.com/c/pay/session#token", "stripe", "test")).toBe(true);
  expect(isHostedCheckoutUrl("https://checkout.stripe.com.untrusted.test/c/pay/session", "stripe", "live")).toBe(false);
  expect(isHostedCheckoutUrl("https://square.link/u/session", "square", "test")).toBe(false);
  expect(isHostedCheckoutUrl("https://sandbox.square.link/u/session", "square", "test")).toBe(true);
});
