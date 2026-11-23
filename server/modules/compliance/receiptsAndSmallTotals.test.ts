/**
 * Increment 06 Wave 2 — D5 small-total checkout settlement (`payments.small_totals` waive/block + `$0` zero-total),
 * D15 branded payment receipts (`RPR-YYYY-NNNNNN`) + refund notes (`RPRN-YYYY-NNNNNN`) + encrypted PDF/snapshot +
 * transactional mail + rate-limited staff resend, and D11/D14 typed-signature check & router capability guards.
 * All data is 100% synthetic.
 */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModuleDeps, Services } from "../../container.js";
import { DomainError, notFound } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { DbOrTx, Logger, SessionPrincipal } from "../../core/types.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { users } from "../identity/schema.js";
import type { EgressFetchOptions, EgressFetchResponse, EgressPurpose } from "../integrations/egress.js";
import type { OrderAccessRole, OrderAccessView, OrderLockState, OrdersModule } from "../orders/index.js";
import {
  createPaymentsModule,
  DEFAULT_PAYMENTS_RECEIPTS,
  DEFAULT_PAYMENTS_SMALL_TOTALS,
  parsePaymentsReceiptsSetting,
  parsePaymentsSmallTotals,
  paymentAttempts,
  paymentsRouter,
} from "../payments/index.js";
import * as paymentsSchema from "../payments/schema.js";
import {
  createComplianceModule,
  parsePngForPdf,
  renderPaymentReceiptPdf,
} from "./index.js";
import { complianceRouter } from "./router.js";
import { compareTypedSignatureToAccountName, normalizeSignatureName } from "./signatureNameCheck.js";
import * as complianceSchema from "./schema.js";

interface FakeOrderRecord {
  id: number;
  publicId: string;
  reference: string;
  ownerUserId: number;
  ownerPublicId: string;
  lockState: OrderLockState;
  origin: "portal" | "import";
  collaborators?: Map<number, { role: "viewer" | "contributor"; hasBillingGrant?: boolean }>;
}

function buildFakeOrders(ordersByPubId: Map<string, FakeOrderRecord>): OrdersModule {
  const byId = () => {
    const m = new Map<number, FakeOrderRecord>();
    for (const o of ordersByPubId.values()) m.set(o.id, o);
    return m;
  };

  function resolveRole(
    principal: SessionPrincipal,
    order: FakeOrderRecord,
  ): { role: OrderAccessRole; hasBillingGrant?: boolean } | null {
    if (principal.role === "admin") return { role: "admin" };
    if (principal.role === "staff") return { role: "staff" };
    if (order.ownerUserId === principal.userId) return { role: "owner" };
    const collab = order.collaborators?.get(principal.userId);
    if (collab) return { role: collab.role, ...(collab.hasBillingGrant ? { hasBillingGrant: true } : {}) };
    return null;
  }

  function toView(order: FakeOrderRecord, role: OrderAccessRole, hasBillingGrant?: boolean): OrderAccessView {
    return {
      id: order.id,
      publicId: order.publicId,
      reference: order.reference,
      ownerUserId: order.ownerUserId,
      ownerPublicId: order.ownerPublicId,
      statusKey: "in_progress",
      lockState: order.lockState,
      locked: order.lockState !== "none",
      readOnlyImported: order.origin === "import" || order.lockState === "imported_read_only",
      accessRole: role,
      canWrite: order.lockState === "none" && order.origin === "portal",
      origin: order.origin,
      version: 1,
      workflowVersionId: 1,
      ...(hasBillingGrant ? ({ hasBillingGrant: true } as Record<string, unknown>) : {}),
    };
  }

  async function assertCanReadOrder(principal: SessionPrincipal, orderPublicId: string): Promise<OrderAccessView> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) throw notFound("ORDER_NOT_FOUND");
    const order = ordersByPubId.get(orderPublicId);
    if (!order) throw notFound("ORDER_NOT_FOUND");
    const resolved = resolveRole(principal, order);
    if (!resolved) throw notFound("ORDER_NOT_FOUND");
    return toView(order, resolved.role, resolved.hasBillingGrant);
  }

  return {
    assertCanReadOrder,
    async assertCanWriteOrder(
      principal: SessionPrincipal,
      orderPublicId: string,
      _opts: { kind?: string; tx?: DbOrTx; forUpdate?: boolean },
    ) {
      const view = await assertCanReadOrder(principal, orderPublicId);
      if (view.accessRole !== "staff" && view.accessRole !== "admin") throw notFound("ORDER_NOT_FOUND");
      return view;
    },
    async readableOrderFilter(principal: SessionPrincipal) {
      if (principal.role === "admin" || principal.role === "staff") return { all: true };
      const ids: number[] = [];
      for (const o of ordersByPubId.values()) {
        if (o.ownerUserId === principal.userId) ids.push(o.id);
      }
      return { all: false, orderIds: ids, truncated: false };
    },
    async getOrderRefById(orderId: number, _tx?: DbOrTx) {
      const o = byId().get(orderId);
      if (!o) return null;
      return {
        id: o.id,
        publicId: o.publicId,
        reference: o.reference,
        ownerUserId: o.ownerUserId,
        lockState: o.lockState,
        statusKey: "in_progress",
      };
    },
  } as unknown as OrdersModule;
}

function signStripeWebhook(rawBody: Buffer, webhookSecret: string, timestampSec: number): string {
  const signedPayload = Buffer.concat([Buffer.from(`${timestampSec}.`, "utf8"), rawBody]);
  const v1 = createHmac("sha256", webhookSecret).update(signedPayload).digest("hex");
  return `t=${timestampSec},v1=${v1}`;
}

