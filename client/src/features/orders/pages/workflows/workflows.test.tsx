/** Workflow designer client: list + install, wizard, canvas, versions and read-only published view (fake tRPC only). */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import AdminWorkflowsPage, { resetPhasesNoticeForTests } from "../AdminWorkflowsPage";
import { RulesReviewSummary } from "./rulesFields";
import WorkflowDesignerPage, { addCatalogStatuses, startPhases } from "./WorkflowDesignerPage";
import WorkflowVersionPage from "./WorkflowVersionPage";
import WorkflowVersionsPage from "./WorkflowVersionsPage";

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
vi.mock("@/lib/trpc", async (original) => ({ ...(await original<typeof trpcModule>()), useTRPC: () => proxy([]), useTRPCClient: () => proxy([]) }));

const WF = "01JTESTWF0000000000000000A";
const VERSION = "01JTESTWFV000000000000000A";
const DRAFT = "01JTESTWFD000000000000000A";
const now = new Date("2026-11-20T09:00:00.000Z");
const states = [
  { key: "submitted", label: "Submitted", customerLabel: "Submitted", kind: "initial", tone: "info" },
  { key: "completed", label: "Completed", customerLabel: "Completed", kind: "terminal", tone: "success" },
];
const transition = { from: "submitted", to: "completed", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false };
const workflowRow = { publicId: WF, workflowKey: "standard", name: "Standard", isDefault: true, rowVersion: 1, versionNumber: 1, currentVersionPublicId: VERSION, draftPublicId: null, definition: { states, transitions: [transition] } };
const deadEnd = { severity: "error", code: "STATE_DEAD_END", path: "states.0", message: "Status 1 (“Submitted”) has no way out. Add a transition from it, or mark it as final." };
const draftView = (transitions: unknown[] = [], issues: unknown[] = [deadEnd]) => ({
  publicId: DRAFT,
  workflowPublicId: WF,
  workflowKey: "standard",
  name: "Standard",
  source: "copy",
  baseVersionNumber: 1,
  definition: { states, transitions },
  layout: null,
  rowVersion: 1,
  updatedAt: now,
  issues,
  publishable: issues.length === 0,
});

// FlowCanvas (React Flow) needs layout APIs jsdom lacks (same stub as client/src/ui/increment03.test.tsx).
const original = { ro: window.ResizeObserver, w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"), h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight") };
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 200 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 80 });
  (window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  };
  window.ResizeObserver = class {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterAll(() => {
  window.ResizeObserver = original.ro;
  if (original.w) Object.defineProperty(HTMLElement.prototype, "offsetWidth", original.w);
  if (original.h) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original.h);
});

const POLICY_A = "01JTESTPOL0000000000000000";
// Shape of compliance.policies.listPublished (only currently published customer-audience policies are returned).
const policyDocs = [{ documentPublicId: POLICY_A, slug: "order-terms", title: "Synthetic order terms", audience: "customer", requiresAcceptance: true, versionNumber: 1 }];

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  resetPhasesNoticeForTests();
  handlers.set("compliance.policies.listPublished", () => policyDocs);
  handlers.set("orders.admin.workflows.transfer.status", () => ({ enabled: false, canExport: true, canImport: true, maxBytes: 2_097_152, maxWorkflows: 50 }));
});

const designer = () => renderUi(<Route path="/admin/workflows/drafts/:draftId"><WorkflowDesignerPage /></Route>, { path: `/admin/workflows/drafts/${DRAFT}` });

