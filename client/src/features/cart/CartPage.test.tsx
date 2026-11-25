import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeResult, MeUser } from "@/lib/authApi";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { fakeAuthApi, renderUi } from "@/ui/testing";
import { CartBadge, cartCountLabel } from "./CartBadge";
import { canCheckout, CartPage, STALE_MESSAGE } from "./CartPage";
import { OrderFormCartBanner } from "./OrderFormCartBanner";

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

const { handlers, calls } = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => unknown>(),
  calls: [] as { path: string; input: unknown }[],
}));

function proxy(path: string[]): unknown {
  const key = path.join(".");
  const run = async (input: unknown) => {
    calls.push({ path: key, input });
    const handler = handlers.get(key);
    if (!handler) throw new Error(`no handler for ${key}`);
    return handler(input);
  };
  const api = {
    queryOptions: (input: unknown, opts: Record<string, unknown> = {}) => ({ queryKey: [key, input], queryFn: () => run(input), ...opts }),
    mutationOptions: (opts: Record<string, unknown> = {}) => ({ mutationFn: run, ...opts }),
    queryKey: (input?: unknown) => [key, input],
    pathKey: () => [key],
  };
  return new Proxy(api, { get: (target, prop: string) => (prop in target ? target[prop as keyof typeof target] : proxy([...path, prop])) });
}
vi.mock("@/lib/trpc", async (original) => ({ ...(await original<typeof trpcModule>()), useTRPC: () => proxy([]) }));

const line = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  itemPublicId: id,
  productPublicId: `P${id}`,
  packetNumber: null,
  tier: null,
  name,
  description: "",
  outcome: "",
  timeline: "",
  quantity: 1,
  unitPriceMinor: 1000,
  lineTotalMinor: 1000,
  currency: "USD",
  available: true,
  ...extra,
});
const cart = (items: ReturnType<typeof line>[], extra: Record<string, unknown> = {}) => ({
  cartPublicId: "01JQACART0000000000000000A",
  version: 3,
  status: "open",
  itemCount: items.length,
  projectName: "",
  note: "",
  billing: null,
  items,
  hasUnavailableItems: items.some((i) => !i.available),
  mixedCurrency: false,
  totals: { currency: "USD", subtotalMinor: 1000, discountMinor: 0, discountLabel: null, subtotalAfterDiscountMinor: 1000, taxRateBps: 0, taxMinor: 0, totalMinor: 1000, bundle: null, promo: null },
  promotionsEnabled: false,
  promoNotice: null,
  upsells: [],
  smallTotalEvaluation: null,
  paymentProvider: "none",
  onlinePaymentEnabled: false,
  updatedAt: null,
  pendingPolicies: [],
  ...extra,
});
const catalog = [
  {
    publicId: "G1",
    name: "Synthetic add-ons",
    products: [{ publicId: "PADD", name: "Synthetic add-on", packetNumber: null, tier: null, priceMinor: 500, currency: "USD", active: true }],
  },
];

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  handlers.set("orders.catalog.list", () => catalog);
  handlers.set("cart.badgeCount", () => ({ enabled: true, itemCount: 2 }));
  handlers.set("platform.bootstrap", () => ({ features: { cart: true }, consent: { enabled: false, policyVersion: 1, renewMonths: 12 } }));
});

