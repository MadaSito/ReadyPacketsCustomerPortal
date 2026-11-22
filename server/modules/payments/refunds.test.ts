import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Services } from "../../container.js";
import { DomainError, notFound } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createComplianceModule } from "../compliance/index.js";
import * as complianceSchema from "../compliance/schema.js";
import { users } from "../identity/schema.js";
import type { EgressFetchOptions, EgressFetchResponse, EgressPurpose } from "../integrations/egress.js";
import { REFUND_NOTICE_TEMPLATE_KEY, REFUND_RECONCILE_JOB, registerRefundNotice } from "../jobs/refundSupport.js";
import type { OrderAccessRole, OrderAccessView, OrderLockState, OrdersModule } from "../orders/index.js";
import type { InvoiceRefundedReferralEvent } from "../referrals/index.js";
import {
  createPaymentsModule,
  paymentRefunds,
  paymentsRouter,
  paymentWebhookEvents,
  REFUND_CONFIRMATION_PHRASE,
} from "./index.js";
import * as paymentsSchema from "./schema.js";

interface FakeOrderRecord {
  id: number;
  publicId: string;
  reference: string;
  ownerUserId: number;
  ownerPublicId: string;
  lockState: OrderLockState;
  origin: "portal" | "import";
  restrictedFromStaffUserId?: number;
}

function buildFakeOrders(ordersByPubId: Map<string, FakeOrderRecord>): OrdersModule {
  const byId = () => {
    const m = new Map<number, FakeOrderRecord>();
    for (const o of ordersByPubId.values()) m.set(o.id, o);
    return m;
  };

  function resolveRole(principal: SessionPrincipal, order: FakeOrderRecord): OrderAccessRole | null {
    if (principal.role === "admin") return "admin";
    if (principal.role === "staff") {
      if (order.restrictedFromStaffUserId === principal.userId) return null;
      return "staff";
    }
    if (order.ownerUserId === principal.userId) return "owner";
    return null;
  }

  function toView(order: FakeOrderRecord, role: OrderAccessRole): OrderAccessView {
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
    };
  }

  async function assertCanReadOrder(principal: SessionPrincipal, orderPublicId: string): Promise<OrderAccessView> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) throw notFound("ORDER_NOT_FOUND");
    const order = ordersByPubId.get(orderPublicId);
    if (!order) throw notFound("ORDER_NOT_FOUND");
    const role = resolveRole(principal, order);
    if (!role) throw notFound("ORDER_NOT_FOUND");
    return toView(order, role);
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
    async portableOrders(_tx: Tx, input: { customerIds: readonly number[]; limit: number; after?: number }) {
      const matching = [...ordersByPubId.values()]
        .filter((o) => input.customerIds.includes(o.ownerUserId) && (input.after === undefined || o.id > input.after))
        .sort((a, b) => a.id - b.id);
      return {
        items: matching.slice(0, input.limit),
        nextAfter: null,
      };
    },
    registerPaymentSummaryProvider() {},
  } as unknown as OrdersModule;
}

interface StoredStripeRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  payment_intent: string;
  status: "pending" | "succeeded" | "failed" | "canceled";
  created: number;
  failure_reason?: string | null;
  metadata: Record<string, string>;
}

interface StoredStripeSession {
  id: string;
  url: string;
  livemode: boolean;
  status: "open" | "complete" | "expired";
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
  };
}

let seq = 100;

