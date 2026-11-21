/**
 * Increment 03 — order workflow designer (drafts, validation, publish as a new version, install standard) and the
 * order change hook / sync view for package H. All data SYNTHETIC.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Services } from "../../container.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createTestDeps, type fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createOrdersModule, type OrderChangeEvent, type OrdersModule } from "./index.js";
import { ordersRouter } from "./router.js";
import { orders, orderWorkflowDrafts, orderWorkflows } from "./schema.js";
import { BLANK_DRAFT, toDraft, validateDraft, type WorkflowDraftDefinition } from "./workflowDesign.js";
import { DEFAULT_WORKFLOW } from "./workflowTypes.js";
import { resolveOrderContext } from "./automationTriggers.js";
import { FakeEngagement, FakeFiles, fakeIdentity, idemKey, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let admin: TestUser;
let adminNoStepUp: TestUser;
let staff: TestUser;
let alice: TestUser;
let productId: string;
const changes: OrderChangeEvent[] = [];
let failListener = false;

const code = (error: unknown) => (error instanceof DomainError ? `${error.code}:${error.reasonCode}` : String(error));
async function expectError(promise: Promise<unknown>, expected: string): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(code(error)).toBe(expected);
    return error as DomainError;
  }
  throw new Error(`expected ${expected}`);
}
const call = (principal: ReturnType<typeof fakePrincipal> | null) =>
  createCallerFactory(ordersRouter)({ services: h.services, session: principal, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });
const codes = (definition: WorkflowDraftDefinition) => validateDraft(definition).map((issue) => `${issue.severity}:${issue.code}@${issue.path}`);
const newOrder = () => mod.orders.create(alice.principal, { projectName: "Synthetic", items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: idemKey() });
const boundVersion = async (publicId: string) => (await t.db.select({ v: orders.workflowVersionId }).from(orders).where(eq(orders.publicId, publicId)))[0]!.v;

beforeAll(async () => {
  t = await createTestDb({ schema: ordersTestSchema });
  h = createTestDeps({ db: t.db });
  mod = createOrdersModule(h.deps);
  h.services.orders = mod;
  h.services.identity = fakeIdentity(h, t.db) as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];
  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  adminNoStepUp = await insertUser(h, t.db, { role: "admin" });
  staff = await insertUser(h, t.db, { role: "staff", stepUp: true });
  alice = await insertUser(h, t.db);
  const group = await mod.catalog.createGroup(admin.principal, { name: "Synthetic group", description: "", sortOrder: 0, active: true });
  await mod.catalog.createProduct(admin.principal, {
    groupId: group.publicId,
    productKey: "synthetic-wf-1",
    sortOrder: 0,
    active: true,
    name: "Synthetic item",
    description: "",
    features: [],
    priceMinor: 1000,
    currency: "USD",
  });
  productId = (await mod.catalog.listAll())[0]!.products[0]!.publicId;
  mod.registerChangeListener(async (event, tx) => {
    expect(tx).toBeDefined();
    if (failListener) throw new Error("listener refused");
    changes.push(event);
  });
});
afterAll(() => t.cleanup());
beforeEach(() => {
  h.audit.failRecords = false;
  failListener = false;
});

describe("validateDraft (pure)", () => {
  it("accepts the standard workflow with no errors and no warnings", () => {
    expect(codes(toDraft(DEFAULT_WORKFLOW))).toEqual([]);
  });

  it("explains what a blank draft still needs", () => {
    expect(codes(BLANK_DRAFT)).toEqual(["error:TRANSITIONS_REQUIRED@transitions", "error:STATE_DEAD_END@states.0"]);
    const [, deadEnd] = validateDraft(BLANK_DRAFT);
    expect(deadEnd!.message).toBe("Status 1 (“Submitted”) has no way out. Add a transition from it, or mark it as final.");
  });

  it("reports every problem with a field path and a plain message", () => {
    const draft: WorkflowDraftDefinition = {
      states: [
        { key: "start", label: "Start", customerLabel: "Start", kind: "initial", tone: "info" },
        { key: "Bad Key", label: "Bad", customerLabel: "", kind: "active", tone: "info" },
        { key: "start", label: "Again", customerLabel: "Again", kind: "initial", tone: "info" },
        { key: "done", label: "Done", customerLabel: "Done", kind: "terminal", tone: "success" },
        { key: "island", label: "Island", customerLabel: "Island", kind: "terminal", tone: "neutral" },
      ],
      transitions: [
        { from: "start", to: "done", allowedBy: ["staff"], notifyCustomer: false, requiresNote: false },
        { from: "start", to: "nowhere", allowedBy: [], notifyCustomer: false, requiresNote: false },
        { from: "done", to: "start", allowedBy: ["admin"], notifyCustomer: false, requiresNote: false },
        { from: "start", to: "start", allowedBy: ["staff", "staff"], notifyCustomer: false, requiresNote: false, actionLabel: " " },
        { from: "start", to: "done", allowedBy: ["admin"], notifyCustomer: false, requiresNote: false },
      ],
    };
    const issues = validateDraft(draft);
    expect(issues.map((issue) => `${issue.severity}:${issue.code}@${issue.path}`)).toEqual([
      "error:STATE_KEY_FORMAT@states.1.key",
      "error:STATE_CUSTOMER_LABEL_REQUIRED@states.1.customerLabel",
      "error:STATE_KEY_DUPLICATE@states.2.key",
      "error:INITIAL_MULTIPLE@states",
      "error:TRANSITION_TO_UNKNOWN@transitions.1.to",
      "error:TRANSITION_NOBODY@transitions.1.allowedBy",
      "error:TRANSITION_FROM_TERMINAL@transitions.2.from",
      "error:TRANSITION_SELF@transitions.3.to",
      "error:TRANSITION_ACTOR_DUPLICATE@transitions.3.allowedBy",
      "error:TRANSITION_ACTION_LABEL_EMPTY@transitions.3.actionLabel",
      "error:TRANSITION_DUPLICATE@transitions.4",
    ]);
    expect(issues.find((issue) => issue.code === "STATE_KEY_DUPLICATE")!.message).toBe("Status 3 (“Again”): the key “start” is already used by status 1.");
    expect(issues.find((issue) => issue.code === "TRANSITION_FROM_TERMINAL")!.message).toContain("“Done” is a final status");
  });

  it("flags unreachable statuses and missing customer notices as warnings, and no path to a final status as an error", () => {
    const draft: WorkflowDraftDefinition = {
      states: [
        { key: "aa", label: "Alpha", customerLabel: "Alpha", kind: "initial", tone: "info" },
        { key: "bb", label: "Beta", customerLabel: "Beta", kind: "active", tone: "info" },
        { key: "cc", label: "Gamma", customerLabel: "Gamma", kind: "terminal", tone: "success" },
      ],
      transitions: [
        { from: "aa", to: "bb", allowedBy: ["staff"], notifyCustomer: false, requiresNote: false },
        { from: "bb", to: "aa", allowedBy: ["staff"], notifyCustomer: false, requiresNote: false },
      ],
    };
    expect(codes(draft)).toEqual(["warning:STATE_UNREACHABLE@states.2", "error:NO_PATH_TO_FINISH@transitions", "warning:NO_CUSTOMER_NOTICE@transitions"]);
  });
});

describe("designer service", () => {
  let standardId: string;
  let v1OrderId: string;

  it("installs the standard workflow explicitly (step-up, audited, idempotent)", async () => {
    await expectError(mod.workflows.installStandard(adminNoStepUp.principal), "STEP_UP_REQUIRED:STEP_UP_REQUIRED");
    h.audit.clear();
    const first = await mod.workflows.installStandard(admin.principal);
    expect(first).toMatchObject({ installed: true, versionNumber: 1 });
    expect(h.audit.named("workflow.changed")).toEqual([expect.objectContaining({ action: "create", reasonCode: "STANDARD_INSTALLED", actor: { userId: admin.id, role: "admin" } })]);
    expect(await mod.workflows.installStandard(admin.principal)).toEqual({ installed: false, workflowPublicId: first.workflowPublicId, versionNumber: 1 });
    standardId = first.workflowPublicId;
    v1OrderId = (await newOrder()).publicId;
  });

  it("customers and staff cannot reach the designer; only admins with workflows.manage", async () => {
    await expect(call(alice.principal).admin.workflows.drafts.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call(staff.principal).admin.workflows.drafts.create({ from: "blank", workflowKey: "nope", name: "Nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call(null).admin.workflows.installStandard()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("drafts an edit, saves invalid work in progress, refuses to publish it, then publishes a NEW version; existing orders keep theirs", async () => {
    const draft = await call(admin.principal).admin.workflows.drafts.create({ from: "copy", copyVersionId: (await mod.workflows.listVersions(standardId)).versions[0]!.publicId, workflowId: standardId });
    await expectError(mod.workflows.createDraft(admin.principal, { from: "standard", workflowId: standardId }), "CONFLICT:WORKFLOW_DRAFT_EXISTS");
    expect((await mod.workflows.list()).find((workflow) => workflow.publicId === standardId)!.draftPublicId).toBe(draft.publicId);
    const loaded = await mod.workflows.getDraft(draft.publicId);
    expect(loaded).toMatchObject({ workflowPublicId: standardId, baseVersionNumber: 1, source: "copy", publishable: true, rowVersion: 1 });

    const broken = structuredClone(loaded.definition);
    broken.states.push({ key: "", label: "Quality check", customerLabel: "Checking", kind: "active", tone: "info" });
    const saved = await mod.workflows.saveDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 1, name: "Standard", definition: broken, layout: { nodes: [{ key: "submitted", x: 10, y: 20 }, { key: "ghost", x: 0, y: 0 }] } });
    expect(saved.publishable).toBe(false);
    expect(saved.issues.map((issue) => issue.code)).toContain("STATE_KEY_REQUIRED");
    await expectError(mod.workflows.saveDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 1, name: "Standard", definition: broken }), "CONFLICT:STALE_VERSION");
    const refused = await expectError(mod.workflows.publishDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 2, makeDefault: false }), "VALIDATION:WORKFLOW_DRAFT_INVALID");
    expect(refused.details).toMatchObject({ issueCodes: ["STATE_KEY_REQUIRED"], issuePaths: expect.arrayContaining(["states.7.key"]) });

    const fixed = structuredClone(broken);
    fixed.states[7] = { key: "quality_check", label: "Quality check", customerLabel: "Checking", kind: "active", tone: "info" };
    fixed.transitions = fixed.transitions.filter((transition) => !(transition.from === "in_progress" && transition.to === "delivered"));
    fixed.transitions.push(
      { from: "in_progress", to: "quality_check", allowedBy: ["staff", "admin"], notifyCustomer: false, requiresNote: false },
      { from: "quality_check", to: "delivered", allowedBy: ["admin"], notifyCustomer: true, requiresNote: true, actionLabel: "Approve delivery" },
    );
    const savedAgain = await mod.workflows.saveDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 2, name: "Standard (QC)", definition: fixed });
    expect(savedAgain).toMatchObject({ rowVersion: 3, publishable: true });
    await expectError(mod.workflows.publishDraft(adminNoStepUp.principal, { draftId: draft.publicId, expectedVersion: 3, makeDefault: false }), "STEP_UP_REQUIRED:STEP_UP_REQUIRED");

    h.audit.clear();
    const published = await call(admin.principal).admin.workflows.drafts.publish({ draftId: draft.publicId, expectedVersion: 3, makeDefault: false, changeNote: "Adds a quality check" });
    expect(published).toEqual({ workflowPublicId: standardId, versionNumber: 2, isDefault: true });
    expect(h.audit.named("workflow.changed")[0]).toMatchObject({ action: "publish", attributes: expect.objectContaining({ version_number: 2, source: "copy", draft_id: draft.publicId }) });
    expect(h.audit.recordedInTx.every(Boolean)).toBe(true);
    expect(await t.db.select().from(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.publicId, draft.publicId))).toEqual([]);

    const v2OrderId = (await newOrder()).publicId;
    expect(await boundVersion(v1OrderId)).not.toBe(await boundVersion(v2OrderId));
    // The v1 order still follows v1: in_progress → delivered directly; the v2 order must pass the quality check.
    for (const [orderId, path] of [
      [v1OrderId, ["in_review", "in_progress", "delivered"]],
      [v2OrderId, ["in_review", "in_progress", "quality_check"]],
    ] as const) {
      for (const toStatus of path) {
        const view = await mod.orders.get(admin.principal, orderId, "console");
        await mod.orders.transition(admin.principal, { orderId, expectedVersion: view.version, toStatus });
      }
    }
    const v2View = await mod.orders.get(admin.principal, v2OrderId, "console");
    await expectError(mod.orders.transition(admin.principal, { orderId: v2OrderId, expectedVersion: v2View.version, toStatus: "delivered" }), "VALIDATION:NOTE_REQUIRED");

    const versions = await mod.workflows.listVersions(standardId);
    expect(versions.versions.map((version) => [version.versionNumber, version.isCurrent, version.orderCount, version.changeNote])).toEqual([
      [2, true, 1, "Adds a quality check"],
      [1, false, 1, null],
    ]);
    const readOnly = await call(admin.principal).admin.workflows.version({ versionId: versions.versions[0]!.publicId });
    expect(readOnly.layout).toEqual({ nodes: [{ key: "submitted", x: 10, y: 20 }] });
    expect(readOnly.definition.states.map((state) => state.key)).toContain("quality_check");
  });

  it("refuses to publish a draft whose workflow was published again after it started", async () => {
    const draft = await mod.workflows.createDraft(admin.principal, { from: "standard", workflowId: standardId });
    const [workflow] = await t.db.select().from(orderWorkflows).where(eq(orderWorkflows.publicId, standardId));
    await mod.workflows.publish(admin.principal, { workflowId: standardId, expectedVersion: workflow!.version, name: "Standard", definition: DEFAULT_WORKFLOW, makeDefault: false });
    await expectError(mod.workflows.publishDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 1, makeDefault: false }), "CONFLICT:WORKFLOW_CHANGED_SINCE_DRAFT");
    await expectError(mod.workflows.discardDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 9 }), "CONFLICT:STALE_VERSION");
    expect(await mod.workflows.discardDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 1 })).toEqual({ discarded: true });
    await expectError(mod.workflows.getDraft(draft.publicId), "NOT_FOUND:WORKFLOW_DRAFT_NOT_FOUND");
  });

  it("legacy direct create/publish are not mounted; internal callers need step-up and pass designer validation", async () => {
    const legacy = call(admin.principal).admin.workflows as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const [workflow] = await t.db.select().from(orderWorkflows).where(eq(orderWorkflows.publicId, standardId));
    const body = { workflowId: standardId, expectedVersion: workflow!.version, name: "Standard", definition: DEFAULT_WORKFLOW, makeDefault: false };
    await expect(legacy.publish!(body)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(legacy.create!({ workflowKey: "legacy_wf", name: "Legacy", definition: DEFAULT_WORKFLOW })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(Object.keys(ordersRouter._def.procedures).filter((path) => /^admin\.workflows\.(create|publish)$/.test(path))).toEqual([]);
    await expectError(mod.workflows.publish(adminNoStepUp.principal, body), "STEP_UP_REQUIRED:STEP_UP_REQUIRED");
    await expectError(mod.workflows.create(adminNoStepUp.principal, { workflowKey: "legacy_wf", name: "Legacy", definition: DEFAULT_WORKFLOW }), "STEP_UP_REQUIRED:STEP_UP_REQUIRED");
    await expectError(mod.workflows.publish(staff.principal, body), "FORBIDDEN:ACTOR_NOT_AUTHORIZED");
    const deadEnd = {
      states: [
        { key: "submitted", label: "Submitted", customerLabel: "Submitted", kind: "initial", tone: "info" },
        { key: "in_review", label: "In review", customerLabel: "In review", kind: "active", tone: "info" },
        { key: "completed", label: "Completed", customerLabel: "Completed", kind: "terminal", tone: "success" },
      ],
      transitions: [
        { from: "submitted", to: "in_review", allowedBy: ["staff"], notifyCustomer: true, requiresNote: false },
        { from: "submitted", to: "completed", allowedBy: ["staff"], notifyCustomer: true, requiresNote: false },
      ],
    };
    await expectError(mod.workflows.publish(admin.principal, { ...body, definition: deadEnd }), "VALIDATION:WORKFLOW_DRAFT_INVALID");
    const [after] = await t.db.select().from(orderWorkflows).where(eq(orderWorkflows.publicId, standardId));
    expect(after!.version).toBe(workflow!.version);
  });

  it("creates a new workflow from a blank draft; it is not the default unless asked", async () => {
    await expectError(mod.workflows.createDraft(admin.principal, { from: "blank", workflowKey: "standard", name: "Clash" }), "CONFLICT:WORKFLOW_KEY_TAKEN");
    const draft = await mod.workflows.createDraft(admin.principal, { from: "blank", workflowKey: "rush", name: "Rush" });
    await expectError(mod.workflows.createDraft(admin.principal, { from: "blank", workflowKey: "rush", name: "Rush again" }), "CONFLICT:WORKFLOW_KEY_TAKEN");
    const definition = structuredClone(BLANK_DRAFT);
    definition.transitions.push({ from: "submitted", to: "completed", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false });
    await mod.workflows.saveDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 1, name: "Rush", definition });
    expect((await mod.workflows.listDrafts()).find((entry) => entry.publicId === draft.publicId)).toMatchObject({ errorCount: 0, warningCount: 0, workflowPublicId: null });
    const published = await mod.workflows.publishDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 2, makeDefault: false });
    expect(published).toMatchObject({ versionNumber: 1, isDefault: false });
    expect((await mod.workflows.list()).find((workflow) => workflow.workflowKey === "rush")).toMatchObject({ isDefault: false, versionNumber: 1, draftPublicId: null, currentVersionPublicId: expect.any(String) });
    expect((await mod.workflows.currentDefault(t.db))!.workflowKey).toBe("standard");
  });

  it("refuses malformed drafts at the API boundary and validates unsaved bodies without writing", async () => {
    const draft = await mod.workflows.createDraft(admin.principal, { from: "standard", workflowId: standardId });
    const tooMany = { states: Array.from({ length: 31 }, (_, i) => ({ key: `s${i}x`, label: "S", customerLabel: "S", kind: "active", tone: "info" })), transitions: [] };
    await expectError(mod.workflows.saveDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 1, name: "X", definition: tooMany }), "VALIDATION:INVALID_WORKFLOW_DRAFT");
    await expectError(mod.workflows.saveDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 1, name: "X", definition: BLANK_DRAFT, layout: { nodes: [{ key: "a", x: 1e9, y: 0 }] } }), "VALIDATION:INVALID_WORKFLOW_LAYOUT");
    const checked = await call(admin.principal).admin.workflows.drafts.validate({ definition: BLANK_DRAFT });
    expect(checked.publishable).toBe(false);
    expect((await call(admin.principal).admin.workflows.drafts.validate({ definition: { states: "x" } })).issues[0]!.code).toBe("DRAFT_SHAPE");
    await mod.workflows.discardDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 1 });
  });
});

describe("order change hook and sync view (package H port)", () => {
  it("calls listeners inside the transaction; a throwing listener aborts the write", async () => {
    changes.length = 0;
    const order = await newOrder();
    const view = await mod.orders.get(admin.principal, order.publicId, "console");
    await mod.orders.transition(admin.principal, { orderId: order.publicId, expectedVersion: view.version, toStatus: "in_review" });
    expect(changes.filter((change) => change.orderPublicId === order.publicId).map((change) => change.kind)).toEqual(["created", "status_changed"]);
    failListener = true;
    await expect(newOrder()).rejects.toThrow("listener refused");
    const after = await mod.orders.get(admin.principal, order.publicId, "console");
    await expect(mod.orders.transition(admin.principal, { orderId: order.publicId, expectedVersion: after.version, toStatus: "in_progress" })).rejects.toThrow("listener refused");
    expect((await mod.orders.get(admin.principal, order.publicId, "console")).version).toBe(after.version);
  });

  it("getOrderSyncView returns the list-item fields, and null for unknown ids", async () => {
    const order = await newOrder();
    const view = await mod.getOrderSyncView(order.publicId);
    expect(view).toMatchObject({ publicId: order.publicId, reference: order.reference, status: { key: "submitted", label: "Submitted", kind: "initial" }, ownerUserId: alice.id, currency: "USD", subtotalMinor: 1000, discountMinor: 0, totalMinor: 1000, closedAt: null });
    expect(view!.items).toEqual([{ packetNumber: null, tier: null, name: "Synthetic item" }]);
    expect(await mod.getOrderSyncView("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
    expect(await mod.getOrderSyncView("not-an-id")).toBeNull();
    expect(await mod.getOrderRefByPublicId(order.publicId)).toMatchObject({ publicId: order.publicId, reference: order.reference, ownerUserId: alice.id });
    expect(await mod.getOrderRefByPublicId("not-an-id")).toBeNull();
    await expectError(mod.getOrderRefByPublicId(order.publicId, undefined, { forUpdate: true }), "VALIDATION:TX_REQUIRED");
  });

  it("listOrderPublicIdsForSync pages every order by ascending publicId (ids only)", async () => {
    await newOrder();
    await newOrder();
    const all = (await t.db.select({ publicId: orders.publicId }).from(orders)).map((row) => row.publicId).sort();
    const seen: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const page: { publicIds: string[]; nextAfter: string | null } = await mod.listOrderPublicIdsForSync({ afterPublicId: after, limit: 2 });
      expect(page.publicIds.length).toBeLessThanOrEqual(2);
      seen.push(...page.publicIds);
      if (!page.nextAfter) break;
      after = page.nextAfter;
    }
    expect(seen).toEqual(all);
    expect((await mod.listOrderPublicIdsForSync({ limit: 5000 })).publicIds.length).toBe(Math.min(all.length, 500));
    expect(await mod.listOrderPublicIdsForSync({ afterPublicId: all.at(-1)!, limit: 10 })).toEqual({ publicIds: [], nextAfter: null });
    await expectError(mod.listOrderPublicIdsForSync({ afterPublicId: "nope", limit: 10 }), "VALIDATION:INVALID_CURSOR");
  });
});

describe("automation trigger context (order triggers)", () => {
  const tapEvent = (eventName: string, publicId: string | null, attributes: Record<string, string> = {}) => ({
    eventId: "e1", eventName, category: "business" as const, action: "transition", outcome: "completed" as const, reasonCode: null,
    occurredAt: new Date().toISOString(), actor: { role: "admin" as const, userId: admin.id }, resource: publicId ? { type: "order", publicId } : null,
    correlationId: null, jobId: null, attributes, safeCounts: {},
  });
  const resolve = (event: ReturnType<typeof tapEvent>) =>
    resolveOrderContext({ triggerKey: "order.status_changed", event: event as never, db: t.db, services: h.services, signal: new AbortController().signal });

  it("labels the status from the event's to_status in the order's bound version, and addresses the owner by id only", async () => {
    const order = await newOrder();
    const context = await resolve(tapEvent("order.status.changed", order.publicId, { to_status: "in_review" }));
    expect(context).toEqual({
      orderPublicId: order.publicId,
      fields: { order_reference: order.reference, order_status_label: "Being reviewed", order_link: new URL(`/orders/${order.publicId}`, h.services.config.canonicalOrigin).href },
      recipients: { order_owner: [alice.id], order_assignee: [] },
    });
    expect((await resolve(tapEvent("order.created", order.publicId))).fields).toMatchObject({ order_status_label: "Submitted" });
  });

  it("returns nothing for missing, malformed or unknown order ids", async () => {
    expect(await resolve(tapEvent("order.created", null))).toEqual({});
    expect(await resolve(tapEvent("order.created", "x"))).toEqual({});
    expect(await resolve(tapEvent("order.created", "01ARZ3NDEKTSV4RRFFQ69G5FAV"))).toEqual({});
  });
});
