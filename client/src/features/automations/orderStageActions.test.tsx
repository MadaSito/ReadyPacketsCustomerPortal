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
        if (prop === "pathFilter") return () => ({ predicate: (q: { queryKey: readonly unknown[] }) => typeof q.queryKey[0] === "string" && (q.queryKey[0] === key || q.queryKey[0].startsWith(`${key}.`)) });
        if (prop === "queryFilter") return () => ({ queryKey: [key] });
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
    expect(first!.textContent).toContain("Synthetic In review automation: Send e-mail, Add tag");
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

  it("keyboard: Enter opens, Escape cancels without running and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    page();
    const trigger = await screen.findByRole("button", { name: "Run actions for In review" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
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

  it("keyboard: loading the last page of runs keeps focus on the shared LoadMore summary", async () => {
    const user = userEvent.setup();
    page();
    await screen.findByText("Synthetic run 1");
    screen.getByRole("button", { name: "Load more runs" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByText("Synthetic run 2");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Showing 2 runs"));
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

/* ---- Increment 07 (D5): pinned phase bundles, preview/confirm, completion jobs & cancel, stage runs ---- */

const TOKEN_1 = "a".repeat(64);
const TOKEN_2 = "b".repeat(64);

const phaseBundleView = (overrides: Record<string, unknown> = {}) => ({
  ...view(true),
  workflowFormat: 3,
  stageBundlesEnabled: true,
  stageBundlesDisabledReason: null,
  canRunStageBundles: true,
  canCancelCompletionJobs: true,
  stages: [
    {
      stageKey: "discovery",
      staffLabel: "Discovery & intake",
      customerLabel: "Getting started",
      statusKeys: ["review"],
      isCurrentStage: true,
      configuredSlotCount: 3,
      hasConfiguredBundle: true,
      slots: [
        { slot: "status", label: "Order status", summary: "Move order to Approved (approved)", warning: null },
        { slot: "completion", label: "Completion", summary: "Set 65% completion after 2 hours", warning: null },
        { slot: "email", label: "Customer e-mail", summary: "Send Phase ready notice", warning: null },
      ],
      activeCompletionJob: {
        publicId: "01JCOMPJOB0000000000000001",
        orderPublicId: ORDER,
        stageKey: "discovery",
        sourceKind: "stage_run",
        policyKind: "fixed",
        resolvedPercent: 65,
        minPercent: null,
        maxPercent: null,
        delayMinutes: 120,
        dueAt: "2026-11-24T15:00:00.000Z",
        state: "scheduled",
        reasonCode: null,
        completedAt: null,
        canceledAt: null,
        canceledBy: null,
        createdAt: "2026-11-24T13:00:00.000Z",
      },
      lastStageRun: {
        publicId: "01JSTGRUN00000000000000001",
        orderPublicId: ORDER,
        stageKey: "discovery",
        stageLabel: "Discovery & intake",
        workflowVersionId: 12,
        state: "completed",
        triggeredBy: { publicId: "usr_admin", displayName: "Synthetic Admin", role: "admin" },
        correlationId: "stage:01JSTGRUN00000000000000001",
        statusOverrideReason: null,
        results: [
          { slot: "status", outcome: "completed", reasonCode: null, safeSummary: "Moved order to approved", externalRef: null },
          { slot: "completion", outcome: "scheduled", reasonCode: null, safeSummary: "Scheduled 65% completion", externalRef: "01JCOMPJOB0000000000000001" },
        ],
        startedAt: "2026-11-24T13:00:00.000Z",
        finishedAt: "2026-11-24T13:00:01.000Z",
        createdAt: "2026-11-24T13:00:00.000Z",
      },
    },
    {
      stageKey: "closing",
      staffLabel: "Final closing",
      customerLabel: "Closing",
      statusKeys: ["done"],
      isCurrentStage: false,
      configuredSlotCount: 0,
      hasConfiguredBundle: false,
      slots: [],
      activeCompletionJob: null,
      lastStageRun: null,
    },
  ],
  recentStageRuns: [
    {
      publicId: "01JSTGRUN00000000000000001",
      orderPublicId: ORDER,
      stageKey: "discovery",
      stageLabel: "Discovery & intake",
      workflowVersionId: 12,
      state: "completed",
      triggeredBy: { publicId: "usr_admin", displayName: "Synthetic Admin", role: "admin" },
      correlationId: "stage:01JSTGRUN00000000000000001",
      statusOverrideReason: null,
      results: [
        { slot: "status", outcome: "completed", reasonCode: null, safeSummary: "Moved order to approved", externalRef: null },
        { slot: "completion", outcome: "scheduled", reasonCode: null, safeSummary: "Scheduled 65% completion", externalRef: "01JCOMPJOB0000000000000001" },
      ],
      startedAt: "2026-11-24T13:00:00.000Z",
      finishedAt: "2026-11-24T13:00:01.000Z",
      createdAt: "2026-11-24T13:00:00.000Z",
    },
  ],
  recentCompletionJobs: [
    {
      publicId: "01JCOMPJOB0000000000000001",
      orderPublicId: ORDER,
      stageKey: "discovery",
      sourceKind: "stage_run",
      policyKind: "fixed",
      resolvedPercent: 65,
      minPercent: null,
      maxPercent: null,
      delayMinutes: 120,
      dueAt: "2026-11-24T15:00:00.000Z",
      state: "scheduled",
      reasonCode: null,
      completedAt: null,
      canceledAt: null,
      canceledBy: null,
      createdAt: "2026-11-24T13:00:00.000Z",
    },
  ],
  ...overrides,
});

const previewPayload = (overrides: Record<string, unknown> = {}) => ({
  orderPublicId: ORDER,
  orderReference: "RP-SYN-1",
  stageKey: "discovery",
  stageLabel: "Discovery & intake",
  customerLabel: "Getting started",
  workflowVersionNumber: 3,
  currentStatusKey: "review",
  currentCompletionPercent: 25,
  canExecute: true,
  blockedReason: null,
  requiresAdminOverrideReason: false,
  statusTransition: {
    targetStatusKey: "approved",
    targetStatusLabel: "Approved",
    alreadyInTargetStatus: false,
    requiresAdminOverride: false,
  },
  slots: [
    { slot: "status", label: "Order status", summary: "Move order from review to Approved (approved)", warning: null },
    { slot: "completion", label: "Completion", summary: "Schedule 65% completion in 2 hours", warning: "Supersedes 1 pending completion update." },
  ],
  confirmationToken: TOKEN_1,
  ...overrides,
});

describe("OrderWorkflowStageActionsPanel (Increment 07 D5)", () => {
  beforeEach(() => {
    session.role = "admin";
    handlers["automations.orderStageActions.get"] = () => phaseBundleView();
    handlers["automations.orderStageActions.previewBundle"] = () => previewPayload();
    handlers["automations.orderStageActions.runBundle"] = (input) => ({
      deduplicated: false,
      stageRun: (phaseBundleView().recentStageRuns as unknown[])[0],
      completionJob: (phaseBundleView().recentCompletionJobs as unknown[])[0],
      echoInput: input,
    });
    handlers["automations.orderStageActions.cancelCompletionJob"] = (input) => ({
      ...(phaseBundleView().recentCompletionJobs as Record<string, unknown>[])[0],
      publicId: input.completionJobPublicId,
      state: "canceled",
      canceledAt: "2026-11-24T13:15:00.000Z",
      reasonCode: "CANCELED_BY_ADMIN",
    });
  });

  it("renders pinned phase bundles, fails closed when stageBundlesEnabled is false, and handles format 2 empty bundles", async () => {
    const { unmount } = page();
    const list = await screen.findByRole("list", { name: "Pinned workflow phases" });
    const items = within(list).getAllByRole("listitem").filter((li) => li.parentElement === list);
    expect(items[0]!.textContent).toContain("Discovery & intake");
    expect(items[0]!.textContent).toContain("Current phase");
    expect(items[0]!.textContent).toContain("3 configured");
    expect(within(items[1]!).getByRole("button", { name: "Preview and run Final closing" })).toBeDisabled();
    unmount();

    /* Fail closed when stageBundlesEnabled is false */
    handlers["automations.orderStageActions.get"] = () => phaseBundleView({ stageBundlesEnabled: false });
    const second = page();
    expect(await screen.findByText("Administrator-run phase bundles are turned off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview and run Discovery & intake" })).toBeDisabled();
    second.unmount();

    /* Format 2 workflow without phase bundles */
    handlers["automations.orderStageActions.get"] = () => phaseBundleView({ workflowFormat: 2, stages: [] });
    page();
    expect(await screen.findByText(/uses an earlier workflow format without phase action bundles/)).toBeInTheDocument();
  });

  it("previews a phase bundle, enforces override reason when required, refreshes on STALE_STAGE_CONFIRMATION, and runs with confirmationToken", async () => {
    const user = userEvent.setup();
    let previewCount = 0;
    handlers["automations.orderStageActions.previewBundle"] = () => {
      previewCount += 1;
      return previewPayload({
        requiresAdminOverrideReason: true,
        statusTransition: {
          targetStatusKey: "approved",
          targetStatusLabel: "Approved",
          alreadyInTargetStatus: false,
          requiresAdminOverride: true,
        },
        confirmationToken: previewCount === 1 ? TOKEN_1 : TOKEN_2,
      });
    };
    let runAttempts = 0;
    handlers["automations.orderStageActions.runBundle"] = (input) => {
      runAttempts += 1;
      if (runAttempts === 1) {
        throw Object.assign(new Error("Stale"), {
          data: { safe: { domainCode: "CONFLICT", reasonCode: "STALE_STAGE_CONFIRMATION", safeMessage: "Stale preview", requestId: "req_1" } },
        });
      }
      return {
        deduplicated: false,
        stageRun: (phaseBundleView().recentStageRuns as unknown[])[0],
        completionJob: (phaseBundleView().recentCompletionJobs as unknown[])[0],
        echoInput: input,
      };
    };

    page();
    await user.click(await screen.findByRole("button", { name: "Preview and run Discovery & intake" }));
    const dialog = await screen.findByRole("dialog", { name: /Preview phase actions: Discovery & intake/ });
    expect(await within(dialog).findByText(/Supersedes 1 pending completion update/)).toBeInTheDocument();

    /* Confirm disabled until override reason >= 3 chars */
    const confirmBtn = within(dialog).getByRole("button", { name: "Confirm and run phase" });
    expect(confirmBtn).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Administrator status override reason/), "Expedited customer approval");
    expect(confirmBtn).toBeEnabled();

    /* First attempt hits STALE_STAGE_CONFIRMATION -> refetches preview with TOKEN_2 and keeps dialog open */
    await user.click(confirmBtn);
    expect(await within(dialog).findByText(/The order changed since this preview loaded/)).toBeInTheDocument();
    expect(previewCount).toBe(2);

    /* Second attempt succeeds with refreshed confirmationToken TOKEN_2 */
    await user.click(within(dialog).getByRole("button", { name: "Confirm and run phase" }));
    await waitFor(() => expect(runAttempts).toBe(2));
    const runCalls = calls.filter((c) => c.path === "automations.orderStageActions.runBundle");
    expect(runCalls[1]!.input).toMatchObject({
      orderPublicId: ORDER,
      stageKey: "discovery",
      confirmationToken: TOKEN_2,
      statusOverrideReason: "Expedited customer approval",
    });
    expect(String(runCalls[1]!.input.idempotencyKey)).toMatch(/^bundle:[0-9a-f-]{36}$/u);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("displays scheduled completion updates with staff phase labels, cancels with administrator confirmation, and supports scoped stageKey mode", async () => {
    const user = userEvent.setup();
    const { unmount } = page();

    expect(await screen.findByText("65% completion")).toBeInTheDocument();
    expect(screen.getByText("Phase: Discovery & intake")).toBeInTheDocument();
    expect(screen.queryByText("Phase: discovery")).toBeNull();
    expect(screen.getByText("2 done")).toBeInTheDocument();
    expect(screen.getByText("Moved order to approved")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel 65% completion update" }));
    const cancelDialog = await screen.findByRole("alertdialog", { name: "Cancel 65% completion update?" });
    await user.type(within(cancelDialog).getByLabelText(/Cancellation note/), "Order placed on hold");
    await user.click(within(cancelDialog).getByRole("button", { name: "Cancel scheduled update" }));

    await waitFor(() =>
      expect(calls.some((c) => c.path === "automations.orderStageActions.cancelCompletionJob")).toBe(true),
    );
    expect(calls.find((c) => c.path === "automations.orderStageActions.cancelCompletionJob")!.input).toEqual({
      completionJobPublicId: "01JCOMPJOB0000000000000001",
      reason: "Order placed on hold",
    });
    unmount();

    /* Scoped single-phase mode (`stageKey="closing"`) shows only that phase */
    document.title = "Phase console";
    renderUi(
      <main id="main">
        <h1>Order</h1>
        <OrderWorkflowStageActionsPanel orderId={ORDER} stageKey="closing" />
      </main>,
      { path: `/admin/orders/${ORDER}` },
    );
    expect(await screen.findByText("Final closing")).toBeInTheDocument();
    expect(screen.queryByText("Discovery & intake")).toBeNull();
  });

  it("renders warning rows with production webhook link + skip count in preview, announces warning summary toast/status on run, and surfaces skipped reasons under Last phase run", async () => {
    const user = userEvent.setup();

    const runWithSkippedWebhook = {
      publicId: "01JSTGRUN00000000000000099",
      orderPublicId: ORDER,
      stageKey: "discovery",
      stageLabel: "Discovery & intake",
      workflowVersionId: 12,
      state: "completed",
      triggeredBy: { publicId: "usr_admin", displayName: "Synthetic Admin", role: "admin" },
      correlationId: "stage:01JSTGRUN00000000000000099",
      statusOverrideReason: null,
      results: [
        {
          slot: "status",
          outcome: "completed",
          reasonCode: null,
          safeSummary: "Moved order to Approved.",
          externalRef: null,
        },
        {
          slot: "completion",
          outcome: "scheduled",
          reasonCode: null,
          safeSummary: "Scheduled 72% completion update.",
          externalRef: "01JCOMPJOB0000000000000001",
        },
        {
          slot: "email",
          outcome: "completed",
          reasonCode: null,
          safeSummary: "Queued customer phase email.",
          externalRef: null,
        },
        {
          slot: "webhook",
          outcome: "skipped",
          reasonCode: "PRODUCTION_WEBHOOKS_NOT_ENABLED",
          safeSummary: "Production webhook P201 is disabled or not configured.\nSecondary diagnostic line",
          externalRef: null,
        },
      ],
      startedAt: "2026-11-24T14:00:00.000Z",
      finishedAt: "2026-11-24T14:00:01.000Z",
      createdAt: "2026-11-24T14:00:00.000Z",
    };

    let hasRun = false;
    handlers["automations.orderStageActions.get"] = () => {
      const base = phaseBundleView();
      if (!hasRun) return base;
      const updatedStages = (base.stages as Record<string, unknown>[]).map((st) =>
        st.stageKey === "discovery" ? { ...st, lastStageRun: runWithSkippedWebhook } : st,
      );
      return {
        ...base,
        stages: updatedStages,
        recentStageRuns: [runWithSkippedWebhook],
      };
    };

    handlers["automations.orderStageActions.previewBundle"] = () =>
      previewPayload({
        slots: [
          {
            slot: "status",
            label: "Order status",
            summary: "Move order from review to Approved (approved)",
            warning: null,
          },
          {
            slot: "completion",
            label: "Completion",
            summary: "Schedule 70%–80% completion in 1 minute",
            warning: null,
          },
          {
            slot: "email",
            label: "Customer email",
            summary: "Queue phase review notification",
            warning: null,
          },
          {
            slot: "webhook",
            label: "Workflow webhook",
            summary: "Send Production P201 webhook",
            warning: "Production webhooks are currently disabled in Integrations -> Production.",
          },
        ],
      });

    handlers["automations.orderStageActions.runBundle"] = () => {
      hasRun = true;
      return {
        deduplicated: false,
        stageRun: runWithSkippedWebhook,
        completionJob: (phaseBundleView().recentCompletionJobs as unknown[])[0],
      };
    };

    page();
    await user.click(await screen.findByRole("button", { name: "Preview and run Discovery & intake" }));
    const dialog = await screen.findByRole("dialog", { name: /Preview phase actions: Discovery & intake/ });

    /* 4. Warning row with Warning badge, normalized wording + link, and confirm-area skip count */
    expect(within(dialog).getByText("Warning")).toBeInTheDocument();
    const prodLink = within(dialog).getByRole("link", { name: "Integrations → Production webhooks" });
    expect(prodLink).toHaveAttribute("href", "/admin/integrations/production");
    expect(within(dialog).getByText("1 action will be skipped")).toBeInTheDocument();

    /* 1. Confirm and run -> warning toast + polite status announcement summarising the run */
    await user.click(within(dialog).getByRole("button", { name: "Confirm and run phase" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const statusRegions = screen.getAllByRole("status");
    expect(
      statusRegions.some((el) => el.textContent?.includes("Phase actions run: 3 done, 1 skipped")),
    ).toBe(true);
    expect(
      statusRegions.some((el) => el.textContent?.includes("Warning:")),
    ).toBe(true);
    expect(
      screen.getByText("Phase actions run: 3 done, 1 skipped (Discovery & intake)"),
    ).toBeInTheDocument();

    /* 2. "Last phase run" displays "3 done · 1 skipped" and first reason line without opening history */
    expect(await screen.findByText("3 done · 1 skipped")).toBeInTheDocument();
    const lastRunReasons = screen.getByRole("list", {
      name: "Skipped or failed actions in last phase run",
    });
    expect(lastRunReasons.textContent).toContain("Skipped (Workflow webhook):");
    expect(lastRunReasons.textContent).toContain(
      "Production webhook P201 is disabled or not configured.",
    );
    expect(lastRunReasons.textContent).not.toContain("Secondary diagnostic line");
    expect(
      within(lastRunReasons).getByRole("link", { name: "Integrations → Production webhooks" }),
    ).toHaveAttribute("href", "/admin/integrations/production");
  });

  pageA11y("order phase bundles panel with skipped webhook notice", async () => {
    const base = phaseBundleView();
    const stages = (base.stages as Record<string, unknown>[]).map((st) =>
      st.stageKey === "discovery"
        ? {
            ...st,
            slots: [
              ...(st.slots as unknown[]),
              {
                slot: "webhook",
                label: "Workflow webhook",
                summary: "Send Production P201 webhook",
                warning: "Production webhooks are currently disabled in Integrations -> Production.",
              },
            ],
            lastStageRun: {
              ...(st.lastStageRun as Record<string, unknown>),
              results: [
                { slot: "status", outcome: "skipped", reasonCode: "ALREADY_IN_STATUS", safeSummary: "Order is already in status \"Approved\".", externalRef: null },
                { slot: "completion", outcome: "scheduled", reasonCode: null, safeSummary: "Scheduled 65% completion", externalRef: "01JCOMPJOB0000000000000001" },
                { slot: "webhook", outcome: "skipped", reasonCode: "PRODUCTION_WEBHOOKS_NOT_ENABLED", safeSummary: "Production webhook P201 is disabled or not configured.", externalRef: null },
              ],
            },
          }
        : st,
    );
    handlers["automations.orderStageActions.get"] = () => ({ ...base, stages });
    page();
    await screen.findByRole("list", { name: "Pinned workflow phases" });
  });

  pageA11y("order phase bundle preview dialog with warning row and skip count", async () => {
    handlers["automations.orderStageActions.previewBundle"] = () =>
      previewPayload({
        slots: [
          { slot: "status", label: "Order status", summary: "Move order from review to Approved (approved)", warning: null },
          {
            slot: "webhook",
            label: "Workflow webhook",
            summary: "Send Production P201 webhook",
            warning: "Production webhooks are currently disabled in Integrations -> Production.",
          },
        ],
      });
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole("button", { name: "Preview and run Discovery & intake" }));
    await screen.findByRole("dialog", { name: /Preview phase actions/ });
  });
});

