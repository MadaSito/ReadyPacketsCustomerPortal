import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import type * as agreementGateModule from "@/lib/agreementGate";
import type * as trpcModule from "@/lib/trpc";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import AdminCatalogPage, { parseAmountToMinor, parseDeliverables, parsePacketNumbers } from "./pages/AdminCatalogPage";
import AdminOrdersPage from "./pages/AdminOrdersPage";
import NewOrderPage from "./pages/NewOrderPage";
import OrderDetailPage from "./pages/OrderDetailPage";
import AdminOrderDetailPage from "./pages/AdminOrderDetailPage";
import OrdersListPage from "./pages/OrdersListPage";
import OrdersPipelineWidget from "./OrdersPipelineWidget";
import RecentOrdersWidget from "./RecentOrdersWidget";
import { ordersFeature } from "./routes";
import { pageA11y } from "@/test/a11y";
import { newIdempotencyKey } from "./shared";

/** Generic fake of the tRPC/TanStack proxy: every procedure path resolves through `handlers`. */
const { handlers, calls, session } = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => unknown>(),
  calls: [] as { path: string; input: unknown }[],
  session: { role: "customer" as string },
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
    infiniteQueryOptions: (input: unknown, opts: Record<string, unknown> = {}) => ({
      queryKey: [key, input, "infinite"],
      queryFn: ({ pageParam }: { pageParam: unknown }) => run({ ...(input as object), cursor: pageParam ?? undefined }),
      initialPageParam: null,
      ...opts,
    }),
    mutationOptions: (opts: Record<string, unknown> = {}) => ({ mutationFn: run, ...opts }),
    mutate: run,
    query: run,
    queryKey: (input?: unknown) => [key, input],
    pathKey: () => [key],
    pathFilter: () => ({ queryKey: [key] }),
  };
  return new Proxy(api, { get: (target, prop: string) => (prop in target ? target[prop as keyof typeof target] : proxy([...path, prop])) });
}

vi.mock("@/lib/trpc", async (original) => ({ ...(await original<typeof trpcModule>()), useTRPC: () => proxy([]), useTRPCClient: () => proxy([]) }));
// The shared agreement dialog (compliance) is stubbed: these tests cover how the order page reacts to AGREEMENT_REQUIRED.
vi.mock("@/lib/agreementGate", async (original) => ({
  ...(await original<typeof agreementGateModule>()),
  AgreementDialog: ({ open, policyPublicId, onAccepted, onClose }: { open: boolean; policyPublicId: string; onAccepted: () => void; onClose: () => void }) =>
    open ? (
      <div role="dialog" aria-label="Order agreement">
        <p>{`Agreement ${policyPublicId}`}</p>
        <button type="button" onClick={onAccepted}>Accept agreement</button>
        <button type="button" onClick={onClose}>Not now</button>
      </div>
    ) : null,
}));
vi.mock("@/lib/session", () => ({ useSession: () => ({ me: { state: "full", user: { role: session.role } }, view: { status: "full", role: session.role } }) }));
vi.mock("@/app/registry", () => ({
  FEATURES: [
    {
      routes: [],
      orderBanners: [
        { key: "gate", order: 0, area: "both", component: ({ orderId, area }: { orderId: string; area: string }) => <p>Gate banner for {orderId} in {area}</p> },
        { key: "console_only", order: 1, area: "console", component: () => <p>Console only banner</p> },
      ],
    },
  ],
  ORDER_TABS: [
    { key: "files", label: "Files", access: "customer", order: 30, component: ({ orderId, area }: { orderId: string; area: string }) => <p>Files tab for {orderId} in {area}</p> },
    { key: "invoices_admin", label: "Billing (staff)", access: "staff", order: 40, component: () => <p>staff only tab</p> },
  ],
}));

const ORDER_ID = "01JTESTORDER0000000000000A";
const now = new Date("2026-11-20T09:00:00.000Z");
const listItem = {
  publicId: ORDER_ID,
  reference: "RP-2026-000001",
  projectName: "Synthetic project",
  statusKey: "submitted",
  statusLabel: "Submitted",
  statusTone: "info",
  lockState: "none",
  totalMinor: 2500,
  currency: "USD",
  accessRole: "owner",
  createdAt: now,
  updatedAt: now,
};
const detail = {
  ...listItem,
  statusKind: "initial",
  origin: "portal",
  version: 3,
  canWrite: true,
  canShare: true,
  ownerPublicId: "01JTESTUSER00000000000000A",
  submittedAt: now,
  subtotalMinor: 2500,
  discountMinor: 0,
  discountLabel: null,
  lineItems: [
    {
      publicId: "01JTESTLINE00000000000000A",
      productPublicId: null,
      productVersion: 1,
      name: "Synthetic item",
      description: "Demo",
      features: [],
      packetNumber: null,
      tier: null,
      outcome: "",
      timeline: "",
      deliverables: [],
      unitPriceMinor: 1250,
      currency: "USD",
      quantity: 2,
      lineTotalMinor: 2500,
    },
  ],
  notes: [{ publicId: "01JTESTNOTE00000000000000A", visibility: "customer", authorRole: "customer", mine: true, body: "Customer note", createdAt: now }],
  history: [{ publicId: "01JTESTHIST00000000000000A", fromLabel: null, toLabel: "Submitted", toStatus: "submitted", actorRole: "customer", reasonCode: "CREATED", hasNote: false, occurredAt: now }],
  transitions: [{ to: "canceled", label: "Canceled", actionLabel: "Cancel order", destructive: true, requiresNote: true }],
};
const catalog = [
  {
    publicId: "01JTESTGROUP000000000000A",
    groupKey: null,
    packetNumber: null,
    name: "Synthetic group",
    description: "",
    sortOrder: 0,
    active: true,
    rowVersion: 1,
    products: [
      { publicId: "01JTESTPROD000000000000A1", productKey: "synthetic-a", groupPublicId: "01JTESTGROUP000000000000A", packetNumber: null, tier: null, outcome: "", timeline: "", deliverables: [], name: "Synthetic A", description: "First", features: ["One"], priceMinor: 1000, currency: "USD", versionNumber: 1, versionPublicId: "x", sortOrder: 0, active: true, rowVersion: 1 },
      { publicId: "01JTESTPROD000000000000A2", productKey: "synthetic-b", groupPublicId: "01JTESTGROUP000000000000A", packetNumber: null, tier: null, outcome: "", timeline: "", deliverables: [], name: "Synthetic B", description: "", features: [], priceMinor: 500, currency: "USD", versionNumber: 2, versionPublicId: "y", sortOrder: 1, active: true, rowVersion: 1 },
    ],
  },
];

/** Synthetic packet catalog (packet numbers 41/42 so nothing resembles real offerings). */
const packetProduct = (packet: number, tier: "Basic" | "Premium", id: string, priceMinor: number) => ({
  publicId: id,
  productKey: `synthetic-${packet}-${tier.toLowerCase()}`,
  groupPublicId: `01JTESTPKTGRP0000000000${packet}`,
  packetNumber: packet,
  tier,
  name: `Synthetic Packet ${packet} - ${tier}`,
  description: "",
  features: ["Synthetic deliverable"],
  outcome: `Synthetic outcome ${packet} ${tier}`,
  timeline: "1 - 2 synthetic days",
  deliverables: [{ title: "Synthetic deliverable", detail: "Synthetic detail" }],
  priceMinor,
  currency: "USD",
  versionNumber: 1,
  versionPublicId: "v",
  sortOrder: tier === "Basic" ? 0 : 2,
  active: true,
  rowVersion: 1,
});
const packetCatalog = [41, 42].map((packet) => ({
  publicId: `01JTESTPKTGRP0000000000${packet}`,
  groupKey: `synthetic-${packet}`,
  packetNumber: packet,
  name: `Synthetic Packet ${packet}`,
  description: "Synthetic packet",
  sortOrder: packet,
  active: true,
  rowVersion: 1,
  products: [packetProduct(packet, "Basic", `01JTESTPKT${packet}B00000000000A`, packet * 100), packetProduct(packet, "Premium", `01JTESTPKT${packet}P00000000000A`, packet * 300)],
}));
const allProducts: { publicId: string; priceMinor: number; packetNumber: number | null }[] = [
  ...catalog.flatMap((g) => g.products),
  ...packetCatalog.flatMap((g) => g.products),
];

