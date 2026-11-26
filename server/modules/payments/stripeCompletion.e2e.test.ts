/**
 * Increment 07 — Decision D9 (Stripe completion), Decision D12 (receipt PDF sync port),
 * and Decision D5 (payment & intake automation trigger resolvers) end-to-end suite.
 *
 * Exercises real MySQL (including migration 0007), real `OrdersModule` (v3 stages + `INVOICE_PAID`),
 * real `CartModule` (`carts.status = "checked_out"`), real `ComplianceModule` (invoices, numbered
 * `RPR-...` receipts, `ensurePdfForArchive`, intake submissions), real `OpsAlertsModule`, and real
 * `PaymentsModule` (`paymentsRouter` + `mountPaymentsHttp`) against a protocol-level fake Stripe API
 * wired solely at `services.integrations.egress` (`isPresetEnabled` + `fetchPinned`).
 */
import { createHmac } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal } from "../../core/types.js";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { users } from "../identity/schema.js";
import * as orderTables from "../orders/schema.js";
import { createOrdersModule } from "../orders/index.js";
import { STANDARD_V3_DEFINITION, STANDARD_V3_WORKFLOW_KEY, STANDARD_V3_WORKFLOW_NAME } from "../orders/stageModel.js";
import { workflowDefinitionSchema } from "../orders/workflowTypes.js";
import { FakeEngagement, FakeFiles, fakeIdentity, insertUser } from "../orders/testSupport.js";
import * as complianceTables from "../compliance/schema.js";
import { createComplianceModule } from "../compliance/index.js";
import {
  resolveIntakeTriggerContext,
  resolveInvoiceTriggerContext,
} from "../compliance/automationTriggers.js";
import * as cartTables from "../cart/schema.js";
import { createCartModule } from "../cart/index.js";
import { cartRouter } from "../cart/router.js";
import * as opsAlertTables from "../opsAlerts/schema.js";
import { createOpsAlertsModule } from "../opsAlerts/index.js";
import type { EgressFetchOptions, EgressFetchResponse, EgressPurpose } from "../integrations/egress.js";
import {
  createPaymentReturnHttpRouter,
  createPaymentsModule,
  createPaymentWebhooksHttpRouter,
  parsePaymentsConfigSetting,
  paymentRefunds,
  paymentsRouter,
  paymentWebhookEvents,
  paymentWebhookRejections,
  REFUND_CONFIRMATION_PHRASE,
} from "./index.js";
import * as paymentsTables from "./schema.js";

const fullSchema = {
  users,
  ...orderTables,
  ...complianceTables,
  ...cartTables,
  ...opsAlertTables,
  ...paymentsTables,
};

interface FakeStripeSession {
  id: string;
  url: string;
  livemode: boolean;
  status: "open" | "complete" | "expired";
  payment_status: "unpaid" | "paid" | "no_payment_required";
  amount_total: number;
  currency: string;
  expires_at: number;
  metadata: Record<string, string>;
  idempotencyKey: string | null;
  payment_intent: {
    id: string;
    status: "requires_payment_method" | "processing" | "succeeded" | "canceled";
    amount_received: number;
    amount_refunded: number;
    created: number;
    latest_charge: { id: string; balance_transaction: string } | null;
  };
}

interface FakeStripeRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  payment_intent: string;
  charge: string | null;
  status: "pending" | "succeeded" | "failed" | "canceled";
  created: number;
  metadata: Record<string, string>;
}

function signStripeWebhook(rawBody: Buffer, secret: string, timestampSec: number): string {
  const signedPayload = `${timestampSec}.${rawBody.toString("utf8")}`;
  const sig = createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
  return `t=${timestampSec},v1=${sig}`;
}

let stripeSeq = 500;

