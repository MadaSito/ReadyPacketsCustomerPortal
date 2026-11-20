import { fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { ReactNode } from "react";
import type { AppRouter } from "@server/trpc/root";
import type * as trpcModule from "@/lib/trpc";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import { useOrderQuote, bundleHint, isPacketCatalog, nonPacketGroups, PacketPicker, packetItems, PacketSummary, type OrderQuote, type PickerGroup, type PacketTier } from "./index";

const { quoteFn } = vi.hoisted(() => ({ quoteFn: vi.fn() }));
vi.mock("@/lib/trpc", async (original) => ({
  ...(await original<typeof trpcModule>()),
  useTRPC: () => ({ orders: { quote: { queryOptions: (input: unknown, opts: object) => ({ queryKey: ["orders.quote", input], queryFn: () => quoteFn(input), ...opts }) } } }),
}));

// Compile-time: the router's catalog.list output satisfies the picker's structural input type.
type CatalogList = inferRouterOutputs<AppRouter>["orders"]["catalog"]["list"];
export const catalogFitsPicker = (groups: CatalogList): readonly PickerGroup[] => groups;

const PRICES: Record<PacketTier, number> = { Basic: 45000, Standard: 135000, Premium: 250000 };
const packet = (n: number, name: string): PickerGroup => ({
  publicId: `g${n}`,
  name,
  description: `Short description of ${name}`,
  packetNumber: n,
  products: (["Premium", "Basic", "Standard"] as const).map((tier) => ({
    publicId: `p${n}-${tier.toLowerCase()}`,
    name: `${name} — ${tier}`,
    priceMinor: PRICES[tier] + n,
    currency: "USD",
    packetNumber: n,
    tier,
    outcome: `${tier} outcome for ${name}`,
    timeline: tier === "Basic" ? "48-72 hours" : "4 - 6 business days",
    deliverables: [{ title: `${tier} deliverable ${n}`, detail: `Detail of ${tier} deliverable` }],
  })),
});
const GROUPS: PickerGroup[] = [packet(2, "Market & Product Validation"), packet(1, "Idea & IP Protection")];
const OTHER: PickerGroup = { publicId: "gx", name: "Extras", description: "", packetNumber: null, products: [{ publicId: "x1", name: "Rush review", priceMinor: 1000, currency: "USD", packetNumber: null, tier: null, outcome: "", timeline: "", deliverables: [] }] };

function Harness({ onChange }: { onChange?: (s: Record<number, string | null>) => void }) {
  const [selection, setSelection] = useState<Record<number, string | null>>({});
  return (
    <>
      <h2>Choose items</h2>
      <PacketPicker
        groups={[...GROUPS, OTHER]}
        selection={selection}
        onChange={(next) => {
          setSelection(next);
          onChange?.(next);
        }}
      />
    </>
  );
}

describe("packet model", () => {
  it("detects packet catalogs, keeps non-packet groups apart and builds quantity-1 items in packet order", () => {
    expect(isPacketCatalog([OTHER])).toBe(false);
    expect(isPacketCatalog(GROUPS)).toBe(true);
    expect(nonPacketGroups([...GROUPS, OTHER]).map((g) => g.publicId)).toEqual(["gx"]);
    expect(packetItems({ 2: "p2-basic", 1: "p1-premium" }, GROUPS)).toEqual([
      { productPublicId: "p1-premium", quantity: 1 },
      { productPublicId: "p2-basic", quantity: 1 },
    ]);
    expect(packetItems({ 1: null, 2: "p2-basic" })).toEqual([{ productPublicId: "p2-basic", quantity: 1 }]);
    // A stale id that is not a tier of that packet is dropped.
    expect(packetItems({ 1: "p2-basic" }, GROUPS)).toEqual([]);
  });
});

describe("PacketPicker", () => {
  it("one fieldset per packet in packet order, Not included by default, tiers Basic→Premium; no axe violations", async () => {
    const { container } = renderUi(<Harness />);
    const groups = screen.getAllByRole("radiogroup");
    expect(groups).toHaveLength(2);
    const first = screen.getByRole("group", { name: "Tier for Idea & IP Protection" });
    expect(container.querySelectorAll("section")[0]).toHaveAccessibleName("Packet 1: Idea & IP Protection");
    const radios = within(first).getAllByRole("radio");
    const names = radios.map((r) => (r as HTMLButtonElement).labels?.[0]?.textContent ?? "");
    expect(names.map((n) => n.match(/^(Not included|Basic|Standard|Premium)/)?.[1])).toEqual(["Not included", "Basic", "Standard", "Premium"]);
    expect(names[1]).toContain("$450.01");
    expect(names[1]).toContain("Timeline: 48-72 hours");
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("Rush review")).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("selecting and clearing a tier reports one productPublicId per packet", () => {
    const onChange = vi.fn();
    renderUi(<Harness onChange={onChange} />);
    const first = screen.getByRole("group", { name: "Tier for Idea & IP Protection" });
    fireEvent.click(within(first).getByRole("radio", { name: /^Standard/ }));
    expect(onChange).toHaveBeenLastCalledWith({ 1: "p1-standard" });
    fireEvent.click(within(first).getByRole("radio", { name: /^Premium/ }));
    expect(onChange).toHaveBeenLastCalledWith({ 1: "p1-premium" });
    fireEvent.click(within(first).getByRole("radio", { name: /^Not included/ }));
    expect(onChange).toHaveBeenLastCalledWith({ 1: null });
  });

  it("deliverables disclosures show outcome, timeline and 'Everything in …, plus:' for higher tiers", () => {
    renderUi(<Harness />);
    const card = screen.getByRole("region", { name: "Packet 1: Idea & IP Protection" });
    const basic = within(card).getByText("Basic: outcome and deliverables").closest("details") as HTMLDetailsElement;
    const premium = within(card).getByText("Premium: outcome and deliverables").closest("details") as HTMLDetailsElement;
    expect(basic).not.toHaveAttribute("open");
    expect(within(basic).queryByText(/Everything in/)).not.toBeInTheDocument();
    expect(within(basic).getByText("Basic deliverable 1")).toBeInTheDocument();
    expect(within(premium).getByText("Everything in Standard, plus:")).toBeInTheDocument();
    expect(within(premium).getByText("Premium outcome for Idea & IP Protection")).toBeInTheDocument();
  });
});

const quote = (over: Partial<OrderQuote> = {}): OrderQuote => ({
  currency: "USD",
  subtotalMinor: 180002,
  discountMinor: 0,
  discountLabel: null,
  totalMinor: 180002,
  bundle: { label: "All-In bundle", discountPercent: 15, requiredPacketNumbers: [1, 2, 3, 4, 5, 6], missingPacketNumbers: [3, 4, 5, 6], applied: false },
  ...over,
});

describe("PacketSummary", () => {
  const selection = { 1: "p1-basic", 2: "p2-standard" };

  it("shows selected packets and server-quoted figures in a polite live region with the bundle hint; no axe violations", async () => {
    const { container } = renderUi(<PacketSummary groups={GROUPS} selection={selection} quote={quote()} />);
    expect(screen.getByText(/Packet 1: Idea & IP Protection — Basic/)).toBeInTheDocument();
    const live = screen.getByTestId("packet-summary-figures");
    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(within(live).getByText("Subtotal")).toBeInTheDocument();
    expect(live).toHaveTextContent("$1,800.02");
    expect(live).toHaveTextContent("Add all six packets for 15% off (4 more to go).");
    expect(within(live).queryByText("All-In bundle")).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("uses the quote's discount and total as given (no client arithmetic) and drops the hint once applied", () => {
    // Deliberately inconsistent figures prove the component displays the server values verbatim.
    renderUi(<PacketSummary groups={GROUPS} selection={selection} quote={quote({ discountMinor: 111, discountLabel: "All-In bundle (15% off)", totalMinor: 999, bundle: { ...quote().bundle!, missingPacketNumbers: [], applied: true } })} />);
    const live = screen.getByTestId("packet-summary-figures");
    expect(live).toHaveTextContent("All-In bundle (15% off)");
    expect(live).toHaveTextContent("−$1.11");
    expect(live).toHaveTextContent("$9.99");
    expect(live).not.toHaveTextContent(/for 15% off/);
  });

  it("empty, pending and error states", () => {
    const a = renderUi(<PacketSummary groups={GROUPS} selection={{}} quote={null} />);
    expect(screen.getByText("No packets chosen yet.")).toBeInTheDocument();
    a.unmount();
    const b = renderUi(<PacketSummary groups={GROUPS} selection={selection} quote={undefined} pending />);
    expect(screen.getByTestId("packet-summary-figures")).toHaveTextContent("Updating total…");
    b.unmount();
    const err = Object.assign(new Error("x"), { data: { safe: { domainCode: "VALIDATION", reasonCode: "PACKET_TIER_CONFLICT", safeMessage: "Choose one tier per packet." } } });
    renderUi(<PacketSummary groups={GROUPS} selection={selection} quote={undefined} error={err} />);
    expect(screen.getByTestId("packet-summary-figures")).toHaveTextContent("Choose one tier per packet.");
  });

  it("bundleHint is null without a rule", () => {
    expect(bundleHint(quote({ bundle: null }))).toBeNull();
    expect(bundleHint(null)).toBeNull();
  });
});

describe("useOrderQuote", () => {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } })}>{children}</QueryClientProvider>;

  it("does not call the server for an empty selection, and passes the exact items when there is one", async () => {
    quoteFn.mockReset();
    quoteFn.mockResolvedValue(quote());
    const { result, rerender } = renderHook(({ items }) => useOrderQuote(items), { wrapper, initialProps: { items: [] as Array<{ productPublicId: string; quantity: number }> } });
    expect(result.current).toEqual({ quote: null, pending: false, error: null });
    expect(quoteFn).not.toHaveBeenCalled();
    rerender({ items: [{ productPublicId: "p1-basic", quantity: 1 }] });
    await waitFor(() => expect(result.current.quote?.totalMinor).toBe(180002));
    expect(result.current.pending).toBe(false);
    expect(quoteFn).toHaveBeenCalledWith({ items: [{ productPublicId: "p1-basic", quantity: 1 }] });
  });

  it("surfaces a validation error without retrying", async () => {
    quoteFn.mockReset();
    quoteFn.mockRejectedValue(new Error("PACKET_TIER_CONFLICT"));
    const { result } = renderHook(() => useOrderQuote([{ productPublicId: "p1-basic", quantity: 1 }]), { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.quote).toBeNull();
    expect(quoteFn).toHaveBeenCalledTimes(1);
  });
});
