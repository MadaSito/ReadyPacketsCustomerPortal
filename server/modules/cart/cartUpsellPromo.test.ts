/**
 * Increment 05 (Package B) server integration & abuse-case suite:
 *  - Decision D2: Cart upsell (`feature.cart.upsell`, `add_on`, `tier_upgrade`, automatic `bundle_completion`,
 *    counters, per-cart dismissals, idempotent `accept`, admin CRUD authz `customer -> NOT_FOUND` vs `staff -> FORBIDDEN`).
 *  - Decision D3 / §3: Discount code in cart (`applyCode`, `removeCode`, encrypted storage, zero raw code in logs/audit,
 *    passive `recheck: true` re-evaluation, checkout redemption, and `"order not placed, confirm new total"` on stale code).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Services } from "../../container.js";
import type { Db, DbOrTx, Logger, SessionPrincipal, Tx } from "../../core/types.js";
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
import { createPromotionsModule } from "../promotions/index.js";
import * as cartTables from "./schema.js";
import { CART_FEATURE_FLAG, CART_UPSELL_FEATURE_FLAG } from "./settings.js";
import type {
  CartPaymentsPort,
  CartPromotionContext,
  CartPromotionOutcome,
  CartPromotionsPort,
} from "./ports.js";
import {
  BUNDLE_COMPLETION_OFFER_KEY,
  createCartModule,
  type BillingDetailsInput,
  type CartModule,
} from "./index.js";
import { cartRouter } from "./router.js";

const testSchema = {
  users,
  ...orderTables,
  ...complianceTables,
  ...promotionsTables,
  ...cartTables,
};

class SimpleInvoicePayments implements CartPaymentsPort {
  async isOnlineCheckoutEnabled() {
    return false;
  }
  async getPublicCheckoutConfig() {
    return { provider: "none" as const, mode: "test" as const, currency: "USD" };
  }
  async startCheckout(invoicePublicId: string) {
    return { mode: "invoice" as const, invoicePublicId };
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
      balanceDueMinor: inv!.totalMinor,
      currency: inv!.currency,
      providerConfigured: "none" as const,
      environment: "test" as const,
      attempt: null,
    };
  }
  async cancelAttemptIfUnpaid() {
    return { cancelled: false, attemptPublicId: null, status: null };
  }
}

interface FakePromoDef {
  promoPublicId: string;
  code: string;
  label: string;
  percentOff: number;
  minSubtotalMinor: number;
  maxRedemptions: number;
  redeemedCount: number;
  active: boolean;
}

class FakePromotionsService implements CartPromotionsPort {
  enabled = true;
  entryPreviewCalls = 0;
  recheckPreviewCalls = 0;
  failedEntryGuesses = 0;
  defs = new Map<string, FakePromoDef>();

  async isEnabled(_opts?: { tx?: DbOrTx }) {
    return this.enabled;
  }

  private evaluate(ctx: CartPromotionContext): CartPromotionOutcome {
    const norm = ctx.code.trim().toUpperCase();
    const def = this.defs.get(norm);
    if (!def || !def.active || def.redeemedCount >= def.maxRedemptions) {
      throw new DomainError("VALIDATION", "PROMO_NOT_APPLICABLE", "This code cannot be applied.");
    }
    if (ctx.subtotalMinor < def.minSubtotalMinor) {
      throw new DomainError(
        "VALIDATION",
        "PROMO_MIN_SUBTOTAL",
        `This code requires a minimum subtotal of $${(def.minSubtotalMinor / 100).toFixed(2)}.`,
      );
    }
    const rawPromo = Math.floor((ctx.subtotalMinor * def.percentOff + 50) / 100);
    // Better-of rule (D3 default: does not stack with bundle discount; picks whichever saves more).
    if (rawPromo > ctx.bundleDiscountMinor) {
      const discountMinor = Math.min(ctx.subtotalMinor, rawPromo);
      return {
        promoPublicId: def.promoPublicId,
        label: def.label,
        promoDiscountMinor: discountMinor,
        bundleDiscountMinor: 0,
        discountMinor,
        discountLabel: def.label,
        totalMinor: ctx.subtotalMinor - discountMinor,
      };
    }
    return {
      promoPublicId: def.promoPublicId,
      label: def.label,
      promoDiscountMinor: 0,
      bundleDiscountMinor: ctx.bundleDiscountMinor,
      discountMinor: ctx.bundleDiscountMinor,
      discountLabel: ctx.bundleLabel ?? def.label,
      totalMinor: ctx.subtotalMinor - ctx.bundleDiscountMinor,
    };
  }

  async preview(ctx: CartPromotionContext, opts?: { tx?: DbOrTx; recheck?: boolean }): Promise<CartPromotionOutcome> {
    if (!this.enabled) {
      throw new DomainError("VALIDATION", "PROMO_NOT_APPLICABLE", "This code cannot be applied.");
    }
    if (opts?.recheck) {
      this.recheckPreviewCalls += 1;
    } else {
      this.entryPreviewCalls += 1;
    }
    try {
      return this.evaluate(ctx);
    } catch (err) {
      if (!opts?.recheck) {
        this.failedEntryGuesses += 1;
      }
      throw err;
    }
  }

  async redeemInTx(
    _tx: Tx,
    ctx: CartPromotionContext & { orderPublicId: string; correlationId: string },
  ): Promise<CartPromotionOutcome> {
    if (!this.enabled) {
      throw new DomainError("VALIDATION", "PROMO_NOT_APPLICABLE", "This code cannot be applied.");
    }
    const outcome = this.evaluate(ctx);
    const def = this.defs.get(ctx.code.trim().toUpperCase())!;
    def.redeemedCount += 1;
    return outcome;
  }

  async releaseForOrderInTx() {
    return { released: false };
  }
}

const appTestRouter = router({ cart: cartRouter });
const createCaller = createCallerFactory(appTestRouter);

let t: TestDb;
let h: TestHarness;
let capturedLogs: unknown[] = [];
let ordersMod: OrdersModule;
let complianceMod: ComplianceModule;
let cartMod: CartModule;
let promosFake: FakePromotionsService;

let admin: TestUser;
let staff: TestUser;
let alice: TestUser;
let bob: TestUser;

let p1Basic: string;
let p1Premium: string;
let p2Basic: string;
let p3Basic: string;
let addonWorkshop: string;
let addonInactive: string;
let publishedPolicyVersionId: string;
let publishedPolicyHash: string;

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
  const makeCapturingLogger = (): Logger => ({
    debug: (...args: unknown[]) => { capturedLogs.push(args); },
    info: (...args: unknown[]) => { capturedLogs.push(args); },
    warn: (...args: unknown[]) => { capturedLogs.push(args); },
    error: (...args: unknown[]) => { capturedLogs.push(args); },
    child: () => makeCapturingLogger(),
  });
  h.deps.logger = makeCapturingLogger();
  const identityFake = fakeIdentity(h, t.db);
  ordersMod = createOrdersModule(h.deps);
  complianceMod = createComplianceModule(h.deps);
  promosFake = new FakePromotionsService();
  cartMod = createCartModule(h.deps);

  h.services.identity = identityFake as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];
  h.services.orders = ordersMod;
  h.services.compliance = complianceMod;
  h.services.payments = new SimpleInvoicePayments() as unknown as Services["payments"];
  (h.services as unknown as Record<string, unknown>).promotions = promosFake;
  h.services.cart = cartMod;

  cartMod.init();

  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  staff = await insertUser(h, t.db, { role: "staff" });
  alice = await insertUser(h, t.db, { role: "customer" });
  bob = await insertUser(h, t.db, { role: "customer" });

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
      deliverables: [{ title: "Roadmap", detail: "Baseline" }],
      outcome: "Roadmap",
      timeline: "5 days",
      features: ["Roadmap"],
      priceMinor: 200_00,
      currency: "USD",
    })
  ).publicId;

  p1Premium = (
    await ordersMod.catalog.createProduct(admin.principal, {
      groupId: g1.publicId,
      productKey: "p1-premium",
      packetNumber: 1,
      tier: "Premium",
      sortOrder: 2,
      active: true,
      name: "Packet 1 Premium",
      description: "Executive strategy",
      deliverables: [{ title: "Board deck", detail: "Executive deck" }],
      outcome: "Board alignment",
      timeline: "7 days",
      features: ["Roadmap", "Board deck"],
      priceMinor: 350_00,
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
      description: "Architecture blueprint",
      deliverables: [{ title: "Blueprint", detail: "System design" }],
      outcome: "Blueprint",
      timeline: "5 days",
      features: ["Blueprint"],
      priceMinor: 300_00,
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
      description: "Delivery launch",
      deliverables: [{ title: "Launch plan", detail: "Rollout" }],
      outcome: "Launch plan",
      timeline: "5 days",
      features: ["Launch plan"],
      priceMinor: 400_00,
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
      name: "Stakeholder Workshop",
      description: "Facilitated workshop",
      deliverables: [{ title: "Workshop", detail: "90-minute session" }],
      outcome: "Team consensus",
      timeline: "2 days",
      features: ["Live facilitation"],
      priceMinor: 150_00,
      currency: "USD",
    })
  ).publicId;

  addonInactive = (
    await ordersMod.catalog.createProduct(admin.principal, {
      groupId: gAddon.publicId,
      productKey: "addon-retired",
      packetNumber: null,
      tier: null,
      sortOrder: 2,
      active: false,
      name: "Retired Add-on",
      description: "No longer sold",
      deliverables: [{ title: "Retired", detail: "Retired" }],
      outcome: "None",
      timeline: "N/A",
      features: ["Retired"],
      priceMinor: 99_00,
      currency: "USD",
    })
  ).publicId;

  await h.settings.set("orders.bundle_rule", {
    enabled: true,
    requiredPacketNumbers: [1, 2, 3],
    discountPercent: 10,
    label: "Full 3-Packet Bundle (10% off)",
  });

  const createdDoc = await complianceMod.policies.admin.createDocument(admin.principal, {
    slug: "terms-of-service",
    title: "Terms of Service",
    audience: "customer",
    requiresAcceptance: true,
    requiresTypedSignature: false,
    versionLabel: "1.0",
    contentFormat: "plain_text",
    bodyText: "Customer agrees to synthetic test terms.",
    effectiveAt: new Date(h.clock.now().getTime() - 60_000),
  });
  const pub = await complianceMod.policies.admin.publishVersion(admin.principal, {
    versionPublicId: createdDoc.draftVersionPublicId,
    effectiveAt: new Date(h.clock.now().getTime() - 60_000),
  });
  publishedPolicyVersionId = pub.versionPublicId;
  publishedPolicyHash = pub.contentHash;
});

afterAll(async () => {
  await t?.cleanup();
});

beforeEach(async () => {
  await t.db.delete(cartTables.cartUpsellAcceptances);
  await t.db.delete(cartTables.cartUpsellCartStates);
  await t.db.delete(cartTables.cartUpsellOffers);
  await t.db.delete(cartTables.cartItems);
  await t.db.delete(cartTables.carts);

  h.settings.flags.add(CART_FEATURE_FLAG.flag);
  h.settings.flags.delete(CART_UPSELL_FEATURE_FLAG.flag);

  promosFake.enabled = true;
  promosFake.entryPreviewCalls = 0;
  promosFake.recheckPreviewCalls = 0;
  promosFake.failedEntryGuesses = 0;
  promosFake.defs.clear();
  (h.services as unknown as Record<string, unknown>).promotions = promosFake;
  h.audit.clear();
  capturedLogs = [];
});

describe("Increment 05 Package B — Cart upsell (D2) & Discount codes in cart (D3 / §3)", () => {
  it("enforces admin upsell authz before input parsing: anonymous -> UNAUTHORIZED, customer/unprivileged staff -> FORBIDDEN even on empty {} input, admin -> allowed", async () => {
    for (const call of [
      () => callerFor(null).cart.admin.upsells.list(),
      () => callerFor(null).cart.admin.upsells.create({} as never),
      () => callerFor(null).cart.admin.upsells.update({} as never),
      () => callerFor(null).cart.admin.upsells.setActive({} as never),
      () => callerFor(null).cart.admin.upsells.delete({} as never),
    ]) {
      await expect(call()).rejects.toSatisfy((err) => {
        const c = extractCodes(err);
        return c.trpcCode === "UNAUTHORIZED" && c.domainCode === "UNAUTHENTICATED";
      });
    }

    for (const principal of [alice.principal, staff.principal]) {
      for (const call of [
        () => callerFor(principal).cart.admin.upsells.list(),
        () => callerFor(principal).cart.admin.upsells.create({} as never),
        () => callerFor(principal).cart.admin.upsells.update({} as never),
        () => callerFor(principal).cart.admin.upsells.setActive({} as never),
        () => callerFor(principal).cart.admin.upsells.delete({} as never),
      ]) {
        await expect(call()).rejects.toSatisfy((err) => {
          const c = extractCodes(err);
          return c.trpcCode === "FORBIDDEN" && c.domainCode === "FORBIDDEN";
        });
      }
    }

    // Service-side defence-in-depth still rejects direct non-admin callers.
    await expect(cartMod.adminListUpsellOffers(alice.principal)).rejects.toSatisfy(
      (err) => err instanceof DomainError && err.code === "NOT_FOUND",
    );
    await expect(cartMod.adminListUpsellOffers(staff.principal)).rejects.toSatisfy(
      (err) => err instanceof DomainError && err.code === "FORBIDDEN",
    );

    const listRes = await callerFor(admin.principal).cart.admin.upsells.list();
    expect(listRes.featureCartEnabled).toBe(true);
    expect(listRes.featureUpsellEnabled).toBe(false);
    expect(listRes.offers).toEqual([]);
  });

  it("keeps feature.cart.upsell off by default and enforces upsell eligibility, counters, per-cart dismissals, and idempotent accept", async () => {
    const adminCaller = callerFor(admin.principal);
    const aliceCaller = callerFor(alice.principal);
    const bobCaller = callerFor(bob.principal);

    // Tier upgrade targeting the cheapest tier (Basic) is refused at creation time.
    await expect(
      adminCaller.cart.admin.upsells.create({
        kind: "tier_upgrade",
        title: "Invalid downgrade",
        shortText: "Should not be allowed",
        triggerMode: "any_cart",
        triggerProductPublicIds: [],
        targetProductPublicId: p1Basic,
        priority: 10,
        active: true,
      }),
    ).rejects.toSatisfy((err) => extractCodes(err).reasonCode === "TIER_UPGRADE_MUST_BE_HIGHER_TIER");

    // Inactive target product is refused.
    await expect(
      adminCaller.cart.admin.upsells.create({
        kind: "add_on",
        title: "Retired offer",
        shortText: "Inactive product",
        triggerMode: "any_cart",
        triggerProductPublicIds: [],
        targetProductPublicId: addonInactive,
      }),
    ).rejects.toSatisfy((err) => extractCodes(err).reasonCode === "TARGET_PRODUCT_UNAVAILABLE");

    // Create valid tier upgrade + add-on offers.
    const upgradeOffer = await adminCaller.cart.admin.upsells.create({
      kind: "tier_upgrade",
      title: "Upgrade Packet 1 to Premium",
      shortText: "Add executive board deck alignment.",
      triggerMode: "products",
      triggerProductPublicIds: [p1Basic],
      targetProductPublicId: p1Premium,
      priority: 10,
      active: true,
    });

    const addonOffer = await adminCaller.cart.admin.upsells.create({
      kind: "add_on",
      title: "Add Stakeholder Workshop",
      shortText: "Facilitated 90-minute alignment session.",
      triggerMode: "any_cart",
      triggerProductPublicIds: [],
      targetProductPublicId: addonWorkshop,
      priority: 80,
      active: true,
    });

    // Future-scheduled offer must not show yet.
    const futureStart = new Date(h.clock.now().getTime() + 86_400_000);
    await adminCaller.cart.admin.upsells.create({
      kind: "add_on",
      title: "Future Offer",
      shortText: "Starts tomorrow.",
      triggerMode: "any_cart",
      triggerProductPublicIds: [],
      targetProductPublicId: p3Basic,
      priority: 5,
      active: true,
      startsAt: futureStart,
    });

    // Alice adds Packet 1 Basic + Packet 2 Basic (1 packet short of the 3-packet bundle rule!).
    const whileUpsellOff = await aliceCaller.cart.addItems({
      items: [
        { productPublicId: p1Basic, quantity: 1 },
        { productPublicId: p2Basic, quantity: 1 },
      ],
    });
    expect(whileUpsellOff.upsells).toEqual([]);

    // Accept is refused while feature.cart.upsell is false.
    await expect(
      aliceCaller.cart.upsell.accept({
        offerPublicId: upgradeOffer.offerPublicId,
        idempotencyKey: "idem-upsell-off-01",
      }),
    ).rejects.toSatisfy((err) => extractCodes(err).reasonCode === "CART_UPSELL_DISABLED");

    // Enable feature.cart.upsell.
    h.settings.flags.add(CART_UPSELL_FEATURE_FLAG.flag);

    const firstView = await aliceCaller.cart.get();
    // Priority order: upgradeOffer (10), bundle_completion (50), addonOffer (80). Future offer excluded!
    expect(firstView.upsells.map((u) => u.offerPublicId)).toEqual([
      upgradeOffer.offerPublicId,
      BUNDLE_COMPLETION_OFFER_KEY,
      addonOffer.offerPublicId,
    ]);
    // Upgrade delta = $350 - $200 = +$150.00
    expect(firstView.upsells[0]?.priceMinor).toBe(150_00);
    // Bundle completion: Packet 3 Basic ($400) completes $200+$300+$400=$900 * 10% = $90 saving -> net +$310!
    expect(firstView.upsells[1]?.savingMinor).toBe(90_00);
    expect(firstView.upsells[1]?.priceMinor).toBe(310_00);

    // Polling cart.get again does NOT inflate shownCount!
    await aliceCaller.cart.get();
    const afterTwoReads = await adminCaller.cart.admin.upsells.list();
    expect(afterTwoReads.offers.find((o) => o.offerPublicId === upgradeOffer.offerPublicId)?.shownCount).toBe(1);
    expect(afterTwoReads.offers.find((o) => o.offerPublicId === addonOffer.offerPublicId)?.shownCount).toBe(1);

    // Dismissing addonOffer hides it on Alice's cart only (Bob still sees it) and increments dismissedCount once.
    const afterDismiss = await aliceCaller.cart.upsell.dismiss({ offerPublicId: addonOffer.offerPublicId });
    expect(afterDismiss.upsells.some((u) => u.offerPublicId === addonOffer.offerPublicId)).toBe(false);
    await aliceCaller.cart.upsell.dismiss({ offerPublicId: addonOffer.offerPublicId });

    await bobCaller.cart.addItems({ items: [{ productPublicId: p1Basic, quantity: 1 }] });
    const bobView = await bobCaller.cart.get();
    expect(bobView.upsells.some((u) => u.offerPublicId === addonOffer.offerPublicId)).toBe(true);

    const afterDismissCounts = await adminCaller.cart.admin.upsells.list();
    expect(afterDismissCounts.offers.find((o) => o.offerPublicId === addonOffer.offerPublicId)?.dismissedCount).toBe(1);
    expect(afterDismissCounts.offers.find((o) => o.offerPublicId === addonOffer.offerPublicId)?.shownCount).toBe(2);

    // Client-supplied extra price field is rejected by .strict().
    await expect(
      (aliceCaller.cart.upsell.accept as (input: unknown) => Promise<unknown>)({
        offerPublicId: upgradeOffer.offerPublicId,
        idempotencyKey: "idem-extra-field-01",
        priceMinor: 1,
      }),
    ).rejects.toSatisfy((err) => err instanceof TRPCError && err.code === "BAD_REQUEST");

    // Accept tier upgrade + replay with identical idempotencyKey -> one effect!
    const acceptedUpgrade = await aliceCaller.cart.upsell.accept({
      offerPublicId: upgradeOffer.offerPublicId,
      idempotencyKey: "idem-accept-upgrade-01",
    });
    const replayUpgrade = await aliceCaller.cart.upsell.accept({
      offerPublicId: upgradeOffer.offerPublicId,
      idempotencyKey: "idem-accept-upgrade-01",
    });
    expect(acceptedUpgrade.items.find((i) => i.packetNumber === 1)?.productPublicId).toBe(p1Premium);
    expect(acceptedUpgrade.totals.subtotalMinor).toBe(650_00);
    expect(replayUpgrade.version).toBe(acceptedUpgrade.version);

    // Reusing the same idempotencyKey for a DIFFERENT offer is rejected with CONFLICT:IDEMPOTENCY_KEY_REUSED!
    await expect(
      aliceCaller.cart.upsell.accept({
        offerPublicId: BUNDLE_COMPLETION_OFFER_KEY,
        idempotencyKey: "idem-accept-upgrade-01",
      }),
    ).rejects.toSatisfy((err) => extractCodes(err).reasonCode === "IDEMPOTENCY_KEY_REUSED");

    // Once Packet 1 is Premium, tier_upgrade is no longer suggested!
    expect(acceptedUpgrade.upsells.some((u) => u.offerPublicId === upgradeOffer.offerPublicId)).toBe(false);

    const afterAcceptCounts = await adminCaller.cart.admin.upsells.list();
    expect(afterAcceptCounts.offers.find((o) => o.offerPublicId === upgradeOffer.offerPublicId)?.acceptedCount).toBe(1);

    // Regression: if an offer's target product is deactivated right before accept, accept fails closed!
    const bobOffer = await adminCaller.cart.admin.upsells.create({
      kind: "add_on",
      title: "Temporary Workshop Offer",
      shortText: "Limited workshop slot.",
      triggerMode: "any_cart",
      triggerProductPublicIds: [],
      targetProductPublicId: addonWorkshop,
      priority: 1,
      active: true,
    });
    await t.db
      .update(orderTables.catalogProducts)
      .set({ active: false })
      .where(eq(orderTables.catalogProducts.publicId, addonWorkshop));
    await expect(
      bobCaller.cart.upsell.accept({
        offerPublicId: bobOffer.offerPublicId,
        idempotencyKey: "idem-bob-deactivated-target",
      }),
    ).rejects.toSatisfy((err) => extractCodes(err).reasonCode === "UPSELL_NOT_AVAILABLE");
    await t.db
      .update(orderTables.catalogProducts)
      .set({ active: true })
      .where(eq(orderTables.catalogProducts.publicId, addonWorkshop));

    // Regression: lower-priority duplicate offer suppressed by `bobOffer` (priority 1 vs 80) cannot be accepted directly!
    await expect(
      bobCaller.cart.upsell.accept({
        offerPublicId: addonOffer.offerPublicId,
        idempotencyKey: "idem-bob-suppressed-offer",
      }),
    ).rejects.toSatisfy((err) => extractCodes(err).reasonCode === "UPSELL_NOT_AVAILABLE");

    // Regression: if target product is repriced before accept, accept applies the live server price inside tx!
    const [workshopRow] = await t.db
      .select()
      .from(orderTables.catalogProducts)
      .where(eq(orderTables.catalogProducts.publicId, addonWorkshop));
    await t.db
      .update(orderTables.catalogProductVersions)
      .set({ priceMinor: 175_00 })
      .where(eq(orderTables.catalogProductVersions.id, workshopRow!.currentVersionId!));
    const bobAcceptedRepriced = await bobCaller.cart.upsell.accept({
      offerPublicId: bobOffer.offerPublicId,
      idempotencyKey: "idem-bob-repriced-target",
    });
    expect(bobAcceptedRepriced.items.find((i) => i.productPublicId === addonWorkshop)?.unitPriceMinor).toBe(175_00);
    await t.db
      .update(orderTables.catalogProductVersions)
      .set({ priceMinor: 150_00 })
      .where(eq(orderTables.catalogProductVersions.id, workshopRow!.currentVersionId!));

    // Accept automatic bundle_completion -> adds Packet 3 Basic and unlocks 10% bundle discount!
    const completedBundle = await aliceCaller.cart.upsell.accept({
      offerPublicId: BUNDLE_COMPLETION_OFFER_KEY,
      idempotencyKey: "idem-accept-bundle-01",
    });
    expect(completedBundle.totals.bundle?.applied).toBe(true);
    // $350 + $300 + $400 = $1,050; 10% bundle = $105 -> $945.00
    expect(completedBundle.totals.subtotalMinor).toBe(1050_00);
    expect(completedBundle.totals.discountMinor).toBe(105_00);
    expect(completedBundle.totals.totalMinor).toBe(945_00);
  });

  it("applies, encrypts, re-evaluates, and removes promo codes without ever logging raw codes, and blocks checkout on stale codes until new total is confirmed", async () => {
    const aliceCaller = callerFor(alice.principal);

    const save25Id = ulid();
    promosFake.defs.set("SECRET25", {
      promoPublicId: save25Id,
      code: "SECRET25",
      label: "Partner 25% Off",
      percentOff: 25,
      minSubtotalMinor: 400_00,
      maxRedemptions: 1,
      redeemedCount: 0,
      active: true,
    });

    await aliceCaller.cart.addItems({
      items: [
        { productPublicId: p1Basic, quantity: 1 }, // $200
        { productPublicId: p2Basic, quantity: 1 }, // $300 -> $500 subtotal
      ],
    });

    // When promotions feature is disabled, applyCode returns uniform PROMO_NOT_APPLICABLE.
    promosFake.enabled = false;
    await expect(aliceCaller.cart.applyCode({ code: "SECRET25" })).rejects.toSatisfy(
      (err) => extractCodes(err).reasonCode === "PROMO_NOT_APPLICABLE",
    );
    promosFake.enabled = true;

    // Apply code + replay with same idempotencyKey -> 1 preview entry call!
    const withPromo = await aliceCaller.cart.applyCode({
      code: "  secret25 ",
      idempotencyKey: "idem-apply-secret25",
    });
    const replayPromo = await aliceCaller.cart.applyCode({
      code: "secret25",
      idempotencyKey: "idem-apply-secret25",
    });

    expect(promosFake.entryPreviewCalls).toBe(1);
    expect(withPromo.totals.promo?.label).toBe("Partner 25% Off");
    expect(withPromo.totals.promo?.promoDiscountMinor).toBe(125_00);
    expect(withPromo.totals.totalMinor).toBe(375_00);
    expect(replayPromo.version).toBe(withPromo.version);

    // Reusing the same idempotencyKey with a DIFFERENT code is rejected with CONFLICT:IDEMPOTENCY_KEY_REUSED!
    await expect(
      aliceCaller.cart.applyCode({
        code: "OTHER99",
        idempotencyKey: "idem-apply-secret25",
      }),
    ).rejects.toSatisfy((err) => extractCodes(err).reasonCode === "IDEMPOTENCY_KEY_REUSED");

    // Ciphertext check: DB row NEVER contains raw code "secret25" / "SECRET25".
    const [rawCartRow] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, withPromo.cartPublicId!));
    expect(rawCartRow?.appliedPromoCodeEnc).toBeTruthy();
    expect(rawCartRow?.appliedPromoCodeEnc?.toLowerCase()).not.toContain("secret25");
    expect(rawCartRow?.appliedPromoPublicId).toBe(save25Id);

    // Audit & log check: raw code NEVER appears in any audit event or log entry!
    const serializedAudit = JSON.stringify(h.audit.events).toLowerCase();
    const serializedLogs = JSON.stringify(capturedLogs).toLowerCase();
    expect(serializedAudit).not.toContain("secret25");
    expect(serializedLogs).not.toContain("secret25");

    // Removing Packet 2 drops subtotal to $200 (< $400 minSubtotalMinor) -> passive recheck uses `recheck: true`
    // (does NOT increment failedEntryGuesses!) and surfaces PROMO_MIN_SUBTOTAL notice + undiscounted $200 total!
    const p2Item = withPromo.items.find((i) => i.packetNumber === 2)!;
    const belowMin = await aliceCaller.cart.removeItem({
      itemPublicId: p2Item.itemPublicId,
      expectedVersion: withPromo.version,
    });
    expect(belowMin.totals.promo).toBeNull();
    expect(belowMin.totals.totalMinor).toBe(200_00);
    expect(belowMin.promoNotice?.reasonCode).toBe("PROMO_MIN_SUBTOTAL");
    expect(promosFake.failedEntryGuesses).toBe(0);

    // Re-adding Packet 2 restores subtotal to $500 -> promo automatically applies again ($375)!
    const restoredPromo = await aliceCaller.cart.addItems({
      items: [{ productPublicId: p2Basic, quantity: 1 }],
    });
    expect(restoredPromo.totals.promo?.promoDiscountMinor).toBe(125_00);
    expect(restoredPromo.totals.totalMinor).toBe(375_00);

    // CRITICAL D3 RULE: Code stops being valid (exhausted/paused) between applying and placing the order!
    promosFake.defs.get("SECRET25")!.redeemedCount = 1; // exhausted!

    await expect(
      aliceCaller.cart.checkout({
        cartPublicId: restoredPromo.cartPublicId!,
        expectedVersion: restoredPromo.version,
        expectedTotalMinor: 375_00,
        projectName: "Alice Stale Promo Test",
        note: "",
        billing: sampleBilling,
        policyAcceptances: [
          {
            versionPublicId: publishedPolicyVersionId,
            contentHash: publishedPolicyHash,
          },
        ],
        idempotencyKey: "idem-checkout-stale-promo-01",
      }),
    ).rejects.toSatisfy((err) => {
      const c = extractCodes(err);
      const details = c.details as { newTotalMinor?: number; cartVersion?: number } | undefined;
      return (
        c.trpcCode === "CONFLICT" &&
        c.reasonCode === "PROMO_RECONFIRM_TOTAL" &&
        details?.newTotalMinor === 500_00
      );
    });

    // Verify ZERO orders were placed when promo failed at checkout!
    const ordersAfterRefusal = await t.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.ownerUserId, alice.id));
    expect(ordersAfterRefusal).toHaveLength(0);

    // Refreshed cart has the dead code cleared and shows the new $500.00 total ready for confirmation!
    const refreshedCart = await aliceCaller.cart.get();
    expect(refreshedCart.totals.promo).toBeNull();
    expect(refreshedCart.totals.totalMinor).toBe(500_00);

    // Customer confirms the new $500.00 total -> order & invoice are created cleanly!
    const placed = await aliceCaller.cart.checkout({
      cartPublicId: refreshedCart.cartPublicId!,
      expectedVersion: refreshedCart.version,
      expectedTotalMinor: 500_00,
      projectName: "Alice Confirmed New Total",
      note: "",
      billing: sampleBilling,
      policyAcceptances: [
        {
          versionPublicId: publishedPolicyVersionId,
          contentHash: publishedPolicyHash,
        },
      ],
      idempotencyKey: "idem-checkout-confirmed-02",
    });
    expect(placed.totalMinor).toBe(500_00);

    // Now test happy-path checkout WITH a valid promo code!
    const validPromoId = ulid();
    promosFake.defs.set("LAUNCH20", {
      promoPublicId: validPromoId,
      code: "LAUNCH20",
      label: "Launch 20% Off",
      percentOff: 20,
      minSubtotalMinor: 100_00,
      maxRedemptions: 5,
      redeemedCount: 0,
      active: true,
    });

    await aliceCaller.cart.addItems({ items: [{ productPublicId: p2Basic, quantity: 1 }] });
    const cartWithLaunch = await aliceCaller.cart.applyCode({ code: "LAUNCH20" });
    expect(cartWithLaunch.totals.totalMinor).toBe(240_00);

    const discountedCheckout = await aliceCaller.cart.checkout({
      cartPublicId: cartWithLaunch.cartPublicId!,
      expectedVersion: cartWithLaunch.version,
      expectedTotalMinor: 240_00,
      projectName: "Alice Discounted Order",
      note: "",
      billing: sampleBilling,
      policyAcceptances: [],
      idempotencyKey: "idem-checkout-valid-promo-03",
    });
    expect(discountedCheckout.totalMinor).toBe(240_00);

    const status = await aliceCaller.cart.checkoutStatus({ cartPublicId: cartWithLaunch.cartPublicId! });
    expect(status.discountMinor).toBe(60_00);
    expect(status.promoDiscountMinor).toBe(60_00);
    expect(status.promoLabel).toBe("Launch 20% Off");
    expect(status.totalMinor).toBe(240_00);

    // Post-checkout cart row wipes `applied_promo_code_enc` ciphertext.
    const [checkedOutRow] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, cartWithLaunch.cartPublicId!));
    expect(checkedOutRow?.appliedPromoCodeEnc).toBeNull();
    expect(checkedOutRow?.checkedOutPromoDiscountMinor).toBe(60_00);
    expect(checkedOutRow?.checkedOutPromoLabel).toBe("Launch 20% Off");
  });

  it("executes acceptUpsell and applyCode on a connectionLimit: 1 MySQL pool without taking a second connection inside tx", async () => {
    const singlePool = mysql.createPool({
      uri: t.url,
      connectionLimit: 1,
      timezone: "Z",
      supportBigNumbers: true,
      charset: "utf8mb4",
    });
    try {
      const singleDb = drizzle(singlePool, { mode: "default" }) as unknown as Db;
      const singleHarness = createTestDeps({ db: singleDb });
      singleHarness.settings.flags.add(CART_FEATURE_FLAG.flag);
      singleHarness.settings.flags.add(CART_UPSELL_FEATURE_FLAG.flag);
      await singleHarness.settings.set("orders.bundle_rule", {
        enabled: true,
        requiredPacketNumbers: [1, 2, 3],
        discountPercent: 10,
        label: "Full 3-Packet Bundle (10% off)",
      });

      const singleOrders = createOrdersModule(singleHarness.deps);
      const singleCompliance = createComplianceModule(singleHarness.deps);
      const singleCart = createCartModule(singleHarness.deps);

      singleHarness.services.identity = fakeIdentity(singleHarness, singleDb) as unknown as Services["identity"];
      singleHarness.services.files = new FakeFiles() as unknown as Services["files"];
      singleHarness.services.engagement = new FakeEngagement() as unknown as Services["engagement"];
      singleHarness.services.orders = singleOrders;
      singleHarness.services.compliance = singleCompliance;
      singleHarness.services.payments = new SimpleInvoicePayments() as unknown as Services["payments"];
      (singleHarness.services as unknown as Record<string, unknown>).promotions = promosFake;
      singleHarness.services.cart = singleCart;

      promosFake.defs.set("POOL1", {
        promoPublicId: ulid(),
        code: "POOL1",
        label: "Single Pool 15% Off",
        percentOff: 15,
        minSubtotalMinor: 100_00,
        maxRedemptions: 5,
        redeemedCount: 0,
        active: true,
      });

      const singleCaller = (principal: SessionPrincipal) =>
        createCaller({
          services: singleHarness.services,
          session: principal,
          request: newRequestContext("test"),
          transport: { issue() {}, clear() {} },
        });

      const offer = await singleCaller(admin.principal).cart.admin.upsells.create({
        kind: "add_on",
        title: "Single-Pool Add-on",
        shortText: "Runs cleanly on 1 DB connection.",
        triggerMode: "any_cart",
        triggerProductPublicIds: [],
        targetProductPublicId: addonWorkshop,
        priority: 1,
        active: true,
      });

      await singleCaller(alice.principal).cart.addItems({
        items: [{ productPublicId: p1Basic, quantity: 1 }],
      });

      const accepted = await singleCaller(alice.principal).cart.upsell.accept({
        offerPublicId: offer.offerPublicId,
        idempotencyKey: "idem-pool1-accept-01",
      });
      expect(accepted.items.some((i) => i.productPublicId === addonWorkshop)).toBe(true);

      const promoApplied = await singleCaller(alice.principal).cart.applyCode({
        code: "POOL1",
        idempotencyKey: "idem-pool1-promo-01",
      });
      expect(promoApplied.totals.promo?.label).toBe("Single Pool 15% Off");
    } finally {
      await singlePool.end();
    }
  });

  it("completes zero-total checkout with a 100% code (guard at 100) as no_payment_due without calling payments.startCheckout, idempotent on replay", async () => {
    const realPromos = createPromotionsModule(h.deps);
    (h.services as unknown as Record<string, unknown>).promotions = realPromos;

    let startCheckoutCalls = 0;
    const stripePaymentsGuard: CartPaymentsPort = {
      async isOnlineCheckoutEnabled() {
        return true;
      },
      async getPublicCheckoutConfig() {
        return { provider: "stripe", mode: "test", currency: "USD" };
      },
      async startCheckout(invoicePublicId: string) {
        startCheckoutCalls += 1;
        const [inv] = await t.db
          .select()
          .from(complianceTables.complianceInvoices)
          .where(eq(complianceTables.complianceInvoices.publicId, invoicePublicId))
          .limit(1);
        if (inv?.status === "paid") {
          throw new DomainError("CONFLICT", "INVOICE_ALREADY_PAID", "This invoice is already paid.");
        }
        return {
          mode: "redirect",
          attemptPublicId: ulid(),
          invoicePublicId,
          provider: "stripe",
          environment: "test",
          redirectUrl: "https://checkout.stripe.com/c/pay/cs_test_unused",
          expiresAt: null,
        };
      },
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
          providerConfigured: "stripe",
          environment: "test",
          attempt: null,
        };
      },
      async cancelAttemptIfUnpaid() {
        return { cancelled: false, attemptPublicId: null, status: null };
      },
    };
    const prevPayments = h.services.payments;
    h.services.payments = stripePaymentsGuard as unknown as Services["payments"];

    try {
      h.settings.flags.add("promotions");
      await realPromos.admin.updateSettings(admin.principal, {
        enabled: true,
        maxDiscountPercent: 100,
      });
      await realPromos.admin.create(admin.principal, {
        name: "100% Executive Comp",
        label: "Complimentary order",
        type: "percent",
        percentBps: 10_000,
        scope: { kind: "all" },
        code: "COMP100FREE",
        maxRedemptions: 5,
        maxPerCustomer: 1,
      });

      const aliceCaller = callerFor(alice.principal);
      await aliceCaller.cart.addItems({
        items: [{ productPublicId: p1Basic, quantity: 1 }],
      });
      const withFreePromo = await aliceCaller.cart.applyCode({
        code: "COMP100FREE",
        idempotencyKey: "idem-comp100-apply-01",
      });
      expect(withFreePromo.totals.subtotalMinor).toBe(200_00);
      expect(withFreePromo.totals.discountMinor).toBe(200_00);
      expect(withFreePromo.totals.totalMinor).toBe(0);

      const sampleBilling: BillingDetailsInput = {
        fullName: "Alice Example",
        company: "Alice Co",
        email: "alice@example.test",
        country: "US",
        region: "NY",
        addressLine1: "100 Main St",
        addressLine2: "",
        city: "New York",
        postalCode: "10001",
        taxId: "",
      };

      const checkoutPayload = {
        cartPublicId: withFreePromo.cartPublicId!,
        expectedVersion: withFreePromo.version,
        expectedTotalMinor: 0,
        projectName: "Zero-Total Comp Project",
        note: "100% covered",
        billing: sampleBilling,
        policyAcceptances: [
          {
            versionPublicId: publishedPolicyVersionId,
            contentHash: publishedPolicyHash,
          },
        ],
        idempotencyKey: "idem-comp100-checkout-01",
      };

      const firstRes = await aliceCaller.cart.checkout(checkoutPayload);
      expect(firstRes).toMatchObject({
        mode: "no_payment_due",
        cartPublicId: withFreePromo.cartPublicId,
        currency: "USD",
        totalMinor: 0,
      });
      expect(startCheckoutCalls).toBe(0);

      // Idempotent replay with the same idempotencyKey returns the exact same result without extra audits or provider calls.
      const replayRes = await aliceCaller.cart.checkout(checkoutPayload);
      expect(replayRes).toEqual(firstRes);
      expect(startCheckoutCalls).toBe(0);

      const [storedCart] = await t.db
        .select()
        .from(cartTables.carts)
        .where(eq(cartTables.carts.publicId, withFreePromo.cartPublicId!));
      expect(storedCart?.status).toBe("checked_out");
      expect(storedCart?.paymentMode).toBeNull();
      expect(storedCart?.paymentAttemptPublicId).toBeNull();
      expect(storedCart?.checkedOutTotalMinor).toBe(0);

      const checkedOutEvents = h.audit.events.filter(
        (ev) => ev.eventName === "cart.checked_out" && ev.resource?.publicId === withFreePromo.cartPublicId,
      );
      expect(checkedOutEvents).toHaveLength(1);
      expect(checkedOutEvents[0]?.attributes).toMatchObject({
        payment_mode: "no_payment_due",
        total_minor: 0,
        promo_discount_minor: 200_00,
      });

      const statusRes = await aliceCaller.cart.checkoutStatus({
        cartPublicId: withFreePromo.cartPublicId!,
      });
      expect(statusRes.confirmationState).toBe("no_payment_due");
      expect(statusRes.paymentMode).toBe("no_payment_due");
      expect(statusRes.invoiceStatus).toBe("paid");
      expect(statusRes.totalMinor).toBe(0);
      expect(statusRes.balanceDueMinor).toBe(0);
      expect(statusRes.canRestoreToCart).toBe(false);

      await expect(
        aliceCaller.cart.restoreCheckout({ cartPublicId: withFreePromo.cartPublicId! }),
      ).rejects.toSatisfy((err) => extractCodes(err).reasonCode === "CHECKOUT_ALREADY_PAID");
    } finally {
      h.settings.flags.delete("promotions");
      h.services.payments = prevPayments;
    }
  });
});
