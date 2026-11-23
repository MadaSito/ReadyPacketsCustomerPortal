import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import { AdminCartUpsellsPage, type AdminUpsellOfferRow } from "./AdminCartUpsellsPage";

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

const sampleCatalogProducts = [
  {
    productPublicId: "01JQAPROD00000000000000001",
    name: "Packet 01 - Basic",
    groupName: "Packet 01",
    packetNumber: 1,
    tier: "Basic" as const,
    priceMinor: 25000,
    currency: "USD",
    active: true,
    canBeTierUpgradeTarget: false,
  },
  {
    productPublicId: "01JQAPROD00000000000000002",
    name: "Packet 01 - Premium",
    groupName: "Packet 01",
    packetNumber: 1,
    tier: "Premium" as const,
    priceMinor: 45000,
    currency: "USD",
    active: true,
    canBeTierUpgradeTarget: true,
  },
  {
    productPublicId: "01JQAPROD00000000000000003",
    name: "Priority onboarding session",
    groupName: "Add-ons",
    packetNumber: null,
    tier: null,
    priceMinor: 15000,
    currency: "USD",
    active: true,
    canBeTierUpgradeTarget: false,
  },
];

function sampleOffer(
  offerPublicId: string,
  overrides: Partial<AdminUpsellOfferRow> = {},
): AdminUpsellOfferRow {
  const now = new Date("2026-11-22T12:00:00Z");
  return {
    offerPublicId,
    seedKey: null,
    ruleType: "standard",
    version: 2,
    kind: "add_on",
    title: "Add priority onboarding",
    shortText: "Dedicated 60-minute onboarding walkthrough with a specialist.",
    triggerMode: "any_cart",
    triggerProductPublicIds: [],
    triggerProductNames: [],
    targetProductPublicId: "01JQAPROD00000000000000003",
    targetProductName: "Priority onboarding session",
    targetProductAvailable: true,
    targetProductPriceMinor: 15000,
    targetProductCurrency: "USD",
    priority: 100,
    active: true,
    startsAt: null,
    endsAt: null,
    shownCount: 42,
    acceptedCount: 9,
    dismissedCount: 5,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeListResponse(
  offers: AdminUpsellOfferRow[] = [
    sampleOffer("01JQAUPSELL000000000000001"),
    sampleOffer("01JQAUPSELL000000000000002", {
      seedKey: "seed:v1:tier_upgrade:p1:Basic:Premium",
      kind: "tier_upgrade",
      title: "Step up to Packet 01 Premium",
      shortText: "Includes board-ready executive summary and custom mapping.",
      triggerMode: "products",
      triggerProductPublicIds: ["01JQAPROD00000000000000001"],
      triggerProductNames: ["Packet 01 - Basic"],
      targetProductPublicId: "01JQAPROD00000000000000002",
      targetProductName: "Packet 01 - Premium",
      targetProductPriceMinor: 45000,
      priority: 40,
      active: false,
      shownCount: 18,
      acceptedCount: 4,
      dismissedCount: 2,
    }),
  ],
  overrides: Partial<ReturnType<typeof baseMeta>> = {},
) {
  return {
    ...baseMeta(),
    ...overrides,
    offers,
  };
}

function baseMeta() {
  return {
    featureCartEnabled: true,
    featureUpsellEnabled: false,
    bundleRuleEnabled: true,
    bundleRuleLabel: "Full Governance Suite (15% off)",
    catalogProducts: sampleCatalogProducts,
  };
}

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  handlers.set("platform.bootstrap", () => ({
    features: { cart: true },
    consent: { enabled: false, policyVersion: 1, renewMonths: 12 },
  }));
});