describe("CartPage", () => {
  it("shows server totals and offers checkout only for a ready cart", async () => {
    handlers.set("cart.get", () => cart([line("A", "Synthetic Packet 41 - Basic")]));
    renderUi(<CartPage />, { path: "/cart" });
    expect(await screen.findByText("Synthetic Packet 41 - Basic")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Cart" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue to checkout" })).toHaveAttribute("href", "/cart/checkout");
    expect(canCheckout({ items: [], hasUnavailableItems: false, mixedCurrency: false })).toBe(false);
    expect(canCheckout({ items: [line("A", "x")] as never, hasUnavailableItems: true, mixedCurrency: false })).toBe(false);
    expect(canCheckout({ items: [line("A", "x")] as never, hasUnavailableItems: false, mixedCurrency: true })).toBe(false);
  });

  it("hides checkout when an item is unavailable", async () => {
    handlers.set("cart.get", () => cart([line("A", "Old synthetic item", { available: false })]));
    renderUi(<CartPage />, { path: "/cart" });
    expect(await screen.findByText("No longer available")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Continue to checkout" })).not.toBeInTheDocument();
  });

  it("removes an item with the cart version and never sends prices", async () => {
    let current = cart([line("A", "Synthetic add-on")]);
    handlers.set("cart.get", () => current);
    handlers.set("cart.removeItem", () => (current = cart([], { version: 4 })));
    renderUi(<CartPage />, { path: "/cart" });
    await userEvent.click(await screen.findByRole("button", { name: "Remove Synthetic add-on" }));
    await screen.findByText("Your cart is empty");
    expect(calls.find((c) => c.path === "cart.removeItem")?.input).toEqual({ itemPublicId: "A", expectedVersion: 3 });
    expect(screen.getByText("Synthetic add-on removed from cart.")).toHaveAttribute("aria-live", "polite");
  });

  it("refetches and announces politely on a STALE_VERSION conflict", async () => {
    let version = 3;
    handlers.set("cart.get", () => cart([line("A", "Synthetic add-on")], { version }));
    handlers.set("cart.removeItem", () => {
      version = 9;
      throw Object.assign(new Error("conflict"), { data: { safe: { domainCode: "CONFLICT", reasonCode: "STALE_VERSION", safeMessage: "x" } } });
    });
    renderUi(<CartPage />, { path: "/cart" });
    await userEvent.click(await screen.findByRole("button", { name: "Remove Synthetic add-on" }));
    await waitFor(() => expect(screen.getByText(STALE_MESSAGE)).toHaveAttribute("role", "status"));
    await waitFor(() => expect(calls.filter((c) => c.path === "cart.get").length).toBeGreaterThan(1));
    expect(screen.queryByText("Cart not updated")).not.toBeInTheDocument();
  });

  it("adds a catalog item by product id only", async () => {
    handlers.set("cart.get", () => cart([]));
    handlers.set("cart.addItems", () => cart([line("B", "Synthetic add-on")], { version: 4 }));
    renderUi(<CartPage />, { path: "/cart" });
    await userEvent.selectOptions(await screen.findByLabelText("Product"), "PADD");
    await userEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(calls.find((c) => c.path === "cart.addItems")?.input).toEqual({ items: [{ productPublicId: "PADD", quantity: 1 }] }));
  });

  it("explains on an empty cart that a discount code can be applied after adding an item when promotions are enabled", async () => {
    handlers.set("cart.get", () => cart([], { promotionsEnabled: true, totals: { ...cart([]).totals, currency: null, subtotalMinor: 0, subtotalAfterDiscountMinor: 0, totalMinor: 0 } }));
    renderUi(<CartPage />, { path: "/cart", ...asRole("customer") });
    expect(await screen.findByText("Have a discount code? Add an item first to apply it here or at checkout.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Discount code")).not.toBeInTheDocument();
  });

  it("renders StaffOrderHandoff for admin and staff on /cart without calling any cart or catalog procedures", async () => {
    for (const [role, portalLabel] of [["admin", "Admin portal"], ["staff", "Staff portal"]] as const) {
      calls.length = 0;
      const view = renderUi(<CartPage />, { path: "/cart", ...asRole(role) });
      expect(await screen.findByRole("heading", { level: 1, name: "Carts belong to customer accounts" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "New order for a customer" })).toHaveAttribute("href", "/admin/orders?new=1");
      expect(screen.getByRole("link", { name: portalLabel })).toHaveAttribute("href", "/admin");
      expect(calls.filter((c) => c.path.startsWith("cart.") || c.path === "orders.catalog.list")).toEqual([]);
      view.unmount();
    }
  });
});

describe("CartBadge", () => {
  it("renders an accessible count when enabled and non-zero", async () => {
    renderUi(<CartBadge />, asRole("customer"));
    expect(await screen.findByRole("img", { name: "2 items in cart" })).toHaveTextContent("2");
    expect(cartCountLabel(1)).toBe("1 item in cart");
  });
  it("renders nothing for zero items", async () => {
    handlers.set("cart.badgeCount", () => ({ enabled: true, itemCount: 0 }));
    renderUi(<CartBadge />, asRole("customer"));
    await waitFor(() => expect(calls.some((c) => c.path === "cart.badgeCount")).toBe(true));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("does not query cart.badgeCount for staff or admin viewers", async () => {
    for (const role of ["admin", "staff"] as const) {
      calls.length = 0;
      const view = renderUi(<CartBadge />, asRole(role));
      await waitFor(() => expect(calls.some((c) => c.path === "platform.bootstrap")).toBe(true));
      expect(calls.filter((c) => c.path.startsWith("cart."))).toEqual([]);
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      view.unmount();
    }
  });
});

describe("OrderFormCartBanner", () => {
  it("passes children through without rendering quick-cart controls or querying catalog for staff and admin", async () => {
    for (const role of ["admin", "staff"] as const) {
      calls.length = 0;
      const view = renderUi(
        <OrderFormCartBanner>
          <h1>Orders are placed for a customer</h1>
        </OrderFormCartBanner>,
        asRole(role),
      );
      expect(await screen.findByRole("heading", { level: 1, name: "Orders are placed for a customer" })).toBeInTheDocument();
      await waitFor(() => expect(calls.some((c) => c.path === "platform.bootstrap")).toBe(true));
      expect(screen.queryByRole("heading", { name: "Save items to your cart" })).not.toBeInTheDocument();
      expect(calls.filter((c) => c.path.startsWith("cart.") || c.path === "orders.catalog.list")).toEqual([]);
      view.unmount();
    }
  });
});

describe("cart page a11y", () => {
  pageA11y("cart", async () => {
    document.title = "Cart · ReadyPackets";
    handlers.set("cart.get", () => cart([line("A", "Synthetic add-on", { quantity: 2, lineTotalMinor: 2000 })]));
    renderUi(
      <main>
        <CartPage />
      </main>,
      { path: "/cart" },
    );
    await screen.findByRole("heading", { name: "Items" });
  });

  pageA11y("cart staff handoff", async () => {
    document.title = "Cart · ReadyPackets";
    renderUi(
      <main>
        <CartPage />
      </main>,
      { path: "/cart", ...asRole("admin") },
    );
    await screen.findByRole("heading", { level: 1, name: "Carts belong to customer accounts" });
  });
});
