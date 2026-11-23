/**
 * Increment 06 (Package D) server integration & abuse-case suite:
 *  - Decision D3: Seeded starter upsell model (`ensureDefaultUpsellOffers`, `seedSuggested`,
 *    tier upgrades, complete-the-bundle, next-packet, add-ons), idempotent, all seeded rows disabled,
 *    never overwrites admin edits, respects deleted starter rows on reboot while restoring missing ones
 *    on `"Add suggested offers"`, `setFeature` (offering `feature.cart`), `setAllActive`, `duplicate`,
 *    pre-input router authz, and `parseCartUpsellSeededKeysSetting` legacy-stored-value resilience.
 *  - Decision D5: `set_total` (`$0.00` and small positive totals), two-decimal percentage discounts,
 *    `PROMO_LIMIT_*` pass-through and invalidation at checkout, Wave-2 zero-total & `waived_small_total`
 *    settled receipts, and `payments.small_totals` `"block"` (`AMOUNT_BELOW_PROVIDER_MINIMUM` rollback).
 *  - Decision D14: `orders.gates.assertCustomerMayPlaceOrder` enforced at checkout, rolling back on
 *    `AGREEMENT_REQUIRED` (`{ policyPublicId, signatureMode }`) and succeeding after acceptance.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Services } from "../../container.js";
import type { DbOrTx, SessionPrincipal } from "../../core/types.js";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { users } from "../identity/schema.js";
import * as orderTables from "../orders/schema.js";
import { createOrdersModule, type OrdersModule } from "../orders/index.js";
import { FakeEngagement, FakeFiles, fakeIdentity, insertUser, type TestUser } from "../orders/testSupport.js";
import * as complianceTables from "../compliance/schema.js";
import { createComplianceModule, type ComplianceModule } from "../compliance/index.js";
import * as promotionsTables from "../promotions/schema.js";
import { createPromotionsModule, type PromotionsModule } from "../promotions/index.js";
import * as cartTables from "./schema.js";
import {
  CART_FEATURE_FLAG,
  CART_UPSELL_FEATURE_FLAG,
  CART_UPSELL_SEEDED_KEYS,
  parseCartUpsellSeededKeysSetting,
} from "./settings.js";
import type { CartCheckoutAmountEvaluation, CartPaymentsPort } from "./ports.js";
import { createCartModule, type BillingDetailsInput, type CartModule } from "./index.js";
import { cartRouter } from "./router.js";

const testSchema = {
  users,
  ...orderTables,
  ...complianceTables,
  ...promotionsTables,
  ...cartTables,
};

class Wave2PaymentsFake implements CartPaymentsPort {
  readonly supportsSettledReceipts = true;
  provider: "none" | "stripe" | "square" = "stripe";
  belowMinimumBehavior: "waive" | "block" = "waive";
  minimumMinor = 50;
  settledCalls: { invoicePublicId: string; kind: "zero_total" | "waived_small_total" }[] = [];
  redirectCalls = 0;

  async isOnlineCheckoutEnabled(_tx?: DbOrTx) {
    return this.provider !== "none";
  }

  async getPublicCheckoutConfig(_tx?: DbOrTx) {
    return { provider: this.provider, mode: "test" as const, currency: "USD" };
  }

  async evaluateCheckoutAmount(amountMinor: number, _currency: string, _tx?: DbOrTx): Promise<CartCheckoutAmountEvaluation> {
    if (this.provider === "none") {
      return {
        onlineEnabled: false,
        provider: "none",
        minimumMinor: 0,
        belowMinimum: false,
        smallTotalAction: amountMinor === 0 ? "zero_total" : "none",
      };
    }
    if (amountMinor === 0) {
      return {
        onlineEnabled: true,
        provider: this.provider,
        minimumMinor: this.minimumMinor,
        belowMinimum: false,
        smallTotalAction: "zero_total",
      };
    }
    if (amountMinor > 0 && amountMinor < this.minimumMinor) {
      return {
        onlineEnabled: true,
        provider: this.provider,
        minimumMinor: this.minimumMinor,
        belowMinimum: true,
        smallTotalAction: this.belowMinimumBehavior,
      };
    }
    return {
      onlineEnabled: true,
      provider: this.provider,
      minimumMinor: this.minimumMinor,
      belowMinimum: false,
      smallTotalAction: "none",
    };
  }

  async startCheckout(invoicePublicId: string) {
    const [inv] = await t.db
      .select()
      .from(complianceTables.complianceInvoices)
      .where(eq(complianceTables.complianceInvoices.publicId, invoicePublicId))
      .limit(1);
    if (!inv) {
      throw new DomainError("NOT_FOUND", "INVOICE_NOT_FOUND", "Invoice not found.");
    }
    if (this.provider === "none") {
      return { mode: "invoice" as const, invoicePublicId };
    }
    if (inv.totalMinor === 0) {
      this.settledCalls.push({ invoicePublicId, kind: "zero_total" });
      await t.db
        .update(complianceTables.complianceInvoices)
        .set({ status: "paid", updatedAt: h.deps.clock.now() })
        .where(eq(complianceTables.complianceInvoices.id, inv.id));
      return {
        mode: "settled" as const,
        settlementKind: "zero_total" as const,
        invoicePublicId,
        receiptPublicId: `01JRECEIPTZERO${invoicePublicId.slice(-12)}`,
      };
    }
    if (inv.totalMinor < this.minimumMinor) {
      if (this.belowMinimumBehavior === "block") {
        throw new DomainError(
          "VALIDATION",
          "AMOUNT_BELOW_PROVIDER_MINIMUM",
          `Online card payments require at least $${(this.minimumMinor / 100).toFixed(2)}.`,
        );
      }
      this.settledCalls.push({ invoicePublicId, kind: "waived_small_total" });
      await t.db
        .update(complianceTables.complianceInvoices)
        .set({ status: "paid", updatedAt: h.deps.clock.now() })
        .where(eq(complianceTables.complianceInvoices.id, inv.id));
      return {
        mode: "settled" as const,
        settlementKind: "waived_small_total" as const,
        invoicePublicId,
        waivedMinor: inv.totalMinor,
        receiptPublicId: `01JRECEIPTWAIV${invoicePublicId.slice(-12)}`,
      };
    }
    this.redirectCalls += 1;
    return {
      mode: "redirect" as const,
      attemptPublicId: ulid(),
      invoicePublicId,
      provider: this.provider,
      environment: "test" as const,
      redirectUrl: "https://checkout.stripe.com/c/pay/cs_test_inc06",
      expiresAt: null,
    };
  }

  async getCheckoutStatus(principal: SessionPrincipal, query: { invoicePublicId?: string }) {
    const [inv] = await t.db
      .select()
      .from(complianceTables.complianceInvoices)
      .where(eq(complianceTables.complianceInvoices.publicId, query.invoicePublicId!))
      .limit(1);
    const [ord] = await t.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.id, inv!.orderId))
      .limit(1);
    if (!ord || ord.ownerUserId !== principal.userId) {
      throw new DomainError("NOT_FOUND", "INVOICE_NOT_FOUND", "The requested item was not found.");
    }
    return {
      invoicePublicId: inv!.publicId,
      invoiceNumber: inv!.invoiceNumber,
      invoiceStatus: inv!.status,
      amountMinor: inv!.totalMinor,
      balanceDueMinor: inv!.status === "paid" ? 0 : inv!.totalMinor,
      currency: inv!.currency,
      providerConfigured: this.provider,
      environment: "test" as const,
      attempt: null,
    };
  }

  async cancelAttemptIfUnpaid() {
    return { cancelled: false, attemptPublicId: null, status: null };
  }
}

const appTestRouter = router({ cart: cartRouter });
const createCaller = createCallerFactory(appTestRouter);

let t: TestDb;
let h: TestHarness;
let ordersMod: OrdersModule;
let complianceMod: ComplianceModule;
let promotionsMod: PromotionsModule;
let cartMod: CartModule;
let paymentsFake: Wave2PaymentsFake;

let admin: TestUser;
let staff: TestUser;
let alice: TestUser;

let p1Basic: string;
let p1Standard: string;
let p1Premium: string;
let p2Basic: string;
let p3Basic: string;
let addonWorkshop: string;

const sampleBilling: BillingDetailsInput = {
  fullName: "Alice Example",
  company: "Example Studio LLC",
  email: "alice@customer.example.test",
  country: "US",
  region: "NY",
  addressLine1: "100 Example Ave",
  addressLine2: "",
  city: "New York",
  postalCode: "10001",
  taxId: "",
};

function callerFor(principal: SessionPrincipal | null) {
  return createCaller({
    services: h.services,
    session: principal,
    request: newRequestContext("test"),
    transport: { issue() {}, clear() {} },
  });
}

function extractCodes(err: unknown): { trpcCode: string; domainCode: string; reasonCode: string; details?: unknown } {
  if (err instanceof TRPCError) {
    const cause = err.cause;
    if (cause instanceof DomainError) {
      return {
        trpcCode: err.code,
        domainCode: cause.code,
        reasonCode: cause.reasonCode,
        details: cause.details,
      };
    }
    return { trpcCode: err.code, domainCode: "UNKNOWN", reasonCode: err.message };
  }
  if (err instanceof DomainError) {
    return { trpcCode: err.code, domainCode: err.code, reasonCode: err.reasonCode, details: err.details };
  }
  return { trpcCode: "UNKNOWN", domainCode: "UNKNOWN", reasonCode: String(err) };
}

beforeAll(async () => {
  t = await createTestDb({ schema: testSchema });
  h = createTestDeps({ db: t.db });
  const identityFake = fakeIdentity(h, t.db);
  ordersMod = createOrdersModule(h.deps);
  complianceMod = createComplianceModule(h.deps);
  promotionsMod = createPromotionsModule(h.deps);
  paymentsFake = new Wave2PaymentsFake();
  cartMod = createCartModule(h.deps);

  h.services.identity = identityFake as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];
  h.services.orders = ordersMod;
  h.services.compliance = complianceMod;
  h.services.payments = paymentsFake as unknown as Services["payments"];
  h.services.promotions = promotionsMod;
  h.services.cart = cartMod;

  ordersMod.init?.();
  complianceMod.init?.();
  promotionsMod.init?.();
  cartMod.init();

  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  staff = await insertUser(h, t.db, { role: "staff" });
  alice = await insertUser(h, t.db, { role: "customer" });

  const g1 = await ordersMod.catalog.createGroup(admin.principal, {
    name: "Packet 1 — Strategy",
    description: "Packet 1 group",
    packetNumber: 1,
    sortOrder: 1,
    active: true,
  });
  const g2 = await ordersMod.catalog.createGroup(admin.principal, {
    name: "Packet 2 — Architecture",
    description: "Packet 2 group",
    packetNumber: 2,
    sortOrder: 2,
    active: true,
  });
  const g3 = await ordersMod.catalog.createGroup(admin.principal, {
    name: "Packet 3 — Delivery",
    description: "Packet 3 group",
    packetNumber: 3,
    sortOrder: 3,
    active: true,
  });
  const gAddon = await ordersMod.catalog.createGroup(admin.principal, {
    name: "Add-ons",
    description: "Add-ons",
    sortOrder: 4,
    active: true,
  });

  p1Basic = (
    await ordersMod.catalog.createProduct(admin.principal, {
      groupId: g1.publicId,
      productKey: "p1-basic",
      packetNumber: 1,
      tier: "Basic",
      sortOrder: 1,
      active: true,
      name: "Packet 1 Basic",
      description: "Core strategy",
      features: ["Core strategy blueprint"],
      deliverables: [{ title: "Roadmap", detail: "Baseline" }],
      outcome: "Roadmap",
      timeline: "5 days",
      priceMinor: 200_00,
      currency: "USD",
    })
  ).publicId;

  p1Standard = (
    await ordersMod.catalog.createProduct(admin.principal, {
      groupId: g1.publicId,
      productKey: "p1-standard",
      packetNumber: 1,
      tier: "Standard",
      sortOrder: 2,
      active: true,
      name: "Packet 1 Standard",
      description: "Standard strategy",
      features: ["Standard strategy blueprint"],
      deliverables: [{ title: "Roadmap + Matrix", detail: "Standard" }],
      outcome: "Standard roadmap",
      timeline: "6 days",
      priceMinor: 350_00,
      currency: "USD",
    })
  ).publicId;

  p1Premium = (
    await ordersMod.catalog.createProduct(admin.principal, {
      groupId: g1.publicId,
      productKey: "p1-premium",
      packetNumber: 1,
      tier: "Premium",
      sortOrder: 3,
      active: true,
      name: "Packet 1 Premium",
      description: "Executive strategy",
      features: ["Executive strategy blueprint"],
      deliverables: [{ title: "Board deck", detail: "Executive" }],
      outcome: "Board deck",
      timeline: "7 days",
      priceMinor: 500_00,
      currency: "USD",
    })
  ).publicId;

  p2Basic = (
    await ordersMod.catalog.createProduct(admin.principal, {
      groupId: g2.publicId,
      productKey: "p2-basic",
      packetNumber: 2,
      tier: "Basic",
      sortOrder: 1,
      active: true,
      name: "Packet 2 Basic",
      description: "Core architecture",
      features: ["Core architecture blueprint"],
      deliverables: [{ title: "Blueprint", detail: "Core" }],
      outcome: "Blueprint",
      timeline: "5 days",
      priceMinor: 200_00,
      currency: "USD",
    })
  ).publicId;

  p3Basic = (
    await ordersMod.catalog.createProduct(admin.principal, {
      groupId: g3.publicId,
      productKey: "p3-basic",
      packetNumber: 3,
      tier: "Basic",
      sortOrder: 1,
      active: true,
      name: "Packet 3 Basic",
      description: "Core delivery",
      features: ["Core delivery blueprint"],
      deliverables: [{ title: "Playbook", detail: "Core" }],
      outcome: "Playbook",
      timeline: "5 days",
      priceMinor: 200_00,
      currency: "USD",
    })
  ).publicId;

  addonWorkshop = (
    await ordersMod.catalog.createProduct(admin.principal, {
      groupId: gAddon.publicId,
      productKey: "addon-workshop",
      packetNumber: null,
      tier: null,
      sortOrder: 1,
      active: true,
      name: "Executive Workshop",
      description: "90-minute alignment workshop",
      features: ["Live alignment session"],
      deliverables: [{ title: "Live workshop", detail: "90m" }],
      outcome: "Aligned stakeholders",
      timeline: "2 days",
      priceMinor: 75_00,
      currency: "USD",
    })
  ).publicId;

  await ordersMod.catalog.updateBundleRule(admin.principal, {
    enabled: true,
    discountPercent: 15,
    requiredPacketNumbers: [1, 2, 3],
    label: "3-Packet Suite (15% off)",
  });
});

beforeEach(async () => {
  await t.db.delete(cartTables.cartUpsellAcceptances);
  await t.db.delete(cartTables.cartUpsellCartStates);
  await t.db.delete(cartTables.cartUpsellOffers);
  await t.db.delete(cartTables.cartItems);
  await t.db.delete(cartTables.carts);
  await t.db.delete(promotionsTables.promoRedemptions);
  await t.db.delete(promotionsTables.promoCodes);
  await t.db.delete(promotionsTables.promoBatches);
  h.settings.values.delete(CART_UPSELL_SEEDED_KEYS.key);
  h.settings.values.delete("orders.agreement_gate");
  h.settings.flags.add(CART_FEATURE_FLAG.flag);
  h.settings.flags.delete(CART_UPSELL_FEATURE_FLAG.flag);
  h.settings.flags.add("promotions");
  paymentsFake.provider = "stripe";
  paymentsFake.belowMinimumBehavior = "waive";
  paymentsFake.minimumMinor = 50;
  paymentsFake.settledCalls = [];
  paymentsFake.redirectCalls = 0;
  h.audit.events.length = 0;
});

afterAll(async () => {
  await t?.cleanup();
});

describe("Increment 06 Package D — Seeded upsells (D3), D5 totals & small_totals, and D14 agreement gate", () => {
  it("parses legacy/corrupt cart.upsell_seeded_keys values safely without ever throwing", () => {
    expect(parseCartUpsellSeededKeysSetting(undefined)).toEqual([]);
    expect(parseCartUpsellSeededKeysSetting(null)).toEqual([]);
    expect(parseCartUpsellSeededKeysSetting("corrupt-string")).toEqual([]);
    expect(parseCartUpsellSeededKeysSetting(42)).toEqual([]);
    expect(parseCartUpsellSeededKeysSetting({ keys: "not-an-array" })).toEqual([]);
    expect(
      parseCartUpsellSeededKeysSetting([
        "seed:v1:bundle_completion:default",
        "seed:v1:bundle_completion:default",
        "",
        "   ",
        123,
        null,
        "x".repeat(300),
      ]),
    ).toEqual(["seed:v1:bundle_completion:default"]);
    expect(
      parseCartUpsellSeededKeysSetting({
        keys: ["seed:v1:add_on:addon-workshop", "seed:v1:add_on:addon-workshop", false],
      }),
    ).toEqual(["seed:v1:add_on:addon-workshop"]);
  });

  it("enforces pre-input authz on all new D3 admin procedures (anonymous -> 401, customer/staff -> 403 before input validation)", async () => {
    const anonCaller = callerFor(null);
    const customerCaller = callerFor(alice.principal);
    const staffCaller = callerFor(staff.principal);

    for (const invoke of [
      (c: ReturnType<typeof callerFor>) => c.cart.admin.upsells.setFeature({} as never),
      (c: ReturnType<typeof callerFor>) => c.cart.admin.upsells.setAllActive({} as never),
      (c: ReturnType<typeof callerFor>) => c.cart.admin.upsells.seedSuggested(),
      (c: ReturnType<typeof callerFor>) => c.cart.admin.upsells.duplicate({} as never),
    ]) {
      await expect(invoke(anonCaller)).rejects.toSatisfy(
        (err) => extractCodes(err).trpcCode === "UNAUTHORIZED",
      );
      await expect(invoke(customerCaller)).rejects.toSatisfy(
        (err) => extractCodes(err).trpcCode === "FORBIDDEN",
      );
      await expect(invoke(staffCaller)).rejects.toSatisfy(
        (err) => extractCodes(err).trpcCode === "FORBIDDEN",
      );
    }
  });

  it("D3: seeds all 4 starter categories disabled, is idempotent, never overwrites edits, supports setFeature / Enable all / Disable all / Add suggested offers / Duplicate, and evaluates dynamic bundle completion", async () => {
    const adminCaller = callerFor(admin.principal);
    const aliceCaller = callerFor(alice.principal);

    // 1. Startup seed populates all 4 categories with active === false
    const firstSeed = await cartMod.ensureDefaultUpsellOffers();
    expect(firstSeed.addedCount).toBeGreaterThanOrEqual(6);

    // Re-running startup seed is 100% idempotent
    const secondSeed = await cartMod.ensureDefaultUpsellOffers();
    expect(secondSeed.addedCount).toBe(0);

    const listed = await adminCaller.cart.admin.upsells.list();
    expect(listed.offers.every((o) => o.active === false)).toBe(true);

    // Verify all 4 categories exist
    const tierUpgrades = listed.offers.filter((o) => o.kind === "tier_upgrade");
    const bundleRow = listed.offers.find((o) => o.ruleType === "bundle_completion");
    const nextPackets = listed.offers.filter((o) => o.ruleType === "next_packet");
    const addOns = listed.offers.filter((o) => o.kind === "add_on" && o.ruleType === "standard");

    expect(tierUpgrades.map((o) => o.seedKey)).toEqual(
      expect.arrayContaining([
        "tier-upgrade:packet-1:basic-to-standard",
        "tier-upgrade:packet-1:standard-to-premium",
      ]),
    );
    expect(p1Standard).toBeTruthy();
    expect(p1Premium).toBeTruthy();
    expect(addonWorkshop).toBeTruthy();
    expect(bundleRow).toBeDefined();
    expect(bundleRow?.seedKey).toBe("bundle:complete-all-in");
    expect(nextPackets.map((o) => o.seedKey)).toEqual(
      expect.arrayContaining(["next-packet:packet-1-to-2", "next-packet:packet-2-to-3"]),
    );
    expect(addOns.length).toBeGreaterThanOrEqual(1);

    // 2. Edit one seeded row and delete another -> startup seed never overwrites edits and never resurrects deleted rows
    const targetToEdit = addOns[0]!;
    const edited = await adminCaller.cart.admin.upsells.update({
      offerPublicId: targetToEdit.offerPublicId,
      expectedVersion: targetToEdit.version,
      kind: targetToEdit.kind,
      title: "Custom Workshop Title",
      shortText: "Customized description that must never be overwritten.",
      triggerMode: targetToEdit.triggerMode,
      triggerProductPublicIds: targetToEdit.triggerProductPublicIds,
      targetProductPublicId: targetToEdit.targetProductPublicId,
      priority: targetToEdit.priority,
      active: true,
      startsAt: null,
      endsAt: null,
    });
    expect(edited.title).toBe("Custom Workshop Title");

    const deletedNext = nextPackets[0]!;
    await adminCaller.cart.admin.upsells.delete({ offerPublicId: deletedNext.offerPublicId });

    const rebootSeed = await cartMod.ensureDefaultUpsellOffers();
    expect(rebootSeed.addedCount).toBe(0);

    // Clicking "Add suggested offers" restores ONLY the missing starter row (disabled) and preserves the edited row!
    const manualReseed = await adminCaller.cart.admin.upsells.seedSuggested();
    expect(manualReseed.addedCount).toBe(1);

    const afterReseed = await adminCaller.cart.admin.upsells.list();
    const preservedEdit = afterReseed.offers.find((o) => o.offerPublicId === targetToEdit.offerPublicId)!;
    expect(preservedEdit.title).toBe("Custom Workshop Title");
    expect(preservedEdit.active).toBe(true);
    const restoredRow = afterReseed.offers.find((o) => o.seedKey === deletedNext.seedKey)!;
    expect(restoredRow.active).toBe(false);

    // 3. Page-level switch ("Show suggestions in the cart") turns on feature.cart.upsell and optionally feature.cart
    h.settings.flags.delete(CART_FEATURE_FLAG.flag);
    const featOnly = await adminCaller.cart.admin.upsells.setFeature({
      enabled: true,
      alsoEnableCart: false,
    });
    expect(featOnly).toEqual({ featureUpsellEnabled: true, featureCartEnabled: false });

    const featBoth = await adminCaller.cart.admin.upsells.setFeature({
      enabled: true,
      alsoEnableCart: true,
    });
    expect(featBoth).toEqual({ featureUpsellEnabled: true, featureCartEnabled: true });

    // 4. Enable all / Disable all / Duplicate
    const dup = await adminCaller.cart.admin.upsells.duplicate({
      offerPublicId: targetToEdit.offerPublicId,
    });
    expect(dup.active).toBe(false);
    expect(dup.seedKey).toBeNull();
    expect(dup.title).toContain("(Copy)");

    const enabledAll = await adminCaller.cart.admin.upsells.setAllActive({ active: true });
    expect(enabledAll.updatedCount).toBeGreaterThanOrEqual(1);

    // 5. With 2 of 3 bundle packets in cart, the enabled seeded bundle_completion row dynamically offers Packet 3!
    await aliceCaller.cart.addItems({
      items: [
        { productPublicId: p1Basic, quantity: 1 },
        { productPublicId: p2Basic, quantity: 1 },
      ],
    });
    const cartWithUpsells = await aliceCaller.cart.get();
    const bundleUpsell = cartWithUpsells.upsells.find((u) => u.offerPublicId === bundleRow!.offerPublicId);
    expect(bundleUpsell).toBeDefined();
    expect(bundleUpsell?.kind).toBe("bundle_completion");
    expect(bundleUpsell?.targetProducts.map((p) => p.productPublicId)).toEqual([p3Basic]);

    const afterBundleAccept = await aliceCaller.cart.upsell.accept({
      offerPublicId: bundleRow!.offerPublicId,
      idempotencyKey: "idem-inc06-bundle-accept-01",
    });
    expect(afterBundleAccept.items.map((i) => i.productPublicId)).toEqual(
      expect.arrayContaining([p1Basic, p2Basic, p3Basic]),
    );
    expect(afterBundleAccept.totals.bundle?.applied).toBe(true);

    // Disable all turns every offer off -> customer sees zero upsells
    await adminCaller.cart.admin.upsells.setAllActive({ active: false });
    const afterDisableAll = await aliceCaller.cart.get();
    expect(afterDisableAll.upsells).toEqual([]);
  });

  it("D5: supports set_total ($0.00 & small totals), two-decimal percent, PROMO_LIMIT_* invalidation, waived_small_total receipts, and AMOUNT_BELOW_PROVIDER_MINIMUM rollback", async () => {
    const aliceCaller = callerFor(alice.principal);

    await promotionsMod.admin.updateSettings(admin.principal, {
      enabled: true,
      maxDiscountPercent: 100,
      allowZeroTotal: true,
      minOrderTotalAfterDiscountMinor: 0,
    });

    // 1. Two-decimal percentage (12.50% = 1250 bps on $200.00 = $25.00 = 2500 minor)
    await promotionsMod.admin.create(admin.principal, {
      name: "Partner 12.5% off",
      label: "Partner 12.5% off",
      type: "percent",
      percentBps: 1250,
      scope: { kind: "all" },
      code: "PARTNER125",
    });

    await aliceCaller.cart.addItems({ items: [{ productPublicId: p1Basic, quantity: 1 }] });
    const with125 = await aliceCaller.cart.applyCode({
      code: "PARTNER125",
      idempotencyKey: "idem-p125-01",
    });
    expect(with125.totals.discountMinor).toBe(25_00);
    expect(with125.totals.totalMinor).toBe(175_00);

    // Lowering maxDiscountPercent below 12.5% surfaces PROMO_LIMIT_MAX_PERCENT in promoNotice & blocks checkout with PROMO_RECONFIRM_TOTAL
    await promotionsMod.admin.updateSettings(admin.principal, { maxDiscountPercent: 10 });
    const withLimitNotice = await aliceCaller.cart.get();
    expect(withLimitNotice.promoNotice?.reasonCode).toBe("PROMO_LIMIT_MAX_PERCENT");
    await expect(
      aliceCaller.cart.checkout({
        cartPublicId: with125.cartPublicId!,
        expectedVersion: with125.version,
        projectName: "Blocked by lowered limit",
        note: "",
        billing: sampleBilling,
        policyAcceptances: [],
        idempotencyKey: "idem-limit-block-01",
      }),
    ).rejects.toSatisfy((err) => extractCodes(err).reasonCode === "PROMO_RECONFIRM_TOTAL");
    await promotionsMod.admin.updateSettings(admin.principal, { maxDiscountPercent: 100 });

    // 2. set_total = $0.40 (40 minor < Stripe 50 minor minimum)
    await promotionsMod.admin.create(admin.principal, {
      name: "Test order $0.40",
      label: "Test order $0.40",
      type: "set_total",
      setTotalMinor: 40,
      currency: "USD",
      scope: { kind: "all" },
      code: "SETTOTAL40",
    });

    const refreshedOpen = await aliceCaller.cart.get();
    expect(refreshedOpen.cartPublicId).toBeTruthy();
    const with40 = await aliceCaller.cart.applyCode({
      code: "SETTOTAL40",
      idempotencyKey: "idem-set40-01",
    });
    expect(with40.totals.subtotalMinor).toBe(200_00);
    expect(with40.totals.discountMinor).toBe(199_60);
    expect(with40.totals.totalMinor).toBe(40);
    expect(with40.smallTotalEvaluation).toMatchObject({
      belowMinimum: true,
      minimumMinor: 50,
      smallTotalAction: "waive",
    });

    // 2a. When payments.small_totals is "block", checkout refuses AMOUNT_BELOW_PROVIDER_MINIMUM and rolls back cleanly!
    paymentsFake.belowMinimumBehavior = "block";
    const blockedView = await aliceCaller.cart.get();
    expect(blockedView.smallTotalEvaluation?.smallTotalAction).toBe("block");

    await expect(
      aliceCaller.cart.checkout({
        cartPublicId: blockedView.cartPublicId!,
        expectedVersion: blockedView.version,
        projectName: "Small Total Blocked",
        note: "",
        billing: sampleBilling,
        policyAcceptances: [],
        idempotencyKey: "idem-small-block-01",
      }),
    ).rejects.toSatisfy((err) => extractCodes(err).reasonCode === "AMOUNT_BELOW_PROVIDER_MINIMUM");

    const ordersAfterBlock = await t.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.projectName, "Small Total Blocked"));
    expect(ordersAfterBlock).toHaveLength(0);

    // 2b. When payments.small_totals is "waive", checkout waives the $0.40 balance, settles the invoice, and records waivedMinor!
    paymentsFake.belowMinimumBehavior = "waive";
    const waivedCheckoutPayload = {
      cartPublicId: blockedView.cartPublicId!,
      expectedVersion: blockedView.version,
      projectName: "Small Total Waived",
      note: "",
      billing: sampleBilling,
      policyAcceptances: [],
      idempotencyKey: "idem-small-waive-01",
    };
    const waivedRes = await aliceCaller.cart.checkout(waivedCheckoutPayload);
    expect(waivedRes).toMatchObject({
      mode: "waived_small_total",
      cartPublicId: blockedView.cartPublicId,
      currency: "USD",
      totalMinor: 40,
      waivedMinor: 40,
    });
    expect(paymentsFake.settledCalls).toEqual([
      { invoicePublicId: waivedRes.invoicePublicId, kind: "waived_small_total" },
    ]);
    expect(paymentsFake.redirectCalls).toBe(0);

    // Replay with same idempotencyKey returns identical waived_small_total result
    const waivedReplay = await aliceCaller.cart.checkout(waivedCheckoutPayload);
    expect(waivedReplay).toMatchObject({
      mode: "waived_small_total",
      cartPublicId: blockedView.cartPublicId,
      totalMinor: 40,
      waivedMinor: 40,
    });

    const waivedStatus = await aliceCaller.cart.checkoutStatus({
      cartPublicId: blockedView.cartPublicId!,
    });
    expect(waivedStatus.confirmationState).toBe("no_payment_due");
    expect(waivedStatus.paymentMode).toBe("waived_small_total");
    expect(waivedStatus.totalMinor).toBe(40);
    expect(waivedStatus.waivedMinor).toBe(40);
    expect(waivedStatus.balanceDueMinor).toBe(0);
    expect(waivedStatus.canRestoreToCart).toBe(false);

    await expect(
      aliceCaller.cart.restoreCheckout({ cartPublicId: blockedView.cartPublicId! }),
    ).rejects.toSatisfy((err) => extractCodes(err).reasonCode === "CHECKOUT_ALREADY_PAID");

    // 3. set_total = $0.00 -> Wave-2 zero_total settled receipt!
    await promotionsMod.admin.create(admin.principal, {
      name: "Test order $0.00",
      label: "Complimentary test order",
      type: "set_total",
      setTotalMinor: 0,
      currency: "USD",
      scope: { kind: "all" },
      code: "SETTOTALZERO",
    });

    await aliceCaller.cart.addItems({ items: [{ productPublicId: p2Basic, quantity: 1 }] });
    const withZero = await aliceCaller.cart.applyCode({
      code: "SETTOTALZERO",
      idempotencyKey: "idem-set0-01",
    });
    expect(withZero.totals.totalMinor).toBe(0);

    const zeroRes = await aliceCaller.cart.checkout({
      cartPublicId: withZero.cartPublicId!,
      expectedVersion: withZero.version,
      projectName: "Zero Total Set Total Order",
      note: "",
      billing: sampleBilling,
      policyAcceptances: [],
      idempotencyKey: "idem-set0-checkout-01",
    });
    expect(zeroRes).toMatchObject({
      mode: "no_payment_due",
      totalMinor: 0,
      receiptPublicId: expect.stringMatching(/^01JRECEIPTZERO/),
    });
  });

  it("D14: enforces orders.gates.assertCustomerMayPlaceOrder at checkout, rolling back on AGREEMENT_REQUIRED and succeeding once accepted", async () => {
    paymentsFake.provider = "none";
    const aliceCaller = callerFor(alice.principal);

    // Create & publish an account-level MNDA policy (requiresAcceptance: false so it is governed by D14 agreement_gate)
    const mndaDoc = await complianceMod.policies.admin.createDocument(admin.principal, {
      slug: "order-mnda-inc06",
      title: "Mutual Non-Disclosure Agreement",
      audience: "customer",
      requiresAcceptance: false,
      requiresTypedSignature: true,
      versionLabel: "1.0",
      contentFormat: "plain_text",
      bodyText: "Account-level MNDA governing ReadyPackets engagements.",
      effectiveAt: new Date(h.clock.now().getTime() - 60_000),
    });
    const mndaPublished = await complianceMod.policies.admin.publishVersion(admin.principal, {
      versionPublicId: mndaDoc.draftVersionPublicId,
      effectiveAt: new Date(h.clock.now().getTime() - 60_000),
    });

    await ordersMod.agreementGate.update(admin.principal, {
      setting: {
        enabled: true,
        policyPublicId: mndaDoc.documentPublicId,
        applyTo: { placeOrder: true, workOnOrder: true },
        signatureMode: "typed_name",
        askAgainOnNewVersion: true,
      },
    });

    const added = await aliceCaller.cart.addItems({
      items: [{ productPublicId: p1Basic, quantity: 1 }],
    });

    // First checkout attempt fails with CONFLICT / AGREEMENT_REQUIRED and rolls back cleanly
    let caughtErr: unknown;
    try {
      await aliceCaller.cart.checkout({
        cartPublicId: added.cartPublicId!,
        expectedVersion: added.version,
        projectName: "Gated Project",
        note: "",
        billing: sampleBilling,
        policyAcceptances: [],
        idempotencyKey: "idem-d14-attempt-01",
      });
    } catch (err) {
      caughtErr = err;
    }

    const extracted = extractCodes(caughtErr);
    expect(extracted.trpcCode).toBe("CONFLICT");
    expect(extracted.reasonCode).toBe("AGREEMENT_REQUIRED");
    expect(extracted.details).toEqual({
      policyPublicId: mndaDoc.documentPublicId,
      signatureMode: "typed_name",
    });

    // Cart is still open and zero orders exist for this checkout
    const stillOpen = await aliceCaller.cart.get();
    expect(stillOpen.status).toBe("open");
    const ordersBeforeAccept = await t.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.projectName, "Gated Project"));
    expect(ordersBeforeAccept).toHaveLength(0);

    // Customer accepts the MNDA agreement with their matching profile name, then retries checkout -> succeeds!
    const aliceProfile = await h.services.identity.getUser(alice.id);
    await expect(
      complianceMod.policies.accept(alice.principal, {
        versionPublicId: mndaPublished.versionPublicId,
        contentHash: mndaPublished.contentHash,
        method: "typed_signature",
        signerName: "Wrong Name",
      }),
    ).rejects.toSatisfy((err) => extractCodes(err).reasonCode === "SIGNER_NAME_MISMATCH");

    await complianceMod.policies.accept(alice.principal, {
      versionPublicId: mndaPublished.versionPublicId,
      contentHash: mndaPublished.contentHash,
      method: "typed_signature",
      signerName: aliceProfile!.name!,
    });

    const placed = await aliceCaller.cart.checkout({
      cartPublicId: stillOpen.cartPublicId!,
      expectedVersion: stillOpen.version,
      projectName: "Gated Project",
      note: "",
      billing: sampleBilling,
      policyAcceptances: [],
      idempotencyKey: "idem-d14-attempt-02",
    });
    expect(placed.mode).toBe("invoice");
    expect(placed.orderPublicId).toBeTruthy();
  });
});
