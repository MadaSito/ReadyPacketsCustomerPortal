import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { seedOrdersDemo } from "./demoSeed.js";
import { createOrdersModule, type OrdersModule } from "./index.js";
import type { Services } from "../../container.js";
import { fakeIdentity, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let admin: TestUser;

beforeAll(async () => {
  t = await createTestDb({ schema: ordersTestSchema });
  h = createTestDeps({ db: t.db });
  mod = createOrdersModule(h.deps);
  h.services.orders = mod;
  // Catalog writes re-validate the actor in-transaction via identity.sessions.assertCurrent.
  h.services.identity = fakeIdentity(h, t.db) as unknown as Services["identity"];
  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
});

afterAll(() => t.cleanup());

describe("synthetic demo seed", () => {
  it("is not run automatically, seeds only an empty catalog, labels everything as demo, and is idempotent", async () => {
    expect(await mod.catalog.isEmpty()).toBe(true);
    const first = await seedOrdersDemo(mod, admin.principal);
    expect(first.seeded).toBe(true);
    const products = await mod.catalog.listActive();
    const names = JSON.stringify(products);
    expect(names).toContain("Demo");
    expect(names).not.toMatch(/packet\s*8/i);
    expect(h.audit.named("catalog.product.changed").length).toBe(3);
    const second = await seedOrdersDemo(mod, admin.principal);
    expect(second).toEqual({ seeded: false, groupPublicId: null, productPublicIds: [] });
  });
});
