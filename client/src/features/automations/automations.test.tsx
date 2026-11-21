import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "wouter";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as transportModule from "@/lib/sessionTransport";
import type * as trpcModule from "@/lib/trpc";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import AutomationDetailPage from "./AutomationDetailPage";
import { CanvasBuilder, Editor } from "./AutomationEditorPage";
import AutomationsPage from "./AutomationsPage";
import {
  addAction, addCondition, addGroup, connect, draftFromRecipe, emptyDraft, moveAction, setTrigger, toGraph, toSaveInput, updateAction, updateCondition,
  validateDraft, type TriggerEntry, type AutomationDetailView, type AutomationRunView, type AutomationSummaryView, type Catalogue, type Draft,
} from "./model";
import { automationsFeature } from "./routes";

/* ---- tRPC mock: every procedure path resolves through `handlers[path]` ---- */
const { handlers, fetchMock, session } = vi.hoisted(() => ({
  handlers: {} as Record<string, (input: unknown) => unknown>, fetchMock: vi.fn(), session: { role: "admin" as string },
}));
vi.mock("@/lib/sessionTransport", async (original) => ({ ...await original<typeof transportModule>(), sessionFetch: fetchMock }));
vi.mock("@/lib/session", () => ({ useSession: () => ({ me: { state: "full", user: { role: session.role } }, view: { status: "full", role: session.role } }) }));
vi.mock("@/lib/trpc", async (original) => {
  const call = (path: string, input: unknown) => {
    const handler = handlers[path];
    if (!handler) return Promise.reject(new Error(`unmocked ${path}`));
    try { return Promise.resolve(handler(input)); } catch (e) { return Promise.reject(e); }
  };
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        const key = path.join(".");
        if (prop === "queryOptions") return (input?: unknown) => ({ queryKey: [key, input ?? null], queryFn: () => call(key, input) });
        if (prop === "mutationOptions") return () => ({ mutationFn: (input: unknown) => call(key, input) });
        if (prop === "pathFilter" || prop === "queryFilter") return () => ({ queryKey: [key] });
        if (prop === "queryKey" || prop === "pathKey") return () => [key];
        return node([...path, prop]);
      },
    });
  return { ...await original<typeof trpcModule>(), useTRPC: () => node([]), useTRPCClient: () => node([]) };
});

/* Synthetic subset of the curated trigger catalogue (the client may import server types only). */
const ADMINS = { key: "administrators", label: "Administrators", kind: "role" } as const;
const OWNER = { key: "order_owner", label: "Order owner (customer)", kind: "user" } as const;
const TRIGGER_CATALOGUE = [
  {
    key: "order.created", label: "Order created", group: "Orders", owner: "orders", description: "A new order was placed.", eventName: "order.created", outcomes: ["completed"], resourceType: "order",
    fields: [
      { key: "currency", label: "Currency", type: "string", from: "event" }, { key: "total_minor", label: "Order total", type: "money_minor", from: "event" },
      { key: "recipient_name", label: "Recipient name", type: "string", from: "context", personal: true },
    ],
    recipients: [OWNER, ADMINS],
  },
  {
    key: "message.internal_note", label: "Internal order note posted", group: "Files and messages", owner: "engagement", description: "Staff-only note.", eventName: "engagement.message.sent",
    outcomes: ["completed"], match: { visibility: "internal" }, resourceType: "order_message", staffOnly: true,
    fields: [{ key: "attachment_count", label: "Attachments", type: "number", from: "event" }], recipients: [ADMINS],
  },
  {
    key: "backup.failed", label: "Backup failed", group: "Operations", owner: "backup", description: "A backup could not be written.", eventName: "backup.archive.failed",
    outcomes: ["failed"], resourceType: "backup_archive", fields: [{ key: "reason_code", label: "Reason", type: "string", from: "event" }], recipients: [ADMINS],
  },
] as unknown as readonly TriggerEntry[];