function createFakeProvidersProtocol() {
  const stripeSessions = new Map<string, StoredStripeSession>();
  const stripeRefunds = new Map<string, StoredStripeRefund>();
  const squareLinks = new Map<string, { id: string; order_id: string; url: string }>();
  const squareOrders = new Map<
    string,
    {
      id: string;
      location_id: string;
      reference_id: string;
      total_money: { amount: number; currency: string };
      state: string;
      line_items: Array<{ note: string; quantity: "1"; base_price_money: { amount: number; currency: string } }>;
      tenders: Array<{ payment_id?: string }>;
    }
  >();
  const squarePayments = new Map<
    string,
    {
      id: string;
      order_id: string;
      location_id: string;
      status: "COMPLETED";
      amount_money: { amount: number; currency: string };
      total_money: { amount: number; currency: string };
      updated_at: string;
      refund_ids?: string[];
    }
  >();
  const squareRefunds = new Map<
    string,
    {
      id: string;
      payment_id: string;
      status: "PENDING" | "COMPLETED" | "FAILED" | "REJECTED";
      amount_money: { amount: number; currency: string };
      reason?: string;
      updated_at: string;
    }
  >();

  const calls: Array<{ method: string; url: string; purpose: EgressPurpose; headers: Record<string, string> }> = [];
  let nextStripeRefundPostBehavior: "succeeded" | "pending" | "network_drop_after_stripe_accepted" = "succeeded";
  let nextSquareRefundStatus: "PENDING" | "COMPLETED" = "PENDING";

  const fetchPinned = async (
    url: URL | string,
    purpose: EgressPurpose,
    options?: EgressFetchOptions,
  ): Promise<EgressFetchResponse> => {
    const u = typeof url === "string" ? new URL(url) : url;
    const opts = options ?? {};
    const method = (opts.method ?? "GET").toUpperCase();
    const headersLower: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      headersLower[k.toLowerCase()] = v;
    }
    calls.push({ method, url: u.href, purpose, headers: headersLower });
    if (opts.beforeSend) {
      await opts.beforeSend();
    }

    if (purpose === "stripe" && u.origin === "https://api.stripe.com") {
      if (method === "POST" && u.pathname === "/v1/checkout/sessions") {
        const form = new URLSearchParams(typeof opts.body === "string" ? opts.body : "");
        const n = seq++;
        const id = `cs_test_rfd_${n}`;
        const piId = `pi_test_rfd_${n}`;
        const amount = Number.parseInt(form.get("line_items[0][price_data][unit_amount]") ?? "0", 10);
        const currency = (form.get("line_items[0][price_data][currency]") ?? "usd").toLowerCase();
        const session: StoredStripeSession = {
          id,
          url: `https://checkout.stripe.com/c/pay/${id}`,
          livemode: false,
          status: "open",
          payment_status: "unpaid",
          amount_total: amount,
          currency,
          expires_at: Math.floor(Date.parse("2026-11-22T12:00:00.000Z") / 1000),
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
            created: Math.floor(Date.parse("2026-11-21T12:05:00.000Z") / 1000),
          },
        };
        stripeSessions.set(id, session);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(session), "utf8"),
        };
      }

      if (method === "GET" && u.pathname.startsWith("/v1/checkout/sessions/")) {
        const sessionId = decodeURIComponent(u.pathname.slice("/v1/checkout/sessions/".length));
        const s = stripeSessions.get(sessionId);
        if (!s) return { status: 404, headers: {}, body: Buffer.from("{}", "utf8") };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(s), "utf8"),
        };
      }

      if (method === "POST" && u.pathname === "/v1/refunds") {
        const form = new URLSearchParams(typeof opts.body === "string" ? opts.body : "");
        const n = seq++;
        const refundId = `re_test_${n}`;
        const piId = form.get("payment_intent") ?? "";
        const amount = Number.parseInt(form.get("amount") ?? "0", 10);
        const mode = nextStripeRefundPostBehavior;
        nextStripeRefundPostBehavior = "succeeded";

        const matchingSession = [...stripeSessions.values()].find((s) => s.payment_intent.id === piId);
        const currency = matchingSession?.currency ?? "usd";

        const stored: StoredStripeRefund = {
          id: refundId,
          object: "refund",
          amount,
          currency,
          payment_intent: piId,
          status: mode === "pending" ? "pending" : "succeeded",
          created: Math.floor(Date.parse("2026-11-21T12:15:00.000Z") / 1000),
          metadata: {
            refund_public_id: form.get("metadata[refund_public_id]") ?? "",
            order_public_id: form.get("metadata[order_public_id]") ?? "",
            invoice_public_id: form.get("metadata[invoice_public_id]") ?? "",
          },
        };
        stripeRefunds.set(refundId, stored);

        if (mode === "network_drop_after_stripe_accepted") {
          throw new DomainError("UNAVAILABLE", "EGRESS_TIMEOUT", "Simulated socket drop after Stripe accepted refund.");
        }

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(stored), "utf8"),
        };
      }

      if (method === "GET" && u.pathname.startsWith("/v1/refunds/")) {
        const refundId = decodeURIComponent(u.pathname.slice("/v1/refunds/".length));
        const r = stripeRefunds.get(refundId);
        if (!r) return { status: 404, headers: {}, body: Buffer.from("{}", "utf8") };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(r), "utf8"),
        };
      }

      if (method === "GET" && u.pathname === "/v1/refunds") {
        const piId = u.searchParams.get("payment_intent") ?? "";
        const data = [...stripeRefunds.values()].filter((r) => r.payment_intent === piId);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ object: "list", data }), "utf8"),
        };
      }
    }

    if (purpose === "square" && u.origin === "https://connect.squareupsandbox.com") {
      if (method === "POST" && u.pathname === "/v2/online-checkout/payment-links") {
        const parsed = JSON.parse(typeof opts.body === "string" ? opts.body : "{}") as {
          order: {
            location_id: string;
            reference_id: string;
            line_items: Array<{ note: string; quantity: "1"; base_price_money: { amount: number; currency: string } }>;
          };
        };
        const n = seq++;
        const linkId = `sqlink_${n}`;
        const orderId = `sqord_${n}`;
        const line = parsed.order.line_items[0]!;
        squareLinks.set(linkId, { id: linkId, order_id: orderId, url: `https://sandbox.square.link/u/${linkId}` });
        squareOrders.set(orderId, {
          id: orderId,
          location_id: parsed.order.location_id,
          reference_id: parsed.order.reference_id,
          total_money: line.base_price_money,
          state: "OPEN",
          line_items: [line],
          tenders: [],
        });
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ payment_link: squareLinks.get(linkId) }), "utf8"),
        };
      }

      if (method === "GET" && u.pathname.startsWith("/v2/online-checkout/payment-links/")) {
        const id = u.pathname.slice("/v2/online-checkout/payment-links/".length);
        const link = squareLinks.get(id);
        if (!link) return { status: 404, headers: {}, body: Buffer.from("{}", "utf8") };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ payment_link: link }), "utf8"),
        };
      }

      if (method === "GET" && u.pathname.startsWith("/v2/orders/")) {
        const id = u.pathname.slice("/v2/orders/".length);
        const ord = squareOrders.get(id);
        if (!ord) return { status: 404, headers: {}, body: Buffer.from("{}", "utf8") };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ order: ord }), "utf8"),
        };
      }

      if (method === "GET" && u.pathname.startsWith("/v2/payments/")) {
        const id = u.pathname.slice("/v2/payments/".length);
        const pmt = squarePayments.get(id);
        if (!pmt) return { status: 404, headers: {}, body: Buffer.from("{}", "utf8") };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ payment: pmt }), "utf8"),
        };
      }

      if (method === "POST" && u.pathname === "/v2/refunds") {
        const parsed = JSON.parse(typeof opts.body === "string" ? opts.body : "{}") as {
          idempotency_key: string;
          payment_id: string;
          amount_money: { amount: number; currency: string };
          reason?: string;
        };
        const n = seq++;
        const refundId = `sqrfd_${n}`;
        const status = nextSquareRefundStatus;
        nextSquareRefundStatus = "PENDING";
        const row = {
          id: refundId,
          payment_id: parsed.payment_id,
          status,
          amount_money: parsed.amount_money,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          updated_at: "2026-11-21T12:20:00.000Z",
        };
        squareRefunds.set(refundId, row);
        const pmt = squarePayments.get(parsed.payment_id);
        if (pmt) {
          pmt.refund_ids = [...(pmt.refund_ids ?? []), refundId];
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ refund: row }), "utf8"),
        };
      }

      if (method === "GET" && u.pathname.startsWith("/v2/refunds/")) {
        const id = u.pathname.slice("/v2/refunds/".length);
        const row = squareRefunds.get(id);
        if (!row) return { status: 404, headers: {}, body: Buffer.from("{}", "utf8") };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ refund: row }), "utf8"),
        };
      }
    }

    return { status: 404, headers: {}, body: Buffer.from("{}", "utf8") };
  };

  return {
    calls,
    fetchPinned,
    stripeSessions,
    stripeRefunds,
    squareOrders,
    squareRefunds,
    setNextStripeRefundPostBehavior(mode: "succeeded" | "pending" | "network_drop_after_stripe_accepted") {
      nextStripeRefundPostBehavior = mode;
    },
    setStripeRefundStatus(refundId: string, status: StoredStripeRefund["status"]) {
      const r = stripeRefunds.get(refundId);
      if (!r) throw new Error(`Unknown Stripe refund ${refundId}`);
      r.status = status;
    },
    markStripeSessionPaid(sessionId: string) {
      const s = stripeSessions.get(sessionId);
      if (!s) throw new Error(`Unknown Stripe session ${sessionId}`);
      s.status = "complete";
      s.payment_status = "paid";
      s.payment_intent.status = "succeeded";
      s.payment_intent.amount_received = s.amount_total;
    },
    completeSquareOrderPayment(orderId: string): string {
      const ord = squareOrders.get(orderId);
      if (!ord) throw new Error(`Unknown Square order ${orderId}`);
      const paymentId = `sqpay_${orderId}`;
      ord.state = "COMPLETED";
      ord.tenders = [{ payment_id: paymentId }];
      squarePayments.set(paymentId, {
        id: paymentId,
        order_id: orderId,
        location_id: ord.location_id,
        status: "COMPLETED",
        amount_money: ord.total_money,
        total_money: ord.total_money,
        updated_at: "2026-11-21T12:05:00.000Z",
      });
      return paymentId;
    },
    setSquareRefundStatus(refundId: string, status: "PENDING" | "COMPLETED" | "FAILED" | "REJECTED") {
      const r = squareRefunds.get(refundId);
      if (!r) throw new Error(`Unknown Square refund ${refundId}`);
      r.status = status;
      r.updated_at = "2026-11-21T12:25:00.000Z";
    },
  };
}