describe("AdminCartUpsellsPage (/admin/carts/suggestions)", () => {
  it("renders aggregated counters, page-level switch, and filters offers cleanly", async () => {
    handlers.set("cart.admin.upsells.list", () => makeListResponse());

    const user = userEvent.setup();
    renderUi(<AdminCartUpsellsPage />, { path: "/admin/carts/suggestions" });

    expect(await screen.findByRole("heading", { level: 1, name: "Cart suggestions" })).toBeInTheDocument();
    const pageSwitch = await screen.findByRole("switch", { name: "Show suggestions in the cart" });
    expect(pageSwitch).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Add suggested offers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable all" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable all" })).toBeInTheDocument();

    // Aggregated StatCard counters: Shown 42+18=60, Accepted 9+4=13, Dismissed 5+2=7
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText("13")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();

    // Filter by search
    const searchInput = screen.getByRole("searchbox", { name: "Search cart suggestions" });
    await user.type(searchInput, "nonexistent offer{Enter}");
    expect(await screen.findByText("No matching cart suggestions")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /Clear filters/i })[0]!);
    expect((await screen.findAllByText("Add priority onboarding")).length).toBeGreaterThan(0);
  });

  it("supports D3 page-level switch (offering feature.cart when off), Enable all, Disable all, Add suggested offers, and Duplicate", async () => {
    let featureCartEnabled = false;
    let featureUpsellEnabled = false;
    let offers = makeListResponse().offers;

    handlers.set("cart.admin.upsells.list", () =>
      makeListResponse(offers, { featureCartEnabled, featureUpsellEnabled }),
    );
    handlers.set("cart.admin.upsells.setFeature", (raw) => {
      const input = raw as { enabled: boolean; alsoEnableCart?: boolean };
      featureUpsellEnabled = input.enabled;
      if (input.alsoEnableCart) featureCartEnabled = true;
      return { featureUpsellEnabled, featureCartEnabled };
    });
    handlers.set("cart.admin.upsells.setAllActive", (raw) => {
      const input = raw as { active: boolean };
      offers = offers.map((o) => ({ ...o, active: input.active, version: o.version + 1 }));
      return { updatedCount: offers.length };
    });
    handlers.set("cart.admin.upsells.seedSuggested", () => {
      const seededBundle = sampleOffer("01JQAUPSELL000000000000099", {
        seedKey: "seed:v1:bundle_completion:default",
        ruleType: "bundle_completion",
        title: "Complete the Full Governance Suite (save 15%)",
        shortText: "Add your remaining packets to unlock the automatic 15% bundle discount.",
        targetProductName: "Missing bundle packets (dynamic)",
        active: false,
      });
      offers = [...offers, seededBundle];
      return { addedCount: 1, skippedExistingCount: 2, totalOffers: offers.length };
    });
    handlers.set("cart.admin.upsells.duplicate", (raw) => {
      const input = raw as { offerPublicId: string };
      const src = offers.find((o) => o.offerPublicId === input.offerPublicId)!;
      const dup = sampleOffer("01JQAUPSELL000000000000088", {
        ...src,
        offerPublicId: "01JQAUPSELL000000000000088",
        seedKey: null,
        title: `${src.title} (copy)`,
        active: false,
        version: 1,
      });
      offers = [...offers, dup];
      return dup;
    });

    const user = userEvent.setup();
    renderUi(<AdminCartUpsellsPage />, { path: "/admin/carts/suggestions" });

    const pageSwitch = await screen.findByRole("switch", { name: "Show suggestions in the cart" });
    await user.click(pageSwitch);

    // Since featureCartEnabled is false, dialog offers enabling shopping cart as well
    expect(await screen.findByRole("dialog", { name: "Turn on shopping cart as well?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Enable cart and suggestions" }));

    await waitFor(() => {
      expect(calls.find((c) => c.path === "cart.admin.upsells.setFeature")?.input).toEqual({
        enabled: true,
        alsoEnableCart: true,
      });
    });

    await user.click(screen.getByRole("button", { name: "Add suggested offers" }));
    expect((await screen.findAllByText("Complete the Full Governance Suite (save 15%)")).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Enable all" }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "cart.admin.upsells.setAllActive")).toBe(true);
    });

    await user.click(screen.getAllByRole("button", { name: "Duplicate: Add priority onboarding" })[0]!);
    expect((await screen.findAllByText("Add priority onboarding (copy)")).length).toBeGreaterThan(0);
  });

  it("filters tier_upgrade target products to higher packet tiers only and creates/edits/toggles/deletes offers", async () => {
    let offers = makeListResponse().offers;
    handlers.set("cart.admin.upsells.list", () => makeListResponse(offers));
    handlers.set("cart.admin.upsells.create", (raw) => {
      const input = raw as {
        kind: "add_on" | "tier_upgrade";
        title: string;
        shortText: string;
        triggerMode: "any_cart" | "products";
        triggerProductPublicIds: string[];
        targetProductPublicId: string;
        priority: number;
      };
      const created = sampleOffer("01JQAUPSELL000000000000009", {
        kind: input.kind,
        title: input.title,
        shortText: input.shortText,
        triggerMode: input.triggerMode,
        triggerProductPublicIds: input.triggerProductPublicIds,
        targetProductPublicId: input.targetProductPublicId,
        targetProductName: "Packet 01 - Premium",
        priority: input.priority,
      });
      offers = [...offers, created];
      return created;
    });
    handlers.set("cart.admin.upsells.update", (raw) => {
      const input = raw as { offerPublicId: string; expectedVersion: number; title: string };
      expect(input.offerPublicId).toBe("01JQAUPSELL000000000000001");
      expect(input.expectedVersion).toBe(2);
      const updated = sampleOffer("01JQAUPSELL000000000000001", { title: input.title, version: 3 });
      offers = offers.map((o) => (o.offerPublicId === input.offerPublicId ? updated : o));
      return updated;
    });
    handlers.set("cart.admin.upsells.setActive", (raw) => {
      const input = raw as { offerPublicId: string; expectedVersion: number; active: boolean };
      expect(input).toEqual({
        offerPublicId: "01JQAUPSELL000000000000001",
        expectedVersion: 3,
        active: false,
      });
      const updated = sampleOffer("01JQAUPSELL000000000000001", {
        title: "Add priority onboarding — updated",
        active: false,
        version: 4,
      });
      offers = offers.map((o) => (o.offerPublicId === input.offerPublicId ? updated : o));
      return updated;
    });
    handlers.set("cart.admin.upsells.delete", (raw) => {
      const input = raw as { offerPublicId: string };
      offers = offers.filter((o) => o.offerPublicId !== input.offerPublicId);
      return { deleted: true, offerPublicId: input.offerPublicId };
    });

    const user = userEvent.setup();
    renderUi(<AdminCartUpsellsPage />, { path: "/admin/carts/suggestions" });
    expect(await screen.findByRole("heading", { level: 1, name: "Cart suggestions" })).toBeInTheDocument();

    // Open New suggestion dialog
    await user.click(screen.getByRole("button", { name: "New suggestion" }));
    expect(await screen.findByRole("dialog", { name: "New cart suggestion" })).toBeInTheDocument();

    // Switch kind to tier_upgrade -> only Packet 01 - Premium (canBeTierUpgradeTarget=true) is offered
    await user.selectOptions(screen.getByLabelText(/Suggestion kind/i), "tier_upgrade");
    const targetSelect = screen.getByLabelText(/Target product/i) as HTMLSelectElement;
    const optionValues = Array.from(targetSelect.options)
      .map((o) => o.value)
      .filter(Boolean);
    expect(optionValues).toEqual(["01JQAPROD00000000000000002"]);

    await user.type(screen.getByLabelText(/^Title/i), "Upgrade Packet 01 to Premium");
    await user.type(
      screen.getByLabelText(/Short description/i),
      "Unlock executive board deck and custom controls mapping.",
    );
    await user.selectOptions(targetSelect, "01JQAPROD00000000000000002");
    await user.selectOptions(screen.getByLabelText(/Trigger condition/i), "products");
    await user.click(screen.getByRole("checkbox", { name: "Packet 01: Packet 01 - Basic" }));
    await user.click(screen.getByRole("button", { name: "Create suggestion" }));

    await waitFor(() => {
      expect(calls.some((c) => c.path === "cart.admin.upsells.create")).toBe(true);
    });

    // Edit first offer (optimistic concurrency expectedVersion = 2)
    await user.click(screen.getAllByRole("button", { name: "Edit: Add priority onboarding" })[0]!);
    expect(await screen.findByRole("dialog", { name: "Edit cart suggestion" })).toBeInTheDocument();
    const editTitleInput = screen.getByLabelText(/^Title/i);
    await user.clear(editTitleInput);
    await user.type(editTitleInput, "Add priority onboarding — updated");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "cart.admin.upsells.update")).toBe(true);
    });

    // Deactivate first offer via per-row Switch (now version 3)
    const rowSwitches = await screen.findAllByRole("switch", {
      name: "Disable: Add priority onboarding — updated",
    });
    await user.click(rowSwitches[0]!);
    await waitFor(() => {
      expect(calls.some((c) => c.path === "cart.admin.upsells.setActive")).toBe(true);
    });

    // Delete first offer via ConfirmDialog (role="alertdialog")
    await user.click(
      screen.getAllByRole("button", { name: "Delete: Add priority onboarding — updated" })[0]!,
    );
    expect(await screen.findByRole("alertdialog", { name: "Delete cart suggestion?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete suggestion" }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "cart.admin.upsells.delete")).toBe(true);
    });
  });

  pageA11y("admin cart suggestions list view", async () => {
    document.title = "Cart suggestions · ReadyPackets";
    handlers.set("cart.admin.upsells.list", () => makeListResponse());
    renderUi(
      <main>
        <AdminCartUpsellsPage />
      </main>,
      { path: "/admin/carts/suggestions" },
    );
    await screen.findByRole("heading", { level: 1, name: "Cart suggestions" });
    await screen.findAllByText("Add priority onboarding");
  });

  pageA11y("admin cart suggestions enable-cart prompt dialog open", async () => {
    document.title = "Cart suggestions · ReadyPackets";
    handlers.set("cart.admin.upsells.list", () => makeListResponse(undefined, { featureCartEnabled: false }));
    const user = userEvent.setup();
    renderUi(
      <main>
        <AdminCartUpsellsPage />
      </main>,
      { path: "/admin/carts/suggestions" },
    );
    await user.click(await screen.findByRole("switch", { name: "Show suggestions in the cart" }));
    await screen.findByRole("dialog", { name: "Turn on shopping cart as well?" });
  });

  pageA11y("admin cart suggestions create dialog open with trigger products fieldset", async () => {
    document.title = "Cart suggestions · ReadyPackets";
    handlers.set("cart.admin.upsells.list", () => makeListResponse());
    const user = userEvent.setup();
    renderUi(
      <main>
        <AdminCartUpsellsPage />
      </main>,
      { path: "/admin/carts/suggestions" },
    );
    await screen.findByRole("heading", { level: 1, name: "Cart suggestions" });
    await user.click(screen.getByRole("button", { name: "New suggestion" }));
    await screen.findByRole("dialog", { name: "New cart suggestion" });
    await user.selectOptions(screen.getByLabelText(/Trigger condition/i), "products");
    await screen.findByRole("group", { name: "Trigger products" });
  });

  pageA11y("admin cart suggestions delete confirmation dialog open", async () => {
    document.title = "Cart suggestions · ReadyPackets";
    handlers.set("cart.admin.upsells.list", () => makeListResponse());
    const user = userEvent.setup();
    renderUi(
      <main>
        <AdminCartUpsellsPage />
      </main>,
      { path: "/admin/carts/suggestions" },
    );
    await screen.findAllByText("Add priority onboarding");
    await user.click(screen.getAllByRole("button", { name: "Delete: Add priority onboarding" })[0]!);
    await screen.findByRole("alertdialog", { name: "Delete cart suggestion?" });
  });
});
