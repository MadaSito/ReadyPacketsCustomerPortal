/**
 * Increment 04 part B (S1) — console rename + name history, status-transition port, acceptance gate port
 * (`orders.gates`) and storage-folder routing. All data SYNTHETIC.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Services } from "../../container.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createTestDeps, type fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createOrdersModule, type OrderGateProvider, type OrdersModule } from "./index.js";
import { ordersRouter } from "./router.js";
import { orderNameHistory, orders } from "./schema.js";
import { DEFAULT_WORKFLOW, type WorkflowDefinition } from "./workflowTypes.js";
import type { BoundWorkflow } from "./workflows.js";
import { FakeEngagement, FakeFiles, fakeIdentity, idemKey, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let admin: TestUser;
let staff: TestUser;
let alice: TestUser;
let bob: TestUser;
let productId: string;

const code = (error: unknown) => (error instanceof DomainError ? `${error.code}:${error.reasonCode}` : String(error));
async function expectError(promise: Promise<unknown>, expected: string) {
  try {
    await promise;
  } catch (error) {
    expect(code(error)).toBe(expected);
    return;
  }
  throw new Error(`expected ${expected}`);
}
const call = (principal: ReturnType<typeof fakePrincipal> | null) =>
  createCallerFactory(ordersRouter)({ services: h.services, session: principal, request: newRequestContext("test"), transport: { issue() {}, clear() {} } });
const newOrder = (owner: TestUser = alice) =>
  mod.orders.create(owner.principal, { projectName: "Synthetic project", items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: idemKey() });
const versionOf = async (publicId: string) => (await t.db.select({ v: orders.version }).from(orders).where(eq(orders.publicId, publicId)))[0]!.v;
const idOf = async (publicId: string) => (await t.db.select({ id: orders.id }).from(orders).where(eq(orders.publicId, publicId)))[0]!.id;

/** Runs `fn` with every pinned version answering `definition` (patches the shared workflow service). */
async function withDefinition<T>(definition: WorkflowDefinition, fn: () => Promise<T>): Promise<T> {
  const original = mod.workflows.byVersionId;
  mod.workflows.byVersionId = async (db, versionId) => ({ ...(await original(db, versionId)), definition }) as BoundWorkflow;
  try {
    return await fn();
  } finally {
    mod.workflows.byVersionId = original;
  }
}
const POLICY = "01JD0000000000000000000P01";
const gated = (point: "order_start" | { stepKey: string }): WorkflowDefinition => ({
  ...DEFAULT_WORKFLOW,
  transitions: DEFAULT_WORKFLOW.transitions.map((tr) =>
    tr.from === "awaiting_customer" && tr.to === "in_review" ? { ...tr, allowedBy: [...tr.allowedBy, "api"] } : tr,
  ),
  acceptanceGates: [{ key: "terms", policyPublicId: POLICY, point, signatureMode: "checkbox", askAgainOnNewVersion: true }],
});

/** Moves an order (staff) to awaiting_customer so the customer has a non-cancel transition available. */
async function toAwaitingCustomer(publicId: string) {
  await mod.orders.transition(staff.principal, { orderId: publicId, expectedVersion: await versionOf(publicId), toStatus: "in_review" });
  await mod.orders.transition(staff.principal, { orderId: publicId, expectedVersion: await versionOf(publicId), toStatus: "awaiting_customer", note: "Synthetic request" });
}

const accepted = new Set<number>();
const calls: Parameters<OrderGateProvider["assertMet"]>[0][] = [];
const provider: OrderGateProvider = {
  async assertMet(input) {
    calls.push(input);
    if (!accepted.has(input.actor.userId)) throw new DomainError("CONFLICT", "ORDER_ACCEPTANCE_REQUIRED", "Please review and accept the terms first.");
  },
};

beforeAll(async () => {
  t = await createTestDb({ schema: ordersTestSchema });
  h = createTestDeps({ db: t.db });
  mod = createOrdersModule(h.deps);
  h.services.orders = mod;
  h.services.identity = fakeIdentity(h, t.db) as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];
  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  staff = await insertUser(h, t.db, { role: "staff" });
  alice = await insertUser(h, t.db);
  bob = await insertUser(h, t.db);
  const group = await mod.catalog.createGroup(admin.principal, { name: "Synthetic group", description: "", sortOrder: 0, active: true });
  const product = await mod.catalog.createProduct(admin.principal, {
    groupId: group.publicId,
    productKey: "synthetic-s1",
    sortOrder: 0,
    active: true,
    name: "Synthetic product",
    description: "",
    priceMinor: 1000,
    currency: "USD",
    features: [],
  });
  productId = product.publicId;
});
afterAll(() => t.cleanup());
beforeEach(() => {
  h.audit.failRecords = false;
  calls.length = 0;
  accepted.clear();
});

