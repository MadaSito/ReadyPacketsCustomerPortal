import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import OrderHistoryTab from "./OrderHistoryTab";
import { OrderHistoryTabLabel } from "./OrderHistoryTabLabel";
import { auditFeature } from "./routes";

/* ---- tRPC mock: every procedure path resolves through `handlers[path]` ---- */
const { handlers, calls } = vi.hoisted(() => ({
  handlers: {} as Record<string, (input: Record<string, unknown>) => unknown>,
  calls: [] as { path: string; input: Record<string, unknown> }[],
}));
vi.mock("@/lib/trpc", async (original) => {
  const call = (path: string, input: Record<string, unknown>) => {
    calls.push({ path, input });
    const handler = handlers[path];
    if (!handler) return Promise.reject(new Error(`unmocked ${path}`));
    try { return Promise.resolve(handler(input)); } catch (e) { return Promise.reject(e); }
  };
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        const key = path.join(".");
        if (prop === "queryOptions") return (input: Record<string, unknown>) => ({ queryKey: [key, input ?? null], queryFn: () => call(key, input) });
        if (prop === "infiniteQueryOptions") {
          return (input: Record<string, unknown>, opts: { getNextPageParam: (p: unknown) => unknown }) => ({
            queryKey: [key, input, "infinite"],
            queryFn: ({ pageParam }: { pageParam: unknown }) => call(key, { ...input, cursor: pageParam }),
            initialPageParam: null,
            getNextPageParam: opts.getNextPageParam,
          });
        }
        if (prop === "mutationOptions") return () => ({ mutationFn: (input: Record<string, unknown>) => call(key, input) });
        if (prop === "pathFilter" || prop === "queryFilter") return () => ({ queryKey: [key] });
        if (prop === "queryKey" || prop === "pathKey") return () => [key];
        return node([...path, prop]);
      },
    });
  return { ...await original<typeof trpcModule>(), useTRPC: () => node([]), useTRPCClient: () => node([]) };
});

/* Synthetic fixtures only. */
const ORDER = "ord_synthetic_0001";
const AT = "2026-11-19T09:30:00.000Z";
const customerStatus = {
  view: "customer",
  items: [
    { key: "k1", kind: "transition", at: AT, actor: "ReadyPackets staff", from: "review", fromLabel: "In review", to: "done", toLabel: "Complete", note: null },
    { key: "k2", kind: "rename", at: AT, actor: "You" },
    { key: "k3", kind: "transition", at: AT, actor: "You", from: null, fromLabel: null, to: "new", toLabel: "Submitted", note: "Synthetic customer note" },
  ],
  nextCursor: null,
};
const staffStatus = {
  view: "staff",
  items: [{ key: "s1", kind: "rename", at: AT, actor: "Synthetic Staffer", oldName: "Synthetic name A", newName: "Synthetic name B" }],
  nextCursor: null,
};
const customerActivity = (page: number) => ({
  view: "customer",
  items: [{ key: `a${page}`, at: AT, category: "files", label: page === 1 ? "File uploaded" : "File removed", actor: "You", details: {} }],
  nextCursor: page === 1 ? "opaque_cursor_1" : null,
});
const staffActivity = {
  view: "staff",
  items: [{
    key: "x1", at: AT, category: "automation", label: "Automation run", actor: "System", details: { step_key: "review" },
    eventId: "evt_synthetic", eventName: "automation.run.completed", outcome: "failed", reasonCode: "TIMEOUT", actorRole: "system", correlationId: "corr_synthetic",
  }],
  nextCursor: null,
};

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
  handlers["audit.orderStatusHistory"] = () => customerStatus;
  handlers["audit.orderActivity"] = (i) => (i.cursor ? customerActivity(2) : customerActivity(1));
});
afterEach(() => vi.clearAllMocks());

const page = (area: "customer" | "console") => {
  document.title = "Order history";
  return renderUi(<main id="main"><h1>Order</h1><OrderHistoryTab orderId={ORDER} area={area} /></main>, { path: `/orders/${ORDER}/history` });
};

