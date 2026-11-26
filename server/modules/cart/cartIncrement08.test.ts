/**
 * Increment 08 — Cart & Checkout integration tests:
 *  - D3: Add packets to an existing project (`carts.add_to_order_public_id`, `cart.setTarget`,
 *        duplicate-packet & foreign-order protections, upsell exclusion of target project packets,
 *        and `orders -> users -> user_sessions -> carts` root-lock ordering in `cart.checkout`).
 *  - D4: Shared `billingDetailsSchema` re-export, `billingSource: "saved" | "custom"`, and
 *        transactional `"Save as my billing information"` (`saveAsBillingProfile`) via `billingProfile`.
 *
 * Synthetic fixtures only (`Zeus Greene`, `RPCUS-A1B2CJJG5`, project `Ice Queen`).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingDetailsSchema as sharedBillingDetailsSchema } from "../../../shared/billingDetails.js";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { Services } from "../../container.js";
import type { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { createBillingProfileModule, type BillingProfileModule } from "../billingProfile/index.js";
import * as billingProfileTables from "../billingProfile/schema.js";
import { createComplianceModule } from "../compliance/index.js";
import * as complianceTables from "../compliance/schema.js";
import { users } from "../identity/schema.js";
import { createOrdersModule, type OrdersModule } from "../orders/index.js";
import * as orderTables from "../orders/schema.js";
import { FakeEngagement, FakeFiles, fakeIdentity, insertUser, type TestUser } from "../orders/testSupport.js";
import * as paymentsTables from "../payments/schema.js";
import { createPromotionsModule } from "../promotions/index.js";
import * as promotionsTables from "../promotions/schema.js";
import {
  billingDetailsSchema as cartBillingDetailsSchema,
  createCartModule,
  type BillingDetailsInput,
  type CartModule,
} from "./index.js";
import type { CartCheckoutAmountEvaluation, CartPaymentsPort } from "./ports.js";
import * as cartTables from "./schema.js";
import { CART_FEATURE_FLAG, CART_UPSELL_FEATURE_FLAG } from "./settings.js";
import { checkoutInputSchema } from "./types.js";

const testSchema = {
  users,
  ...orderTables,
  ...complianceTables,
  ...billingProfileTables,
  ...promotionsTables,
  ...paymentsTables,
  ...cartTables,
};

const ZEUS_SAVED_BILLING: BillingDetailsInput = {
  fullName: "Zeus Greene",
  company: "Ice Queen Studio",
  email: "zeus.greene@example.test",
  country: "US",
  addressLine1: "400 Glacier Way",
  addressLine2: "Suite 8",
  city: "Austin",
  region: "TX",
  postalCode: "78701",
  taxId: "",
};

const ONE_OFF_BILLING: BillingDetailsInput = {
  fullName: "Zeus Greene",
  company: "One-Off Subsidiary",
  email: "zeus.oneoff@example.test",
  country: "CA",
  addressLine1: "88 Northern Blvd",
  addressLine2: "",
  city: "Toronto",
  region: "ON",
  postalCode: "M5V 2T6",
  taxId: "",
};

class SimpleInvoicePaymentsFake implements CartPaymentsPort {
  readonly supportsSettledReceipts = true;

  async isOnlineCheckoutEnabled(_tx?: DbOrTx) {
    return false;
  }

  async getPublicCheckoutConfig(_tx?: DbOrTx) {
    return { provider: "none" as const, mode: "test" as const, currency: "USD" };
  }

  async evaluateCheckoutAmount(amountMinor: number): Promise<CartCheckoutAmountEvaluation> {
    return {
      onlineEnabled: false,
      provider: "none",
      minimumMinor: 0,
      belowMinimum: false,
      smallTotalAction: amountMinor === 0 ? "zero_total" : "none",
    };
  }

  async startCheckout(invoicePublicId: string) {
    return {
      mode: "invoice" as const,
      invoicePublicId,
    };
  }

  async getCheckoutStatus(_principal: SessionPrincipal, input: { invoicePublicId?: string }) {
    return {
      providerConfigured: "none" as const,
      environment: "test" as const,
      invoicePublicId: input.invoicePublicId ?? "",
      invoiceNumber: "INV-INC08",
      invoiceStatus: "issued" as const,
      currency: "USD",
      amountMinor: 5000,
      waivedMinor: 0,
      balanceDueMinor: 5000,
      receiptPublicId: null,
      attempt: null,
    };
  }

  async cancelAttemptIfUnpaid(
    _principal: SessionPrincipal,
    input: { invoicePublicId: string; attemptPublicId?: string },
    _tx?: Tx,
  ) {
    return { cancelled: true, attemptPublicId: input.attemptPublicId ?? null, status: "cancelled" as const };
  }
}

let t: TestDb;
let h: TestHarness;
let ordersMod: OrdersModule;
let billingProfileMod: BillingProfileModule;
let cartMod: CartModule;
let callTrace: string[];
let afterLockAddOnRootHook: (() => Promise<void>) | null = null;
let admin: TestUser;
let zeus: TestUser;
let otherBuyer: TestUser;
let packet1ProductId: string;
let packet2ProductId: string;
let packet3ProductId: string;

beforeAll(async () => {
  t = await createTestDb({ schema: testSchema });
  h = createTestDeps({ db: t.db });
  callTrace = [];

  const rawOrdersMod = createOrdersModule(h.deps);
  const origLockAddOnRoot = rawOrdersMod.lockAddOnRootInTx.bind(rawOrdersMod);
  ordersMod = {
    ...rawOrdersMod,
    async lockAddOnRootInTx(tx, ownerUserId, orderPublicId) {
      callTrace.push("orders.lockAddOnRootInTx");
      const res = await origLockAddOnRoot(tx, ownerUserId, orderPublicId);
      // Ensure `tx`'s InnoDB REPEATABLE READ consistent snapshot is open before `users` FOR UPDATE:
      await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).limit(1);
      if (afterLockAddOnRootHook) {
        const hook = afterLockAddOnRootHook;
        afterLockAddOnRootHook = null;
        await hook();
      }
      return res;
    },
  };

  const complianceMod = createComplianceModule(h.deps);
  billingProfileMod = createBillingProfileModule(h.deps);
  const promotionsMod = createPromotionsModule(h.deps);
  const paymentsFake = new SimpleInvoicePaymentsFake();

  const rawIdentity = fakeIdentity(h, t.db);
  const origAssertCurrent = rawIdentity.sessions.assertCurrent.bind(rawIdentity.sessions);
  const tracedIdentity = {
    ...rawIdentity,
    sessions: {
      ...rawIdentity.sessions,
      async assertCurrent(...args: Parameters<typeof origAssertCurrent>) {
        callTrace.push("identity.sessions.assertCurrent");
        return origAssertCurrent(...args);
      },
    },
  };

  h.services.orders = ordersMod;
  h.services.compliance = complianceMod;
  h.services.billingProfile = billingProfileMod;
  h.services.promotions = promotionsMod;
  h.services.payments = paymentsFake as unknown as Services["payments"];
  h.services.identity = tracedIdentity as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];

  cartMod = createCartModule(h.deps);
  h.services.cart = cartMod;

  rawOrdersMod.init?.();
  complianceMod.init?.();
  billingProfileMod.init?.();
  promotionsMod.init?.();
  cartMod.init();

  h.settings.flags.add(CART_FEATURE_FLAG.flag);
  h.settings.flags.add(CART_UPSELL_FEATURE_FLAG.flag);

  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  zeus = await insertUser(h, t.db, { role: "customer" });
  await t.db.update(users).set({ customerRef: "RPCUS-A1B2CJJG5" }).where(eq(users.id, zeus.id));
  otherBuyer = await insertUser(h, t.db, { role: "customer" });

  const g1 = await ordersMod.catalog.createGroup(admin.principal, {
    name: "Packet 1 — Strategy",
    description: "",
    packetNumber: 1,
    sortOrder: 1,
    active: true,
  });
  const g2 = await ordersMod.catalog.createGroup(admin.principal, {
    name: "Packet 2 — Architecture",
    description: "",
    packetNumber: 2,
    sortOrder: 2,
    active: true,
  });
  const g3 = await ordersMod.catalog.createGroup(admin.principal, {
    name: "Packet 3 — Delivery",
    description: "",
    packetNumber: 3,
    sortOrder: 3,
    active: true,
  });
  const p1 = await ordersMod.catalog.createProduct(admin.principal, {
    groupId: g1.publicId,
    productKey: "inc08-packet-1-basic",
    packetNumber: 1,
    tier: "Basic",
    sortOrder: 1,
    active: true,
    name: "Packet 1 — Basic",
    description: "",
    priceMinor: 5000,
    currency: "USD",
    features: [],
  });
  const p2 = await ordersMod.catalog.createProduct(admin.principal, {
    groupId: g2.publicId,
    productKey: "inc08-packet-2-basic",
    packetNumber: 2,
    tier: "Basic",
    sortOrder: 1,
    active: true,
    name: "Packet 2 — Basic",
    description: "",
    priceMinor: 6000,
    currency: "USD",
    features: [],
  });
  const p3 = await ordersMod.catalog.createProduct(admin.principal, {
    groupId: g3.publicId,
    productKey: "inc08-packet-3-basic",
    packetNumber: 3,
    tier: "Basic",
    sortOrder: 1,
    active: true,
    name: "Packet 3 — Basic",
    description: "",
    priceMinor: 7000,
    currency: "USD",
    features: [],
  });
  packet1ProductId = p1.publicId;
  packet2ProductId = p2.publicId;
  packet3ProductId = p3.publicId;

  // Create an upsell suggesting Packet 1 so we can verify add-on carts exclude packets already in the target project.
  await cartMod.adminCreateUpsellOffer(admin.principal, {
    kind: "add_on",
    ruleType: "standard",
    title: "Add Packet 1",
    shortText: "Start from the foundation packet.",
    triggerMode: "any_cart",
    triggerProductPublicIds: [],
    targetProductPublicId: packet1ProductId,
    priority: 10,
    active: true,
    startsAt: null,
    endsAt: null,
  });
});

afterAll(async () => {
  await t?.cleanup();
});

describe("Increment 08 — D4 shared billing schema re-export", () => {
  it("re-exports shared/billingDetails.ts directly with identical normalization", () => {
    expect(cartBillingDetailsSchema).toBe(sharedBillingDetailsSchema);
    const parsed = cartBillingDetailsSchema.parse({
      fullName: "  Zeus Greene  ",
      company: "  Ice Queen  ",
      email: "  ZEUS@Example.Test ",
      country: " us ",
      addressLine1: " 400 Glacier Way ",
      addressLine2: "",
      city: " Austin ",
      region: " TX ",
      postalCode: " 78701 ",
      taxId: "",
    });
    expect(parsed.fullName).toBe("Zeus Greene");
    expect(parsed.email).toBe("ZEUS@Example.Test");
    expect(parsed.country).toBe("US");
  });
});

describe("Increment 08 — D4 saved billing profile vs custom billing at checkout", () => {
  it("enforces mandatory CAS generation tokens on billingSource='saved' and saveAsBillingProfile=true while keeping plain custom checkout unchanged", () => {
    const base = {
      cartPublicId: ulid(),
      expectedVersion: 1,
      policyAcceptances: [],
      idempotencyKey: "idem-schema-cas-check",
    };

    // Legacy plain custom checkout (no billingSource / saveAsBillingProfile=false) requires no CAS tokens.
    expect(
      checkoutInputSchema.safeParse({
        ...base,
        billing: ZEUS_SAVED_BILLING,
      }).success,
    ).toBe(true);
    expect(
      checkoutInputSchema.safeParse({
        ...base,
        billingSource: "custom",
        billing: ZEUS_SAVED_BILLING,
        saveAsBillingProfile: false,
      }).success,
    ).toBe(true);

    // `billingSource: "saved"` requires BOTH `savedBillingVersion >= 1` AND `savedBillingPublicId`.
    expect(
      checkoutInputSchema.safeParse({
        ...base,
        billingSource: "saved",
      }).success,
    ).toBe(false);
    expect(
      checkoutInputSchema.safeParse({
        ...base,
        billingSource: "saved",
        savedBillingVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      checkoutInputSchema.safeParse({
        ...base,
        billingSource: "saved",
        savedBillingPublicId: ulid(),
      }).success,
    ).toBe(false);
    expect(
      checkoutInputSchema.safeParse({
        ...base,
        billingSource: "saved",
        savedBillingPublicId: ulid(),
        savedBillingVersion: 1,
      }).success,
    ).toBe(true);

    // `saveAsBillingProfile: true` requires either `savedBillingVersion: 0` (sentinel) or `version >= 1` + `publicId`.
    expect(
      checkoutInputSchema.safeParse({
        ...base,
        billingSource: "custom",
        billing: ZEUS_SAVED_BILLING,
        saveAsBillingProfile: true,
      }).success,
    ).toBe(false);
    expect(
      checkoutInputSchema.safeParse({
        ...base,
        billingSource: "custom",
        billing: ZEUS_SAVED_BILLING,
        saveAsBillingProfile: true,
        savedBillingVersion: 0,
      }).success,
    ).toBe(true);
    expect(
      checkoutInputSchema.safeParse({
        ...base,
        billingSource: "custom",
        billing: ZEUS_SAVED_BILLING,
        saveAsBillingProfile: true,
        savedBillingVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      checkoutInputSchema.safeParse({
        ...base,
        billingSource: "custom",
        billing: ZEUS_SAVED_BILLING,
        saveAsBillingProfile: true,
        savedBillingPublicId: ulid(),
        savedBillingVersion: 2,
      }).success,
    ).toBe(true);
  });

  it("rejects billingSource='saved' with SAVED_BILLING_NOT_FOUND when customer has no saved profile", async () => {
    const afterAdd = await cartMod.addItems(zeus.principal, {
      items: [{ productPublicId: packet1ProductId, quantity: 1 }],
      projectName: "Ice Queen",
    });

    await expect(
      cartMod.checkout(zeus.principal, {
        cartPublicId: afterAdd.cartPublicId!,
        expectedVersion: afterAdd.version,
        billingSource: "saved",
        savedBillingPublicId: ulid(),
        savedBillingVersion: 1,
        policyAcceptances: [],
        idempotencyKey: `idem-nosaved-${ulid()}`,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "SAVED_BILLING_NOT_FOUND",
    } satisfies Partial<DomainError>);

    // Cart remains open and ready to complete checkout.
    const stillOpen = await cartMod.getMyCart(zeus.principal);
    expect(stillOpen.cartPublicId).toBe(afterAdd.cartPublicId);
    expect(stillOpen.itemCount).toBe(1);
  });

  it("saves custom billing profile when saveAsBillingProfile=true, then uses saved profile on next checkout and preserves it on one-off custom checkout", async () => {
    const open = await cartMod.getMyCart(zeus.principal);
    const firstCheckout = await cartMod.checkout(zeus.principal, {
      cartPublicId: open.cartPublicId!,
      expectedVersion: open.version,
      projectName: "Ice Queen",
      billingSource: "custom",
      billing: ZEUS_SAVED_BILLING,
      saveAsBillingProfile: true,
      savedBillingVersion: 0,
      policyAcceptances: [],
      idempotencyKey: `idem-save-profile-${ulid()}`,
    });
    expect(firstCheckout.mode).toBe("invoice");

    // Saved profile is persisted for Zeus Greene.
    const savedAfterFirst = await billingProfileMod.get(zeus.principal);
    expect(savedAfterFirst).not.toBeNull();
    expect(savedAfterFirst?.details.company).toBe("Ice Queen Studio");
    expect(savedAfterFirst?.details.country).toBe("US");

    // Second checkout uses `billingSource: "saved"` with generation tuple without sending `billing`.
    const secondCart = await cartMod.addItems(zeus.principal, {
      items: [{ productPublicId: packet2ProductId, quantity: 1 }],
      projectName: "Glacier Ridge",
    });
    const secondCheckout = await cartMod.checkout(zeus.principal, {
      cartPublicId: secondCart.cartPublicId!,
      expectedVersion: secondCart.version,
      projectName: "Glacier Ridge",
      billingSource: "saved",
      savedBillingPublicId: savedAfterFirst!.publicId,
      savedBillingVersion: savedAfterFirst!.version,
      policyAcceptances: [],
      idempotencyKey: `idem-use-saved-${ulid()}`,
    });
    expect(secondCheckout.mode).toBe("invoice");

    const [secondCartRow] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, secondCart.cartPublicId!));
    expect(secondCartRow?.billingCountry).toBe("US");
    expect(secondCartRow?.billingRegion).toBe("TX");

    // Third checkout uses `billingSource: "custom"` with `saveAsBillingProfile: false` -> one-off billing used, saved profile untouched.
    const thirdCart = await cartMod.addItems(zeus.principal, {
      items: [{ productPublicId: packet3ProductId, quantity: 1 }],
      projectName: "Northern Annex",
    });
    const thirdCheckout = await cartMod.checkout(zeus.principal, {
      cartPublicId: thirdCart.cartPublicId!,
      expectedVersion: thirdCart.version,
      projectName: "Northern Annex",
      billingSource: "custom",
      billing: ONE_OFF_BILLING,
      saveAsBillingProfile: false,
      policyAcceptances: [],
      idempotencyKey: `idem-one-off-${ulid()}`,
    });
    expect(thirdCheckout.mode).toBe("invoice");

    const [thirdCartRow] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, thirdCart.cartPublicId!));
    expect(thirdCartRow?.billingCountry).toBe("CA");
    expect(thirdCartRow?.billingRegion).toBe("ON");

    const savedStillIntact = await billingProfileMod.get(zeus.principal);
    expect(savedStillIntact?.details.company).toBe("Ice Queen Studio");
    expect(savedStillIntact?.details.country).toBe("US");

    // Generation-drift protections (D4 concurrency):
    // 1. Stale `savedBillingVersion` on `billingSource: "saved"` is rejected with `SAVED_BILLING_CHANGED`.
    const driftCart = await cartMod.addItems(zeus.principal, {
      items: [{ productPublicId: packet1ProductId, quantity: 1 }],
      projectName: "Drift Check",
      addToOrderPublicId: null,
    });
    await expect(
      cartMod.checkout(zeus.principal, {
        cartPublicId: driftCart.cartPublicId!,
        expectedVersion: driftCart.version,
        projectName: "Drift Check",
        billingSource: "saved",
        savedBillingPublicId: savedStillIntact!.publicId,
        savedBillingVersion: savedStillIntact!.version + 1,
        policyAcceptances: [],
        idempotencyKey: `idem-stale-saved-${ulid()}`,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "SAVED_BILLING_CHANGED",
    } satisfies Partial<DomainError>);

    // 2. Auto-checked save from a no-profile state (`savedBillingVersion: 0`) refuses to overwrite an existing profile.
    await expect(
      cartMod.checkout(zeus.principal, {
        cartPublicId: driftCart.cartPublicId!,
        expectedVersion: driftCart.version,
        projectName: "Drift Check",
        billingSource: "custom",
        billing: ONE_OFF_BILLING,
        saveAsBillingProfile: true,
        savedBillingVersion: 0,
        policyAcceptances: [],
        idempotencyKey: `idem-stale-zero-${ulid()}`,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "SAVED_BILLING_CHANGED",
    } satisfies Partial<DomainError>);

    // Clean up open cart before next suite.
    await cartMod.clearCart(zeus.principal, { expectedVersion: driftCart.version });
  });
});

describe("Increment 08 — D3 add-to-existing-order cart & checkout flow", () => {
  let iceQueenRootOrderPublicId: string;

  it("sets addToOrderPublicId, excludes owned packets from upsells, rejects duplicate/foreign targets, and locks root order before actorCheck at checkout", async () => {
    const savedProfile = (await billingProfileMod.get(zeus.principal))!;
    // Create a clean root order on "Ice Queen" with Packet 1.
    const rootCart = await cartMod.addItems(zeus.principal, {
      items: [{ productPublicId: packet1ProductId, quantity: 1 }],
      projectName: "Ice Queen",
      addToOrderPublicId: null,
    });
    const rootCheckout = await cartMod.checkout(zeus.principal, {
      cartPublicId: rootCart.cartPublicId!,
      expectedVersion: rootCart.version,
      projectName: "Ice Queen",
      billingSource: "saved",
      savedBillingPublicId: savedProfile.publicId,
      savedBillingVersion: savedProfile.version,
      policyAcceptances: [],
      idempotencyKey: `idem-root-iq-${ulid()}`,
    });
    iceQueenRootOrderPublicId = rootCheckout.orderPublicId;

    // Foreign customer cannot attach to Zeus's order — indistinguishable NOT_FOUND + authz.cart.denied.
    await expect(
      cartMod.addItems(otherBuyer.principal, {
        items: [{ productPublicId: packet2ProductId, quantity: 1 }],
        addToOrderPublicId: iceQueenRootOrderPublicId,
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      reasonCode: "ORDER_NOT_FOUND",
    } satisfies Partial<DomainError>);
    expect(
      h.audit.events.some(
        (ev) => ev.eventName === "authz.cart.denied" && ev.reasonCode === "ADD_ON_TARGET_NOT_AUTHORIZED",
      ),
    ).toBe(true);

    // Zeus adds Packet 2 targeting "Ice Queen" (even if client passes a stale projectName, root project name wins).
    const addOnCart = await cartMod.addItems(zeus.principal, {
      items: [{ productPublicId: packet2ProductId, quantity: 1 }],
      projectName: "Ignored Client Name",
      addToOrderPublicId: iceQueenRootOrderPublicId,
    });
    expect(addOnCart.projectName).toBe("Ice Queen");
    expect(addOnCart.addToOrder).toMatchObject({
      orderPublicId: iceQueenRootOrderPublicId,
      rootPublicId: iceQueenRootOrderPublicId,
      projectName: "Ice Queen",
      packetNumbers: [1],
      targetAvailable: true,
      conflictingItemPublicIds: [],
      currencyMismatch: false,
    });

    // Upsell suggesting Packet 1 is suppressed because Packet 1 is already in "Ice Queen".
    expect(addOnCart.upsells.some((u) => u.targetProducts.some((tp) => tp.packetNumber === 1))).toBe(false);

    // Adding Packet 1 (already in "Ice Queen") is rejected with PACKET_ALREADY_IN_PROJECT.
    await expect(
      cartMod.addItems(zeus.principal, {
        items: [{ productPublicId: packet1ProductId, quantity: 1 }],
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "PACKET_ALREADY_IN_PROJECT",
    } satisfies Partial<DomainError>);

    // Forced InnoDB REPEATABLE READ overlap around `users` lock:
    // After D3 `lockAddOnRootInTx` opens `tx`'s RR consistent snapshot at `savedProfile.version` (before `users FOR UPDATE`),
    // a concurrent `billingProfile.save` commits `version + 1` right before `cart.checkout` acquires `users FOR UPDATE`.
    // `getForUserInTx(..., { forUpdate: true })` performs a current locking read and catches `SAVED_BILLING_CHANGED`.
    afterLockAddOnRootHook = async () => {
      await billingProfileMod.save(zeus.principal, {
        details: {
          ...ZEUS_SAVED_BILLING,
          addressLine1: "401 Glacier Way",
        },
        expectedPublicId: savedProfile.publicId,
        expectedVersion: savedProfile.version,
      });
    };
    await expect(
      cartMod.checkout(zeus.principal, {
        cartPublicId: addOnCart.cartPublicId!,
        expectedVersion: addOnCart.version,
        billingSource: "saved",
        savedBillingPublicId: savedProfile.publicId,
        savedBillingVersion: savedProfile.version,
        policyAcceptances: [],
        idempotencyKey: `idem-rr-overlap-${ulid()}`,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "SAVED_BILLING_CHANGED",
    } satisfies Partial<DomainError>);

    const refreshedProfile = (await billingProfileMod.get(zeus.principal))!;
    expect(refreshedProfile.version).toBe(savedProfile.version + 1);

    // Checkout locks group root (`orders.lockAddOnRootInTx`) BEFORE `identity.assertActiveActor` and links child order!
    callTrace.length = 0;
    const childCheckout = await cartMod.checkout(zeus.principal, {
      cartPublicId: addOnCart.cartPublicId!,
      expectedVersion: addOnCart.version,
      billingSource: "saved",
      savedBillingPublicId: refreshedProfile.publicId,
      savedBillingVersion: refreshedProfile.version,
      policyAcceptances: [],
      idempotencyKey: `idem-child-iq-${ulid()}`,
    });
    expect(childCheckout.orderPublicId).not.toBe(iceQueenRootOrderPublicId);

    const lockIdx = callTrace.indexOf("orders.lockAddOnRootInTx");
    const actorIdx = callTrace.indexOf("identity.sessions.assertCurrent");
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(actorIdx).toBeGreaterThan(lockIdx);

    const [rootOrderRow] = await t.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, iceQueenRootOrderPublicId));
    const [childOrderRow] = await t.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, childCheckout.orderPublicId));
    expect(rootOrderRow?.groupRootOrderId).toBeNull();
    expect(childOrderRow?.groupRootOrderId).toBe(rootOrderRow?.id);
    expect(childOrderRow?.projectName).toBe("Ice Queen");
  });

  it("flags existing conflicting items when setTarget attaches an open cart, blocks checkout until resolved, and clears target cleanly", async () => {
    const savedProfile = (await billingProfileMod.get(zeus.principal))!;
    // Zeus adds Packet 1 to a standalone open cart first, then points the cart at "Ice Queen" via `setTarget`.
    await cartMod.addItems(zeus.principal, {
      items: [{ productPublicId: packet1ProductId, quantity: 1 }],
      projectName: "Standalone Draft",
      addToOrderPublicId: null,
    });
    const retargeted = await cartMod.setTarget(zeus.principal, {
      addToOrderPublicId: iceQueenRootOrderPublicId,
    });
    expect(retargeted.addToOrder?.rootPublicId).toBe(iceQueenRootOrderPublicId);
    expect(retargeted.items[0]?.alreadyInTargetProject).toBe(true);
    expect(retargeted.addToOrder?.conflictingItemPublicIds).toHaveLength(1);

    // Server refuses checkout while conflicting item remains.
    await expect(
      cartMod.checkout(zeus.principal, {
        cartPublicId: retargeted.cartPublicId!,
        expectedVersion: retargeted.version,
        billingSource: "saved",
        savedBillingPublicId: savedProfile.publicId,
        savedBillingVersion: savedProfile.version,
        policyAcceptances: [],
        idempotencyKey: `idem-conflict-iq-${ulid()}`,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "PACKET_ALREADY_IN_PROJECT",
    } satisfies Partial<DomainError>);

    // Clearing the target (`addToOrderPublicId: null`) removes the conflict so Zeus can check out a new standalone project.
    const cleared = await cartMod.setTarget(zeus.principal, {
      addToOrderPublicId: null,
      expectedVersion: retargeted.version,
    });
    expect(cleared.addToOrder).toBeNull();
    expect(cleared.items[0]?.alreadyInTargetProject).toBe(false);

    const standaloneCheckout = await cartMod.checkout(zeus.principal, {
      cartPublicId: cleared.cartPublicId!,
      expectedVersion: cleared.version,
      projectName: "Fresh Standalone Project",
      billingSource: "saved",
      savedBillingPublicId: savedProfile.publicId,
      savedBillingVersion: savedProfile.version,
      policyAcceptances: [],
      idempotencyKey: `idem-fresh-standalone-${ulid()}`,
    });
    const [freshRow] = await t.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, standaloneCheckout.orderPublicId));
    expect(freshRow?.groupRootOrderId).toBeNull();
    expect(freshRow?.projectName).toBe("Fresh Standalone Project");
  });
});
