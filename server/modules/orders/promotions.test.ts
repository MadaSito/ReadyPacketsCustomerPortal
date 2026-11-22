/**
 * Increment 05 (C3) — orders pricing hook for promotion codes, against a FAKE promotions module (the real one is
 * siem_engineer's C1). Covers: uniform refusal when the module is absent or off, preview in quote, redemption in
 * the creation transaction (before the order row; a refusal or a later failure writes nothing), owner-judged
 * eligibility for staff-created orders, release on cancel before payment only, and inconsistent outcomes refused.
 * All data SYNTHETIC.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import type { Services } from "../../container.js";
import type { Tx } from "../../core/types.js";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { ordersRouter } from "./router.js";
import { createOrdersModule, type OrdersModule } from "./index.js";
import type { PromotionContext, PromotionOutcome } from "./ports.js";
import { orders } from "./schema.js";
import { FakeEngagement, FakeFiles, fakeIdentity, idemKey, insertUser, ordersTestSchema, type TestUser } from "./testSupport.js";

let t: TestDb;
let h: TestHarness;
let mod: OrdersModule;
let admin: TestUser;
let staff: TestUser;
let alice: TestUser;
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

/** Fake promotions: code "SAVE10" = 10 % for alice only, 1 redemption in total. */
class FakePromotions {
  enabled = true;
  remaining = 1;
  redeemed = new Map<string, number>();
  released: string[] = [];
  previews: PromotionContext[] = [];
  /** When set, returns this outcome verbatim (to test the consistency guard). */
  override: PromotionOutcome | null = null;
  constructor(private readonly allowedUserId: () => number) {}
  async isEnabled() {
    return this.enabled;
  }
  private outcome(ctx: PromotionContext): PromotionOutcome {
    if (this.override) return this.override;
    if (ctx.code.trim().toUpperCase() !== "SAVE10" || ctx.customerUserId !== this.allowedUserId()) throw new DomainError("VALIDATION", "PROMO_NOT_APPLICABLE", "This code cannot be applied.");
    const promo = Math.floor((ctx.subtotalMinor * 10 + 50) / 100);
    const discount = Math.max(promo, ctx.bundleDiscountMinor);
    return { promoPublicId: "01JD0000000000000000PROMO1", label: "Synthetic 10 % off", promoDiscountMinor: promo, bundleDiscountMinor: 0, discountMinor: discount, discountLabel: "Synthetic 10 % off", totalMinor: ctx.subtotalMinor - discount };
  }
  async preview(ctx: PromotionContext) {
    this.previews.push(ctx);
    return this.outcome(ctx);
  }
  async redeemInTx(_tx: Tx, ctx: PromotionContext & { orderPublicId: string; correlationId: string }) {
    const out = this.outcome(ctx);
    if (this.remaining <= 0) throw new DomainError("VALIDATION", "PROMO_NOT_APPLICABLE", "This code cannot be applied.");
    // The order row must not exist yet (redeem runs before the insert).
    const [row] = await _tx.select({ id: orders.id }).from(orders).where(eq(orders.publicId, ctx.orderPublicId));
    if (row) throw new Error("order inserted before redemption");
    this.remaining -= 1;
    this.redeemed.set(ctx.orderPublicId, ctx.actorUserId);
    return out;
  }
  async releaseForOrderInTx(_tx: Tx, input: { orderPublicId: string; reason: "order_cancelled" }) {
    this.released.push(input.orderPublicId);
    this.remaining += 1;
    return { released: true };
  }
}

let promos: FakePromotions;

const items = () => [{ productPublicId: productId, quantity: 1 }];
const rowOf = async (publicId: string) => (await t.db.select().from(orders).where(eq(orders.publicId, publicId)))[0]!;

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
  const group = await mod.catalog.createGroup(admin.principal, { name: "Synthetic group", description: "", sortOrder: 0, active: true });
  const product = await mod.catalog.createProduct(admin.principal, {
    groupId: group.publicId,
    productKey: "synthetic-promo",
    sortOrder: 0,
    active: true,
    name: "Synthetic product",
    description: "",
    priceMinor: 10000,
    currency: "USD",
    features: [],
  });
  productId = product.publicId;
});
afterAll(() => t.cleanup());
beforeEach(() => {
  promos = new FakePromotions(() => alice.id);
  (h.services as unknown as Record<string, unknown>).promotions = promos;
});