/** Fake server quote: sums lines; 10% "Synthetic bundle" once packets 41 and 42 are both present. */
function fakeQuote(input: unknown) {
  const { items } = input as { items: { productPublicId: string; quantity: number }[] };
  const lines = items.map((item) => ({ item, product: allProducts.find((p) => p.publicId === item.productPublicId)! }));
  const subtotalMinor = lines.reduce((sum, { item, product }) => sum + product.priceMinor * item.quantity, 0);
  const present = new Set(lines.map(({ product }) => product.packetNumber).filter((n) => n !== null));
  const missingPacketNumbers = [41, 42].filter((n) => !present.has(n));
  const applied = missingPacketNumbers.length === 0;
  const discountMinor = applied ? Math.floor((subtotalMinor * 10 + 50) / 100) : 0;
  return {
    currency: "USD",
    subtotalMinor,
    discountMinor,
    discountLabel: applied ? "Synthetic bundle" : null,
    totalMinor: subtotalMinor - discountMinor,
    bundle: { enabled: true, label: "Synthetic bundle", discountPercent: 10, requiredPacketNumbers: [41, 42], missingPacketNumbers, applied },
  };
}

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  session.role = "customer";
  handlers.set("orders.sharing.myInvitations", () => []);
  handlers.set("orders.quote", fakeQuote);
  handlers.set("orders.admin.catalog.bundleRule", () => ({ enabled: false, requiredPacketNumbers: [], discountPercent: 0, label: "" }));
});

