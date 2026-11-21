/** Workflow designer client: list + install, wizard, canvas, versions and read-only published view (fake tRPC only). */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import type * as trpcModule from "@/lib/trpc";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import AdminWorkflowsPage from "../AdminWorkflowsPage";
import WorkflowDesignerPage from "./WorkflowDesignerPage";
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
vi.mock("@/lib/trpc", async (original) => ({ ...(await original<typeof trpcModule>()), useTRPC: () => proxy([]) }));

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

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
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
    await user.click(screen.getByRole("tab", { name: "Wizard" }));
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Transitions" })).toBeInTheDocument();
    expect(screen.getByText("Transition 1: Submitted to Completed")).toBeInTheDocument();
  });
});

describe("published versions", () => {
  it("lists versions with order counts and links to the read-only view", async () => {
    handlers.set("orders.admin.workflows.versions", () => ({
      workflow: { publicId: WF, workflowKey: "standard", name: "Standard", isDefault: true },
      versions: [
        { publicId: VERSION, versionNumber: 2, isCurrent: true, createdAt: now, changeNote: "Customers may finish", stateCount: 2, transitionCount: 1, orderCount: 0 },
        { publicId: "01JTESTWFV000000000000000B", versionNumber: 1, isCurrent: false, createdAt: now, changeNote: null, stateCount: 2, transitionCount: 1, orderCount: 7 },
      ],
    }));
    const { container } = renderUi(<Route path="/admin/workflows/:workflowId/versions"><WorkflowVersionsPage /></Route>, { path: `/admin/workflows/${WF}/versions` });
    expect((await screen.findAllByRole("link", { name: "Version 2" }))[0]).toHaveAttribute("href", `/admin/workflows/versions/${VERSION}`);
    expect(screen.getAllByText("Current").length).toBeGreaterThan(0);
    expect(screen.getAllByText("7").length).toBeGreaterThan(0);
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
