/**
 * Regression: no orders code path performs work on a second pool connection while it holds a transaction.
 * Every flow runs against a pool with exactly ONE connection; any such access would self-deadlock and time out.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import type { Services } from "../../container.js";
import type { Db } from "../../core/types.js";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createOrdersModule, type OrdersModule } from "./index.js";
import { FakeEngagement, FakeFiles, fakeIdentity, idemKey, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";

let t: TestDb;
let pool: mysql.Pool;
let db: Db;
let h: TestHarness;
let mod: OrdersModule;
let admin: TestUser;
let staff: TestUser;
let alice: TestUser;
let bob: TestUser;

const within = <T>(p: Promise<T>, ms = 4000) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out: second pool connection used inside a transaction?")), ms))]);

beforeAll(async () => {
  t = await createTestDb({ schema: ordersTestSchema });
  pool = mysql.createPool({ uri: t.url, connectionLimit: 1, timezone: "Z", supportBigNumbers: true, charset: "utf8mb4" });
  db = drizzle(pool, { mode: "default" }) as unknown as Db;
  h = createTestDeps({ db });
  mod = createOrdersModule(h.deps);
  h.services.orders = mod;
  h.services.identity = fakeIdentity(h, db) as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];
  admin = await insertUser(h, db, { role: "admin", stepUp: true });
  staff = await insertUser(h, db, { role: "staff" });
  alice = await insertUser(h, db);
  bob = await insertUser(h, db);
});

afterAll(async () => {
  await pool.end();
  await t.cleanup();
});

describe("one-connection pool", () => {
  it("catalog, create, transition, share, lock, reference change, reassign, import and in-tx denial all complete", async () => {
    const group = await within(mod.catalog.createGroup(admin.principal, { name: "Synthetic group", description: "", sortOrder: 0, active: true }));
    const product = await within(
      mod.catalog.createProduct(admin.principal, { groupId: group.publicId, productKey: "synthetic-one", sortOrder: 0, active: true, name: "Synthetic", description: "", features: [], priceMinor: 100, currency: "USD" }),
    );
    const order = await within(mod.orders.create(alice.principal, { projectName: "Synthetic project", items: [{ productPublicId: product.publicId, quantity: 1 }], idempotencyKey: idemKey() }));
    let view = await within(mod.assertCanReadOrder(admin.principal, order.publicId));
    await within(mod.orders.transition(staff.principal, { orderId: order.publicId, expectedVersion: view.version, toStatus: "in_review" }));
    const invite = await within(mod.sharing.invite(alice.principal, { orderId: order.publicId, email: bob.email, role: "viewer" }));
    await within(mod.sharing.respond(bob.principal, { grantId: invite.publicId, accept: true }));
    // Denial inside a caller transaction must not wait on a second connection.
    await within(
      db.transaction(async (tx) => {
        await expect(mod.assertCanWriteOrder(bob.principal, order.publicId, { kind: "message", tx, forUpdate: true })).rejects.toMatchObject({ reasonCode: "GRANT_READ_ONLY" });
      }),
    );
    view = await within(mod.assertCanReadOrder(admin.principal, order.publicId));
    await within(mod.orders.setLock(admin.principal, { orderId: order.publicId, expectedVersion: view.version, lockState: "review", reasonCode: "CHECK" }));
    view = await within(mod.assertCanReadOrder(admin.principal, order.publicId));
    await within(mod.orders.changeReference(admin.principal, { orderId: order.publicId, expectedVersion: view.version, newReference: "RP-ONE-1", reasonCode: "FIX" }));
    view = await within(mod.assertCanReadOrder(admin.principal, order.publicId));
    await within(mod.orders.reassign(admin.principal, { orderId: order.publicId, targetCustomerPublicId: bob.publicId, expectedVersion: view.version, operationId: idemKey(), reasonCode: "MOVE" }));
    const imported = await within(
      db.transaction((tx) =>
        mod.importOrder(
          {
            importId: "imp_one_slot",
            sourceInstallationId: "src",
            sourceOrderPublicId: "SRC-1",
            targetOwnerUserId: alice.id,
            projectName: "Imported",
            statusKey: "submitted",
            totalMinor: 0,
            currency: "USD",
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
            lineItems: [],
          },
          tx,
        ),
      ),
    );
    expect(imported.created).toBe(true);
    expect(await within(mod.isPortableStatusSupported("submitted", undefined))).toBe(true);
  });
});