describe("Increment 06 — D5 small totals, D15 payment receipts & refund notes, D11 signature check", () => {
  let tdb: TestDb;
  let adminPrincipal: SessionPrincipal;
  let staffPrincipal: SessionPrincipal;
  let customerAPrincipal: SessionPrincipal;
  let customerBPrincipal: SessionPrincipal;
  const ordersMap = new Map<string, FakeOrderRecord>();
  let orderSeq = 900;
  let stripeSeq = 1;

  beforeAll(async () => {
    tdb = await createTestDb({
      schema: {
        users,
        ...complianceSchema,
        ...paymentsSchema,
      },
    });

    const now = new Date("2026-11-23T12:00:00.000Z");
    const seed = [
      { key: "admin", role: "admin" as const, email: "rcpt-admin@example.test", name: "Admin Operator", customerRef: null },
      { key: "staff", role: "staff" as const, email: "rcpt-staff@example.test", name: "Staff Operator", customerRef: null },
      {
        key: "custA",
        role: "customer" as const,
        email: "maria@example.test",
        name: "María Elena García-López",
        customerRef: "CUST-2026-0042",
      },
      {
        key: "custB",
        role: "customer" as const,
        email: "other@example.test",
        name: "Jordan Taylor",
        customerRef: "CUST-2026-0099",
      },
    ];

    const t = createTestDeps({ db: tdb.db, now });
    const ids: Record<string, { id: number; publicId: string }> = {};
    for (const [idx, u] of seed.entries()) {
      const pubId = ulid(now.getTime() + idx * 25);
      const [ins] = await tdb.db.insert(users).values({
        publicId: pubId,
        customerRef: u.customerRef,
        emailEnc: t.deps.crypto.encrypt(u.email, `users.email:${pubId}`),
        emailIndex: `${idx + 80}`.padStart(64, "c"),
        nameEnc: t.deps.crypto.encrypt(u.name, `users.name:${pubId}`),
        role: u.role,
        status: "active",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      ids[u.key] = { id: ins.insertId, publicId: pubId };
    }

    adminPrincipal = fakePrincipal({
      userId: ids.admin!.id,
      userPublicId: ids.admin!.publicId,
      role: "admin",
      stepUpAt: now,
    });
    staffPrincipal = fakePrincipal({
      userId: ids.staff!.id,
      userPublicId: ids.staff!.publicId,
      role: "staff",
      stepUpAt: now,
    });
    customerAPrincipal = fakePrincipal({
      userId: ids.custA!.id,
      userPublicId: ids.custA!.publicId,
      role: "customer",
    });
    customerBPrincipal = fakePrincipal({
      userId: ids.custB!.id,
      userPublicId: ids.custB!.publicId,
      role: "customer",
    });
  });

  afterAll(async () => {
    await tdb?.cleanup();
  });

  function createHarness() {
    let clockMs = Date.parse("2026-11-23T12:00:00.000Z");
    const t = createTestDeps({ db: tdb.db, now: new Date(clockMs) });
    t.deps.clock.now = () => new Date(clockMs);

    const testLogger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return testLogger;
      },
    };

    const stripeSessions = new Map<
      string,
      {
        id: string;
        url: string;
        livemode: boolean;
        status: "open" | "complete";
        payment_status: "unpaid" | "paid";
        amount_total: number;
        currency: string;
        expires_at: number;
        metadata: Record<string, string>;
        payment_intent: {
          id: string;
          status: string;
          amount_received: number;
          amount_refunded: number;
          created: number;
          latest_charge?: {
            payment_method_details?: {
              card?: {
                brand?: string;
                last4?: string;
              };
            };
          };
        };
      }
    >();

    const fetchPinned = async (
      url: URL | string,
      purpose: EgressPurpose,
      options?: EgressFetchOptions,
    ): Promise<EgressFetchResponse> => {
      const u = typeof url === "string" ? new URL(url) : url;
      const opts = options ?? {};
      if (opts.beforeSend) await opts.beforeSend();
      if (purpose !== "stripe" || u.hostname !== "api.stripe.com") {
        throw new DomainError("FORBIDDEN", "EGRESS_HOST_DENIED", "Blocked by test egress.");
      }

      if (opts.method === "POST" && u.pathname === "/v1/checkout/sessions") {
        const form = new URLSearchParams(typeof opts.body === "string" ? opts.body : "");
        const seq = stripeSeq++;
        const id = `cs_test_inc06_${String(seq).padStart(4, "0")}`;
        const piId = `pi_test_inc06_${String(seq).padStart(4, "0")}`;
        const amount = Number.parseInt(form.get("line_items[0][price_data][unit_amount]") ?? "0", 10);
        const currency = (form.get("line_items[0][price_data][currency]") ?? "usd").toLowerCase();
        const session = {
          id,
          url: `https://checkout.stripe.com/c/pay/${id}`,
          livemode: false,
          status: "open" as const,
          payment_status: "unpaid" as const,
          amount_total: amount,
          currency,
          expires_at: Math.floor(clockMs / 1000) + 1800,
          metadata: {
            attempt_public_id: form.get("metadata[attempt_public_id]") ?? "",
            invoice_public_id: form.get("metadata[invoice_public_id]") ?? "",
            order_public_id: form.get("metadata[order_public_id]") ?? "",
          },
          payment_intent: {
            id: piId,
            status: "requires_payment_method",
            amount_received: 0,
            amount_refunded: 0,
            created: Math.floor(clockMs / 1000),
          },
        };
        stripeSessions.set(id, session);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(session), "utf8"),
        };
      }

      if (opts.method === "GET" && u.pathname.startsWith("/v1/checkout/sessions/")) {
        const sessionId = decodeURIComponent(u.pathname.slice("/v1/checkout/sessions/".length));
        const found = stripeSessions.get(sessionId);
        if (!found) {
          return { status: 404, headers: { "content-type": "application/json" }, body: Buffer.from("{}", "utf8") };
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(found), "utf8"),
        };
      }

      if (opts.method === "POST" && u.pathname === "/v1/refunds") {
        const form = new URLSearchParams(typeof opts.body === "string" ? opts.body : "");
        const seq = stripeSeq++;
        const refundObj = {
          id: `re_test_inc06_${String(seq).padStart(4, "0")}`,
          object: "refund",
          amount: Number.parseInt(form.get("amount") ?? "0", 10),
          currency: "usd",
          payment_intent: form.get("payment_intent") ?? "",
          status: "succeeded",
          created: Math.floor(clockMs / 1000),
          metadata: {
            refund_public_id: form.get("metadata[refund_public_id]") ?? "",
            order_public_id: form.get("metadata[order_public_id]") ?? "",
            invoice_public_id: form.get("metadata[invoice_public_id]") ?? "",
          },
        };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(refundObj), "utf8"),
        };
      }

      return { status: 404, headers: { "content-type": "application/json" }, body: Buffer.from("{}", "utf8") };
    };

    const referralPaidCalls: string[] = [];
    const suspendedUserIds = new Set<number>();

    const servicesObj = Object.assign(t.services, {
      config: { ...t.config, canonicalOrigin: "https://portal.readypackets.test" },
      logger: testLogger,
      identity: {
        sessions: {
          async assertCurrent(principal: SessionPrincipal) {
            return { ...principal, pendingSteps: [] };
          },
          async getState(sessionId: string) {
            const all = [adminPrincipal, staffPrincipal, customerAPrincipal, customerBPrincipal];
            const found = all.find((p) => p.sessionId === sessionId);
            if (!found) return null;
            const suspended = suspendedUserIds.has(found.userId);
            return {
              live: !suspended,
              userId: found.userId,
              userPublicId: found.userPublicId,
              userStatus: suspended ? ("suspended" as const) : ("active" as const),
              authMethod: found.authMethod,
              role: found.role,
              state: found.state,
              pendingSteps: found.pendingSteps,
              stepUpAt: found.stepUpAt,
              mfaVerifiedAt: found.mfaVerifiedAt,
            };
          },
        },
      },
      orders: buildFakeOrders(ordersMap),
      integrations: {
        egress: {
          fetchPinned,
          async listPresets() {
            return [
              {
                key: "stripe",
                label: "Stripe API",
                purpose: "stripe",
                parameterized: false,
                hosts: ["api.stripe.com"],
                enabled: true,
                matchingRulePublicIds: [],
              },
            ];
          },
        },
      },
      referrals: {
        async onInvoicePaid(ev: { invoicePublicId: string }) {
          referralPaidCalls.push(ev.invoicePublicId);
        },
      },
    }) as unknown as Services;

    const moduleDeps: ModuleDeps = {
      ...t.deps,
      logger: testLogger,
      config: { ...t.config, canonicalOrigin: "https://portal.readypackets.test" },
      services: servicesObj,
    };

    const compliance = createComplianceModule(moduleDeps);
    (servicesObj as unknown as Record<string, unknown>).compliance = compliance;
    const payments = createPaymentsModule(moduleDeps);
    (servicesObj as unknown as Record<string, unknown>).payments = payments;
    compliance.init?.();
    payments.init?.();

    function seedOrder(owner: SessionPrincipal): FakeOrderRecord {
      const seq = ++orderSeq;
      const pubId = ulid(clockMs + seq);
      const rec: FakeOrderRecord = {
        id: seq,
        publicId: pubId,
        reference: `RP-2026-0${seq}`,
        ownerUserId: owner.userId,
        ownerPublicId: owner.userPublicId,
        lockState: "none",
        origin: "portal",
      };
      ordersMap.set(pubId, rec);
      return rec;
    }

    const complianceCaller = (session: SessionPrincipal | null) =>
      createCallerFactory(complianceRouter)({
        services: servicesObj,
        session,
        request: newRequestContext("test"),
        transport: { issue() {}, clear() {} },
      });

    const paymentsCaller = (session: SessionPrincipal | null) =>
      createCallerFactory(paymentsRouter)({
        services: servicesObj,
        session,
        request: newRequestContext("test"),
        transport: { issue() {}, clear() {} },
      });

    return {
      t,
      moduleDeps,
      servicesObj,
      compliance,
      payments,
      stripeSessions,
      referralPaidCalls,
      suspendedUserIds,
      seedOrder,
      complianceCaller,
      paymentsCaller,
      spawnFreshComplianceCaller(session: SessionPrincipal | null) {
        const freshT = createTestDeps({ db: tdb.db, now: new Date(clockMs) });
        freshT.deps.clock.now = () => new Date(clockMs);
        const freshServices = Object.assign({}, servicesObj) as Services;
        const freshDeps: ModuleDeps = {
          ...freshT.deps,
          logger: testLogger,
          config: { ...freshT.config, canonicalOrigin: "https://portal.readypackets.test" },
          services: freshServices,
        };
        const freshCompliance = createComplianceModule(freshDeps);
        (freshServices as unknown as Record<string, unknown>).compliance = freshCompliance;
        freshCompliance.init?.();
        return createCallerFactory(complianceRouter)({
          services: freshServices,
          session,
          request: newRequestContext("test"),
          transport: { issue() {}, clear() {} },
        });
      },
      advanceClockMs(delta: number) {
        clockMs += delta;
      },
      nowSec() {
        return Math.floor(clockMs / 1000);
      },
    };
  }

  it("parses legacy/partial D5 and D15 settings defensively and validates PNG/PDF embedding", () => {
    expect(parsePaymentsSmallTotals(undefined)).toEqual(DEFAULT_PAYMENTS_SMALL_TOTALS);
    expect(parsePaymentsSmallTotals("block")).toEqual({
      belowProviderMinimum: "block",
    });
    expect(
      parsePaymentsSmallTotals({
        belowProviderMinimum: "waive",
        minimumOverrides: { stripe: { usd: 75, bad: -5 }, bogus: { USD: 100 } },
      }),
    ).toEqual({
      belowProviderMinimum: "waive",
      minimumOverrides: { stripe: { USD: 75 } },
    });

    expect(parsePaymentsReceiptsSetting(undefined)).toEqual(DEFAULT_PAYMENTS_RECEIPTS);
    expect(parsePaymentsReceiptsSetting(false)).toEqual({
      ...DEFAULT_PAYMENTS_RECEIPTS,
      enabled: false,
    });

    // Embedded brand PNG parses cleanly and produces a valid tagged PDF 1.4 with /Subtype /Image
    const pdf = renderPaymentReceiptPdf({
      schemaVersion: 1,
      receiptPublicId: "01J0000000000000000000RCPT",
      receiptNumber: "RPR-2026-000001",
      settlementKind: "provider_online",
      issuedAt: "2026-11-23T12:00:00.000Z",
      invoicePublicId: "01J0000000000000000000INVC",
      invoiceNumber: "INV-2026-000001",
      paymentPublicId: "01J0000000000000000000PMNT",
      orderPublicId: "01J0000000000000000000ORDR",
      orderReference: "RP-2026-0901",
      company: {
        legalName: "ReadyPackets LLC",
        address: "100 Market St\nSuite 400",
        contact: "billing@example.test",
        taxId: "EIN 12-3456789",
        logoMode: "brand",
        logoBrandPath: "/brand/readypackets-approved-header-wordmark-light.png",
      },
      customer: {
        name: "María Elena García-López",
        customerRef: "CUST-2026-0042",
        email: "maria@example.test",
      },
      currency: "USD",
      lines: [
        { position: 1, description: "Packet 1 — Standard", quantity: 1, unitAmountMinor: 15_000, lineTotalMinor: 15_000 },
      ],
      subtotalMinor: 15_000,
      discountMinor: 1_000,
      bundleDiscountMinor: 500,
      discountLabel: "Bundle discount",
      promoDiscountMinor: 500,
      promoLabel: "WELCOME10",
      taxMinor: 0,
      amountWaivedMinor: 0,
      amountPaidMinor: 14_000,
      paymentMethod: "provider_online",
      paymentMethodBrand: "visa",
      paymentMethodLast4: "4242",
      provider: "stripe",
      providerReference: "pi_test_0001",
      footerText: "Retain this receipt for your compliance audit file.",
    });
    const pdfAscii = pdf.toString("latin1");
    expect(pdfAscii.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdfAscii).toContain("/StructTreeRoot");
    expect(pdfAscii).toContain("/Subtype /Image");
    expect(pdfAscii).toContain("RPR-2026-000001");
    expect(pdfAscii).toContain("Visa ending in 4242");
    expect(parsePngForPdf(Buffer.from("not-a-png"))).toBeNull();
  });

  it("D5: evaluates checkout amounts, blocks sub-minimum when configured, waives sub-minimum without cash refund/referral exposure, and settles $0 totals idempotently", async () => {
    const h = createHarness();
    const webhookSecret = "whsec_test_inc06_small_totals_secret_123456";
    await h.paymentsCaller(adminPrincipal).admin.updateSettings({
      provider: "stripe",
      mode: "test",
      currency: "USD",
      stripeSecretKey: "sk_test_inc06_small_totals_key_1234567890",
      stripeWebhookSecret: webhookSecret,
      smallTotals: { belowProviderMinimum: "block" },
    });

    // 1. evaluateCheckoutAmount reflects active Stripe $0.50 minimum
    const evalZero = await h.payments.evaluateCheckoutAmount(0, "USD");
    expect(evalZero.smallTotalAction).toBe("zero_total");
    expect(evalZero.minimumMinor).toBe(0);

    const evalBlocked = await h.payments.evaluateCheckoutAmount(35, "USD");
    expect(evalBlocked.smallTotalAction).toBe("block");
    expect(evalBlocked.minimumMinor).toBe(50);

    const evalNormal = await h.payments.evaluateCheckoutAmount(50, "USD");
    expect(evalNormal.smallTotalAction).toBe("none");

    // 2. Sub-minimum invoice ($0.35) under `block` refuses before provider call & creates zero attempts
    const ordBlocked = h.seedOrder(customerAPrincipal);
    const invBlocked = await tdb.db.transaction((tx) =>
      h.compliance.invoices.issueCheckoutInvoiceInTx(
        {
          principal: customerAPrincipal,
          orderId: ordBlocked.id,
          orderPublicId: ordBlocked.publicId,
          currency: "USD",
          lines: [{ description: "Discounted Packet", quantity: 1, unitAmountMinor: 1_000 }],
          discountMinor: 965,
          taxMinor: 0,
        },
        tx,
      ),
    );
    expect(invBlocked.totalMinor).toBe(35);

    await expect(
      h.payments.startCheckout(invBlocked.invoicePublicId, undefined, {
        principal: customerAPrincipal,
        idempotencyKey: `idem-block-${invBlocked.invoicePublicId}`,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "AMOUNT_BELOW_PROVIDER_MINIMUM",
      details: { minimumMinor: 50, balanceDueMinor: 35, currency: "USD" },
    });

    const attemptsAfterBlock = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.invoicePublicId, invBlocked.invoicePublicId));
    expect(attemptsAfterBlock).toHaveLength(0);

    // 3. Switch to `waive` (default) -> $0.35 settles immediately with waived receipt, 0 cash captured, non-refundable, no referral payout
    await h.paymentsCaller(adminPrincipal).admin.updateSettings({
      provider: "stripe",
      mode: "test",
      currency: "USD",
      smallTotals: { belowProviderMinimum: "waive" },
    });
    expect((await h.payments.evaluateCheckoutAmount(35, "USD")).smallTotalAction).toBe("waive");

    const waivedRes = await h.payments.startCheckout(invBlocked.invoicePublicId, undefined, {
      principal: customerAPrincipal,
      idempotencyKey: `idem-waive-${invBlocked.invoicePublicId}`,
    });
    expect(waivedRes).toMatchObject({
      mode: "settled",
      settlementKind: "waived_small_total",
      invoicePublicId: invBlocked.invoicePublicId,
      waivedMinor: 35,
    });
    if (waivedRes.mode !== "settled") throw new Error("Expected settled result");
    expect(waivedRes.receiptPublicId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(h.referralPaidCalls).not.toContain(invBlocked.invoicePublicId);

    // Idempotent replay of waived checkout returns same receiptPublicId without a second email
    const sentBeforeReplay = h.t.mailer.sent.length;
    const waivedReplay = await h.payments.startCheckout(invBlocked.invoicePublicId, undefined, {
      principal: customerAPrincipal,
      idempotencyKey: `idem-waive-${invBlocked.invoicePublicId}`,
    });
    expect(waivedReplay).toEqual(waivedRes);
    expect(h.t.mailer.sent.length).toBe(sentBeforeReplay);

    const waivedReceipt = await h.compliance.receipts.get(customerAPrincipal, waivedRes.receiptPublicId!);
    expect(waivedReceipt.receiptNumber).toMatch(/^RPR-2026-\d{6}$/);
    expect(waivedReceipt.amountWaivedMinor).toBe(35);
    expect(waivedReceipt.amountPaidMinor).toBe(0);
    expect(waivedReceipt.settlementKind).toBe("waived_small_total");

    // Accounting boundary + checkout status: waived nominal amount is NEVER reported as captured cash
    const waivedInvoiceDetail = await h.complianceCaller(customerAPrincipal).invoices.get({
      invoicePublicId: invBlocked.invoicePublicId,
    });
    expect(waivedInvoiceDetail.status).toBe("paid");
    expect(waivedInvoiceDetail.grossPaidMinor).toBe(0);
    expect(waivedInvoiceDetail.netPaidMinor).toBe(0);
    expect(waivedInvoiceDetail.waivedMinor).toBe(35);
    expect(waivedInvoiceDetail.balanceDueMinor).toBe(0);

    const checkoutStatusAfterWaive = await h.payments.getCheckoutStatus(customerAPrincipal, {
      invoicePublicId: invBlocked.invoicePublicId,
    });
    expect(checkoutStatusAfterWaive.invoiceStatus).toBe("paid");
    expect(checkoutStatusAfterWaive.balanceDueMinor).toBe(0);
    expect(checkoutStatusAfterWaive.waivedMinor).toBe(35);
    expect(checkoutStatusAfterWaive.receiptPublicId).toBe(waivedRes.receiptPublicId);

    // Waived payment CANNOT be refunded in cash
    const ledger = await h.compliance.invoices.listOrderPaymentsAndRefunds(ordBlocked.publicId);
    expect(ledger.payments).toHaveLength(1);
    expect(ledger.payments[0]?.capturedMinor).toBe(0);
    await expect(
      h.compliance.invoices.admin.recordRefund(adminPrincipal, {
        invoicePublicId: invBlocked.invoicePublicId,
        paymentPublicId: ledger.payments[0]!.paymentPublicId,
        amountMinor: 35,
        currency: "USD",
        reasonCode: "customer_request",
        reference: "REF-BLOCK-WAIVED",
        confirmationPhrase: "REFUND ORDER",
        idempotencyKey: "idem-ref-waived",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "WAIVED_PAYMENT_NOT_REFUNDABLE",
    });

    // 4. $0.00 zero-total invoice settles with `zero_total` receipt and idempotent replay
    const ordZero = h.seedOrder(customerAPrincipal);
    const invZero = await tdb.db.transaction((tx) =>
      h.compliance.invoices.issueCheckoutInvoiceInTx(
        {
          principal: customerAPrincipal,
          orderId: ordZero.id,
          orderPublicId: ordZero.publicId,
          currency: "USD",
          lines: [{ description: "Free Promo Packet", quantity: 1, unitAmountMinor: 5_000 }],
          discountMinor: 5_000,
          taxMinor: 0,
        },
        tx,
      ),
    );
    const zeroRes = await h.payments.startCheckout(invZero.invoicePublicId, undefined, {
      principal: customerAPrincipal,
      idempotencyKey: `idem-zero-${invZero.invoicePublicId}`,
    });
    expect(zeroRes).toMatchObject({
      mode: "settled",
      settlementKind: "zero_total",
      invoicePublicId: invZero.invoicePublicId,
    });
    if (zeroRes.mode !== "settled") throw new Error("Expected settled");
    const zeroReceipt = await h.compliance.receipts.get(customerAPrincipal, zeroRes.receiptPublicId!);
    expect(zeroReceipt.amountPaidMinor).toBe(0);
    expect(zeroReceipt.amountWaivedMinor).toBe(0);
    expect(zeroReceipt.settlementKind).toBe("zero_total");
  });

  it("D15: issues immutable receipts for Stripe webhook & manual payments, attaches PDF to mail, enforces ownership, rate-limits resend, and appends refund notes", async () => {
    const h = createHarness();
    const webhookSecret = "whsec_test_inc06_receipt_webhook_secret_789";
    await h.paymentsCaller(adminPrincipal).admin.updateSettings({
      provider: "stripe",
      mode: "test",
      currency: "USD",
      stripeSecretKey: "sk_test_inc06_receipt_secret_key_1234567890",
      stripeWebhookSecret: webhookSecret,
      receipts: {
        enabled: true,
        emailCustomer: true,
        footerText: "Thank you for choosing ReadyPackets.",
      },
    });
    await h.complianceCaller(adminPrincipal).invoices.admin.companyProfile.update({
      issuerName: "ReadyPackets Compliance Corp",
      issuerAddress: "500 Enterprise Way",
      issuerContact: "receipts@example.test",
      issuerTaxId: "TAX-99-887766",
      issuerLogo: {
        mode: "brand",
        brandPath: "/brand/readypackets-approved-header-wordmark-light.png",
      },
    });

    // 1. Online Stripe checkout -> verified webhook -> receipt with Visa *4242 + PDF email attachment
    const ordOnline = h.seedOrder(customerAPrincipal);
    const invOnline = await tdb.db.transaction((tx) =>
      h.compliance.invoices.issueCheckoutInvoiceInTx(
        {
          principal: customerAPrincipal,
          orderId: ordOnline.id,
          orderPublicId: ordOnline.publicId,
          currency: "USD",
          lines: [{ description: "Enterprise Packet", quantity: 1, unitAmountMinor: 14_900 }],
          discountMinor: 0,
          taxMinor: 0,
        },
        tx,
      ),
    );

    const started = await h.payments.startCheckout(invOnline.invoicePublicId, undefined, {
      principal: customerAPrincipal,
      idempotencyKey: "idem-stripe-rcpt-1",
    });
    expect(started.mode).toBe("redirect");
    if (started.mode !== "redirect") throw new Error("Expected redirect");

    const sessionEntry = [...h.stripeSessions.values()][0]!;
    sessionEntry.status = "complete";
    sessionEntry.payment_status = "paid";
    sessionEntry.payment_intent.status = "succeeded";
    sessionEntry.payment_intent.amount_received = 14_900;
    sessionEntry.payment_intent.latest_charge = {
      payment_method_details: {
        card: { brand: "visa", last4: "4242" },
      },
    };

    const whPayload = Buffer.from(
      JSON.stringify({
        id: "evt_inc06_paid_0001",
        object: "event",
        type: "checkout.session.completed",
        livemode: false,
        created: h.nowSec(),
        data: { object: sessionEntry },
      }),
      "utf8",
    );
    const sig = signStripeWebhook(whPayload, webhookSecret, h.nowSec());
    const whRes = await h.payments.handleSignedWebhook({
      provider: "stripe",
      rawBody: whPayload,
      headers: { "stripe-signature": sig },
      notificationUrl: "https://portal.readypackets.test/api/payments/webhooks/stripe",
    });
    expect(whRes.booked).toBe(true);

    const orderReceipts = await h.complianceCaller(customerAPrincipal).receipts.forOrder({
      orderPublicId: ordOnline.publicId,
    });
    expect(orderReceipts).toHaveLength(1);
    const onlineReceipt = orderReceipts[0]!;
    expect(onlineReceipt.receiptNumber).toMatch(/^RPR-2026-\d{6}$/);
    expect(onlineReceipt.amountPaidMinor).toBe(14_900);
    expect(onlineReceipt.paymentMethodBrand).toBe("visa");
    expect(onlineReceipt.paymentMethodLast4).toBe("4242");

    const lastMail = h.t.mailer.last("payment_receipt");
    expect(lastMail).toBeDefined();
    expect(lastMail?.vars).toEqual({ receiptNumber: onlineReceipt.receiptNumber });
    expect(lastMail?.attachments?.[0]?.filename).toBe(`${onlineReceipt.receiptNumber}.pdf`);

    // Download original PDF and capture SHA-256 to prove immutability across refunds
    const origPdfDownload = await h.compliance.receipts.downloadReceiptPdf(
      customerAPrincipal,
      onlineReceipt.receiptPublicId,
    );
    expect(origPdfDownload.buffer.toString("latin1")).toContain("ReadyPackets Compliance Corp");
    expect(origPdfDownload.buffer.toString("latin1")).toContain("Visa ending in 4242");

    // Ownership enforcement: Customer B gets NOT_FOUND on get, forOrder, and downloadReceiptPdf
    await expect(
      h.complianceCaller(customerBPrincipal).receipts.get({ receiptPublicId: onlineReceipt.receiptPublicId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      h.compliance.receipts.downloadReceiptPdf(customerBPrincipal, onlineReceipt.receiptPublicId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // 2. Partial refund ($49.00) + remaining refund ($100.00) via `payments.refunds.create` -> original receipt PDF unchanged, two RPRN notes appended!
    const ledger = await h.compliance.invoices.listOrderPaymentsAndRefunds(ordOnline.publicId);
    const paymentPubId = ledger.payments[0]!.paymentPublicId;

    await h.paymentsCaller(adminPrincipal).refunds.create({
      orderPublicId: ordOnline.publicId,
      paymentPublicId: paymentPubId,
      amountMinor: 4_900,
      currency: "USD",
      reason: "Partial scope adjustment",
      sendCustomerNotice: false,
      confirmationPhrase: "REFUND ORDER",
      idempotencyKey: "idem-rfd-partial-1",
    });

    const afterPartial = await h.complianceCaller(customerAPrincipal).receipts.get({
      receiptPublicId: onlineReceipt.receiptPublicId,
    });
    expect(afterPartial.refundState).toBe("partially_refunded");
    expect(afterPartial.refundedMinor).toBe(4_900);
    expect(afterPartial.refundNotes).toHaveLength(1);
    expect(afterPartial.refundNotes[0]?.noteNumber).toMatch(/^RPRN-2026-\d{6}$/);
    expect(afterPartial.refundNotes[0]?.resultingRefundState).toBe("partially_refunded");

    await h.paymentsCaller(adminPrincipal).refunds.create({
      orderPublicId: ordOnline.publicId,
      paymentPublicId: paymentPubId,
      amountMinor: 10_000,
      currency: "USD",
      reason: "Remaining balance refund",
      sendCustomerNotice: false,
      confirmationPhrase: "REFUND ORDER",
      idempotencyKey: "idem-rfd-full-2",
    });

    const afterFull = await h.complianceCaller(customerAPrincipal).receipts.get({
      receiptPublicId: onlineReceipt.receiptPublicId,
    });
    expect(afterFull.refundState).toBe("refunded");
    expect(afterFull.refundedMinor).toBe(14_900);
    expect(afterFull.refundNotes).toHaveLength(2);
    expect(afterFull.refundNotes[1]?.resultingRefundState).toBe("refunded");

    // Original receipt PDF bytes remain 100% identical; refund note PDF streams cleanly
    const postRefundPdf = await h.compliance.receipts.downloadReceiptPdf(
      customerAPrincipal,
      onlineReceipt.receiptPublicId,
    );
    expect(postRefundPdf.buffer.equals(origPdfDownload.buffer)).toBe(true);

    const notePdf = await h.compliance.receipts.downloadRefundNotePdf(
      customerAPrincipal,
      afterFull.refundNotes[0]!.notePublicId,
    );
    expect(notePdf.buffer.toString("latin1")).toContain("REFUND NOTE");
    expect(notePdf.buffer.toString("latin1")).toContain(onlineReceipt.receiptNumber);

    // 3. Staff "Send again" (`receipts.admin.resend`) — capability guard before `.input()`, audited, and rate-limited at 3/hr
    await expect(
      h.complianceCaller(null).receipts.admin.resend({ receiptPublicId: "bad" } as never),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      h.complianceCaller(customerAPrincipal).receipts.admin.resend({ receiptPublicId: "bad" } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    for (let i = 1; i <= 3; i += 1) {
      h.advanceClockMs(61_000);
      const resent = await h.complianceCaller(staffPrincipal).receipts.admin.resend({
        receiptPublicId: onlineReceipt.receiptPublicId,
      });
      expect(resent.resendCount).toBe(i);
      expect(resent.attachment).toBe("attached");
    }

    // Immediate retry within 60s hits cooldown; retry after 61s (4th within the hour) hits 3/hr rate limit
    await expect(
      h.complianceCaller(staffPrincipal).receipts.admin.resend({
        receiptPublicId: onlineReceipt.receiptPublicId,
      }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      cause: expect.objectContaining({
        code: "RATE_LIMITED",
        reasonCode: "RECEIPT_RESEND_COOLDOWN",
      }),
    });

    h.advanceClockMs(61_000);
    await expect(
      h.complianceCaller(staffPrincipal).receipts.admin.resend({
        receiptPublicId: onlineReceipt.receiptPublicId,
      }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      cause: expect.objectContaining({
        code: "RATE_LIMITED",
        reasonCode: "RECEIPT_RESEND_RATE_LIMITED",
      }),
    });
    expect(h.t.audit.named("compliance.receipt.resend_rate_limited").length).toBeGreaterThanOrEqual(2);

    // 4. Manual payment recorded by staff also issues a sequential receipt visible in `myList`
    const ordManual = h.seedOrder(customerAPrincipal);
    const draftInv = await h.compliance.invoices.admin.createDraft(adminPrincipal, {
      orderPublicId: ordManual.publicId,
      currency: "USD",
      lines: [{ description: "Wire Packet", quantity: 1, unitAmountMinor: 25_000 }],
      discountMinor: 0,
      taxMinor: 0,
    });
    await h.compliance.invoices.admin.issue(adminPrincipal, {
      invoicePublicId: draftInv.invoicePublicId,
    });
    await h.compliance.invoices.admin.recordManualPayment(adminPrincipal, {
      invoicePublicId: draftInv.invoicePublicId,
      method: "bank_transfer",
      amountMinor: 25_000,
      currency: "USD",
      reference: "WIRE-2026-7788",
      receivedAt: new Date("2026-11-23T12:10:00.000Z"),
      idempotencyKey: "idem-manual-wire-rcpt",
    });

    const myList = await h.complianceCaller(customerAPrincipal).receipts.myList({ limit: 10 });
    expect(myList.items.some((r) => r.orderPublicId === ordManual.publicId && r.amountPaidMinor === 25_000)).toBe(true);
  });

  it("D11 + D14: enforces require/warn/off typed-signature name matching, folds diacritics & middle names, and guards admin settings before input()", async () => {
    const h = createHarness();

    // Pure comparator checks
    expect(normalizeSignatureName("  María   García-López  ")).toBe("maria garcia lopez");
    expect(compareTypedSignatureToAccountName("maria garcia-lopez", "María Elena García-López")).toEqual({
      matched: true,
      kind: "first_last",
    });
    expect(compareTypedSignatureToAccountName("MARIA ELENA GARCIA LOPEZ", "María Elena García-López")).toEqual({
      matched: true,
      kind: "exact",
    });
    expect(compareTypedSignatureToAccountName("Alex Wrong", "María Elena García-López")).toEqual({
      matched: false,
    });

    // Router capability guards fire BEFORE `.input()` (UNAUTHORIZED / FORBIDDEN, never 400 BAD_INPUT)
    await expect(
      h.complianceCaller(null).policies.admin.signatureNameCheck.update({ mode: "invalid" } as never),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      h.complianceCaller(customerAPrincipal).policies.admin.signatureNameCheck.update({ mode: "invalid" } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.complianceCaller(null).invoices.admin.companyProfile.update({} as never),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      h.complianceCaller(customerAPrincipal).invoices.admin.companyProfile.update({} as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Create a typed-signature policy
    const doc = await h.compliance.policies.admin.createDocument(adminPrincipal, {
      slug: "mnda-d11",
      title: "Mutual NDA",
      audience: "customer",
      requiresAcceptance: true,
      requiresTypedSignature: true,
      versionLabel: "1.0",
      contentFormat: "safe_markdown",
      bodyText: "# Mutual NDA\nConfidentiality terms.",
    });
    const pubV1 = await h.compliance.policies.admin.publishVersion(adminPrincipal, {
      versionPublicId: doc.draftVersionPublicId,
    });

    // Default `mode: "require"` rejects mismatched name with `SIGNER_NAME_MISMATCH` + expectedName + `/account`
    await expect(
      h.complianceCaller(customerAPrincipal).policies.accept({
        versionPublicId: pubV1.versionPublicId,
        contentHash: pubV1.contentHash,
        method: "typed_signature",
        signerName: "Completely Different Name",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({
        code: "VALIDATION",
        reasonCode: "SIGNER_NAME_MISMATCH",
        details: expect.objectContaining({
          expectedName: "María Elena García-López",
          profilePath: "/account",
        }),
      }),
    });
    expect(h.t.audit.named("compliance.signature_name.mismatch").length).toBeGreaterThanOrEqual(1);

    // Accepts diacritic-folded first+last omitting middle name ("maria garcia-lopez") -> stores `first_last`
    const accV1 = await h.complianceCaller(customerAPrincipal).policies.accept({
      versionPublicId: pubV1.versionPublicId,
      contentHash: pubV1.contentHash,
      method: "typed_signature",
      signerName: "maria garcia-lopez",
    });
    expect(accV1.duplicate).toBe(false);

    const logList1 = await h.complianceCaller(adminPrincipal).policies.admin.acceptanceLog.list({});
    const item1 = logList1.items.find((i) => i.publicId === accV1.acceptancePublicId);
    expect(item1?.signatureMatch).toBe("first_last");

    // Switch to `mode: "warn"` on v2 -> allows mismatch and records `mismatch_warn` in Acceptance Log Centre
    await h.complianceCaller(adminPrincipal).policies.admin.signatureNameCheck.update({ mode: "warn" });
    const draftV2 = await h.compliance.policies.admin.createDraftVersion(adminPrincipal, {
      documentPublicId: doc.documentPublicId,
      versionLabel: "2.0",
      contentFormat: "safe_markdown",
      bodyText: "# Mutual NDA v2\nUpdated terms.",
    });
    const pubV2 = await h.compliance.policies.admin.publishVersion(adminPrincipal, {
      versionPublicId: draftV2.versionPublicId,
    });

    const accV2 = await h.complianceCaller(customerAPrincipal).policies.accept({
      versionPublicId: pubV2.versionPublicId,
      contentHash: pubV2.contentHash,
      method: "typed_signature",
      signerName: "Authorized Agent Signer",
    });
    const detail2 = await h.complianceCaller(adminPrincipal).policies.admin.acceptanceLog.detail({
      publicId: accV2.acceptancePublicId,
    });
    expect(detail2.signatureMatch).toBe("mismatch_warn");
  });

  it("D13 × D14 × D11 lockout regression: reports effective requiresTypedSignature across listPublished, myStatus, requiredAcceptancesFor, and enforcement.pending when orders.agreement_gate is typed_name, and reverts to false when disabled", async () => {
    const h = createHarness();
    const doc = await h.compliance.policies.admin.createDocument(adminPrincipal, {
      slug: "qa-mutual-nda",
      title: "QA Mutual NDA",
      audience: "customer",
      requiresAcceptance: true,
      requiresTypedSignature: false,
      versionLabel: "2.0",
      contentFormat: "plain_text",
      bodyText: "Mutual NDA governed by order agreement gate.",
    });
    const pub = await h.compliance.policies.admin.publishVersion(adminPrincipal, {
      versionPublicId: doc.draftVersionPublicId,
    });

    // Enable session enforcement with graceHours: 0 (immediate remediation)
    const enfStatus = await h.complianceCaller(adminPrincipal).policies.enforcement.status({
      documentPublicId: doc.documentPublicId,
    });
    await h.complianceCaller(adminPrincipal).policies.enforcement.configure({
      documentPublicId: doc.documentPublicId,
      expectedVersion: enfStatus.expectedVersion,
      mode: "required_to_continue",
      graceHours: 0,
      warningText: null,
      confirmedCount: enfStatus.affectedCount,
    });

    // Enable `orders.agreement_gate` targeting `qa-mutual-nda` with `signatureMode: "typed_name"`
    await h.t.settings.set("orders.agreement_gate", {
      enabled: true,
      policyPublicId: doc.documentPublicId,
      applyTo: { placeOrder: true, workOnOrder: true },
      signatureMode: "typed_name",
      askAgainOnNewVersion: true,
    });

    // 1. Every customer/acceptance listing reports effective `requiresTypedSignature: true`
    const published = await h.complianceCaller(customerAPrincipal).policies.listPublished({ slug: "qa-mutual-nda" });
    expect(published[0]?.requiresTypedSignature).toBe(true);

    const status = await h.complianceCaller(customerAPrincipal).policies.myStatus();
    expect(status.published.find((p) => p.documentPublicId === doc.documentPublicId)?.requiresTypedSignature).toBe(true);
    expect(status.pendingRequired.find((p) => p.documentPublicId === doc.documentPublicId)?.requiresTypedSignature).toBe(true);
    expect(status.expectedSignerName).toBe("María Elena García-López");

    const rawRequired = await h.compliance.requiredAcceptancesFor(customerAPrincipal.userId, { audience: "customer" });
    expect(rawRequired.find((p) => p.documentPublicId === doc.documentPublicId)?.requiresTypedSignature).toBe(true);

    const remediationPrincipal: SessionPrincipal = {
      ...customerAPrincipal,
      state: "remediation",
      pendingSteps: ["accept_policy"],
    };
    const pendingEnforcement = await h.complianceCaller(remediationPrincipal).policies.enforcement.pending();
    const enfItem = pendingEnforcement.find((p) => p.documentPublicId === doc.documentPublicId);
    expect(enfItem?.requiresTypedSignature).toBe(true);
    expect(enfItem?.blocking).toBe(true);

    // Admin document editor still sees the document's own stored flag (`false`)
    const adminDoc = await h.complianceCaller(adminPrincipal).policies.admin.getDocument({
      documentPublicId: doc.documentPublicId,
    });
    expect(adminDoc.document.requiresTypedSignature).toBe(false);

    // 2. When gate is switched to `checkbox` or disabled (`enabled: false`), effective flag reports `false`
    await h.t.settings.set("orders.agreement_gate", {
      enabled: true,
      policyPublicId: doc.documentPublicId,
      applyTo: { placeOrder: true, workOnOrder: true },
      signatureMode: "checkbox",
      askAgainOnNewVersion: true,
    });
    expect(
      (await h.complianceCaller(remediationPrincipal).policies.enforcement.pending()).find(
        (p) => p.documentPublicId === doc.documentPublicId,
      )?.requiresTypedSignature,
    ).toBe(false);

    await h.t.settings.set("orders.agreement_gate", {
      enabled: false,
      policyPublicId: doc.documentPublicId,
      applyTo: { placeOrder: true, workOnOrder: true },
      signatureMode: "typed_name",
      askAgainOnNewVersion: true,
    });
    expect(
      (await h.complianceCaller(customerAPrincipal).policies.myStatus()).pendingRequired.find(
        (p) => p.documentPublicId === doc.documentPublicId,
      )?.requiresTypedSignature,
    ).toBe(false);
    expect(
      (await h.complianceCaller(remediationPrincipal).policies.enforcement.pending()).find(
        (p) => p.documentPublicId === doc.documentPublicId,
      )?.requiresTypedSignature,
    ).toBe(false);

    // 3. Re-enable `typed_name` gate and complete `/accept-policy` remediation end-to-end:
    //    mismatch rejected with `SIGNER_NAME_MISMATCH` + `versionPublicId`, matching name unlocks remediation
    await h.t.settings.set("orders.agreement_gate", {
      enabled: true,
      policyPublicId: doc.documentPublicId,
      applyTo: { placeOrder: true, workOnOrder: true },
      signatureMode: "typed_name",
      askAgainOnNewVersion: true,
    });

    await expect(
      h.complianceCaller(remediationPrincipal).policies.enforcement.accept({
        versionPublicId: pub.versionPublicId,
        contentHash: pub.contentHash,
        signerName: "Wrong Signer",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({
        reasonCode: "SIGNER_NAME_MISMATCH",
        details: expect.objectContaining({
          expectedName: "María Elena García-López",
          profilePath: "/account",
          versionPublicId: pub.versionPublicId,
        }),
      }),
    });

    await h.complianceCaller(remediationPrincipal).policies.enforcement.accept({
      versionPublicId: pub.versionPublicId,
      contentHash: pub.contentHash,
      signerName: "María Elena García-López",
    });
    expect(
      await h.compliance.policyEnforcement.requiresRemediation(customerAPrincipal.userId, "customer"),
    ).toBe(false);
  });

  it("Wave 2 security regressions: blocks waiver when prior provider attempt has exposure, enforces DB-durable 3/hr resend across instances, and denies generic order collaborators on receipts/PDFs", async () => {
    const h = createHarness();
    const webhookSecret = "whsec_test_inc06_wave2_sec_regressions_999";
    await h.paymentsCaller(adminPrincipal).admin.updateSettings({
      provider: "stripe",
      mode: "test",
      currency: "USD",
      stripeSecretKey: "sk_test_inc06_wave2_sec_key_1234567890",
      stripeWebhookSecret: webhookSecret,
      smallTotals: {
        belowProviderMinimum: "waive",
        minimumOverrides: { stripe: { USD: 50 } },
      },
      receipts: {
        enabled: true,
        emailCustomer: true,
        footerText: "Retain for audit.",
      },
    });

    // (1) Pre-existing provider attempt under lock MUST block small-total waiver when minimum later rises
    const ordAttemptFirst = h.seedOrder(customerAPrincipal);
    const invAttemptFirst = await tdb.db.transaction((tx) =>
      h.compliance.invoices.issueCheckoutInvoiceInTx(
        {
          principal: customerAPrincipal,
          orderId: ordAttemptFirst.id,
          orderPublicId: ordAttemptFirst.publicId,
          currency: "USD",
          lines: [{ description: "Micro Add-on", quantity: 1, unitAmountMinor: 75 }],
          discountMinor: 0,
          taxMinor: 0,
        },
        tx,
      ),
    );

    // At $0.50 minimum, $0.75 creates a real Stripe checkout session (`redirected` with `providerRef`)
    const redirectAttempt = await h.payments.startCheckout(invAttemptFirst.invoicePublicId, undefined, {
      principal: customerAPrincipal,
      idempotencyKey: `idem-attempt-75-${invAttemptFirst.invoicePublicId}`,
    });
    expect(redirectAttempt.mode).toBe("redirect");

    // Admin raises Stripe USD minimum override to $1.00 (`100` minor) while the $0.75 session is still open externally
    await h.paymentsCaller(adminPrincipal).admin.updateSettings({
      provider: "stripe",
      mode: "test",
      currency: "USD",
      smallTotals: {
        belowProviderMinimum: "waive",
        minimumOverrides: { stripe: { USD: 100 } },
      },
    });

    // Attempting checkout with a fresh idempotency key MUST fail closed (`PAYMENT_ATTEMPT_OUTSTANDING`) — zero waiver rows & zero receipts
    await expect(
      h.payments.startCheckout(invAttemptFirst.invoicePublicId, undefined, {
        principal: customerAPrincipal,
        idempotencyKey: `idem-waive-blocked-by-attempt-${invAttemptFirst.invoicePublicId}`,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "PAYMENT_ATTEMPT_OUTSTANDING",
    });

    // Even if the customer locally cancels the attempt, prior attempt record still blocks waiver
    if (redirectAttempt.mode === "redirect") {
      await h.payments.cancelAttemptIfUnpaid(customerAPrincipal, { attemptPublicId: redirectAttempt.attemptPublicId });
    }
    await expect(
      h.payments.startCheckout(invAttemptFirst.invoicePublicId, undefined, {
        principal: customerAPrincipal,
        idempotencyKey: `idem-waive-blocked-after-cancel-${invAttemptFirst.invoicePublicId}`,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "PAYMENT_ATTEMPT_OUTSTANDING",
    });

    // Even a ref-less `failed` attempt (e.g. ambiguous network failure during provider session creation) blocks waiver
    const ordReflessFailed = h.seedOrder(customerAPrincipal);
    const invReflessFailed = await tdb.db.transaction((tx) =>
      h.compliance.invoices.issueCheckoutInvoiceInTx(
        {
          principal: customerAPrincipal,
          orderId: ordReflessFailed.id,
          orderPublicId: ordReflessFailed.publicId,
          currency: "USD",
          lines: [{ description: "Ambiguous Dispatch Item", quantity: 1, unitAmountMinor: 60 }],
          discountMinor: 0,
          taxMinor: 0,
        },
        tx,
      ),
    );
    const [invRowForRefless] = await tdb.db
      .select({ id: complianceSchema.complianceInvoices.id })
      .from(complianceSchema.complianceInvoices)
      .where(eq(complianceSchema.complianceInvoices.publicId, invReflessFailed.invoicePublicId))
      .limit(1);
    await tdb.db.insert(paymentAttempts).values({
      publicId: ulid(Date.now() + 999),
      orderPublicId: ordReflessFailed.publicId,
      invoiceId: invRowForRefless!.id,
      invoicePublicId: invReflessFailed.invoicePublicId,
      customerUserId: customerAPrincipal.userId,
      provider: "stripe",
      environment: "test",
      status: "failed",
      amountMinor: 60,
      currency: "USD",
      idempotencyKey: `idem-refless-failed-${invReflessFailed.invoicePublicId}`,
      successPath: "/checkout/complete",
      cancelPath: "/checkout/cancelled",
      failureReasonCode: "PROVIDER_NETWORK_TIMEOUT",
      createdAt: new Date("2026-11-23T12:05:00.000Z"),
      updatedAt: new Date("2026-11-23T12:05:00.000Z"),
    });
    await expect(
      h.payments.startCheckout(invReflessFailed.invoicePublicId, undefined, {
        principal: customerAPrincipal,
        idempotencyKey: `idem-waive-after-refless-${invReflessFailed.invoicePublicId}`,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "PAYMENT_ATTEMPT_OUTSTANDING",
    });

    const prematureReceipts = await h.compliance.receipts.forOrder(adminPrincipal, ordAttemptFirst.publicId);
    expect(prematureReceipts).toHaveLength(0);

    // (1b) Waived replay path validates live actor inside `tx` (suspended user rejected)
    const ordWaiveReplay = h.seedOrder(customerAPrincipal);
    const invWaiveReplay = await tdb.db.transaction((tx) =>
      h.compliance.invoices.issueCheckoutInvoiceInTx(
        {
          principal: customerAPrincipal,
          orderId: ordWaiveReplay.id,
          orderPublicId: ordWaiveReplay.publicId,
          currency: "USD",
          lines: [{ description: "Sub-min Item", quantity: 1, unitAmountMinor: 40 }],
          discountMinor: 0,
          taxMinor: 0,
        },
        tx,
      ),
    );
    const initialWaive = await h.payments.startCheckout(invWaiveReplay.invoicePublicId, undefined, {
      principal: customerAPrincipal,
      idempotencyKey: `idem-waive-live-${invWaiveReplay.invoicePublicId}`,
    });
    expect(initialWaive.mode).toBe("settled");

    await tdb.db.update(users).set({ status: "suspended" }).where(eq(users.id, customerAPrincipal.userId));
    try {
      await expect(
        h.payments.startCheckout(invWaiveReplay.invoicePublicId, undefined, {
          principal: customerAPrincipal,
          idempotencyKey: `idem-waive-live-${invWaiveReplay.invoicePublicId}`,
        }),
      ).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
    } finally {
      await tdb.db.update(users).set({ status: "active" }).where(eq(users.id, customerAPrincipal.userId));
    }

    // (2) DB-durable 3/hr "Send again" limit across independent ComplianceModule instances + window expiry
    const ordCollab = h.seedOrder(customerAPrincipal);
    ordCollab.collaborators = new Map([[customerBPrincipal.userId, { role: "viewer" }]]);
    const draftCollabInv = await h.compliance.invoices.admin.createDraft(adminPrincipal, {
      orderPublicId: ordCollab.publicId,
      currency: "USD",
      lines: [{ description: "Enterprise Packet", quantity: 1, unitAmountMinor: 12_000 }],
      discountMinor: 0,
      taxMinor: 0,
    });
    await h.compliance.invoices.admin.issue(adminPrincipal, {
      invoicePublicId: draftCollabInv.invoicePublicId,
    });
    const recordedManual = await h.compliance.invoices.admin.recordManualPayment(adminPrincipal, {
      invoicePublicId: draftCollabInv.invoicePublicId,
      method: "wire",
      amountMinor: 12_000,
      currency: "USD",
      reference: "WIRE-SEC-0001",
      receivedAt: new Date("2026-11-23T12:15:00.000Z"),
      idempotencyKey: "idem-sec-manual-wire-1",
    });
    const collabReceipts = await h.compliance.receipts.forOrder(adminPrincipal, ordCollab.publicId);
    expect(collabReceipts).toHaveLength(1);
    const targetReceiptId = collabReceipts[0]!.receiptPublicId;

    // Issue a partial refund so a refund note also exists on this receipt
    await h.compliance.invoices.admin.recordRefund(adminPrincipal, {
      invoicePublicId: draftCollabInv.invoicePublicId,
      paymentPublicId: recordedManual.paymentPublicId,
      amountMinor: 2_000,
      currency: "USD",
      reasonCode: "price_adjustment",
      reference: "WIRE-RFD-0001",
      confirmationPhrase: "REFUND ORDER",
      idempotencyKey: "idem-sec-manual-rfd-1",
    });
    const receiptWithNote = await h.compliance.receipts.get(adminPrincipal, targetReceiptId);
    expect(receiptWithNote.refundNotes).toHaveLength(1);
    const targetNoteId = receiptWithNote.refundNotes[0]!.notePublicId;

    // Send 3 times on primary module instance
    for (let i = 0; i < 3; i++) {
      await h.complianceCaller(staffPrincipal).receipts.admin.resend({ receiptPublicId: targetReceiptId });
      h.advanceClockMs(60_000);
    }

    // Spawn a brand-new ComplianceModule instance (zero shared in-memory state) -> 4th send within 1 hour STILL blocked by DB!
    const freshStaffCaller = h.spawnFreshComplianceCaller(staffPrincipal);
    await expect(
      freshStaffCaller.receipts.admin.resend({ receiptPublicId: targetReceiptId }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      cause: expect.objectContaining({
        code: "RATE_LIMITED",
        reasonCode: "RECEIPT_RESEND_RATE_LIMITED",
      }),
    });

    // Advance clock past the 1-hour sliding window -> resend succeeds again and updates slot durably
    h.advanceClockMs(3600 * 1000);
    const unlockedResend = await freshStaffCaller.receipts.admin.resend({ receiptPublicId: targetReceiptId });
    expect(unlockedResend.resendCount).toBe(4);

    // (3) Generic order collaborator (`viewer` / `contributor` without explicit billing grant) is DENIED on all receipt & refund-note surfaces
    // AND public NOT_FOUND error carries zero `details` oracle distinguishing real receipts from nonexistent IDs.
    const deniedBefore = h.t.audit.named("authz.compliance.denied").length;
    await expect(
      h.complianceCaller(customerBPrincipal).receipts.forOrder({ orderPublicId: ordCollab.publicId }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      cause: expect.objectContaining({
        reasonCode: "NOT_RECEIPT_BUYER_OR_BILLING",
      }),
    });
    let collabGetErr: unknown;
    try {
      await h.complianceCaller(customerBPrincipal).receipts.get({ receiptPublicId: targetReceiptId });
    } catch (e) {
      collabGetErr = e;
    }
    expect(collabGetErr).toMatchObject({ code: "NOT_FOUND" });
    expect(((collabGetErr as { cause?: { details?: unknown } })?.cause)?.details).toBeUndefined();

    await expect(
      h.compliance.receipts.downloadReceiptPdf(customerBPrincipal, targetReceiptId),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      details: undefined,
    });
    await expect(
      h.compliance.receipts.downloadRefundNotePdf(customerBPrincipal, targetNoteId),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      details: undefined,
    });
    expect(h.t.audit.named("authz.compliance.denied").length).toBeGreaterThanOrEqual(deniedBefore + 4);

    // Granting an explicit billing grant (`hasBillingGrant: true`) unlocks receipt read & PDF download for that collaborator
    ordCollab.collaborators.set(customerBPrincipal.userId, { role: "viewer", hasBillingGrant: true });
    const billingGrantedList = await h.complianceCaller(customerBPrincipal).receipts.forOrder({
      orderPublicId: ordCollab.publicId,
    });
    expect(billingGrantedList).toHaveLength(1);
    const billingGrantedPdf = await h.compliance.receipts.downloadReceiptPdf(customerBPrincipal, targetReceiptId);
    expect(billingGrantedPdf.buffer.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    const billingGrantedNotePdf = await h.compliance.receipts.downloadRefundNotePdf(customerBPrincipal, targetNoteId);
    expect(billingGrantedNotePdf.buffer.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
  });
});
