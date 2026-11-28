/**
 * Increment 09 (D2): orders side of trash / restore / permanent deletion, against real MySQL.
 * - Central gate: trashed and tombstoned orders answer not-found for every principal and the trusted ports.
 * - Lists, search, groups and add-on targets exclude trashed orders; numbers stay reserved.
 * - Root cascade, same-batch replay, double submit (one winner), restore rules, purge claim and tombstone CAS.
 * - Participant purge erases orders-owned rows and keeps the line items and the reference.
 * All data SYNTHETIC (Zeus Greene, RPCUS-A1B2CJJG5, project "Ice Queen").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx } from "../../core/types.js";
import type { Services } from "../../container.js";
import type { TrashActor } from "../trash/ports.js";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createOrdersModule, type OrdersModule } from "./index.js";
import { orderLineItems, orderNotes, orderReferences, orders, orderStatusHistory, PACKET_TIERS } from "./schema.js";
import { FakeEngagement, FakeFiles, fakeIdentity, idemKey, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let admin: TestUser;
let zeus: TestUser;
const trashedOwners = new Set<number>();
const packet: Record<number, string> = {};
let actor: TrashActor;

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

const create = (user: TestUser, items: number[], extra: { addToOrderPublicId?: string; projectName?: string } = {}) =>
  mod.orders.create(user.principal, { projectName: extra.projectName ?? "Ice Queen", items: items.map((n) => ({ productPublicId: packet[n]!, quantity: 1 })), idempotencyKey: idemKey(), ...extra });

const rowOf = async (publicId: string) => (await t.db.select().from(orders).where(eq(orders.publicId, publicId)))[0]!;
const tx = <T>(fn: (tx: Parameters<Parameters<TestDb["db"]["transaction"]>[0]>[0]) => Promise<T>) => t.db.transaction(fn);
const trash = (publicId: string, batchId = ulid(h.clock.now().getTime())) =>
  tx((q) => mod.trash.trashOrderInTx(q, { orderPublicId: publicId, batchId, actor, reason: "Synthetic duplicate" }));
const restore = (publicId: string) => tx((q) => mod.trash.restoreOrderInTx(q, { orderPublicId: publicId, actor }));
const purgeFully = async (publicId: string) => {
  const row = await rowOf(publicId);
  const runId = ulid(h.clock.now().getTime());
  await tx((q) => mod.trash.markPurgeStartedInTx(q, { orderId: row.id, runId, actor }));
  await mod.trash.participant.purge!({ kind: "order", id: row.id, publicId, batchId: row.trashBatchId! }, { runId });
  await tx((q) => mod.trash.tombstoneOrderInTx(q, { orderId: row.id, runId, actor }));
};

beforeAll(async () => {
  t = await createTestDb({ schema: ordersTestSchema });
  h = createTestDeps({ db: t.db });
  mod = createOrdersModule(h.deps);
  h.services.orders = mod;
  const identity = fakeIdentity(h, t.db);
  h.services.identity = {
    ...identity,
    users: {
      async namePartsInTx() {
        return { firstName: "Zeus", lastName: "Greene", preferredName: null, customerRef: "RPCUS-A1B2CJJG5" };
      },
      async isTrashedInTx(_tx: DbOrTx, userId: number) {
        return trashedOwners.has(userId);
      },
      async lockGoneInTx(_tx: DbOrTx, userIds: readonly number[]) {
        return userIds.filter((id) => trashedOwners.has(id));
      },
    },
  } as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];
  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  zeus = await insertUser(h, t.db);
  actor = { kind: "user", userId: admin.id, publicId: admin.publicId };
  for (const n of [1, 2, 3]) {
    const group = await mod.catalog.createGroup(admin.principal, { name: `Synthetic packet ${n}`, description: "", sortOrder: n, active: true, groupKey: `synthetic-${n}`, packetNumber: n });
    await mod.catalog.createProduct(admin.principal, {
      groupId: group.publicId,
      productKey: `synthetic-p${n}`,
      sortOrder: n,
      active: true,
      name: `Synthetic packet ${n}`,
      description: "",
      features: [],
      priceMinor: 1000 * n,
      currency: "USD",
      packetNumber: n,
      tier: PACKET_TIERS[0],
    } as Parameters<OrdersModule["catalog"]["createProduct"]>[1]);
  }
  for (const p of (await mod.catalog.listAll()).flatMap((g) => g.products)) packet[p.packetNumber!] = p.publicId;
}, 120_000);

afterAll(() => t.cleanup());

describe("central gate", () => {
  it("a trashed order is not found for owner, admin and the trusted ports; isTrashedInTx fails closed", async () => {
    const order = await create(zeus, [1]);
    const row = await rowOf(order.publicId);
    expect(await mod.isTrashedInTx(t.db, row.id)).toBe(false);
    await trash(order.publicId);
    expect(await mod.isTrashedInTx(t.db, row.id)).toBe(true);
    expect(await mod.isTrashedInTx(t.db, 99_999_999)).toBe(true);
    await expectError(mod.assertCanReadOrder(zeus.principal, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.assertCanReadOrder(admin.principal, order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(mod.orders.get(admin.principal, order.publicId, "console"), "NOT_FOUND:ORDER_NOT_FOUND");
    expect(await mod.getOrderRefById(row.id)).toBeNull();
    expect(await mod.getOrderRefByPublicId(order.publicId)).toBeNull();
    expect(await mod.getOrderSyncView(order.publicId)).toBeNull();
    const custody = await tx((q) => mod.retainedOrderRefInTx(q, row.id, { forUpdate: true }));
    expect(custody).toMatchObject({ publicId: order.publicId, trashed: true, purgeStarted: false, purged: false });
  });

  it("lists, admin list, search and accessible ids exclude it; the number stays reserved", async () => {
    const order = await create(zeus, [2], { projectName: "Hidden Lake" });
    await trash(order.publicId);
    const mine = await mod.orders.list(zeus.principal, {});
    expect(mine.items.some((i) => i.publicId === order.publicId)).toBe(false);
    const all = await mod.orders.adminList(admin.principal, {});
    expect(all.items.some((i) => i.publicId === order.publicId)).toBe(false);
    const hits = await mod.searchOrders(admin.principal, order.reference);
    expect(hits.some((x) => x.publicId === order.publicId)).toBe(false);
    const ids = await mod.listAccessibleOrderIds(zeus.principal);
    if (!ids.all) expect(ids.orderIds).not.toContain((await rowOf(order.publicId)).id);
    const refs = await t.db.select().from(orderReferences).where(eq(orderReferences.reference, order.reference));
    expect(refs).toHaveLength(1);
  });
});

describe("groups", () => {
  it("a root takes its live additions into the same batch; a replay returns the batch; another batch gets 409", async () => {
    const root = await create(zeus, [1], { projectName: "Snow Field" });
    const add = await create(zeus, [2], { addToOrderPublicId: root.publicId });
    const batchId = ulid(h.clock.now().getTime());
    const first = await trash(root.publicId, batchId);
    expect(first.entities.map((e) => e.publicId).sort()).toEqual([root.publicId, add.publicId].sort());
    expect((await rowOf(add.publicId)).trashBatchId).toBe(batchId);
    const replay = await trash(root.publicId, batchId);
    expect(replay.entities).toHaveLength(2);
    await expectError(trash(root.publicId), "CONFLICT:ORDER_ALREADY_IN_TRASH");
    // A restore of the root brings both back.
    const back = await restore(root.publicId);
    expect(back.entities).toHaveLength(2);
    expect((await rowOf(add.publicId)).trashedAt).toBeNull();
  });

  it("concurrent trash of the same order with different batches has exactly one winner", async () => {
    const order = await create(zeus, [3], { projectName: "Race Track" });
    const results = await Promise.allSettled([trash(order.publicId), trash(order.publicId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(code(loser.reason)).toMatch(/CONFLICT:ORDER_(ALREADY_IN_TRASH|TRASH_STATE_CHANGED)/);
  });

  it("an addition is trashed alone, hidden from the group and add-on target; it cannot be restored while the root is in the trash", async () => {
    const root = await create(zeus, [1], { projectName: "Glacier Bay" });
    const add = await create(zeus, [2], { addToOrderPublicId: root.publicId });
    await trash(add.publicId);
    const view = await mod.orders.get(zeus.principal, root.publicId);
    expect(view.group.orders.map((o) => o.publicId)).not.toContain(add.publicId);
    await expectError(mod.orders.addOnTarget(zeus.principal, { orderId: add.publicId }), "NOT_FOUND:ORDER_NOT_FOUND").catch(async () => {
      expect(await mod.orders.addOnTarget(zeus.principal, { orderId: add.publicId })).toBeNull();
    });
    // The root trashed later keeps the addition's own batch.
    const rootBatch = await trash(root.publicId);
    expect(rootBatch.entities.map((e) => e.publicId)).toEqual([root.publicId]);
    await expectError(restore(add.publicId), "CONFLICT:ROOT_IN_TRASH");
    await restore(root.publicId);
    expect((await rowOf(add.publicId)).trashedAt).not.toBeNull();
    await restore(add.publicId);
    expect((await rowOf(add.publicId)).trashedAt).toBeNull();
  });

  it("restore is refused with 409 when the project now has the same packet; nothing is restored", async () => {
    const root = await create(zeus, [1], { projectName: "Ice Wall" });
    const add = await create(zeus, [2], { addToOrderPublicId: root.publicId });
    await trash(add.publicId);
    await create(zeus, [2], { addToOrderPublicId: root.publicId });
    await expectError(restore(add.publicId), "CONFLICT:PACKET_ALREADY_IN_PROJECT");
    expect((await rowOf(add.publicId)).trashedAt).not.toBeNull();
  });
});

describe("restore rules", () => {
  it("not in trash, owner in trash and purge started answer 409", async () => {
    const order = await create(zeus, [1], { projectName: "Cold Front" });
    await expectError(restore(order.publicId), "CONFLICT:ORDER_NOT_IN_TRASH");
    await trash(order.publicId);
    trashedOwners.add(zeus.id);
    try {
      await expectError(restore(order.publicId), "CONFLICT:OWNER_IN_TRASH");
    } finally {
      trashedOwners.delete(zeus.id);
    }
    const row = await rowOf(order.publicId);
    await tx((q) => mod.trash.markPurgeStartedInTx(q, { orderId: row.id, runId: ulid(h.clock.now().getTime()), actor }));
    await expectError(restore(order.publicId), "CONFLICT:PURGE_IN_PROGRESS");
  });

  it("customer cascade moves all live orders in one batch and the batch restore brings back exactly that batch", async () => {
    const customer = await insertUser(h, t.db);
    const a = await create(customer, [1], { projectName: "North Pole" });
    const b = await create(customer, [2], { projectName: "South Pole" });
    await trash(b.publicId);
    const batchId = ulid(h.clock.now().getTime());
    const moved = await tx((q) => mod.trash.trashOrdersOfCustomerInTx(q, { ownerUserId: customer.id, batchId, actor, reason: null }));
    expect(moved.entities.map((e) => e.publicId)).toEqual([a.publicId]);
    const back = await tx((q) => mod.trash.restoreOrdersOfBatchInTx(q, { ownerUserId: customer.id, batchId, actor }));
    expect(back.entities.map((e) => e.publicId)).toEqual([a.publicId]);
    expect((await rowOf(b.publicId)).trashedAt).not.toBeNull();
    const listed = await mod.trash.ordersOfCustomerInTx(t.db, customer.id, { state: "trashed" });
    expect(listed.map((o) => o.publicId)).toEqual([b.publicId]);
  });
});

describe("security findings", () => {
  it("legal hold: no move to trash (alone or in a customer cascade) and no purge claim: ORDER_ON_LEGAL_HOLD", async () => {
    const customer = await insertUser(h, t.db);
    const held = await create(customer, [1], { projectName: "Held Peak" });
    const other = await create(customer, [2], { projectName: "Open Peak" });
    await t.db.update(orders).set({ lockState: "legal_hold" }).where(eq(orders.publicId, held.publicId));
    await expectError(trash(held.publicId), "CONFLICT:ORDER_ON_LEGAL_HOLD");
    await expectError(tx((q) => mod.trash.trashOrdersOfCustomerInTx(q, { ownerUserId: customer.id, batchId: ulid(h.clock.now().getTime()), actor, reason: null })), "CONFLICT:ORDER_ON_LEGAL_HOLD");
    expect((await rowOf(other.publicId)).trashedAt).toBeNull();
    // Put on hold after it was trashed: the purge claim is refused.
    await trash(other.publicId);
    await t.db.update(orders).set({ lockState: "legal_hold" }).where(eq(orders.publicId, other.publicId));
    const row = await rowOf(other.publicId);
    await expectError(tx((q) => mod.trash.markPurgeStartedInTx(q, { orderId: row.id, runId: "r", actor })), "CONFLICT:ORDER_ON_LEGAL_HOLD");
  });

  it("restoring a root checks every owner in its batch (an addition reassigned to a customer now in the trash)", async () => {
    const otherOwner = await insertUser(h, t.db);
    const root = await create(zeus, [1], { projectName: "Split Ice" });
    const add = await create(zeus, [2], { addToOrderPublicId: root.publicId });
    await t.db.update(orders).set({ ownerUserId: otherOwner.id }).where(eq(orders.publicId, add.publicId));
    await trash(root.publicId);
    trashedOwners.add(otherOwner.id);
    try {
      await expectError(restore(root.publicId), "CONFLICT:OWNER_IN_TRASH");
    } finally {
      trashedOwners.delete(otherOwner.id);
    }
    expect((await rowOf(root.publicId)).trashedAt).not.toBeNull();
  });

  it("a reassignment replay of an order now in the trash answers not found", async () => {
    const target = await insertUser(h, t.db);
    const order = await create(zeus, [3], { projectName: "Moved Floe" });
    const input = { orderId: order.publicId, targetCustomerPublicId: target.publicId, expectedVersion: (await rowOf(order.publicId)).version, operationId: idemKey(), reasonCode: "MOVE" };
    await mod.orders.reassign(admin.principal, input);
    await trash(order.publicId);
    await expectError(mod.orders.reassign(admin.principal, input), "NOT_FOUND:ORDER_NOT_FOUND");
  });
});

describe("purge", () => {
  it("participant purge refuses before the claim; after it erases orders-owned rows; the tombstone keeps the reference", async () => {
    const order = await create(zeus, [3], { projectName: "Frozen Ridge" });
    const row = await rowOf(order.publicId);
    await t.db.insert(orderNotes).values({ publicId: ulid(h.clock.now().getTime()), orderId: row.id, authorUserId: null, authorRole: "staff", visibility: "internal", bodyEnc: "x", createdAt: h.clock.now() });
    await trash(order.publicId);
    await expectError(mod.trash.participant.purge!({ kind: "order", id: row.id, publicId: order.publicId, batchId: "x" }, { runId: "r" }), "CONFLICT:ORDER_PURGE_NOT_STARTED");
    await expectError(tx((q) => mod.trash.tombstoneOrderInTx(q, { orderId: row.id, runId: "r", actor })), "CONFLICT:ORDER_PURGE_NOT_STARTED");
    const summary = await mod.trash.participant.summarize!({ kind: "order", id: row.id, publicId: order.publicId, batchId: (await rowOf(order.publicId)).trashBatchId! });
    expect(summary).toMatchObject({ lineItems: 1, notes: 1 });
    await purgeFully(order.publicId);
    const tomb = await rowOf(order.publicId);
    expect(tomb.purgedAt).not.toBeNull();
    expect(tomb.projectName).toBe("Deleted order");
    expect(tomb.reference).toBe(order.reference);
    expect(tomb.trashReason).toBeNull();
    expect(await t.db.select().from(orderNotes).where(eq(orderNotes.orderId, row.id))).toHaveLength(0);
    expect(await t.db.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, row.id))).toHaveLength(0);
    expect(await t.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, row.id))).toHaveLength(1);
    // Idempotent tombstone; a tombstone is not found everywhere, including restore and trash.
    await tx((q) => mod.trash.tombstoneOrderInTx(q, { orderId: row.id, runId: "r", actor }));
    await expectError(restore(order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(trash(order.publicId), "NOT_FOUND:ORDER_NOT_FOUND");
    expect(await mod.trash.trashRefInTx(t.db, order.publicId)).toMatchObject({ purgedAt: expect.any(Date) });
    const listed = await mod.trash.listTrashed({ q: order.reference });
    expect(listed.items).toHaveLength(0);
  });

  it("listTrashed and trashRefInTx return the agreed fields", async () => {
    const root = await create(zeus, [1], { projectName: "Polar Night" });
    const add = await create(zeus, [2], { addToOrderPublicId: root.publicId });
    const batch = await trash(root.publicId);
    const listed = await mod.trash.listTrashed({ q: root.reference.slice(0, -4), limit: 1000 });
    const child = listed.items.find((i) => i.publicId === add.publicId)!;
    expect(child).toMatchObject({ projectName: "Polar Night", groupRootPublicId: root.publicId, groupRootTrashed: true, batchId: batch.entities[0]!.batchId, reason: "Synthetic duplicate" });
    const inBatch = await mod.trash.ordersInBatchInTx(t.db, batch.entities[0]!.batchId);
    expect(inBatch.map((r) => r.publicId)).toEqual([root.publicId, add.publicId]);
  });
});