const NOW = new Date("2026-11-20T12:00:00.000Z");
const AID = "au_synthetic_0001";
const catalogue: Catalogue = {
  globallyEnabled: false,
  limits: {
    globalRunsPerMinute: 60, defaultPerAutomationRunsPerHour: 30, maxPerAutomationRunsPerHour: 600, maxActionsPerAutomation: 10, maxConditionGroups: 10,
    maxConditionsPerGroup: 20, minScheduleMinutes: 15, maxScheduleMinutes: 10080, maxActiveSchedules: 50,
  },
  triggers: TRIGGER_CATALOGUE,
  actions: [
    {
      key: "email.send_template", label: "Send an e-mail", description: "Sends a published template.", category: "communication", owner: "mail",
      configFields: [
        { key: "templateKey", label: "Template", type: "template_key", required: true },
        { key: "recipientMode", label: "Send to", type: "enum", required: true, enumOptions: [{ value: "catalogue", label: "A person from the event" }, { value: "fixed", label: "A fixed address" }] },
        { key: "recipientKey", label: "Person", type: "trigger_recipient", required: false },
        { key: "fixedAddress", label: "Address", type: "email", required: false },
      ],
      requiresOrderContext: false, forbidOnStaffOnlyTrigger: false, supportedTriggerModes: ["event", "manual", "schedule"], retrySafe: true,
    },
    {
      key: "webhook.call", label: "Call a webhook", description: "Posts a signed JSON body.", category: "integration", owner: "integrations",
      configFields: [
        { key: "url", label: "Address", type: "https_url", required: true },
        { key: "signingSecret", label: "Signing secret", type: "secret", secret: true, required: true },
      ],
      requiresOrderContext: false, forbidOnStaffOnlyTrigger: true, supportedTriggerModes: ["event", "manual", "schedule"], retrySafe: false,
    },
  ] as unknown as Catalogue["actions"],
  operatorsByFieldType: {
    string: ["eq", "neq", "in", "not_in", "contains", "starts_with", "exists"], number: ["eq", "neq", "gt", "gte", "lt", "lte"], boolean: ["is_true", "is_false"],
    enum: ["eq", "neq", "in", "not_in"], money_minor: ["eq", "gt", "gte", "lt", "lte"], datetime: ["exists"], public_id: ["exists"],
  },
  starterRecipes: [
    {
      key: "order_confirmation", name: "Order confirmation e-mail", description: "E-mails the customer when an order is placed.",
      trigger: { kind: "event", triggerKey: "order.created" }, conditions: { match: "all", groups: [] },
      actions: [{ stepKey: "step_1", actionKey: "email.send_template", config: { templateKey: "order.confirmation", recipientMode: "catalogue", recipientKey: "order_owner" } }],
    },
    {
      key: "backup_failed_alert", name: "Backup failed alert", description: "Tells administrators when a backup fails.",
      trigger: { kind: "event", triggerKey: "backup.failed" }, conditions: { match: "all", groups: [] },
      actions: [{ stepKey: "step_1", actionKey: "email.send_template", config: { templateKey: "ops.backup_failed", recipientMode: "catalogue", recipientKey: "administrators" } }],
    },
  ],
} as unknown as Catalogue;

