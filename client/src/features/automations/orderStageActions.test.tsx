import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import OrderWorkflowStageActionsPanel from "./OrderWorkflowStageActionsPanel";

/* ---- tRPC mock: every procedure path resolves through `handlers[path]` ---- */
const { handlers, calls, session } = vi.hoisted(() => ({
  handlers: {} as Record<string, (input: Record<string, unknown>) => unknown>,
  calls: [] as { path: string; input: Record<string, unknown> }[],
  session: { role: "staff" as string },
}));
vi.mock("@/lib/session", () => ({ useSession: () => ({ me: { state: "full", user: { role: session.role } }, view: { status: "full", role: session.role } }) }));
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
const ORDER = "01JTESTORDER00000000000001";
const step = (key: string, label: string, extra: Record<string, unknown> = {}) => ({
  stepKey: key, label, customerLabel: label, kind: "active", tone: "neutral", phaseKey: null, isCurrentOrderStep: false,
  configuredAutomationCount: 1, configuredActionCount: 2,
  automations: [{ publicId: `au_${key}`, name: `Synthetic ${label} automation`, description: null, version: 1, triggerKey: "order.status_changed", actionCount: 2, actionLabels: ["Send e-mail", "Add tag"] }],
  ...extra,
});
const view = (engineEnabled = true) => ({
  orderPublicId: ORDER, orderReference: "RP-SYN-1", currentStatusKey: "review", workflowKey: "standard", workflowVersionNumber: 3,
  engineEnabled, engineDisabledReason: engineEnabled ? null : "AUTOMATIONS_DISABLED", settingsPath: "/admin/automations", canManageAutomations: true,
  steps: [step("review", "In review", { isCurrentOrderStep: true }), step("done", "Complete", { configuredAutomationCount: 0, configuredActionCount: 0, automations: [] })],
  recentRuns: [],
});
const run = (n: number) => ({
  publicId: `run_${n}`, automationPublicId: "au_review", automationName: `Synthetic run ${n}`, automationVersion: 1, triggerMode: "event", triggerKey: "order.status_changed",
  triggerEventId: null, orderPublicId: ORDER, stageStepKey: "review", triggeredBy: n === 1 ? { publicId: "usr_syn", displayName: "Synthetic Staffer", role: "staff" } : null,
  correlationId: "corr", isTest: false, state: "completed", reasonCode: null, evaluatedFields: {}, steps: [], queuedAt: "2026-11-19T09:30:00.000Z", startedAt: null, finishedAt: null, durationMs: null,
});

beforeEach(() => {
  calls.length = 0;
  session.role = "staff";
  for (const k of Object.keys(handlers)) delete handlers[k];
  handlers["automations.orderStageActions.get"] = () => view();
  handlers["automations.orderStageActions.listRuns"] = (i) => (i.cursor ? { items: [run(2)], nextCursor: null } : { items: [run(1)], nextCursor: "c1" });
  handlers["automations.orderStageActions.runForOrder"] = (i) => ({ orderPublicId: ORDER, stepKey: i.stepKey, queuedRuns: [{ runPublicId: "run_9", automationPublicId: "au_review", automationName: "x", jobId: "j", deduplicated: false }] });
});
afterEach(() => vi.clearAllMocks());

const page = () => {
  document.title = "Order automation";
  return renderUi(<main id="main"><h1>Order</h1><OrderWorkflowStageActionsPanel orderId={ORDER} /></main>, { path: `/admin/orders/${ORDER}/automation` });
};

describe("Workflow stage actions panel (T2)", () => {
  it("renders nothing for customers and never calls the server", () => {
    session.role = "customer";
    const { container } = page();
    expect(container.querySelector("h2")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("renders nothing when the server refuses with FORBIDDEN", async () => {
    handlers["automations.orderStageActions.get"] = () => { throw Object.assign(new Error("FORBIDDEN"), { data: { safe: { domainCode: "FORBIDDEN", reasonCode: "FORBIDDEN", safeMessage: "No", requestId: "r" } } }); };
    page();
    await waitFor(() => expect(calls.some((c) => c.path === "automations.orderStageActions.get")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Workflow stage actions" })).toBeNull());
  });

  it("lists steps with the current step marked in text and configured action counts", async () => {
    page();
    const list = await screen.findByRole("list", { name: "Workflow steps" });
    const [first, second] = within(list).getAllByRole("listitem").filter((li) => li.parentElement === list);
    expect(first!.textContent).toContain("Current step");
    expect(first!.getAttribute("aria-current")).toBe("step");
    expect(first!.textContent).toContain("2 configured actions in 1 automation");
    expect(within(second!).getByRole("button", { name: "Run actions for Complete" }).hasAttribute("disabled")).toBe(true);
  });

  it("runs a step only after confirmation, with one idempotency key, and announces the result", async () => {
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("button", { name: "Run actions for In review" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Run actions for In review?" });
    expect(calls.some((c) => c.path === "automations.orderStageActions.runForOrder")).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Run actions" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "automations.orderStageActions.runForOrder")).toHaveLength(1));
    const input = calls.find((c) => c.path === "automations.orderStageActions.runForOrder")!.input;
    expect(input).toMatchObject({ orderPublicId: ORDER, stepKey: "review" });
    expect(String(input.idempotencyKey)).toMatch(/^stage:[0-9a-f-]{36}$/u);
    expect(await screen.findByText("1 automation run queued")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("cancel closes the dialog without running and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    page();
    const trigger = await screen.findByRole("button", { name: "Run actions for In review" });
    await user.click(trigger);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.path === "automations.orderStageActions.runForOrder")).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("fails closed when the engine is off: notice with settings link and disabled run buttons", async () => {
    handlers["automations.orderStageActions.get"] = () => view(false);
    page();
    expect(await screen.findByText("The automation engine is turned off")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open automation settings" }).getAttribute("href")).toBe("/admin/automations");
    for (const b of screen.getAllByRole("button", { name: /^Run actions for/u })) expect(b.hasAttribute("disabled")).toBe(true);
  });

  it("recent runs paginate with the cursor", async () => {
    const user = userEvent.setup();
    page();
    expect(await screen.findByText("Synthetic run 1")).toBeTruthy();
    expect(screen.getByText(/Run by Synthetic Staffer/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Load more runs" }));
    expect(await screen.findByText("Synthetic run 2")).toBeTruthy();
    expect(calls).toContainEqual({ path: "automations.orderStageActions.listRuns", input: { orderPublicId: ORDER, limit: 10, cursor: "c1" } });
  });

  pageA11y("order automation stage actions", async () => {
    page();
    await screen.findByRole("list", { name: "Recent automation runs" });
  });
  pageA11y("order automation stage actions confirm dialog", async () => {
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("button", { name: "Run actions for In review" }));
    await screen.findByRole("alertdialog");
  });
});