describe("orders.console.rename (B2)", () => {
  it("renames with NFC normalisation, bumps the version, keeps the reference, records history and a name-free audit event", async () => {
    const order = await newOrder();
    const before = await mod.orders.get(staff.principal, order.publicId);
    h.audit.clear();
    const result = await call(staff.principal).console.rename({ orderId: order.publicId, expectedVersion: before.version, name: "  Cafe\u0301 synthetic  " });
    expect(result).toEqual({ version: before.version + 1, changed: true });
    const after = await mod.orders.get(staff.principal, order.publicId);
    expect(after.projectName).toBe("Caf\u00e9 synthetic");
    expect(after.reference).toBe(before.reference);
    const event = h.audit.named("order.renamed").at(-1)!;
    expect(event).toMatchObject({ resource: { type: "order", publicId: order.publicId }, attributes: { renamed: true, old_length: 17, new_length: 14 } });
    expect(JSON.stringify(event)).not.toContain("Synthetic project");
    expect(JSON.stringify(event)).not.toContain("synthetic");
    expect(h.audit.recordedInTx.at(-1)).toBe(true);
    const rows = await t.db.select().from(orderNameHistory).where(eq(orderNameHistory.orderId, await idOf(order.publicId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ oldName: "Synthetic project", newName: "Caf\u00e9 synthetic", actorUserId: staff.id, actorRole: "staff" });
  });

  it("is a no-op for the same name, refuses stale versions, invalid names and customers", async () => {
    const order = await newOrder();
    const v = await versionOf(order.publicId);
    expect(await mod.orders.rename(staff.principal, { orderId: order.publicId, expectedVersion: v, name: "Synthetic project" })).toEqual({ version: v, changed: false });
    await expectError(mod.orders.rename(staff.principal, { orderId: order.publicId, expectedVersion: v + 5, name: "Other" }), "CONFLICT:STALE_VERSION");
    await expectError(mod.orders.rename(staff.principal, { orderId: order.publicId, expectedVersion: v, name: "bad\u0007name" }), "VALIDATION:ORDER_NAME_INVALID");
    await expectError(mod.orders.rename(staff.principal, { orderId: order.publicId, expectedVersion: v, name: "   " }), "VALIDATION:ORDER_NAME_INVALID");
    await expectError(mod.orders.rename(staff.principal, { orderId: order.publicId, expectedVersion: v, name: "x".repeat(121) }), "VALIDATION:ORDER_NAME_INVALID");
    await expect(call(alice.principal).console.rename({ orderId: order.publicId, expectedVersion: v, name: "Mine" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(mod.orders.rename(alice.principal, { orderId: order.publicId, expectedVersion: v, name: "Mine" })).rejects.toBeInstanceOf(DomainError);
    expect(await versionOf(order.publicId)).toBe(v);
  });

  it("fails closed when the audit write fails (rename and history roll back)", async () => {
    const order = await newOrder();
    const v = await versionOf(order.publicId);
    h.audit.failRecords = true;
    await expect(mod.orders.rename(staff.principal, { orderId: order.publicId, expectedVersion: v, name: "Rolled back" })).rejects.toBeTruthy();
    h.audit.failRecords = false;
    expect((await mod.orders.get(staff.principal, order.publicId)).projectName).toBe("Synthetic project");
    expect(await t.db.select().from(orderNameHistory).where(eq(orderNameHistory.orderId, await idOf(order.publicId)))).toHaveLength(0);
  });

  it("listNameHistory: staff see old → new newest first across pages (stable on timestamp ties); customers get a generic entry", async () => {
    const order = await newOrder();
    for (const name of ["Name one", "Name two", "Name three"]) {
      await mod.orders.rename(staff.principal, { orderId: order.publicId, expectedVersion: await versionOf(order.publicId), name });
    }
    const orderId = await idOf(order.publicId);
    const first = await mod.listNameHistory(orderId, { limit: 2, customerView: false });
    expect(first.items.map((i) => i.newName)).toEqual(["Name three", "Name two"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await mod.listNameHistory(orderId, { limit: 2, customerView: false, cursor: first.nextCursor });
    expect(second.items.map((i) => `${i.oldName} → ${i.newName}`)).toEqual(["Synthetic project → Name one"]);
    expect(second.nextCursor).toBeNull();
    expect(first.items[0]).toMatchObject({ actorUserId: staff.id, actorRole: "staff" });
    const customer = await mod.listNameHistory(orderId, { limit: 10, customerView: true });
    expect(customer.items).toHaveLength(3);
    for (const item of customer.items) expect(item).toMatchObject({ oldName: null, newName: null, actorUserId: null, actorRole: "staff" });
    await expectError(mod.listNameHistory(orderId, { limit: 2, customerView: false, cursor: "bad" }), "VALIDATION:INVALID_CURSOR");
  });
});

describe("listStatusTransitions (S2 port)", () => {
  it("returns transitions newest first and hides internal notes in the customer view", async () => {
    const order = await newOrder();
    await mod.orders.transition(staff.principal, { orderId: order.publicId, expectedVersion: await versionOf(order.publicId), toStatus: "in_review" });
    await mod.orders.transition(staff.principal, { orderId: order.publicId, expectedVersion: await versionOf(order.publicId), toStatus: "awaiting_customer", note: "Synthetic internal detail" });
    const orderId = await idOf(order.publicId);
    const staffView = await mod.listStatusTransitions(orderId, { limit: 10, customerView: false });
    expect(staffView.items[0]).toMatchObject({ from: "in_review", to: "awaiting_customer" });
    expect(staffView.items.map((i) => i.to)).toEqual(expect.arrayContaining(["in_review", "awaiting_customer"]));
    const customerView = await mod.listStatusTransitions(orderId, { limit: 10, customerView: true });
    expect(customerView.items.length).toBe(staffView.items.length);
    expect(staffView.items[0]!.note).toBe("Synthetic internal detail");
    // Customer view never shows more notes than staff, and only customer-visible ones.
    customerView.items.forEach((item, i) => expect(item.note === null || item.note === staffView.items[i]!.note).toBe(true));
    expect(customerView.items[0]!.toLabel).toBeTruthy();
    const paged = await mod.listStatusTransitions(orderId, { limit: 1, customerView: false });
    expect(paged.items).toHaveLength(1);
    expect(paged.nextCursor).not.toBeNull();
  });
});

describe("orders.gates (B6)", () => {
  it("fails closed with UNAVAILABLE when gates exist but no provider is registered", async () => {
    const fresh = createOrdersModule(createTestDeps({ db: t.db }).deps);
    const order = await newOrder();
    const orderId = await idOf(order.publicId);
    const original = fresh.workflows.byVersionId;
    fresh.workflows.byVersionId = async (db, versionId) => ({ ...(await original(db, versionId)), definition: gated("order_start") }) as BoundWorkflow;
    await expectError(
      t.db.transaction((tx) => fresh.gates.assertCustomerMayWork({ tx, orderId, actor: alice.principal, action: "upload", statusKey: null })),
      "UNAVAILABLE:ORDER_GATES_UNAVAILABLE",
    );
    // No gates ⇒ nothing to check, even without a provider.
    fresh.workflows.byVersionId = original;
    await t.db.transaction((tx) => fresh.gates.assertCustomerMayWork({ tx, orderId, actor: alice.principal, action: "upload", statusKey: null }));
  });

  it("blocks a customer transition with CONFLICT ORDER_ACCEPTANCE_REQUIRED until accepted; staff pass; cancel is never gated", async () => {
    mod.gates.registerProvider("acceptance", provider);
    const order = await newOrder();
    await toAwaitingCustomer(order.publicId);
    await withDefinition(gated("order_start"), async () => {
      await expectError(
        mod.orders.transition(alice.principal, { orderId: order.publicId, expectedVersion: await versionOf(order.publicId), toStatus: "in_review" }),
        "CONFLICT:ORDER_ACCEPTANCE_REQUIRED",
      );
      expect(calls.at(-1)).toMatchObject({ actor: { userId: alice.id }, point: { kind: "order_start" } });
      accepted.add(alice.id);
      await mod.orders.transition(alice.principal, { orderId: order.publicId, expectedVersion: await versionOf(order.publicId), toStatus: "in_review" });
      // Staff are never gated (no provider call).
      const before = calls.length;
      await mod.orders.transition(staff.principal, { orderId: order.publicId, expectedVersion: await versionOf(order.publicId), toStatus: "awaiting_customer", note: "Again" });
      expect(calls.length).toBe(before);
    });
    const other = await newOrder();
    await withDefinition(gated("order_start"), async () => {
      await mod.orders.transition(alice.principal, { orderId: other.publicId, expectedVersion: await versionOf(other.publicId), toStatus: "canceled" });
    });
    expect((await mod.orders.get(staff.principal, other.publicId)).statusKey).toBe("canceled");
  });

  it("step gates apply only at their step, using the FROM status", async () => {
    mod.gates.registerProvider("acceptance", provider);
    const order = await newOrder();
    const orderId = await idOf(order.publicId);
    await withDefinition(gated({ stepKey: "awaiting_customer" }), async () => {
      await t.db.transaction((tx) => mod.gates.assertCustomerMayWork({ tx, orderId, actor: alice.principal, action: "upload", statusKey: "submitted" }));
      await expectError(
        t.db.transaction((tx) => mod.gates.assertCustomerMayWork({ tx, orderId, actor: alice.principal, action: "upload", statusKey: "awaiting_customer" })),
        "CONFLICT:ORDER_ACCEPTANCE_REQUIRED",
      );
      expect(calls.at(-1)).toMatchObject({ point: { kind: "step", stepKey: "awaiting_customer" } });
    });
  });

  it("system / API v1 transitions are checked against the OWNER's acceptance", async () => {
    mod.gates.registerProvider("acceptance", provider);
    const order = await newOrder();
    await toAwaitingCustomer(order.publicId);
    await withDefinition(gated("order_start"), async () => {
      const input = () => versionOf(order.publicId).then((v) => ({ orderPublicId: order.publicId, expectedVersion: v, toStatus: "in_review", correlationId: "corr-s1" }));
      await expectError(mod.orders.transitionAsSystem(await input()), "CONFLICT:ORDER_ACCEPTANCE_REQUIRED");
      expect(calls.at(-1)).toMatchObject({ actor: { userId: alice.id, role: "customer" } });
      accepted.add(alice.id);
      await mod.orders.transitionAsSystem(await input());
    });
    expect((await mod.orders.get(staff.principal, order.publicId)).statusKey).toBe("in_review");
  });

  it("context() is scoped: owner and staff read it, another customer gets null", async () => {
    const order = await newOrder();
    await withDefinition(gated("order_start"), async () => {
      const own = await mod.gates.context(order.publicId, alice.principal);
      expect(own).toMatchObject({ orderPublicId: order.publicId, name: "Synthetic project", customerUserId: alice.id, actorAccess: "owner", gates: [{ key: "terms" }] });
      expect((await mod.gates.context(order.publicId, staff.principal))?.actorAccess).toBe("staff");
      expect(await mod.gates.context(order.publicId, bob.principal)).toBeNull();
      expect(await mod.gates.context("01JD0000000000000000000ZZZ", alice.principal)).toBeNull();
    });
  });

  it("rejects an invalid provider registration", () => {
    expect(() => mod.gates.registerProvider("acceptance", {} as OrderGateProvider)).toThrow();
  });
});

describe("getOrderFileFolderRouting", () => {
  it("returns slot and workflow templates for the order's pinned workflow, null for unknown orders", async () => {
    const order = await newOrder();
    const base = DEFAULT_WORKFLOW;
    const withFolders = { ...base, storageFolder: "Orders/{reference}" } as WorkflowDefinition;
    await withDefinition(withFolders, async () => {
      const routing = await t.db.transaction((tx) => mod.getOrderFileFolderRouting({ orderPublicId: order.publicId, statusKey: "submitted", slotKey: "nope" }, tx));
      expect(routing).toMatchObject({ slotTemplate: null, workflowTemplate: "Orders/{reference}" });
    });
    expect(await t.db.transaction((tx) => mod.getOrderFileFolderRouting({ orderPublicId: "01JD0000000000000000000ZZZ", statusKey: "submitted", slotKey: "x" }, tx))).toBeNull();
  });
});
