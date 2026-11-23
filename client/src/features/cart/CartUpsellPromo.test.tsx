import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Switch } from "wouter";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import { CartPage, type CartViewData } from "./CartPage";
import { CheckoutPage } from "./CheckoutPage";
import { CheckoutReturnPage, type CheckoutStatus } from "./CheckoutReturnPage";

const { handlers, calls } = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => unknown>(),
  calls: [] as { path: string; input: unknown }[],
}));

function makeTrpcProxy(path: string[]): unknown {
  const key = path.join(".");
  const run = async (input: unknown) => {
    calls.push({ path: key, input });
    const handler = handlers.get(key);
    if (!handler) throw new Error(`no handler for ${key}`);
    return handler(input);
  };
  const api = {
    queryOptions: (input: unknown, opts: Record<string, unknown> = {}) => ({
      queryKey: [key, input],
      queryFn: () => run(input),
      ...opts,
    }),
    mutationOptions: (opts: Record<string, unknown> = {}) => ({ mutationFn: run, ...opts }),
    queryKey: (input?: unknown) => [key, input],
    pathKey: () => [key],
    mutate: run,
    query: run,
  };
  return new Proxy(api, {
    get: (target, prop: string) =>
      prop in target ? target[prop as keyof typeof target] : makeTrpcProxy([...path, prop]),
  });
}

vi.mock("@/lib/trpc", async (original) => ({
  ...(await original<typeof trpcModule>()),
  useTRPC: () => makeTrpcProxy([]),
  useTRPCClient: () => makeTrpcProxy([]),
}));

function makeSafeTrpcError(domainCode: string, reasonCode: string, safeMessage: string) {
  return Object.assign(new Error(safeMessage), {
    data: {
      safe: {
        domainCode,
        reasonCode,
        safeMessage,
        correlationId: "corr_test_01",
      },
    },
  });
}

const sampleUpsells: CartViewData["upsells"] = [
  {
    offerPublicId: "01JQAUPSELL000000000000001",
    kind: "add_on",
    title: "Add priority onboarding",
    shortText: "Dedicated 60-minute onboarding walkthrough with a specialist.",
    currency: "USD",
    priceMinor: 15000,
    fullTargetPriceMinor: 15000,
    savingMinor: null,
    targetProducts: [
      {
        productPublicId: "01JQAPROD00000000000000010",
        name: "Priority onboarding session",
        groupName: "Add-ons",
        packetNumber: null,
        tier: null,
        unitPriceMinor: 15000,
        currency: "USD",
      },
    ],
    currentProduct: null,
  },
  {
    offerPublicId: "01JQAUPSELL000000000000002",
    kind: "tier_upgrade",
    title: "Step up to Premium tier",
    shortText: "Includes board-ready executive summary and custom mapping.",
    currency: "USD",
    priceMinor: 20000,
    fullTargetPriceMinor: 45000,
    savingMinor: null,
    targetProducts: [
      {
        productPublicId: "01JQAPROD00000000000000020",
        name: "Packet 01 - Premium",
        groupName: "Packet 01",
        packetNumber: 1,
        tier: "Premium",
        unitPriceMinor: 45000,
        currency: "USD",
      },
    ],
    currentProduct: {
      productPublicId: "01JQAPROD00000000000000001",
      name: "Packet 01 - Basic",
      packetNumber: 1,
      tier: "Basic",
      unitPriceMinor: 25000,
    },
  },
];