describe("promotion codes on orders (C3)", () => {
  it("refuses a code with the uniform error when the module is absent or feature.promotions is off; no code still works", async () => {
    delete (h.services as unknown as Record<string, unknown>).promotions;
    await expectError(mod.orders.quote(alice.principal, { items: items(), promoCode: "SAVE10" }), "VALIDATION:PROMO_NOT_APPLICABLE");
    await expectError(mod.orders.create(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), promoCode: "SAVE10" }), "VALIDATION:PROMO_NOT_APPLICABLE");
    expect((await mod.orders.quote(alice.principal, { items: items() })).promo).toBeNull();
    (h.services as unknown as Record<string, unknown>).promotions = promos;
    promos.enabled = false;
    await expectError(mod.orders.quote(alice.principal, { items: items(), promoCode: "SAVE10" }), "VALIDATION:PROMO_NOT_APPLICABLE");
    expect(promos.previews).toHaveLength(0);
  });

  it("quote previews the code with server lines and the owner; nothing is redeemed", async () => {
    const quote = await mod.orders.quote(alice.principal, { items: items(), promoCode: "save10" });
    expect(quote).toMatchObject({ subtotalMinor: 10000, discountMinor: 1000, totalMinor: 9000, discountLabel: "Synthetic 10 % off", promo: { label: "Synthetic 10 % off", promoDiscountMinor: 1000 } });
    expect(promos.previews[0]).toMatchObject({ customerUserId: alice.id, actorUserId: alice.id, currency: "USD", subtotalMinor: 10000, bundleDiscountMinor: 0, lines: [{ productPublicId: productId, lineTotalMinor: 10000 }] });
    expect(promos.remaining).toBe(1);
    // Customers cannot price for another customer.
    await expectError(mod.orders.quote(alice.principal, { items: items(), forCustomerPublicId: alice.publicId }), "FORBIDDEN:CAPABILITY_NOT_GRANTED");
  });

  it("create redeems inside the transaction before the order row and stores the promo figures; the last redemption goes once", async () => {
    const created = await mod.orders.create(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), promoCode: "SAVE10" });
    const row = await rowOf(created.publicId);
    expect(row).toMatchObject({ subtotalMinor: 10000, discountMinor: 1000, totalMinor: 9000, promoDiscountMinor: 1000, promoLabel: "Synthetic 10 % off", discountLabel: "Synthetic 10 % off" });
    expect(promos.redeemed.get(created.publicId)).toBe(alice.id);
    const view = await mod.orders.get(alice.principal, created.publicId);
    expect(view).toMatchObject({ promoDiscountMinor: 1000, promoLabel: "Synthetic 10 % off" });
    // No redemptions left: refused, and no order row is written.
    const before = (await t.db.select({ id: orders.id }).from(orders)).length;
    await expectError(mod.orders.create(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), promoCode: "SAVE10" }), "VALIDATION:PROMO_NOT_APPLICABLE");
    expect((await t.db.select({ id: orders.id }).from(orders)).length).toBe(before);
    const audit = h.audit.events.filter((e) => e.eventName === "order.created").at(-1)!;
    expect(JSON.stringify(audit)).not.toContain("SAVE10");
    expect(audit.attributes).toMatchObject({ promo_public_id: "01JD0000000000000000PROMO1", promo_discount_minor: 1000 });
  });

  it("a failure after redemption rolls the redemption back with the order (audit failure)", async () => {
    h.audit.failRecords = true;
    try {
      await expect(mod.orders.create(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), promoCode: "SAVE10" })).rejects.toThrow();
    } finally {
      h.audit.failRecords = false;
    }
    // The fake counts in memory; the real module's row is in the rolled-back tx. Here we check no order exists for it.
    for (const publicId of promos.redeemed.keys()) expect((await t.db.select({ id: orders.id }).from(orders).where(eq(orders.publicId, publicId))).length).toBe(0);
  });

  it("staff creating for a customer: eligibility is judged for the customer; staff cannot use a code for themselves", async () => {
    const forAlice = await mod.orders.create(staff.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), onBehalfOfCustomerPublicId: alice.publicId, promoCode: "SAVE10" });
    expect(promos.redeemed.get(forAlice.publicId)).toBe(staff.id);
    expect((await rowOf(forAlice.publicId)).promoDiscountMinor).toBe(1000);
    const q = await mod.orders.quote(staff.principal, { items: items(), promoCode: "SAVE10", forCustomerPublicId: alice.publicId });
    expect(q.promo?.promoDiscountMinor).toBe(1000);
    await expectError(mod.orders.quote(staff.principal, { items: items(), promoCode: "SAVE10" }), "VALIDATION:PROMO_NOT_APPLICABLE");
  });

  it("checkout in the caller's tx accepts a code and returns the promo figures", async () => {
    const result = await t.db.transaction((tx) => mod.createOrderFromCheckoutInTx(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), promoCode: "SAVE10" }, tx));
    expect(result).toMatchObject({ created: true, discountMinor: 1000, totalMinor: 9000, promoDiscountMinor: 1000, promoLabel: "Synthetic 10 % off" });
  });

  it("cancelling releases the redemption only on authoritative zero exposure; otherwise it stays used and the cancel succeeds", async () => {
    promos.remaining = 10;
    const services = h.services as unknown as Record<string, unknown>;
    // Without compliance's authoritative exposure port the redemption is never released (fail closed).
    delete services.compliance;
    const noGuard = await mod.orders.create(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), promoCode: "SAVE10" });
    await mod.orders.transition(alice.principal, { orderId: noGuard.publicId, expectedVersion: (await rowOf(noGuard.publicId)).version, toStatus: "canceled" });
    expect(promos.released).toEqual([]);
    // Exposure proves nothing paid and nothing capturable ⇒ released; any exposure, malformed answer or error ⇒ kept.
    const exposureOf = new Map<string, unknown>();
    const asked: string[] = [];
    services.compliance = {
      orderPaymentExposureInTx: async (_tx: Tx, publicId: string) => {
        asked.push(publicId);
        const value = exposureOf.get(publicId);
        if (value === "throw") throw new Error("synthetic");
        return value;
      },
    };
    const none = { grossPaidMinor: 0, payableInvoiceOpen: false, providerCapturePending: false };
    try {
      const unpaid = await mod.orders.create(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), promoCode: "SAVE10" });
      exposureOf.set(unpaid.publicId, none);
      await mod.orders.transition(alice.principal, { orderId: unpaid.publicId, expectedVersion: (await rowOf(unpaid.publicId)).version, toStatus: "canceled" });
      expect(promos.released).toEqual([unpaid.publicId]);
      for (const exposure of [{ ...none, grossPaidMinor: 1 }, { ...none, payableInvoiceOpen: true }, { ...none, providerCapturePending: true }, "throw", { grossPaidMinor: 0 }]) {
        const kept = await mod.orders.create(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), promoCode: "SAVE10" });
        exposureOf.set(kept.publicId, exposure);
        await mod.orders.transition(alice.principal, { orderId: kept.publicId, expectedVersion: (await rowOf(kept.publicId)).version, toStatus: "canceled" });
        expect((await rowOf(kept.publicId)).statusKey).toBe("canceled");
      }
      expect(promos.released).toEqual([unpaid.publicId]);
      const plain = await mod.orders.create(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey() });
      await mod.orders.transition(alice.principal, { orderId: plain.publicId, expectedVersion: (await rowOf(plain.publicId)).version, toStatus: "canceled" });
      expect(promos.released).toEqual([unpaid.publicId]);
      expect(asked).not.toContain(plain.publicId);
    } finally {
      delete services.compliance;
    }
  });

  it("a code never travels in a URL: quote (GET) refuses it, quoteWithPromo is a POST mutation", () => {
    const procedures = ordersRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
    expect(procedures.quote!._def.type).toBe("query");
    expect(procedures.quoteWithPromo!._def.type).toBe("mutation");
  });

  it("an inconsistent outcome from promotions is refused (fail closed), never a negative total", async () => {
    promos.override = { promoPublicId: "01JD0000000000000000PROMO1", label: "Bad", promoDiscountMinor: 20000, bundleDiscountMinor: 0, discountMinor: 20000, discountLabel: "Bad", totalMinor: -10000 };
    await expectError(mod.orders.quote(alice.principal, { items: items(), promoCode: "SAVE10" }), "UNAVAILABLE:PROMOTIONS_UNAVAILABLE");
    await expectError(mod.orders.create(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), promoCode: "SAVE10" }), "UNAVAILABLE:PROMOTIONS_UNAVAILABLE");
  });

  it("C1 attempt guard wraps quote and create (incl. staff for a customer) outside the tx; refusals reach it after rollback; checkout is not wrapped", async () => {
    const guarded: { actor: number; outcome: string; ordersAfter?: number }[] = [];
    const countOrders = async () => (await t.db.select({ id: orders.id }).from(orders)).length;
    (promos as unknown as { guardAttempt: <T>(actor: number, fn: () => Promise<T>) => Promise<T> }).guardAttempt = async (actor, fn) => {
      const before = await countOrders();
      try {
        const value = await fn();
        guarded.push({ actor, outcome: "ok" });
        return value;
      } catch (error) {
        // The caller's tx has already rolled back: nothing was written.
        guarded.push({ actor, outcome: error instanceof DomainError ? error.reasonCode : "other", ordersAfter: (await countOrders()) - before });
        throw error;
      }
    };
    await mod.orders.quote(alice.principal, { items: items(), promoCode: "SAVE10" });
    await expectError(mod.orders.create(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), promoCode: "WRONG1" }), "VALIDATION:PROMO_NOT_APPLICABLE");
    await mod.orders.create(staff.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), onBehalfOfCustomerPublicId: alice.publicId, promoCode: "SAVE10" });
    expect(guarded).toEqual([
      { actor: alice.id, outcome: "ok" },
      { actor: alice.id, outcome: "PROMO_NOT_APPLICABLE", ordersAfter: 0 },
      { actor: staff.id, outcome: "ok" },
    ]);
    // No code: not guarded. Checkout (caller-held tx): not guarded.
    await mod.orders.quote(alice.principal, { items: items() });
    promos.remaining = 5;
    await t.db.transaction((tx) => mod.createOrderFromCheckoutInTx(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), promoCode: "SAVE10" }, tx));
    expect(guarded).toHaveLength(3);
  });

  it("a code that contributes nothing leaves no promo figures or label on the order", async () => {
    promos.override = { promoPublicId: "01JD0000000000000000PROMO1", label: "Synthetic zero", promoDiscountMinor: 0, bundleDiscountMinor: 0, discountMinor: 0, discountLabel: "Synthetic zero", totalMinor: 10000 };
    const q = await mod.orders.quote(alice.principal, { items: items(), promoCode: "SAVE10" });
    expect(q).toMatchObject({ promo: null, discountMinor: 0, discountLabel: null, totalMinor: 10000 });
    const created = await mod.orders.create(alice.principal, { projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), promoCode: "SAVE10" });
    expect(await rowOf(created.publicId)).toMatchObject({ promoDiscountMinor: 0, promoLabel: null, discountMinor: 0, discountLabel: null });
  });

  it("API v1 (system) order creation does not accept codes", async () => {
    await expectError(
      mod.orders.createAsSystem({ ownerPublicId: alice.publicId, projectName: "Synthetic", items: items(), idempotencyKey: idemKey(), correlationId: "corr-c3", ...({ promoCode: "SAVE10" } as object) }),
      "VALIDATION:PROMO_NOT_APPLICABLE",
    );
  });
});