const summary = (patch: Partial<AutomationSummaryView> = {}): AutomationSummaryView => ({
  publicId: AID, name: "Order confirmation", description: null, enabled: false, version: 3, trigger: { kind: "event", triggerKey: "order.created" },
  conditionGroupCount: 0, actionCount: 1, maxRunsPerHour: 30, lastRun: { publicId: "ar_1", state: "completed", triggerMode: "event", startedAt: NOW, finishedAt: NOW, createdAt: NOW },
  createdAt: NOW, updatedAt: NOW, ...patch,
});
const detail = (patch: Partial<AutomationDetailView> = {}): AutomationDetailView => ({
  ...summary(), conditions: { match: "all", groups: [] }, canvasLayout: null,
  actions: [{ stepKey: "step_1", actionKey: "email.send_template", config: { templateKey: "order.confirmation", recipientMode: "catalogue", recipientKey: "order_owner" }, secretStatus: {} }],
  ...patch,
} as unknown as AutomationDetailView);
const run = (patch: Partial<AutomationRunView> = {}): AutomationRunView => ({
  publicId: "ar_synthetic_0001", automationPublicId: AID, automationName: "Order confirmation", automationVersion: 3, triggerMode: "event", triggerKey: "order.created",
  triggerEventId: "ev_1", correlationId: "automation:ar_synthetic_0001", isTest: false, state: "partial_unknown", reasonCode: "WEBHOOK_TIMEOUT",
  evaluatedFields: { currency: "USD" }, queuedAt: NOW, startedAt: NOW, finishedAt: NOW, durationMs: 1500,
  steps: [
    { stepIndex: 0, stepKey: "step_1", actionKey: "email.send_template", state: "completed", attemptCount: 1, reasonCode: null, safeSummary: "E-mail queued", safeCounts: null, externalRef: null, startedAt: NOW, finishedAt: NOW, durationMs: 300 },
    { stepIndex: 1, stepKey: "step_2", actionKey: "webhook.call", state: "unknown", attemptCount: 2, reasonCode: "WEBHOOK_TIMEOUT", safeSummary: "Webhook call", safeCounts: null, externalRef: null, startedAt: NOW, finishedAt: NOW, durationMs: 1200 },
  ],
  ...patch,
} as AutomationRunView);

beforeEach(() => {
  session.role = "admin";
  for (const k of Object.keys(handlers)) delete handlers[k];
  handlers["automations.catalogue"] = () => catalogue;
  handlers["automations.list"] = () => ({ items: [summary()], nextCursor: null });
  handlers["automations.get"] = () => detail();
  handlers["automations.runs.list"] = () => ({ items: [run()], nextCursor: null });
  handlers["automations.runs.get"] = () => run();
});
afterEach(() => { fetchMock.mockReset(); vi.restoreAllMocks(); });

const eventDraft = (): Draft => setTrigger({ ...emptyDraft(), name: "Big orders" }, { kind: "event", triggerKey: "order.created" }, catalogue);

describe("automations model", () => {
  it("validates each step and never offers personal fields to conditions", () => {
    const errors = validateDraft(emptyDraft(), catalogue);
    expect(errors.trigger.name).toBeDefined();
    expect(errors.trigger.trigger).toBeDefined();
    expect(errors.actions.actions).toBeDefined();
    const d = eventDraft();
    const fields = TRIGGER_CATALOGUE.find((t) => t.key === "order.created")!.fields;
    expect(fields.some((f) => f.personal)).toBe(true);
    let g = addGroup(d);
    const condId = g.groups[0]!.conditions[0]?.id ?? addCondition(g, g.groups[0]!.id).groups[0]!.conditions[0]!.id;
    if (!g.groups[0]!.conditions[0]) g = addCondition(g, g.groups[0]!.id);
    g = updateCondition(g, condId, { field: "total_minor", operator: "gte", value: "12.50" });
    expect(toSaveInput(g, catalogue).conditions.groups[0]!.conditions[0]).toEqual({ field: "total_minor", operator: "gte", value: 1250 });
    expect(validateDraft(updateCondition(g, condId, { field: "recipient_name" }), catalogue).conditions[`${condId}.field`]).toBeDefined();
  });

  it("refuses webhooks on staff-only triggers and requires write-only secrets", () => {
    let d = setTrigger({ ...emptyDraft(), name: "Notes" }, { kind: "event", triggerKey: "message.internal_note" }, catalogue);
    d = addAction(d, "webhook.call");
    const key = d.actions[0]!.stepKey;
    d = updateAction(d, key, { config: { url: "https://hooks.example.test/x" } });
    const errors = validateDraft(d, catalogue).actions;
    expect(Object.keys(errors).some((k) => k.startsWith(key))).toBe(true);
  });

  it("orders actions by canvas connections and moves", () => {
    let d = addAction(addAction(eventDraft(), "email.send_template"), "webhook.call");
    const [a, b] = d.actions.map((x) => x.stepKey) as [string, string];
    expect(connect(d, "trigger", b)!.actions.map((x) => x.stepKey)).toEqual([b, a]);
    expect(connect(d, b, "trigger")).toBeNull();
    d = moveAction(d, b, -1);
    expect(d.actions[0]!.stepKey).toBe(b);
    const graph = toGraph(d, catalogue);
    expect(graph.nodes[0]!.kind).toBe("Trigger");
    expect(graph.edges).toHaveLength(2);
  });

  it("prefills a starter recipe", () => {
    const d = draftFromRecipe(catalogue.starterRecipes[0]!, catalogue);
    expect(d.name).toBe("Order confirmation e-mail");
    expect(d.actions[0]!.config.recipientKey).toBe("order_owner");
    expect(validateDraft(d, catalogue).actions).toEqual({});
  });

  it("registers admin-only routes with the static paths first", () => {
    const paths = automationsFeature.routes.map((r) => r.path);
    expect(paths.indexOf("/admin/automations/new")).toBeLessThan(paths.indexOf("/admin/automations/:automationId"));
    expect(automationsFeature.routes.every((r) => r.access === "admin")).toBe(true);
    expect(automationsFeature.nav?.[0]).toMatchObject({ href: "/admin/automations", group: "Integrations", order: 62 });
  });
});