function makeCart(overrides: Partial<CartViewData> = {}): CartViewData {
  return {
    cartPublicId: "01JQACART00000000000000001",
    version: 4,
    status: "open",
    itemCount: 1,
    projectName: "Synthetic Governance Rollout",
    note: "",
    billing: {
      fullName: "Synthetic Buyer",
      company: "Synthetic Org",
      email: "buyer@example.test",
      country: "US",
      region: "NY",
      addressLine1: "100 Synthetic Plaza",
      addressLine2: "",
      city: "New York",
      postalCode: "10001",
      taxId: "",
    },
    items: [
      {
        itemPublicId: "01JQAITEM00000000000000001",
        productPublicId: "01JQAPROD00000000000000001",
        packetNumber: 1,
        groupName: "Packet 01",
        tier: "Basic",
        tierOptions: [],
        name: "Packet 01 - Basic",
        description: "Baseline governance packet",
        outcome: "Ready to adopt",
        timeline: "3 business days",
        quantity: 1,
        unitPriceMinor: 25000,
        lineTotalMinor: 25000,
        currency: "USD",
        available: true,
      },
    ],
    hasUnavailableItems: false,
    mixedCurrency: false,
    totals: {
      currency: "USD",
      subtotalMinor: 25000,
      discountMinor: 0,
      discountLabel: null,
      subtotalAfterDiscountMinor: 25000,
      taxRateBps: 0,
      taxMinor: 0,
      totalMinor: 25000,
      bundle: null,
      promo: null,
    },
    promotionsEnabled: true,
    promoNotice: null,
    upsells: sampleUpsells,
    smallTotalEvaluation: null,
    paymentProvider: "none",
    paymentEnvironment: "test",
    onlinePaymentEnabled: false,
    pendingPolicies: [],
    updatedAt: new Date("2026-11-22T12:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  handlers.set("orders.catalog.list", () => []);
  handlers.set("cart.badgeCount", () => ({ enabled: true, itemCount: 1 }));
  handlers.set("platform.bootstrap", () => ({
    features: { cart: true },
    consent: { enabled: false, policyVersion: 1, renewMonths: 12 },
  }));
});

describe("Cart upsells & promo codes (Increment 05 Package B)", () => {
  it("exposes WCAG 2.5.3 Label-in-Name accessible button labels and accepts/dismisses with deterministic focus", async () => {
    let current = makeCart();
    handlers.set("cart.get", () => current);
    handlers.set("cart.upsell.accept", (raw) => {
      const input = raw as { offerPublicId: string };
      current = makeCart({
        version: current.version + 1,
        upsells: current.upsells.filter((u) => u.offerPublicId !== input.offerPublicId),
      });
      return current;
    });
    handlers.set("cart.upsell.dismiss", (raw) => {
      const input = raw as { offerPublicId: string };
      current = makeCart({
        version: current.version + 1,
        upsells: current.upsells.filter((u) => u.offerPublicId !== input.offerPublicId),
      });
      return current;
    });

    const user = userEvent.setup();
    renderUi(<CartPage />, { path: "/cart" });

    const addBtn = await screen.findByRole("button", {
      name: "Add to cart: Priority onboarding session for $150.00",
    });
    const upgradeBtn = screen.getByRole("button", {
      name: "Upgrade: Packet 01 - Premium for +$200.00",
    });
    expect(addBtn).toHaveTextContent("Add to cart");
    expect(upgradeBtn).toHaveTextContent("Upgrade");

    await user.click(addBtn);
    await waitFor(() => {
      expect(calls.some((c) => c.path === "cart.upsell.accept")).toBe(true);
    });
    // Focus moves deterministically to the remaining suggestion's primary action button
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Upgrade: Packet 01 - Premium for +$200.00" }),
      ).toHaveFocus();
    });

    // Dismiss the final suggestion -> focus lands on #cart-summary-focus
    const dismissRemaining = screen.getByRole("button", {
      name: "Dismiss: Step up to Premium tier",
    });
    await user.click(dismissRemaining);
    await waitFor(() => {
      expect(document.getElementById("cart-summary-focus")).toHaveFocus();
    });
  });

  it("does not steal focus if the user moves focus elsewhere during a slow mutation, and restores focus on failure", async () => {
    let resolveDismiss: ((val: CartViewData) => void) | undefined;
    let current = makeCart();
    handlers.set("cart.get", () => current);
    handlers.set("cart.upsell.dismiss", () => {
      return new Promise<CartViewData>((resolve) => {
        resolveDismiss = resolve;
      });
    });
    handlers.set("cart.upsell.accept", () => {
      throw makeSafeTrpcError("CONFLICT", "UPSELL_NOT_ELIGIBLE", "That suggestion is no longer available.");
    });

    const user = userEvent.setup();
    renderUi(<CartPage />, { path: "/cart" });

    const addBtn = await screen.findByRole("button", {
      name: "Add to cart: Priority onboarding session for $150.00",
    });
    // Failure restores focus to the trigger after disabled clears
    await user.click(addBtn);
    expect(await screen.findByText("That suggestion is no longer available.")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Add to cart: Priority onboarding session for $150.00" }),
      ).toHaveFocus();
    });

    // Delayed dismiss: user moves focus to Continue to checkout link before promise resolves
    const dismissFirst = screen.getByRole("button", {
      name: "Dismiss: Add priority onboarding",
    });
    await user.click(dismissFirst);
    const checkoutLink = screen.getByRole("link", { name: "Continue to checkout" });
    checkoutLink.focus();
    expect(checkoutLink).toHaveFocus();

    current = makeCart({
      version: 5,
      upsells: [sampleUpsells[1]!],
    });
    resolveDismiss?.(current);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Dismiss: Add priority onboarding" }),
      ).not.toBeInTheDocument();
    });
    // Focus stays where the user moved it (never stolen back to the suggestions region)
    expect(checkoutLink).toHaveFocus();
  });

  it("applies and removes a discount code on CartPage using server-evaluated totals", async () => {
    let current = makeCart({ upsells: [] });
    handlers.set("cart.get", () => current);
    handlers.set("cart.applyCode", (raw) => {
      const input = raw as { code: string; idempotencyKey: string };
      expect(input.code).toBe("SAVE25");
      expect(input.idempotencyKey).toMatch(/^cart-promo:/);
      current = makeCart({
        version: 5,
        upsells: [],
        totals: {
          currency: "USD",
          subtotalMinor: 25000,
          discountMinor: 5000,
          discountLabel: "Partner 20% off",
          subtotalAfterDiscountMinor: 20000,
          taxRateBps: 0,
          taxMinor: 0,
          totalMinor: 20000,
          bundle: null,
          promo: {
            promoPublicId: "01JQAPROMO0000000000000001",
            label: "Partner 20% off",
            promoDiscountMinor: 5000,
            bundleDiscountMinor: 0,
          },
        },
      });
      return current;
    });
    handlers.set("cart.removeCode", (raw) => {
      const input = raw as { expectedVersion: number };
      expect(input).toEqual({ expectedVersion: 5 });
      current = makeCart({ version: 6, upsells: [] });
      return current;
    });

    const user = userEvent.setup();
    renderUi(<CartPage />, { path: "/cart" });

    const codeInput = await screen.findByLabelText("Discount code");
    await user.type(codeInput, "SAVE25");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect((await screen.findAllByText(/Partner 20% off/i)).length).toBeGreaterThanOrEqual(2);
    await user.click(screen.getByRole("button", { name: "Remove discount Partner 20% off" }));

    await waitFor(() => {
      expect(calls.some((c) => c.path === "cart.removeCode")).toBe(true);
    });
  });

  it("handles PROMO_RECONFIRM_TOTAL on CheckoutPage without placing an order until the customer confirms the updated total", async () => {
    let current = makeCart({
      upsells: [],
      totals: {
        currency: "USD",
        subtotalMinor: 25000,
        discountMinor: 5000,
        discountLabel: "Partner 20% off",
        subtotalAfterDiscountMinor: 20000,
        taxRateBps: 0,
        taxMinor: 0,
        totalMinor: 20000,
        bundle: null,
        promo: {
          promoPublicId: "01JQAPROMO0000000000000001",
          label: "Partner 20% off",
          promoDiscountMinor: 5000,
          bundleDiscountMinor: 0,
        },
      },
    });

    let checkoutCalls = 0;
    handlers.set("cart.get", () => current);
    handlers.set("cart.checkout", () => {
      checkoutCalls += 1;
      if (checkoutCalls === 1) {
        current = makeCart({
          version: 5,
          upsells: [],
          promoNotice: {
            reasonCode: "PROMO_EXPIRED",
            message: "Your discount code expired and was removed from your cart.",
            previousLabel: "Partner 20% off",
          },
        });
        throw makeSafeTrpcError(
          "CONFLICT",
          "PROMO_RECONFIRM_TOTAL",
          "Your discount code is no longer valid, so your order was not placed.",
        );
      }
      return {
        mode: "invoice_only",
        cartPublicId: current.cartPublicId,
        attemptPublicId: "01JQAATTEMPT000000000000001",
        orderPublicId: "01JQAORDER00000000000000001",
        orderReference: "RP-2026-0099",
        invoicePublicId: "01JQAINV000000000000000001",
        invoiceNumber: "INV-2026-0099",
        totalMinor: 25000,
        currency: "USD",
      };
    });

    const user = userEvent.setup();
    renderUi(<CheckoutPage />, { path: "/cart/checkout" });

    const submitBtn = await screen.findByRole("button", { name: "Place order and receive invoice" });
    await user.click(submitBtn);

    expect(await screen.findByText("Order not placed — confirm new total")).toBeInTheDocument();
    expect(
      screen.getByText(/Your discount code is no longer valid, so your order was not placed/i),
    ).toBeInTheDocument();
    expect(checkoutCalls).toBe(1);

    // Second click confirms the updated cart version (5) and places the order
    const reconfirmBtn = screen.getByRole("button", { name: "Confirm new total and receive invoice" });
    await user.click(reconfirmBtn);
    await waitFor(() => {
      expect(checkoutCalls).toBe(2);
    });
    const secondPayload = calls.filter((c) => c.path === "cart.checkout")[1]?.input as { expectedVersion: number };
    expect(secondPayload.expectedVersion).toBe(5);
  });

  pageA11y("cart page with upsells, applied promo code, and promo notice", async () => {
    document.title = "Cart · ReadyPackets";
    handlers.set("cart.get", () =>
      makeCart({
        promoNotice: {
          reasonCode: "BUNDLE_BEATS_PROMO",
          message: "Your bundle discount saves more and is applied automatically.",
          previousLabel: "Partner 20% off",
        },
        totals: {
          currency: "USD",
          subtotalMinor: 25000,
          discountMinor: 5000,
          discountLabel: "Partner 20% off",
          subtotalAfterDiscountMinor: 20000,
          taxRateBps: 0,
          taxMinor: 0,
          totalMinor: 20000,
          bundle: null,
          promo: {
            promoPublicId: "01JQAPROMO0000000000000001",
            label: "Partner 20% off",
            promoDiscountMinor: 5000,
            bundleDiscountMinor: 0,
          },
        },
      }),
    );
    renderUi(
      <main>
        <CartPage />
      </main>,
      { path: "/cart" },
    );
    await screen.findByRole("region", { name: "Recommended for your cart" });
  });

  pageA11y("checkout page with PromoCodeField enabled", async () => {
    document.title = "Checkout · ReadyPackets";
    handlers.set("cart.get", () => makeCart({ upsells: [] }));
    renderUi(
      <main>
        <CheckoutPage />
      </main>,
      { path: "/cart/checkout" },
    );
    await screen.findByLabelText("Discount code");
  });

  it("completes zero-total checkout with a 100% or set_total discount and renders 'Nothing to pay — your discount covers this order.' on CartPage, CheckoutPage, and confirmation", async () => {
    const user = userEvent.setup();
    const zeroCartId = "01JQACART00000000000000001";
    const zeroOrderId = "01JQAORDER0000000000000001";
    const zeroInvoiceId = "01JQAINV000000000000000001";

    const zeroCart = makeCart({
      cartPublicId: zeroCartId,
      upsells: [],
      onlinePaymentEnabled: true,
      paymentProvider: "stripe",
      paymentEnvironment: "test",
      totals: {
        currency: "USD",
        subtotalMinor: 25000,
        discountMinor: 25000,
        discountLabel: "Complimentary order",
        subtotalAfterDiscountMinor: 0,
        taxRateBps: 0,
        taxMinor: 0,
        totalMinor: 0,
        bundle: null,
        promo: {
          promoPublicId: "01JQAPROMO0000000000000100",
          label: "Complimentary order",
          promoDiscountMinor: 25000,
          bundleDiscountMinor: 0,
        },
      },
    });
    handlers.set("cart.get", () => zeroCart);

    handlers.set("cart.checkout", () => ({
      mode: "no_payment_due" as const,
      cartPublicId: zeroCartId,
      orderPublicId: zeroOrderId,
      orderReference: "RP-2026-0100",
      invoicePublicId: zeroInvoiceId,
      invoiceNumber: "INV-2026-0100",
      currency: "USD",
      totalMinor: 0 as const,
    }));

    const zeroStatus: CheckoutStatus = {
      cartPublicId: zeroCartId,
      confirmationState: "no_payment_due",
      paymentMode: "no_payment_due",
      provider: "stripe",
      attemptPublicId: null,
      attemptStatus: null,
      failureReasonCode: null,
      orderPublicId: zeroOrderId,
      orderReference: "RP-2026-0100",
      invoicePublicId: zeroInvoiceId,
      invoiceNumber: "INV-2026-0100",
      invoiceStatus: "paid",
      currency: "USD",
      subtotalMinor: 25000,
      discountMinor: 25000,
      discountLabel: "Complimentary order",
      promoDiscountMinor: 25000,
      promoLabel: "Complimentary order",
      taxRateBps: 0,
      taxMinor: 0,
      totalMinor: 0,
      waivedMinor: 0,
      balanceDueMinor: 0,
      canRestoreToCart: false,
      alreadyRestored: false,
      checkedOutAt: new Date("2026-11-22T12:00:00Z"),
    };
    handlers.set("cart.checkoutStatus", () => zeroStatus);

    renderUi(
      <main>
        <Switch>
          <Route path="/cart" component={CartPage} />
          <Route path="/cart/checkout" component={CheckoutPage} />
          <Route path="/checkout/return" component={CheckoutReturnPage} />
        </Switch>
      </main>,
      { path: "/cart" },
    );

    expect(
      await screen.findByText("Nothing to pay — your discount covers this order."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Continue to checkout" }));

    expect(
      await screen.findByText("Nothing to pay — your discount covers this order."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Place order" }));

    expect(
      await screen.findByRole("heading", { name: "Checkout status" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Nothing to pay — your discount covers this order."),
    ).toBeInTheDocument();
    expect(screen.getByText("RP-2026-0100")).toBeInTheDocument();
  });

  pageA11y("checkout confirmation page for zero-total no_payment_due state", async () => {
    document.title = "Checkout status · ReadyPackets";
    const zeroCartId = "01JQACART00000000000000001";
    const zeroStatus: CheckoutStatus = {
      cartPublicId: zeroCartId,
      confirmationState: "no_payment_due",
      paymentMode: "no_payment_due",
      provider: "stripe",
      attemptPublicId: null,
      attemptStatus: null,
      failureReasonCode: null,
      orderPublicId: "01JQAORDER0000000000000001",
      orderReference: "RP-2026-0100",
      invoicePublicId: "01JQAINV000000000000000001",
      invoiceNumber: "INV-2026-0100",
      invoiceStatus: "paid",
      currency: "USD",
      subtotalMinor: 25000,
      discountMinor: 25000,
      discountLabel: "Complimentary order",
      promoDiscountMinor: 25000,
      promoLabel: "Complimentary order",
      taxRateBps: 0,
      taxMinor: 0,
      totalMinor: 0,
      waivedMinor: 0,
      balanceDueMinor: 0,
      canRestoreToCart: false,
      alreadyRestored: false,
      checkedOutAt: new Date("2026-11-22T12:00:00Z"),
    };
    handlers.set("cart.checkoutStatus", () => zeroStatus);

    renderUi(
      <main>
        <CheckoutReturnPage />
      </main>,
      { path: `/checkout/return?cart=${zeroCartId}` },
    );

    await screen.findByText("Nothing to pay — your discount covers this order.");
  });
});