function createProtocolFakeStripe(opts: { nowSec: () => number }) {
  let stripeEgressEnabled = false;
  let stripeRuleVersion = 1;
  const sessions = new Map<string, FakeStripeSession>();
  const sessionByIdem = new Map<string, FakeStripeSession>();
  const refunds = new Map<string, FakeStripeRefund>();
  const requests: Array<{ method: string; path: string; search: string; idempotencyKey: string | null }> = [];
  let dropNextRefundPost = false;

  const egress = {
    setStripePreset(enabled: boolean) {
      if (stripeEgressEnabled !== enabled) {
        stripeRuleVersion += 1;
      }
      stripeEgressEnabled = enabled;
    },
    async isPresetEnabled(key: string): Promise<boolean> {
      return key === "stripe" ? stripeEgressEnabled : false;
    },
    async listPresets() {
      return [
        {
          key: "stripe",
          label: "Stripe API",
          enabled: stripeEgressEnabled,
          parameterized: false,
        },
      ];
    },
    async listAllowlist() {
      return [
        {
          publicId: "01JSTRIPEEGRESSRULE0000001",
          purpose: "stripe" as const,
          pattern: "api.stripe.com",
          enabled: stripeEgressEnabled,
          version: stripeRuleVersion,
        },
      ];
    },
    async fetchPinned(
      url: string | URL,
      _purpose: EgressPurpose,
      init: EgressFetchOptions = {},
    ): Promise<EgressFetchResponse> {
      const parsed = typeof url === "string" ? new URL(url) : url;
      if (parsed.hostname !== "api.stripe.com") {
        throw new DomainError("FORBIDDEN", "EGRESS_HOST_NOT_ALLOWLISTED", "Host not allowlisted.");
      }
      if (!stripeEgressEnabled) {
        throw new DomainError("FORBIDDEN", "EGRESS_HOST_NOT_ALLOWLISTED", "Stripe egress preset is off.");
      }

      const method = (init.method ?? "GET").toUpperCase();
      const idemHeader =
        init.headers?.["Idempotency-Key"] ?? init.headers?.["idempotency-key"] ?? null;
      requests.push({
        method,
        path: parsed.pathname,
        search: parsed.search,
        idempotencyKey: idemHeader,
      });

      const auth = init.headers?.Authorization ?? init.headers?.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
      const livemode = token.startsWith("sk_live_") || token.startsWith("rk_live_");
      const decodeBody = () => {
        if (!init.body) return "";
        if (typeof init.body === "string") return init.body;
        if (Buffer.isBuffer(init.body)) return init.body.toString("utf8");
        if (init.body instanceof Uint8Array) return Buffer.from(init.body).toString("utf8");
        return "";
      };

      // GET /v1/checkout/sessions?limit=1 (testConnection)
      if (method === "GET" && parsed.pathname === "/v1/checkout/sessions") {
        if ((!token.startsWith("sk_") && !token.startsWith("rk_")) || token.includes("_fake_401_")) {
          return {
            status: 401,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify({ error: { code: "invalid_api_key" } }), "utf8"),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({
              object: "list",
              data: [...sessions.values()].slice(0, 1),
              has_more: false,
            }),
            "utf8",
          ),
        };
      }

      // POST /v1/checkout/sessions
      if (method === "POST" && parsed.pathname === "/v1/checkout/sessions") {
        if (idemHeader && sessionByIdem.has(idemHeader)) {
          const cached = sessionByIdem.get(idemHeader)!;
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify(cached), "utf8"),
          };
        }
        const rawForm = decodeBody();
        const form = new URLSearchParams(rawForm);
        stripeSeq += 1;
        const sessionId = `cs_test_inc07_${stripeSeq}`;
        const piId = `pi_test_inc07_${stripeSeq}`;
        const chId = `ch_test_inc07_${stripeSeq}`;
        const amountMinor = Number(form.get("line_items[0][price_data][unit_amount]") ?? "0");
        const currency = (form.get("line_items[0][price_data][currency]") ?? "usd").toLowerCase();
        const metadata: Record<string, string> = {};
        for (const [k, v] of form.entries()) {
          const match = /^metadata\[([a-zA-Z0-9_]+)\]$/u.exec(k);
          if (match?.[1]) metadata[match[1]] = v;
        }
        const now = opts.nowSec();
        const created: FakeStripeSession = {
          id: sessionId,
          url: `https://checkout.stripe.com/c/pay/${sessionId}`,
          livemode,
          status: "open",
          payment_status: "unpaid",
          amount_total: amountMinor,
          currency,
          expires_at: Number(form.get("expires_at") ?? String(now + 1800)),
          metadata,
          idempotencyKey: idemHeader,
          payment_intent: {
            id: piId,
            status: "requires_payment_method",
            amount_received: 0,
            amount_refunded: 0,
            created: now,
            latest_charge: { id: chId, balance_transaction: `txn_inc07_${stripeSeq}` },
          },
        };
        sessions.set(sessionId, created);
        if (idemHeader) sessionByIdem.set(idemHeader, created);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(created), "utf8"),
        };
      }

      // POST /v1/checkout/sessions/:id/expire (verifyCheckoutSession probe cleanup)
      if (
        method === "POST" &&
        parsed.pathname.startsWith("/v1/checkout/sessions/") &&
        parsed.pathname.endsWith("/expire")
      ) {
        const sessionId = decodeURIComponent(
          parsed.pathname.slice("/v1/checkout/sessions/".length, -"/expire".length),
        );
        const session = sessions.get(sessionId);
        if (!session) {
          return {
            status: 404,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify({ error: { code: "resource_missing" } }), "utf8"),
          };
        }
        const expired: FakeStripeSession = { ...session, status: "expired" };
        sessions.set(sessionId, expired);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(expired), "utf8"),
        };
      }

      // GET /v1/checkout/sessions/:id?expand[]=payment_intent.latest_charge
      if (method === "GET" && parsed.pathname.startsWith("/v1/checkout/sessions/")) {
        const sessionId = decodeURIComponent(parsed.pathname.slice("/v1/checkout/sessions/".length));
        const session = sessions.get(sessionId);
        if (!session) {
          return {
            status: 404,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify({ error: { code: "resource_missing" } }), "utf8"),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(session), "utf8"),
        };
      }

      // POST /v1/refunds
      if (method === "POST" && parsed.pathname === "/v1/refunds") {
        const rawForm = decodeBody();
        const form = new URLSearchParams(rawForm);
        stripeSeq += 1;
        const refundId = `re_test_inc07_${stripeSeq}`;
        const metadata: Record<string, string> = {};
        for (const [k, v] of form.entries()) {
          const match = /^metadata\[([a-zA-Z0-9_]+)\]$/u.exec(k);
          if (match?.[1]) metadata[match[1]] = v;
        }
        const piId = form.get("payment_intent") ?? "";
        const matchingSession = [...sessions.values()].find((s) => s.payment_intent.id === piId);
        const refund: FakeStripeRefund = {
          id: refundId,
          object: "refund",
          amount: Number(form.get("amount") ?? "0"),
          currency: (form.get("currency") ?? matchingSession?.currency ?? "usd").toLowerCase(),
          payment_intent: piId,
          charge: matchingSession?.payment_intent.latest_charge?.id ?? null,
          status: "succeeded",
          created: opts.nowSec(),
          metadata,
        };
        refunds.set(refundId, refund);
        if (matchingSession) {
          matchingSession.payment_intent.amount_refunded += refund.amount;
        }
        if (dropNextRefundPost) {
          dropNextRefundPost = false;
          throw new DomainError("UNAVAILABLE", "EGRESS_NETWORK_ERROR", "Simulated TCP drop after Stripe accepted refund.");
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(refund), "utf8"),
        };
      }

      // GET /v1/refunds?payment_intent=...
      if (method === "GET" && parsed.pathname === "/v1/refunds") {
        const piFilter = parsed.searchParams.get("payment_intent");
        const list = [...refunds.values()].filter((r) => !piFilter || r.payment_intent === piFilter);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ object: "list", data: list, has_more: false }), "utf8"),
        };
      }

      // GET /v1/refunds/:id
      if (method === "GET" && parsed.pathname.startsWith("/v1/refunds/")) {
        const refundId = decodeURIComponent(parsed.pathname.slice("/v1/refunds/".length));
        const found = refunds.get(refundId);
        if (!found) {
          return {
            status: 404,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify({ error: { code: "resource_missing" } }), "utf8"),
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
        body: Buffer.from(JSON.stringify({ error: { code: "unknown_endpoint" } }), "utf8"),
      };
    },
  };

  return {
    egress,
    sessions,
    refunds,
    requests,
    setDropNextRefundPost(value: boolean) {
      dropNextRefundPost = value;
    },
    markSessionPaid(sessionId: string) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`missing session ${sessionId}`);
      s.status = "complete";
      s.payment_status = "paid";
      s.payment_intent.status = "succeeded";
      s.payment_intent.amount_received = s.amount_total;
    },
    markSessionAsyncProcessing(sessionId: string) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`missing session ${sessionId}`);
      s.status = "complete";
      s.payment_status = "unpaid";
      s.payment_intent.status = "processing";
      s.payment_intent.amount_received = 0;
    },
    markSessionFailed(sessionId: string) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`missing session ${sessionId}`);
      s.status = "open";
      s.payment_status = "unpaid";
      s.payment_intent.status = "canceled";
      s.payment_intent.amount_received = 0;
    },
    injectUnlinkedDashboardRefund(piId: string, amountMinor: number, currency = "usd"): FakeStripeRefund {
      stripeSeq += 1;
      const r: FakeStripeRefund = {
        id: `re_dashboard_unlinked_${stripeSeq}`,
        object: "refund",
        amount: amountMinor,
        currency: currency.toLowerCase(),
        payment_intent: piId,
        charge: `ch_dashboard_${stripeSeq}`,
        status: "succeeded",
        created: opts.nowSec(),
        metadata: {},
      };
      refunds.set(r.id, r);
      return r;
    },
  };
}

const e2eRouter = router({
  cart: cartRouter,
  payments: paymentsRouter,
});
const createCaller = createCallerFactory(e2eRouter);