describe("AutomationsPage", () => {
  it("lists automations with state, last run and recipes, and warns when globally off", async () => {
    const { container } = renderUi(<AutomationsPage />);
    expect((await screen.findAllByRole("link", { name: "Order confirmation" }))[0]).toHaveAttribute("href", `/admin/automations/${AID}`);
    expect(screen.getByText(/switched off for the whole portal/)).toBeInTheDocument();
    expect(screen.getAllByText("Off").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Use recipe: Backup failed alert" })).toHaveAttribute("href", "/admin/automations/new?recipe=backup_failed_alert");
    await expectNoAxeViolations(container);
  });

  it("shows an error with retry when the list fails", async () => {
    handlers["automations.list"] = () => { throw new Error("boom"); };
    renderUi(<AutomationsPage />);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("turns an automation on with the current version", async () => {
    const setEnabled = vi.fn((_input: unknown) => detail({ enabled: true }));
    handlers["automations.setEnabled"] = setEnabled;
    renderUi(<AutomationsPage />);
    await userEvent.click((await screen.findAllByRole("button", { name: "Turn on Order confirmation" }))[0]!);
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith({ publicId: AID, expectedVersion: 3, enabled: true }));
  });
});

describe("wizard", () => {
  it("blocks Continue with visible errors, then saves a new automation", async () => {
    const create = vi.fn((_input: unknown) => detail());
    handlers["automations.create"] = create;
    const { container } = renderUi(<Editor catalogue={catalogue} initial={emptyDraft()} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Continue" })[0]!);
    expect(await screen.findByText("Give the automation a name.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^Name/), "New order notice");
    await userEvent.click(screen.getByLabelText(/An event/));
    await userEvent.selectOptions(screen.getByLabelText(/^Event/), "order.created");
    await expectNoAxeViolations(container);
    await userEvent.click(screen.getAllByRole("button", { name: "Continue" })[0]!);
    expect(await screen.findByRole("button", { name: /Add a condition/ })).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Continue" })[0]!);
    await userEvent.selectOptions(await screen.findByLabelText(/^Add an action/), "email.send_template");
    await userEvent.type(screen.getByLabelText(/^Template/), "order.confirmation");
    await userEvent.selectOptions(screen.getByLabelText(/^Send to/), "catalogue");
    await userEvent.selectOptions(screen.getByLabelText(/^Person/), "order_owner");
    await expectNoAxeViolations(container);
    await userEvent.click(screen.getAllByRole("button", { name: "Continue" })[0]!);
    expect(await screen.findByText("Actions, in order")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toMatchObject({ name: "New order notice", trigger: { kind: "event", triggerKey: "order.created" } });
  });

  it("runs a dry test from review and shows planned steps", async () => {
    const testRun = vi.fn((_input: unknown) => ({ dryRun: true, conditionsMatched: true, groupResults: [], plannedSteps: [{ stepKey: "step_1", actionKey: "email.send_template", wouldRun: true, previewSummary: "E-mail to the order owner" }] }));
    handlers["automations.testRun"] = testRun;
    renderUi(<Editor catalogue={catalogue} initial={draftFromRecipe(catalogue.starterRecipes[0]!, catalogue)} publicId={AID} expectedVersion={3} />);
    for (let i = 0; i < 3; i += 1) await userEvent.click(screen.getAllByRole("button", { name: "Continue" })[0]!);
    await userEvent.click(await screen.findByRole("button", { name: "Test without sending" }));
    expect(await screen.findByText("Would run: E-mail to the order owner")).toBeInTheDocument();
    expect(testRun.mock.calls[0]![0]).toMatchObject({ publicId: AID, executeLive: false });
  });
});

describe("canvas", () => {
  const original = { ro: window.ResizeObserver, w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"), h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight") };
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 80 });
    (window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; };
    window.ResizeObserver = class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(target: Element) { this.cb([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  afterAll(() => {
    window.ResizeObserver = original.ro;
    if (original.w) Object.defineProperty(HTMLElement.prototype, "offsetWidth", original.w);
    if (original.h) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original.h);
  });

  it("renders nodes and offers button alternatives to dragging", async () => {
    const onChange = vi.fn();
    const d = addAction(addAction(draftFromRecipe(catalogue.starterRecipes[0]!, catalogue), "webhook.call"), "email.send_template");
    const { container } = renderUi(<CanvasBuilder draft={d} onChange={onChange} catalogue={catalogue} errors={validateDraft(d, catalogue)} />);
    expect(await screen.findByText("Order created", { selector: "*" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Trigger" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/^Add an action/), "email.send_template");
    expect(onChange).toHaveBeenCalled();
    expect((onChange.mock.calls[0]![0] as Draft).actions).toHaveLength(4);
    await expectNoAxeViolations(container);
  });

  it("selecting an action node shows move and remove buttons", async () => {
    const onChange = vi.fn();
    const d = addAction(draftFromRecipe(catalogue.starterRecipes[0]!, catalogue), "webhook.call");
    renderUi(<CanvasBuilder draft={d} onChange={onChange} catalogue={catalogue} errors={validateDraft(d, catalogue)} />);
    const node = await screen.findByText("Call a webhook");
    fireEvent.click(node);
    expect(await screen.findByRole("heading", { name: "Step 2" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Move earlier" }));
    expect((onChange.mock.calls.at(-1)![0] as Draft).actions[0]!.actionKey).toBe("webhook.call");
    expect(screen.getByRole("button", { name: "Move later" })).toBeDisabled();
  });
});

describe("AutomationDetailPage", () => {
  const renderDetail = () => renderUi(<Route path="/admin/automations/:automationId"><AutomationDetailPage /></Route>, { path: `/admin/automations/${AID}` });

  it("shows summary, run history and per-step results", async () => {
    const { container } = renderDetail();
    expect(await screen.findByRole("heading", { level: 1, name: "Order confirmation" })).toBeInTheDocument();
    expect((await screen.findAllByText("1 of 2 completed")).length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
    await userEvent.click(screen.getAllByRole("button", { name: /^Details for run/ })[0]!);
    const drawer = await screen.findByRole("dialog", { name: "Run details" });
    expect(await within(drawer).findByText("2. Webhook call")).toBeInTheDocument();
    expect(within(drawer).getAllByText("WEBHOOK_TIMEOUT").length).toBeGreaterThan(0);
    expect(within(drawer).getByText("2 attempts")).toBeInTheDocument();
    expect(drawer.textContent).not.toMatch(/@/);
  });

  it("shows an error state when the automation cannot be loaded", async () => {
    handlers["automations.get"] = () => { throw new Error("nope"); };
    renderDetail();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
