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
import * as paymentsTables from "../payments/schema.js";
import {
  createPaymentsService,
  type PaymentProviderAdapter,
  type PaymentRefundAdapter,
  PAYMENTS_CONFIG_SETTING,
  PAYMENTS_SMALL_TOTALS_SETTING,
  PAYMENTS_STRIPE_SECRET_KEY,
  PAYMENTS_STRIPE_WEBHOOK_SECRET,
} from "../payments/index.js";
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
  ...paymentsTables,
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
      waivedMinor:
        inv!.status === "paid" &&
        this.settledCalls.some((c) => c.invoicePublicId === inv!.publicId && c.kind === "waived_small_total")
          ? inv!.totalMinor
          : 0,
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

  it("D14 live QA regression: policy with requiresAcceptance=true and requiresTypedSignature=false governed by typed_name order agreement gate exposes effective requiresTypedSignature=true, completes in one inline step (with SIGNER_NAME_MISMATCH details), falls back to AGREEMENT_REQUIRED on unsigned/prior-checkbox submissions, and leaves staff orders unaffected", async () => {
    paymentsFake.provider = "none";
    const bob = await insertUser(h, t.db, { role: "customer" });
    const carol = await insertUser(h, t.db, { role: "customer" });
    const aliceCaller = callerFor(alice.principal);
    const bobCaller = callerFor(bob.principal);
    const carolCaller = callerFor(carol.principal);

    // Exact live QA setup: policy "QA Mutual NDA" (audience customer, requiresAcceptance ON, document-level requiresTypedSignature OFF)
    const qaMndaDoc = await complianceMod.policies.admin.createDocument(admin.principal, {
      slug: "qa-mutual-nda",
      title: "QA Mutual NDA",
      audience: "customer",
      requiresAcceptance: true,
      requiresTypedSignature: false,
      versionLabel: "1.0",
      contentFormat: "plain_text",
      bodyText: "QA Mutual NDA body text requiring typed signature via order agreement gate.",
      effectiveAt: new Date(h.clock.now().getTime() - 60_000),
    });
    const qaMndaPublished = await complianceMod.policies.admin.publishVersion(admin.principal, {
      versionPublicId: qaMndaDoc.draftVersionPublicId,
      effectiveAt: new Date(h.clock.now().getTime() - 60_000),
    });

    // Scenario (a) setup for Bob: Bob accepts "QA Mutual NDA" by checkbox in the general policy prompt
    // BEFORE the typed-name order agreement gate is enabled.
    await complianceMod.policies.accept(bob.principal, {
      versionPublicId: qaMndaPublished.versionPublicId,
      contentHash: qaMndaPublished.contentHash,
      method: "portal_checkbox",
    });

    // Admin enables Order Agreement Gate on "QA Mutual NDA" with signatureMode "typed_name" at placing an order.
    await ordersMod.agreementGate.update(admin.principal, {
      setting: {
        enabled: true,
        policyPublicId: qaMndaDoc.documentPublicId,
        applyTo: { placeOrder: true, workOnOrder: true },
        signatureMode: "typed_name",
        askAgainOnNewVersion: true,
      },
    });

    // Scenario (b): Staff-created order on behalf of an unsigned customer (`bob`) is completely unaffected.
    const staffCreatedOrder = await ordersMod.orders.create(admin.principal, {
      onBehalfOfCustomerPublicId: bob.publicId,
      projectName: "Staff Created Engagement",
      items: [{ productPublicId: p1Basic, quantity: 1 }],
      idempotencyKey: "idem-d14-staff-order-0001",
    });
    expect(staffCreatedOrder.publicId).toBeTruthy();

    // Main live QA scenario (`alice` has never accepted "QA Mutual NDA"):
    // 1. `cart.get` / `addItems` exposes effective `requiresTypedSignature: true` on "QA Mutual NDA"
    //    (in both worlds) and reports `placeOrderAgreement`.
    const aliceCart = await aliceCaller.cart.addItems({
      items: [{ productPublicId: p1Basic, quantity: 1 }],
    });
    const aliceGatePolicy = aliceCart.pendingPolicies.find(
      (p) => p.documentPublicId === qaMndaDoc.documentPublicId,
    );
    expect(aliceGatePolicy).toBeDefined();
    expect(aliceGatePolicy?.requiresTypedSignature).toBe(true);
    expect(aliceCart.placeOrderAgreement).toEqual({
      required: true,
      met: false,
      policyPublicId: qaMndaDoc.documentPublicId,
      signatureMode: "typed_name",
    });

    // 2. Submitting a mismatched inline typed name returns SIGNER_NAME_MISMATCH with `details.expectedName`.
    const aliceProfile = await h.services.identity.getUser(alice.id);
    let mismatchErr: unknown;
    try {
      await aliceCaller.cart.checkout({
        cartPublicId: aliceCart.cartPublicId!,
        expectedVersion: aliceCart.version,
        projectName: "Alice Live QA Order",
        note: "",
        billing: sampleBilling,
        policyAcceptances: [
          {
            versionPublicId: qaMndaPublished.versionPublicId,
            contentHash: qaMndaPublished.contentHash,
            signerName: "Wrong Signer Name",
          },
        ],
        idempotencyKey: "idem-d14-qa-alice-mismatch-01",
      });
    } catch (err) {
      mismatchErr = err;
    }
    expect(extractCodes(mismatchErr)).toMatchObject({
      trpcCode: "BAD_REQUEST",
      reasonCode: "SIGNER_NAME_MISMATCH",
      details: expect.objectContaining({
        expectedName: aliceProfile!.name!,
      }),
    });

    // 3. Submitting the matching profile name inline completes checkout in ONE step (does NOT raise AGREEMENT_REQUIRED a second time)!
    const alicePlaced = await aliceCaller.cart.checkout({
      cartPublicId: aliceCart.cartPublicId!,
      expectedVersion: aliceCart.version,
      projectName: "Alice Live QA Order",
      note: "",
      billing: sampleBilling,
      policyAcceptances: [
        {
          versionPublicId: qaMndaPublished.versionPublicId,
          contentHash: qaMndaPublished.contentHash,
          signerName: aliceProfile!.name!,
        },
      ],
      idempotencyKey: "idem-d14-qa-alice-inline-02",
    });
    expect(alicePlaced.mode).toBe("invoice");
    expect(alicePlaced.orderPublicId).toBeTruthy();

    // Stale-tab defense (`carol` submits an unsigned checkbox entry in `policyAcceptances`):
    // Server raises CONFLICT / AGREEMENT_REQUIRED (NOT 400 TYPED_SIGNATURE_REQUIRED), then succeeds after signing!
    const carolCart = await carolCaller.cart.addItems({
      items: [{ productPublicId: p1Basic, quantity: 1 }],
    });
    let staleTabErr: unknown;
    try {
      await carolCaller.cart.checkout({
        cartPublicId: carolCart.cartPublicId!,
        expectedVersion: carolCart.version,
        projectName: "Carol Stale Tab Order",
        note: "",
        billing: sampleBilling,
        policyAcceptances: [
          {
            versionPublicId: qaMndaPublished.versionPublicId,
            contentHash: qaMndaPublished.contentHash,
          },
        ],
        idempotencyKey: "idem-d14-qa-carol-stale-01",
      });
    } catch (err) {
      staleTabErr = err;
    }
    expect(extractCodes(staleTabErr)).toMatchObject({
      trpcCode: "CONFLICT",
      reasonCode: "AGREEMENT_REQUIRED",
      details: {
        policyPublicId: qaMndaDoc.documentPublicId,
        signatureMode: "typed_name",
      },
    });
    const carolProfile = await h.services.identity.getUser(carol.id);
    await complianceMod.policies.accept(carol.principal, {
      versionPublicId: qaMndaPublished.versionPublicId,
      contentHash: qaMndaPublished.contentHash,
      method: "typed_signature",
      signerName: carolProfile!.name!,
    });
    const carolPlaced = await carolCaller.cart.checkout({
      cartPublicId: carolCart.cartPublicId!,
      expectedVersion: carolCart.version,
      projectName: "Carol Stale Tab Order",
      note: "",
      billing: sampleBilling,
      policyAcceptances: [
        {
          versionPublicId: qaMndaPublished.versionPublicId,
          contentHash: qaMndaPublished.contentHash,
        },
      ],
      idempotencyKey: "idem-d14-qa-carol-retry-02",
    });
    expect(carolPlaced.mode).toBe("invoice");

    // Scenario (a) verification (`bob` already accepted "QA Mutual NDA" by checkbox in the general prompt):
    // 1. Bob still gets CONFLICT / AGREEMENT_REQUIRED when submitting without a typed signature.
    const bobCart = await bobCaller.cart.addItems({
      items: [{ productPublicId: p1Basic, quantity: 1 }],
    });
    expect(bobCart.placeOrderAgreement).toEqual({
      required: true,
      met: false,
      policyPublicId: qaMndaDoc.documentPublicId,
      signatureMode: "typed_name",
    });

    let bobGateErr: unknown;
    try {
      await bobCaller.cart.checkout({
        cartPublicId: bobCart.cartPublicId!,
        expectedVersion: bobCart.version,
        projectName: "Bob Upgraded Signature Order",
        note: "",
        billing: sampleBilling,
        policyAcceptances: [],
        idempotencyKey: "idem-d14-qa-bob-01",
      });
    } catch (err) {
      bobGateErr = err;
    }
    expect(extractCodes(bobGateErr)).toMatchObject({
      trpcCode: "CONFLICT",
      reasonCode: "AGREEMENT_REQUIRED",
      details: {
        policyPublicId: qaMndaDoc.documentPublicId,
        signatureMode: "typed_name",
      },
    });

    // 2. Bob signs with his typed full name (upgrading his checkbox acceptance) and completes checkout!
    const bobProfile = await h.services.identity.getUser(bob.id);
    const bobUpgrade = await complianceMod.policies.accept(bob.principal, {
      versionPublicId: qaMndaPublished.versionPublicId,
      contentHash: qaMndaPublished.contentHash,
      method: "typed_signature",
      signerName: bobProfile!.name!,
    });
    expect(bobUpgrade.duplicate).toBe(false);

    const bobPlaced = await bobCaller.cart.checkout({
      cartPublicId: bobCart.cartPublicId!,
      expectedVersion: bobCart.version,
      projectName: "Bob Upgraded Signature Order",
      note: "",
      billing: sampleBilling,
      policyAcceptances: [],
      idempotencyKey: "idem-d14-qa-bob-02",
    });
    expect(bobPlaced.mode).toBe("invoice");
    expect(bobPlaced.orderPublicId).toBeTruthy();
  });

  it("D5 regression: never stores predictive waiver before settlement, reconciles Phase 2 failures and settings/provider flips against the actual ledger", async () => {
    const prevPayments = h.services.payments;
    const aliceCaller = callerFor(alice.principal);

    let createdRedirectSessions = 0;
    const stripeAdapter: PaymentProviderAdapter = {
      key: "stripe",
      async createCheckout(input) {
        createdRedirectSessions += 1;
        return {
          redirectUrl: `https://checkout.stripe.com/c/pay/cs_test_${input.attemptPublicId}`,
          providerRef: `cs_test_${input.attemptPublicId}`,
          expiresAt: null,
        };
      },
      verifyWebhook() {
        return { ok: false, reasonCode: "UNSUPPORTED_IN_TEST" };
      },
      async fetchPayment(input) {
        return {
          providerRef: input.providerRef,
          providerOrderRef: null,
          providerPaymentRef: null,
          status: "open",
          amountMinor: 40,
          currency: "USD",
          livemode: false,
          attemptPublicId: null,
          invoicePublicId: null,
          paidAt: null,
        };
      },
    };
    const squareAdapter: PaymentProviderAdapter = {
      ...stripeAdapter,
      key: "square",
    };
    const noopRefundAdapter: PaymentRefundAdapter<"stripe"> = {
      provider: "stripe",
      async createRefund() {
        return { outcome: "failed", failureReasonCode: "UNSUPPORTED_IN_TEST" };
      },
      async lookupRefund() {
        return { status: "absent", providerRefundRef: null, failureReasonCode: null, settledAt: null };
      },
    };
    const noopSquareRefundAdapter: PaymentRefundAdapter<"square"> = {
      ...noopRefundAdapter,
      provider: "square",
    };

    const realPayments = createPaymentsService(h.deps, {
      stripeAdapter,
      squareAdapter,
      stripeRefundAdapter: noopRefundAdapter,
      squareRefundAdapter: noopSquareRefundAdapter,
    });

    let failNextStartCheckout = false;
    let simulateCrashAfterLedgerSettle = false;
    const faultInjectablePayments = new Proxy(realPayments, {
      get(target, prop, receiver) {
        if (prop === "startCheckout") {
          return async (...args: Parameters<typeof realPayments.startCheckout>) => {
            if (failNextStartCheckout) {
              failNextStartCheckout = false;
              throw new DomainError(
                "UNAVAILABLE",
                "PAYMENTS_START_TRANSIENT_FAILURE",
                "Simulated failure between Phase 1 and Phase 2 before settlement.",
              );
            }
            const res = await target.startCheckout(...args);
            if (simulateCrashAfterLedgerSettle) {
              simulateCrashAfterLedgerSettle = false;
              throw new DomainError(
                "UNAVAILABLE",
                "PROCESS_CRASH_AFTER_SETTLEMENT",
                "Simulated crash after ledger settlement before cart reconciliation.",
              );
            }
            return res;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const configureStripeOnline = async () => {
      await h.settings.setSecret(PAYMENTS_STRIPE_SECRET_KEY.key, "sk_test_ReadyPacketsD5RegressionKey123456");
      await h.settings.setSecret(PAYMENTS_STRIPE_WEBHOOK_SECRET.key, "whsec_ReadyPacketsD5RegressionHook123456");
      await h.settings.set(PAYMENTS_CONFIG_SETTING.key, {
        provider: "stripe",
        mode: "test",
        currency: "USD",
        successPath: "/invoices",
        cancelPath: "/invoices",
        webhookToleranceSeconds: 300,
        stripeSecretKeyLast4: "3456",
        stripeWebhookSecretLast4: "3456",
        squareLocationId: null,
        squareAccessTokenLast4: null,
        squareWebhookSignatureKeyLast4: null,
      });
    };

    const configureInvoiceOnly = async () => {
      await h.settings.set(PAYMENTS_CONFIG_SETTING.key, {
        provider: "none",
        mode: "test",
        currency: "USD",
        successPath: "/invoices",
        cancelPath: "/invoices",
        webhookToleranceSeconds: 300,
        stripeSecretKeyLast4: "3456",
        stripeWebhookSecretLast4: "3456",
        squareLocationId: null,
        squareAccessTokenLast4: null,
        squareWebhookSignatureKeyLast4: null,
      });
    };

    try {
      h.services.payments = faultInjectablePayments as unknown as Services["payments"];
      await configureStripeOnline();
      await h.settings.set(PAYMENTS_SMALL_TOTALS_SETTING.key, {
        belowProviderMinimum: "waive",
      });

      await promotionsMod.admin.create(admin.principal, {
        name: "Sub-minimum $0.40 regression promo",
        label: "$0.40 regression total",
        type: "set_total",
        setTotalMinor: 40,
        currency: "USD",
        scope: { kind: "all" },
        code: "REGRESS40",
        maxPerCustomer: 10,
      });

      // -----------------------------------------------------------------------
      // Case 1: Transient failure between Phase 1 and Phase 2, then retry settles,
      // then settings + provider flip AFTER settlement -> replay reflects what really settled!
      // -----------------------------------------------------------------------
      await aliceCaller.cart.addItems({ items: [{ productPublicId: p1Basic, quantity: 1 }] });
      const cart1 = await aliceCaller.cart.applyCode({
        code: "REGRESS40",
        idempotencyKey: "idem-regress40-apply-1",
      });
      expect(cart1.totals.totalMinor).toBe(40);

      const payload1 = {
        cartPublicId: cart1.cartPublicId!,
        expectedVersion: cart1.version,
        projectName: "D5 Phase 2 Failure Then Waive",
        note: "",
        billing: sampleBilling,
        policyAcceptances: [],
        idempotencyKey: "idem-d5-phase2-fail-then-waive-01",
      };

      failNextStartCheckout = true;
      await expect(aliceCaller.cart.checkout(payload1)).rejects.toSatisfy(
        (err) => extractCodes(err).reasonCode === "PAYMENTS_START_TRANSIENT_FAILURE",
      );

      // Verify cart did NOT store a predictive waiver or premature `checked_out` state!
      const [cart1AfterFail] = await t.db
        .select()
        .from(cartTables.carts)
        .where(eq(cartTables.carts.publicId, cart1.cartPublicId!));
      expect(cart1AfterFail?.status).toBe("awaiting_payment");
      expect(cart1AfterFail?.checkedOutWaivedMinor).toBe(0);
      expect(cart1AfterFail?.paymentMode).toBeNull();

      // Phase 1 `cart.checked_out` audit event must NOT claim a predictive waiver
      const checkedOutAudit1 = h.audit.events.find(
        (ev) => ev.eventName === "cart.checked_out" && ev.resource?.publicId === cart1.cartPublicId,
      );
      expect(checkedOutAudit1).toBeDefined();
      expect(checkedOutAudit1?.attributes).not.toHaveProperty("payment_mode");
      expect(checkedOutAudit1?.attributes).not.toHaveProperty("waived_minor");

      // `checkoutStatus` while unpaid reports `pending_confirmation` with `waivedMinor: 0` and `balanceDueMinor: 40`
      const status1BeforeRetry = await aliceCaller.cart.checkoutStatus({
        cartPublicId: cart1.cartPublicId!,
      });
      expect(status1BeforeRetry.confirmationState).toBe("pending_confirmation");
      expect(status1BeforeRetry.invoiceStatus).toBe("issued");
      expect(status1BeforeRetry.waivedMinor).toBe(0);
      expect(status1BeforeRetry.balanceDueMinor).toBe(40);

      // Retry with the same idempotencyKey now settles the waiver in the ledger and reconciles the cart row
      const settled1 = await aliceCaller.cart.checkout(payload1);
      expect(settled1).toMatchObject({
        mode: "waived_small_total",
        cartPublicId: cart1.cartPublicId,
        totalMinor: 40,
        waivedMinor: 40,
      });
      if (settled1.mode !== "waived_small_total") throw new Error("Expected waived_small_total");
      expect(settled1.receiptPublicId).toBeTruthy();

      const [cart1AfterSettle] = await t.db
        .select()
        .from(cartTables.carts)
        .where(eq(cartTables.carts.publicId, cart1.cartPublicId!));
      expect(cart1AfterSettle?.status).toBe("checked_out");
      expect(cart1AfterSettle?.checkedOutWaivedMinor).toBe(40);

      // Now flip `payments.small_totals` to `"block"` AND flip provider to `"none"` AFTER settlement:
      // idempotent replay MUST still return what actually settled (`waived_small_total`, `waivedMinor: 40`)!
      await h.settings.set(PAYMENTS_SMALL_TOTALS_SETTING.key, {
        belowProviderMinimum: "block",
      });
      const replayAfterFlipToBlock = await aliceCaller.cart.checkout(payload1);
      expect(replayAfterFlipToBlock).toEqual(settled1);

      await configureInvoiceOnly();
      const replayAfterFlipToInvoice = await aliceCaller.cart.checkout(payload1);
      expect(replayAfterFlipToInvoice).toEqual(settled1);

      // Only one `cart.checkout_payment_started` audit event was emitted for cart1 across retries/replays
      const startedAudits1 = h.audit.events.filter(
        (ev) => ev.eventName === "cart.checkout_payment_started" && ev.resource?.publicId === cart1.cartPublicId,
      );
      expect(startedAudits1).toHaveLength(1);
      expect(startedAudits1[0]?.attributes).toMatchObject({
        payment_mode: "waived_small_total",
        waived_minor: 40,
      });

      // -----------------------------------------------------------------------
      // Case 2: Phase 2 fails BEFORE settlement, then `payments.small_totals` flips to `"block"`
      // (replay rejects with `AMOUNT_BELOW_PROVIDER_MINIMUM` — never claims a fake waiver!),
      // and when provider subsequently switches to `"none"` (invoice), replay returns `mode: "invoice"`!
      // -----------------------------------------------------------------------
      await configureStripeOnline();
      await h.settings.set(PAYMENTS_SMALL_TOTALS_SETTING.key, {
        belowProviderMinimum: "waive",
      });

      await aliceCaller.cart.addItems({ items: [{ productPublicId: p2Basic, quantity: 1 }] });
      const cart2 = await aliceCaller.cart.applyCode({
        code: "REGRESS40",
        idempotencyKey: "idem-regress40-apply-2",
      });

      const payload2 = {
        cartPublicId: cart2.cartPublicId!,
        expectedVersion: cart2.version,
        projectName: "D5 Flip Before Settlement",
        note: "",
        billing: sampleBilling,
        policyAcceptances: [],
        idempotencyKey: "idem-d5-flip-before-settlement-02",
      };

      failNextStartCheckout = true;
      await expect(aliceCaller.cart.checkout(payload2)).rejects.toSatisfy(
        (err) => extractCodes(err).reasonCode === "PAYMENTS_START_TRANSIENT_FAILURE",
      );

      // Flip `payments.small_totals` to `"block"` BEFORE Phase 2 ever settled
      await h.settings.set(PAYMENTS_SMALL_TOTALS_SETTING.key, {
        belowProviderMinimum: "block",
      });

      await expect(aliceCaller.cart.checkout(payload2)).rejects.toSatisfy(
        (err) => extractCodes(err).reasonCode === "AMOUNT_BELOW_PROVIDER_MINIMUM",
      );

      const [cart2AfterBlockedReplay] = await t.db
        .select()
        .from(cartTables.carts)
        .where(eq(cartTables.carts.publicId, cart2.cartPublicId!));
      expect(cart2AfterBlockedReplay?.status).toBe("awaiting_payment");
      expect(cart2AfterBlockedReplay?.checkedOutWaivedMinor).toBe(0);

      // Now admin switches provider to `"none"` (pay by invoice); replay settles into `"invoice"` mode with `checkedOutWaivedMinor === 0`!
      await configureInvoiceOnly();
      const invoiceReplay2 = await aliceCaller.cart.checkout(payload2);
      expect(invoiceReplay2).toMatchObject({
        mode: "invoice",
        cartPublicId: cart2.cartPublicId,
        totalMinor: 40,
      });

      const [cart2AfterInvoiceReplay] = await t.db
        .select()
        .from(cartTables.carts)
        .where(eq(cartTables.carts.publicId, cart2.cartPublicId!));
      expect(cart2AfterInvoiceReplay?.status).toBe("checked_out");
      expect(cart2AfterInvoiceReplay?.paymentMode).toBe("invoice");
      expect(cart2AfterInvoiceReplay?.checkedOutWaivedMinor).toBe(0);

      // -----------------------------------------------------------------------
      // Case 3: Phase 2 fails BEFORE settlement, then provider minimum is lowered to $0.30
      // so $0.40 is no longer sub-minimum -> replay creates a hosted redirect attempt (`checkedOutWaivedMinor === 0`)!
      // -----------------------------------------------------------------------
      await configureStripeOnline();
      await h.settings.set(PAYMENTS_SMALL_TOTALS_SETTING.key, {
        belowProviderMinimum: "waive",
      });

      await aliceCaller.cart.addItems({ items: [{ productPublicId: p3Basic, quantity: 1 }] });
      const cart3 = await aliceCaller.cart.applyCode({
        code: "REGRESS40",
        idempotencyKey: "idem-regress40-apply-3",
      });

      const payload3 = {
        cartPublicId: cart3.cartPublicId!,
        expectedVersion: cart3.version,
        projectName: "D5 Lowered Minimum Redirect",
        note: "",
        billing: sampleBilling,
        policyAcceptances: [],
        idempotencyKey: "idem-d5-lowered-min-redirect-03",
      };

      failNextStartCheckout = true;
      await expect(aliceCaller.cart.checkout(payload3)).rejects.toSatisfy(
        (err) => extractCodes(err).reasonCode === "PAYMENTS_START_TRANSIENT_FAILURE",
      );

      await h.settings.set(PAYMENTS_SMALL_TOTALS_SETTING.key, {
        belowProviderMinimum: "block",
        minimumOverrides: { stripe: { USD: 30 } },
      });

      const redirectReplay3 = await aliceCaller.cart.checkout(payload3);
      expect(redirectReplay3).toMatchObject({
        mode: "redirect",
        cartPublicId: cart3.cartPublicId,
        provider: "stripe",
        totalMinor: 40,
      });
      expect(createdRedirectSessions).toBe(1);

      const [cart3AfterRedirect] = await t.db
        .select()
        .from(cartTables.carts)
        .where(eq(cartTables.carts.publicId, cart3.cartPublicId!));
      expect(cart3AfterRedirect?.status).toBe("awaiting_payment");
      expect(cart3AfterRedirect?.paymentMode).toBe("redirect");
      expect(cart3AfterRedirect?.checkedOutWaivedMinor).toBe(0);

      // -----------------------------------------------------------------------
      // Case 4: Crash AFTER ledger waiver settlement BEFORE cart row reconciliation:
      // replay reconciles `checkedOutWaivedMinor` from the ledger even after `payments.small_totals` flipped to `"block"`!
      // -----------------------------------------------------------------------
      await h.settings.set(PAYMENTS_SMALL_TOTALS_SETTING.key, {
        belowProviderMinimum: "waive",
      });

      await aliceCaller.cart.addItems({ items: [{ productPublicId: addonWorkshop, quantity: 1 }] });
      const cart4 = await aliceCaller.cart.applyCode({
        code: "REGRESS40",
        idempotencyKey: "idem-regress40-apply-4",
      });

      const payload4 = {
        cartPublicId: cart4.cartPublicId!,
        expectedVersion: cart4.version,
        projectName: "D5 Crash After Ledger Settle",
        note: "",
        billing: sampleBilling,
        policyAcceptances: [],
        idempotencyKey: "idem-d5-crash-after-settle-04",
      };

      simulateCrashAfterLedgerSettle = true;
      await expect(aliceCaller.cart.checkout(payload4)).rejects.toSatisfy(
        (err) => extractCodes(err).reasonCode === "PROCESS_CRASH_AFTER_SETTLEMENT",
      );

      // Cart row has not been reconciled yet (`checkedOutWaivedMinor === 0`), even though the ledger settled!
      const [cart4BeforeReconcile] = await t.db
        .select()
        .from(cartTables.carts)
        .where(eq(cartTables.carts.publicId, cart4.cartPublicId!));
      expect(cart4BeforeReconcile?.status).toBe("awaiting_payment");
      expect(cart4BeforeReconcile?.checkedOutWaivedMinor).toBe(0);

      // Even before replay updates the cart row, `checkoutStatus` sees `invoiceStatus === "paid"` and blocks restore!
      const status4BeforeReconcile = await aliceCaller.cart.checkoutStatus({
        cartPublicId: cart4.cartPublicId!,
      });
      expect(status4BeforeReconcile.invoiceStatus).toBe("paid");
      expect(status4BeforeReconcile.canRestoreToCart).toBe(false);
      if (status4BeforeReconcile.waivedMinor > 0) {
        expect(status4BeforeReconcile.confirmationState).toBe("no_payment_due");
        expect(status4BeforeReconcile.paymentMode).toBe("waived_small_total");
        expect(status4BeforeReconcile.waivedMinor).toBe(40);
      }

      // Flip `payments.small_totals` to `"block"` before replay, then replay -> reconciles `checkedOutWaivedMinor = 40` from ledger!
      await h.settings.set(PAYMENTS_SMALL_TOTALS_SETTING.key, {
        belowProviderMinimum: "block",
      });
      const reconciled4 = await aliceCaller.cart.checkout(payload4);
      expect(reconciled4).toMatchObject({
        mode: "waived_small_total",
        cartPublicId: cart4.cartPublicId,
        totalMinor: 40,
        waivedMinor: 40,
      });

      const [cart4AfterReconcile] = await t.db
        .select()
        .from(cartTables.carts)
        .where(eq(cartTables.carts.publicId, cart4.cartPublicId!));
      expect(cart4AfterReconcile?.status).toBe("checked_out");
      expect(cart4AfterReconcile?.checkedOutWaivedMinor).toBe(40);

      const status4AfterReconcile = await aliceCaller.cart.checkoutStatus({
        cartPublicId: cart4.cartPublicId!,
      });
      expect(status4AfterReconcile.confirmationState).toBe("no_payment_due");
      expect(status4AfterReconcile.paymentMode).toBe("waived_small_total");
      expect(status4AfterReconcile.waivedMinor).toBe(40);
      expect(status4AfterReconcile.canRestoreToCart).toBe(false);

      // Even if provider subsequently flips to `"none"` (`startCheckout` -> `"invoice"`), a replay
      // preserves the already-reconciled terminal waiver and never overwrites `checkedOutWaivedMinor`!
      await h.settings.set(PAYMENTS_CONFIG_SETTING.key, {
        provider: "none",
        mode: "test",
      });
      const replayAfterProviderNone = await aliceCaller.cart.checkout(payload4);
      expect(replayAfterProviderNone).toMatchObject({
        mode: "waived_small_total",
        cartPublicId: cart4.cartPublicId,
        totalMinor: 40,
        waivedMinor: 40,
      });
      const [cart4AfterProviderFlip] = await t.db
        .select()
        .from(cartTables.carts)
        .where(eq(cartTables.carts.publicId, cart4.cartPublicId!));
      expect(cart4AfterProviderFlip?.paymentMode).toBeNull();
      expect(cart4AfterProviderFlip?.checkedOutWaivedMinor).toBe(40);
    } finally {
      h.services.payments = prevPayments;
      h.settings.values.delete(PAYMENTS_CONFIG_SETTING.key);
      h.settings.values.delete(PAYMENTS_SMALL_TOTALS_SETTING.key);
    }
  });
});
