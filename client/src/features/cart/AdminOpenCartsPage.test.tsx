import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { PageHeader } from "@/ui";
import { renderUi } from "@/ui/testing";
import { AdminOpenCartsPage } from "./AdminOpenCartsPage";
import { OrderFormCartBanner } from "./OrderFormCartBanner";
import { cartFeature } from "./routes";

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
    queryOptions: (input: unknown, opts: Record<string, unknown> = {}) => ({
      queryKey: [key, input],
      queryFn: () => run(input),
      ...opts,
    }),
    mutationOptions: (opts: Record<string, unknown> = {}) => ({ mutationFn: run, ...opts }),
    queryKey: (input?: unknown) => [key, input],
    pathKey: () => [key],
  };
  return new Proxy(api, {
    get: (target, prop: string) => (prop in target ? target[prop as keyof typeof target] : proxy([...path, prop])),
  });
}

vi.mock("@/lib/trpc", async (original) => ({
  ...(await original<typeof trpcModule>()),
  useTRPC: () => proxy([]),
}));

const sampleRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  cartPublicId: id,
  customerPublicId: "01JQACUST00000000000000001",
  customerRef: "CUST-1042",
  projectName: "Synthetic Governance Rollout",
  itemCount: 2,
  packetSummary: "Packet 1 (Standard), Rush Review",
  currency: "USD",
  subtotalMinor: 65000,
  discountMinor: 6500,
  taxMinor: 4826,
  totalMinor: 63326,
  bundleApplied: true,
  hasUnavailableItems: false,
  lastActivityAt: new Date("2026-11-21T18:00:00.000Z"),
  expiresAt: new Date("2026-11-24T18:00:00.000Z"),
  createdAt: new Date("2026-11-21T16:00:00.000Z"),
  ...overrides,
});

const sampleDetail = (id: string) => ({
  ...sampleRow(id),
  items: [
    {
      itemPublicId: "01JQAITEM00000000000000001",
      productPublicId: "01JQAPROD00000000000000001",
      packetNumber: 1,
      groupName: "Packet 1 — Readiness",
      tier: "Standard" as const,
      tierOptions: [],
      name: "Synthetic Readiness Packet — Standard",
      description: "Readiness review",
      outcome: "Readiness workbook",
      timeline: "5 business days",
      quantity: 1,
      unitPriceMinor: 50000,
      lineTotalMinor: 50000,
      currency: "USD",
      available: true,
    },
  ],
  totals: {
    currency: "USD",
    subtotalMinor: 65000,
    discountMinor: 6500,
    discountLabel: "Complete Packet Bundle (10% off)",
    subtotalAfterDiscountMinor: 58500,
    taxRateBps: 825,
    taxMinor: 4826,
    totalMinor: 63326,
    bundle: {
      enabled: true as const,
      label: "Complete Packet Bundle (10% off)",
      discountPercent: 10,
      requiredPacketNumbers: [1, 2],
      missingPacketNumbers: [],
      applied: true,
    },
  },
});

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  handlers.set("platform.bootstrap", () => ({
    features: { cart: true },
    consent: { enabled: false, policyVersion: 1, renewMonths: 12 },
  }));
});

