import { createHmac } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModuleDeps, Services } from "../../container.js";
import { DomainError, notFound } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type { DbOrTx, Logger, SessionPrincipal } from "../../core/types.js";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createComplianceModule } from "../compliance/index.js";
import * as complianceSchema from "../compliance/schema.js";
import { users } from "../identity/schema.js";
import type { EgressFetchOptions, EgressFetchResponse, EgressPurpose } from "../integrations/egress.js";
import type { OrderAccessRole, OrderAccessView, OrderLockState, OrdersModule } from "../orders/index.js";
import {
  createPaymentReturnHttpRouter,
  createPaymentsModule,
  createPaymentWebhooksHttpRouter,
  createStripeProvider,
  paymentAttempts,
  paymentWebhookEvents,
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
}

function buildFakeOrders(ordersByPubId: Map<string, FakeOrderRecord>): OrdersModule {
  const byId = () => {
    const m = new Map<number, FakeOrderRecord>();
    for (const o of ordersByPubId.values()) m.set(o.id, o);
    return m;
  };

  function resolveRole(principal: SessionPrincipal, order: FakeOrderRecord): OrderAccessRole | null {
    if (principal.role === "admin") return "admin";
    if (principal.role === "staff") return "staff";
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
  } as unknown as OrdersModule;
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

let globalStripeSeq = 1;

function createFakeStripeProtocol() {
  const sessions = new Map<string, StoredStripeSession>();
  const calls: Array<{ url: string; purpose: EgressPurpose; options: EgressFetchOptions }> = [];
  let nextCreateUrlOverride: string | null = null;
  let failNextFetch = false;

  const fetchPinned = async (
    url: URL | string,
    purpose: EgressPurpose,
    options?: EgressFetchOptions,
  ): Promise<EgressFetchResponse> => {
    const u = typeof url === "string" ? new URL(url) : url;
    const opts = options ?? {};
    calls.push({ url: u.href, purpose, options: opts });
    if (opts.beforeSend) {
      await opts.beforeSend();
    }

    if (u.origin !== "https://api.stripe.com" || purpose !== "stripe") {
      throw new DomainError("FORBIDDEN", "EGRESS_HOST_DENIED", "Blocked by egress fake.");
    }

    if (opts.method === "POST" && u.pathname === "/v1/checkout/sessions") {
      const form = new URLSearchParams(typeof opts.body === "string" ? opts.body : "");
      const auth = opts.headers?.authorization ?? "";
      const livemode = auth.startsWith("Bearer sk_live_");
      const currentSeq = globalStripeSeq++;
      const id = `cs_${livemode ? "live" : "test"}_session_${String(currentSeq).padStart(4, "0")}`;
      const piId = `pi_${livemode ? "live" : "test"}_${String(currentSeq).padStart(4, "0")}`;
      const amount = Number.parseInt(form.get("line_items[0][price_data][unit_amount]") ?? "0", 10);
      const currency = (form.get("line_items[0][price_data][currency]") ?? "usd").toLowerCase();
      const urlOut = nextCreateUrlOverride ?? `https://checkout.stripe.com/c/pay/${id}`;
      nextCreateUrlOverride = null;

      const session: StoredStripeSession = {
        id,
        url: urlOut,
        livemode,
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
      sessions.set(id, session);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify(session), "utf8"),
      };
    }

    if (opts.method === "GET" && u.pathname.startsWith("/v1/checkout/sessions/")) {
      if (failNextFetch) {
        failNextFetch = false;
        throw new DomainError("UNAVAILABLE", "STRIPE_UPSTREAM_TIMEOUT", "Simulated transient network timeout.");
      }
      const sessionId = decodeURIComponent(u.pathname.slice("/v1/checkout/sessions/".length));
      const found = sessions.get(sessionId);
      if (!found) {
        return {
          status: 404,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ error: { message: "No such checkout.session" } }), "utf8"),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify(found), "utf8"),
      };
    }

    return {
      status: 404,
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}", "utf8"),
    };
  };

  return {
    sessions,
    calls,
    fetchPinned,
    setNextRedirectOverride(url: string) {
      nextCreateUrlOverride = url;
    },
    setFailNextFetch(flag: boolean) {
      failNextFetch = flag;
    },
    markPaid(sessionId: string, overrides?: Partial<{ amount_total: number; currency: string }>) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`Unknown session ${sessionId}`);
      s.status = "complete";
      s.payment_status = "paid";
      if (overrides?.amount_total !== undefined) s.amount_total = overrides.amount_total;
      if (overrides?.currency !== undefined) s.currency = overrides.currency;
      s.payment_intent.status = "succeeded";
      s.payment_intent.amount_received = s.amount_total;
    },
    markExpired(sessionId: string) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`Unknown session ${sessionId}`);
      s.status = "expired";
      s.payment_status = "unpaid";
    },
  };
}

function signStripeWebhook(rawBody: Buffer, webhookSecret: string, timestampSec: number): string {
  const signedPayload = Buffer.concat([
    Buffer.from(`${timestampSec}.`, "utf8"),
    rawBody,
  ]);
  const v1 = createHmac("sha256", webhookSecret).update(signedPayload).digest("hex");
  return `t=${timestampSec},v1=${v1}`;
}

let globalSquareSeq = 1;

