/**
 * Server integration & abuse-case suite for Package L (`cart`).
 * Exercises real MySQL (`carts`, `cart_items`, `orders`, `compliance_*`, `users`) with real
 * `OrdersModule` + `ComplianceModule` in-transaction checkout orchestration and synthetic data (`*.example.test`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Services } from "../../container.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { users } from "../identity/schema.js";
import * as orderTables from "../orders/schema.js";
import { createOrdersModule, type OrdersModule } from "../orders/index.js";
import { FakeEngagement, FakeFiles, fakeIdentity, insertUser, type TestUser } from "../orders/testSupport.js";
import * as complianceTables from "../compliance/schema.js";
import { createComplianceModule, type ComplianceModule } from "../compliance/index.js";
import * as cartTables from "./schema.js";
import { CART_ABANDONED_TTL_HOURS, CART_FEATURE_FLAG } from "./settings.js";
import type { CartPaymentsPort } from "./ports.js";
import {
  CART_JOB_EXPIRE_ABANDONED,
  CART_SCHEDULE_EXPIRE_ABANDONED,
  createCartModule,
  type CartModule,
} from "./index.js";
import { cartRouter } from "./router.js";

const cartTestSchema = {
  users,
  ...orderTables,
  ...complianceTables,
  ...cartTables,
};

interface FakeAttemptState {
  attemptPublicId: string;
  invoicePublicId: string;
  orderPublicId: string;
  orderReference: string;
  invoiceNumber: string | null;
  ownerUserId: number;
  cartPublicId: string | null;
  provider: "stripe" | "square";
  environment: "test" | "live";
  status: "created" | "redirected" | "paid" | "failed" | "cancelled" | "expired";
  invoiceStatus: "issued" | "paid" | "void";
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  redirectUrl: string;
  createdAt: Date;
  expiresAt: Date;
}

class FakePayments implements CartPaymentsPort {
  provider: "none" | "stripe" | "square" = "none";
  environment: "test" | "live" = "test";
  attemptsById = new Map<string, FakeAttemptState>();
  attemptsByInvoice = new Map<string, FakeAttemptState>();
  startCalls = 0;
  statusCalls = 0;
  cancelCalls = 0;

  constructor(private readonly db: TestDb["db"]) {}

  async isOnlineCheckoutEnabled() {
    return this.provider !== "none";
  }

  async getPublicCheckoutConfig() {
    return {
      provider: this.provider,
      mode: this.environment,
      currency: "USD",
    };
  }

  async startCheckout(
    invoicePublicId: string,
    _returnUrls?: { successPath?: string; cancelPath?: string },
    ctx?: { principal?: SessionPrincipal; cartPublicId?: string; idempotencyKey?: string },
  ) {
    this.startCalls += 1;
    if (this.provider === "none") {
      return { mode: "invoice" as const, invoicePublicId };
    }
    const existing = this.attemptsByInvoice.get(invoicePublicId);
    if (existing && (existing.status === "created" || existing.status === "redirected")) {
      return {
        mode: "redirect" as const,
        attemptPublicId: existing.attemptPublicId,
        invoicePublicId,
        provider: existing.provider,
        environment: existing.environment,
        redirectUrl: existing.redirectUrl,
        expiresAt: existing.expiresAt,
      };
    }

    const [inv] = await this.db
      .select()
      .from(complianceTables.complianceInvoices)
      .where(eq(complianceTables.complianceInvoices.publicId, invoicePublicId))
      .limit(1);
    const [ord] = await this.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.id, inv!.orderId))
      .limit(1);

    const attemptPublicId = ulid();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 30 * 60_000);
    const redirectUrl = `https://checkout.stripe.example.test/pay/${attemptPublicId}`;
    const state: FakeAttemptState = {
      attemptPublicId,
      invoicePublicId,
      orderPublicId: ord!.publicId,
      orderReference: ord!.reference,
      invoiceNumber: inv!.invoiceNumber,
      ownerUserId: ctx?.principal?.userId ?? ord!.ownerUserId,
      cartPublicId: ctx?.cartPublicId ?? null,
      provider: this.provider,
      environment: this.environment,
      status: "redirected",
      invoiceStatus: "issued",
      currency: inv!.currency,
      subtotalMinor: inv!.subtotalMinor,
      discountMinor: inv!.discountMinor,
      taxMinor: inv!.taxMinor,
      totalMinor: inv!.totalMinor,
      redirectUrl,
      createdAt,
      expiresAt,
    };
    this.attemptsById.set(attemptPublicId, state);
    this.attemptsByInvoice.set(invoicePublicId, state);
    return {
      mode: "redirect" as const,
      attemptPublicId,
      invoicePublicId,
      provider: state.provider,
      environment: state.environment,
      redirectUrl,
      expiresAt,
    };
  }

  async getCheckoutStatus(
    principal: SessionPrincipal,
    input: { invoicePublicId?: string; attemptPublicId?: string },
  ) {
    this.statusCalls += 1;
    const state = input.attemptPublicId
      ? this.attemptsById.get(input.attemptPublicId)
      : input.invoicePublicId
        ? this.attemptsByInvoice.get(input.invoicePublicId)
        : undefined;

    if (state) {
      if (state.ownerUserId !== principal.userId) {
        throw new DomainError("NOT_FOUND", "ATTEMPT_NOT_FOUND", "The requested item was not found.");
      }
      return {
        invoicePublicId: state.invoicePublicId,
        invoiceNumber: state.invoiceNumber,
        invoiceStatus: state.invoiceStatus,
        amountMinor: state.totalMinor,
        balanceDueMinor: state.invoiceStatus === "paid" ? 0 : state.totalMinor,
        currency: state.currency,
        providerConfigured: this.provider,
        environment: state.environment,
        attempt: {
          attemptPublicId: state.attemptPublicId,
          provider: state.provider,
          environment: state.environment,
          status: state.status,
          cartPublicId: state.cartPublicId,
          amountMinor: state.totalMinor,
          currency: state.currency,
          createdAt: state.createdAt,
          redirectedAt: state.createdAt,
          paidAt: state.status === "paid" ? state.createdAt : null,
          expiresAt: state.expiresAt,
          failureReasonCode: null,
        },
      };
    }

    if (input.invoicePublicId) {
      const [inv] = await this.db
        .select()
        .from(complianceTables.complianceInvoices)
        .where(eq(complianceTables.complianceInvoices.publicId, input.invoicePublicId))
        .limit(1);
      if (!inv) throw new DomainError("NOT_FOUND", "INVOICE_NOT_FOUND", "The requested item was not found.");
      const [ord] = await this.db
        .select()
        .from(orderTables.orders)
        .where(eq(orderTables.orders.id, inv.orderId))
        .limit(1);
      if (!ord || ord.ownerUserId !== principal.userId) {
        throw new DomainError("NOT_FOUND", "INVOICE_NOT_FOUND", "The requested item was not found.");
      }
      return {
        invoicePublicId: inv.publicId,
        invoiceNumber: inv.invoiceNumber,
        invoiceStatus: inv.status,
        amountMinor: inv.totalMinor,
        balanceDueMinor: inv.status === "paid" ? 0 : inv.totalMinor,
        currency: inv.currency,
        providerConfigured: this.provider,
        environment: this.environment,
        attempt: null,
      };
    }

    throw new DomainError("NOT_FOUND", "ATTEMPT_NOT_FOUND", "The requested item was not found.");
  }

  async cancelAttemptIfUnpaid(
    principal: SessionPrincipal,
    input: { invoicePublicId?: string; attemptPublicId?: string },
    _tx?: Tx,
  ) {
    this.cancelCalls += 1;
    const state = input.attemptPublicId
      ? this.attemptsById.get(input.attemptPublicId)
      : input.invoicePublicId
        ? this.attemptsByInvoice.get(input.invoicePublicId)
        : undefined;
    if (!state) {
      return { cancelled: false, attemptPublicId: null, status: null };
    }
    if (state.ownerUserId !== principal.userId) {
      throw new DomainError("NOT_FOUND", "ATTEMPT_NOT_FOUND", "The requested item was not found.");
    }
    if (state.status === "paid" || state.invoiceStatus === "paid") {
      return { cancelled: false, attemptPublicId: state.attemptPublicId, status: "paid" as const };
    }
    if (state.status === "created" || state.status === "redirected") {
      state.status = "cancelled";
      return { cancelled: true, attemptPublicId: state.attemptPublicId, status: "cancelled" as const };
    }
    return { cancelled: false, attemptPublicId: state.attemptPublicId, status: state.status };
  }
}

const appTestRouter = router({ cart: cartRouter });
const createCaller = createCallerFactory(appTestRouter);

let t: TestDb;
let h: TestHarness;
let ordersMod: OrdersModule;
let complianceMod: ComplianceModule;
let cartMod: CartModule;
let paymentsFake: FakePayments;
let identityFake: ReturnType<typeof fakeIdentity>;

let admin: TestUser;
let staff: TestUser;
let alice: TestUser;
let bob: TestUser;

let packet1Essential: string;
let packet1Executive: string;
let packet2Essential: string;
let addonRush: string;
let publishedPolicyVersionId: string;
let publishedPolicyHash: string;

const codeOf = (err: unknown): string =>
  err instanceof DomainError ? `${err.code}:${err.reasonCode}` : String(err);

async function expectDomainError(promise: Promise<unknown>, expected: string) {
  try {
    await promise;
  } catch (err) {
    expect(codeOf(err)).toBe(expected);
    return;
  }
  throw new Error(`Expected ${expected}, but promise resolved`);
}

function callerFor(principal: SessionPrincipal | null) {
  return createCaller({
    services: h.services,
    session: principal,
    request: newRequestContext("test"),
    transport: { issue() {}, clear() {} },
  });
}

beforeAll(async () => {
  t = await createTestDb({ schema: cartTestSchema });
  h = createTestDeps({ db: t.db });
  identityFake = fakeIdentity(h, t.db);
  ordersMod = createOrdersModule(h.deps);
  complianceMod = createComplianceModule(h.deps);
  paymentsFake = new FakePayments(t.db);
  cartMod = createCartModule(h.deps);

  h.services.identity = identityFake as unknown as Services["identity"];
  h.services.files = new FakeFiles() as unknown as Services["files"];
  h.services.engagement = new FakeEngagement() as unknown as Services["engagement"];
  h.services.orders = ordersMod;
  h.services.compliance = complianceMod;
  h.services.payments = paymentsFake as unknown as Services["payments"];
  h.services.cart = cartMod;

  cartMod.init();

  admin = await insertUser(h, t.db, { role: "admin", stepUp: true });
  staff = await insertUser(h, t.db, { role: "staff" });
  alice = await insertUser(h, t.db, { role: "customer" });
  bob = await insertUser(h, t.db, { role: "customer" });

  await t.db.update(users).set({ customerRef: "CUST-ALICE-01" }).where(eq(users.id, alice.id));

  // Seed active catalogue: Packet 1 (Essential + Executive), Packet 2 (Essential), and an Add-on
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
  const gAddon = await ordersMod.catalog.createGroup(admin.principal, {
    name: "Add-ons",
    description: "Optional add-ons",
    sortOrder: 3,
    active: true,
  });

  packet1Essential = (
    await ordersMod.catalog.createProduct(admin.principal, {
      groupId: g1.publicId,
      productKey: "p1-basic",
      packetNumber: 1,
      tier: "Basic",
      sortOrder: 1,
      active: true,
      name: "Packet 1 — Basic",
      description: "Core strategy packet",
      deliverables: [{ title: "Roadmap", detail: "Baseline roadmap" }],
      outcome: "Approved roadmap",
      timeline: "5 business days",
      features: ["Roadmap"],
      priceMinor: 100_00,
      currency: "USD",
    })
  ).publicId;

  packet1Executive = (
    await ordersMod.catalog.createProduct(admin.principal, {
      groupId: g1.publicId,
      productKey: "p1-premium",
      packetNumber: 1,
      tier: "Premium",
      sortOrder: 2,
      active: true,
      name: "Packet 1 — Premium",
      description: "Premium strategy packet",
      deliverables: [
        { title: "Roadmap", detail: "Full roadmap" },
        { title: "Board deck", detail: "Executive board deck" },
      ],
      outcome: "Executive alignment",
      timeline: "7 business days",
      features: ["Roadmap", "Board deck"],
      priceMinor: 250_00,
      currency: "USD",
    })
  ).publicId;

  packet2Essential = (
    await ordersMod.catalog.createProduct(admin.principal, {
      groupId: g2.publicId,
      productKey: "p2-basic",
      packetNumber: 2,
      tier: "Basic",
      sortOrder: 1,
      active: true,
      name: "Packet 2 — Basic",
      description: "Architecture blueprint",
      deliverables: [{ title: "Architecture blueprint", detail: "Target blueprint" }],
      outcome: "Target architecture",
      timeline: "10 business days",
      features: ["Blueprint"],
      priceMinor: 200_00,
      currency: "USD",
    })
  ).publicId;

  addonRush = (
    await ordersMod.catalog.createProduct(admin.principal, {
      groupId: gAddon.publicId,
      productKey: "addon-rush-review",
      sortOrder: 1,
      active: true,
      name: "Expedited Review",
      description: "48-hour expedited review session",
      features: ["Priority queue"],
      priceMinor: 50_00,
      currency: "USD",
    })
  ).publicId;

  await h.settings.set("orders.bundle_rule", {
    enabled: true,
    discountPercent: 10,
    requiredPacketNumbers: [1, 2],
    label: "Complete Packet Bundle (10% off)",
  });

  // Configure compliance tax rate (8.25% = 825 bps) and publish a required customer policy
  await h.settings.set("compliance.invoices.default_tax_rate_bps", 825);
  const createdDoc = await complianceMod.policies.admin.createDocument(admin.principal, {
    slug: "checkout-terms",
    title: "Master Services Terms",
    audience: "customer",
    requiresAcceptance: true,
    requiresTypedSignature: false,
    versionLabel: "1.0",
    contentFormat: "plain_text",
    bodyText: "Synthetic checkout terms for automated verification.",
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
  await t.cleanup();
});

beforeEach(() => {
  h.audit.failRecords = false;
  h.audit.clear();
  paymentsFake.provider = "none";
});

describe("cart module — feature gate, authorization matrix, and worker registration", () => {
  it("registers abandoned-cart schedule on init and fails closed while feature.cart is disabled", async () => {
    expect(h.jobs.schedules.some((s) => s.name === CART_SCHEDULE_EXPIRE_ABANDONED && s.type === CART_JOB_EXPIRE_ABANDONED)).toBe(true);
    expect(h.jobs.handlers.has(CART_JOB_EXPIRE_ABANDONED)).toBe(true);

    // Feature flag ships disabled by default
    expect(await h.settings.isFeatureEnabled(CART_FEATURE_FLAG.flag)).toBe(false);
    expect(await callerFor(alice.principal).cart.badgeCount()).toEqual({ enabled: false, itemCount: 0 });
    await expectDomainError(cartMod.getMyCart(alice.principal), "NOT_FOUND:CART_FEATURE_DISABLED");
    await expectDomainError(
      cartMod.addItems(alice.principal, {
        items: [{ productPublicId: packet1Essential, quantity: 1 }],
        replacePacketTiers: true,
      }),
      "NOT_FOUND:CART_FEATURE_DISABLED",
    );
  });

  it("enforces the 5-actor authorization matrix (anonymous, customer, other customer, staff, admin) and remediation guard", async () => {
    h.settings.flags.add(CART_FEATURE_FLAG.flag);

    // 1. Anonymous rejected on every procedure
    await expect(callerFor(null).cart.get()).rejects.toThrow();
    await expect(callerFor(null).cart.badgeCount()).rejects.toThrow();
    await expect(callerFor(null).cart.admin.listOpen({})).rejects.toThrow();

    // 2. Staff & admin forbidden on customer cart endpoints (audited)
    await expectDomainError(cartMod.getMyCart(staff.principal), "FORBIDDEN:CUSTOMER_ROLE_REQUIRED");
    await expectDomainError(cartMod.getMyCart(admin.principal), "FORBIDDEN:CUSTOMER_ROLE_REQUIRED");
    expect(h.audit.named("authz.cart.denied").length).toBeGreaterThanOrEqual(2);

    // 3. Customer forbidden on console open-carts endpoints (`carts.read_all`)
    await expect(callerFor(alice.principal).cart.admin.listOpen({})).rejects.toThrow();
    await expectDomainError(cartMod.adminListOpen(alice.principal, { limit: 25 }), "FORBIDDEN:CAPABILITY_NOT_GRANTED");

    // 4. Remediation session refused
    const remediationPrincipal: SessionPrincipal = {
      ...alice.principal,
      state: "remediation",
      pendingSteps: ["mfa_challenge"],
    };
    await expectDomainError(cartMod.getMyCart(remediationPrincipal), "REMEDIATION_REQUIRED:ACCOUNT_STEP_PENDING");
  });
});

describe("cart module — single open cart, tier switching, optimistic locking, and price/tax tampering abuse cases", () => {
  it("rejects client price/discount/tax fields and recomputes authoritative totals when catalogue prices change", async () => {
    h.settings.flags.add(CART_FEATURE_FLAG.flag);

    // Abuse case (§4): client attempts to supply forged unitPriceMinor / discountMinor / taxMinor
    await expect(
      callerFor(alice.principal).cart.addItems({
        items: [{ productPublicId: packet1Essential, quantity: 1, unitPriceMinor: 1 } as never],
      }),
    ).rejects.toThrow();

    // Packet quantity > 1 is rejected
    await expectDomainError(
      cartMod.addItems(alice.principal, {
        items: [{ productPublicId: packet1Essential, quantity: 2 }],
        replacePacketTiers: true,
      }),
      "VALIDATION:PACKET_QUANTITY_ONE",
    );

    // Add Packet 1 Essential ($100) + Expedited Review x2 ($100) -> subtotal $200, no bundle yet, tax 8.25% = $16.50 -> total $216.50
    const v1 = await callerFor(alice.principal).cart.addItems({
      items: [
        { productPublicId: packet1Essential, quantity: 1 },
        { productPublicId: addonRush, quantity: 2 },
      ],
    });
    expect(v1.itemCount).toBe(3);
    expect(v1.totals.subtotalMinor).toBe(200_00);
    expect(v1.totals.discountMinor).toBe(0);
    expect(v1.totals.taxRateBps).toBe(825);
    expect(v1.totals.taxMinor).toBe(16_50);
    expect(v1.totals.totalMinor).toBe(216_50);
    expect(await callerFor(alice.principal).cart.badgeCount()).toEqual({ enabled: true, itemCount: 3 });

    // Stale expectedVersion is refused with CONFLICT:STALE_VERSION
    await expectDomainError(
      cartMod.updateItem(alice.principal, {
        itemPublicId: v1.items[0]!.itemPublicId,
        expectedVersion: v1.version + 99,
        productPublicId: packet1Executive,
      }),
      "CONFLICT:STALE_VERSION",
    );

    // Switch Packet 1 from Basic ($100) to Premium ($250) + add Packet 2 Basic ($200) -> triggers 10% bundle discount!
    const p1Item = v1.items.find((i) => i.packetNumber === 1)!;
    const v2 = await callerFor(alice.principal).cart.updateItem({
      itemPublicId: p1Item.itemPublicId,
      expectedVersion: v1.version,
      productPublicId: packet1Executive,
    });
    expect(v2.items.filter((i) => i.packetNumber === 1)).toHaveLength(1);
    expect(v2.items.find((i) => i.packetNumber === 1)?.tier).toBe("Premium");

    const v3 = await callerFor(alice.principal).cart.addItems({
      items: [{ productPublicId: packet2Essential, quantity: 1 }],
    });
    // Subtotal = $250 + $100 + $200 = $550.00; 10% bundle = -$55.00 -> $495.00; tax 8.25% of 49500 = 4084 ($40.84) -> $535.84
    expect(v3.totals.bundle?.applied).toBe(true);
    expect(v3.totals.subtotalMinor).toBe(550_00);
    expect(v3.totals.discountMinor).toBe(55_00);
    expect(v3.totals.subtotalAfterDiscountMinor).toBe(495_00);
    expect(v3.totals.taxMinor).toBe(40_84);
    expect(v3.totals.totalMinor).toBe(535_84);

    // Abuse case (§4): Admin updates Packet 2 price from $200 -> $300 while item sits in Alice's open cart.
    // Reading cart immediately reflects the live $300 price without trusting any historic price!
    const [p2Row] = await t.db
      .select()
      .from(orderTables.catalogProducts)
      .where(eq(orderTables.catalogProducts.publicId, packet2Essential))
      .limit(1);
    await ordersMod.catalog.updateProduct(admin.principal, {
      productId: packet2Essential,
      expectedVersion: p2Row!.version,
      groupId: v3.items.find((i) => i.productPublicId === packet2Essential)
        ? (await ordersMod.catalog.listAll()).find((g) => g.products.some((p) => p.publicId === packet2Essential))!.publicId
        : "",
      packetNumber: 2,
      tier: "Basic",
      sortOrder: 1,
      active: true,
      name: "Packet 2 — Basic",
      description: "Architecture blueprint",
      deliverables: [{ title: "Architecture blueprint", detail: "Target blueprint" }],
      outcome: "Target architecture",
      timeline: "10 business days",
      features: ["Blueprint"],
      priceMinor: 300_00,
      currency: "USD",
    });

    const refreshed = await callerFor(alice.principal).cart.get();
    // Subtotal = $250 + $100 + $300 = $650.00; 10% bundle = -$65.00 -> $585.00; tax 8.25% = $48.26 -> $633.26
    expect(refreshed.totals.subtotalMinor).toBe(650_00);
    expect(refreshed.totals.discountMinor).toBe(65_00);
    expect(refreshed.totals.taxMinor).toBe(48_26);
    expect(refreshed.totals.totalMinor).toBe(633_26);
  });

  it("encrypts draft notes and billing details at rest and exposes zero decrypted PII to staff on /admin/carts", async () => {
    const current = await callerFor(alice.principal).cart.get();
    const secretNote = "CONFIDENTIAL-NOTE-ALPHA-9921";
    const secretEmail = "billing-secret-alpha@example.test";
    const secretStreet = "742 Evergreen Secret Terrace";

    const saved = await callerFor(alice.principal).cart.saveDraftDetails({
      expectedVersion: current.version,
      projectName: "Horizon Renewal",
      note: secretNote,
      billing: {
        fullName: "Alice Example",
        company: "Example Corp",
        email: secretEmail,
        addressLine1: secretStreet,
        city: "New York",
        region: "NY",
        postalCode: "10001",
        country: "US",
      },
    });
    expect(saved.projectName).toBe("Horizon Renewal");
    expect(saved.note).toBe(secretNote);
    expect(saved.billing?.email).toBe(secretEmail);

    // Verify DB row stores ciphertext, not plaintext
    const [rawRow] = await t.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, saved.cartPublicId!))
      .limit(1);
    expect(rawRow!.noteEnc).not.toContain(secretNote);
    expect(rawRow!.billingEnc).not.toContain(secretEmail);
    expect(rawRow!.billingEnc).not.toContain(secretStreet);

    // Staff (`carts.read_all`) sees open cart summary + live line items, NEVER decrypted note/billing/email/name
    const openList = await callerFor(staff.principal).cart.admin.listOpen({ search: "Horizon" });
    expect(openList.items).toHaveLength(1);
    expect(openList.items[0]!.cartPublicId).toBe(saved.cartPublicId);
    expect(openList.items[0]!.customerRef).toBe("CUST-ALICE-01");
    expect(openList.items[0]!.totalMinor).toBe(633_26);

    const openDetail = await callerFor(staff.principal).cart.admin.getOpen({ cartPublicId: saved.cartPublicId! });
    const serialized = JSON.stringify({ openList, openDetail });
    expect(serialized).not.toContain(secretNote);
    expect(serialized).not.toContain(secretEmail);
    expect(serialized).not.toContain(secretStreet);
    expect(serialized).not.toContain("Synthetic User");
  });
});

describe("cart module — atomic checkout, policy enforcement, Decision 12 return status, cancel/restore, and expiry", () => {
  it("enforces required policy acceptance, rolls back atomically on audit failure, and executes idempotent invoice checkout", async () => {
    const cartBefore = await callerFor(alice.principal).cart.get();
    const cartPublicId = cartBefore.cartPublicId!;

    // Bob (other customer) attempting to checkout Alice's cartPublicId gets NOT_FOUND + authz.cart.denied
    await expectDomainError(
      cartMod.checkout(bob.principal, {
        cartPublicId,
        expectedVersion: cartBefore.version,
        projectName: "Hijack Attempt",
        note: "",
        billing: cartBefore.billing!,
        policyAcceptances: [{ versionPublicId: publishedPolicyVersionId, contentHash: publishedPolicyHash }],
        idempotencyKey: "idem-bob-hijack-0001",
      }),
      "NOT_FOUND:CART_NOT_FOUND",
    );
    expect(h.audit.named("authz.cart.denied").some((e) => e.reasonCode === "NOT_CART_OWNER")).toBe(true);

    // Missing required policy acceptance -> CONFLICT:POLICY_ACCEPTANCE_REQUIRED, cart stays open!
    await expectDomainError(
      cartMod.checkout(alice.principal, {
        cartPublicId,
        expectedVersion: cartBefore.version,
        projectName: "Horizon Renewal",
        note: "",
        billing: cartBefore.billing!,
        policyAcceptances: [],
        idempotencyKey: "idem-missing-policy-0001",
      }),
      "CONFLICT:POLICY_ACCEPTANCE_REQUIRED",
    );

    // Audit fail-closed -> entire transaction rolls back (no order, no invoice, cart remains open)
    h.audit.failRecords = true;
    await expect(
      cartMod.checkout(alice.principal, {
        cartPublicId,
        expectedVersion: cartBefore.version,
        projectName: "Horizon Renewal",
        note: "",
        billing: cartBefore.billing!,
        policyAcceptances: [{ versionPublicId: publishedPolicyVersionId, contentHash: publishedPolicyHash }],
        idempotencyKey: "idem-audit-fail-0001",
      }),
    ).rejects.toThrow();
    h.audit.failRecords = false;

    const stillOpen = await callerFor(alice.principal).cart.get();
    expect(stillOpen.cartPublicId).toBe(cartPublicId);
    expect(stillOpen.items.length).toBe(3);

    // Succeeds in invoice mode (`payments.provider === "none"`) and is idempotent on replay
    const idemKey = "idem-alice-checkout-invoice-0001";
    const result1 = await callerFor(alice.principal).cart.checkout({
      cartPublicId,
      expectedVersion: stillOpen.version,
      projectName: "Horizon Renewal",
      note: stillOpen.note,
      billing: stillOpen.billing!,
      policyAcceptances: [{ versionPublicId: publishedPolicyVersionId, contentHash: publishedPolicyHash }],
      idempotencyKey: idemKey,
    });
    expect(result1.mode).toBe("invoice");
    expect(result1.totalMinor).toBe(633_26);
    expect(result1.invoiceNumber).toMatch(/^RP-INV-/);

    // Replay with identical idempotencyKey returns the exact same order & invoice without duplicating rows
    const result2 = await callerFor(alice.principal).cart.checkout({
      cartPublicId,
      expectedVersion: stillOpen.version,
      projectName: "Horizon Renewal",
      note: stillOpen.note,
      billing: stillOpen.billing!,
      policyAcceptances: [],
      idempotencyKey: idemKey,
    });
    expect(result2.orderPublicId).toBe(result1.orderPublicId);
    expect(result2.invoicePublicId).toBe(result1.invoicePublicId);

    // Alice's active cart is now empty so she can start a new cart cleanly
    const afterCheckout = await callerFor(alice.principal).cart.get();
    expect(afterCheckout.items).toHaveLength(0);
    expect(afterCheckout.cartPublicId).toBeNull();
  });

  it("supports hosted redirect checkout, Decision 12 read-only return polling, idempotent cancel/restore, and refuses restore once paid", async () => {
    paymentsFake.provider = "stripe";

    // Build a second cart for Alice and check out in hosted redirect mode
    const c1 = await callerFor(alice.principal).cart.addItems({
      items: [
        { productPublicId: packet1Essential, quantity: 1 },
        { productPublicId: addonRush, quantity: 1 },
      ],
    });
    const checkoutRes = await callerFor(alice.principal).cart.checkout({
      cartPublicId: c1.cartPublicId!,
      expectedVersion: c1.version,
      projectName: "Stripe Hosted Checkout",
      note: "Restore me if unpaid",
      billing: {
        fullName: "Alice Example",
        email: "alice.checkout@example.test",
        addressLine1: "100 Market St",
        city: "San Francisco",
        region: "CA",
        postalCode: "94105",
        country: "US",
      },
      policyAcceptances: [],
      idempotencyKey: "idem-alice-stripe-redirect-0001",
    });

    expect(checkoutRes.mode).toBe("redirect");
    if (checkoutRes.mode !== "redirect") throw new Error("Expected redirect mode");
    const attemptId = checkoutRes.attemptPublicId;

    // Decision 12 invariant: `checkoutStatus` is strictly read-only and reports `pending_confirmation` while attempt is pending
    const statusPending = await callerFor(alice.principal).cart.checkoutStatus({ attemptPublicId: attemptId });
    expect(statusPending.confirmationState).toBe("pending_confirmation");
    expect(statusPending.invoiceStatus).toBe("issued");
    expect(statusPending.canRestoreToCart).toBe(true);

    // Bob cannot inspect or restore Alice's checkout attempt (NOT_FOUND + authz.cart.denied)
    await expectDomainError(
      cartMod.getCheckoutStatus(bob.principal, { attemptPublicId: attemptId }),
      "NOT_FOUND:CART_NOT_FOUND",
    );
    await expectDomainError(
      cartMod.restoreCheckout(bob.principal, { attemptPublicId: attemptId }),
      "NOT_FOUND:CART_NOT_FOUND",
    );

    // Explicit POST `restoreCheckout` cancels the unpaid attempt and restores items + draft fields into Alice's open cart
    const restored1 = await callerFor(alice.principal).cart.restoreCheckout({ attemptPublicId: attemptId });
    expect(restored1.restored).toBe(true);
    expect(restored1.alreadyRestored).toBe(false);
    expect(restored1.cart.items).toHaveLength(2);
    expect(restored1.cart.projectName).toBe("Stripe Hosted Checkout");
    expect(restored1.cart.note).toBe("Restore me if unpaid");

    // Repeating `restoreCheckout` is idempotent and does NOT duplicate items
    const restored2 = await callerFor(alice.principal).cart.restoreCheckout({ attemptPublicId: attemptId });
    expect(restored2.alreadyRestored).toBe(true);
    expect(restored2.cart.items).toHaveLength(2);

    // Now complete a third checkout and simulate verified webhook marking attempt + invoice `paid`:
    // `checkoutStatus` reports `paid` and `restoreCheckout` refuses with CONFLICT:CHECKOUT_ALREADY_PAID!
    const paidCheckout = await callerFor(alice.principal).cart.checkout({
      cartPublicId: restored2.cart.cartPublicId!,
      expectedVersion: restored2.cart.version,
      projectName: "Paid Hosted Checkout",
      billing: restored2.cart.billing!,
      policyAcceptances: [],
      idempotencyKey: "idem-alice-stripe-paid-0002",
    });
    if (paidCheckout.mode !== "redirect") throw new Error("Expected redirect mode");
    const paidAttempt = paymentsFake.attemptsById.get(paidCheckout.attemptPublicId)!;
    paidAttempt.status = "paid";
    paidAttempt.invoiceStatus = "paid";

    const statusPaid = await callerFor(alice.principal).cart.checkoutStatus({
      attemptPublicId: paidCheckout.attemptPublicId,
    });
    expect(statusPaid.confirmationState).toBe("paid");
    expect(statusPaid.canRestoreToCart).toBe(false);

    await expectDomainError(
      cartMod.restoreCheckout(alice.principal, { attemptPublicId: paidCheckout.attemptPublicId }),
      "CONFLICT:CHECKOUT_ALREADY_PAID",
    );
  });

  it("expires abandoned open carts via the fenced worker job while preserving active carts", async () => {
    await h.settings.set(CART_ABANDONED_TTL_HOURS.key, 24);

    // Bob creates an open cart at T0; Alice creates an open cart 20 hours later
    const bobCart = await callerFor(bob.principal).cart.addItems({
      items: [{ productPublicId: packet1Essential, quantity: 1 }],
    });
    h.clock.advance(20 * 3_600_000);
    const aliceCart = await callerFor(alice.principal).cart.addItems({
      items: [{ productPublicId: addonRush, quantity: 1 }],
    });

    // Advance another 5 hours (Bob = 25h inactive > 24h TTL; Alice = 5h inactive < 24h TTL)
    h.clock.advance(5 * 3_600_000);
    await h.jobs.enqueue(CART_JOB_EXPIRE_ABANDONED, {});
    const jobResults = await h.jobs.runAll(CART_JOB_EXPIRE_ABANDONED);
    expect(jobResults[0]).toEqual({ outcome: "completed", safeCounts: { expired_carts: 1 } });
    expect(h.audit.named("cart.expired")).toHaveLength(1);
    expect(h.audit.named("cart.expired")[0]!.resource?.publicId).toBe(bobCart.cartPublicId);

    // Bob's cart is expired so his open cart is empty (and he can open a fresh one without unique-slot collision); Alice's cart remains open
    const bobAfter = await callerFor(bob.principal).cart.get();
    expect(bobAfter.cartPublicId).toBeNull();
    expect(bobAfter.items).toHaveLength(0);

    const bobFresh = await callerFor(bob.principal).cart.addItems({
      items: [{ productPublicId: packet1Executive, quantity: 1 }],
    });
    expect(bobFresh.cartPublicId).not.toBe(bobCart.cartPublicId);
    expect(bobFresh.items).toHaveLength(1);

    const aliceAfter = await callerFor(alice.principal).cart.get();
    expect(aliceAfter.cartPublicId).toBe(aliceCart.cartPublicId);
    expect(aliceAfter.items).toHaveLength(1);
  });
});