describe("workflows page", () => {
  it("offers to install the standard workflow when none exists (explicit action, no automatic install)", async () => {
    let installed = false;
    handlers.set("orders.admin.workflows.list", () => (installed ? [workflowRow] : []));
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    handlers.set("orders.admin.workflows.installStandard", () => {
      installed = true;
      return { installed: true, workflowPublicId: WF, versionNumber: 1 };
    });
    const user = userEvent.setup();
    const { container } = renderUi(<AdminWorkflowsPage />, { path: "/admin/workflows" });
    expect(await screen.findByRole("heading", { name: "No workflow installed yet" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
    expect(calls.some((c) => c.path === "orders.admin.workflows.installStandard")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Install the standard workflow now" }));
    expect(await screen.findByRole("heading", { name: "Standard" })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "orders.admin.workflows.installStandard")).toHaveLength(1);
  });

  it("lists workflows and drafts, and Edit starts a draft copied from the current version", async () => {
    handlers.set("orders.admin.workflows.list", () => [workflowRow]);
    handlers.set("orders.admin.workflows.drafts.list", () => [{ publicId: DRAFT, workflowPublicId: null, workflowKey: "rush", name: "Rush jobs", source: "blank", rowVersion: 2, updatedAt: now, errorCount: 2, warningCount: 0 }]);
    handlers.set("orders.admin.workflows.drafts.create", () => ({ publicId: "01JTESTWFD000000000000000B", rowVersion: 1 }));
    const user = userEvent.setup();
    const { container, location } = renderUi(<AdminWorkflowsPage />, { path: "/admin/workflows" });
    expect(await screen.findByRole("heading", { name: "Standard" })).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect((await screen.findAllByRole("link", { name: "Rush jobs" }))[0]).toHaveAttribute("href", `/admin/workflows/drafts/${DRAFT}`);
    expect(screen.getAllByText("2 to fix").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Versions of Standard" })).toHaveAttribute("href", `/admin/workflows/${WF}/versions`);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Edit Standard" }));
    await waitFor(() => expect(location.history.at(-1)).toBe("/admin/workflows/drafts/01JTESTWFD000000000000000B"));
    expect(calls.find((c) => c.path === "orders.admin.workflows.drafts.create")?.input).toEqual({ from: "copy", copyVersionId: VERSION, workflowId: WF });
  });

  it("new workflow dialog validates the key and creates a blank draft", async () => {
    handlers.set("orders.admin.workflows.list", () => [workflowRow]);
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    handlers.set("orders.admin.workflows.drafts.create", () => ({ publicId: DRAFT, rowVersion: 1 }));
    const user = userEvent.setup();
    const { location } = renderUi(<AdminWorkflowsPage />, { path: "/admin/workflows" });
    await user.click(await screen.findByRole("button", { name: "New workflow" }));
    const dialog = await screen.findByRole("dialog", { name: "New workflow" });
    await user.type(within(dialog).getByLabelText(/^Name/), "Rush jobs");
    expect(within(dialog).getByLabelText(/^Key/)).toHaveValue("rush_jobs");
    await user.clear(within(dialog).getByLabelText(/^Key/));
    await user.type(within(dialog).getByLabelText(/^Key/), "standard");
    await user.click(within(dialog).getByRole("button", { name: "Create draft" }));
    expect(await within(dialog).findByText("A workflow with this key already exists.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(/^Key/));
    await user.type(within(dialog).getByLabelText(/^Key/), "rush");
    await user.click(within(dialog).getByRole("radio", { name: /Blank/ }));
    await expectNoAxeViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(location.history.at(-1)).toBe(`/admin/workflows/drafts/${DRAFT}`));
    expect(calls.find((c) => c.path === "orders.admin.workflows.drafts.create")?.input).toEqual({ from: "blank", workflowKey: "rush", name: "Rush jobs" });
  });

  it("new workflow dialog recommends the ReadyPackets phases and selects it by default", async () => {
    handlers.set("orders.admin.workflows.list", () => [workflowRow]);
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    handlers.set("orders.admin.workflows.drafts.create", () => ({ publicId: DRAFT, rowVersion: 1 }));
    const user = userEvent.setup();
    const { location } = renderUi(<AdminWorkflowsPage />, { path: "/admin/workflows" });
    await user.click(await screen.findByRole("button", { name: "New workflow" }));
    const dialog = await screen.findByRole("dialog", { name: "New workflow" });
    expect(within(dialog).getByRole("radio", { name: /ReadyPackets phases \(recommended\)/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /The standard workflow \(statuses\)/ })).not.toBeChecked();
    await user.type(within(dialog).getByLabelText(/^Name/), "Packets");
    await user.click(within(dialog).getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(location.history.at(-1)).toBe(`/admin/workflows/drafts/${DRAFT}`));
    expect(calls.find((c) => c.path === "orders.admin.workflows.drafts.create")?.input).toEqual({ from: "phases", workflowKey: "packets", name: "Packets" });
  });

  it("phases notice: shown while no published workflow has phases; add, convert (opens the existing draft) and dismiss", async () => {
    handlers.set("orders.admin.workflows.list", () => [workflowRow]);
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    handlers.set("orders.admin.workflows.phases.addStandard", () => ({ draftId: "01JTESTWFD000000000000000C", created: true }));
    handlers.set("orders.admin.workflows.phases.convertDefault", () => ({ draftId: DRAFT, created: false }));
    const user = userEvent.setup();
    const { container, location, unmount } = renderUi(<AdminWorkflowsPage />, { path: "/admin/workflows" });
    const notice = await screen.findByRole("region", { name: "Your workflows do not use phases yet" });
    await expectNoAxeViolations(container);
    await user.click(within(notice).getByRole("button", { name: "Add the ReadyPackets phases workflow" }));
    await waitFor(() => expect(location.history.at(-1)).toBe("/admin/workflows/drafts/01JTESTWFD000000000000000C"));
    await user.click(within(notice).getByRole("button", { name: "Convert Standard to phases" }));
    await waitFor(() => expect(location.history.at(-1)).toBe(`/admin/workflows/drafts/${DRAFT}`));
    expect(await screen.findByText("Opening the existing draft")).toBeInTheDocument();
    await user.click(within(notice).getByRole("button", { name: "Dismiss the phases notice" }));
    expect(screen.queryByRole("region", { name: "Your workflows do not use phases yet" })).not.toBeInTheDocument();
    unmount();

    // A published workflow with phases: no notice.
    resetPhasesNoticeForTests();
    handlers.set("orders.admin.workflows.list", () => [{ ...workflowRow, definition: { ...workflowRow.definition, stages: [{ key: "intake" }] } }]);
    renderUi(<AdminWorkflowsPage />, { path: "/admin/workflows" });
    expect(await screen.findByRole("heading", { name: "Standard" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Your workflows do not use phases yet" })).not.toBeInTheDocument();
  });
});

describe("designer phases-first", () => {
  it("opens every draft on the Phases tab, first in the tab order", async () => {
    handlers.set("orders.admin.workflows.drafts.get", () => draftView([transition], []));
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    designer();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Phases", "Statuses wizard", "Canvas"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("button", { name: "Start phases from statuses" })).toBeInTheDocument();
  });

  it("phase status choices: this workflow's statuses with its labels, then catalogue statuses; ticking one adds it", async () => {
    const stage = {
      key: "intake", customerLabel: "Intake", staffLabel: "Intake", statusKeys: ["submitted"], progression: "submit_lock",
      actions: { uploadDocuments: true, answerQuestions: false, recordAudio: false, uploadAudio: false, teamFileReview: false },
      folders: { documents: "{phase_key}/Docs", audio: "{phase_key}/Audio" }, fileSync: { originals: null, conversionStaging: null, intakeDelivery: null },
      acknowledgement: { policy: "none" }, adminTasks: [], completesOn: "manual", weight: 1,
    };
    handlers.set("orders.admin.workflows.drafts.get", () => ({ ...draftView([transition], []), definition: { states, transitions: [transition], stages: [stage] } }));
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    handlers.set("orders.statusCatalog.list", () => [
      { key: "submitted", staffLabel: "Catalogue submitted", customerLabel: "Submitted", tone: "info", category: "start", retired: false },
      { key: "intake_open", staffLabel: "Intake open", customerLabel: "Upload your materials", tone: "warning", category: "working", retired: false },
      { key: "old_one", staffLabel: "Old status", customerLabel: "Old", tone: "neutral", category: "working", retired: true },
    ]);
    const user = userEvent.setup();
    designer();
    expect(await screen.findByRole("checkbox", { name: "Submitted" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /Catalogue submitted/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Old status/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("checkbox", { name: "Intake open (not in this workflow yet)" }));
    expect(await screen.findByText("Intake open: added to this workflow's statuses. Add its transitions in the Statuses wizard.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Intake open" })).toBeChecked();

  });

  it("Review summary lists format-3 phases (not the classic groups)", async () => {
    const stage = { key: "intake", customerLabel: "Intake", staffLabel: "Intake", statusKeys: ["submitted", "completed"], progression: "submit_lock" };
    renderUi(<RulesReviewSummary definition={{ states, transitions: [transition], stages: [stage] } as unknown as Parameters<typeof RulesReviewSummary>[0]["definition"]} />, { path: "/" });
    const summary = await screen.findByRole("region", { name: "Phases, requirements, acceptance and storage" });
    expect(within(summary).getByText(/1 phase\./)).toBeInTheDocument();
    expect(within(summary).getByText(/2 statuses; submit and lock/)).toBeInTheDocument();
    expect(within(summary).queryByText("No phases. Orders show statuses only.")).not.toBeInTheDocument();
  });

  it("addCatalogStatuses adds catalogue statuses named by a phase (no transitions) and ignores retired or unknown keys", () => {
    const catalog = [
      { key: "delivered", staffLabel: "Delivered", customerLabel: "Delivered", tone: "success", category: "done", retired: false },
      { key: "old_one", staffLabel: "Old", customerLabel: "Old", tone: "neutral", category: "working", retired: true },
    ];
    const draft = { states, transitions: [transition], stages: [{ key: "a", statusKeys: ["submitted", "delivered", "old_one", "nope"] }] } as unknown as Parameters<typeof addCatalogStatuses>[0];
    const result = addCatalogStatuses(draft, catalog);
    expect(result.added).toEqual(["delivered"]);
    expect(result.definition.states.at(-1)).toMatchObject({ key: "delivered", label: "Delivered", kind: "terminal", tone: "success" });
    expect(result.definition.transitions).toHaveLength(1);
    expect(addCatalogStatuses(result.definition, catalog).added).toEqual([]);
  });

  it("starting phases from classic status groups removes the groups (a draft may not use both)", () => {
    const classic = {
      states: [{ ...states[0]!, phase: "intake" }, states[1]!],
      transitions: [transition],
      phases: [{ key: "intake", label: "Intake" }],
    } as unknown as Parameters<typeof startPhases>[0];
    const next = startPhases(classic) as unknown as { phases?: unknown; states: { phase?: string }[]; stages: { key: string; statusKeys: string[] }[] };
    expect(next.phases).toBeUndefined();
    expect(next.states.every((state) => state.phase === undefined)).toBe(true);
    expect(next.stages[0]).toMatchObject({ key: "intake", statusKeys: ["submitted"] });
  });
});

describe("workflow designer", () => {
  it("wizard: server issues block the step, then every step is reachable and Publish sends the saved draft", async () => {
    handlers.set("orders.admin.workflows.drafts.get", () => draftView());
    let saves = 0;
    handlers.set("orders.admin.workflows.drafts.save", (input) => {
      saves += 1;
      const transitions = (input as { definition: { transitions: unknown[] } }).definition.transitions;
      return { rowVersion: 1 + saves, issues: transitions.length ? [] : [deadEnd], publishable: transitions.length > 0 };
    });
    handlers.set("orders.admin.workflows.drafts.publish", () => ({ workflowPublicId: WF, versionNumber: 2, isDefault: true }));
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    handlers.set("orders.admin.workflows.list", () => []);
    const user = userEvent.setup();
    const { container, location } = designer();
    await user.click(await screen.findByRole("tab", { name: "Statuses wizard" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Statuses" })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^Staff label/)).toHaveLength(2);
    await expectNoAxeViolations(container);

    // Statuses step: the dead-end issue belongs to Transitions, so Statuses may continue.
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Transitions" })).toBeInTheDocument();
    // Transitions step: the server reports the dead end; Continue is blocked with the precise message.
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByText("Fix these problems to continue")).toBeInTheDocument();
    expect(screen.getAllByText(/has no way out/).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 2, name: "Transitions" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add transition" }));
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Who may move" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Staff" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Customer" }));
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Notices and notes" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Require a note/ }));
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    // Increment 04: phases and requirements step (optional; edits here are undone so the publish payload is unchanged).
    expect(await screen.findByRole("heading", { level: 2, name: "Status requirements" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add phase" }));
    expect(screen.getByLabelText(/Phase 1 name/)).toHaveValue("Phase 1");
    await user.click(screen.getAllByRole("button", { name: /^Add upload to / })[0]!);
    expect(screen.getAllByLabelText(/Upload name/)[0]).toHaveValue("Documents");
    await expectNoAxeViolations(container);
    await user.click(screen.getAllByRole("button", { name: /^Remove upload / })[0]!);
    await user.click(screen.getByRole("button", { name: /^Remove phase / }));
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Review and publish" })).toBeInTheDocument();
    expect(screen.getByText("The draft has no problems and is ready to publish.")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Use for new orders/ }));
    await user.type(screen.getByLabelText(/Change note/), "Customers may finish");
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(location.history.at(-1)).toBe(`/admin/workflows/${WF}/versions`));

    const lastSave = calls.filter((c) => c.path === "orders.admin.workflows.drafts.save").at(-1)?.input as { definition: { transitions: unknown[] } };
    expect(lastSave.definition.transitions).toEqual([{ ...transition, allowedBy: ["customer", "staff", "admin"], requiresNote: true }]);
    expect(calls.find((c) => c.path === "orders.admin.workflows.drafts.publish")?.input).toEqual({ draftId: DRAFT, expectedVersion: 1 + saves, makeDefault: true, changeNote: "Customers may finish" });
  });

  it("shows the server's conflict message when the draft changed elsewhere and does not advance", async () => {
    handlers.set("orders.admin.workflows.drafts.get", () => draftView([transition], []));
    handlers.set("orders.admin.workflows.drafts.save", () => {
      throw Object.assign(new Error("conflict"), { data: { safe: { domainCode: "CONFLICT", reasonCode: "STALE_VERSION", safeMessage: "This draft was changed by someone else. Reload it and try again.", requestId: "r" } } });
    });
    const user = userEvent.setup();
    designer();
    await user.click(await screen.findByRole("tab", { name: "Statuses wizard" }));
    await user.click(await screen.findByRole("button", { name: "Save and continue" }));
    expect(await screen.findByText("This draft was changed by someone else. Reload it and try again.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Statuses" })).toBeInTheDocument();
  });

  it("canvas edits the same draft: add a transition with the form, edit it in the side panel, save", async () => {
    handlers.set("orders.admin.workflows.drafts.get", () => draftView());
    handlers.set("orders.admin.workflows.drafts.save", () => ({ rowVersion: 2, issues: [], publishable: true }));
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    const user = userEvent.setup();
    const { container } = designer();
    await user.click(await screen.findByRole("tab", { name: "Statuses wizard" }));
    await user.click(await screen.findByRole("tab", { name: "Canvas" }));
    expect(await screen.findByRole("button", { name: /Start: Submitted/ }, { timeout: 10000 })).toBeInTheDocument();
    const add = screen.getByRole("group", { name: "Add a transition" });
    await user.selectOptions(within(add).getByLabelText("From"), "submitted");
    await user.selectOptions(within(add).getByLabelText("To"), "completed");
    await user.click(within(add).getByRole("button", { name: "Add transition" }));
    expect(await screen.findByRole("button", { name: /Transition 1: from Submitted to Completed/ })).toBeInTheDocument();
    const panel = screen.getByRole("complementary", { name: "Properties" });
    expect(within(panel).getByRole("heading", { name: "Transition: Submitted to Completed" })).toBeInTheDocument();
    await user.click(within(panel).getByRole("checkbox", { name: /Require a note/ }));
    await expectNoAxeViolations(container);

    fireEvent.click(screen.getByRole("button", { name: /Start: Submitted/ }));
    expect(await within(panel).findByRole("heading", { name: "Status: Submitted" })).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Save draft" })[0]!);
    await waitFor(() => expect(calls.some((c) => c.path === "orders.admin.workflows.drafts.save")).toBe(true));
    const saved = calls.find((c) => c.path === "orders.admin.workflows.drafts.save")?.input as { definition: { transitions: unknown[] } };
    expect(saved.definition.transitions).toEqual([{ ...transition, requiresNote: true }]);

    // The wizard shows the same edit.
    await user.click(screen.getByRole("tab", { name: "Statuses wizard" }));
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Transitions" })).toBeInTheDocument();
    expect(screen.getByText("Transition 1: Submitted to Completed")).toBeInTheDocument();
  });
});

describe("workflow designer — acceptance gates and storage folders (part B)", () => {
  it("edits a gate (policy, point, signature, ask again) and folders with a live example path; server issues show at the field", async () => {
    handlers.set("orders.admin.workflows.drafts.get", () => draftView([transition], []));
    let saves = 0;
    handlers.set("orders.admin.workflows.drafts.save", (input) => {
      saves += 1;
      const gates = (input as { definition: { acceptanceGates?: { policyPublicId: string }[] } }).definition.acceptanceGates ?? [];
      const issues = gates.some((gate) => !gate.policyPublicId)
        ? [{ severity: "error", code: "GATE_POLICY_REQUIRED", path: "acceptanceGates.0.policyPublicId", message: "Acceptance gate 1: choose a policy from the policy centre." }]
        : [];
      return { rowVersion: 1 + saves, issues, publishable: issues.length === 0 };
    });
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    const user = userEvent.setup();
    const { container } = designer();
    await user.click(await screen.findByRole("tab", { name: "Statuses wizard" }));
    await screen.findByRole("heading", { level: 2, name: "Statuses" });
    for (const next of ["Transitions", "Who may move", "Notices and notes", "Status requirements"]) {
      await user.click(screen.getByRole("button", { name: "Save and continue" }));
      expect(await screen.findByRole("heading", { level: 2, name: next })).toBeInTheDocument();
    }
    const gates = screen.getByRole("group", { name: "Acceptance gates" });
    expect(within(gates).getByText("No gates.")).toBeInTheDocument();
    await user.click(within(gates).getByRole("button", { name: "Add acceptance gate" }));
    const policy = within(gates).getByLabelText(/Gate 1 policy/);
    await waitFor(() => expect(within(policy).getByRole("option", { name: "Synthetic order terms" })).toBeInTheDocument());
    // Options come from the public published list, without the admin policy list (no step-up for designers).
    expect(calls.some((call) => call.path === "compliance.policies.admin.listDocuments")).toBe(false);
    const applies = within(gates).getByLabelText(/Gate 1 applies/);
    // Final statuses cannot be gated (nothing is submitted from them).
    expect(within(applies).getAllByRole("option").map((o) => o.textContent)).toEqual(["Before any work on the order", "Before submitting from “Submitted”"]);

    // Saving without a policy: the server's message appears at the field and the step is blocked.
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findAllByText("Acceptance gate 1: choose a policy from the policy centre.")).not.toHaveLength(0);
    expect(screen.getByRole("heading", { level: 2, name: "Status requirements" })).toBeInTheDocument();

    await user.selectOptions(policy, POLICY_A);
    await user.selectOptions(applies, "step:submitted");
    await user.selectOptions(within(gates).getByLabelText(/Gate 1 signature/), "typed_name");
    await user.click(within(gates).getByRole("checkbox", { name: "Ask again when the policy has a new version" }));

    const storage = screen.getByRole("group", { name: "Storage folder" });
    expect(within(storage).getByText("customers/RPCUS-A1B2C3D4E/orders/RP-2026-000123/Intake")).toBeInTheDocument();
    const folder = within(storage).getByLabelText(/Default storage folder/);
    await user.type(folder, "../secret");
    expect(within(storage).getByText("No example yet: the folder path is not valid.")).toBeInTheDocument();
    await user.clear(folder);
    await user.click(folder);
    await user.paste("clients/{customer_ref}/{order_ref}");
    expect(within(storage).getByText("clients/RPCUS-A1B2C3D4E/RP-2026-000123")).toBeInTheDocument();

    // Per-slot folder overrides the workflow default in the example.
    await user.click(screen.getAllByRole("button", { name: /^Add upload to / })[0]!);
    const slotFolder = screen.getAllByLabelText(/^Storage folder \(optional\)/)[0]!;
    await user.click(slotFolder);
    await user.paste("uploads/{slot}");
    expect(screen.getByText("uploads/Documents")).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Review and publish" })).toBeInTheDocument();
    const lastSave = calls.filter((c) => c.path === "orders.admin.workflows.drafts.save").at(-1)?.input as {
      definition: { acceptanceGates: unknown[]; storageFolder: string; states: { requirements?: { uploads: { storageFolder?: string }[] } }[] };
    };
    expect(lastSave.definition.acceptanceGates).toEqual([{ key: "terms", policyPublicId: POLICY_A, point: { stepKey: "submitted" }, signatureMode: "typed_name", askAgainOnNewVersion: false }]);
    expect(lastSave.definition.storageFolder).toBe("clients/{customer_ref}/{order_ref}");
    expect(lastSave.definition.states[0]!.requirements!.uploads[0]!.storageFolder).toBe("uploads/{slot}");
  });

  it("a gate can be removed and the policy list failing still leaves the editor usable", async () => {
    handlers.set("orders.admin.workflows.drafts.get", () => ({ ...draftView([transition], []), definition: { states, transitions: [transition], acceptanceGates: [{ key: "terms", policyPublicId: "01JTESTPOL00000000000000ZZ", point: "order_start", signatureMode: "checkbox", askAgainOnNewVersion: true }] } }));
    handlers.set("orders.admin.workflows.drafts.save", () => ({ rowVersion: 2, issues: [], publishable: true }));
    handlers.set("compliance.policies.listPublished", () => {
      throw new Error("FORBIDDEN");
    });
    const user = userEvent.setup();
    designer();
    await user.click(await screen.findByRole("tab", { name: "Statuses wizard" }));
    await screen.findByRole("heading", { level: 2, name: "Statuses" });
    for (let i = 0; i < 4; i += 1) await user.click(screen.getByRole("button", { name: "Save and continue" }));
    const gates = await screen.findByRole("group", { name: "Acceptance gates" });
    expect(await within(gates).findByText(/The policy list could not be loaded/)).toBeInTheDocument();
    expect(within(gates).getByRole("option", { name: "Policy not available (unpublished or removed)" })).toBeInTheDocument();
    await user.click(within(gates).getByRole("button", { name: "Remove gate 1" }));
    expect(within(gates).getByText("No gates.")).toBeInTheDocument();
  });
});

describe("workflow designer — customer tasks and findings (increment 06, D8)", () => {
  const toRules = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByRole("heading", { level: 2, name: "Statuses" });
    for (let i = 0; i < 4; i += 1) await user.click(screen.getByRole("button", { name: "Save and continue" }));
    await screen.findByRole("heading", { level: 2, name: "Status requirements" });
  };

  it("adds a recording and a document task with presets and response modes; the saved definition carries them", async () => {
    handlers.set("orders.admin.workflows.drafts.get", () => draftView([transition], []));
    handlers.set("orders.admin.workflows.drafts.save", () => ({ rowVersion: 2, issues: [], publishable: true }));
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    const user = userEvent.setup();
    const { container } = designer();
    await user.click(await screen.findByRole("tab", { name: "Statuses wizard" }));
    await toRules(user);

    await user.click(screen.getAllByRole("button", { name: /^Add recording to / })[0]!);
    expect(screen.getByLabelText(/How the customer adds audio/)).toHaveValue("either");
    const minutes = screen.getByLabelText(/Longest recording \(minutes\)/);
    await user.clear(minutes);
    await user.type(minutes, "15");

    await user.click(screen.getAllByRole("button", { name: /^Add document task to / })[0]!);
    await user.type(screen.getByLabelText(/Document name/), "Contract to sign");
    await user.click(screen.getByRole("checkbox", { name: "Edit in the portal" }));
    const presets = screen.getAllByRole("group", { name: /^File type presets for / }).at(-1)!;
    expect(within(presets).getByRole("checkbox", { name: /^Word/ })).toBeChecked();
    await user.click(within(presets).getByRole("checkbox", { name: /^PDF/ }));
    await user.click(within(presets).getByRole("checkbox", { name: /^Images/ }));
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Review and publish" })).toBeInTheDocument();
    const lastSave = calls.filter((c) => c.path === "orders.admin.workflows.drafts.save").at(-1)?.input as {
      definition: { states: { requirements?: { uploads: { kind: string; capture?: string; maxMinutes?: number }[]; documents?: { label: string; responseModes: string[]; allowedTypes: string[] }[] } }[] };
    };
    const requirements = lastSave.definition.states[0]!.requirements!;
    expect(requirements.uploads.at(-1)).toMatchObject({ kind: "audio", capture: "either", maxMinutes: 15 });
    expect(requirements.documents?.[0]).toMatchObject({ label: "Contract to sign", responseModes: ["edit_in_portal", "upload_reply"] });
    expect(requirements.documents?.[0]?.allowedTypes).toEqual(["docx", "png", "jpg"]);
  });

  it("the “to fix” badge opens a findings list and Show focuses the field with the problem", async () => {
    const labelIssue = { severity: "error", code: "UPLOAD_LABEL_REQUIRED", path: "states.0.requirements.uploads.0.label", message: "Submitted: upload 1 needs a name." };
    handlers.set("orders.admin.workflows.drafts.get", () => ({
      ...draftView([transition], [labelIssue]),
      definition: { states: [{ ...states[0], requirements: { uploads: [{ key: "contract", label: "", kind: "document", minCount: 1, maxCount: 1, allowedTypes: ["pdf"], uploadedBy: ["customer"] }], acknowledgements: [] } }, states[1]], transitions: [transition] },
    }));
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    const user = userEvent.setup();
    designer();
    await user.click(await screen.findByRole("tab", { name: "Statuses wizard" }));
    await screen.findByRole("heading", { level: 2, name: "Statuses" });
    const toggle = screen.getByRole("button", { name: /1 to fix/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const findings = document.getElementById("wf-findings")!;
    await user.click(within(findings).getByRole("button", { name: `Show: ${labelIssue.message}` }));
    expect(await screen.findByRole("heading", { level: 2, name: "Status requirements" })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement?.id).toBe("wf-field-states-0-requirements-uploads-0-label"));
    expect(document.activeElement).toHaveAttribute("aria-invalid", "true");
  });

  it("a finding without a matching field falls back to the step's problem list", async () => {
    handlers.set("orders.admin.workflows.drafts.get", () => draftView([], [deadEnd]));
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    const user = userEvent.setup();
    designer();
    await user.click(await screen.findByRole("tab", { name: "Statuses wizard" }));
    await screen.findByRole("heading", { level: 2, name: "Statuses" });
    await user.click(screen.getByRole("button", { name: /1 to fix/ }));
    await user.click(within(document.getElementById("wf-findings")!).getByRole("button", { name: `Show: ${deadEnd.message}` }));
    await waitFor(() => expect(["wf-step-problems", "wf-field-states-0"]).toContain(document.activeElement?.id));
  });
});

describe("workflow designer — review summary", () => {
  it("Review and publish summarises phases, requirement counts, gates and the files folder", async () => {
    const reviewStates = [
      { ...states[0]!, phase: "intake", requirements: { uploads: [{ key: "brief", label: "Brief", kind: "document", minCount: 1, maxCount: 1, allowedTypes: ["pdf"], uploadedBy: ["customer"], storageFolder: "Briefs/{order_ref}" }], acknowledgements: [{ key: "terms", title: "Terms", body: "Synthetic.", acceptedBy: "customer", requireTypedName: false }] } },
      { ...states[1]!, phase: "delivery" },
    ];
    const definition = {
      phases: [{ key: "intake", label: "Intake" }, { key: "delivery", label: "Delivery" }],
      states: reviewStates,
      transitions: [transition],
      storageFolder: "Orders/{order_ref}",
      acceptanceGates: [{ key: "terms", policyPublicId: POLICY_A, point: { stepKey: "submitted" }, signatureMode: "typed_name", askAgainOnNewVersion: true }],
    };
    handlers.set("orders.admin.workflows.drafts.get", () => ({ ...draftView([transition], []), definition }));
    handlers.set("orders.admin.workflows.drafts.save", () => ({ rowVersion: 2, issues: [], publishable: true }));
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    const user = userEvent.setup();
    const { container } = designer();
    await user.click(await screen.findByRole("tab", { name: "Statuses wizard" }));
    await screen.findByRole("heading", { level: 2, name: "Statuses" });
    for (const next of ["Transitions", "Who may move", "Notices and notes", "Status requirements", "Review and publish"]) {
      await user.click(screen.getByRole("button", { name: "Save and continue" }));
      expect(await screen.findByRole("heading", { level: 2, name: next })).toBeInTheDocument();
    }
    const summary = screen.getByRole("region", { name: "Phases, requirements, acceptance and storage" });
    expect(summary).toHaveTextContent("Each phase locks when the order moves on");
    expect(summary).toHaveTextContent("Intake: 1 status; requirements: 1 upload, 1 acknowledgement");
    expect(summary).toHaveTextContent("Delivery: 1 status; requirements: None");
    expect(await within(summary).findByText("Synthetic order terms")).toBeInTheDocument();
    expect(summary).toHaveTextContent("before submitting from “Submitted”; type their full name; asked again for a new policy version");
    expect(summary).toHaveTextContent("Orders/{order_ref}; 1 upload slot uses its own folder");
    expect(summary).toHaveTextContent("Example: Orders/RP-2026-000123");
    await expectNoAxeViolations(container);
  });
});

describe("designer part B page accessibility", () => {
  // The rules step with a gate and the folder fields (with the live example), checked as a page in light and dark.
  const prepare = async () => {
    handlers.set("orders.admin.workflows.drafts.get", () => ({ ...draftView([transition], []), definition: { states, transitions: [transition], acceptanceGates: [{ key: "terms", policyPublicId: "01JTESTPOL00000000000000ZZ", point: "order_start", signatureMode: "checkbox", askAgainOnNewVersion: true }] } }));
    handlers.set("orders.admin.workflows.drafts.save", () => ({ rowVersion: 2, issues: [], publishable: true }));
    handlers.set("orders.admin.workflows.drafts.list", () => []);
    document.title = "Workflow draft · Console";
    renderUi(<main><Route path="/admin/workflows/drafts/:draftId"><WorkflowDesignerPage /></Route></main>, { path: `/admin/workflows/drafts/${DRAFT}` });
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Statuses wizard" }));
    await screen.findByRole("heading", { level: 2, name: "Statuses" });
    for (const next of ["Transitions", "Who may move", "Notices and notes", "Status requirements"]) {
      fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
      await screen.findByRole("heading", { level: 2, name: next });
    }
    await screen.findByRole("group", { name: "Acceptance gates" });
  };
  pageA11y("designer rules step with an acceptance gate and storage folders", prepare);
});

describe("published versions", () => {
  it("lists versions with order counts and links to the read-only view", async () => {
    handlers.set("orders.admin.workflows.versions", () => ({
      workflow: { publicId: WF, workflowKey: "standard", name: "Standard", isDefault: true },
      versions: [
        { publicId: VERSION, versionNumber: 2, isCurrent: true, createdAt: now, changeNote: "Customers may finish", stateCount: 2, stageCount: 1, transitionCount: 1, orderCount: 0 },
        { publicId: "01JTESTWFV000000000000000B", versionNumber: 1, isCurrent: false, createdAt: now, changeNote: null, stateCount: 2, stageCount: 0, transitionCount: 1, orderCount: 7 },
      ],
    }));
    const { container } = renderUi(<Route path="/admin/workflows/:workflowId/versions"><WorkflowVersionsPage /></Route>, { path: `/admin/workflows/${WF}/versions` });
    expect((await screen.findAllByRole("link", { name: "Version 2" }))[0]).toHaveAttribute("href", `/admin/workflows/versions/${VERSION}`);
    expect(screen.getAllByText("Current").length).toBeGreaterThan(0);
    expect(screen.getAllByText("7").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 phase, 2 statuses, 1 transitions").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2 statuses, 1 transitions").length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });

  it("shows a published version read-only on the canvas and in tables", async () => {
    handlers.set("orders.admin.workflows.version", () => ({
      publicId: VERSION,
      workflowPublicId: WF,
      workflowName: "Standard",
      versionNumber: 2,
      isCurrent: true,
      createdAt: now,
      definition: { states, transitions: [transition] },
      layout: { nodes: [{ key: "completed", x: 400, y: 0 }] },
      changeNote: "Customers may finish",
    }));
    const { container } = renderUi(<Route path="/admin/workflows/versions/:versionId"><WorkflowVersionPage /></Route>, { path: `/admin/workflows/versions/${VERSION}` });
    expect(await screen.findByRole("heading", { level: 1, name: "Standard: version 2" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Transition 1: from Submitted to Completed/ })).toBeInTheDocument();
    expect(screen.getByText("Customers may finish")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Standard" })).toHaveAttribute("href", `/admin/workflows/${WF}/versions`);
    await expectNoAxeViolations(container);
  });
});