function signStripeWebhook(rawBody: Buffer, webhookSecret: string, timestampSec: number): string {
  const signedPayload = Buffer.concat([Buffer.from(`${timestampSec}.`, "utf8"), rawBody]);
  const v1 = createHmac("sha256", webhookSecret).update(signedPayload).digest("hex");
  return `t=${timestampSec},v1=${v1}`;
}

function signSquareWebhook(notificationUrl: string, rawBody: Buffer, sigKey: string): string {
  return createHmac("sha256", sigKey).update(notificationUrl, "utf8").update(rawBody).digest("base64");
}

describe("payments.refunds — B5 console order refunds, reconciliation, webhooks & referral clawback", () => {
  let tdb: TestDb;
  let adminPrincipal: SessionPrincipal;
  let adminStaleStepUpPrincipal: SessionPrincipal;
  let staffPrincipal: SessionPrincipal;
  let restrictedStaffPrincipal: SessionPrincipal;
  let customerAPrincipal: SessionPrincipal;
  let customerBPrincipal: SessionPrincipal;
  const ordersMap = new Map<string, FakeOrderRecord>();
  let orderSeq = 900;

  beforeAll(async () => {
    tdb = await createTestDb({
      schema: {
        users,
        ...complianceSchema,
        ...paymentsSchema,
      },
    });

    const now = new Date("2026-11-21T12:00:00.000Z");
    const seed = [
      { key: "admin", role: "admin" as const, email: "rfd-admin@example.test", name: "Admin Refund" },
      { key: "staff", role: "staff" as const, email: "rfd-staff@example.test", name: "Staff Reader" },
      { key: "staffRestricted", role: "staff" as const, email: "rfd-staff2@example.test", name: "Staff Restricted" },
      { key: "custA", role: "customer" as const, email: "rfd-custa@example.test", name: "Alice Customer" },
      { key: "custB", role: "customer" as const, email: "rfd-custb@example.test", name: "Bob Customer" },
    ];

    const ids: Record<string, { id: number; publicId: string }> = {};
    for (const [idx, u] of seed.entries()) {
      const pubId = ulid(now.getTime() + idx * 10);
      const [ins] = await tdb.db.insert(users).values({
        publicId: pubId,
        emailEnc: `enc:${u.email}`,
        emailIndex: `${idx + 70}`.padStart(64, "c"),
        nameEnc: `enc:${u.name}`,
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
      mfaVerifiedAt: now,
    });
    adminStaleStepUpPrincipal = fakePrincipal({
      userId: ids.admin!.id,
      userPublicId: ids.admin!.publicId,
      role: "admin",
      stepUpAt: null,
      mfaVerifiedAt: now,
    });
    staffPrincipal = fakePrincipal({
      userId: ids.staff!.id,
      userPublicId: ids.staff!.publicId,
      role: "staff",
      stepUpAt: now,
      mfaVerifiedAt: now,
    });
    restrictedStaffPrincipal = fakePrincipal({
      userId: ids.staffRestricted!.id,
      userPublicId: ids.staffRestricted!.publicId,
      role: "staff",
      stepUpAt: now,
      mfaVerifiedAt: now,
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
    const h = createTestDeps({
      db: tdb.db,
      now: new Date("2026-11-21T12:00:00.000Z"),
    });
    registerRefundNotice(h.mailer);
    const protocol = createFakeProvidersProtocol();
    const referralRefundEvents: Array<{ event: InvoiceRefundedReferralEvent; hasTx: boolean }> = [];

    h.services.orders = buildFakeOrders(ordersMap);
    (h.services as unknown as Record<string, unknown>).integrations = {
      egress: {
        fetchPinned: protocol.fetchPinned,
        isHostAllowed: () => true,
      },
    };
    (h.services as unknown as Record<string, unknown>).referrals = {
      async onInvoicePaid() {},
      async onInvoiceRefunded(event: InvoiceRefundedReferralEvent, opts?: { tx?: Tx }) {
        referralRefundEvents.push({ event, hasTx: opts?.tx !== undefined });
      },
    };

    const compliance = createComplianceModule(h.deps);
    h.services.compliance = compliance;
    const payments = createPaymentsModule(h.deps);
    (h.services as unknown as Record<string, unknown>).payments = payments;
    compliance.init?.();
    payments.init?.();

    function seedOrder(owner: SessionPrincipal, opts?: { restrictedFromStaffUserId?: number }): FakeOrderRecord {
      const id = ++orderSeq;
      const pubId = ulid(h.clock.now().getTime() + id);
      const rec: FakeOrderRecord = {
        id,
        publicId: pubId,
        reference: `RP-2026-${String(id).padStart(4, "0")}`,
        ownerUserId: owner.userId,
        ownerPublicId: owner.userPublicId,
        lockState: "none",
        origin: "portal",
        ...(opts?.restrictedFromStaffUserId !== undefined
          ? { restrictedFromStaffUserId: opts.restrictedFromStaffUserId }
          : {}),
      };
      ordersMap.set(pubId, rec);
      return rec;
    }

    function callerFor(session: SessionPrincipal | null) {
      const reqCtx = newRequestContext("http");
      return paymentsRouter.createCaller({
        services: h.services as Services,
        session,
        request: reqCtx,
        transport: { issue: () => {}, clear: () => {} },
      });
    }

    return { h, protocol, compliance, payments, referralRefundEvents, seedOrder, callerFor };
  }

  async function issueOrderInvoice(
    compliance: ReturnType<typeof createComplianceModule>,
    orderPublicId: string,
    amountMinor: number,
  ): Promise<string> {
    const draft = await compliance.invoices.admin.createDraft(adminPrincipal, {
      orderPublicId,
      currency: "USD",
      lines: [{ description: "Filing packet service", quantity: 1, unitAmountMinor: amountMinor }],
      discountMinor: 0,
      taxMinor: 0,
    });
    await compliance.invoices.admin.issue(adminPrincipal, {
      invoicePublicId: draft.invoicePublicId,
    });
    return draft.invoicePublicId;
  }

  it("enforces RBAC, step-up, confirmation phrase, PAN rejection, order scope & read-only staff redaction on refunds.{forOrder,create}", async () => {
    const { compliance, seedOrder, callerFor } = createHarness();
    const order = seedOrder(customerAPrincipal, {
      restrictedFromStaffUserId: restrictedStaffPrincipal.userId,
    });
    const invoicePublicId = await issueOrderInvoice(compliance, order.publicId, 12_000);
    const recorded = await compliance.invoices.admin.recordManualPayment(adminPrincipal, {
      invoicePublicId,
      method: "bank_transfer",
      amountMinor: 12_000,
      currency: "USD",
      reference: "WIRE-9001",
      idempotencyKey: "idem-wire-9001",
    });

    // Unauthenticated & customer denied at tRPC router
    await expect(callerFor(null).refunds.forOrder({ orderPublicId: order.publicId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      callerFor(customerAPrincipal).refunds.forOrder({ orderPublicId: order.publicId }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // Restricted staff & nonexistent order both get NOT_FOUND:ORDER_NOT_FOUND (zero existence oracle)
    await expect(
      callerFor(restrictedStaffPrincipal).refunds.forOrder({ orderPublicId: order.publicId }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: expect.objectContaining({ reasonCode: "ORDER_NOT_FOUND" }),
    });
    await expect(
      callerFor(adminPrincipal).refunds.forOrder({ orderPublicId: ulid(1_700_000_000_000) }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: expect.objectContaining({ reasonCode: "ORDER_NOT_FOUND" }),
    });

    // Staff cannot call refunds.create; admin without fresh step-up is refused with STEP_UP_REQUIRED
    await expect(
      callerFor(staffPrincipal).refunds.create({
        orderPublicId: order.publicId,
        paymentPublicId: recorded.paymentPublicId,
        amountMinor: 2_000,
        currency: "USD",
        reason: "Partial fee adjustment",
        sendCustomerNotice: false,
        confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
        idempotencyKey: "idem-staff-attempt-1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      callerFor(adminStaleStepUpPrincipal).refunds.create({
        orderPublicId: order.publicId,
        paymentPublicId: recorded.paymentPublicId,
        amountMinor: 2_000,
        currency: "USD",
        reason: "Partial fee adjustment",
        sendCustomerNotice: false,
        confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
        idempotencyKey: "idem-stale-stepup-1",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      cause: expect.objectContaining({ code: "STEP_UP_REQUIRED", reasonCode: "STEP_UP_REQUIRED" }),
    });

    // Wrong confirmation phrase & card PAN in reason are rejected server-side
    await expect(
      callerFor(adminPrincipal).refunds.create({
        orderPublicId: order.publicId,
        paymentPublicId: recorded.paymentPublicId,
        amountMinor: 2_000,
        currency: "USD",
        reason: "Duplicate billing adjustment",
        sendCustomerNotice: false,
        confirmationPhrase: "refund order",
        idempotencyKey: "idem-bad-phrase-1",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({ reasonCode: "CONFIRMATION_PHRASE_MISMATCH" }),
    });

    await expect(
      callerFor(adminPrincipal).refunds.create({
        orderPublicId: order.publicId,
        paymentPublicId: recorded.paymentPublicId,
        amountMinor: 2_000,
        currency: "USD",
        reason: "Refund to card 4111 1111 1111 1111",
        sendCustomerNotice: false,
        confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
        idempotencyKey: "idem-card-pan-1",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({ reasonCode: "CARD_DATA_FORBIDDEN" }),
    });

    // Admin records a valid partial manual refund ($30 of $120)
    const created = await callerFor(adminPrincipal).refunds.create({
      orderPublicId: order.publicId,
      paymentPublicId: recorded.paymentPublicId,
      amountMinor: 3_000,
      currency: "USD",
      reason: "Sensitive internal billing adjustment note",
      sendCustomerNotice: false,
      confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
      idempotencyKey: "idem-manual-partial-1",
    });
    expect(created.executionKind).toBe("recorded_only");
    expect(created.executionLabel).toBe("recorded only — no money is moved by the portal");
    expect(created.status).toBe("succeeded");
    expect(created.invoicePaymentState).toBe("partially_refunded");
    expect(created.orderPaymentState).toBe("partially_refunded");

    // Staff sees balances with canIssueRefund: false and redacted reason: null; admin sees decrypted reason
    const staffView = await callerFor(staffPrincipal).refunds.forOrder({ orderPublicId: order.publicId });
    expect(staffView.canIssueRefund).toBe(false);
    expect(staffView.payments[0]?.capturedMinor).toBe(12_000);
    expect(staffView.payments[0]?.refundedMinor).toBe(3_000);
    expect(staffView.payments[0]?.refundableMinor).toBe(9_000);
    expect(staffView.payments[0]?.refunds[0]?.reason).toBeNull();

    const adminView = await callerFor(adminPrincipal).refunds.forOrder({ orderPublicId: order.publicId });
    expect(adminView.canIssueRefund).toBe(true);
    expect(adminView.payments[0]?.refunds[0]?.reason).toBe("Sensitive internal billing adjustment note");
  });

  it("executes manual 'recorded_only' full refund with zero provider egress, customer notice email, customer-safe audit & referral review hook", async () => {
    const { h, protocol, compliance, referralRefundEvents, seedOrder, callerFor } = createHarness();
    const order = seedOrder(customerAPrincipal);
    const invoicePublicId = await issueOrderInvoice(compliance, order.publicId, 8_500);
    const recorded = await compliance.invoices.admin.recordManualPayment(adminPrincipal, {
      invoicePublicId,
      method: "check",
      amountMinor: 8_500,
      currency: "USD",
      reference: "CHK-441",
      idempotencyKey: "idem-chk-441",
    });

    h.audit.clear();
    const callsBefore = protocol.calls.length;

    const result = await callerFor(adminPrincipal).refunds.create({
      orderPublicId: order.publicId,
      paymentPublicId: recorded.paymentPublicId,
      amountMinor: 8_500,
      currency: "USD",
      reason: "Check returned and refunded offline",
      sendCustomerNotice: true,
      confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
      idempotencyKey: "idem-manual-full-8500",
    });

    expect(protocol.calls.length).toBe(callsBefore);
    expect(result.status).toBe("succeeded");
    expect(result.executionKind).toBe("recorded_only");
    expect(result.invoicePaymentState).toBe("refunded");
    expect(result.orderPaymentState).toBe("refunded");

    // Over-refund is refused under FOR UPDATE
    await expect(
      callerFor(adminPrincipal).refunds.create({
        orderPublicId: order.publicId,
        paymentPublicId: recorded.paymentPublicId,
        amountMinor: 1,
        currency: "USD",
        reason: "Extra penny",
        sendCustomerNotice: false,
        confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
        idempotencyKey: "idem-manual-over-1",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "REFUND_EXCEEDS_REFUNDABLE" }),
    });

    // Customer notice email queued once
    const notice = h.mailer.last(REFUND_NOTICE_TEMPLATE_KEY);
    expect(notice).toBeDefined();
    expect(notice?.vars.orderReference).toBe(order.reference);
    expect(notice?.vars.refundReference).toBe(result.refundPublicId);

    // Customer-visible `payment.refund.succeeded` event carries orderPublicId and zero PII / amounts
    const succeededAudits = h.audit.named("payment.refund.succeeded");
    expect(succeededAudits).toHaveLength(1);
    expect(succeededAudits[0]?.orderPublicId).toBe(order.publicId);
    expect(succeededAudits[0]?.attributes).toEqual({
      order_public_id: order.publicId,
      invoice_public_id: invoicePublicId,
      provider: "manual",
      execution_kind: "recorded_only",
    });

    // Referral clawback / manual-review hook fired inside settlement tx with fullyRefunded: true
    expect(referralRefundEvents).toHaveLength(1);
    expect(referralRefundEvents[0]?.hasTx).toBe(true);
    expect(referralRefundEvents[0]?.event.fullyRefunded).toBe(true);
    expect(referralRefundEvents[0]?.event.refundedMinor).toBe(8_500);
    expect(referralRefundEvents[0]?.event.totalMinor).toBe(8_500);
  });

  it("executes Stripe provider refunds, never re-POSTs on 'unknown' outcome, reserves balance, and settles via GET reconciliation", async () => {
    const { h, protocol, compliance, payments, seedOrder, callerFor } = createHarness();
    const webhookSecret = "whsec_test_refund_suite_secret_01";
    await payments.admin.updateSettings(adminPrincipal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      stripeSecretKey: "sk_test_refund_suite_secret_01",
      stripeWebhookSecret: webhookSecret,
    });

    const order = seedOrder(customerBPrincipal);
    const invoicePublicId = await issueOrderInvoice(compliance, order.publicId, 10_000);

    // Capture $100.00 via Stripe Checkout + double-verified webhook
    const started = await runWithRequestContext(newRequestContext("http"), () =>
      payments.startCheckout(invoicePublicId, undefined, {
        principal: customerBPrincipal,
        idempotencyKey: "idem-stripe-chk-1",
      }),
    );
    expect(started.mode).toBe("redirect");
    if (started.mode !== "redirect") throw new Error("expected redirect");

    const sessionId = started.redirectUrl.split("/").pop()!;
    protocol.markStripeSessionPaid(sessionId);
    const sessionObj = protocol.stripeSessions.get(sessionId)!;

    const paidEventPayload = Buffer.from(
      JSON.stringify({
        id: "evt_test_paid_rfd_1",
        object: "event",
        type: "checkout.session.completed",
        livemode: false,
        created: Math.floor(h.clock.now().getTime() / 1000),
        data: { object: sessionObj },
      }),
      "utf8",
    );
    const stripeNotificationUrl = `${h.deps.config.canonicalOrigin}/api/payments/webhooks/stripe`;
    const sig = signStripeWebhook(paidEventPayload, webhookSecret, Math.floor(h.clock.now().getTime() / 1000));
    const whRes = await payments.handleSignedWebhook({
      provider: "stripe",
      rawBody: paidEventPayload,
      headers: { "stripe-signature": sig },
      notificationUrl: stripeNotificationUrl,
    });
    expect(whRes.booked).toBe(true);

    const workspace0 = await callerFor(adminPrincipal).refunds.forOrder({ orderPublicId: order.publicId });
    expect(workspace0.payments).toHaveLength(1);
    const pmt = workspace0.payments[0]!;
    expect(pmt.provider).toBe("stripe");
    expect(pmt.executionKind).toBe("provider_refund");
    expect(pmt.capturedMinor).toBe(10_000);
    expect(pmt.refundableMinor).toBe(10_000);

    // 1) Partial synchronous Stripe refund ($40.00) + caller idempotency replay (no second POST)
    const partial = await callerFor(adminPrincipal).refunds.create({
      orderPublicId: order.publicId,
      paymentPublicId: pmt.paymentPublicId,
      amountMinor: 4_000,
      currency: "USD",
      reason: "Partial service credit",
      sendCustomerNotice: true,
      confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
      idempotencyKey: "idem-stripe-rfd-4000",
    });
    expect(partial.status).toBe("succeeded");
    expect(partial.providerRefundRef).toMatch(/^re_test_/u);
    expect(partial.invoicePaymentState).toBe("partially_refunded");

    const stripePostCallsAfterFirst = protocol.calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/v1/refunds"),
    );
    expect(stripePostCallsAfterFirst).toHaveLength(1);
    expect(stripePostCallsAfterFirst[0]?.headers["idempotency-key"]).toBe(`rp-refund-${partial.refundPublicId}`);

    const replayed = await callerFor(adminPrincipal).refunds.create({
      orderPublicId: order.publicId,
      paymentPublicId: pmt.paymentPublicId,
      amountMinor: 4_000,
      currency: "USD",
      reason: "Partial service credit",
      sendCustomerNotice: true,
      confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
      idempotencyKey: "idem-stripe-rfd-4000",
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.refundPublicId).toBe(partial.refundPublicId);
    expect(protocol.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/refunds"))).toHaveLength(1);

    // 2) Simulate socket drop AFTER Stripe accepted the remaining $60.00 refund -> status "unknown"
    protocol.setNextStripeRefundPostBehavior("network_drop_after_stripe_accepted");
    const ambiguous = await callerFor(adminPrincipal).refunds.create({
      orderPublicId: order.publicId,
      paymentPublicId: pmt.paymentPublicId,
      amountMinor: 6_000,
      currency: "USD",
      reason: "Remaining balance refund",
      sendCustomerNotice: true,
      confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
      idempotencyKey: "idem-stripe-rfd-6000-ambiguous",
    });
    expect(ambiguous.status).toBe("unknown");

    // Only ONE POST was sent for the ambiguous refund (total 2 POSTs across both refunds)
    expect(protocol.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/refunds"))).toHaveLength(2);

    // Balance is reserved (`reservedPendingOrUnknownMinor: 6000`, `refundableMinor: 0`) & new refund is blocked
    const workspaceDuringUnknown = await callerFor(adminPrincipal).refunds.forOrder({
      orderPublicId: order.publicId,
    });
    expect(workspaceDuringUnknown.payments[0]?.refundedMinor).toBe(4_000);
    expect(workspaceDuringUnknown.payments[0]?.reservedPendingOrUnknownMinor).toBe(6_000);
    expect(workspaceDuringUnknown.payments[0]?.refundableMinor).toBe(0);

    await expect(
      callerFor(adminPrincipal).refunds.create({
        orderPublicId: order.publicId,
        paymentPublicId: pmt.paymentPublicId,
        amountMinor: 1_000,
        currency: "USD",
        reason: "Blocked while unknown",
        sendCustomerNotice: false,
        confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
        idempotencyKey: "idem-stripe-blocked-while-unknown",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "REFUND_OUTCOME_UNKNOWN_PENDING" }),
    });

    // Durable reconcile job was enqueued in the prepare transaction
    expect(
      h.jobs.enqueued.some(
        (j) =>
          j.type === REFUND_RECONCILE_JOB &&
          (j.payload as { refundPublicId: string }).refundPublicId === ambiguous.refundPublicId,
      ),
    ).toBe(true);

    // Run reconcile job handler -> performs GET /v1/refunds?payment_intent=... ONLY (zero POSTs!) and settles!
    const reconcileOutcome = await payments.reconcileProviderRefund(ambiguous.refundPublicId, {
      jobId: "job-reconcile-1",
      signal: new AbortController().signal,
      correlationId: "corr-reconcile-1",
      assertStillOwned: async () => {},
    });
    expect(reconcileOutcome).toBe("settled");
    expect(protocol.calls.filter((c) => c.method === "POST" && c.url.endsWith("/v1/refunds"))).toHaveLength(2);

    const workspaceAfterReconcile = await callerFor(adminPrincipal).refunds.forOrder({
      orderPublicId: order.publicId,
    });
    expect(workspaceAfterReconcile.orderPaymentState).toBe("refunded");
    expect(workspaceAfterReconcile.payments[0]?.refundedMinor).toBe(10_000);
    expect(workspaceAfterReconcile.payments[0]?.reservedPendingOrUnknownMinor).toBe(0);
    expect(workspaceAfterReconcile.payments[0]?.refundableMinor).toBe(0);
  });

  it("settles a pending Stripe refund through a verified `refund.updated` webhook and links payment_webhook_events", async () => {
    const { h, protocol, compliance, payments, seedOrder, callerFor } = createHarness();
    const webhookSecret = "whsec_test_refund_webhook_02";
    await payments.admin.updateSettings(adminPrincipal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      stripeSecretKey: "sk_test_refund_webhook_02",
      stripeWebhookSecret: webhookSecret,
    });

    const order = seedOrder(customerAPrincipal);
    const invoicePublicId = await issueOrderInvoice(compliance, order.publicId, 5_000);
    const started = await payments.startCheckout(invoicePublicId, undefined, {
      principal: customerAPrincipal,
      idempotencyKey: "idem-stripe-wh-chk-2",
    });
    if (started.mode !== "redirect") throw new Error("expected redirect");
    const sessionId = started.redirectUrl.split("/").pop()!;
    protocol.markStripeSessionPaid(sessionId);
    const sessionObj = protocol.stripeSessions.get(sessionId)!;

    const nowSec = Math.floor(h.clock.now().getTime() / 1000);
    const paidBody = Buffer.from(
      JSON.stringify({
        id: "evt_test_paid_wh_2",
        type: "checkout.session.completed",
        livemode: false,
        created: nowSec,
        data: { object: sessionObj },
      }),
      "utf8",
    );
    const stripeNotificationUrl = `${h.deps.config.canonicalOrigin}/api/payments/webhooks/stripe`;
    await payments.handleSignedWebhook({
      provider: "stripe",
      rawBody: paidBody,
      headers: { "stripe-signature": signStripeWebhook(paidBody, webhookSecret, nowSec) },
      notificationUrl: stripeNotificationUrl,
    });

    const ws = await callerFor(adminPrincipal).refunds.forOrder({ orderPublicId: order.publicId });
    const pmt = ws.payments[0]!;

    // Stripe initially returns status: "pending"
    protocol.setNextStripeRefundPostBehavior("pending");
    const pendingRefund = await callerFor(adminPrincipal).refunds.create({
      orderPublicId: order.publicId,
      paymentPublicId: pmt.paymentPublicId,
      amountMinor: 5_000,
      currency: "USD",
      reason: "Async bank refund",
      sendCustomerNotice: false,
      confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
      idempotencyKey: "idem-stripe-pending-wh-2",
    });
    expect(pendingRefund.status).toBe("pending");
    expect(pendingRefund.providerRefundRef).toBeTruthy();

    // Stripe transitions refund to succeeded and sends signed `refund.updated` webhook
    protocol.setStripeRefundStatus(pendingRefund.providerRefundRef!, "succeeded");
    const storedStripeRefund = protocol.stripeRefunds.get(pendingRefund.providerRefundRef!)!;
    const refundEventBody = Buffer.from(
      JSON.stringify({
        id: "evt_test_refund_updated_2",
        type: "refund.updated",
        livemode: false,
        created: nowSec + 10,
        data: { object: storedStripeRefund },
      }),
      "utf8",
    );
    const rfdWebhookRes = await payments.handleSignedWebhook({
      provider: "stripe",
      rawBody: refundEventBody,
      headers: { "stripe-signature": signStripeWebhook(refundEventBody, webhookSecret, nowSec + 10) },
      notificationUrl: stripeNotificationUrl,
    });
    expect(rfdWebhookRes.accepted).toBe(true);
    expect(rfdWebhookRes.booked).toBe(true);
    expect(rfdWebhookRes.reasonCode).toBe("REFUND_SUCCEEDED");

    const [updatedRow] = await tdb.db
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.publicId, pendingRefund.refundPublicId));
    expect(updatedRow?.status).toBe("succeeded");
    expect(updatedRow?.verifiedWebhookEventId).toBe("evt_test_refund_updated_2");

    const [whEventRow] = await tdb.db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.externalEventId, "evt_test_refund_updated_2"));
    expect(whEventRow?.refundPublicId).toBe(pendingRefund.refundPublicId);
    expect(whEventRow?.providerRefundRef).toBe(pendingRefund.providerRefundRef);
    expect(whEventRow?.status).toBe("processed");
  });

  it("executes Square refunds (`PENDING` -> `COMPLETED`) via Square refund adapter & Square webhook verification", async () => {
    const { h, protocol, compliance, payments, seedOrder, callerFor } = createHarness();
    const sqSigKey = "sq_wh_sig_refund_test_03";
    await payments.admin.updateSettings(adminPrincipal, {
      provider: "square",
      mode: "test",
      currency: "USD",
      squareLocationId: "LTESTLOC99",
      squareAccessToken: "EAAA_sandbox_refund_token_03",
      squareWebhookSignatureKey: sqSigKey,
    });

    const order = seedOrder(customerAPrincipal);
    const invoicePublicId = await issueOrderInvoice(compliance, order.publicId, 7_500);
    const started = await payments.startCheckout(invoicePublicId, undefined, {
      principal: customerAPrincipal,
      idempotencyKey: "idem-sq-chk-3",
    });
    if (started.mode !== "redirect") throw new Error("expected redirect");

    const sqLinkId = started.redirectUrl.split("/").pop()!;
    const sqOrder = [...protocol.squareOrders.values()].find((o) => o.reference_id === started.attemptPublicId)!;
    const sqPaymentId = protocol.completeSquareOrderPayment(sqOrder.id);

    const sqPaidBody = Buffer.from(
      JSON.stringify({
        event_id: "sq_evt_paid_03",
        type: "payment.updated",
        created_at: "2026-11-21T12:00:10.000Z",
        data: {
          type: "payment",
          id: sqPaymentId,
          object: {
            payment: {
              id: sqPaymentId,
              order_id: sqOrder.id,
              status: "COMPLETED",
            },
          },
        },
      }),
      "utf8",
    );
    const sqNotificationUrl = `${h.deps.config.canonicalOrigin}/api/payments/webhooks/square`;
    expect(sqLinkId).toBeTruthy();
    const sqPaidWh = await payments.handleSignedWebhook({
      provider: "square",
      rawBody: sqPaidBody,
      headers: {
        "x-square-hmacsha256-signature": signSquareWebhook(sqNotificationUrl, sqPaidBody, sqSigKey),
        "square-environment": "Sandbox",
      },
      notificationUrl: sqNotificationUrl,
    });
    expect(sqPaidWh.booked).toBe(true);

    const ws0 = await callerFor(adminPrincipal).refunds.forOrder({ orderPublicId: order.publicId });
    const sqPmt = ws0.payments[0]!;
    expect(sqPmt.provider).toBe("square");

    const sqCreated = await callerFor(adminPrincipal).refunds.create({
      orderPublicId: order.publicId,
      paymentPublicId: sqPmt.paymentPublicId,
      amountMinor: 7_500,
      currency: "USD",
      reason: "Customer cancelled Square order",
      sendCustomerNotice: false,
      confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
      idempotencyKey: "idem-sq-refund-7500",
    });
    expect(sqCreated.status).toBe("pending");
    expect(sqCreated.executionLabel).toBe("Square refund");

    // Transition Square refund to COMPLETED and deliver signed Square `refund.updated` webhook
    protocol.setSquareRefundStatus(sqCreated.providerRefundRef!, "COMPLETED");
    const storedSqRefund = protocol.squareRefunds.get(sqCreated.providerRefundRef!)!;
    const sqRefundBody = Buffer.from(
      JSON.stringify({
        event_id: "sq_evt_rfd_completed_03",
        type: "refund.updated",
        created_at: "2026-11-21T12:00:30.000Z",
        data: {
          type: "refund",
          id: sqCreated.providerRefundRef!,
          object: {
            refund: {
              id: sqCreated.providerRefundRef!,
              payment_id: sqPaymentId,
              ...(storedSqRefund.reason ? { reason: storedSqRefund.reason } : {}),
            },
          },
        },
      }),
      "utf8",
    );
    const sqRfdWh = await payments.handleSignedWebhook({
      provider: "square",
      rawBody: sqRefundBody,
      headers: {
        "x-square-hmacsha256-signature": signSquareWebhook(sqNotificationUrl, sqRefundBody, sqSigKey),
        "square-environment": "Sandbox",
      },
      notificationUrl: sqNotificationUrl,
    });
    expect(sqRfdWh.booked).toBe(true);

    const wsFinal = await callerFor(adminPrincipal).refunds.forOrder({ orderPublicId: order.publicId });
    expect(wsFinal.orderPaymentState).toBe("refunded");
    expect(wsFinal.payments[0]?.refundedMinor).toBe(7_500);
    expect(wsFinal.payments[0]?.refundableMinor).toBe(0);
  });

  it("normalizes cross-customer attempt-only checkoutStatus and cancelAttempt calls to NOT_FOUND:PAYMENT_ATTEMPT_NOT_FOUND", async () => {
    const { compliance, payments, seedOrder } = createHarness();
    await payments.admin.updateSettings(adminPrincipal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      stripeSecretKey: "sk_test_norm_validkey_04",
      stripeWebhookSecret: "whsec_test_norm_validsecret_04",
    });

    const aliceOrder = seedOrder(customerAPrincipal);
    const invoicePublicId = await issueOrderInvoice(compliance, aliceOrder.publicId, 3_000);
    const started = await payments.startCheckout(invoicePublicId, undefined, {
      principal: customerAPrincipal,
      idempotencyKey: "idem-norm-attempt-1",
    });
    if (started.mode !== "redirect") throw new Error("expected redirect");

    // Cross-customer Bob probing Alice's attemptPublicId gets identical PAYMENT_ATTEMPT_NOT_FOUND as a random ULID
    await expect(
      payments.getCheckoutStatus(customerBPrincipal, { attemptPublicId: started.attemptPublicId }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      reasonCode: "PAYMENT_ATTEMPT_NOT_FOUND",
    });

    await expect(
      payments.cancelAttemptIfUnpaid(customerBPrincipal, { attemptPublicId: started.attemptPublicId }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      reasonCode: "PAYMENT_ATTEMPT_NOT_FOUND",
    });
  });
});