describe("customer order list", () => {
  it("renders orders with status badges and no axe violations", async () => {
    handlers.set("orders.list", () => ({ items: [listItem], nextCursor: null }));
    const { container } = renderUi(<OrdersListPage />, { path: "/orders" });
    expect((await screen.findAllByRole("link", { name: "Synthetic project" }))[0]).toHaveAttribute("href", "/orders/" + ORDER_ID);
    expect(screen.getAllByText("Submitted").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(container);
  });

  it("shows a guiding empty state and pending invitations that can be accepted", async () => {
    handlers.set("orders.list", () => ({ items: [], nextCursor: null }));
    handlers.set("orders.sharing.myInvitations", () => [{ publicId: "01JTESTGRANT0000000000000A", role: "viewer", orderReference: "RP-2026-000009", projectName: "Shared synthetic", expiresAt: now, createdAt: now }]);
    handlers.set("orders.sharing.respond", () => ({ status: "active" }));
    const { container } = renderUi(<OrdersListPage />, { path: "/orders" });
    expect(await screen.findByText("No orders yet")).toBeInTheDocument();
    await screen.findByText("Shared synthetic");
    await expectNoAxeViolations(container);
    await userEvent.setup().click(screen.getByRole("button", { name: /Accept invitation to Shared synthetic/ }));
    await waitFor(() => expect(calls.find((c) => c.path === "orders.sharing.respond")?.input).toEqual({ grantId: "01JTESTGRANT0000000000000A", accept: true }));
  });

  it("07.1 D4: New order and Start an order go to the wizard for customers and to the console dialog for staff/admin", async () => {
    handlers.set("orders.list", () => ({ items: [], nextCursor: null }));
    handlers.set("orders.sharing.myInvitations", () => []);
    const first = renderUi(<OrdersListPage />, { path: "/orders" });
    await screen.findByText("No orders yet");
    expect(screen.getByRole("link", { name: "New order" })).toHaveAttribute("href", "/orders/new");
    expect(screen.getByRole("link", { name: "Start an order" })).toHaveAttribute("href", "/orders/new");
    first.unmount();
    for (const role of ["staff", "admin"]) {
      session.role = role;
      const view = renderUi(<OrdersListPage />, { path: "/orders" });
      await screen.findByText("No orders yet");
      const links = screen.getAllByRole("link", { name: "New order for a customer" });
      expect(links).toHaveLength(2);
      for (const link of links) expect(link).toHaveAttribute("href", "/admin/orders?new=1");
      expect(screen.queryByRole("link", { name: /^(New order|Start an order)$/ })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("240 px reflow: the phone card's progress bar has no fixed minimum width (the 10rem floor is md+ table only)", async () => {
    handlers.set("orders.list", () => ({ items: [{ ...listItem, progressPercent: 40, phaseLabel: "Payment", phaseIndex: 0, phaseTotal: 7, progressCanceled: false }], nextCursor: null }));
    const { container } = renderUi(<OrdersListPage />, { path: "/orders" });
    await screen.findAllByRole("link", { name: "Synthetic project" });
    const cards = screen.getByRole("list", { name: "Your orders" });
    const bars = [...container.querySelectorAll<HTMLElement>('[data-variant="compact"]')];
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.some((bar) => cards.contains(bar))).toBe(true);
    for (const bar of bars) {
      const classes = bar.className.split(/\s+/);
      expect(classes).not.toContain("min-w-40");
      expect(classes).toContain("md:min-w-40");
    }
  });

  it("shows an error state when the list fails", async () => {
    handlers.set("orders.list", () => {
      throw new Error("boom");
    });
    renderUi(<OrdersListPage />, { path: "/orders" });
    expect(await screen.findByRole("button", { name: /try again|retry/i })).toBeInTheDocument();
  });
});

describe("new order wizard", () => {
  it("walks choose → details → review, keeps data on Back, and submits once with an idempotency key", async () => {
    handlers.set("orders.catalog.list", () => catalog);
    handlers.set("orders.create", () => ({ publicId: ORDER_ID, reference: "RP-2026-000001", created: true }));
    const user = userEvent.setup();
    const { container, location } = renderUi(<NewOrderPage />, { path: "/orders/new" });
    await screen.findByText("Synthetic A");
    await expectNoAxeViolations(container);
    expect(screen.getByText(/Step 1 of 3: Choose items/).closest("li")).toHaveAttribute("aria-current", "step");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Choose at least one item to continue.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Quantity of Synthetic A"), "2");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Details" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Enter a project name.")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Project name/), "My synthetic project");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Quantity of Synthetic A")).toHaveValue(2);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText(/Project name/)).toHaveValue("My synthetic project");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Review" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Submit order" }));
    await waitFor(() => expect(location.history?.at(-1)).toBe(`/orders/${ORDER_ID}`));
    const create = calls.filter((c) => c.path === "orders.create");
    expect(create).toHaveLength(1);
    expect(create[0]!.input).toMatchObject({ projectName: "My synthetic project", items: [{ productPublicId: catalog[0]!.products[0]!.publicId, quantity: 2 }] });
    expect((create[0]!.input as { idempotencyKey: string }).idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
  });

  it("handles a policy published mid-wizard: keeps the choices, links to /policies and refreshes policy status", async () => {
    handlers.set("orders.catalog.list", () => catalog);
    let attempts = 0;
    handlers.set("orders.create", () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("policy"), { data: { safe: { domainCode: "CONFLICT", reasonCode: "POLICY_ACCEPTANCE_REQUIRED", safeMessage: "Please accept.", requestId: "r1" } } });
      return { publicId: ORDER_ID, reference: "RP-2026-000001", created: true };
    });
    const user = userEvent.setup();
    const { container, location, queryClient } = renderUi(<NewOrderPage />, { path: "/orders/new" });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await screen.findByText("Synthetic A");
    await user.type(screen.getByLabelText("Quantity of Synthetic A"), "1");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText(/Project name/), "Policy race");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Submit order" }));
    expect(await screen.findByText("Please review our policies first")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review and accept policies" })).toHaveAttribute("href", "/policies");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["compliance.policies.myStatus", undefined] });
    expect(location.history?.at(-1)).toBe("/orders/new");
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Submit order" }));
    await waitFor(() => expect(location.history?.at(-1)).toBe(`/orders/${ORDER_ID}`));
    const keys = calls.filter((c) => c.path === "orders.create").map((c) => (c.input as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("D14 order agreement: AGREEMENT_REQUIRED opens the agreement, accepting retries once with the same key; Not now explains", async () => {
    handlers.set("orders.catalog.list", () => catalog);
    let attempts = 0;
    const agreementError = () =>
      Object.assign(new Error("agreement"), {
        data: { safe: { domainCode: "CONFLICT", reasonCode: "AGREEMENT_REQUIRED", safeMessage: "Accept the order agreement first.", requestId: "r1", details: { policyPublicId: "01JTESTPOL0000000000000000", signatureMode: "checkbox" } } },
      });
    handlers.set("orders.create", () => {
      attempts += 1;
      if (attempts <= 2) throw agreementError();
      return { publicId: ORDER_ID, reference: "RP-2026-000001", created: true };
    });
    const user = userEvent.setup();
    const { location } = renderUi(<NewOrderPage />, { path: "/orders/new" });
    await screen.findByText("Synthetic A");
    await user.type(screen.getByLabelText("Quantity of Synthetic A"), "1");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText(/Project name/), "Agreement first");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Submit order" }));
    const dialog = await screen.findByRole("dialog", { name: "Order agreement" });
    expect(within(dialog).getByText("Agreement 01JTESTPOL0000000000000000")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Not now" }));
    expect(await screen.findByText("Your order was not submitted. Accept the order agreement to place it.")).toBeInTheDocument();
    expect(location.history?.at(-1)).toBe("/orders/new");
    await user.click(screen.getByRole("button", { name: "Submit order" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Order agreement" })).getByRole("button", { name: "Accept agreement" }));
    await waitFor(() => expect(location.history?.at(-1)).toBe(`/orders/${ORDER_ID}`));
    const keys = calls.filter((c) => c.path === "orders.create").map((c) => (c.input as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("C3 discount code: Apply and Enter only quote (never submit the order), total is announced, code is sent on create", async () => {
    handlers.set("orders.catalog.list", () => catalog);
    handlers.set("platform.bootstrap", () => ({ features: { promotions: true }, consent: { enabled: false, policyVersion: 1, renewMonths: 12 } }));
    handlers.set("orders.quoteWithPromo", (input) => {
      const { promoCode } = input as { promoCode: string };
      if (promoCode !== "SAVE10") throw Object.assign(new Error("promo"), { data: { safe: { domainCode: "VALIDATION", reasonCode: "PROMO_NOT_APPLICABLE", safeMessage: "This code cannot be applied.", requestId: "r1" } } });
      const base = fakeQuote(input);
      return { ...base, discountMinor: base.discountMinor + 100, discountLabel: "Synthetic promo", totalMinor: base.totalMinor - 100, promo: { label: "Synthetic promo", promoDiscountMinor: 100 } };
    });
    handlers.set("orders.create", () => ({ publicId: ORDER_ID, reference: "RP-2026-000001", created: true }));
    const user = userEvent.setup();
    const { container, location, queryClient } = renderUi(<NewOrderPage />, { path: "/orders/new" });
    await screen.findByText("Synthetic A");
    await user.type(screen.getByLabelText("Quantity of Synthetic A"), "2");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText(/Project name/), "Promo project");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Review" })).toBeInTheDocument();
    // No nested forms: the discount field's form is outside the wizard form.
    expect(container.querySelectorAll("form form")).toHaveLength(0);
    const codeInput = await screen.findByLabelText("Discount code");
    expect(screen.queryByText(/You can enter it in your cart and at checkout/)).not.toBeInTheDocument();
    // Enter with a wrong code: quote only, uniform refusal, no order.
    await user.type(codeInput, "WRONG1{Enter}");
    await waitFor(() => expect(calls.filter((c) => c.path === "orders.quoteWithPromo")).toHaveLength(1));
    expect(await screen.findAllByText("This code cannot be applied.")).not.toHaveLength(0);
    expect(calls.filter((c) => c.path === "orders.create")).toHaveLength(0);
    // Apply button with the right code: quote only, then the new total is announced in the always-mounted region.
    await user.clear(screen.getByLabelText("Discount code"));
    await user.type(screen.getByLabelText("Discount code"), "SAVE10");
    await user.click(screen.getByRole("button", { name: /^Apply/ }));
    await waitFor(() => expect(screen.getByText(/Discount Synthetic promo applied\. New total/)).toBeInTheDocument());
    expect(calls.filter((c) => c.path === "orders.create")).toHaveLength(0);
    expect(location.history?.at(-1)).toBe("/orders/new");
    // The code is never part of a cache key.
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.queryKey))).not.toContain("SAVE10");
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Submit order" }));
    await waitFor(() => expect(location.history?.at(-1)).toBe(`/orders/${ORDER_ID}`));
    const create = calls.filter((c) => c.path === "orders.create");
    expect(create).toHaveLength(1);
    expect(create[0]!.input).toMatchObject({ promoCode: "SAVE10" });
  });

  it("07.1 D4: staff/admin on /orders/new get the handoff panel, not the wizard, and no customer queries run", async () => {
    for (const role of ["staff", "admin"]) {
      session.role = role;
      calls.length = 0;
      const view = renderUi(<NewOrderPage />, { path: "/orders/new" });
      expect(screen.getByRole("heading", { level: 1, name: "Orders are placed for a customer" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "New order for a customer" })).toHaveAttribute("href", "/admin/orders?new=1");
      expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
      expect(calls.filter((c) => c.path === "orders.catalog.list")).toHaveLength(0);
      await expectNoAxeViolations(view.container);
      view.unmount();
    }
  });

  it("07.1 D6: with cart and promotions on, Review says a discount code goes in the cart and at checkout", async () => {
    handlers.set("orders.catalog.list", () => catalog);
    handlers.set("platform.bootstrap", () => ({ features: { promotions: true, cart: true }, consent: { enabled: false, policyVersion: 1, renewMonths: 12 } }));
    const user = userEvent.setup();
    const { container } = renderUi(<NewOrderPage />, { path: "/orders/new" });
    await screen.findByText("Synthetic A");
    await user.type(screen.getByLabelText("Quantity of Synthetic A"), "2");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText(/Project name/), "Cart project");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Review" })).toBeInTheDocument();
    expect(await screen.findByText("Have a discount code? You can enter it in your cart and at checkout.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Discount code")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to cart" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("C3 discount code dropped after a selection change stays removed when the selection is restored", async () => {
    handlers.set("orders.catalog.list", () => catalog);
    handlers.set("platform.bootstrap", () => ({ features: { promotions: true }, consent: { enabled: false, policyVersion: 1, renewMonths: 12 } }));
    handlers.set("orders.quoteWithPromo", (input) => {
      const { items, promoCode } = input as { items: { quantity: number }[]; promoCode: string };
      if (items[0]?.quantity !== 2 || promoCode !== "SAVE10") throw Object.assign(new Error("promo"), { data: { safe: { domainCode: "VALIDATION", reasonCode: "PROMO_NOT_APPLICABLE", safeMessage: "This code cannot be applied.", requestId: "r1" } } });
      const base = fakeQuote(input);
      return { ...base, discountMinor: 100, discountLabel: "Synthetic promo", totalMinor: base.totalMinor - 100, promo: { label: "Synthetic promo", promoDiscountMinor: 100 } };
    });
    handlers.set("orders.create", () => ({ publicId: ORDER_ID, reference: "RP-2026-000001", created: true }));
    const user = userEvent.setup();
    const { location } = renderUi(<NewOrderPage />, { path: "/orders/new" });
    await screen.findByText("Synthetic A");
    await user.type(screen.getByLabelText("Quantity of Synthetic A"), "2");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText(/Project name/), "Promo project");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(await screen.findByLabelText("Discount code"), "SAVE10");
    await user.click(screen.getByRole("button", { name: /^Apply/ }));
    await screen.findByText(/Discount Synthetic promo applied\. New total/);
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.clear(screen.getByLabelText("Quantity of Synthetic A"));
    await user.type(screen.getByLabelText("Quantity of Synthetic A"), "3");
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((region) => region.textContent === "The discount code does not apply to this selection and was removed.")).toBe(true),
    );
    await user.clear(screen.getByLabelText("Quantity of Synthetic A"));
    await user.type(screen.getByLabelText("Quantity of Synthetic A"), "2");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Not re-applied: the field offers entry again and create carries no code.
    expect(await screen.findByLabelText("Discount code")).toBeInTheDocument();
    // A later field error replaces the notice in the shared status region.
    await user.type(screen.getByLabelText("Discount code"), "WRONG1{Enter}");
    await waitFor(() => expect(screen.getAllByRole("status").some((region) => region.textContent === "This code cannot be applied.")).toBe(true));
    expect(screen.queryByText("The discount code does not apply to this selection and was removed.")).toBeNull();
    expect(calls.filter((c) => c.path === "orders.create")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Submit order" }));
    await waitFor(() => expect(location.history?.at(-1)).toBe(`/orders/${ORDER_ID}`));
    const create = calls.filter((c) => c.path === "orders.create");
    expect(create).toHaveLength(1);
    expect(create[0]!.input).not.toHaveProperty("promoCode");
  });

  it("packet catalog: picker + server quote, bundle discount on review, one tier per packet sent as quantity 1", async () => {
    handlers.set("orders.catalog.list", () => packetCatalog);
    handlers.set("orders.create", () => ({ publicId: ORDER_ID, reference: "RP-2026-000001", created: true }));
    const user = userEvent.setup();
    const { container, location } = renderUi(<NewOrderPage />, { path: "/orders/new" });
    await screen.findByRole("heading", { name: "Packet 41: Synthetic Packet 41" });
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Choose at least one packet or item to continue.")).toBeInTheDocument();
    await user.click(within(screen.getByRole("group", { name: "Tier for Synthetic Packet 41" })).getByRole("radio", { name: /Premium/ }));
    await user.click(within(screen.getByRole("group", { name: "Tier for Synthetic Packet 42" })).getByRole("radio", { name: /Basic/ }));
    const figures = await screen.findByTestId("packet-summary-figures");
    // 12300 + 4200 = 16500; 10% = 1650 -> 14850 (all from the fake server quote)
    await waitFor(() => expect(within(figures).getByText("Synthetic bundle")).toBeInTheDocument());
    expect(figures).toHaveTextContent("$148.50");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText(/Project name/), "Packet project");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Review" })).toBeInTheDocument();
    expect(screen.getByText("Subtotal").parentElement).toHaveTextContent("$165.00");
    expect(screen.getByText("Synthetic bundle").parentElement).toHaveTextContent("$16.50");
    expect(screen.getByText("Total").parentElement).toHaveTextContent("$148.50");
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Submit order" }));
    await waitFor(() => expect(location.history?.at(-1)).toBe(`/orders/${ORDER_ID}`));
    const create = calls.filter((c) => c.path === "orders.create");
    expect(create).toHaveLength(1);
    expect((create[0]!.input as { items: unknown[] }).items).toEqual([
      { productPublicId: "01JTESTPKT41P00000000000A", quantity: 1 },
      { productPublicId: "01JTESTPKT42B00000000000A", quantity: 1 },
    ]);
    expect(Object.keys(create[0]!.input as object)).not.toContain("totalMinor");
  });

  it("shows the server's packet rule message when create is refused", async () => {
    handlers.set("orders.catalog.list", () => packetCatalog);
    handlers.set("orders.create", () => {
      throw Object.assign(new Error("tier"), { data: { safe: { domainCode: "VALIDATION", reasonCode: "PACKET_TIER_CONFLICT", safeMessage: "x", requestId: "r1" } } });
    });
    const user = userEvent.setup();
    renderUi(<NewOrderPage />, { path: "/orders/new" });
    await user.click(within(await screen.findByRole("group", { name: "Tier for Synthetic Packet 41" })).getByRole("radio", { name: /Basic/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText(/Project name/), "Packet project");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Submit order" }));
    expect(await screen.findByText("Choose one tier per packet.")).toBeInTheDocument();
  });

  it("explains an empty catalog instead of showing a broken form", async () => {
    handlers.set("orders.catalog.list", () => []);
    const { container } = renderUi(<NewOrderPage />, { path: "/orders/new" });
    expect(await screen.findByText("Nothing is available to order yet")).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe("order detail host", () => {
  const renderDetail = (path: string) =>
    renderUi(
      <>
        <Route path="/orders/:orderId">
          <OrderDetailPage />
        </Route>
        <Route path="/orders/:orderId/:tab">
          <OrderDetailPage />
        </Route>
      </>,
      { path },
    );

  it("renders overview, registered customer tabs only, and no axe violations", async () => {
    handlers.set("orders.get", () => detail);
    const { container } = renderDetail(`/orders/${ORDER_ID}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Synthetic project" })).toBeInTheDocument();
    // Increment 08: customers land on the wizard; the former tabs sit behind "Order details".
    await userEvent.setup().click(screen.getByRole("button", { name: "Order details" }));
    const tabs = screen.getByRole("tablist", { name: "Order sections" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Files", "Notes", "Sharing"]);
    expect(screen.getAllByText("Synthetic item").length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });

  it("opens a contributed tab from the URL and passes orderId + area", async () => {
    handlers.set("orders.get", () => detail);
    renderDetail(`/orders/${ORDER_ID}/files`);
    expect(await screen.findByText(`Files tab for ${ORDER_ID} in customer`)).toBeInTheDocument();
  });

  it("transition requiring a note refuses to submit without one", async () => {
    handlers.set("orders.get", () => detail);
    handlers.set("orders.transition", () => ({ version: 4 }));
    const user = userEvent.setup();
    renderDetail(`/orders/${ORDER_ID}`);
    await user.click(await screen.findByRole("button", { name: "Cancel order" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel this order?" });
    await user.click(within(dialog).getByRole("button", { name: "Yes, cancel order" }));
    expect(await within(dialog).findByText("A note is required for this change.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "orders.transition")).toBe(false);
    await expectNoAxeViolations(dialog);
  });

  it("D14: a transition refused with AGREEMENT_REQUIRED opens the agreement; Not now explains; accepting resends the same request once", async () => {
    handlers.set("orders.get", () => detail);
    let attempts = 0;
    handlers.set("orders.transition", () => {
      attempts += 1;
      if (attempts <= 2)
        throw Object.assign(new Error("agreement"), {
          data: { safe: { domainCode: "CONFLICT", reasonCode: "AGREEMENT_REQUIRED", safeMessage: "Accept the order agreement first.", requestId: "r1", details: { policyPublicId: "01JTESTPOL0000000000000000", signatureMode: "typed_name" } } },
        });
      return { version: 4 };
    });
    const user = userEvent.setup();
    renderDetail(`/orders/${ORDER_ID}`);
    await user.click(await screen.findByRole("button", { name: "Cancel order" }));
    let dialog = await screen.findByRole("dialog", { name: "Cancel this order?" });
    await user.type(within(dialog).getByLabelText(/Note/), "No longer needed");
    await user.click(within(dialog).getByRole("button", { name: "Yes, cancel order" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Order agreement" })).getByRole("button", { name: "Not now" }));
    dialog = await screen.findByRole("dialog", { name: "Cancel this order?" });
    expect(within(dialog).getByText("The status was not changed. Accept the order agreement to continue.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Note/)).toHaveValue("No longer needed");
    await user.click(within(dialog).getByRole("button", { name: "Yes, cancel order" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Order agreement" })).getByRole("button", { name: "Accept agreement" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const sent = calls.filter((c) => c.path === "orders.transition").map((c) => c.input);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual(sent[0]);
    expect(sent[2]).toMatchObject({ orderId: ORDER_ID, toStatus: "canceled", note: "No longer needed" });
  });

  it("customer sees a verb action (not a state name); Keep order closes the dialog without a change", async () => {
    handlers.set("orders.get", () => detail);
    const user = userEvent.setup();
    renderDetail(`/orders/${ORDER_ID}`);
    const action = await screen.findByRole("button", { name: "Cancel order" });
    expect(screen.queryByRole("button", { name: "Canceled" })).not.toBeInTheDocument();
    await user.click(action);
    const dialog = await screen.findByRole("dialog", { name: "Cancel this order?" });
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent?.trim()).filter(Boolean)).toEqual(expect.arrayContaining(["Keep order", "Yes, cancel order"]));
    await user.click(within(dialog).getByRole("button", { name: "Keep order" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.some((c) => c.path === "orders.transition")).toBe(false);
  });

  it("unknown or forbidden orders show one indistinguishable error page", async () => {
    handlers.set("orders.get", () => {
      throw new Error("NOT_FOUND");
    });
    renderDetail(`/orders/${ORDER_ID}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Order unavailable" })).toBeInTheDocument();
  });

  it("sharing tab lists grants and invites with a uniform response", async () => {
    handlers.set("orders.get", () => detail);
    handlers.set("orders.sharing.list", () => [{ publicId: "01JTESTGRANT0000000000000B", email: "friend@example.test", role: "viewer", status: "active", acceptedAt: now, endedAt: null, endReasonCode: null, createdAt: now }]);
    handlers.set("orders.sharing.invite", () => ({ status: "pending" }));
    const user = userEvent.setup();
    const { container } = renderDetail(`/orders/${ORDER_ID}/sharing`);
    expect(await screen.findAllByText("friend@example.test")).not.toHaveLength(0);
    await expectNoAxeViolations(container);
    await user.type(screen.getByLabelText(/E-mail address/), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByText("Enter a valid e-mail address.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/E-mail address/));
    await user.type(screen.getByLabelText(/E-mail address/), "someone@example.test");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(calls.find((c) => c.path === "orders.sharing.invite")?.input).toEqual({ orderId: ORDER_ID, email: "someone@example.test", role: "viewer" }));
  });
});

describe("console", () => {
  it("admin order list renders filters and rows without axe violations", async () => {
    session.role = "staff";
    handlers.set("orders.admin.list", () => ({ items: [{ ...listItem, ownerName: "Synthetic Customer" }], nextCursor: null }));
    const { container } = renderUi(<AdminOrdersPage />, { path: "/admin/orders" });
    expect((await screen.findAllByRole("link", { name: "RP-2026-000001" }))[0]).toHaveAttribute("href", `/admin/orders/${ORDER_ID}`);
    await expectNoAxeViolations(container);
  });

  it("console transitions use unique verb labels and every confirm dialog has a Cancel button", async () => {
    session.role = "admin";
    const transitions = [
      { to: "in_review", label: "In review", actionLabel: "Move to In review", destructive: false, requiresNote: false },
      { to: "awaiting_customer", label: "Awaiting customer", actionLabel: "Move to Awaiting customer", destructive: false, requiresNote: true },
      { to: "in_progress", label: "In progress", actionLabel: "Move to In progress", destructive: false, requiresNote: false },
      { to: "canceled", label: "Canceled", actionLabel: "Cancel order", destructive: true, requiresNote: true },
    ];
    handlers.set("orders.admin.get", () => ({ ...detail, accessRole: "admin", transitions }));
    handlers.set("orders.admin.referenceHistory", () => []);
    const user = userEvent.setup();
    const { container } = renderUi(
      <Route path="/admin/orders/:orderId">
        <AdminOrderDetailPage />
      </Route>,
      { path: `/admin/orders/${ORDER_ID}` },
    );
    for (const name of ["Move to In review", "Move to Awaiting customer", "Move to In progress", "Cancel order"]) expect(await screen.findByRole("button", { name })).toBeInTheDocument();
    for (const name of ["In review", "Awaiting customer", "In progress", "Canceled"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Move to In review" }));
    let dialog = await screen.findByRole("dialog", { name: "Change status to “In review”?" });
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    await expectNoAxeViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    for (const action of ["Change lock", "Change reference", "Reassign customer"]) {
      await user.click(screen.getByRole("button", { name: action }));
      dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
    expect(calls.some((c) => c.path.startsWith("orders.admin.") && !c.path.endsWith("get") && !c.path.endsWith("referenceHistory"))).toBe(false);
  });

  it("change reference updates breadcrumb, subtitle and summary immediately and shows a toast", async () => {
    session.role = "admin";
    let current = { ...detail, accessRole: "admin", transitions: [] as typeof detail.transitions };
    handlers.set("orders.admin.get", () => current);
    handlers.set("orders.admin.referenceHistory", () => []);
    handlers.set("orders.admin.changeReference", (input) => {
      const { newReference } = input as { newReference: string };
      current = { ...current, reference: newReference, version: current.version + 1 };
      return { reference: newReference, version: current.version };
    });
    const user = userEvent.setup();
    renderUi(
      <Route path="/admin/orders/:orderId">
        <AdminOrderDetailPage />
      </Route>,
      { path: `/admin/orders/${ORDER_ID}` },
    );
    expect(await screen.findByText(/^RP-2026-000001 · /)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change reference" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/New reference/), "RP-QA-0001");
    await user.selectOptions(within(dialog).getByLabelText(/Reason/), "CORRECTION");
    await user.click(within(dialog).getByRole("button", { name: "Change reference" }));
    expect(await screen.findByText("Reference changed")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/^RP-QA-0001 · /)).toBeInTheDocument());
    expect(screen.queryByText(/^RP-2026-000001 · /)).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: /breadcrumb/i })).getByText("RP-QA-0001")).toBeInTheDocument();
    expect(screen.getAllByText("RP-QA-0001").length).toBeGreaterThanOrEqual(2); // breadcrumb + summary (subtitle asserted above)
    expect(calls.find((c) => c.path === "orders.admin.changeReference")?.input).toMatchObject({ orderId: ORDER_ID, expectedVersion: 3, newReference: "RP-QA-0001", reasonCode: "CORRECTION" });
  });

  it("console detail shows staff tabs and admin actions; reassignment requires typing the reference", async () => {
    session.role = "admin";
    handlers.set("orders.admin.get", () => ({ ...detail, accessRole: "admin", transitions: [] }));
    handlers.set("orders.admin.referenceHistory", () => [{ reference: "RP-2026-000001", status: "active", reasonCode: "CREATED", assignedAt: now, retiredAt: null }]);
    handlers.set("orders.stages.workspace", () => ({
      workflowFormat: 3, derived: false, currentStageKey: "intake",
      progress: { percent: 33, canceled: false, currentIndex: 1, total: 3, currentLabel: "Intake (staff)" },
      stages: [
        { key: "payment", customerLabel: "Payment", staffLabel: "Payment check" },
        { key: "intake", customerLabel: "Intake", staffLabel: "Intake (staff)" },
        { key: "delivery", customerLabel: "Delivery", staffLabel: "Delivery" },
      ],
    }));
    handlers.set("orders.admin.customerLookup", () => [{ publicId: "01JTESTUSER00000000000000B", name: "Synthetic Customer B", customerRef: null, emailMasked: "s***@example.test" }]);
    const user = userEvent.setup();
    const { container } = renderUi(
      <Route path="/admin/orders/:orderId">
        <AdminOrderDetailPage />
      </Route>,
      { path: `/admin/orders/${ORDER_ID}` },
    );
    await screen.findByRole("heading", { level: 1, name: "Synthetic project" });
    expect(within(screen.getByRole("tablist")).getByRole("tab", { name: "Billing (staff)" })).toBeInTheDocument();
    // Lead QA (7): dense progress under the console header, staff labels.
    expect(await screen.findByRole("progressbar", { name: "Order progress" })).toHaveAttribute("aria-valuenow", "33");
    expect(screen.getByText(/2 of 3: Intake \(staff\)/)).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Reassign customer" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Reassign order" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Type RP-2026-000001 to confirm"), "RP-2026-000001");
    // Still disabled until a new owner is picked from the customer search (no raw ID field).
    expect(within(dialog).getByRole("button", { name: "Reassign order" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Find new owner/), "Synthetic");
    await user.click(await within(dialog).findByRole("radio", { name: /Synthetic Customer B/ }));
    expect(within(dialog).getByText("s***@example.test")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Reassign order" })).toBeEnabled();
    await expectNoAxeViolations(dialog);
  });

  it("catalog page explains the empty catalog (no built-in products) without axe violations", async () => {
    session.role = "admin";
    handlers.set("orders.admin.catalog.list", () => []);
    const { container } = renderUi(<AdminCatalogPage />, { path: "/admin/catalog" });
    expect(await screen.findByText("The catalog is empty")).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("catalog page lists products and validates price input before saving", async () => {
    session.role = "admin";
    handlers.set("orders.admin.catalog.list", () => catalog);
    const user = userEvent.setup();
    const { container } = renderUi(<AdminCatalogPage />, { path: "/admin/catalog" });
    expect(await screen.findAllByText("Synthetic A")).not.toHaveLength(0);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: /Add product to Synthetic group/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Product key/), "synthetic-c");
    await user.type(within(dialog).getByLabelText(/^Name/), "Synthetic C");
    await user.type(within(dialog).getByLabelText(/^Price/), "12.345");
    await user.click(within(dialog).getByRole("button", { name: "Save product" }));
    expect(await within(dialog).findByText("Enter a price such as 125 or 125.50.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "orders.admin.catalog.createProduct")).toBe(false);
  });

  it("09 D2.7: administrators move an order to the trash from the detail (confirm, summary, no-refund note, reason) and return to the list", async () => {
    session.role = "admin";
    handlers.set("orders.admin.get", () => ({ ...detail, accessRole: "admin", transitions: [] }));
    handlers.set("orders.admin.referenceHistory", () => []);
    handlers.set("trash.summarize", () => ({ counts: { additions: 1, lineItems: 2 }, dueAt: "2026-12-27T12:00:00.000Z", cascadedOrders: 0, hasPayments: true }));
    handlers.set("trash.moveToTrash", () => ({ batchId: "01JTESTBATCH0000000000000A", dueAt: "2026-12-27T12:00:00.000Z", cascadedOrders: 0 }));
    const user = userEvent.setup();
    const { location } = renderUi(
      <Route path="/admin/orders/:orderId">
        <AdminOrderDetailPage />
      </Route>,
      { path: `/admin/orders/${ORDER_ID}` },
    );
    await user.click(await screen.findByRole("button", { name: "Move to trash" }));
    const dialog = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
    expect(within(dialog).getByText(/Move RP-2026-000001 · Synthetic project to the trash\?/)).toBeInTheDocument();
    expect(await within(dialog).findByText(/never refunds anything/)).toBeInTheDocument();
    await expectNoAxeViolations(dialog);
    const reason = within(dialog).getByRole("textbox");
    await user.type(reason, "Synthetic duplicate");
    await user.click(within(dialog).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(calls.find((c) => c.path === "trash.moveToTrash")?.input).toMatchObject({ kind: "order", publicId: ORDER_ID, reason: "Synthetic duplicate" }));
    await waitFor(() => expect(location.history?.at(-1)).toBe("/admin/orders"));
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("09 D2.7: the list row offers Move to trash to administrators only", async () => {
    handlers.set("orders.admin.list", () => ({ items: [{ ...listItem, ownerName: "Synthetic Customer" }], nextCursor: null }));
    session.role = "staff";
    const staffView = renderUi(<AdminOrdersPage />, { path: "/admin/orders" });
    await screen.findAllByRole("link", { name: "RP-2026-000001" });
    expect(screen.queryByRole("button", { name: /Move to trash/ })).not.toBeInTheDocument();
    staffView.unmount();
    session.role = "admin";
    const { container } = renderUi(<AdminOrdersPage />, { path: "/admin/orders" });
    expect((await screen.findAllByRole("button", { name: "Move to trash: RP-2026-000001" })).length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });

  it("09 D2.7 focus: Cancel returns focus to the row action; a successful row move focuses the results region", async () => {
    session.role = "admin";
    let items = [{ ...listItem, ownerName: "Synthetic Customer" }];
    handlers.set("orders.admin.list", () => ({ items, nextCursor: null }));
    handlers.set("trash.summarize", () => ({ counts: {}, dueAt: null, cascadedOrders: 0, hasPayments: false }));
    handlers.set("trash.moveToTrash", () => {
      items = [];
      return { batchId: "01JTESTBATCH0000000000000A", dueAt: null, cascadedOrders: 0 };
    });
    const user = userEvent.setup();
    renderUi(<AdminOrdersPage />, { path: "/admin/orders" });
    const opener = (await screen.findAllByRole("button", { name: "Move to trash: RP-2026-000001" }))[0]!;
    await user.click(opener);
    let dialog = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
    await user.click(opener);
    dialog = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
    await user.click(within(dialog).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Order results" })).toHaveFocus());
  });

  // The workflows pages (list, designer, versions) are covered in pages/workflows/workflows.test.tsx.
});

describe("console orders pipeline widget", () => {
  it("shows per-status counts (N+ when capped), newest orders with links, one heading, and no axe violations", async () => {
    session.role = "staff";
    handlers.set("orders.admin.list", (input) => {
      const { status } = input as { status?: string };
      if (status === "submitted") return { items: [{ ...listItem, ownerName: "Synthetic Customer" }], nextCursor: null };
      if (status === "in_review") return { items: [{ ...listItem, statusKey: "in_review", statusLabel: "In review" }], nextCursor: "next" };
      if (status) return { items: [], nextCursor: null };
      return { items: [{ ...listItem, ownerName: "Synthetic Customer" }], nextCursor: null };
    });
    const { container } = renderUi(<OrdersPipelineWidget />, { path: "/admin" });
    expect(await screen.findByRole("link", { name: "RP-2026-000001" })).toHaveAttribute("href", `/admin/orders/${ORDER_ID}`);
    expect(screen.getByRole("link", { name: "All orders" })).toHaveAttribute("href", "/admin/orders");
    expect(screen.getByRole("link", { name: "1+ In review orders" })).toHaveAttribute("href", "/admin/orders?status=in_review");
    expect(screen.getByRole("link", { name: "0 Awaiting customer orders" })).toBeInTheDocument();
    // WCAG 2.5.8: each count link keeps a target of at least 24x24 CSS px.
    expect(screen.getByRole("link", { name: "0 Awaiting customer orders" })).toHaveClass("inline-flex", "min-h-6", "min-w-6");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(calls.filter((c) => c.path === "orders.admin.list")).toHaveLength(5);
    await expectNoAxeViolations(container);
  });

  it("shows an error state, never zero counts, when any read fails", async () => {
    session.role = "staff";
    handlers.set("orders.admin.list", (input) => {
      if ((input as { status?: string }).status === "in_progress") throw new Error("boom");
      return { items: [], nextCursor: null };
    });
    renderUi(<OrdersPipelineWidget />, { path: "/admin" });
    expect(await screen.findByText("We couldn't load the orders pipeline")).toBeInTheDocument();
    expect(screen.queryByText("No orders have been placed yet.")).not.toBeInTheDocument();
  });

  it("shows an honest empty state and is gated to staff with orders.read_all", async () => {
    session.role = "staff";
    handlers.set("orders.admin.list", () => ({ items: [], nextCursor: null }));
    renderUi(<OrdersPipelineWidget />, { path: "/admin" });
    expect(await screen.findByText("No orders have been placed yet.")).toBeInTheDocument();
    expect(ordersFeature.widgets?.find((w) => w.key === "orders.pipeline")).toMatchObject({ area: "console", access: "staff", capability: "orders.read_all", span: 8 });
  });

  it("admin order list honours ?status= deep links from the overview", async () => {
    session.role = "staff";
    handlers.set("orders.admin.list", () => ({ items: [], nextCursor: null }));
    renderUi(<AdminOrdersPage />, { path: "/admin/orders?status=in_review" });
    await waitFor(() => expect(calls.find((c) => c.path === "orders.admin.list")?.input).toMatchObject({ status: "in_review" }));
  });
});

describe("increment 02 display", () => {
  it("order detail shows tier, outcome, timeline, deliverables and the subtotal/discount/total", async () => {
    handlers.set("orders.get", () => ({
      ...detail,
      subtotalMinor: 16500,
      discountMinor: 1650,
      discountLabel: "Synthetic bundle",
      totalMinor: 14850,
      lineItems: [
        {
          ...detail.lineItems[0]!,
          name: "Synthetic Packet 41 - Premium",
          packetNumber: 41,
          tier: "Premium",
          outcome: "Synthetic outcome",
          timeline: "1 - 2 synthetic days",
          deliverables: [
            { title: "Synthetic deliverable one", detail: "Synthetic detail" },
            { title: "Synthetic deliverable two", detail: "" },
          ],
          quantity: 1,
          unitPriceMinor: 16500,
          lineTotalMinor: 16500,
        },
      ],
    }));
    const user = userEvent.setup();
    const { container } = renderUi(
      <Route path="/orders/:orderId">
        <OrderDetailPage />
      </Route>,
      { path: `/orders/${ORDER_ID}` },
    );
    await user.click(await screen.findByRole("button", { name: "Order details" }));
    expect((await screen.findAllByText("Premium")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 - 2 synthetic days").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Synthetic outcome/).length).toBeGreaterThan(0);
    expect(screen.getByText("Subtotal").parentElement).toHaveTextContent("$165.00");
    expect(screen.getByText("Synthetic bundle").parentElement).toHaveTextContent("$16.50");
    const toggle = screen.getAllByText(/2 deliverables/)[0]!;
    await user.click(toggle);
    expect(screen.getAllByText("Synthetic deliverable one").length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });

  it("admin catalog shows packet groups and tiers, saves packet fields and edits the bundle rule", async () => {
    session.role = "admin";
    handlers.set("orders.admin.catalog.list", () => packetCatalog);
    handlers.set("orders.admin.catalog.updateProduct", () => ({ publicId: "x", versionNumber: 2, rowVersion: 2 }));
    handlers.set("orders.admin.catalog.updateBundleRule", (input) => (input as { rule: unknown }).rule);
    const user = userEvent.setup();
    const { container } = renderUi(<AdminCatalogPage />, { path: "/admin/catalog" });
    expect((await screen.findAllByText("Packet 41")).length).toBeGreaterThan(0);
    expect(await screen.findByText(/No bundle discount is applied/)).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.click(screen.getAllByRole("button", { name: /Edit Synthetic Packet 41 - Basic/ })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/^Tier/)).toHaveValue("Basic");
    expect(within(dialog).getByLabelText(/^Deliverables/)).toHaveValue("Synthetic deliverable | Synthetic detail");
    await user.clear(within(dialog).getByLabelText(/^Timeline/));
    await user.type(within(dialog).getByLabelText(/^Timeline/), "3 - 4 synthetic days");
    await expectNoAxeViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Save product" }));
    await waitFor(() => expect(calls.find((c) => c.path === "orders.admin.catalog.updateProduct")?.input).toMatchObject({ packetNumber: 41, tier: "Basic", timeline: "3 - 4 synthetic days", deliverables: [{ title: "Synthetic deliverable", detail: "Synthetic detail" }] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit bundle discount" }));
    const ruleDialog = await screen.findByRole("dialog");
    await user.click(within(ruleDialog).getByLabelText("Apply the bundle discount"));
    await user.click(within(ruleDialog).getByRole("button", { name: "Save bundle discount" }));
    expect(await within(ruleDialog).findByText(/To turn the discount on/)).toBeInTheDocument();
    await user.type(within(ruleDialog).getByLabelText(/Required packets/), "42, 41");
    await user.clear(within(ruleDialog).getByLabelText(/Discount/));
    await user.type(within(ruleDialog).getByLabelText(/Discount/), "10");
    await user.type(within(ruleDialog).getByLabelText(/^Label/), "Synthetic bundle");
    await expectNoAxeViolations(ruleDialog);
    await user.click(within(ruleDialog).getByRole("button", { name: "Save bundle discount" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "orders.admin.catalog.updateBundleRule")?.input).toEqual({
        rule: { enabled: true, requiredPacketNumbers: [41, 42], discountPercent: 10, label: "Synthetic bundle" },
      }),
    );
    expect(await screen.findByText(/10% off the order subtotal/)).toBeInTheDocument();
  });

  it("parses deliverables and packet number lists", () => {
    expect(parseDeliverables("A | one\n\nB\n C | two | three ")).toEqual([
      { title: "A", detail: "one" },
      { title: "B", detail: "" },
      { title: "C", detail: "two | three" },
    ]);
    expect(parsePacketNumbers("3, 1 2,2")).toEqual([1, 2, 3]);
    expect(parsePacketNumbers("1, x")).toBeNull();
    expect(parsePacketNumbers("")).toEqual([]);
  });
});

describe("dashboard widget and helpers", () => {
  it("recent orders widget renders without axe violations", async () => {
    handlers.set("orders.list", () => ({ items: [listItem], nextCursor: null }));
    const { container } = renderUi(<RecentOrdersWidget />);
    expect(await screen.findByRole("link", { name: "Synthetic project" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("07.1 D4: the empty widget's Start an order points staff/admin to the console dialog", async () => {
    handlers.set("orders.list", () => ({ items: [], nextCursor: null }));
    const first = renderUi(<RecentOrdersWidget />);
    expect(await screen.findByRole("link", { name: "Start an order" })).toHaveAttribute("href", "/orders/new");
    first.unmount();
    session.role = "admin";
    renderUi(<RecentOrdersWidget />);
    expect(await screen.findByRole("link", { name: "New order for a customer" })).toHaveAttribute("href", "/admin/orders?new=1");
  });

  it("money parsing is exact and idempotency keys are random and well-formed", () => {
    expect(parseAmountToMinor("125")).toBe(12500);
    expect(parseAmountToMinor("125.5")).toBe(12550);
    expect(parseAmountToMinor("0.07")).toBe(7);
    expect(parseAmountToMinor("1.005")).toBeNull();
    expect(parseAmountToMinor("-1")).toBeNull();
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });
});

describe("increment 04 part B — console order workspace (S1)", () => {
  const consoleDetail = (over: Record<string, unknown> = {}) => ({
    ...detail,
    accessRole: "admin",
    transitions: [],
    console: { customer: { publicId: "01JTESTUSER00000000000000A", name: "Synthetic Customer", customerRef: null }, payment: { state: "paid", totalMinor: 2500, currency: "USD" } },
    ...over,
  });
  const renderConsole = (path = `/admin/orders/${ORDER_ID}`) =>
    renderUi(
      <>
        <Route path="/admin/orders/:orderId">
          <AdminOrderDetailPage />
        </Route>
        <Route path="/admin/orders/:orderId/:tab">
          <AdminOrderDetailPage />
        </Route>
      </>,
      { path },
    );
  const setup = () => {
    session.role = "admin";
    let current = consoleDetail();
    handlers.set("orders.admin.get", () => current);
    handlers.set("orders.admin.referenceHistory", () => []);
    handlers.set("orders.console.rename", (input) => {
      const { name } = input as { name: string };
      current = { ...current, projectName: name, version: current.version + 1 };
      return { version: current.version, changed: true };
    });
  };

  it("header shows reference · customer · placed date, status/lock/payment/total badges and the B1 action row in order", async () => {
    setup();
    renderConsole();
    await screen.findByRole("heading", { level: 1, name: "Synthetic project" });
    expect(screen.getByText(/^RP-2026-000001 · Synthetic Customer · placed /)).toBeInTheDocument();
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getAllByText(/^Total/).length).toBeGreaterThan(0);
    const group = screen.getByRole("group", { name: "Order actions" });
    const names = Array.from(group.querySelectorAll("a, button")).map((el) => el.textContent?.trim());
    expect(names.slice(0, 5)).toEqual(["Rename order", "Change reference", "Reassign customer", "Invoice", "Refund"]);
    expect(within(group).getByRole("link", { name: "Invoice" })).toHaveAttribute("href", `/admin/orders/${ORDER_ID}/invoices`);
    expect(within(group).getByRole("link", { name: "Refund" })).toHaveAttribute("href", `/admin/orders/${ORDER_ID}/refund`);
  });

  it("tabs follow the published order (built-in and contributed share one ordering); /activity opens Notes", async () => {
    setup();
    renderConsole(`/admin/orders/${ORDER_ID}/activity`);
    await screen.findByRole("heading", { level: 1, name: "Synthetic project" });
    const tabs = within(screen.getByRole("tablist", { name: "Order sections" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Overview", "Phases", "Files", "Billing (staff)", "Notes", "Sharing"]);
    expect(screen.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("href", `/admin/orders/${ORDER_ID}/files`);
  });

  it("renders contributed order banners between header and tabs, filtered by area", async () => {
    setup();
    renderConsole();
    expect(await screen.findByText(`Gate banner for ${ORDER_ID} in console`)).toBeInTheDocument();
    expect(screen.getByText("Console only banner")).toBeInTheDocument();
    handlers.set("orders.get", () => detail);
    session.role = "customer";
  });

  it("customer order page shows only customer/both banners, before the requirements checklist", async () => {
    handlers.set("orders.get", () => detail);
    handlers.set("orders.requirements.forOrder", () => ({
      phases: [],
      status: { key: "submitted", label: "Submitted", phaseKey: null },
      uploads: [{ key: "brief", label: "Synthetic brief", hint: null, kind: "document", minCount: 1, maxCount: 1, allowedTypes: ["pdf"], uploadedBy: ["customer"], count: 0, met: false, canUpload: true }],
      acknowledgements: [],
      unmet: 1,
      readOnly: false,
      readOnlyReason: null,
      canUnlock: false,
      acceptancePending: true,
    }));
    renderUi(
      <Route path="/orders/:orderId">
        <OrderDetailPage />
      </Route>,
      { path: `/orders/${ORDER_ID}` },
    );
    expect(await screen.findByText(`Gate banner for ${ORDER_ID} in customer`)).toBeInTheDocument();
    expect(screen.queryByText("Console only banner")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Order actions" })).not.toBeInTheDocument();
    // The blocking gate comes first, then the checklist it pauses.
    const checklist = await screen.findByRole("heading", { name: "Needed before the next step (Submitted)" });
    const banner = screen.getByText(`Gate banner for ${ORDER_ID} in customer`);
    expect(banner.compareDocumentPosition(checklist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Rename order: keyboard opens the dialog, Escape returns focus to the button, saving keeps the reference", async () => {
    setup();
    const user = userEvent.setup();
    renderConsole();
    await screen.findByRole("heading", { level: 1, name: "Synthetic project" });
    const button = screen.getByRole("button", { name: "Rename order" });
    button.focus();
    await user.keyboard("{Enter}");
    let dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText(/Order name/);
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await expectNoAxeViolations(dialog);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(calls.some((c) => c.path === "orders.console.rename")).toBe(false);
    expect(field).not.toBeInTheDocument();

    await user.click(button);
    dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText(/Order name/);
    await user.clear(input);
    await user.click(within(dialog).getByRole("button", { name: "Save name" }));
    expect(await within(dialog).findByText("Enter a name for the order.")).toBeInTheDocument();
    await user.type(input, "Renamed synthetic");
    await user.click(within(dialog).getByRole("button", { name: "Save name" }));
    expect(await screen.findByText("Order renamed")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Renamed synthetic" })).toBeInTheDocument();
    expect(screen.getByText(/^RP-2026-000001 · /)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "orders.console.rename")?.input).toEqual({ orderId: ORDER_ID, expectedVersion: 3, name: "Renamed synthetic" });
  });

  it("staff without admin see Rename but not the admin-only reference/reassign actions", async () => {
    setup();
    session.role = "staff";
    renderConsole();
    await screen.findByRole("heading", { level: 1, name: "Synthetic project" });
    const group = screen.getByRole("group", { name: "Order actions" });
    expect(within(group).getByRole("button", { name: "Rename order" })).toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: "Change reference" })).not.toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: "Reassign customer" })).not.toBeInTheDocument();
  });
});

describe("console order workspace — page axe (light & dark)", () => {
  const prepare = async (openDialog: boolean) => {
    session.role = "admin";
    handlers.set("orders.admin.get", () => ({
      ...detail,
      accessRole: "admin",
      transitions: [],
      console: { customer: { publicId: "01JTESTUSER00000000000000A", name: "Synthetic Customer", customerRef: null }, payment: { state: "unpaid", totalMinor: 2500, currency: "USD" } },
    }));
    handlers.set("orders.admin.referenceHistory", () => []);
    document.title = "Synthetic project · Orders";
    renderUi(
      <main>
        <Route path="/admin/orders/:orderId">
          <AdminOrderDetailPage />
        </Route>
      </main>,
      { path: `/admin/orders/${ORDER_ID}` },
    );
    await screen.findByRole("heading", { level: 1, name: "Synthetic project" });
    if (openDialog) {
      await userEvent.click(screen.getByRole("button", { name: "Rename order" }));
      await screen.findByRole("dialog");
    }
  };
  pageA11y("console order page", () => prepare(false));
  pageA11y("console order page with Rename dialog open", () => prepare(true));
});