function createFakeSquareProtocol() {
  const links = new Map<string, { id: string; order_id: string; url: string }>();
  const orders = new Map<
    string,
    {
      id: string;
      location_id: string;
      reference_id: string;
      total_money: { amount: number; currency: string };
      state: string;
      line_items: Array<{
        note: string;
        quantity: "1";
        base_price_money: { amount: number; currency: string };
      }>;
      tenders: Array<{ payment_id?: string }>;
    }
  >();
  const payments = new Map<
    string,
    {
      id: string;
      order_id: string;
      location_id: string;
      status: "COMPLETED" | "APPROVED" | "PENDING" | "FAILED" | "CANCELED";
      amount_money: { amount: number; currency: string };
      total_money: { amount: number; currency: string };
      updated_at: string;
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
    if (purpose !== "square" || (u.hostname !== "connect.squareupsandbox.com" && u.hostname !== "connect.squareup.com")) {
      throw new DomainError("FORBIDDEN", "EGRESS_HOST_DENIED", "Blocked by Square egress fake.");
    }
    const isLive = u.hostname === "connect.squareup.com";

    if (opts.method === "POST" && u.pathname === "/v2/online-checkout/payment-links") {
      const body = JSON.parse(typeof opts.body === "string" ? opts.body : "{}") as {
        order: {
          location_id: string;
          reference_id: string;
          line_items: Array<{
            note: string;
            base_price_money: { amount: number; currency: string };
          }>;
        };
      };
      const seq = globalSquareSeq++;
      const linkId = `sqlink_${String(seq).padStart(4, "0")}`;
      const orderId = `sqord_${String(seq).padStart(4, "0")}`;
      const hostedUrl = isLive
        ? `https://square.link/u/${linkId}`
        : `https://sandbox.square.link/u/${linkId}`;
      const li = body.order.line_items[0]!;
      links.set(linkId, { id: linkId, order_id: orderId, url: hostedUrl });
      orders.set(orderId, {
        id: orderId,
        location_id: body.order.location_id,
        reference_id: body.order.reference_id,
        total_money: li.base_price_money,
        state: "OPEN",
        line_items: [
          {
            note: li.note,
            quantity: "1",
            base_price_money: li.base_price_money,
          },
        ],
        tenders: [],
      });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ payment_link: links.get(linkId) }), "utf8"),
      };
    }

    if (opts.method === "GET" && u.pathname.startsWith("/v2/online-checkout/payment-links/")) {
      const linkId = u.pathname.slice("/v2/online-checkout/payment-links/".length);
      const found = links.get(linkId);
      if (!found) return { status: 404, headers: {}, body: Buffer.from("{}", "utf8") };
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ payment_link: found }), "utf8"),
      };
    }

    if (opts.method === "GET" && u.pathname.startsWith("/v2/orders/")) {
      const orderId = u.pathname.slice("/v2/orders/".length);
      const found = orders.get(orderId);
      if (!found) return { status: 404, headers: {}, body: Buffer.from("{}", "utf8") };
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ order: found }), "utf8"),
      };
    }

    if (opts.method === "GET" && u.pathname.startsWith("/v2/payments/")) {
      const paymentId = u.pathname.slice("/v2/payments/".length);
      const found = payments.get(paymentId);
      if (!found) return { status: 404, headers: {}, body: Buffer.from("{}", "utf8") };
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ payment: found }), "utf8"),
      };
    }

    return { status: 404, headers: {}, body: Buffer.from("{}", "utf8") };
  };

  return {
    fetchPinned,
    completeOrderPayment(orderId: string): string {
      const ord = orders.get(orderId);
      if (!ord) throw new Error(`Unknown Square order ${orderId}`);
      const paymentId = `sqpay_${orderId}`;
      ord.state = "COMPLETED";
      ord.tenders = [{ payment_id: paymentId }];
      payments.set(paymentId, {
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
  };
}

function signSquareWebhook(notificationUrl: string, rawBody: Buffer, sigKey: string): string {
  return createHmac("sha256", sigKey)
    .update(notificationUrl, "utf8")
    .update(rawBody)
    .digest("base64");
}

describe("payments module — Stripe Checkout, signed webhooks, double verification, reconcile & raw HTTP", () => {
  let tdb: TestDb;
  let adminPrincipal: SessionPrincipal;
  let staffPrincipal: SessionPrincipal;
  let customerAPrincipal: SessionPrincipal;
  let customerBPrincipal: SessionPrincipal;
  const ordersMap = new Map<string, FakeOrderRecord>();
  let orderSeq = 700;

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
      { key: "admin", role: "admin" as const, email: "pay-admin@example.test", name: "Admin Pay" },
      { key: "staff", role: "staff" as const, email: "pay-staff@example.test", name: "Staff Pay" },
      { key: "custA", role: "customer" as const, email: "pay-custa@example.test", name: "Customer A" },
      { key: "custB", role: "customer" as const, email: "pay-custb@example.test", name: "Customer B" },
    ];

    const ids: Record<string, { id: number; publicId: string }> = {};
    for (const [idx, u] of seed.entries()) {
      const pubId = ulid(now.getTime() + idx * 10);
      const [ins] = await tdb.db.insert(users).values({
        publicId: pubId,
        emailEnc: `enc:${u.email}`,
        emailIndex: `${idx + 50}`.padStart(64, "b"),
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
    const now = new Date("2026-11-21T12:00:00.000Z");
    const t = createTestDeps({ db: tdb.db, now });
    const logEntries: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
    const testLogger: Logger = {
      debug(message, context) {
        logEntries.push({ level: "debug", message, ...(context ? { context } : {}) });
      },
      info(message, context) {
        logEntries.push({ level: "info", message, ...(context ? { context } : {}) });
      },
      warn(message, context) {
        logEntries.push({ level: "warn", message, ...(context ? { context } : {}) });
      },
      error(message, context) {
        logEntries.push({ level: "error", message, ...(context ? { context } : {}) });
      },
      child() {
        return testLogger;
      },
    };
    const stripeFake = createFakeStripeProtocol();
    const squareFake = createFakeSquareProtocol();
    const referralEvents: Array<{ invoicePublicId: string; orderPublicId: string; totalMinor: number }> = [];
    const paidListenerEvents: Array<{ invoicePublicId: string; paymentPublicId: string }> = [];

    const servicesObj = Object.assign(t.services, {
      config: {
        ...t.config,
        canonicalOrigin: "https://portal.readypackets.test",
      },
      logger: testLogger,
      identity: {
        sessions: {
          async assertCurrent() {
            return { pendingSteps: [] };
          },
        },
      },
      orders: buildFakeOrders(ordersMap),
      integrations: {
        egress: {
          fetchPinned: async (url: URL | string, purpose: EgressPurpose, options?: EgressFetchOptions) => {
            if (purpose === "square") {
              return squareFake.fetchPinned(url, purpose, options);
            }
            return stripeFake.fetchPinned(url, purpose, options);
          },
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
              {
                key: "square_sandbox",
                label: "Square Sandbox API",
                purpose: "square",
                parameterized: false,
                hosts: ["connect.squareupsandbox.com"],
                enabled: true,
                matchingRulePublicIds: [],
              },
            ];
          },
        },
      },
      referrals: {
        async onInvoicePaid(ev: { invoicePublicId: string; orderPublicId: string; totalMinor: number }) {
          referralEvents.push(ev);
        },
      },
    }) as unknown as Services;

    const moduleDeps: ModuleDeps = {
      ...t.deps,
      logger: testLogger,
      config: {
        ...t.config,
        canonicalOrigin: "https://portal.readypackets.test",
      },
      services: servicesObj,
    };

    const compliance = createComplianceModule(moduleDeps);
    compliance.onInvoicePaid(async (ev) => {
      paidListenerEvents.push({
        invoicePublicId: ev.invoicePublicId,
        paymentPublicId: ev.paymentPublicId,
      });
    });
    (servicesObj as unknown as Record<string, unknown>).compliance = compliance;

    const payments = createPaymentsModule(moduleDeps, {
      stripeAdapter: createStripeProvider(() => ({ fetchPinned: stripeFake.fetchPinned })),
    });
    (servicesObj as unknown as Record<string, unknown>).payments = payments;

    async function createIssuedInvoiceForPrincipal(
      owner: SessionPrincipal,
      amountMinor = 25_000,
      currency = "USD",
    ) {
      const ordId = ++orderSeq;
      const ordPub = ulid(t.clock.now().getTime() + ordId);
      const ord: FakeOrderRecord = {
        id: ordId,
        publicId: ordPub,
        reference: `RP-2026-00${ordId}`,
        ownerUserId: owner.userId,
        ownerPublicId: owner.userPublicId,
        lockState: "none",
        origin: "portal",
      };
      ordersMap.set(ordPub, ord);

      const issued = await tdb.db.transaction((tx) =>
        compliance.issueCheckoutInvoiceInTx(
          {
            principal: owner,
            orderPublicId: ord.publicId,
            currency,
            discountMinor: 0,
            lines: [
              {
                description: "ReadyPackets Security Foundations",
                quantity: 1,
                unitAmountMinor: amountMinor,
              },
            ],
          },
          tx,
        ),
      );
      return { order: ord, invoice: issued };
    }

    async function createIssuedInvoiceForCustomerA(amountMinor = 25_000, currency = "USD") {
      return createIssuedInvoiceForPrincipal(customerAPrincipal, amountMinor, currency);
    }

    return {
      deps: moduleDeps,
      audit: t.audit,
      clock: t.clock,
      logEntries,
      compliance,
      payments,
      stripeFake,
      squareFake,
      referralEvents,
      paidListenerEvents,
      createIssuedInvoiceForPrincipal,
      createIssuedInvoiceForCustomerA,
    };
  }

  it("ships disabled by default (`provider = none`): returns pay-by-invoice and makes zero outbound calls", async () => {
    const h = createHarness();
    const { invoice } = await h.createIssuedInvoiceForCustomerA(15_000);

    expect(await h.payments.isOnlineCheckoutEnabled()).toBe(false);
    const pubCfg = await h.payments.getPublicCheckoutConfig();
    expect(pubCfg).toEqual({
      provider: "none",
      mode: "test",
      currency: "USD",
      onlineEnabled: false,
    });

    const started = await h.payments.startCheckout(
      invoice.invoicePublicId,
      { successPath: "/checkout/return", cancelPath: "/checkout/cancel" },
      { principal: customerAPrincipal },
    );
    expect(started).toEqual({
      mode: "invoice",
      invoicePublicId: invoice.invoicePublicId,
    });

    const reconciled = await h.payments.reconcilePendingAttempts();
    expect(reconciled.scanned).toBe(0);
    expect(h.stripeFake.calls).toHaveLength(0);
  });

  it("enforces admin RBAC, fresh step-up, mode-key alignment, fresh-pair rotation, and secret masking", async () => {
    const h = createHarness();

    await expect(h.payments.admin.getSettings(customerAPrincipal)).rejects.toMatchObject({
      code: "FORBIDDEN",
      reasonCode: "CAPABILITY_NOT_GRANTED",
    });
    await expect(h.payments.admin.getSettings(staffPrincipal)).rejects.toMatchObject({
      code: "FORBIDDEN",
      reasonCode: "CAPABILITY_NOT_GRANTED",
    });

    const staleAdmin = fakePrincipal({
      userId: adminPrincipal.userId,
      userPublicId: adminPrincipal.userPublicId,
      role: "admin",
      stepUpAt: new Date("2026-11-21T11:00:00.000Z"), // 60 min old > 10 min STEP_UP_MAX_AGE_MS
    });
    await expect(
      h.payments.admin.updateSettings(staleAdmin, {
        provider: "none",
        mode: "test",
        currency: "USD",
      }),
    ).rejects.toMatchObject({
      code: "STEP_UP_REQUIRED",
    });

    // Activating Stripe without supplying both fresh credentials fails closed.
    await expect(
      h.payments.admin.updateSettings(adminPrincipal, {
        provider: "stripe",
        mode: "test",
        currency: "USD",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      reasonCode: "FRESH_CREDENTIALS_REQUIRED",
    });

    // Live mode rejects `sk_test_` prefix.
    await expect(
      h.payments.admin.updateSettings(adminPrincipal, {
        provider: "stripe",
        mode: "live",
        currency: "USD",
        stripeSecretKey: "sk_test_wrongmode1234567890",
        stripeWebhookSecret: "whsec_wrongmode1234567890",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      reasonCode: "STRIPE_KEY_MODE_MISMATCH",
    });

    const saved = await h.payments.admin.updateSettings(adminPrincipal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      stripeSecretKey: "sk_test_validkey_ABCD",
      stripeWebhookSecret: "whsec_validsecret_9876",
    });

    expect(saved.onlineEnabled).toBe(true);
    expect(saved.stripe.secretKeyConfigured).toBe(true);
    expect(saved.stripe.secretKeyLast4).toBe("ABCD");
    expect(saved.stripe.webhookSecretConfigured).toBe(true);
    expect(saved.stripe.webhookSecretLast4).toBe("9876");
    expect(JSON.stringify(saved)).not.toContain("sk_test_validkey_ABCD");
    expect(JSON.stringify(saved)).not.toContain("whsec_validsecret_9876");

    // Switching test -> live without re-entering fresh live credentials must be refused.
    await expect(
      h.payments.admin.updateSettings(adminPrincipal, {
        provider: "stripe",
        mode: "live",
        currency: "USD",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      reasonCode: "FRESH_CREDENTIALS_REQUIRED",
    });
  });

  it("validates hosted redirect URLs, encrypts redirectUrl at rest, reuses idempotent attempts, and blocks non-owners with NOT_FOUND", async () => {
    const h = createHarness();
    await h.payments.admin.updateSettings(adminPrincipal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      stripeSecretKey: "sk_test_checkout_1111",
      stripeWebhookSecret: "whsec_checkout_2222",
    });

    const { invoice } = await h.createIssuedInvoiceForCustomerA(32_500);

    // Non-owner customer gets NOT_FOUND (no existence oracle).
    await expect(
      h.payments.startCheckout(invoice.invoicePublicId, undefined, { principal: customerBPrincipal }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // Untrusted redirect URL returned by upstream is rejected and marks attempt failed.
    h.stripeFake.setNextRedirectOverride("https://evil.example.org/phish");
    await expect(
      h.payments.startCheckout(
        invoice.invoicePublicId,
        { successPath: "/checkout/return", cancelPath: "/checkout/cancel" },
        { principal: customerAPrincipal, idempotencyKey: "idem-bad-host-1" },
      ),
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
      reasonCode: "STRIPE_UNTRUSTED_REDIRECT_URL",
    });

    // Valid Stripe Checkout creation succeeds and is idempotent on retry.
    const first = await h.payments.startCheckout(
      invoice.invoicePublicId,
      { successPath: "/checkout/return", cancelPath: "/checkout/cancel" },
      { principal: customerAPrincipal, idempotencyKey: "idem-good-1" },
    );
    expect(first.mode).toBe("redirect");
    if (first.mode !== "redirect") throw new Error("expected redirect");
    expect(first.redirectUrl).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/u);

    // Verify outbound egress options included mandatory allowlist & public IP flags.
    const lastCall = h.stripeFake.calls[h.stripeFake.calls.length - 1]!;
    expect(lastCall.purpose).toBe("stripe");
    expect(lastCall.options.requireAllowlistRule).toBe(true);
    expect(lastCall.options.publicAddressesOnly).toBe(true);
    expect(lastCall.options.expectedHostSuffixes).toEqual(["api.stripe.com"]);

    // Verify `redirectUrlEnc` is encrypted at rest (`rpenc:` envelope, never plaintext URL).
    const [storedAttempt] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, first.attemptPublicId));
    expect(storedAttempt?.status).toBe("redirected");
    expect(storedAttempt?.redirectUrlEnc).toBeTruthy();
    expect(storedAttempt?.redirectUrlEnc).not.toContain("checkout.stripe.com");

    // Idempotent retry returns the exact same attempt without calling Stripe again.
    const callCountBeforeRetry = h.stripeFake.calls.length;
    const second = await h.payments.startCheckout(
      invoice.invoicePublicId,
      { successPath: "/checkout/return", cancelPath: "/checkout/cancel" },
      { principal: customerAPrincipal, idempotencyKey: "idem-good-1" },
    );
    expect(second).toEqual(first);
    expect(h.stripeFake.calls).toHaveLength(callCountBeforeRetry);

    // Other customer cannot read or cancel Customer A's attempt.
    await expect(
      h.payments.getCheckoutStatus(customerBPrincipal, { attemptPublicId: first.attemptPublicId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      h.payments.cancelAttemptIfUnpaid(customerBPrincipal, { attemptPublicId: first.attemptPublicId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Cross-reference isolation regression:
    // 1) Customer A supplying their OWN invoicePublicId alongside Customer B's attemptPublicId MUST return NOT_FOUND
    //    and leave Customer B's attempt untouched.
    const { invoice: invB } = await h.createIssuedInvoiceForPrincipal(customerBPrincipal, 21_000);
    const startedB = await h.payments.startCheckout(
      invB.invoicePublicId,
      { successPath: "/checkout/return", cancelPath: "/checkout/cancel" },
      { principal: customerBPrincipal, idempotencyKey: "idem-custb-1" },
    );
    if (startedB.mode !== "redirect") throw new Error("expected redirect");

    await expect(
      h.payments.cancelAttemptIfUnpaid(customerAPrincipal, {
        invoicePublicId: invoice.invoicePublicId,
        attemptPublicId: startedB.attemptPublicId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      h.payments.getCheckoutStatus(customerAPrincipal, {
        invoicePublicId: invoice.invoicePublicId,
        attemptPublicId: startedB.attemptPublicId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const statusB = await h.payments.getCheckoutStatus(customerBPrincipal, {
      attemptPublicId: startedB.attemptPublicId,
    });
    expect(statusB.attempt?.status).toBe("redirected");

    // 2) Customer A supplying their OWN second invoicePublicId alongside their OWN attemptPublicId from invoice #1
    //    MUST return NOT_FOUND and leave attempt #1 untouched.
    const { invoice: invA2 } = await h.createIssuedInvoiceForCustomerA(19_000);
    await expect(
      h.payments.cancelAttemptIfUnpaid(customerAPrincipal, {
        invoicePublicId: invA2.invoicePublicId,
        attemptPublicId: first.attemptPublicId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      h.payments.getCheckoutStatus(customerAPrincipal, {
        invoicePublicId: invA2.invoicePublicId,
        attemptPublicId: first.attemptPublicId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const statusA1StillRedirected = await h.payments.getCheckoutStatus(customerAPrincipal, {
      invoicePublicId: invoice.invoicePublicId,
      attemptPublicId: first.attemptPublicId,
    });
    expect(statusA1StillRedirected.attempt?.status).toBe("redirected");

    // 3) Matching (invoicePublicId, attemptPublicId, owner) succeeds cleanly.
    const cancelledOk = await h.payments.cancelAttemptIfUnpaid(customerAPrincipal, {
      invoicePublicId: invoice.invoicePublicId,
      attemptPublicId: first.attemptPublicId,
    });
    expect(cancelledOk).toEqual({
      cancelled: true,
      attemptPublicId: first.attemptPublicId,
      status: "cancelled",
    });
  });

  it("enforces Decision 12 double verification: return URL & reconcile alone never mark paid; mismatched fetch refuses; valid webhook + fetch books once and fires invoice.paid", async () => {
    const h = createHarness();
    const webhookSecret = "whsec_doubleverify_secret_9999";
    await h.payments.admin.updateSettings(adminPrincipal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      stripeSecretKey: "sk_test_doubleverify_8888",
      stripeWebhookSecret: webhookSecret,
    });

    const { invoice: inv1 } = await h.createIssuedInvoiceForCustomerA(48_000);
    const started1 = await h.payments.startCheckout(
      inv1.invoicePublicId,
      { successPath: "/checkout/return", cancelPath: "/checkout/cancel" },
      { principal: customerAPrincipal, idempotencyKey: "idem-dv-1" },
    );
    if (started1.mode !== "redirect") throw new Error("expected redirect");

    const [att1Before] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, started1.attemptPublicId));
    const sessionId1 = att1Before!.providerRef!;

    // 1. Provider marks session paid, BEFORE any signed webhook arrives:
    //    reconciliation MUST NOT mark invoice paid (`awaiting_webhook`).
    h.stripeFake.markPaid(sessionId1);
    const recBeforeWebhook = await h.payments.reconcilePendingAttempts();
    expect(recBeforeWebhook.booked).toBe(0);
    expect(recBeforeWebhook.stillPending).toBeGreaterThanOrEqual(1);

    const statusBeforeWebhook = await h.payments.getCheckoutStatus(customerAPrincipal, {
      attemptPublicId: started1.attemptPublicId,
    });
    expect(statusBeforeWebhook.invoiceStatus).toBe("issued");
    expect(statusBeforeWebhook.balanceDueMinor).toBe(48_000);
    expect(statusBeforeWebhook.attempt?.status).toBe("redirected");

    // 2. Forged signature and stale timestamp (> 300s) are rejected with 400 and audited.
    const validEventPayload = Buffer.from(
      JSON.stringify({
        id: "evt_test_paid_001",
        type: "checkout.session.completed",
        created: Math.floor(h.clock.now().getTime() / 1000),
        livemode: false,
        data: {
          object: {
            id: sessionId1,
            payment_status: "paid",
            payment_intent: att1Before!.providerPaymentRef,
            metadata: {
              attempt_public_id: started1.attemptPublicId,
              invoice_public_id: inv1.invoicePublicId,
            },
          },
        },
      }),
      "utf8",
    );

    const notificationUrl = "https://portal.readypackets.test/api/payments/webhooks/stripe";
    const forgedRes = await h.payments.handleSignedWebhook({
      provider: "stripe",
      rawBody: validEventPayload,
      headers: { "stripe-signature": "t=1795262400,v1=" + "0".repeat(64) },
      notificationUrl,
    });
    expect(forgedRes.httpStatus).toBe(400);
    expect(forgedRes.booked).toBe(false);

    const staleTs = Math.floor(h.clock.now().getTime() / 1000) - 301;
    const staleRes = await h.payments.handleSignedWebhook({
      provider: "stripe",
      rawBody: validEventPayload,
      headers: { "stripe-signature": signStripeWebhook(validEventPayload, webhookSecret, staleTs) },
      notificationUrl,
    });
    expect(staleRes.httpStatus).toBe(400);
    expect(staleRes.reasonCode).toBe("TIMESTAMP_OUT_OF_RANGE");

    // 3. Transient upstream fetch outage during webhook -> returns 503 `retry_pending`,
    //    then `reconcilePendingAttempts()` completes booking once upstream recovers!
    h.stripeFake.setFailNextFetch(true);
    const nowSec = Math.floor(h.clock.now().getTime() / 1000);
    const sig1 = signStripeWebhook(validEventPayload, webhookSecret, nowSec);
    const transientRes = await h.payments.handleSignedWebhook({
      provider: "stripe",
      rawBody: validEventPayload,
      headers: { "stripe-signature": sig1 },
      notificationUrl,
    });
    expect(transientRes.httpStatus).toBe(503);
    expect(transientRes.booked).toBe(false);

    const recAfterWebhook = await h.payments.reconcilePendingAttempts();
    expect(recAfterWebhook.booked).toBe(1);

    const statusAfterBook = await h.payments.getCheckoutStatus(customerAPrincipal, {
      attemptPublicId: started1.attemptPublicId,
    });
    expect(statusAfterBook.invoiceStatus).toBe("paid");
    expect(statusAfterBook.balanceDueMinor).toBe(0);
    expect(statusAfterBook.attempt?.status).toBe("paid");
    expect(h.paidListenerEvents).toHaveLength(1);
    expect(h.paidListenerEvents[0]?.invoicePublicId).toBe(inv1.invoicePublicId);
    expect(h.referralEvents).toHaveLength(1);
    expect(h.referralEvents[0]?.totalMinor).toBe(48_000);

    // 4. Duplicate replay of exact same event returns 200 duplicate=true with zero duplicate booking.
    const replayRes = await h.payments.handleSignedWebhook({
      provider: "stripe",
      rawBody: validEventPayload,
      headers: { "stripe-signature": sig1 },
      notificationUrl,
    });
    expect(replayRes.httpStatus).toBe(200);
    expect(replayRes.duplicate).toBe(true);
    expect(h.paidListenerEvents).toHaveLength(1);

    // 5. Same externalEventId re-signed with tampered payload bytes returns 409 PAYLOAD_TAMPER_CONFLICT.
    const tamperedBytes = Buffer.from(
      JSON.stringify({
        id: "evt_test_paid_001",
        type: "checkout.session.completed",
        created: nowSec,
        livemode: false,
        data: { object: { id: sessionId1, payment_status: "paid", tampered: true } },
      }),
      "utf8",
    );
    const tamperRes = await h.payments.handleSignedWebhook({
      provider: "stripe",
      rawBody: tamperedBytes,
      headers: { "stripe-signature": signStripeWebhook(tamperedBytes, webhookSecret, nowSec) },
      notificationUrl,
    });
    expect(tamperRes.httpStatus).toBe(409);
    expect(tamperRes.reasonCode).toBe("PAYLOAD_TAMPER_CONFLICT");

    // 6. Amount mismatch between portal invoice and Stripe fetched session -> verification_mismatch, invoice stays unpaid!
    const { invoice: inv2 } = await h.createIssuedInvoiceForCustomerA(60_000);
    const started2 = await h.payments.startCheckout(inv2.invoicePublicId, undefined, {
      principal: customerAPrincipal,
      idempotencyKey: "idem-dv-mismatch",
    });
    if (started2.mode !== "redirect") throw new Error("expected redirect");
    const [att2Row] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, started2.attemptPublicId));

    // Upstream returns 10_000 instead of 60_000!
    h.stripeFake.markPaid(att2Row!.providerRef!, { amount_total: 10_000 });
    const mismatchPayload = Buffer.from(
      JSON.stringify({
        id: "evt_test_mismatch_002",
        type: "checkout.session.completed",
        created: nowSec,
        livemode: false,
        data: {
          object: {
            id: att2Row!.providerRef!,
            payment_status: "paid",
            metadata: {
              attempt_public_id: started2.attemptPublicId,
              invoice_public_id: inv2.invoicePublicId,
            },
          },
        },
      }),
      "utf8",
    );
    const mismatchRes = await h.payments.handleSignedWebhook({
      provider: "stripe",
      rawBody: mismatchPayload,
      headers: { "stripe-signature": signStripeWebhook(mismatchPayload, webhookSecret, nowSec) },
      notificationUrl,
    });
    expect(mismatchRes.httpStatus).toBe(200);
    expect(mismatchRes.booked).toBe(false);
    expect(mismatchRes.reasonCode).toBe("AMOUNT_MISMATCH");

    const inv2Status = await h.payments.getCheckoutStatus(customerAPrincipal, {
      invoicePublicId: inv2.invoicePublicId,
    });
    expect(inv2Status.invoiceStatus).toBe("issued");
    expect(inv2Status.balanceDueMinor).toBe(60_000);
    expect(inv2Status.attempt?.status).toBe("failed");

    const [whMismatchRow] = await tdb.db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.externalEventId, "evt_test_mismatch_002"));
    expect(whMismatchRow?.status).toBe("verification_mismatch");
  });

  it("raw HTTP routers: return route redirects only to fixed same-origin paths with zero DB writes, and webhook error handler never logs raw exception messages", async () => {
    const h = createHarness();
    const { invoice } = await h.createIssuedInvoiceForCustomerA(20_000);
    await h.payments.admin.updateSettings(adminPrincipal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      stripeSecretKey: "sk_test_http_route_3333",
      stripeWebhookSecret: "whsec_http_route_4444",
    });

    const started = await h.payments.startCheckout(
      invoice.invoicePublicId,
      { successPath: "/checkout/return", cancelPath: "/checkout/cancel" },
      { principal: customerAPrincipal },
    );
    if (started.mode !== "redirect") throw new Error("expected redirect");

    const app = express();
    app.use((_req, _res, next) => {
      runWithRequestContext(
        newRequestContext("http", {
          requestId: "req-test-k01",
          correlationId: "corr-test-k01",
        }),
        () => next(),
      );
    });
    app.use(
      "/api/payments/webhooks",
      express.raw({ type: () => true, limit: "512kb" }),
      createPaymentWebhooksHttpRouter(h.deps.services),
    );
    app.use("/api/payments/return", createPaymentReturnHttpRouter(h.deps.services));

    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("unexpected address");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. Return route ignores open-redirect query params and performs zero state mutation.
      const retRes = await fetch(
        `${baseUrl}/api/payments/return/stripe/${started.attemptPublicId}?flow=checkout&redirect=https://evil.test&next=//evil.test`,
        { redirect: "manual" },
      );
      expect(retRes.status).toBe(303);
      expect(retRes.headers.get("location")).toBe(`/checkout/return?attempt=${started.attemptPublicId}`);
      expect(retRes.headers.get("cache-control")).toBe("no-store");

      const cancelNavRes = await fetch(
        `${baseUrl}/api/payments/return/stripe/${started.attemptPublicId}?flow=checkout&outcome=cancelled`,
        { redirect: "manual" },
      );
      expect(cancelNavRes.status).toBe(303);
      expect(cancelNavRes.headers.get("location")).toBe(`/checkout/cancel?attempt=${started.attemptPublicId}`);

      // Attempt is STILL `redirected` (GET return navigation never mutates payment state!).
      const afterNav = await h.payments.getCheckoutStatus(customerAPrincipal, {
        attemptPublicId: started.attemptPublicId,
      });
      expect(afterNav.attempt?.status).toBe("redirected");
      expect(afterNav.invoiceStatus).toBe("issued");

      // Invalid ULID returns 404.
      const badUlidRes = await fetch(`${baseUrl}/api/payments/return/stripe/not-a-ulid`, {
        redirect: "manual",
      });
      expect(badUlidRes.status).toBe(404);

      // 2. Oversized webhook (> 256 KiB) rejected with 413 before signature/JSON work.
      const huge = Buffer.alloc(260 * 1024, 0x61);
      const hugeRes = await fetch(`${baseUrl}/api/payments/webhooks/stripe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: huge,
      });
      expect(hugeRes.status).toBe(413);

      // 3. K-01 regression: if `handleSignedWebhook` throws an unexpected Error containing sensitive text,
      //    logger receives ONLY structured metadata (`reasonCode`, `errorName`, `correlationId`, `requestId`), never `err.message`.
      const origHandle = h.payments.handleSignedWebhook;
      (h.payments as { handleSignedWebhook: typeof origHandle }).handleSignedWebhook = async () => {
        throw new Error("Sensitive secret sk_live_SUPERSECRET_LEAK in upstream error");
      };
      const boomRes = await fetch(`${baseUrl}/api/payments/webhooks/stripe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.from("{}", "utf8"),
      });
      expect(boomRes.status).toBe(500);
      const serializedLogs = JSON.stringify(h.logEntries);
      expect(serializedLogs).not.toContain("sk_live_SUPERSECRET_LEAK");
      expect(serializedLogs).toContain("corr-test-k01");
      expect(serializedLogs).toContain("req-test-k01");
      (h.payments as { handleSignedWebhook: typeof origHandle }).handleSignedWebhook = origHandle;
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("Square Payment Links end-to-end: rejects mismatched square-environment header and books once upon verified Sandbox webhook + authoritative link/order/payment fetch", async () => {
    const h = createHarness();
    const sqSigKey = "sq_wh_sigkey_sandbox_9876543210";
    await h.payments.admin.updateSettings(adminPrincipal, {
      provider: "square",
      mode: "test",
      currency: "USD",
      squareLocationId: "L_SANDBOX_LOC01",
      squareAccessToken: "EAAA_sandbox_token_valid_123456",
      squareWebhookSignatureKey: sqSigKey,
    });

    const { invoice } = await h.createIssuedInvoiceForCustomerA(32_500);
    const started = await h.payments.startCheckout(invoice.invoicePublicId, undefined, {
      principal: customerAPrincipal,
      idempotencyKey: "idem-sq-e2e-1",
    });
    expect(started.mode).toBe("redirect");
    if (started.mode !== "redirect") throw new Error("expected redirect");
    expect(started.provider).toBe("square");
    expect(started.redirectUrl.startsWith("https://sandbox.square.link/u/")).toBe(true);

    const [attRow] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, started.attemptPublicId));
    const sqOrderId = attRow!.providerOrderRef!;
    const sqPaymentId = h.squareFake.completeOrderPayment(sqOrderId);

    const notificationUrl = "https://portal.readypackets.test/api/payments/webhooks/square";
    const sqBody = Buffer.from(
      JSON.stringify({
        event_id: "sq_evt_paid_001",
        type: "payment.updated",
        created_at: h.clock.now().toISOString(),
        data: {
          type: "payment",
          id: sqPaymentId,
          object: {
            payment: {
              id: sqPaymentId,
              order_id: sqOrderId,
              status: "COMPLETED",
            },
          },
        },
      }),
      "utf8",
    );
    const sqSig = signSquareWebhook(notificationUrl, sqBody, sqSigKey);

    // Unsigned header claiming `Production` against `test` mode config MUST be rejected with 400 ENVIRONMENT_MISMATCH
    // and never switch credentials or mark the attempt paid.
    const wrongEnvRes = await h.payments.handleSignedWebhook({
      provider: "square",
      rawBody: sqBody,
      headers: {
        "x-square-hmacsha256-signature": sqSig,
        "square-environment": "Production",
      },
      notificationUrl,
    });
    expect(wrongEnvRes.httpStatus).toBe(400);
    expect(wrongEnvRes.reasonCode).toBe("WEBHOOK_MODE_MISMATCH");

    // Matching `Sandbox` header + valid HMAC + authoritative Square link/order/payment fetch books once!
    const okRes = await h.payments.handleSignedWebhook({
      provider: "square",
      rawBody: sqBody,
      headers: {
        "x-square-hmacsha256-signature": sqSig,
        "square-environment": "Sandbox",
      },
      notificationUrl,
    });
    expect(okRes.httpStatus).toBe(200);
    expect(okRes.booked).toBe(true);

    const status = await h.payments.getCheckoutStatus(customerAPrincipal, {
      attemptPublicId: started.attemptPublicId,
    });
    expect(status.invoiceStatus).toBe("paid");
    expect(status.balanceDueMinor).toBe(0);
    expect(status.attempt?.status).toBe("paid");
    expect(h.paidListenerEvents).toHaveLength(1);
    expect(h.referralEvents).toHaveLength(1);
    expect(h.referralEvents[0]?.totalMinor).toBe(32_500);
  });

  it("Increment 05 (G-C3-02): getAttemptExposureForOrderInTx & orderPaymentExposureInTx report providerAttemptEver: true across stored failed, cancelled, and expired payment_attempts rows", async () => {
    const h = createHarness();
    const now = h.clock.now();

    // 1. Clean voided-invoice order with ZERO payment_attempts rows -> providerAttemptEver: false
    const clean = await h.createIssuedInvoiceForCustomerA(18_000);
    await h.compliance.invoices.admin.void(adminPrincipal, {
      invoicePublicId: clean.invoice.invoicePublicId,
      reason: "Order cancelled before any checkout attempt",
    });
    const cleanExposure = await tdb.db.transaction((tx) =>
      h.compliance.orderPaymentExposureInTx(tx, clean.order.publicId),
    );
    expect(cleanExposure).toEqual({
      grossPaidMinor: 0,
      payableInvoiceOpen: false,
      providerCapturePending: false,
      providerAttemptEver: false,
    });

    // 2. Stored `expired`, `failed` (unverified + webhook-verified), and `cancelled` rows each force `providerAttemptEver: true`
    const terminalCases: Array<{
      label: string;
      status: "expired" | "failed" | "cancelled";
      verifiedWebhookEventId: string | null;
      expectedCapturePending: boolean;
    }> = [
      {
        label: "expired",
        status: "expired",
        verifiedWebhookEventId: null,
        expectedCapturePending: false,
      },
      {
        label: "failed_without_webhook",
        status: "failed",
        verifiedWebhookEventId: null,
        expectedCapturePending: false,
      },
      {
        label: "failed_with_verified_webhook",
        status: "failed",
        verifiedWebhookEventId: "evt_failed_real_row_1",
        expectedCapturePending: true,
      },
      {
        label: "cancelled",
        status: "cancelled",
        verifiedWebhookEventId: null,
        expectedCapturePending: true,
      },
    ];

    for (const [idx, tc] of terminalCases.entries()) {
      const created = await h.createIssuedInvoiceForCustomerA(20_000 + idx * 100);
      await h.compliance.invoices.admin.void(adminPrincipal, {
        invoicePublicId: created.invoice.invoicePublicId,
        reason: `Voided after ${tc.label} provider attempt`,
      });
      const [invRow] = await tdb.db
        .select({ id: complianceSchema.complianceInvoices.id })
        .from(complianceSchema.complianceInvoices)
        .where(eq(complianceSchema.complianceInvoices.publicId, created.invoice.invoicePublicId));

      await tdb.db.insert(paymentAttempts).values({
        publicId: ulid(now.getTime() + 9_100 + idx),
        invoiceId: invRow!.id,
        invoicePublicId: created.invoice.invoicePublicId,
        orderPublicId: created.order.publicId,
        customerUserId: customerAPrincipal.userId,
        provider: "stripe",
        environment: "test",
        status: tc.status,
        amountMinor: 20_000 + idx * 100,
        currency: "USD",
        idempotencyKey: `idem-gc302-${tc.label}`,
        successPath: `/orders/${created.order.publicId}`,
        cancelPath: `/orders/${created.order.publicId}`,
        providerRef: `cs_test_gc302_${tc.label}`,
        verifiedWebhookEventId: tc.verifiedWebhookEventId,
        createdAt: now,
        updatedAt: now,
      });

      const directExposure = await tdb.db.transaction((tx) =>
        h.payments.getAttemptExposureForOrderInTx(tx, created.order.publicId, [invRow!.id]),
      );
      expect(directExposure).toEqual({
        providerCapturePending: tc.expectedCapturePending,
        providerAttemptEver: true,
      });

      // Match by `orderPublicId` alone (even when `invoiceIds` is empty) also reports `providerAttemptEver: true`
      const orderOnlyExposure = await tdb.db.transaction((tx) =>
        h.payments.getAttemptExposureForOrderInTx(tx, created.order.publicId, []),
      );
      expect(orderOnlyExposure).toEqual({
        providerCapturePending: tc.expectedCapturePending,
        providerAttemptEver: true,
      });

      const fullExposure = await tdb.db.transaction((tx) =>
        h.compliance.orderPaymentExposureInTx(tx, created.order.publicId),
      );
      expect(fullExposure).toEqual({
        grossPaidMinor: 0,
        payableInvoiceOpen: false,
        providerCapturePending: tc.expectedCapturePending,
        providerAttemptEver: true,
      });
    }
  });
});

