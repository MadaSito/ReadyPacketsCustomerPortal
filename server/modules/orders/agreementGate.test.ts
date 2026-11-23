/**
 * Increment 06 (D14) — order agreement (MNDA) gate on the ADR 0039 gateway: stored-value parsing (old, partial,
 * damaged), off by default, customers gated on placing and working on orders, staff and API exempt, fail closed
 * without a provider, admin get/update authorisation, policy validation and audit. All data SYNTHETIC.
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
import { orders } from "./schema.js";
import { AGREEMENT_GATE_DEFAULT, ORDER_AGREEMENT_GATE, parseAgreementGate } from "./settings.js";
import { FakeEngagement, FakeFiles, fakeIdentity, idemKey, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let admin: TestUser;
let staff: TestUser;
let alice: TestUser;
let _bob: TestUser;
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
const _versionOf = async (publicId: string) => (await t.db.select({ v: orders.version }).from(orders).where(eq(orders.publicId, publicId)))[0]!.v;
const idOf = async (publicId: string) => (await t.db.select({ id: orders.id }).from(orders).where(eq(orders.publicId, publicId)))[0]!.id;

const POLICY = "01JD0000000000000000000P01";
const OTHER_POLICY = "01JD0000000000000000000P02";
const accepted = new Set<number>();
const calls: Parameters<NonNullable<OrderGateProvider["agreementStatus"]>>[0][] = [];
const provider: OrderGateProvider = {
  async assertMet() {},
  async agreementStatus(input) {
    calls.push(input);
    return { met: accepted.has(input.userId) };
  },
};
const ON = { ...AGREEMENT_GATE_DEFAULT, enabled: true, policyPublicId: POLICY, signatureMode: "checkbox" as const };
const setGate = (value: unknown) => h.settings.set(ORDER_AGREEMENT_GATE.key, value);

beforeAll(async () => {
  t = await createTestDb({ schema: ordersTestSchema });
  h = createTestDeps({ db: t.db });
  mod = createOrdersModule(h.deps);
  h.services.orders = mod;
  h.services.identity = fakeIdentity(h, t.db) as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];
  h.services.compliance = {
    async listPublishedPolicies() {
      return [
        { documentPublicId: POLICY, title: "Synthetic MNDA", audience: "customer", versionLabel: "v1" },
        { documentPublicId: OTHER_POLICY, title: "Synthetic staff rules", audience: "staff", versionLabel: "v1" },
      ];
    },
  } as unknown as Services["compliance"];
  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  staff = await insertUser(h, t.db, { role: "staff" });
  alice = await insertUser(h, t.db);
  _bob = await insertUser(h, t.db);
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
beforeEach(async () => {
  await setGate(AGREEMENT_GATE_DEFAULT);
  mod.gates.registerProvider("acceptance", provider);
  h.audit.failRecords = false;
  calls.length = 0;
  accepted.clear();
});

describe("orders.agreement_gate setting parsing", () => {
  it("missing, old and partial values parse with defaults and never throw", () => {
    expect(parseAgreementGate(undefined)).toEqual(AGREEMENT_GATE_DEFAULT);
    expect(parseAgreementGate(null)).toEqual(AGREEMENT_GATE_DEFAULT);
    expect(parseAgreementGate({ enabled: false })).toEqual(AGREEMENT_GATE_DEFAULT);
    // An older shape that only knew enabled + policy still parses; new fields take their defaults.
    expect(parseAgreementGate({ enabled: true, policyPublicId: POLICY })).toEqual({ ...AGREEMENT_GATE_DEFAULT, enabled: true, policyPublicId: POLICY });
    expect(parseAgreementGate({ enabled: false, applyTo: { placeOrder: false } })).toMatchObject({ applyTo: { placeOrder: false, workOnOrder: true } });
    for (const junk of ["on", 42, [], { enabled: "yes" }, { enabled: false, signatureMode: "blood" }]) expect(parseAgreementGate(junk)).toEqual(AGREEMENT_GATE_DEFAULT);
  });

  it("a damaged value that says enabled stays enabled without a policy (fail closed)", () => {
    expect(parseAgreementGate({ enabled: true })).toMatchObject({ enabled: true, policyPublicId: null });
    expect(parseAgreementGate({ enabled: true, policyPublicId: "not-a-ulid" })).toMatchObject({ enabled: true, policyPublicId: null });
  });
});

describe("agreement gate on the gateway", () => {
  it("off by default: nothing is checked", async () => {
    await newOrder();
    expect(calls).toEqual([]);
    expect(await call(alice.principal).agreement.status({ scope: "placeOrder" })).toMatchObject({ required: false });
  });

  it("on: a customer cannot place or work on an order until accepted; staff are exempt", async () => {
    const order = await newOrder();
    const orderId = await idOf(order.publicId);
    await setGate(ON);
    const refused = await newOrder().then(
      () => null,
      (error: unknown) => error as DomainError,
    );
    expect(refused && code(refused)).toBe("CONFLICT:AGREEMENT_REQUIRED");
    expect(refused!.details).toEqual({ policyPublicId: POLICY, signatureMode: "checkbox" });
    expect(calls.at(-1)).toMatchObject({ userId: alice.id, gate: { key: "order_agreement", policyPublicId: POLICY, point: "order_start" } });
    await expectError(t.db.transaction((tx) => mod.gates.assertCustomerMayWork({ tx, orderId, actor: alice.principal, action: "upload", statusKey: null })), "CONFLICT:AGREEMENT_REQUIRED");
    await expectError(t.db.transaction((tx) => mod.createOrderFromCheckoutInTx(alice.principal, { projectName: "Cart", items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: idemKey() }, tx)), "CONFLICT:AGREEMENT_REQUIRED");
    expect(await call(alice.principal).agreement.status({ scope: "workOnOrder" })).toMatchObject({ required: true, met: false, policyPublicId: POLICY });
    const before = calls.length;
    await t.db.transaction((tx) => mod.gates.assertCustomerMayWork({ tx, orderId, actor: staff.principal, action: "upload", statusKey: null }));
    expect(await call(staff.principal).agreement.status({ scope: "workOnOrder" })).toMatchObject({ required: false });
    expect(calls.length).toBe(before);
    accepted.add(alice.id);
    await newOrder();
    await t.db.transaction((tx) => mod.gates.assertCustomerMayWork({ tx, orderId, actor: alice.principal, action: "upload", statusKey: null }));
    expect(await call(alice.principal).agreement.status({ scope: "placeOrder" })).toMatchObject({ required: true, met: true });
  });

  it("applyTo narrows the scope", async () => {
    const order = await newOrder();
    const orderId = await idOf(order.publicId);
    await setGate({ ...ON, applyTo: { placeOrder: true, workOnOrder: false } });
    await t.db.transaction((tx) => mod.gates.assertCustomerMayWork({ tx, orderId, actor: alice.principal, action: "upload", statusKey: null }));
    await expectError(newOrder(), "CONFLICT:AGREEMENT_REQUIRED");
  });

  it("API v1 / system work is never gated by the agreement", async () => {
    const order = await newOrder();
    const orderId = await idOf(order.publicId);
    await setGate(ON);
    await t.db.transaction((tx) => mod.gates.assertSystemMayWork({ tx, orderId, action: "upload", statusKey: null }));
    expect(calls).toEqual([]);
  });

  it("fails closed: damaged enabled value or a provider without agreementStatus ⇒ UNAVAILABLE", async () => {
    await setGate({ enabled: true });
    await expectError(newOrder(), "UNAVAILABLE:ORDER_GATES_UNAVAILABLE");
    // Display stays honest (required) instead of hiding the gate.
    expect(await call(alice.principal).agreement.status({ scope: "placeOrder" })).toMatchObject({ required: true, met: false });
    await setGate(ON);
    mod.gates.registerProvider("acceptance", { async assertMet() {} });
    await expectError(newOrder(), "UNAVAILABLE:ORDER_GATES_UNAVAILABLE");
  });
});

describe("orders.admin.agreementGate (admin card)", () => {
  it("authorisation: anonymous, customers and staff are refused", async () => {
    await expect(call(null).admin.agreementGate.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    for (const user of [alice, staff]) {
      await expect(call(user.principal).admin.agreementGate.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(call(user.principal).admin.agreementGate.update({ setting: ON })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(call(null).agreement.status({ scope: "placeOrder" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("an administrator without a fresh step-up is refused and nothing changes", async () => {
    const stale = await insertUser(h, t.db, { role: "admin" });
    await expect(call(stale.principal).admin.agreementGate.update({ setting: ON })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expectError(mod.agreementGate.update(stale.principal, { setting: ON }), "STEP_UP_REQUIRED:STEP_UP_REQUIRED");
    expect(parseAgreementGate(await h.settings.get(ORDER_AGREEMENT_GATE.key, (raw) => raw, null))).toMatchObject({ enabled: false });
    expect(h.audit.events.some((event) => event.eventName === "order.agreement_gate.updated")).toBe(false);
  });

  it("get lists customer-facing published policies only", async () => {
    const view = await call(admin.principal).admin.agreementGate.get();
    expect(view).toMatchObject({ enabled: false, policy: null });
    expect(view.choices.map((choice) => choice.publicId)).toEqual([POLICY]);
  });

  it("update validates the policy, refuses stale writes and is audited in the tx", async () => {
    await expectError(mod.agreementGate.update(admin.principal, { setting: { ...ON, policyPublicId: null } }), "VALIDATION:AGREEMENT_SETTING_INVALID");
    await expectError(mod.agreementGate.update(admin.principal, { setting: { ...ON, policyPublicId: OTHER_POLICY } }), "VALIDATION:AGREEMENT_POLICY_INVALID");
    await expect(call(admin.principal).admin.agreementGate.update({ setting: { ...ON, extra: 1 } as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expectError(mod.agreementGate.update(admin.principal, { setting: ON, expectedEnabled: true }), "CONFLICT:AGREEMENT_SETTING_CHANGED");
    h.audit.events.length = 0;
    const saved = await call(admin.principal).admin.agreementGate.update({ setting: ON, expectedEnabled: false });
    expect(saved).toMatchObject({ enabled: true, policy: { publicId: POLICY, title: "Synthetic MNDA" } });
    const event = h.audit.events.find((candidate) => candidate.eventName === "order.agreement_gate.updated");
    expect(event).toMatchObject({ category: "admin", attributes: { enabled_from: "false", enabled_to: "true", policy_from: "none", policy_public_id: POLICY, signature_mode: "checkbox" } });
    expect(h.audit.recordedInTx.at(-1)).toBe(true);
    expect(parseAgreementGate(await h.settings.get(ORDER_AGREEMENT_GATE.key, (raw) => raw, null))).toMatchObject({ enabled: true });
  });
});