describe("cartFeature routes & console Open carts view", () => {
  it("declares all customer and console cart routes and nav guards", () => {
    expect(cartFeature.routes.map((r) => r.path)).toEqual([
      "/cart",
      "/cart/checkout",
      "/checkout/return",
      "/checkout/cancel",
      "/admin/carts",
      "/admin/carts/suggestions",
    ]);
    const customerNav = cartFeature.nav?.find((n) => n.href === "/cart");
    const adminNav = cartFeature.nav?.find((n) => n.href === "/admin/carts");
    const suggestionsNav = cartFeature.nav?.find((n) => n.href === "/admin/carts/suggestions");
    const suggestionsRoute = cartFeature.routes.find((r) => r.path === "/admin/carts/suggestions");
    expect(customerNav?.enabledBy).toBe("cart");
    expect(adminNav?.capability).toBe("carts.read_all");
    expect(suggestionsNav?.capability).toBe("carts.upsells.manage");
    expect(suggestionsNav?.access).toBe("admin");
    expect(suggestionsRoute?.capability).toBe("carts.upsells.manage");
    expect(suggestionsRoute?.access).toBe("admin");
  });

  it("renders open carts and appends cursor pages via LoadMore", async () => {
    handlers.set("cart.admin.listOpen", (raw) => {
      const input = (raw ?? {}) as { cursor?: string; search?: string };
      if (input.cursor === "cursor_page_2") {
        return {
          featureEnabled: true,
          abandonedTtlHours: 72,
          items: [sampleRow("01JQACART00000000000000002", { projectName: "Second Page Cart", bundleApplied: false })],
          nextCursor: null,
        };
      }
      return {
        featureEnabled: true,
        abandonedTtlHours: 72,
        items: [sampleRow("01JQACART00000000000000001")],
        nextCursor: "cursor_page_2",
      };
    });

    const user = userEvent.setup();
    renderUi(<AdminOpenCartsPage />, { path: "/admin/carts" });
    expect(await screen.findByRole("heading", { level: 1, name: "Open carts" })).toBeInTheDocument();
    expect((await screen.findAllByText("Synthetic Governance Rollout")).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect((await screen.findAllByText("Second Page Cart")).length).toBeGreaterThan(0);
  });

  it("opens detail Drawer without exposing PII and shows feature-off callout", async () => {
    handlers.set("cart.admin.listOpen", () => ({
      featureEnabled: false,
      abandonedTtlHours: 48,
      items: [sampleRow("01JQACART00000000000000001", { hasUnavailableItems: true })],
      nextCursor: null,
    }));
    handlers.set("cart.admin.getOpen", () => sampleDetail("01JQACART00000000000000001"));

    const user = userEvent.setup();
    const view = renderUi(<AdminOpenCartsPage />, { path: "/admin/carts" });
    expect(await screen.findByText("Customer cart feature is turned off")).toBeInTheDocument();
    const inspectButtons = await screen.findAllByRole("button", {
      name: "Inspect cart 01JQACART00000000000000001",
    });
    await user.click(inspectButtons[0]!);
    expect(await screen.findByText("Synthetic Readiness Packet — Standard")).toBeInTheDocument();
    expect(screen.getByText("Complete Packet Bundle (10% off)")).toBeInTheDocument();
    expect(view.container.textContent).not.toContain("billing_enc");
  });

  it("supports search and filter reset when no open carts match", async () => {
    handlers.set("cart.admin.listOpen", (raw) => {
      const input = (raw ?? {}) as { search?: string };
      if (input.search === "NOMATCH") {
        return { featureEnabled: true, abandonedTtlHours: 72, items: [], nextCursor: null };
      }
      return {
        featureEnabled: true,
        abandonedTtlHours: 72,
        items: [sampleRow("01JQACART00000000000000001")],
        nextCursor: null,
      };
    });

    const user = userEvent.setup();
    renderUi(<AdminOpenCartsPage />, { path: "/admin/carts" });
    await screen.findAllByText("Synthetic Governance Rollout");

    const searchBox = screen.getByRole("searchbox", { name: "Search open carts" });
    await user.type(searchBox, "NOMATCH{Enter}");
    expect(await screen.findByText("No matching open carts")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      expect(screen.getAllByText("Synthetic Governance Rollout").length).toBeGreaterThan(0);
    });
  });

  it("keeps OrderFormCartBanner silent when disabled and adds items when enabled", async () => {
    handlers.set("platform.bootstrap", () => ({
      features: { cart: false },
      consent: { enabled: false, policyVersion: 1, renewMonths: 12 },
    }));
    const disabledView = renderUi(
      <OrderFormCartBanner>
        <PageHeader title="New order" description="Start a single packet order." />
      </OrderFormCartBanner>,
      { path: "/orders/new" },
    );
    expect(screen.getByRole("heading", { level: 1, name: "New order" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Save items to your cart" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === "orders.catalog.list")).toBe(false);
    disabledView.unmount();

    handlers.set("platform.bootstrap", () => ({
      features: { cart: true },
      consent: { enabled: false, policyVersion: 1, renewMonths: 12 },
    }));
    handlers.set("orders.catalog.list", () => [
      {
        publicId: "G1",
        name: "Packet 1",
        packetNumber: 1,
        products: [
          {
            publicId: "01JQAPROD00000000000000001",
            name: "Readiness Packet",
            tier: "Standard",
            priceMinor: 50000,
            currency: "USD",
            active: true,
          },
        ],
      },
    ]);
    handlers.set("cart.addItems", () => ({ itemCount: 1 }));
    handlers.set("cart.badgeCount", () => ({ enabled: true, itemCount: 1 }));

    const user = userEvent.setup();
    renderUi(
      <OrderFormCartBanner>
        <PageHeader title="New order" description="Start a single packet order." />
      </OrderFormCartBanner>,
      { path: "/orders/new" },
    );
    const select = await screen.findByLabelText(/Packet tier or add-on/i);
    await user.selectOptions(select, "01JQAPROD00000000000000001");
    await user.click(screen.getByRole("button", { name: "Add to cart" }));
    expect(await screen.findByText("View cart")).toHaveAttribute("href", "/cart");
    expect(calls.some((c) => c.path === "cart.addItems")).toBe(true);
  });
});

describe("admin open carts and order-form companion a11y", () => {
  pageA11y("admin open carts list", async () => {
    document.title = "Open carts · ReadyPackets";
    handlers.set("cart.admin.listOpen", () => ({
      featureEnabled: false,
      abandonedTtlHours: 72,
      items: [sampleRow("01JQACART00000000000000001", { hasUnavailableItems: true })],
      nextCursor: "cursor_next",
    }));
    renderUi(
      <main>
        <AdminOpenCartsPage />
      </main>,
      { path: "/admin/carts" },
    );
    await screen.findByText("Customer cart feature is turned off");
  });

  pageA11y("admin open carts detail drawer", async () => {
    document.title = "Open carts · ReadyPackets";
    handlers.set("cart.admin.listOpen", () => ({
      featureEnabled: true,
      abandonedTtlHours: 72,
      items: [sampleRow("01JQACART00000000000000001")],
      nextCursor: null,
    }));
    handlers.set("cart.admin.getOpen", () => sampleDetail("01JQACART00000000000000001"));
    const user = userEvent.setup();
    renderUi(
      <main>
        <AdminOpenCartsPage />
      </main>,
      { path: "/admin/carts" },
    );
    const inspectButtons = await screen.findAllByRole("button", {
      name: "Inspect cart 01JQACART00000000000000001",
    });
    await user.click(inspectButtons[0]!);
    await screen.findByText("Synthetic Readiness Packet — Standard");
  });

  pageA11y("order form cart companion", async () => {
    document.title = "New order · ReadyPackets";
    handlers.set("orders.catalog.list", () => [
      {
        publicId: "G1",
        name: "Packet 1",
        packetNumber: 1,
        products: [
          {
            publicId: "01JQAPROD00000000000000001",
            name: "Readiness Packet",
            tier: "Standard",
            priceMinor: 50000,
            currency: "USD",
            active: true,
          },
        ],
      },
    ]);
    renderUi(
      <main>
        <OrderFormCartBanner>
          <PageHeader title="New order" description="Start a single packet order." />
        </OrderFormCartBanner>
      </main>,
      { path: "/orders/new" },
    );
    await screen.findByRole("heading", { level: 2, name: "Save items to your cart" });
  });
});