describe("Increment 07 — Stripe completion (D9), receipt PDF sync port (D12), and payment/intake triggers (D5)", () => {
  let tdb: TestDb;

  beforeAll(async () => {
    tdb = await createTestDb({ schema: fullSchema });
  });

  afterAll(async () => {
    await tdb?.cleanup();
  });

  async function buildStack() {
    const h = createTestDeps({
      db: tdb.db,
      config: { canonicalOrigin: "https://portal.example.test" },
    });
    const fakeStripe = createProtocolFakeStripe({
      nowSec: () => Math.floor(h.clock.now().getTime() / 1000),
    });
    const identityFake = fakeIdentity(h, tdb.db);
    const filesFake = new FakeFiles();
    const engagementFake = new FakeEngagement();

    h.services.identity = identityFake as unknown as Services["identity"];
    h.services.files = filesFake as unknown as Services["files"];
    h.services.engagement = engagementFake as unknown as Services["engagement"];
    h.services.integrations = {
      egress: fakeStripe.egress,
    } as unknown as Services["integrations"];

    const ordersMod = createOrdersModule(h.deps);
    h.services.orders = ordersMod;
    const complianceMod = createComplianceModule(h.deps);
    h.services.compliance = complianceMod;
    const opsAlertsMod = createOpsAlertsModule(h.deps);
    h.services.opsAlerts = opsAlertsMod;
    const paymentsMod = createPaymentsModule(h.deps);
    h.services.payments = paymentsMod;
    const cartMod = createCartModule(h.deps);
    h.services.cart = cartMod;

    ordersMod.init?.();
    complianceMod.init?.();
    opsAlertsMod.init?.();
    paymentsMod.init?.();
    cartMod.init?.();
    h.settings.flags.add("cart");

    const admin = await insertUser(h, tdb.db, { role: "admin", stepUp: true });
    const staff = await insertUser(h, tdb.db, { role: "staff" });
    const buyer = await insertUser(h, tdb.db, { role: "customer" });
    await tdb.db.update(users).set({ customerRef: `CUST-${ulid().slice(-6)}` }).where(eq(users.id, buyer.id));

    // Ensure v3 standard workflow with INVOICE_PAID phase transition is active as default
    const existingDefault = await tdb.db
      .select()
      .from(orderTables.orderWorkflows)
      .where(eq(orderTables.orderWorkflows.isDefault, true))
      .limit(1);
    if (existingDefault.length === 0) {
      const wfPubId = ulid();
      const [wfInserted] = await tdb.db
        .insert(orderTables.orderWorkflows)
        .values({
          publicId: wfPubId,
          workflowKey: `${STANDARD_V3_WORKFLOW_KEY}_${wfPubId.slice(-6).toLowerCase()}`,
          name: STANDARD_V3_WORKFLOW_NAME,
          isDefault: true,
        })
        .$returningId();
      const [verInserted] = await tdb.db
        .insert(orderTables.orderWorkflowVersions)
        .values({
          publicId: ulid(),
          workflowId: wfInserted!.id,
          versionNumber: 1,
          definition: workflowDefinitionSchema.parse(STANDARD_V3_DEFINITION),
          createdByUserId: admin.id,
        })
        .$returningId();
      await tdb.db
        .update(orderTables.orderWorkflows)
        .set({ currentVersionId: verInserted!.id })
        .where(eq(orderTables.orderWorkflows.id, wfInserted!.id));
    }

    // Seed or reuse an active catalogue product for cart checkout
    const [existingProduct] = await tdb.db
      .select({ publicId: orderTables.catalogProducts.publicId })
      .from(orderTables.catalogProducts)
      .where(eq(orderTables.catalogProducts.active, true))
      .limit(1);

    let product: { publicId: string };
    if (existingProduct) {
      product = existingProduct;
    } else {
      const suffix = ulid().slice(-6).toLowerCase();
      const group = await ordersMod.catalog.createGroup(admin.principal, {
        name: `Packet 1 Strategy ${suffix}`,
        description: "Strategy packet group",
        packetNumber: 1,
        sortOrder: 1,
        active: true,
      });
      product = await ordersMod.catalog.createProduct(admin.principal, {
        groupId: group.publicId,
        productKey: `p1-std-${suffix}`,
        packetNumber: 1,
        tier: "Standard",
        sortOrder: 1,
        active: true,
        name: "Packet 1 — Standard",
        description: "Core strategy packet",
        deliverables: [{ title: "Roadmap", detail: "Executive roadmap" }],
        outcome: "Approved roadmap",
        timeline: "5 business days",
        features: ["Roadmap"],
        priceMinor: 25_000,
        currency: "USD",
      });
    }

    const callerFor = (session: SessionPrincipal | null) =>
      createCaller({
        services: h.services,
        session,
        request: newRequestContext("test"),
        transport: { issue() {}, clear() {} },
      });

    return {
      h,
      fakeStripe,
      ordersMod,
      complianceMod,
      opsAlertsMod,
      paymentsMod,
      cartMod,
      admin,
      staff,
      buyer,
      product,
      callerFor,
    };
  }

  it("completes cart -> submit -> issue invoice -> Stripe Checkout -> signed webhook -> cart checked_out + order paid + INVOICE_PAID stage advance + receipt PDF archive + payment.succeeded trigger", async () => {
    const stack = await buildStack();
    const { h, fakeStripe, ordersMod, complianceMod, paymentsMod, admin, buyer, product, callerFor } = stack;
    const stripeSk = "sk_test_inc07_e2e_secret_4242";
    const stripeWh = "whsec_test_inc07_e2e_primary_9876";

    // 1. Stage Stripe credentials while provider stays "none" (Pay by invoice remains active)
    const stagedView = await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "none",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      squareLocationId: null,
      stripeSecretKey: stripeSk,
      stripeWebhookSecret: stripeWh,
    });
    expect(stagedView.provider).toBe("none");
    expect(stagedView.onlineEnabled).toBe(false);
    expect(stagedView.stripe.secretKeyConfigured).toBe(true);
    expect(stagedView.stripe.secretKeyLast4).toBe("4242");
    expect(stagedView.stripe.webhookSecretConfigured).toBe(true);
    expect(stagedView.stripe.webhookSecretLast4).toBe("9876");
    expect(stagedView.stripe.egressAllowlisted).toBe(false);
    expect(stagedView.stripe.ready).toBe(false);

    // 2. With egress preset off, testConnection reports egress blocked (ok: false)
    const blockedConn = await paymentsMod.admin.testConnection(admin.principal);
    expect(blockedConn.ok).toBe(false);
    expect(blockedConn.failureReasonCode).toBe("EGRESS_HOST_NOT_ALLOWLISTED");

    // 3. Enable Stripe egress preset -> testConnection succeeds via GET /v1/checkout/sessions?limit=1 & sendSelfTestWebhook verifies signature
    fakeStripe.egress.setStripePreset(true);
    const okConn = await paymentsMod.admin.testConnection(admin.principal);
    expect(okConn.ok).toBe(true);
    expect(okConn.verifiedAt).not.toBeNull();

    const probeCheck = await paymentsMod.admin.verifyCheckoutSession(admin.principal);
    expect(probeCheck.ok).toBe(true);
    expect(probeCheck.expiredImmediately).toBe(true);

    const selfTest = await paymentsMod.admin.sendSelfTestWebhook(admin.principal);
    expect(selfTest.ok).toBe(true);
    expect(selfTest.httpStatus).toBe(200);
    expect(selfTest.reasonCode).toBe("SELF_TEST_OK");

    // 4. Activate Stripe Checkout using the already-staged keys
    const activeView = await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      squareLocationId: null,
    });
    expect(activeView.provider).toBe("stripe");
    expect(activeView.onlineEnabled).toBe(true);
    expect(activeView.stripe.ready).toBe(true);
    expect(activeView.stripe.lastSelfTestWebhookAt).not.toBeNull();

    // 5. Customer adds Packet 1 to cart and submits checkout
    const buyerCaller = callerFor(buyer.principal);
    const added = await buyerCaller.cart.addItems({
      items: [{ productPublicId: product.publicId, quantity: 1 }],
    });
    const submitted = await buyerCaller.cart.checkout({
      cartPublicId: added.cartPublicId!,
      expectedVersion: added.version,
      expectedTotalMinor: added.totals.totalMinor,
      projectName: "Increment 07 Stripe E2E Project",
      note: "Ready for kickoff",
      billing: {
        fullName: "Example Buyer LLC",
        email: "billing@buyer.example.test",
        country: "US",
        addressLine1: "100 Main St",
        city: "New York",
        postalCode: "10001",
      },
      policyAcceptances: [],
      idempotencyKey: `idem-cart-inc07-${ulid()}`,
    });
    expect(submitted.mode).toBe("redirect");
    if (submitted.mode !== "redirect") throw new Error("expected redirect checkout");
    expect(submitted.provider).toBe("stripe");
    expect(submitted.redirectUrl).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_inc07_/u);

    // Verify POST /v1/checkout/sessions was called with an Idempotency-Key for cart checkout
    const postSessionReq = fakeStripe.requests.find(
      (r) =>
        r.method === "POST" &&
        r.path === "/v1/checkout/sessions" &&
        !r.idempotencyKey?.startsWith("rp-probe-"),
    );
    expect(postSessionReq).toBeDefined();
    expect(postSessionReq?.idempotencyKey).toMatch(/^rp-checkout:/u);

    // Before webhook: cart is awaiting_payment (resumable), order is awaiting_payment in payment_confirmed stage
    const [cartBefore] = await tdb.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, added.cartPublicId!));
    expect(cartBefore?.status).toBe("awaiting_payment");

    const [orderBefore] = await tdb.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, submitted.orderPublicId));
    expect(orderBefore?.statusKey).toBe("awaiting_payment");
    expect(orderBefore?.paymentState).toBe("unpaid");

    // 6. Stripe settles the Checkout Session and delivers signed checkout.session.completed
    const stripeSession = [...fakeStripe.sessions.values()].find(
      (s) => s.metadata.attempt_public_id === submitted.attemptPublicId,
    )!;
    expect(stripeSession).toBeDefined();
    fakeStripe.markSessionPaid(stripeSession.id);

    const tsSec = Math.floor(h.clock.now().getTime() / 1000);
    const rawWebhook = Buffer.from(
      JSON.stringify({
        id: `evt_paid_e2e_${ulid().slice(-8)}`,
        type: "checkout.session.completed",
        livemode: false,
        created: tsSec,
        data: {
          object: {
            id: stripeSession.id,
            payment_status: "paid",
            metadata: stripeSession.metadata,
          },
        },
      }),
      "utf8",
    );
    const webhookRes = await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: rawWebhook,
      headers: { "stripe-signature": signStripeWebhook(rawWebhook, stripeWh, tsSec) },
      notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    });
    expect(webhookRes.httpStatus).toBe(200);
    expect(webhookRes.booked).toBe(true);

    // Confirm double-verification requested expand[]=payment_intent.latest_charge
    const expandGet = fakeStripe.requests.find(
      (r) =>
        r.method === "GET" &&
        r.path === `/v1/checkout/sessions/${stripeSession.id}` &&
        r.search.includes("payment_intent.latest_charge"),
    );
    expect(expandGet).toBeDefined();

    // 7. Inside the booking transaction:
    // - Invoice is paid
    const paidInvoice = await complianceMod.invoices.get(buyer.principal, submitted.invoicePublicId);
    expect(paidInvoice.status).toBe("paid");
    expect(paidInvoice.balanceDueMinor).toBe(0);

    // - Cart transitioned to checked_out via cart.onInvoicePaidInTx
    const [cartAfter] = await tdb.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, added.cartPublicId!));
    expect(cartAfter?.status).toBe("checked_out");

    // - Order paymentState is "paid" AND v3 workflow stage advanced across INVOICE_PAID (awaiting_payment -> intake_open / phase_1_intake)
    const [orderAfter] = await tdb.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, submitted.orderPublicId));
    expect(orderAfter?.paymentState).toBe("paid");
    expect(orderAfter?.statusKey).toBe("intake_open");
    const stageWorkspace = await ordersMod.stages.workspace(buyer.principal, {
      orderId: submitted.orderPublicId,
    });
    expect(stageWorkspace.currentStageKey).toBe("phase_1_intake");

    // - Numbered immutable payment receipt RPR-... issued & D12 getFileSyncPdf returns decryptable PDF bytes
    const orderReceipts = await complianceMod.receipts.forOrder(
      buyer.principal,
      submitted.orderPublicId,
    );
    expect(orderReceipts).toHaveLength(1);
    expect(orderReceipts[0]?.receiptNumber).toMatch(/^RPR-\d{4}-\d{6}$/u);

    const syncedPdfBytes = await tdb.db.transaction((tx) =>
      complianceMod.receipts.getFileSyncPdf(
        {
          receiptPublicId: orderReceipts[0]!.receiptPublicId,
          orderPublicId: submitted.orderPublicId,
        },
        tx,
      ),
    );
    expect(syncedPdfBytes).not.toBeNull();
    expect(syncedPdfBytes!.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    // - checkoutStatus returns receiptPublicId for customer return banner
    const checkoutStatus = await buyerCaller.payments.checkoutStatus({
      attemptPublicId: submitted.attemptPublicId,
    });
    expect(checkoutStatus.invoiceStatus).toBe("paid");
    expect(checkoutStatus.receiptPublicId).toBe(orderReceipts[0]!.receiptPublicId);

    // - D5 payment.succeeded trigger context resolves order & invoice fields from invoice.payment.recorded audit event
    const paymentRecordedAudit = h.audit
      .named("invoice.payment.recorded")
      .find((e) => e.attributes?.invoice_public_id === submitted.invoicePublicId)!;
    expect(paymentRecordedAudit).toBeDefined();
    const resolvedCtx = await resolveInvoiceTriggerContext({
      triggerKey: "payment.succeeded",
      event: {
        eventName: paymentRecordedAudit.eventName,
        outcome: paymentRecordedAudit.outcome,
        resource: paymentRecordedAudit.resource ?? null,
        attributes: paymentRecordedAudit.attributes,
      } as never,
      db: tdb.db,
      services: h.services,
      signal: new AbortController().signal,
    });
    expect(resolvedCtx.orderPublicId).toBe(submitted.orderPublicId);
    expect(resolvedCtx.fields?.order_reference).toBe(orderAfter?.reference);
    expect(resolvedCtx.fields?.invoice_number).toBe(paidInvoice.invoiceNumber);
    expect(resolvedCtx.recipients?.order_owner).toEqual([buyer.id]);
  });

  it("handles async bank-debit unpaid -> 200 AWAITING_ASYNC_SETTLEMENT -> async_payment_succeeded, and async_payment_failed -> order payment_failed", async () => {
    const stack = await buildStack();
    const { h, fakeStripe, complianceMod, paymentsMod, admin, buyer, product, callerFor } = stack;
    const stripeSk = "sk_test_inc07_async_secret_1111";
    const stripeWh = "whsec_test_inc07_async_whsec_2222";
    fakeStripe.egress.setStripePreset(true);

    await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "none",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      squareLocationId: null,
      stripeSecretKey: stripeSk,
      stripeWebhookSecret: stripeWh,
    });
    expect((await paymentsMod.admin.testConnection(admin.principal)).ok).toBe(true);
    expect((await paymentsMod.admin.verifyCheckoutSession(admin.principal)).ok).toBe(true);
    expect((await paymentsMod.admin.sendSelfTestWebhook(admin.principal)).ok).toBe(true);
    await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      squareLocationId: null,
    });

    const buyerCaller = callerFor(buyer.principal);
    const added = await buyerCaller.cart.addItems({
      items: [{ productPublicId: product.publicId, quantity: 1 }],
    });
    const submitted = await buyerCaller.cart.checkout({
      cartPublicId: added.cartPublicId!,
      expectedVersion: added.version,
      expectedTotalMinor: added.totals.totalMinor,
      projectName: "Async ACH Settlement Order",
      note: "",
      billing: {
        fullName: "Async Buyer Corp",
        email: "ach@buyer.example.test",
        country: "US",
        addressLine1: "200 Market St",
        city: "San Francisco",
        postalCode: "94105",
      },
      policyAcceptances: [],
      idempotencyKey: `idem-async-inc07-${ulid()}`,
    });
    if (submitted.mode !== "redirect") throw new Error("expected redirect");

    const session = [...fakeStripe.sessions.values()].find(
      (s) => s.metadata.attempt_public_id === submitted.attemptPublicId,
    )!;
    // ACH / SEPA Checkout completes redirect while payment_status is still "unpaid" (processing)
    fakeStripe.markSessionAsyncProcessing(session.id);

    const tsSec = Math.floor(h.clock.now().getTime() / 1000);
    const completedUnpaidBody = Buffer.from(
      JSON.stringify({
        id: `evt_async_unpaid_${ulid().slice(-8)}`,
        type: "checkout.session.completed",
        livemode: false,
        created: tsSec,
        data: {
          object: {
            id: session.id,
            status: "complete",
            payment_status: "unpaid",
            metadata: session.metadata,
          },
        },
      }),
      "utf8",
    );
    const unpaidRes = await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: completedUnpaidBody,
      headers: { "stripe-signature": signStripeWebhook(completedUnpaidBody, stripeWh, tsSec) },
      notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    });
    // Must return 200 (never 503!) and keep attempt redirected + invoice issued while awaiting async settlement
    expect(unpaidRes.httpStatus).toBe(200);
    expect(unpaidRes.accepted).toBe(true);
    expect(unpaidRes.booked).toBe(false);
    expect(unpaidRes.reasonCode).toBe("AWAITING_ASYNC_SETTLEMENT");

    const [whAwaiting] = await tdb.db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.attemptPublicId, submitted.attemptPublicId));
    expect(whAwaiting?.status).toBe("awaiting_settlement");

    const invStillIssued = await complianceMod.invoices.get(
      buyer.principal,
      submitted.invoicePublicId,
    );
    expect(invStillIssued.status).toBe("issued");

    // Days later, bank debit clears -> checkout.session.async_payment_succeeded settles invoice & order
    fakeStripe.markSessionPaid(session.id);
    const asyncPaidBody = Buffer.from(
      JSON.stringify({
        id: `evt_async_paid_${ulid().slice(-8)}`,
        type: "checkout.session.async_payment_succeeded",
        livemode: false,
        created: tsSec + 60,
        data: {
          object: {
            id: session.id,
            status: "complete",
            payment_status: "paid",
            metadata: session.metadata,
          },
        },
      }),
      "utf8",
    );
    const asyncPaidRes = await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: asyncPaidBody,
      headers: { "stripe-signature": signStripeWebhook(asyncPaidBody, stripeWh, tsSec + 60) },
      notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    });
    expect(asyncPaidRes.httpStatus).toBe(200);
    expect(asyncPaidRes.booked).toBe(true);

    const invNowPaid = await complianceMod.invoices.get(buyer.principal, submitted.invoicePublicId);
    expect(invNowPaid.status).toBe("paid");

    // Second order: async_payment_failed transitions attempt -> failed, emits payments.attempt.failed, and flags order payment_failed
    const addedFail = await buyerCaller.cart.addItems({
      items: [{ productPublicId: product.publicId, quantity: 1 }],
    });
    const submittedFail = await buyerCaller.cart.checkout({
      cartPublicId: addedFail.cartPublicId!,
      expectedVersion: addedFail.version,
      expectedTotalMinor: addedFail.totals.totalMinor,
      projectName: "Async ACH Failed Order",
      note: "",
      billing: {
        fullName: "Async Fail Corp",
        email: "fail@buyer.example.test",
        country: "US",
        addressLine1: "200 Market St",
        city: "San Francisco",
        postalCode: "94105",
      },
      policyAcceptances: [],
      idempotencyKey: `idem-async-fail-${ulid()}`,
    });
    if (submittedFail.mode !== "redirect") throw new Error("expected redirect");
    const failSession = [...fakeStripe.sessions.values()].find(
      (s) => s.metadata.attempt_public_id === submittedFail.attemptPublicId,
    )!;
    // First enters pending_async via completed+unpaid, then reverts to unpaid on async_payment_failed
    fakeStripe.markSessionAsyncProcessing(failSession.id);
    const pendingFailBody = Buffer.from(
      JSON.stringify({
        id: `evt_async_pend2_${ulid().slice(-8)}`,
        type: "checkout.session.completed",
        livemode: false,
        created: tsSec + 75,
        data: {
          object: {
            id: failSession.id,
            status: "complete",
            payment_status: "unpaid",
            metadata: failSession.metadata,
          },
        },
      }),
      "utf8",
    );
    await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: pendingFailBody,
      headers: { "stripe-signature": signStripeWebhook(pendingFailBody, stripeWh, tsSec + 75) },
      notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    });
    const [orderPendingAsync] = await tdb.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, submittedFail.orderPublicId));
    expect(orderPendingAsync?.paymentState).toBe("pending_async");

    fakeStripe.markSessionFailed(failSession.id);

    const asyncFailBody = Buffer.from(
      JSON.stringify({
        id: `evt_async_fail_${ulid().slice(-8)}`,
        type: "checkout.session.async_payment_failed",
        livemode: false,
        created: tsSec + 90,
        data: {
          object: {
            id: failSession.id,
            status: "open",
            payment_status: "unpaid",
            metadata: failSession.metadata,
          },
        },
      }),
      "utf8",
    );
    const failRes = await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: asyncFailBody,
      headers: { "stripe-signature": signStripeWebhook(asyncFailBody, stripeWh, tsSec + 90) },
      notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    });
    expect(failRes.httpStatus).toBe(200);
    expect(failRes.booked).toBe(false);
    expect(failRes.reasonCode).toBe("FAILED");

    const [failedOrder] = await tdb.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, submittedFail.orderPublicId));
    expect(failedOrder?.paymentState).toBe("unpaid");

    const [failedAttempt] = await tdb.db
      .select()
      .from(paymentsTables.paymentAttempts)
      .where(eq(paymentsTables.paymentAttempts.publicId, submittedFail.attemptPublicId));
    expect(failedAttempt?.status).toBe("failed");

    const failedAudit = h.audit
      .named("payments.attempt.failed")
      .find((e) => e.attributes?.order_public_id === submittedFail.orderPublicId);
    expect(failedAudit?.outcome).toBe("failed");
  });

  it("settles portal refunds on charge.refunded via GET /v1/refunds?payment_intent=... and flags unlinked Dashboard refunds in opsAlerts without auto-booking", async () => {
    const stack = await buildStack();
    const { h, fakeStripe, complianceMod, opsAlertsMod, paymentsMod, admin, buyer, product, callerFor } = stack;
    const stripeSk = "sk_test_inc07_rfd_secret_3333";
    const stripeWh = "whsec_test_inc07_rfd_whsec_4444";
    fakeStripe.egress.setStripePreset(true);

    await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "none",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      squareLocationId: null,
      stripeSecretKey: stripeSk,
      stripeWebhookSecret: stripeWh,
    });
    expect((await paymentsMod.admin.testConnection(admin.principal)).ok).toBe(true);
    expect((await paymentsMod.admin.verifyCheckoutSession(admin.principal)).ok).toBe(true);
    expect((await paymentsMod.admin.sendSelfTestWebhook(admin.principal)).ok).toBe(true);
    await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      squareLocationId: null,
    });

    const buyerCaller = callerFor(buyer.principal);
    const adminCaller = callerFor(admin.principal);
    const added = await buyerCaller.cart.addItems({
      items: [{ productPublicId: product.publicId, quantity: 1 }],
    });
    const submitted = await buyerCaller.cart.checkout({
      cartPublicId: added.cartPublicId!,
      expectedVersion: added.version,
      expectedTotalMinor: added.totals.totalMinor,
      projectName: "Refund Listing & Flagging Order",
      note: "",
      billing: {
        fullName: "Refund Buyer Corp",
        email: "refunds@buyer.example.test",
        country: "US",
        addressLine1: "100 Main St",
        city: "New York",
        postalCode: "10001",
      },
      policyAcceptances: [],
      idempotencyKey: `idem-rfd-inc07-${ulid()}`,
    });
    if (submitted.mode !== "redirect") throw new Error("expected redirect");

    const session = [...fakeStripe.sessions.values()].find(
      (s) => s.metadata.attempt_public_id === submitted.attemptPublicId,
    )!;
    fakeStripe.markSessionPaid(session.id);

    const tsSec = Math.floor(h.clock.now().getTime() / 1000);
    const paidBody = Buffer.from(
      JSON.stringify({
        id: `evt_rfd_paid_${ulid().slice(-8)}`,
        type: "checkout.session.completed",
        livemode: false,
        created: tsSec,
        data: { object: { id: session.id, payment_status: "paid", metadata: session.metadata } },
      }),
      "utf8",
    );
    await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: paidBody,
      headers: { "stripe-signature": signStripeWebhook(paidBody, stripeWh, tsSec) },
      notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    });

    const ws = await adminCaller.payments.refunds.forOrder({ orderPublicId: submitted.orderPublicId });
    const paymentPublicId = ws.payments[0]!.paymentPublicId;
    const piId = session.payment_intent.id;

    // 1. Portal refund drops after Stripe accepted POST -> status "unknown", providerRefundRef null
    fakeStripe.setDropNextRefundPost(true);
    const portalRefund = await adminCaller.payments.refunds.create({
      orderPublicId: submitted.orderPublicId,
      paymentPublicId,
      amountMinor: 5_000,
      currency: "USD",
      reason: "Partial scope credit",
      sendCustomerNotice: false,
      confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
      idempotencyKey: `idem-portal-rfd-${ulid()}`,
    });
    expect(portalRefund.status).toBe("unknown");

    // Stripe sends `charge.refunded` WITHOUT embedded `refunds.data` -> server lists GET /v1/refunds?payment_intent=pi_... and settles portalRefund!
    const chargeRefundedPortalBody = Buffer.from(
      JSON.stringify({
        id: `evt_ch_rfd_portal_${ulid().slice(-8)}`,
        type: "charge.refunded",
        livemode: false,
        created: tsSec + 20,
        data: {
          object: {
            id: session.payment_intent.latest_charge!.id,
            payment_intent: piId,
            refunded: false,
            amount_refunded: 5_000,
            refunds: { object: "list", data: [] },
          },
        },
      }),
      "utf8",
    );
    const settledViaList = await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: chargeRefundedPortalBody,
      headers: { "stripe-signature": signStripeWebhook(chargeRefundedPortalBody, stripeWh, tsSec + 20) },
      notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    });
    expect(settledViaList.httpStatus).toBe(200);
    expect(settledViaList.booked).toBe(true);

    const listReq = fakeStripe.requests.find(
      (r) => r.method === "GET" && r.path === "/v1/refunds" && r.search.includes(`payment_intent=${piId}`),
    );
    expect(listReq).toBeDefined();

    const [settledRow] = await tdb.db
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.publicId, portalRefund.refundPublicId));
    expect(settledRow?.status).toBe("succeeded");

    const [orderAfterPartial] = await tdb.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, submitted.orderPublicId));
    expect(orderAfterPartial?.paymentState).toBe("partially_refunded");

    // 2. Operator issues an unlinked refund directly in Stripe Dashboard (no portal metadata) -> charge.refunded flags UNLINKED_PROVIDER_REFUND + opsAlerts!
    const unlinkedDashRefund = fakeStripe.injectUnlinkedDashboardRefund(piId, 2_500, "USD");
    const chargeRefundedDashBody = Buffer.from(
      JSON.stringify({
        id: `evt_ch_rfd_dash_${ulid().slice(-8)}`,
        type: "charge.refunded",
        livemode: false,
        created: tsSec + 40,
        data: {
          object: {
            id: session.payment_intent.latest_charge!.id,
            payment_intent: piId,
            refunded: false,
            amount_refunded: 7_500,
            refunds: { object: "list", data: [] },
          },
        },
      }),
      "utf8",
    );
    const flaggedRes = await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: chargeRefundedDashBody,
      headers: { "stripe-signature": signStripeWebhook(chargeRefundedDashBody, stripeWh, tsSec + 40) },
      notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    });
    expect(flaggedRes.httpStatus).toBe(200);
    expect(flaggedRes.booked).toBe(false);
    expect(flaggedRes.reasonCode).toBe("UNLINKED_PROVIDER_REFUND");

    // Invoice ledger refundedMinor stayed at 5_000 (unlinked Dashboard refund was NEVER auto-booked)
    const invAfterFlag = await complianceMod.invoices.get(
      buyer.principal,
      submitted.invoicePublicId,
    );
    expect(invAfterFlag.refundedMinor).toBe(5_000);

    // Operational alert emitted without exposing raw provider IDs in dedupKey, title, or text
    const alerts = await opsAlertsMod.list({ source: "payment" });
    const unlinkedAlert = alerts.items.find(
      (a) => a.code === "UNLINKED_PROVIDER_REFUND" && a.orderPublicId === submitted.orderPublicId,
    );
    expect(unlinkedAlert).toBeDefined();
    expect(unlinkedAlert?.title).not.toContain(unlinkedDashRefund.id);
    expect(unlinkedAlert?.text ?? "").not.toContain(unlinkedDashRefund.id);
  });

  it("supports secondary signing secret rollover, logs zero-secret webhook rejections with 14-day pruning, parses legacy config defaults, and enforces router guard ordering + intake trigger resolution", async () => {
    const stack = await buildStack();
    const { h, fakeStripe, complianceMod, paymentsMod, admin, staff, buyer, product, callerFor } = stack;
    const primaryWh = "whsec_test_inc07_primary_rotate_1111";
    const secondaryWh = "whsec_test_inc07_secondary_rotate_2222";
    fakeStripe.egress.setStripePreset(true);

    await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "none",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      squareLocationId: null,
      stripeSecretKey: "sk_test_inc07_rotate_5555",
      stripeWebhookSecret: primaryWh,
      stripeWebhookSecretSecondary: secondaryWh,
    });
    expect((await paymentsMod.admin.testConnection(admin.principal)).ok).toBe(true);
    expect((await paymentsMod.admin.verifyCheckoutSession(admin.principal)).ok).toBe(true);
    expect((await paymentsMod.admin.sendSelfTestWebhook(admin.principal)).ok).toBe(true);
    const savedWithSecondary = await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      squareLocationId: null,
    });
    expect(savedWithSecondary.stripe.webhookSecretSecondaryConfigured).toBe(true);
    expect(savedWithSecondary.stripe.webhookSecretSecondaryLast4).toBe("2222");

    // Express raw HTTP mount verifies webhook signed with SECONDARY secret
    const app = express();
    app.use("/api/payments/webhooks", createPaymentWebhooksHttpRouter(h.services));
    app.use("/api/payments/return", createPaymentReturnHttpRouter(h.services));

    const tsSec = Math.floor(h.clock.now().getTime() / 1000);
    const secondaryPingBody = Buffer.from(
      JSON.stringify({
        id: `evt_secondary_ok_${ulid().slice(-8)}`,
        type: "charge.succeeded",
        livemode: false,
        created: tsSec,
        data: { object: { id: "ch_untracked_01" } },
      }),
      "utf8",
    );
    const secondaryDelivered = await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: secondaryPingBody,
      headers: { "stripe-signature": signStripeWebhook(secondaryPingBody, secondaryWh, tsSec) },
      notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    });
    expect(secondaryDelivered.httpStatus).toBe(200);
    expect(secondaryDelivered.accepted).toBe(true);

    // Retire secondary signing secret -> webhook signed with retired secondary secret now rejects (400) and logs safe rejection row
    const afterRetire = await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      squareLocationId: null,
      clearStripeWebhookSecretSecondary: true,
    });
    expect(afterRetire.stripe.webhookSecretSecondaryConfigured).toBe(false);
    expect(afterRetire.stripe.webhookSecretSecondaryLast4).toBeNull();

    const badSigBody = Buffer.from(
      JSON.stringify({
        id: `evt_retired_sig_${ulid().slice(-8)}`,
        type: "checkout.session.completed",
        livemode: false,
        created: tsSec,
        sensitiveCardHint: "NEVER_STORE_RAW_BODY_MARKER_9999",
        data: { object: { id: "cs_fake_01" } },
      }),
      "utf8",
    );
    const rejected = await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: badSigBody,
      headers: { "stripe-signature": signStripeWebhook(badSigBody, secondaryWh, tsSec) },
      notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    });
    expect(rejected.httpStatus).toBe(400);
    expect(rejected.accepted).toBe(false);

    // Seed a 15-day-old rejection row and verify 14-day retention pruning
    const fifteenDaysAgo = new Date(h.clock.now().getTime() - 15 * 24 * 60 * 60 * 1000);
    const staleRejectionPubId = ulid();
    await tdb.db.insert(paymentWebhookRejections).values({
      publicId: staleRejectionPubId,
      provider: "stripe",
      environmentHint: "test",
      reasonCode: "WEBHOOK_TIMESTAMP_EXPIRED",
      httpStatus: 400,
      skewSeconds: 900,
      receivedAt: fifteenDaysAgo,
    });
    await paymentsMod.pruneExpiredWebhookRejections(h.clock.now());

    const listedRejections = await callerFor(admin.principal).payments.admin.listWebhookRejections({
      limit: 20,
      provider: "stripe",
    });
    expect(listedRejections.items.some((r) => r.rejectionPublicId === staleRejectionPubId)).toBe(false);
    const latestRejection = listedRejections.items[0]!;
    expect(latestRejection.reasonCode).toMatch(/SIGNATURE/u);
    expect(JSON.stringify(latestRejection)).not.toContain("NEVER_STORE_RAW_BODY_MARKER_9999");
    expect(JSON.stringify(latestRejection)).not.toContain(secondaryWh);

    // Legacy Increment 06 stored config shape (without stripeWebhookSecretSecondaryLast4 / verification timestamps) parses cleanly with defaults
    const parsedLegacy = parsePaymentsConfigSetting({
      provider: "stripe",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      stripeSecretKeyLast4: null,
      stripeWebhookSecretLast4: null,
      squareAccessTokenLast4: null,
      squareWebhookSignatureKeyLast4: null,
      squareLocationId: null,
    });
    expect(parsedLegacy.stripeWebhookSecretSecondaryLast4).toBeNull();
    expect(parsedLegacy.stripeLastApiVerifiedAt).toBeNull();
    expect(parsedLegacy.stripeLastSelfTestAt).toBeNull();

    // Router guard ordering: UNAUTHORIZED / FORBIDDEN fire BEFORE Zod input validation
    const anonCaller = callerFor(null);
    const customerCaller = callerFor(fakePrincipal({ userId: buyer.id, role: "customer" }));
    await expect(
      anonCaller.payments.admin.testConnection({ provider: "invalid_provider" as never }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      customerCaller.payments.admin.testConnection({ provider: "invalid_provider" as never }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      anonCaller.payments.admin.sendSelfTestWebhook({ provider: "invalid_provider" as never }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      customerCaller.payments.admin.listWebhookRejections({ limit: -999 as never }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // D5 intake.submitted and intake.reviewed trigger context resolution
    const buyerCaller = callerFor(buyer.principal);
    const added = await buyerCaller.cart.addItems({
      items: [{ productPublicId: product.publicId, quantity: 1 }],
    });
    const submittedOrder = await buyerCaller.cart.checkout({
      cartPublicId: added.cartPublicId!,
      expectedVersion: added.version,
      expectedTotalMinor: added.totals.totalMinor,
      projectName: "Intake Trigger Order",
      note: "",
      billing: {
        fullName: "Intake Corp",
        email: "intake@buyer.example.test",
        country: "US",
        addressLine1: "100 Main St",
        city: "New York",
        postalCode: "10001",
      },
      policyAcceptances: [],
      idempotencyKey: `idem-intake-trig-${ulid()}`,
    });

    const qCreated = await complianceMod.intake.admin.createQuestionnaire(admin.principal, {
      slug: `kickoff-${ulid().slice(-6).toLowerCase()}`,
      title: "Kickoff Brief",
      description: "Kickoff questions",
      scopeKind: "default",
      scopeRef: null,
      fields: [
        {
          key: "goal",
          label: "Primary goal",
          section: "Overview",
          type: "short_text",
          required: true,
          sensitive: false,
        },
      ],
    });
    await complianceMod.intake.admin.publishVersion(admin.principal, qCreated.draftVersionPublicId);
    const subRes = await complianceMod.intake.submit(buyer.principal, {
      orderPublicId: submittedOrder.orderPublicId,
      questionnairePublicId: qCreated.questionnairePublicId,
      answers: { goal: "Ship Stripe Checkout cleanly" },
    });
    await complianceMod.intake.review(staff.principal, {
      submissionPublicId: subRes.submissionPublicId,
      decision: "accepted",
      reviewNote: "Approved for synthesis.",
    });

    const intakeSubAudit = h.audit
      .named("intake.submission.submitted")
      .find((e) => e.resource?.publicId === subRes.submissionPublicId)!;
    const intakeRevAudit = h.audit
      .named("intake.submission.reviewed")
      .find((e) => e.resource?.publicId === subRes.submissionPublicId)!;
    expect(intakeSubAudit).toBeDefined();
    expect(intakeRevAudit).toBeDefined();

    const subCtx = await resolveIntakeTriggerContext({
      triggerKey: "intake.submitted",
      event: {
        eventName: intakeSubAudit.eventName,
        outcome: intakeSubAudit.outcome,
        resource: intakeSubAudit.resource ?? null,
        attributes: intakeSubAudit.attributes,
      } as never,
      db: tdb.db,
      services: h.services,
      signal: new AbortController().signal,
    });
    expect(subCtx.orderPublicId).toBe(submittedOrder.orderPublicId);
    expect(subCtx.recipients?.order_owner).toEqual([buyer.id]);

    const revCtx = await resolveIntakeTriggerContext({
      triggerKey: "intake.reviewed",
      event: {
        eventName: intakeRevAudit.eventName,
        outcome: intakeRevAudit.outcome,
        resource: intakeRevAudit.resource ?? null,
        attributes: intakeRevAudit.attributes,
      } as never,
      db: tdb.db,
      services: h.services,
      signal: new AbortController().signal,
    });
    expect(revCtx.orderPublicId).toBe(submittedOrder.orderPublicId);
    expect(JSON.stringify(intakeSubAudit.attributes)).not.toContain("Ship Stripe Checkout cleanly");
  });

  it("enforces verified API + self-test gates on activation, invalidates verification on key/mode/egress changes, labels rejection reasons, and alerts on unmatched portal-metadata webhooks while ignoring shared-account sessions", async () => {
    const stack = await buildStack();
    const { h, fakeStripe, opsAlertsMod, paymentsMod, admin, callerFor } = stack;
    const adminCaller = callerFor(admin.principal);
    const stripeWh = "whsec_test_qa_live_defects_9999";

    fakeStripe.egress.setStripePreset(true);

    // 1. Defect 1: stage a syntactically valid fake sk_test_ key that returns HTTP 401 on testConnection.
    await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "none",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      squareLocationId: null,
      stripeSecretKey: "sk_test_fake_401_rejected_by_stripe_0001",
      stripeWebhookSecret: stripeWh,
    });

    const rejectedConn = await paymentsMod.admin.testConnection(admin.principal);
    expect(rejectedConn.ok).toBe(false);
    expect(rejectedConn.failureReasonCode).toBe("STRIPE_AUTH_INVALID_KEY");
    expect(rejectedConn.message).toBe("Stripe rejected the staged secret key (HTTP 401).");
    expect((await paymentsMod.admin.sendSelfTestWebhook(admin.principal)).ok).toBe(true);

    // Activation MUST be refused with STRIPE_API_NOT_VERIFIED!
    await expect(
      paymentsMod.admin.updateSettings(admin.principal, {
        provider: "stripe",
        mode: "test",
        currency: "USD",
        successPath: "/checkout/return",
        cancelPath: "/checkout/cancel",
        webhookToleranceSeconds: 300,
        squareLocationId: null,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      reasonCode: "STRIPE_API_NOT_VERIFIED",
    });

    const readinessFake = await paymentsMod.admin.readiness(admin.principal);
    expect(readinessFake.onlineEnabled).toBe(false);
    expect(
      readinessFake.checklist.find((item) => item.key === "api_connection_verified")?.ready,
    ).toBe(false);

    // Stage a working test key and verify API -> toggling egress preset invalidates lastApiVerifiedAt!
    await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "none",
      mode: "test",
      currency: "USD",
      stripeSecretKey: "sk_test_working_key_0002",
    });
    expect((await paymentsMod.admin.testConnection(admin.principal)).ok).toBe(true);
    expect((await paymentsMod.admin.getSettings(admin.principal)).stripe.lastApiVerifiedAt).not.toBeNull();

    // Toggling egress off and back on bumps rule version -> invalidates lastApiVerifiedAt until re-tested!
    fakeStripe.egress.setStripePreset(false);
    await expect(
      paymentsMod.admin.updateSettings(admin.principal, {
        provider: "stripe",
        mode: "test",
        currency: "USD",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      reasonCode: "STRIPE_EGRESS_NOT_ALLOWLISTED",
    });

    fakeStripe.egress.setStripePreset(true);
    expect((await paymentsMod.admin.getSettings(admin.principal)).stripe.lastApiVerifiedAt).toBeNull();
    await expect(
      paymentsMod.admin.updateSettings(admin.principal, {
        provider: "stripe",
        mode: "test",
        currency: "USD",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      reasonCode: "STRIPE_API_NOT_VERIFIED",
    });

    // Re-verify API + Checkout session probe -> activate succeeds -> switching back to Pay by invoice ("none") works cleanly.
    expect((await paymentsMod.admin.testConnection(admin.principal)).ok).toBe(true);
    expect((await paymentsMod.admin.verifyCheckoutSession(admin.principal)).ok).toBe(true);
    const activated = await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
    });
    expect(activated.provider).toBe("stripe");
    expect(activated.onlineEnabled).toBe(true);

    // Rotating the staged secret key invalidates lastApiVerifiedAt + probe immediately.
    const rotated = await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "none",
      mode: "test",
      currency: "USD",
      stripeSecretKey: "sk_test_working_key_0003",
    });
    expect(rotated.provider).toBe("none");
    expect(rotated.stripe.lastApiVerifiedAt).toBeNull();
    expect((await paymentsMod.admin.testConnection(admin.principal)).ok).toBe(true);
    await expect(
      paymentsMod.admin.updateSettings(admin.principal, {
        provider: "stripe",
        mode: "test",
        currency: "USD",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      reasonCode: "STRIPE_CHECKOUT_SESSION_NOT_VERIFIED",
    });
    expect((await paymentsMod.admin.verifyCheckoutSession(admin.principal)).ok).toBe(true);
    await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
    });

    // 2. Defect 2 & 3: exercise missing signature, invalid signature, stale timestamp, malformed JSON, and livemode mismatch.
    const notificationUrl = "https://portal.example.test/api/payments/webhooks/stripe";
    const nowSec = Math.floor(h.clock.now().getTime() / 1000);
    const sampleEventBuf = Buffer.from(
      JSON.stringify({
        id: "evt_rej_check_1",
        type: "checkout.session.completed",
        livemode: false,
        created: nowSec,
        data: { object: { id: "cs_test_rej_1", payment_status: "paid" } },
      }),
      "utf8",
    );

    await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: sampleEventBuf,
      headers: {},
      notificationUrl,
    });
    await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: sampleEventBuf,
      headers: { "stripe-signature": signStripeWebhook(sampleEventBuf, "whsec_wrong_secret", nowSec) },
      notificationUrl,
    });
    await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: sampleEventBuf,
      headers: { "stripe-signature": signStripeWebhook(sampleEventBuf, stripeWh, nowSec - 900) },
      notificationUrl,
    });
    const malformedJsonBuf = Buffer.from("{not-valid-json", "utf8");
    await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: malformedJsonBuf,
      headers: { "stripe-signature": signStripeWebhook(malformedJsonBuf, stripeWh, nowSec) },
      notificationUrl,
    });
    const liveMismatchBuf = Buffer.from(
      JSON.stringify({
        id: "evt_live_mismatch_1",
        type: "checkout.session.completed",
        livemode: true,
        created: nowSec,
        data: { object: { id: "cs_live_rej_1", payment_status: "paid" } },
      }),
      "utf8",
    );
    await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: liveMismatchBuf,
      headers: { "stripe-signature": signStripeWebhook(liveMismatchBuf, stripeWh, nowSec) },
      notificationUrl,
    });

    const allRej = await adminCaller.payments.admin.listWebhookRejections({
      provider: "stripe",
      limit: 20,
    });
    const byCode = new Map(allRej.items.map((r) => [r.reasonCode, r]));
    expect(byCode.get("MISSING_SIGNATURE")?.reasonLabel).toBe("Missing signature");
    expect(byCode.get("MISSING_SIGNATURE")?.detail).toContain("Stripe-Signature");
    expect(byCode.get("INVALID_SIGNATURE")?.reasonLabel).toBe("Invalid signature");
    expect(byCode.get("INVALID_SIGNATURE")?.detail).toContain("signing secret");
    expect(byCode.get("TIMESTAMP_OUT_OF_RANGE")?.reasonLabel).toBe("Stale timestamp");
    expect(byCode.get("TIMESTAMP_OUT_OF_RANGE")?.detail).toContain("freshness window");
    expect(byCode.get("INVALID_JSON")?.reasonLabel).toBe("Malformed JSON");
    expect(byCode.get("INVALID_JSON")?.detail).toContain("JSON");
    expect(byCode.get("WEBHOOK_MODE_MISMATCH")?.reasonLabel).toBe("Environment mismatch");

    // Reason filter matches canonical code cleanly.
    const invalidJsonFiltered = await adminCaller.payments.admin.listWebhookRejections({
      provider: "stripe",
      reasonCode: "INVALID_JSON",
      limit: 10,
    });
    expect(invalidJsonFiltered.items.length).toBeGreaterThanOrEqual(1);
    expect(invalidJsonFiltered.items.every((r) => r.reasonLabel === "Malformed JSON")).toBe(true);

    // 3. Defect 4: shared Stripe account session WITHOUT portal metadata is ignored quietly (attention stays 0).
    const sharedAccountBuf = Buffer.from(
      JSON.stringify({
        id: `evt_shared_acct_${ulid().slice(-8)}`,
        type: "checkout.session.completed",
        livemode: false,
        created: nowSec,
        data: {
          object: {
            id: "cs_test_other_system_01",
            payment_status: "paid",
            payment_intent: "pi_test_other_system_01",
            metadata: { external_service: "other-billing-app" },
          },
        },
      }),
      "utf8",
    );
    const baselineAttention = (await paymentsMod.admin.readiness(admin.principal)).verification
      .attentionRequiredWebhookCount;
    const sharedRes = await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: sharedAccountBuf,
      headers: { "stripe-signature": signStripeWebhook(sharedAccountBuf, stripeWh, nowSec) },
      notificationUrl,
    });
    expect(sharedRes).toMatchObject({
      httpStatus: 200,
      accepted: true,
      booked: false,
      reasonCode: "IGNORED",
    });
    expect(
      (await paymentsMod.admin.readiness(admin.principal)).verification.attentionRequiredWebhookCount,
    ).toBe(baselineAttention);
    expect(
      (await opsAlertsMod.list({ source: "payment" })).items.some(
        (a) => a.code === "UNMATCHED_PORTAL_PAYMENT",
      ),
    ).toBe(false);

    // Signed checkout.session.completed WITH portal metadata that does NOT match any portal attempt/invoice
    // raises an operational warning alert and increments attentionRequiredWebhookCount!
    const unmatchedOrderId = ulid();
    const unmatchedPortalBuf = Buffer.from(
      JSON.stringify({
        id: `evt_unmatched_portal_${ulid().slice(-8)}`,
        type: "checkout.session.completed",
        livemode: false,
        created: nowSec,
        data: {
          object: {
            id: "cs_test_unknown_portal_session_99",
            payment_status: "paid",
            payment_intent: "pi_test_unknown_portal_99",
            metadata: {
              attempt_public_id: ulid(),
              invoice_public_id: ulid(),
              order_public_id: unmatchedOrderId,
            },
          },
        },
      }),
      "utf8",
    );
    const unmatchedRes = await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: unmatchedPortalBuf,
      headers: { "stripe-signature": signStripeWebhook(unmatchedPortalBuf, stripeWh, nowSec) },
      notificationUrl,
    });
    expect(unmatchedRes).toMatchObject({
      httpStatus: 200,
      accepted: true,
      booked: false,
      reasonCode: "UNMATCHED_PORTAL_PAYMENT",
    });
    expect(
      (await paymentsMod.admin.readiness(admin.principal)).verification.attentionRequiredWebhookCount,
    ).toBe(baselineAttention + 1);
    const alertsAfterUnmatched = await opsAlertsMod.list({ source: "payment" });
    const unmatchedAlert = alertsAfterUnmatched.items.find(
      (a) => a.code === "UNMATCHED_PORTAL_PAYMENT",
    );
    expect(unmatchedAlert).toBeDefined();
    expect(unmatchedAlert?.severity).toBe("warning");
  });
});
