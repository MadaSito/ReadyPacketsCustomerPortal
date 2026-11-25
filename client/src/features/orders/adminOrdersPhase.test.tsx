/** Increment 07 QA: the console order list's Phase column (label, n of m, compact progress). Owner: orders_engineer. */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as trpcModule from "@/lib/trpc";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import AdminOrdersPage from "./pages/AdminOrdersPage";

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (input: unknown) => unknown>() }));

function proxy(path: string[]): unknown {
  const key = path.join(".");
  const run = async (input: unknown) => {
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
    queryKey: (input?: unknown) => [key, input],
    pathKey: () => [key],
  };
  return new Proxy(api, { get: (target, prop: string) => (prop in target ? target[prop as keyof typeof target] : proxy([...path, prop])) });
}
vi.mock("@/lib/trpc", async (original) => ({ ...(await original<typeof trpcModule>()), useTRPC: () => proxy([]), useTRPCClient: () => proxy([]) }));
vi.mock("@/lib/session", () => ({ useSession: () => ({ me: { state: "full", user: { role: "staff" } }, view: { status: "full", role: "staff" } }) }));

const now = new Date("2026-11-20T09:00:00.000Z");
const base = {
  projectName: "Synthetic project",
  statusKey: "in_review",
  statusLabel: "Intake review",
  statusTone: "info",
  lockState: "none",
  totalMinor: 2500,
  currency: "USD",
  accessRole: "staff",
  createdAt: now,
  updatedAt: now,
  paymentState: "paid",
  attention: null,
  progressCanceled: false,
};
const phased = { ...base, publicId: "01JTESTORDER0000000000000A", reference: "RP-2026-000001", progressPercent: 40, phaseLabel: "Phase 1 intake", phaseIndex: 2, phaseTotal: 7 };
const uncached = { ...base, publicId: "01JTESTORDER0000000000000C", reference: "RP-2026-000003", progressPercent: null, phaseLabel: "Phase 2 synthesis", phaseIndex: 3, phaseTotal: 7 };
const classic = { ...base, publicId: "01JTESTORDER0000000000000B", reference: "RP-2026-000002", progressPercent: 0, phaseLabel: null, phaseIndex: null, phaseTotal: 0 };

beforeEach(() => {
  handlers.clear();
  handlers.set("orders.admin.list", () => ({ items: [phased, classic, uncached], nextCursor: null }));
  handlers.set("orders.statusCatalog.list", () => []);
  handlers.set("orders.statusCatalog.attentionCounts", () => ({}));
});

describe("console order list Phase column", () => {
  it("shows the compact progress bar once per row (text when no value yet), a nowrap reference; a row without phases shows a dash", async () => {
    const { container } = renderUi(<AdminOrdersPage />, { path: "/admin/orders" });
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Phase" })).toBeInTheDocument();
    // One line per row (QA #2): the compact bar's own line, no second copy of the phase name.
    expect(within(table).getAllByText(/Phase 1 intake/)).toHaveLength(1);
    expect(within(table).getByText(/3 of 7: Phase 1 intake/)).toBeInTheDocument();
    // No progress value yet: plain text instead of a bar.
    expect(within(table).getByText("Step 4 of 7: Phase 2 synthesis")).toBeInTheDocument();
    expect(within(table).queryByRole("progressbar", { name: "Progress of RP-2026-000003" })).not.toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "RP-2026-000001" })).toHaveClass("whitespace-nowrap");
    expect(within(table).getByRole("progressbar", { name: "Progress of RP-2026-000001" })).toHaveAttribute("aria-valuenow", "40");
    expect(within(table).queryByRole("progressbar", { name: "Progress of RP-2026-000002" })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe("07.1 D5: /admin/orders?new=1", () => {
  it("opens the New order for a customer dialog with focus inside; closing removes the parameter and returns focus to the button", async () => {
    handlers.set("orders.catalog.list", () => []);
    const user = userEvent.setup();
    const { container, location } = renderUi(<AdminOrdersPage />, { path: "/admin/orders?new=1" });
    const dialog = await screen.findByRole("dialog", { name: "New order for a customer" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await expectNoAxeViolations(container);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(location.history?.at(-1)).toBe("/admin/orders");
    await waitFor(() => expect(screen.getByRole("button", { name: "New order for a customer" })).toHaveFocus());
  });

  it("without the parameter the dialog stays closed", async () => {
    renderUi(<AdminOrdersPage />, { path: "/admin/orders" });
    await screen.findByRole("table");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

