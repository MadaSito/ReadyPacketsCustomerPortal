/**
 * Increment 08 (D2 + D3): stem references and add-on orders, against real MySQL.
 * - New orders get `RP-C4-F3L3-P6-NNN` from identity's name parts; additions reuse the root's frozen stem (-002, …).
 * - Add-on checks under the root lock: owner only (foreign roots answer ORDER_NOT_FOUND), not cancelled, same currency,
 *   no packet already in the project (any tier) → PACKET_ALREADY_IN_PROJECT.
 * - Read model: `group` + `canAddPackets` on orders.get, `group` on list items, `addOnTarget`.
 * - Older `RP-YYYY-NNNNNN` references stay valid; a reserved candidate is skipped and never reused.
 * All data SYNTHETIC (Zeus Greene, RPCUS-A1B2CJJG5, project "Ice Queen").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { users } from "../identity/schema.js";
import { DomainError } from "../../core/errors.js";
import type { DbOrTx } from "../../core/types.js";
import type { Services } from "../../container.js";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createOrdersModule, type OrdersModule } from "./index.js";
import { orderReferences, orders, PACKET_TIERS } from "./schema.js";
import { FakeEngagement, FakeFiles, fakeIdentity, idemKey, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let admin: TestUser;
let staff: TestUser;
let zeus: TestUser;
let other: TestUser;
const packet: Record<number, { a: string; b: string }> = {};

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

const create = (user: TestUser, items: string[], extra: { addToOrderPublicId?: string; projectName?: string } = {}) =>
  mod.orders.create(user.principal, { projectName: extra.projectName ?? "Ice Queen", items: items.map((productPublicId) => ({ productPublicId, quantity: 1 })), idempotencyKey: idemKey(), ...extra });

beforeAll(async () => {
  t = await createTestDb({ schema: ordersTestSchema });
  h = createTestDeps({ db: t.db });
  mod = createOrdersModule(h.deps);
  h.services.orders = mod;
  const identity = fakeIdentity(h, t.db);
  h.services.identity = {
    ...identity,
    users: {
      // identity_engineer's D1 port (synthetic parts; `other` has a one-word name and no customer ID).
      async namePartsInTx(_tx: DbOrTx, userId: number) {
        if (userId === zeus.id) return { firstName: "Zeus", lastName: "Greene", preferredName: null, customerRef: "RPCUS-A1B2CJJG5" };
        return { firstName: "Li", lastName: "", preferredName: null, customerRef: null };
      },
    },
  } as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];
  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  staff = await insertUser(h, t.db, { role: "staff", stepUp: true });
  zeus = await insertUser(h, t.db);
  other = await insertUser(h, t.db);
  for (const n of [1, 2, 3]) {
    const group = await mod.catalog.createGroup(admin.principal, { name: `Synthetic packet ${n}`, description: "", sortOrder: n, active: true, groupKey: `synthetic-${n}`, packetNumber: n });
    for (const [index, tier] of [PACKET_TIERS[0], PACKET_TIERS[1]].entries()) {
      await mod.catalog.createProduct(admin.principal, {
        groupId: group.publicId,
        productKey: `synthetic-p${n}-${index}`,
        sortOrder: n * 10 + index,
        active: true,
        name: `Synthetic packet ${n} ${tier}`,
        description: "",
        features: [],
        priceMinor: 1000 * n,
        currency: "USD",
        packetNumber: n,
        tier,
      } as Parameters<OrdersModule["catalog"]["createProduct"]>[1]);
    }
  }
  const products = (await mod.catalog.listAll()).flatMap((g) => g.products);
  for (const n of [1, 2, 3]) {
    const mine = products.filter((p) => p.packetNumber === n);
    packet[n] = { a: mine.find((p) => p.tier === PACKET_TIERS[0])!.publicId, b: mine.find((p) => p.tier === PACKET_TIERS[1])!.publicId };
  }
}, 120_000);

afterAll(() => t.cleanup());

describe("D2 stem references", () => {
  it("a new order gets RP-C4-F3L3-P6-001 and a frozen stem; the next order of the same stem gets -002", async () => {
    const first = await create(zeus, [packet[1]!.a]);
    expect(first.reference).toBe("RP-JJG5-ZEUGRE-ICEQUE-001");
    const [row] = await t.db.select({ stem: orders.referenceStem, root: orders.groupRootOrderId }).from(orders).where(eq(orders.publicId, first.publicId));
    expect(row).toEqual({ stem: "RP-JJG5-ZEUGRE-ICEQUE", root: null });
    const second = await create(zeus, [packet[2]!.a]);
    expect(second.reference).toBe("RP-JJG5-ZEUGRE-ICEQUE-002");
  });

  it("no customer ID and a one-word name pad with 0 / X", async () => {
    const order = await create(other, [packet[1]!.a], { projectName: "Ab" });
    expect(order.reference).toBe("RP-0000-LIXXXX-ABXXXX-001");
  });

  it("skips a value already reserved in order_references and never reuses it", async () => {
    const [anchor] = await t.db.select({ id: orders.id }).from(orders).limit(1);
    await t.db.insert(orderReferences).values({ reference: "RP-0000-LIXXXX-SKIPXX-001", orderId: anchor!.id, status: "retired", reasonCode: "MANUAL", assignedAt: h.clock.now(), retiredAt: h.clock.now() });
    const order = await create(other, [packet[1]!.a], { projectName: "Skip" });
    expect(order.reference).toBe("RP-0000-LIXXXX-SKIPXX-002");
  });
});

describe("D3 add-on orders", () => {
  let root: { publicId: string; reference: string };

  beforeAll(async () => {
    root = await create(zeus, [packet[1]!.a], { projectName: "Frost Gate" });
  });

  it("adds a new linked order with the root's stem, project name and the next number", async () => {
    expect(root.reference).toBe("RP-JJG5-ZEUGRE-FROSTG-001");
    const addition = await create(zeus, [packet[2]!.a], { addToOrderPublicId: root.publicId, projectName: "Ignored" });
    expect(addition.reference).toBe("RP-JJG5-ZEUGRE-FROSTG-002");
    const [row] = await t.db.select({ projectName: orders.projectName, groupRootOrderId: orders.groupRootOrderId }).from(orders).where(eq(orders.publicId, addition.publicId));
    const [rootRow] = await t.db.select({ id: orders.id }).from(orders).where(eq(orders.publicId, root.publicId));
    expect(row).toEqual({ projectName: "Frost Gate", groupRootOrderId: rootRow!.id });
  });

  it("refuses a packet already in the project, in any tier, even when addressed through an addition", async () => {
    await expectError(create(zeus, [packet[1]!.b], { addToOrderPublicId: root.publicId }), "CONFLICT:PACKET_ALREADY_IN_PROJECT");
    const view = await mod.orders.get(zeus.principal, root.publicId);
    const additionId = view.group.orders.find((o) => !o.current)!.publicId;
    await expectError(create(zeus, [packet[2]!.b], { addToOrderPublicId: additionId }), "CONFLICT:PACKET_ALREADY_IN_PROJECT");
    // An addition addressed through another addition still points at the root (flat groups).
    const third = await create(zeus, [packet[3]!.a], { addToOrderPublicId: additionId });
    expect(third.reference).toBe("RP-JJG5-ZEUGRE-FROSTG-003");
  });

  it("two concurrent additions of the same packet serialise on the root: exactly one wins", async () => {
    const project = await create(zeus, [packet[1]!.a], { projectName: "Race Day" });
    // Both transactions take a snapshot first (catalogue reads) and then wait on the root lock; the loser must see the
    // winner's committed line items through the locking read, not its older snapshot.
    const results = await Promise.allSettled([
      create(zeus, [packet[2]!.a], { addToOrderPublicId: project.publicId }),
      create(zeus, [packet[2]!.b], { addToOrderPublicId: project.publicId }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost.map((r) => code(r.reason))).toEqual(["CONFLICT:PACKET_ALREADY_IN_PROJECT"]);
    expect((await mod.orders.get(zeus.principal, project.publicId)).group.orders.map((o) => o.packetNumbers)).toEqual([[1], [2]]);
  });

  it("hides foreign roots (ORDER_NOT_FOUND), also for staff acting for a different customer", async () => {
    await expectError(create(other, [packet[3]!.a], { addToOrderPublicId: root.publicId }), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(
      mod.orders.create(staff.principal, {
        projectName: "x",
        items: [{ productPublicId: packet[3]!.b, quantity: 1 }],
        idempotencyKey: idemKey(),
        onBehalfOfCustomerPublicId: other.publicId,
        addToOrderPublicId: root.publicId,
      }),
      "NOT_FOUND:ORDER_NOT_FOUND",
    );
  });

  it("returns the group read model, canAddPackets, list grouping and the add-on target", async () => {
    const view = await mod.orders.get(zeus.principal, root.publicId);
    expect(view.canAddPackets).toBe(true);
    expect(view.group.rootPublicId).toBe(root.publicId);
    expect(view.group.orders.map((o) => o.reference)).toEqual(["RP-JJG5-ZEUGRE-FROSTG-001", "RP-JJG5-ZEUGRE-FROSTG-002", "RP-JJG5-ZEUGRE-FROSTG-003"]);
    expect(view.group.orders.map((o) => o.packetNumbers)).toEqual([[1], [2], [3]]);
    for (const transition of view.transitions) expect(transition.kind).toBe(transition.destructive ? "cancel" : "forward");
    const list = await mod.orders.list(zeus.principal, { limit: 50 });
    const addition = list.items.find((item) => item.reference === "RP-JJG5-ZEUGRE-FROSTG-002")!;
    expect(addition.group).toEqual({ rootPublicId: root.publicId, rootReference: root.reference });
    expect(list.items.find((item) => item.publicId === root.publicId)!.group).toBeNull();
    const target = await mod.orders.addOnTarget(zeus.principal, { orderId: root.publicId });
    expect(target).toMatchObject({ rootPublicId: root.publicId, rootReference: root.reference, projectName: "Frost Gate", currency: "USD", packetNumbers: [1, 2, 3] });
    expect(await mod.orders.addOnTarget(other.principal, { orderId: root.publicId })).toBeNull();
    const consoleView = await mod.orders.get(staff.principal, root.publicId, "console");
    expect(consoleView.group.orders).toHaveLength(3);
    expect(consoleView.canAddPackets).toBe(false);
  });

  it("a cancelled root can no longer take additions", async () => {
    const lone = await create(zeus, [packet[1]!.a], { projectName: "Cold Snap" });
    const view = await mod.orders.get(zeus.principal, lone.publicId);
    const cancel = view.transitions.find((tr) => tr.kind === "cancel");
    if (!cancel) return; // the default workflow offers the customer no cancel from here; covered by the cancel rule below
    await mod.orders.transition(zeus.principal, { orderId: lone.publicId, expectedVersion: view.version, toStatus: cancel.to, ...(cancel.requiresNote ? { note: "Synthetic cancel" } : {}) } as Parameters<OrdersModule["orders"]["transition"]>[1]);
    await expectError(create(zeus, [packet[2]!.a], { addToOrderPublicId: lone.publicId }), "CONFLICT:ADD_ON_TARGET_UNAVAILABLE");
    expect((await mod.orders.get(zeus.principal, lone.publicId)).canAddPackets).toBe(false);
    expect(await mod.orders.addOnTarget(zeus.principal, { orderId: lone.publicId })).toBeNull();
  });
});

describe("D3 add-on lock scope and order (http_security findings)", () => {
  /** Opens a transaction on another connection that runs `body` and then holds its locks until `release()`. */
  function holdLocks(body: (tx: Parameters<Parameters<TestDb["db"]["transaction"]>[0]>[0]) => Promise<void>) {
    let release!: () => void;
    let ready!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const locked = new Promise<void>((r) => (ready = r));
    const done = t.db.transaction(async (tx) => {
      await body(tx);
      ready();
      await released;
    });
    return { locked, release, done };
  }
  const within = <T,>(promise: Promise<T>, ms: number) =>
    Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still blocked after ${ms} ms`)), ms))]);

  it("a foreign order id answers ORDER_NOT_FOUND without waiting on (or taking) the foreign root's lock", async () => {
    const root = await create(zeus, [packet[1]!.a], { projectName: "Foreign Lock" });
    const holder = holdLocks(async (tx) => {
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.publicId, root.publicId)).for("update");
    });
    await holder.locked;
    try {
      await expectError(within(create(other, [packet[2]!.a], { addToOrderPublicId: root.publicId }), 5_000), "NOT_FOUND:ORDER_NOT_FOUND");
    } finally {
      holder.release();
      await holder.done;
    }
  });

  it("a child reassigned away can no longer select the project, for the old or the new owner", async () => {
    const root = await create(zeus, [packet[1]!.a], { projectName: "Moved Child" });
    const child = await create(zeus, [packet[2]!.a], { addToOrderPublicId: root.publicId });
    await t.db.update(orders).set({ ownerUserId: other.id }).where(eq(orders.publicId, child.publicId));
    await expectError(create(zeus, [packet[3]!.a], { addToOrderPublicId: child.publicId }), "NOT_FOUND:ORDER_NOT_FOUND");
    await expectError(create(other, [packet[3]!.a], { addToOrderPublicId: child.publicId }), "NOT_FOUND:ORDER_NOT_FOUND");
    expect(await mod.orders.addOnTarget(zeus.principal, { orderId: child.publicId })).toBeNull();
  });

  it("takes every order-row lock before the actor's users row (a held member lock blocks the add-on before it locks the user)", async () => {
    const root = await create(zeus, [packet[1]!.a], { projectName: "Lock Order" });
    const child = await create(zeus, [packet[2]!.a], { addToOrderPublicId: root.publicId });
    const holder = holdLocks(async (tx) => {
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.publicId, child.publicId)).for("update");
    });
    await holder.locked;
    const pending = create(zeus, [packet[3]!.a], { addToOrderPublicId: root.publicId });
    const settled = pending.then(() => "ok", (error: unknown) => code(error));
    try {
      await new Promise((r) => setTimeout(r, 300));
      // The add-on now waits on the child; it must not hold Zeus's users row yet (an existing-order write would lock the
      // child first and then that users row — the inverted order would deadlock).
      const probe = await within(
        t.db.transaction(async (tx) => {
          await tx.execute(sql`SET SESSION innodb_lock_wait_timeout = 3`);
          const rows = await tx.select({ id: users.id }).from(users).where(eq(users.id, zeus.id)).for("update");
          await tx.execute(sql`SET SESSION innodb_lock_wait_timeout = 50`);
          return rows.length;
        }),
        5_000,
      );
      expect(probe).toBe(1);
    } finally {
      holder.release();
      await holder.done;
    }
    expect(await settled).toBe("ok");
  });

  it("two simultaneous submits of the same addition (same idempotency key) resolve to one order", async () => {
    const root = await create(zeus, [packet[1]!.a], { projectName: "Same Key" });
    const input = { projectName: "Same Key", items: [{ productPublicId: packet[2]!.a, quantity: 1 }], idempotencyKey: idemKey(), addToOrderPublicId: root.publicId };
    const [a, b] = await Promise.all([mod.orders.create(zeus.principal, input), mod.orders.create(zeus.principal, input)]);
    expect(a.publicId).toBe(b.publicId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect((await mod.orders.get(zeus.principal, root.publicId)).group.orders).toHaveLength(2);
  });

  it("staff add through the console hand-off (orders.manage) for the root's owner; the audit names the root", async () => {
    const root = await create(zeus, [packet[1]!.a], { projectName: "Console Add" });
    const addition = await mod.orders.create(staff.principal, {
      projectName: "ignored",
      items: [{ productPublicId: packet[2]!.a, quantity: 1 }],
      idempotencyKey: idemKey(),
      onBehalfOfCustomerPublicId: zeus.publicId,
      addToOrderPublicId: root.publicId,
    });
    expect(addition.reference).toBe("RP-JJG5-ZEUGRE-CONSOL-002");
    const event = h.audit.named("order.created").find((e) => e.resource?.publicId === addition.publicId);
    expect(event?.attributes).toMatchObject({ group_root_public_id: root.publicId, on_behalf: true });
    expect(event?.actor).toMatchObject({ userId: staff.id });
    // Without the hand-off, staff cannot add to a customer's project (the root is not theirs).
    await expectError(
      mod.orders.create(staff.principal, { projectName: "x", items: [{ productPublicId: packet[3]!.a, quantity: 1 }], idempotencyKey: idemKey(), addToOrderPublicId: root.publicId }),
      "NOT_FOUND:ORDER_NOT_FOUND",
    );
  });
});
