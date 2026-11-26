/**
 * Increment 07.2 — "set default workflow": single-default switch (row locks, one transaction), idempotent, refuses
 * unknown / unpublished workflows, audited with previous and new default, same gates as publishing (admin +
 * workflows.manage + fresh step-up). New orders bind to the new default's current version; existing orders keep theirs.
 * All data SYNTHETIC.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Services } from "../../container.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createTestDeps, type fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createOrdersModule, type OrdersModule } from "./index.js";
import { ordersRouter } from "./router.js";
import { orders, orderWorkflows, orderWorkflowVersions } from "./schema.js";
import { BLANK_DRAFT } from "./workflowDesign.js";
import { FakeEngagement, FakeFiles, fakeIdentity, idemKey, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let admin: TestUser;
let adminNoStepUp: TestUser;
let staff: TestUser;
let alice: TestUser;
let productId: string;
let standardId: string;
let rushId: string;
let unpublishedId: string;

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
const newOrder = () => mod.orders.create(alice.principal, { projectName: "Synthetic", items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: idemKey() });
const boundWorkflowKey = async (orderPublicId: string) =>
  (
    await t.db
      .select({ key: orderWorkflows.workflowKey })
      .from(orders)
      .innerJoin(orderWorkflowVersions, eq(orderWorkflowVersions.id, orders.workflowVersionId))
      .innerJoin(orderWorkflows, eq(orderWorkflows.id, orderWorkflowVersions.workflowId))
      .where(eq(orders.publicId, orderPublicId))
  )[0]!.key;
const defaults = async () => (await t.db.select({ publicId: orderWorkflows.publicId }).from(orderWorkflows).where(eq(orderWorkflows.isDefault, true))).map((row) => row.publicId);

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
  await mod.catalog.createProduct(admin.principal, { groupId: group.publicId, productKey: "synthetic-def-1", sortOrder: 0, active: true, name: "Synthetic item", description: "", features: [], priceMinor: 1000, currency: "USD" });
  productId = (await mod.catalog.listAll())[0]!.products[0]!.publicId;
  await mod.workflows.installStandard(admin.principal);
  standardId = (await mod.workflows.list()).find((wf) => wf.workflowKey === "standard")!.publicId;
  // A second published workflow (not the default).
  const draft = await mod.workflows.createDraft(admin.principal, { from: "blank", workflowKey: "rush", name: "Rush" });
  const definition = structuredClone(BLANK_DRAFT);
  definition.transitions.push({ from: "submitted", to: "completed", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false });
  await mod.workflows.saveDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 1, name: "Rush", definition });
  rushId = (await mod.workflows.publishDraft(admin.principal, { draftId: draft.publicId, expectedVersion: 2, makeDefault: false })).workflowPublicId;
  // A workflow row with no published version (cannot be the default).
  unpublishedId = ulid(h.clock.now().getTime());
  await t.db.insert(orderWorkflows).values({ publicId: unpublishedId, workflowKey: "never_published", name: "Never published", isDefault: false });
});
afterAll(() => t.cleanup());
beforeEach(() => {
  h.audit.failRecords = false;
});

describe("workflows.setDefault (service)", () => {
  it("switches the single default, audits previous and new, and only new orders use the new default", async () => {
    expect(await defaults()).toEqual([standardId]);
    const before = (await newOrder()).publicId;
    h.audit.clear();
    const result = await mod.workflows.setDefault(admin.principal, { workflowId: rushId });
    expect(result).toEqual({ workflowPublicId: rushId, name: "Rush", versionNumber: 1, changed: true, previousWorkflowPublicId: standardId });
    expect(await defaults()).toEqual([rushId]);
    const [event] = h.audit.named("workflow.default.changed");
    expect(event).toMatchObject({
      action: "update",
      outcome: "completed",
      reasonCode: "DEFAULT_WORKFLOW_SET",
      resource: { type: "order_workflow", publicId: rushId },
      attributes: { workflow_key: "rush", version_number: 1, previous_workflow_id: standardId, previous_workflow_key: "standard" },
    });
    expect(h.audit.recordedInTx.every(Boolean)).toBe(true);
    const after = (await newOrder()).publicId;
    expect(await boundWorkflowKey(before)).toBe("standard");
    expect(await boundWorkflowKey(after)).toBe("rush");
    expect((await mod.workflows.list()).filter((wf) => wf.isDefault).map((wf) => wf.publicId)).toEqual([rushId]);
  });

  it("is idempotent when the workflow is already the default (nothing written, no audit)", async () => {
    h.audit.clear();
    const [rowBefore] = await t.db.select().from(orderWorkflows).where(eq(orderWorkflows.publicId, rushId));
    const result = await mod.workflows.setDefault(admin.principal, { workflowId: rushId });
    expect(result).toMatchObject({ workflowPublicId: rushId, changed: false, previousWorkflowPublicId: null });
    expect(h.audit.named("workflow.default.changed")).toHaveLength(0);
    const [rowAfter] = await t.db.select().from(orderWorkflows).where(eq(orderWorkflows.publicId, rushId));
    expect(rowAfter!.version).toBe(rowBefore!.version);
    expect(await defaults()).toEqual([rushId]);
  });

  it("refuses unpublished and unknown workflows with a clear reason and leaves the default unchanged", async () => {
    const refused = await expectError(mod.workflows.setDefault(admin.principal, { workflowId: unpublishedId }), "VALIDATION:WORKFLOW_NOT_PUBLISHED");
    expect(refused.safeMessage).toMatch(/Publish it first/);
    await expectError(mod.workflows.setDefault(admin.principal, { workflowId: ulid(h.clock.now().getTime() + 1) }), "NOT_FOUND:WORKFLOW_NOT_FOUND");
    expect(await defaults()).toEqual([rushId]);
  });

  it("needs a fresh step-up and an admin (same as publishing); refusals change nothing", async () => {
    await expectError(mod.workflows.setDefault(adminNoStepUp.principal, { workflowId: standardId }), "STEP_UP_REQUIRED:STEP_UP_REQUIRED");
    await expect(mod.workflows.setDefault(staff.principal, { workflowId: standardId })).rejects.toBeInstanceOf(DomainError);
    expect(await defaults()).toEqual([rushId]);
  });

  it("rolls back when the audit record fails", async () => {
    h.audit.failRecords = true;
    await expect(mod.workflows.setDefault(admin.principal, { workflowId: standardId })).rejects.toThrow();
    h.audit.failRecords = false;
    expect(await defaults()).toEqual([rushId]);
  });

  it("concurrent switches serialize: exactly one default remains", async () => {
    const results = await Promise.allSettled([
      mod.workflows.setDefault(admin.principal, { workflowId: standardId }),
      mod.workflows.setDefault(admin.principal, { workflowId: rushId }),
      mod.workflows.setDefault(admin.principal, { workflowId: standardId }),
      mod.workflows.setDefault(admin.principal, { workflowId: rushId }),
    ]);
    expect(results.every((entry) => entry.status === "fulfilled")).toBe(true);
    const now = await defaults();
    expect(now).toHaveLength(1);
    expect([standardId, rushId]).toContain(now[0]);
  });

  it("repairs a (legacy) double default: the target stays, every other default is cleared", async () => {
    await t.db.update(orderWorkflows).set({ isDefault: true }).where(eq(orderWorkflows.publicId, standardId));
    await t.db.update(orderWorkflows).set({ isDefault: true }).where(eq(orderWorkflows.publicId, rushId));
    h.audit.clear();
    const result = await mod.workflows.setDefault(admin.principal, { workflowId: rushId });
    expect(result).toMatchObject({ changed: true, previousWorkflowPublicId: standardId });
    expect(await defaults()).toEqual([rushId]);
    expect(h.audit.named("workflow.default.changed")[0]).toMatchObject({ safeCounts: { previous_defaults: 1 } });
  });
});

describe("orders.admin.workflows.setDefault (router)", () => {
  it("refuses anonymous, customers and staff; validates input; admin with step-up succeeds", async () => {
    await expect(call(null).admin.workflows.setDefault({ workflowId: standardId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(call(alice.principal).admin.workflows.setDefault({ workflowId: standardId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call(staff.principal).admin.workflows.setDefault({ workflowId: standardId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call(admin.principal).admin.workflows.setDefault({ workflowId: "not-a-ulid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(call(admin.principal).admin.workflows.setDefault({ workflowId: standardId, extra: true } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(call(adminNoStepUp.principal).admin.workflows.setDefault({ workflowId: standardId })).rejects.toThrow(/confirm your password/i);
    expect(await defaults()).toEqual([rushId]);
    const result = await call(admin.principal).admin.workflows.setDefault({ workflowId: standardId });
    expect(result).toMatchObject({ workflowPublicId: standardId, changed: true, previousWorkflowPublicId: rushId });
    expect(await defaults()).toEqual([standardId]);
  });
});
