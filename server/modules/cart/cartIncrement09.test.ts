/**
 * Increment 09 — Cart & Checkout Trash & Permanent Deletion integration tests:
 *  - `"cart"` `TrashParticipant` registration in `cart.init()` (and inclusion in `EXPECTED_CONTAINER_PARTICIPANTS`),
 *    `onTrashedInTx`, `summarize`, and `purge` (with `run.assertCurrentInTx(tx)` as first statement + `purge_started_at` / `trash_batch_id` verification).
 *  - Trashed & permanently deleted order gates on `cart.checkoutStatus` and `cart.restoreCheckout` (`NOT_FOUND:CART_NOT_FOUND`,
 *    plus scrubbing trashed `addToOrderPublicId` during `restoreCheckout`).
 *  - Trashed & tombstoned customer filtering in `cart.admin.listOpen`, `cart.admin.getOpen`, and `cart.abandoned.expire`.
 *  - End-to-end permanent deletion through the real `createTrashModule` coordinator with `"cart"`, `"orders"`, and `"identity"` registered.
 *
 * Synthetic fixtures only (`Zeus Greene`, `RPCUS-A1B2CJJG5`, project `Ice Queen`).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { Services } from "../../container.js";
import { conflict, type DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { createBillingProfileModule } from "../billingProfile/index.js";
import * as billingProfileTables from "../billingProfile/schema.js";
import { createComplianceModule } from "../compliance/index.js";
import * as complianceTables from "../compliance/schema.js";
import { createIdentityModule } from "../identity/index.js";
import * as identityTables from "../identity/schema.js";
import { users } from "../identity/schema.js";
import { createOrdersModule, type OrdersModule } from "../orders/index.js";
import * as orderTables from "../orders/schema.js";
import { FakeEngagement, FakeFiles, fakeIdentity, insertUser, type TestUser } from "../orders/testSupport.js";
import * as paymentsTables from "../payments/schema.js";
import * as platformTables from "../platform/schema.js";
import { createPromotionsModule } from "../promotions/index.js";
import * as promotionsTables from "../promotions/schema.js";
import {
  createTrashModule,
  EXPECTED_CONTAINER_PARTICIPANTS,
  type TrashCoordinatorModule,
  type TrashPurgeRun,
} from "../trash/index.js";
import * as trashTables from "../trash/schema.js";
import { createCartModule, type BillingDetailsInput, type CartModule } from "./index.js";
import type { CartCheckoutAmountEvaluation, CartPaymentsPort } from "./ports.js";
import * as cartTables from "./schema.js";
import { CART_FEATURE_FLAG } from "./settings.js";
import { createCartTrashParticipant } from "./trash.js";

const testSchema = {
  ...identityTables,
  ...orderTables,
  ...complianceTables,
  ...billingProfileTables,
  ...promotionsTables,
  ...paymentsTables,
  ...platformTables,
  ...trashTables,
  ...cartTables,
};

const ZEUS_BILLING: BillingDetailsInput = {
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
      invoiceNumber: "INV-INC09",
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
let trashMod: TrashCoordinatorModule;
let cartMod: CartModule;
let admin: TestUser;
let zeus: TestUser;
let packet1ProductId: string;
let packet2ProductId: string;

beforeAll(async () => {
  t = await createTestDb({ schema: testSchema });
  h = createTestDeps({ db: t.db });

  h.services.opsAlerts = {
    emit: async () => {},
    resolve: async () => true,
  } as never;
  h.services.assurance = {
    getAssuranceState: async () => ({
      mfaEnrolled: true,
      recoveryCodesAcknowledged: true,
    }),
  } as never;
  h.services.jobAdmin = {
    isDraining: async () => false,
    maintenance: {
      customerAccess: async () => ({ active: false, message: null, updatedAt: null }),
    },
  } as never;

  const realIdentity = createIdentityModule(h.deps);
  ordersMod = createOrdersModule(h.deps);
  const complianceMod = createComplianceModule(h.deps);
  const billingProfileMod = createBillingProfileModule(h.deps);
  const promotionsMod = createPromotionsModule(h.deps);
  const paymentsFake = new SimpleInvoicePaymentsFake();

  // Wire a real Trash coordinator with real `cart`, `orders`, `identity`, `compliance`, `billingProfile`, and `promotions` participants!
  trashMod = createTrashModule(h.deps, {
    expectedParticipants: ["cart", "orders", "identity", "compliance", "billingProfile", "promotions"],
  });
  h.services.trash = trashMod;
  h.services.orders = ordersMod;
  h.services.compliance = complianceMod;
  h.services.billingProfile = billingProfileMod;
  h.services.promotions = promotionsMod;
  h.services.payments = paymentsFake as unknown as Services["payments"];
  const fakeIdent = fakeIdentity(h, t.db);
  h.services.identity = {
    ...fakeIdent,
    users: realIdentity.users,
    trash: realIdentity.trash,
  } as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];

  cartMod = createCartModule(h.deps);
  h.services.cart = cartMod;

  // Exercise `init()` participant registration across real modules including `cart.init()`.
  realIdentity.init?.();
  ordersMod.init?.();
  complianceMod.init?.();
  billingProfileMod.init?.();
  promotionsMod.init?.();
  cartMod.init?.();
  trashMod.init?.();

  h.settings.flags.add(CART_FEATURE_FLAG.flag);

  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  zeus = await insertUser(h, t.db, { role: "customer" });
  await t.db.update(users).set({ customerRef: "RPCUS-A1B2CJJG5" }).where(eq(users.id, zeus.id));

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
  const p1 = await ordersMod.catalog.createProduct(admin.principal, {
    groupId: g1.publicId,
    productKey: "inc09-packet-1-basic",
    packetNumber: 1,
    tier: "Basic",
    sortOrder: 1,
    active: true,
    name: "Packet 1 — Basic",
    description: "Packet 1 Basic",
    priceMinor: 5000,
    currency: "USD",
    features: [],
  });
  const p2 = await ordersMod.catalog.createProduct(admin.principal, {
    groupId: g2.publicId,
    productKey: "inc09-packet-2-basic",
    packetNumber: 2,
    tier: "Basic",
    sortOrder: 1,
    active: true,
    name: "Packet 2 — Basic",
    description: "Packet 2 Basic",
    priceMinor: 7500,
    currency: "USD",
    features: [],
  });
  packet1ProductId = p1.publicId;
  packet2ProductId = p2.publicId;
});

afterAll(async () => {
  await t?.cleanup();
});

describe("Increment 09 — Cart TrashParticipant & trashed customer/order guards", () => {
  it("registers the `cart` TrashParticipant during `cart.init()` and matches the container manifest", async () => {
    expect(EXPECTED_CONTAINER_PARTICIPANTS).toContain("cart");
    const registered = trashMod.participants().map((p) => p.module);
    expect(registered).toContain("cart");
    const health = await trashMod.health!();
    expect(health[0]?.state).toBe("ok");
  });

  it("clears `addToOrderPublicId` on open carts when the target root order moves to trash (`onTrashedInTx`)", async () => {
    await cartMod.addItems(zeus.principal, {
      items: [{ productPublicId: packet1ProductId, quantity: 1 }],
      projectName: "Ice Queen",
    });
    const current = await cartMod.getMyCart(zeus.principal);
    const rootCheckout = await cartMod.checkout(zeus.principal, {
      cartPublicId: current.cartPublicId!,
      expectedVersion: current.version,
      projectName: "Ice Queen",
      billing: ZEUS_BILLING,
      idempotencyKey: `inc09-root-${ulid()}`,
    });

    // Zeus opens a new cart targeting the `Ice Queen` root order.
    const openView = await cartMod.addItems(zeus.principal, {
      items: [{ productPublicId: packet2ProductId, quantity: 1 }],
      addToOrderPublicId: rootCheckout.orderPublicId,
    });
    expect(openView.addToOrder?.rootPublicId).toBe(rootCheckout.orderPublicId);

    // Move `Ice Queen` to trash via the real coordinator -> invokes `cart.onTrashedInTx`.
    const moved = await trashMod.moveToTrash(admin.principal, {
      kind: "order",
      publicId: rootCheckout.orderPublicId,
      reason: "Test move to trash",
      idempotencyKey: `inc09-move-root-${ulid()}`,
    });

    const [updatedOpenRow] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, openView.cartPublicId!));
    expect(updatedOpenRow?.addToOrderPublicId).toBeNull();
    expect(updatedOpenRow?.version).toBeGreaterThan(openView.version);

    // Restoring `Ice Queen` keeps the order live again for subsequent tests.
    await trashMod.restore(admin.principal, {
      items: [{ kind: "order", publicId: rootCheckout.orderPublicId, batchId: moved.batchId }],
      idempotencyKey: `inc09-restore-root-${ulid()}`,
    });
  });

  it("returns `NOT_FOUND:CART_NOT_FOUND` on `checkoutStatus` and `restoreCheckout` when the checkout order is trashed, and scrubs trashed `addToOrderPublicId` on live restore", async () => {
    const clearBefore = await cartMod.getMyCart(zeus.principal);
    if (clearBefore.items.length > 0) {
      await cartMod.clearCart(zeus.principal, { expectedVersion: clearBefore.version });
    }
    const seededRoot = await cartMod.addItems(zeus.principal, {
      items: [{ productPublicId: packet1ProductId, quantity: 1 }],
      projectName: "Ice Queen Root",
    });
    const rootOrder = await cartMod.checkout(zeus.principal, {
      cartPublicId: seededRoot.cartPublicId!,
      expectedVersion: seededRoot.version,
      projectName: "Ice Queen Root",
      billing: ZEUS_BILLING,
      idempotencyKey: `inc09-addon-root-${ulid()}`,
    });

    // Checkout an add-on cart (`awaiting_payment`) pointing to `rootOrder.orderPublicId`.
    const addonOpen = await cartMod.addItems(zeus.principal, {
      items: [{ productPublicId: packet2ProductId, quantity: 1 }],
      addToOrderPublicId: rootOrder.orderPublicId,
    });
    const addonCheckout = await cartMod.checkout(zeus.principal, {
      cartPublicId: addonOpen.cartPublicId!,
      expectedVersion: addonOpen.version,
      projectName: "Ice Queen Root",
      billing: ZEUS_BILLING,
      idempotencyKey: `inc09-addon-child-${ulid()}`,
    });

    // Trash ONLY `addonCheckout` and verify both `getCheckoutStatus` and `restoreCheckout` fail closed with `CART_NOT_FOUND`.
    const movedAddon = await trashMod.moveToTrash(admin.principal, {
      kind: "order",
      publicId: addonCheckout.orderPublicId,
      idempotencyKey: `inc09-move-addon-${ulid()}`,
    });

    await expect(
      cartMod.getCheckoutStatus(zeus.principal, { cartPublicId: addonOpen.cartPublicId! }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      reasonCode: "CART_NOT_FOUND",
    } satisfies Partial<DomainError>);

    await expect(
      cartMod.restoreCheckout(zeus.principal, { cartPublicId: addonOpen.cartPublicId! }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      reasonCode: "CART_NOT_FOUND",
    } satisfies Partial<DomainError>);

    // Restore `addonCheckout`, then mark `rootOrder` (`addToOrderPublicId`) trashed -> `restoreCheckout` succeeds
    // for the live `addonCheckout` order while scrubbing `addToOrderPublicId` to `null`.
    await trashMod.restore(admin.principal, {
      items: [{ kind: "order", publicId: addonCheckout.orderPublicId, batchId: movedAddon.batchId }],
      idempotencyKey: `inc09-restore-addon-${ulid()}`,
    });
    await t.db
      .update(orderTables.orders)
      .set({ trashedAt: h.clock.now(), trashedByUserId: admin.id, trashBatchId: ulid() })
      .where(eq(orderTables.orders.publicId, rootOrder.orderPublicId));

    const restored = await cartMod.restoreCheckout(zeus.principal, {
      cartPublicId: addonOpen.cartPublicId!,
    });
    expect(restored.cart.addToOrder).toBeNull();
    expect(restored.cart.items.length).toBe(1);
    const [restoredOpenRow] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, restored.cart.cartPublicId!));
    expect(restoredOpenRow?.addToOrderPublicId).toBeNull();
  });

  it("hides trashed/tombstoned customers from `admin.listOpen`, `admin.getOpen`, and `expireAbandonedNow`", async () => {
    const trashedBuyer = await insertUser(h, t.db, { role: "customer" });
    await t.db.update(users).set({ customerRef: "RPCUS-7R4SH0001" }).where(eq(users.id, trashedBuyer.id));
    const liveBuyer = await insertUser(h, t.db, { role: "customer" });
    await t.db.update(users).set({ customerRef: "RPCUS-L1V3B0002" }).where(eq(users.id, liveBuyer.id));

    const trashedCart = await cartMod.addItems(trashedBuyer.principal, {
      items: [{ productPublicId: packet1ProductId, quantity: 1 }],
      projectName: "Ice Queen Hidden",
    });
    const liveCart = await cartMod.addItems(liveBuyer.principal, {
      items: [{ productPublicId: packet1ProductId, quantity: 1 }],
      projectName: "Ice Queen Visible",
    });

    // Mark both carts stale so `expireAbandonedNow` would pick them up if owned by live customers.
    const sixtyDaysAgo = new Date(h.clock.now().getTime() - 60 * 24 * 60 * 60 * 1000);
    await t.db
      .update(cartTables.carts)
      .set({ lastActivityAt: sixtyDaysAgo })
      .where(eq(cartTables.carts.publicId, trashedCart.cartPublicId!));
    await t.db
      .update(cartTables.carts)
      .set({ lastActivityAt: sixtyDaysAgo })
      .where(eq(cartTables.carts.publicId, liveCart.cartPublicId!));

    // Suspend & move `trashedBuyer` into Trash (per D2.2 customers must be suspended before moving to Trash).
    await t.db.update(users).set({ status: "suspended" }).where(eq(users.id, trashedBuyer.id));
    await trashMod.moveToTrash(admin.principal, {
      kind: "customer",
      publicId: trashedBuyer.publicId,
      reason: "Test customer trash visibility",
      idempotencyKey: `inc09-move-cust-${ulid()}`,
    });

    const openList = await cartMod.adminListOpen(admin.principal, { limit: 50 });
    const listedIds = openList.items.map((c) => c.cartPublicId);
    expect(listedIds).toContain(liveCart.cartPublicId);
    expect(listedIds).not.toContain(trashedCart.cartPublicId);

    await expect(
      cartMod.adminGetOpen(admin.principal, { cartPublicId: trashedCart.cartPublicId! }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      reasonCode: "CART_NOT_FOUND",
    } satisfies Partial<DomainError>);

    // `expireAbandonedCarts` expires `liveBuyer`'s stale cart while leaving `trashedBuyer`'s cart untouched in Trash.
    const expired = await cartMod.expireAbandonedCarts();
    expect(expired.expiredCount).toBeGreaterThanOrEqual(1);

    const [trashedRowAfter] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, trashedCart.cartPublicId!));
    const [liveRowAfter] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, liveCart.cartPublicId!));
    expect(trashedRowAfter?.status).toBe("open");
    expect(liveRowAfter?.status).toBe("expired");
  });

  it("enforces `run.assertCurrentInTx(tx)` fencing and `PURGE_NOT_STARTED` before mutating cart rows", async () => {
    const fencedBuyer = await insertUser(h, t.db, { role: "customer" });
    await cartMod.addItems(fencedBuyer.principal, {
      items: [{ productPublicId: packet1ProductId, quantity: 1 }],
      projectName: "Ice Queen Fence",
    });
    const participant = createCartTrashParticipant(h.deps);

    const liveRun: TrashPurgeRun = {
      runId: ulid(),
      async assertCurrentInTx() {},
    };

    // Without `purgeStartedAt`, `cart.purge` refuses with `PURGE_NOT_STARTED`.
    await expect(
      participant.purge!(
        {
          kind: "customer",
          id: fencedBuyer.id,
          publicId: fencedBuyer.publicId,
          batchId: ulid(),
        },
        liveRun,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "PURGE_NOT_STARTED",
    } satisfies Partial<DomainError>);

    // Even when `purgeStartedAt` is set, a lost run fence aborts the transaction before deleting any cart rows.
    const batchId = ulid();
    await t.db
      .update(users)
      .set({
        trashedAt: h.clock.now(),
        purgeStartedAt: h.clock.now(),
        trashBatchId: batchId,
      })
      .where(eq(users.id, fencedBuyer.id));

    const fencedOutRun: TrashPurgeRun = {
      runId: ulid(),
      async assertCurrentInTx() {
        throw conflict("PURGE_FENCE_LOST", "Simulated takeover");
      },
    };
    await expect(
      participant.purge!(
        {
          kind: "customer",
          id: fencedBuyer.id,
          publicId: fencedBuyer.publicId,
          batchId,
        },
        fencedOutRun,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "PURGE_FENCE_LOST",
    } satisfies Partial<DomainError>);

    expect(
      await participant.summarize!({
        kind: "customer",
        id: fencedBuyer.id,
        publicId: fencedBuyer.publicId,
        batchId,
      }),
    ).toEqual({ carts: 1 });
  });

  it("scrubs order links on order permanent deletion and erases customer carts + items on customer permanent deletion via `TrashModule`", async () => {
    // 1. Order permanent deletion scrubs `checkoutOrderId`, `checkoutOrderPublicId`, and `checkoutOrderReference`.
    const purgeOrderBuyer = await insertUser(h, t.db, { role: "customer" });
    const purgeCustRef = "RPCUS-PURG30009";
    await t.db.update(users).set({ customerRef: purgeCustRef }).where(eq(users.id, purgeOrderBuyer.id));

    const draft = await cartMod.addItems(purgeOrderBuyer.principal, {
      items: [{ productPublicId: packet1ProductId, quantity: 1 }],
      projectName: "Ice Queen Order Purge",
    });
    const checkedOut = await cartMod.checkout(purgeOrderBuyer.principal, {
      cartPublicId: draft.cartPublicId!,
      expectedVersion: draft.version,
      projectName: "Ice Queen Order Purge",
      billing: ZEUS_BILLING,
      idempotencyKey: `inc09-ord-purge-${ulid()}`,
    });

    const movedOrder = await trashMod.moveToTrash(admin.principal, {
      kind: "order",
      publicId: checkedOut.orderPublicId,
      idempotencyKey: `inc09-move-ord-purge-${ulid()}`,
    });
    const orderPurge = await trashMod.purge(admin.principal, {
      items: [{ kind: "order", publicId: checkedOut.orderPublicId, batchId: movedOrder.batchId }],
      confirmation: checkedOut.orderReference,
      idempotencyKey: `inc09-purge-ord-${ulid()}`,
    });
    expect(orderPurge.results[0]?.ok).toBe(true);

    const [scrubbedCart] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, draft.cartPublicId!));
    expect(scrubbedCart?.checkoutOrderId).toBeNull();
    expect(scrubbedCart?.checkoutOrderPublicId).toBeNull();
    expect(scrubbedCart?.checkoutOrderReference).toBeNull();

    await expect(
      cartMod.getCheckoutStatus(purgeOrderBuyer.principal, {
        cartPublicId: draft.cartPublicId!,
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      reasonCode: "CART_NOT_FOUND",
    } satisfies Partial<DomainError>);

    // 2. Customer permanent deletion summarizes `{ carts }` beforehand and erases all owned carts + items.
    await cartMod.addItems(purgeOrderBuyer.principal, {
      items: [
        { productPublicId: packet1ProductId, quantity: 1 },
        { productPublicId: packet2ProductId, quantity: 1 },
      ],
      projectName: "Ice Queen Open Cart",
    });

    await t.db.update(users).set({ status: "suspended" }).where(eq(users.id, purgeOrderBuyer.id));
    const movedCust = await trashMod.moveToTrash(admin.principal, {
      kind: "customer",
      publicId: purgeOrderBuyer.publicId,
      idempotencyKey: `inc09-move-cust-purge-${ulid()}`,
    });
    const summary = await trashMod.summarize(admin.principal, {
      kind: "customer",
      publicId: purgeOrderBuyer.publicId,
      batchId: movedCust.batchId,
    });
    expect(summary.counts.carts).toBe(2);

    const custPurge = await trashMod.purge(admin.principal, {
      items: [{ kind: "customer", publicId: purgeOrderBuyer.publicId, batchId: movedCust.batchId }],
      confirmation: purgeCustRef,
      idempotencyKey: `inc09-purge-cust-${ulid()}`,
    });
    expect(custPurge.results[0]?.ok).toBe(true);

    const remainingCarts = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.ownerUserId, purgeOrderBuyer.id));
    expect(remainingCarts).toHaveLength(0);
  });
});