describe("Order history tab (S2)", () => {
  it("registers as the history tab, shown to customers as History", () => {
    const tab = auditFeature.orderTabs?.find((t) => t.key === "history");
    expect(tab).toMatchObject({ label: "Order history", access: "customer", order: 90 });
    expect(tab?.labelComponent).toBe(OrderHistoryTabLabel);
    renderUi(<><OrderHistoryTabLabel orderId={ORDER} area="customer" /> | <OrderHistoryTabLabel orderId={ORDER} area="console" /></>);
    expect(document.body.textContent).toContain("History | Order history");
  });

  it("customer view shows status changes, a generic rename and staff only as ReadyPackets staff", async () => {
    page("customer");
    const list = await screen.findByRole("list", { name: "Status history entries" });
    const entries = within(list).getAllByRole("listitem");
    expect(entries).toHaveLength(3);
    expect(entries[0]!.textContent).toMatch(/Status changed from\s*In review\s*to\s*Complete/u);
    expect(entries[0]!.textContent).toContain("ReadyPackets staff");
    expect(entries[1]!.textContent).toContain("Order renamed");
    expect(entries[1]!.textContent).not.toContain("Renamed:");
    expect(entries[2]!.textContent).toContain("Synthetic customer note");
    expect(calls).toContainEqual({ path: "audit.orderStatusHistory", input: { orderPublicId: ORDER, limit: 25, cursor: null } });
  });

  it("staff view shows Renamed: old → new and event details", async () => {
    handlers["audit.orderStatusHistory"] = () => staffStatus;
    handlers["audit.orderActivity"] = () => staffActivity;
    page("console");
    const list = await screen.findByRole("list", { name: "Status history entries" });
    expect(list.textContent).toMatch(/Renamed: Synthetic name A\s*to Synthetic name B/u);
    const activity = await screen.findByRole("list", { name: "Activity entries" });
    expect(activity.textContent).toContain("Outcome: failed");
    expect(activity.textContent).toContain("automation.run.completed");
    expect(activity.textContent).toContain("corr_synthetic");
  });

  it("category filter re-queries with the category and customers get only customer categories", async () => {
    const user = userEvent.setup();
    page("customer");
    const select = await screen.findByRole("combobox", { name: "Show" });
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["All activity", "Order details", "Status", "Sharing and access", "Phases and locks", "Policy acceptance", "Files", "Payments"]);
    await user.selectOptions(select, "files");
    await waitFor(() => expect(calls).toContainEqual({ path: "audit.orderActivity", input: { orderPublicId: ORDER, limit: 25, category: "files", cursor: null } }));
  });

  it("load more passes the opaque cursor and appends the next page", async () => {
    const user = userEvent.setup();
    page("customer");
    await screen.findByText("File uploaded");
    await user.click(screen.getByRole("button", { name: "Load more activity" }));
    await screen.findByText("File removed");
    expect(calls).toContainEqual({ path: "audit.orderActivity", input: { orderPublicId: ORDER, limit: 25, cursor: "opaque_cursor_1" } });
    expect(screen.getByText("File uploaded")).toBeTruthy();
  });

  it("keyboard: on the last page focus moves to the list instead of falling back to the body", async () => {
    const user = userEvent.setup();
    page("customer");
    await screen.findByText("File uploaded");
    screen.getByRole("button", { name: "Load more activity" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByText("File removed");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("list", { name: "Activity entries" })));
    expect(screen.queryByRole("button", { name: "Load more activity" })).toBeNull();
  });

  it("shows an error state with retry when the server refuses", async () => {
    handlers["audit.orderStatusHistory"] = () => { throw new Error("NOT_FOUND"); };
    page("customer");
    expect(await screen.findByText("Status history could not be loaded")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /retry|try again/iu }).length).toBeGreaterThan(0);
  });

  pageA11y("/orders/:id/history customer", async () => {
    page("customer");
    await screen.findByRole("list", { name: "Activity entries" });
    await screen.findByRole("list", { name: "Status history entries" });
  });
  pageA11y("/orders/:id/history console", async () => {
    handlers["audit.orderStatusHistory"] = () => staffStatus;
    handlers["audit.orderActivity"] = () => staffActivity;
    page("console");
    await screen.findByRole("list", { name: "Activity entries" });
  });
});
