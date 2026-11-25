/**
 * Increment 07 (D9) — Cart payment-completion transactional callback (`cart.onInvoicePaidInTx`).
 *
 * Covers:
 *  - Transitioning `awaiting_payment -> checked_out` inside the caller's transaction (`FOR UPDATE`) and
 *    emitting durable `cart.checkout_completed`.
 *  - Idempotent replay on already `checked_out` carts and clean no-op on non-cart invoices.
 *  - Cross-order mismatch guard (`CONFLICT:CART_ORDER_MISMATCH`) rolling back the caller's transaction.
 *  - Fast-webhook concurrency race: if `onInvoicePaidInTx` completes before `cart.checkout` Phase 2,
 *    Phase 2 preserves `status = "checked_out"` while recording `paymentMode` and `paymentAttemptPublicId`.
 *  - Refusing `restoreCheckout` (`CONFLICT:CHECKOUT_ALREADY_PAID`) once `onInvoicePaidInTx` has completed.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { Services } from "../../container.js";
import type { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import * as complianceTables from "../compliance/schema.js";
import { createComplianceModule } from "../compliance/index.js";
import { users } from "../identity/schema.js";
import { createOrdersModule, type OrdersModule } from "../orders/index.js";
import * as orderTables from "../orders/schema.js";
import { FakeEngagement, FakeFiles, fakeIdentity, insertUser, type TestUser } from "../orders/testSupport.js";
import * as paymentsTables from "../payments/schema.js";
import * as promotionsTables from "../promotions/schema.js";
import { createPromotionsModule } from "../promotions/index.js";
import { createCartModule, type BillingDetailsInput, type CartModule } from "./index.js";
import type { CartCheckoutAmountEvaluation, CartPaymentsPort } from "./ports.js";
import * as cartTables from "./schema.js";
import { CART_FEATURE_FLAG } from "./settings.js";

const testSchema = {
  users,
  ...orderTables,
  ...complianceTables,
  ...promotionsTables,
  ...paymentsTables,
  ...cartTables,
};

const BILLING: BillingDetailsInput = {
  fullName: "Synthetic Buyer",
  company: "Synthetic Co",
  email: "buyer@example.test",
  country: "US",
  addressLine1: "100 Synthetic Way",
  addressLine2: "",
  city: "Austin",
  region: "TX",
  postalCode: "78701",
  taxId: "",
};

class ProgrammableRedirectPaymentsFake implements CartPaymentsPort {
  readonly supportsSettledReceipts = true;
  onStartPaymentHook: ((invoicePublicId: string) => Promise<void>) | null = null;
  paidInvoices = new Set<string>();
  private seq = 0;

  async isOnlineCheckoutEnabled(_tx?: DbOrTx) {
    return true;
  }

  async getPublicCheckoutConfig(_tx?: DbOrTx) {
    return { provider: "stripe" as const, mode: "test" as const, currency: "USD" };
  }

  async evaluateCheckoutAmount(amountMinor: number): Promise<CartCheckoutAmountEvaluation> {
    return {
      onlineEnabled: true,
      provider: "stripe",
      minimumMinor: 50,
      belowMinimum: amountMinor > 0 && amountMinor < 50,
      smallTotalAction: amountMinor === 0 ? "zero_total" : "none",
    };
  }

  async startCheckout(invoicePublicId: string) {
    this.seq += 1;
    const attemptPublicId = ulid(Date.now() + this.seq);
    if (this.onStartPaymentHook) {
      await this.onStartPaymentHook(invoicePublicId);
    }
    return {
      mode: "redirect" as const,
      invoicePublicId,
      provider: "stripe" as const,
      environment: "test" as const,
      attemptPublicId,
      redirectUrl: `https://checkout.stripe.test/pay/${attemptPublicId}`,
      expiresAt: null,
    };
  }

  async getCheckoutStatus(_principal: SessionPrincipal, input: { invoicePublicId: string; attemptPublicId?: string }) {
    const isPaid = this.paidInvoices.has(input.invoicePublicId);
    return {
      providerConfigured: "stripe" as const,
      invoicePublicId: input.invoicePublicId,
      invoiceNumber: "INV-TEST-007",
      invoiceStatus: isPaid ? ("paid" as const) : ("issued" as const),
      currency: "USD",
      amountMinor: 5000,
      waivedMinor: 0,
      balanceDueMinor: isPaid ? 0 : 5000,
      receiptPublicId: isPaid ? "01JDRECEIPT000000000000007" : null,
      attempt: input.attemptPublicId
        ? {
            attemptPublicId: input.attemptPublicId,
            provider: "stripe" as const,
            environment: "test" as const,
            status: isPaid ? ("succeeded" as const) : ("redirect_created" as const),
            failureReasonCode: null,
          }
        : null,
    };
  }

  async cancelAttemptIfUnpaid(
    _principal: SessionPrincipal,
    input: { invoicePublicId: string; attemptPublicId?: string },
    _tx?: Tx,
  ) {
    if (this.paidInvoices.has(input.invoicePublicId)) {
      return { cancelled: false, attemptPublicId: input.attemptPublicId ?? null, status: "paid" as const };
    }
    return { cancelled: true, attemptPublicId: input.attemptPublicId ?? null, status: "cancelled" as const };
  }
}

let t: TestDb;
let h: TestHarness;
let ordersMod: OrdersModule;
let cartMod: CartModule;
let paymentsFake: ProgrammableRedirectPaymentsFake;
let admin: TestUser;
let buyer: TestUser;
let productPublicId: string;

beforeAll(async () => {
  t = await createTestDb({ schema: testSchema });
  h = createTestDeps({ db: t.db });
  ordersMod = createOrdersModule(h.deps);
  const complianceMod = createComplianceModule(h.deps);
  const promotionsMod = createPromotionsModule(h.deps);
  paymentsFake = new ProgrammableRedirectPaymentsFake();

  h.services.orders = ordersMod;
  h.services.compliance = complianceMod;
  h.services.promotions = promotionsMod;
  h.services.payments = paymentsFake as unknown as Services["payments"];
  h.services.identity = fakeIdentity(h, t.db) as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];

  cartMod = createCartModule(h.deps);
  h.services.cart = cartMod;

  ordersMod.init?.();
  complianceMod.init?.();
  promotionsMod.init?.();
  cartMod.init();

  h.settings.flags.add(CART_FEATURE_FLAG.flag);

  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  buyer = await insertUser(h, t.db, { role: "customer" });

  const group = await ordersMod.catalog.createGroup(admin.principal, {
    name: "Increment 07 Cart Group",
    description: "",
    sortOrder: 0,
    active: true,
  });
  const product = await ordersMod.catalog.createProduct(admin.principal, {
    groupId: group.publicId,
    productKey: "inc07-cart-p1",
    sortOrder: 0,
    active: true,
    name: "Increment 07 Packet",
    description: "",
    priceMinor: 5000,
    currency: "USD",
    features: [],
  });
  productPublicId = product.publicId;
});

afterAll(() => t.cleanup());

describe("cart.onInvoicePaidInTx (Increment 07 D9)", () => {
  it("transitions awaiting_payment -> checked_out atomically, is idempotent on replay, and blocks restoreCheckout", async () => {
    const added = await cartMod.addItems(buyer.principal, {
      items: [{ productPublicId, quantity: 1 }],
    });
    const checkout = await cartMod.checkout(buyer.principal, {
      cartPublicId: added.cartPublicId!,
      expectedVersion: added.version,
      projectName: "D9 Paid Redirect Project",
      note: "",
      billing: BILLING,
      policyAcceptances: [],
      idempotencyKey: "idem-d9-redirect-0001",
    });
    expect(checkout.mode).toBe("redirect");

    const [beforeRow] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, checkout.cartPublicId));
    expect(beforeRow!.status).toBe("awaiting_payment");

    // Cross-order mismatch must throw CONFLICT:CART_ORDER_MISMATCH and roll back
    await expect(
      t.db.transaction(async (tx) =>
        cartMod.onInvoicePaidInTx(
          {
            invoicePublicId: checkout.invoicePublicId,
            orderPublicId: ulid(h.clock.now().getTime() + 999),
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "CART_ORDER_MISMATCH" } satisfies Partial<DomainError>);

    // Valid payment completion transitions awaiting_payment -> checked_out
    paymentsFake.paidInvoices.add(checkout.invoicePublicId);
    const first = await t.db.transaction(async (tx) =>
      cartMod.onInvoicePaidInTx(
        {
          invoicePublicId: checkout.invoicePublicId,
          orderPublicId: checkout.orderPublicId,
          paidAt: h.clock.now(),
        },
        tx,
      ),
    );
    expect(first).toEqual({ transitioned: true, cartPublicId: checkout.cartPublicId });

    const [afterRow] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, checkout.cartPublicId));
    expect(afterRow!.status).toBe("checked_out");
    expect(afterRow!.version).toBe(beforeRow!.version + 1);

    const auditCountAfterFirst = h.audit.events.filter(
      (e) => e.eventName === "cart.checkout_completed" && e.resource?.publicId === checkout.cartPublicId,
    ).length;
    expect(auditCountAfterFirst).toBe(1);

    // Replay is idempotent: no version bump, no duplicate audit event
    const second = await t.db.transaction(async (tx) =>
      cartMod.onInvoicePaidInTx({ invoicePublicId: checkout.invoicePublicId }, tx),
    );
    expect(second).toEqual({ transitioned: false, cartPublicId: checkout.cartPublicId });

    const [replayRow] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, checkout.cartPublicId));
    expect(replayRow!.version).toBe(afterRow!.version);
    expect(
      h.audit.events.filter(
        (e) => e.eventName === "cart.checkout_completed" && e.resource?.publicId === checkout.cartPublicId,
      ).length,
    ).toBe(1);

    // Non-cart invoice is a clean no-op
    const nonCart = await t.db.transaction(async (tx) =>
      cartMod.onInvoicePaidInTx({ invoicePublicId: ulid(h.clock.now().getTime() + 1234) }, tx),
    );
    expect(nonCart).toEqual({ transitioned: false, cartPublicId: null });

    // restoreCheckout is refused with CHECKOUT_ALREADY_PAID
    await expect(
      cartMod.restoreCheckout(buyer.principal, { cartPublicId: checkout.cartPublicId }),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "CHECKOUT_ALREADY_PAID" } satisfies Partial<DomainError>);
  });

  it("preserves checked_out status if a fast webhook runs onInvoicePaidInTx before checkout Phase 2 completes", async () => {
    const added = await cartMod.addItems(buyer.principal, {
      items: [{ productPublicId, quantity: 1 }],
    });

    paymentsFake.onStartPaymentHook = async (invoicePublicId) => {
      paymentsFake.paidInvoices.add(invoicePublicId);
      await t.db.transaction(async (tx) => {
        await cartMod.onInvoicePaidInTx({ invoicePublicId }, tx);
      });
    };

    try {
      const checkout = await cartMod.checkout(buyer.principal, {
        cartPublicId: added.cartPublicId!,
        expectedVersion: added.version,
        projectName: "D9 Fast Webhook Race Project",
        note: "",
        billing: BILLING,
        policyAcceptances: [],
        idempotencyKey: "idem-d9-fast-webhook-0002",
      });
      expect(checkout.mode).toBe("redirect");

      const [row] = await t.db
        .select()
        .from(cartTables.carts)
        .where(eq(cartTables.carts.publicId, checkout.cartPublicId));
      expect(row!.status).toBe("checked_out");
      expect(row!.paymentMode).toBe("redirect");
      expect(row!.paymentAttemptPublicId).toBe(checkout.mode === "redirect" ? checkout.attemptPublicId : null);
    } finally {
      paymentsFake.onStartPaymentHook = null;
    }
  });
});
