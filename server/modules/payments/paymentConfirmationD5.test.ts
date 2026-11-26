/**
 * Increment 08 — Package D5: Payment confirmation end-to-end & adversarial suite.
 *
 * Exercises real MySQL (including migration 0008), real `OrdersModule`, real `CartModule`,
 * real `ComplianceModule`, real `OpsAlertsModule`, and real `PaymentsModule` + `paymentsRouter`
 * against a protocol-level fake Stripe pinned fetch (`services.integrations.egress.fetchPinned`).
 *
 * Covers:
 *  - `paid` via customer `confirmCheckoutPayment` (`bookingSource = "provider_lookup"`, receipt, cooldown)
 *  - `unpaid-complete` (`status = "complete"`, `payment_status = "unpaid"`, async ACH/SEPA -> `state = "processing"`)
 *    and `no_payment_required` guard (rejected on positive-amount attempts; accepted only when `amountMinor === 0`)
 *  - Strict mismatch checks (`amount mismatch`, `currency mismatch`, `livemode mismatch` + missing `livemode`,
 *    `foreign session id` + missing `id`, `metadata mismatch` + contradictory `client_reference_id`)
 *  - Double booking: `webhook-then-lookup` and `lookup-then-webhook`
 *  - Concurrent `confirmCheckoutPayment` calls (`Promise.all` synchronized at pinned fetch barrier)
 *  - Cross-customer attempt isolation (`NOT_FOUND`, zero egress) and staff/admin `FORBIDDEN` (`CUSTOMER_ONLY`)
 *  - Reconciliation direct booking (`reconcilePendingAttempts` books instead of `awaiting_webhook`),
 *    missing-webhook ops alert (`STRIPE_WEBHOOK_DELIVERY_MISSING`) & `/admin/payments/setup` diagnostics,
 *    and admin `"Check with Stripe now"` (`payments.admin.checkWithStripeNow`, step-up + pre-upgrade repair)
 */
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal } from "../../core/types.js";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { createTestDeps } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { users } from "../identity/schema.js";
import * as orderTables from "../orders/schema.js";
import { createOrdersModule } from "../orders/index.js";
import { STANDARD_V3_DEFINITION, STANDARD_V3_WORKFLOW_KEY, STANDARD_V3_WORKFLOW_NAME } from "../orders/stageModel.js";
import { workflowDefinitionSchema } from "../orders/workflowTypes.js";
import { FakeEngagement, FakeFiles, fakeIdentity, insertUser } from "../orders/testSupport.js";
import * as complianceTables from "../compliance/schema.js";
import { createComplianceModule } from "../compliance/index.js";
import * as cartTables from "../cart/schema.js";
import { createCartModule } from "../cart/index.js";
import { cartRouter } from "../cart/router.js";
import * as opsAlertTables from "../opsAlerts/schema.js";
import { createOpsAlertsModule } from "../opsAlerts/index.js";
import type { EgressFetchOptions, EgressFetchResponse, EgressPurpose } from "../integrations/egress.js";
import {
  createPaymentsModule,
  paymentAttempts,
  paymentsRouter,
  paymentWebhookEvents,
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
  client_reference_id: string | null;
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

function signStripeWebhook(rawBody: Buffer, secret: string, timestampSec: number): string {
  const signedPayload = `${timestampSec}.${rawBody.toString("utf8")}`;
  const sig = createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
  return `t=${timestampSec},v1=${sig}`;
}

let d5StripeSeq = 9_000;

function createD5FakeStripe(opts: { nowSec: () => number }) {
  let stripeEgressEnabled = false;
  let stripeRuleVersion = 1;
  const sessions = new Map<string, FakeStripeSession>();
  const sessionByIdem = new Map<string, FakeStripeSession>();
  const requests: Array<{ method: string; path: string; search: string }> = [];
  let sessionGetTransform:
    | ((sessionId: string, basePayload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>)
    | null = null;

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
          publicId: "01JSTRIPED5EGRESSRULE00001",
          purpose: "stripe" as const,
          pattern: "api.stripe.com",
          enabled: stripeEgressEnabled,
          version: stripeRuleVersion,
        },
      ];
    },
    async fetchPinned(
      url: string | URL,
      purpose: EgressPurpose,
      init: EgressFetchOptions = {},
    ): Promise<EgressFetchResponse> {
      const parsed = typeof url === "string" ? new URL(url) : url;
      if (init.beforeSend) {
        await init.beforeSend();
      }
      if (parsed.hostname !== "api.stripe.com" || purpose !== "stripe") {
        throw new DomainError("FORBIDDEN", "EGRESS_HOST_NOT_ALLOWLISTED", "Host not allowlisted.");
      }
      if (!stripeEgressEnabled) {
        throw new DomainError("FORBIDDEN", "EGRESS_HOST_NOT_ALLOWLISTED", "Stripe egress preset is off.");
      }

      const method = (init.method ?? "GET").toUpperCase();
      requests.push({
        method,
        path: parsed.pathname,
        search: parsed.search,
      });

      const auth = init.headers?.Authorization ?? init.headers?.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
      const livemode = token.startsWith("sk_live_") || token.startsWith("rk_live_");
      const idemHeader =
        init.headers?.["Idempotency-Key"] ?? init.headers?.["idempotency-key"] ?? null;

      const decodeBody = () => {
        if (!init.body) return "";
        if (typeof init.body === "string") return init.body;
        if (Buffer.isBuffer(init.body)) return init.body.toString("utf8");
        if (init.body instanceof Uint8Array) return Buffer.from(init.body).toString("utf8");
        return "";
      };

      // GET /v1/checkout/sessions?limit=1
      if (method === "GET" && parsed.pathname === "/v1/checkout/sessions") {
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
        const form = new URLSearchParams(decodeBody());
        d5StripeSeq += 1;
        const sessionId = `cs_test_d5_${d5StripeSeq}`;
        const piId = `pi_test_d5_${d5StripeSeq}`;
        const chId = `ch_test_d5_${d5StripeSeq}`;
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
          client_reference_id: form.get("client_reference_id"),
          metadata,
          idempotencyKey: idemHeader,
          payment_intent: {
            id: piId,
            status: "requires_payment_method",
            amount_received: 0,
            amount_refunded: 0,
            created: now,
            latest_charge: { id: chId, balance_transaction: `txn_d5_${d5StripeSeq}` },
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

      // POST /v1/checkout/sessions/:id/expire
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

      // GET /v1/checkout/sessions/:id
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
        const cloned = JSON.parse(JSON.stringify(session)) as Record<string, unknown>;
        const out = sessionGetTransform ? await sessionGetTransform(sessionId, cloned) : cloned;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(out), "utf8"),
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
    requests,
    setSessionGetTransform(
      fn:
        | ((sessionId: string, basePayload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>)
        | null,
    ) {
      sessionGetTransform = fn;
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
  };
}

const d5Router = router({
  cart: cartRouter,
  payments: paymentsRouter,
});
const createCaller = createCallerFactory(d5Router);

describe("Increment 08 — Package D5 Payment confirmation (authoritative booking, strict checks, races & ops alerts)", () => {
  let tdb: TestDb;

  beforeAll(async () => {
    tdb = await createTestDb({ schema: fullSchema });
  });

  afterAll(async () => {
    await tdb?.cleanup();
  });

  let nextStackOffsetMs = 0;

  async function buildActivatedStack() {
    const h = createTestDeps({
      db: tdb.db,
      config: { canonicalOrigin: "https://portal.example.test" },
    });
    nextStackOffsetMs += 60 * 60 * 1_000;
    h.clock.advance(nextStackOffsetMs);
    const fakeStripe = createD5FakeStripe({
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
    const adminNoStepUp = await insertUser(h, tdb.db, { role: "admin", stepUp: false });
    const staff = await insertUser(h, tdb.db, { role: "staff", stepUp: true });
    const buyer = await insertUser(h, tdb.db, { role: "customer" });
    const otherBuyer = await insertUser(h, tdb.db, { role: "customer" });
    await tdb.db.update(users).set({ customerRef: `CUST-${ulid().slice(-6)}` }).where(eq(users.id, buyer.id));
    await tdb.db.update(users).set({ customerRef: `CUST-${ulid().slice(-6)}` }).where(eq(users.id, otherBuyer.id));

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
        productKey: `p1-std-d5-${suffix}`,
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

    const stripeSk = "sk_test_inc08_d5_secret_4242";
    const stripeWh = "whsec_test_inc08_d5_primary_9876";

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
    fakeStripe.egress.setStripePreset(true);
    await paymentsMod.admin.testConnection(admin.principal);
    await paymentsMod.admin.verifyCheckoutSession(admin.principal);
    await paymentsMod.admin.sendSelfTestWebhook(admin.principal);
    await paymentsMod.admin.updateSettings(admin.principal, {
      provider: "stripe",
      mode: "test",
      currency: "USD",
      successPath: "/checkout/return",
      cancelPath: "/checkout/cancel",
      webhookToleranceSeconds: 300,
      squareLocationId: null,
    });

    const callerFor = (session: SessionPrincipal | null) =>
      createCaller({
        services: h.services,
        session,
        request: newRequestContext("test"),
        transport: { issue() {}, clear() {} },
      });

    async function createCustomerCheckout(customer = buyer) {
      const cCaller = callerFor(customer.principal);
      const added = await cCaller.cart.addItems({
        items: [{ productPublicId: product.publicId, quantity: 1 }],
      });
      const submitted = await cCaller.cart.checkout({
        cartPublicId: added.cartPublicId!,
        expectedVersion: added.version,
        expectedTotalMinor: added.totals.totalMinor,
        projectName: `D5 Checkout ${ulid().slice(-6)}`,
        note: "D5 checkout verification",
        billing: {
          fullName: "D5 Customer LLC",
          email: customer.email,
          country: "US",
          addressLine1: "200 Broadway",
          city: "New York",
          postalCode: "10007",
        },
        policyAcceptances: [],
        idempotencyKey: `idem-d5-${ulid()}`,
      });
      if (submitted.mode !== "redirect") {
        throw new Error(`expected redirect checkout, got ${submitted.mode}`);
      }
      const [attemptRow] = await tdb.db
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.publicId, submitted.attemptPublicId))
        .limit(1);
      if (!attemptRow || !attemptRow.providerRef) {
        throw new Error("missing providerRef on created payment attempt");
      }
      return {
        attemptPublicId: submitted.attemptPublicId,
        invoicePublicId: submitted.invoicePublicId,
        orderPublicId: submitted.orderPublicId,
        cartPublicId: added.cartPublicId!,
        sessionId: attemptRow.providerRef,
        attemptRow,
      };
    }

    async function deliverSignedCompletedWebhook(sessionId: string, eventId = `evt_test_d5_${ulid().toLowerCase()}`) {
      const session = fakeStripe.sessions.get(sessionId);
      if (!session) throw new Error(`missing session ${sessionId}`);
      const nowSec = Math.floor(h.clock.now().getTime() / 1000);
      const payload = {
        id: eventId,
        object: "event",
        type: "checkout.session.completed",
        created: nowSec,
        livemode: session.livemode,
        data: {
          object: {
            id: session.id,
            object: "checkout.session",
            status: session.status,
            payment_status: session.payment_status,
            payment_intent: session.payment_intent.id,
            metadata: session.metadata,
          },
        },
      };
      const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
      const signature = signStripeWebhook(rawBody, stripeWh, nowSec);
      return paymentsMod.handleSignedWebhook({
        provider: "stripe",
        rawBody,
        headers: { "stripe-signature": signature },
        notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
      });
    }

    return {
      h,
      fakeStripe,
      ordersMod,
      complianceMod,
      opsAlertsMod,
      paymentsMod,
      admin,
      adminNoStepUp,
      staff,
      buyer,
      otherBuyer,
      stripeWh,
      callerFor,
      createCustomerCheckout,
      deliverSignedCompletedWebhook,
    };
  }

  it("books a paid session via customer confirmCheckoutPayment (bookingSource='provider_lookup') and enforces per-attempt cooldown", async () => {
    const stack = await buildActivatedStack();
    const { h, fakeStripe, buyer, callerFor, createCustomerCheckout } = stack;
    const buyerCaller = callerFor(buyer.principal);

    // 1. Open session -> state = "processing", records lastCustomerLookupAt, enforces 3s cooldown
    const openCheckout = await createCustomerCheckout();
    const getCountBefore = fakeStripe.requests.filter(
      (r) => r.method === "GET" && r.path === `/v1/checkout/sessions/${openCheckout.sessionId}`,
    ).length;

    const firstOpen = await buyerCaller.payments.confirmCheckoutPayment({
      attemptPublicId: openCheckout.attemptPublicId,
    });
    expect(firstOpen.state).toBe("processing");
    expect(firstOpen.bookedNow).toBe(false);
    expect(firstOpen.bookingSource).toBeNull();

    const getCountAfterFirst = fakeStripe.requests.filter(
      (r) => r.method === "GET" && r.path === `/v1/checkout/sessions/${openCheckout.sessionId}`,
    ).length;
    expect(getCountAfterFirst).toBe(getCountBefore + 1);

    // Immediate second call within 3s cooldown does NOT hit Stripe again
    h.clock.advance(500);
    const cooldownReply = await buyerCaller.payments.confirmCheckoutPayment({
      attemptPublicId: openCheckout.attemptPublicId,
    });
    expect(cooldownReply.state).toBe("processing");
    expect(cooldownReply.cooldownRemainingMs).toBeGreaterThan(0);
    const getCountDuringCooldown = fakeStripe.requests.filter(
      (r) => r.method === "GET" && r.path === `/v1/checkout/sessions/${openCheckout.sessionId}`,
    ).length;
    expect(getCountDuringCooldown).toBe(getCountAfterFirst);

    // 2. Customer completes payment on Stripe; advance clock past cooldown and confirm without any webhook
    fakeStripe.markSessionPaid(openCheckout.sessionId);
    h.clock.advance(3_500);

    const confirmed = await buyerCaller.payments.confirmCheckoutPayment({
      attemptPublicId: openCheckout.attemptPublicId,
    });
    expect(confirmed.state).toBe("paid");
    expect(confirmed.bookedNow).toBe(true);
    expect(confirmed.bookingSource).toBe("provider_lookup");
    expect(confirmed.invoiceStatus).toBe("paid");
    expect(confirmed.receiptPublicId).toBeTruthy();
    expect(confirmed.orderPublicId).toBe(openCheckout.orderPublicId);

    const [attemptAfter] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, openCheckout.attemptPublicId));
    expect(attemptAfter?.status).toBe("paid");
    expect(attemptAfter?.bookingSource).toBe("provider_lookup");
    expect(attemptAfter?.verifiedWebhookEventId).toBeNull();

    const [cartAfter] = await tdb.db
      .select()
      .from(cartTables.carts)
      .where(eq(cartTables.carts.publicId, openCheckout.cartPublicId));
    expect(cartAfter?.status).toBe("checked_out");

    // Subsequent confirm call is idempotent and performs zero extra Stripe GET calls
    const getCountAfterPaid = fakeStripe.requests.filter(
      (r) => r.method === "GET" && r.path === `/v1/checkout/sessions/${openCheckout.sessionId}`,
    ).length;
    const repeatConfirm = await buyerCaller.payments.confirmCheckoutPayment({
      attemptPublicId: openCheckout.attemptPublicId,
    });
    expect(repeatConfirm.state).toBe("paid");
    expect(repeatConfirm.bookedNow).toBe(false);
    expect(repeatConfirm.bookingSource).toBe("provider_lookup");
    expect(
      fakeStripe.requests.filter(
        (r) => r.method === "GET" && r.path === `/v1/checkout/sessions/${openCheckout.sessionId}`,
      ).length,
    ).toBe(getCountAfterPaid);
  });

  it("handles unpaid-complete async settlement (ACH/SEPA) without booking or failing, and rejects no_payment_required on positive amounts", async () => {
    const stack = await buildActivatedStack();
    const { h, fakeStripe, buyer, callerFor, createCustomerCheckout } = stack;
    const buyerCaller = callerFor(buyer.principal);

    const asyncCheckout = await createCustomerCheckout();
    fakeStripe.markSessionAsyncProcessing(asyncCheckout.sessionId);

    const asyncRes = await buyerCaller.payments.confirmCheckoutPayment({
      attemptPublicId: asyncCheckout.attemptPublicId,
    });
    expect(asyncRes.state).toBe("processing");
    expect(asyncRes.bookedNow).toBe(false);
    expect(asyncRes.attemptStatus).toBe("redirected");
    expect(asyncRes.invoiceStatus).toBe("issued");
    expect(asyncRes.receiptPublicId).toBeNull();

    const [attemptRow] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, asyncCheckout.attemptPublicId));
    expect(attemptRow?.status).toBe("redirected");
    expect(attemptRow?.reconciliationNote).toBe("awaiting_async_settlement");
    expect(attemptRow?.bookingSource).toBeNull();

    const [orderRow] = await tdb.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, asyncCheckout.orderPublicId));
    expect(orderRow?.paymentState).toBe("pending_async");

    // Positive-amount attempt where Stripe returns status='complete' + payment_status='no_payment_required'
    // (even if amount_total echoes 25_000) MUST be refused with UNEXPECTED_NO_PAYMENT_REQUIRED
    h.clock.advance(4_000);
    fakeStripe.setSessionGetTransform((sid, base) => {
      if (sid !== asyncCheckout.sessionId) return base;
      return {
        ...base,
        status: "complete",
        payment_status: "no_payment_required",
      };
    });

    const noPayRes = await buyerCaller.payments.confirmCheckoutPayment({
      attemptPublicId: asyncCheckout.attemptPublicId,
    });
    fakeStripe.setSessionGetTransform(null);
    expect(noPayRes.state).toBe("processing");
    expect(noPayRes.bookedNow).toBe(false);
    expect(noPayRes.invoiceStatus).toBe("issued");

    const mismatchAudit = h.audit.events.find(
      (e) =>
        e.eventName === "payments.verification.mismatch" &&
        e.resource?.publicId === asyncCheckout.attemptPublicId &&
        e.reasonCode === "UNEXPECTED_NO_PAYMENT_REQUIRED",
    );
    expect(mismatchAudit).toBeDefined();
  });

  it("refuses amount, currency, livemode, foreign/missing session id, metadata, and client_reference_id mismatches with audit + ops alert", async () => {
    const stack = await buildActivatedStack();
    const { h, fakeStripe, buyer, callerFor, createCustomerCheckout } = stack;
    const buyerCaller = callerFor(buyer.principal);

    const checkout = await createCustomerCheckout();
    fakeStripe.markSessionPaid(checkout.sessionId);

    const mismatchScenarios: Array<{
      label: string;
      expectedReason: string;
      mutate: (base: Record<string, unknown>) => Record<string, unknown>;
    }> = [
      {
        label: "amount mismatch",
        expectedReason: "AMOUNT_MISMATCH",
        mutate: (b) => ({ ...b, amount_total: Number(b.amount_total) - 100 }),
      },
      {
        label: "currency mismatch",
        expectedReason: "CURRENCY_MISMATCH",
        mutate: (b) => ({ ...b, currency: "eur" }),
      },
      {
        label: "livemode mismatch (true in test mode)",
        expectedReason: "MODE_MISMATCH",
        mutate: (b) => ({ ...b, livemode: true }),
      },
      {
        label: "missing boolean livemode",
        expectedReason: "MODE_MISMATCH",
        mutate: (b) => {
          const copy = { ...b };
          delete copy.livemode;
          return copy;
        },
      },
      {
        label: "foreign session id",
        expectedReason: "PROVIDER_REF_MISMATCH",
        mutate: (b) => ({ ...b, id: "cs_test_foreign_session_999999" }),
      },
      {
        label: "missing session id (never falls back to input providerRef)",
        expectedReason: "PROVIDER_REF_MISMATCH",
        mutate: (b) => {
          const copy = { ...b };
          delete copy.id;
          return copy;
        },
      },
      {
        label: "metadata mismatch on attempt_public_id",
        expectedReason: "ATTEMPT_METADATA_MISMATCH",
        mutate: (b) => ({
          ...b,
          client_reference_id: null,
          metadata: { ...(b.metadata as Record<string, string>), attempt_public_id: ulid() },
        }),
      },
      {
        label: "missing metadata.attempt_public_id even with matching client_reference_id (no fallback)",
        expectedReason: "ATTEMPT_METADATA_MISMATCH",
        mutate: (b) => {
          const meta = { ...(b.metadata as Record<string, string>) };
          delete meta.attempt_public_id;
          return {
            ...b,
            client_reference_id: checkout.attemptPublicId,
            metadata: meta,
          };
        },
      },
      {
        label: "metadata mismatch on invoice_public_id",
        expectedReason: "INVOICE_METADATA_MISMATCH",
        mutate: (b) => ({
          ...b,
          metadata: { ...(b.metadata as Record<string, string>), invoice_public_id: ulid() },
        }),
      },
      {
        label: "metadata mismatch on order_public_id",
        expectedReason: "ORDER_METADATA_MISMATCH",
        mutate: (b) => ({
          ...b,
          metadata: { ...(b.metadata as Record<string, string>), order_public_id: ulid() },
        }),
      },
      {
        label: "missing metadata.order_public_id on Stripe session",
        expectedReason: "ORDER_METADATA_MISMATCH",
        mutate: (b) => {
          const meta = { ...(b.metadata as Record<string, string>) };
          delete meta.order_public_id;
          return {
            ...b,
            metadata: meta,
          };
        },
      },
      {
        label: "contradictory client_reference_id",
        expectedReason: "CLIENT_REFERENCE_MISMATCH",
        mutate: (b) => ({ ...b, client_reference_id: ulid() }),
      },
    ];

    for (const scenario of mismatchScenarios) {
      h.clock.advance(4_000);
      const auditCountBefore = h.audit.events.length;
      fakeStripe.setSessionGetTransform((sid, base) =>
        sid === checkout.sessionId ? scenario.mutate(base) : base,
      );

      const res = await buyerCaller.payments.confirmCheckoutPayment({
        attemptPublicId: checkout.attemptPublicId,
      });
      expect(res.bookedNow, scenario.label).toBe(false);
      expect(res.state, scenario.label).not.toBe("paid");
      expect(res.invoiceStatus, scenario.label).toBe("issued");

      const newAudits = h.audit.events.slice(auditCountBefore);
      const mismatchAudit = newAudits.find((e) => e.eventName === "payments.verification.mismatch");
      expect(mismatchAudit, scenario.label).toBeDefined();
      expect(mismatchAudit?.reasonCode, scenario.label).toBe(scenario.expectedReason);
    }

    fakeStripe.setSessionGetTransform(null);

    const [invRow] = await tdb.db
      .select()
      .from(complianceTables.complianceInvoices)
      .where(eq(complianceTables.complianceInvoices.publicId, checkout.invoicePublicId));
    expect(invRow?.status).toBe("issued");
    const ledgerRows = await tdb.db
      .select()
      .from(complianceTables.complianceInvoicePayments)
      .where(eq(complianceTables.complianceInvoicePayments.invoiceId, invRow!.id));
    expect(ledgerRows).toHaveLength(0);

    const alertRows = await tdb.db
      .select()
      .from(opsAlertTables.operationalAlerts)
      .where(eq(opsAlertTables.operationalAlerts.source, "payment"));
    expect(alertRows.some((a) => a.title === "Payment verification mismatch held booking")).toBe(true);
  });

  it("prevents double booking in both webhook-then-lookup and lookup-then-webhook sequences", async () => {
    const stack = await buildActivatedStack();
    const {
      fakeStripe,
      paymentsMod,
      buyer,
      callerFor,
      createCustomerCheckout,
      deliverSignedCompletedWebhook,
    } = stack;
    const buyerCaller = callerFor(buyer.principal);

    // Sequence A: webhook first -> customer lookup & reconcile second
    const seqA = await createCustomerCheckout();
    fakeStripe.markSessionPaid(seqA.sessionId);

    const whA = await deliverSignedCompletedWebhook(seqA.sessionId, `evt_test_wh_first_${ulid().toLowerCase()}`);
    expect(whA.httpStatus).toBe(200);
    expect(whA.booked).toBe(true);

    const lookupAfterWh = await buyerCaller.payments.confirmCheckoutPayment({
      attemptPublicId: seqA.attemptPublicId,
    });
    expect(lookupAfterWh.state).toBe("paid");
    expect(lookupAfterWh.bookedNow).toBe(false);
    expect(lookupAfterWh.bookingSource).toBe("webhook");

    await paymentsMod.reconcilePendingAttempts();

    const [invA] = await tdb.db
      .select()
      .from(complianceTables.complianceInvoices)
      .where(eq(complianceTables.complianceInvoices.publicId, seqA.invoicePublicId));
    const paymentsA = await tdb.db
      .select()
      .from(complianceTables.complianceInvoicePayments)
      .where(eq(complianceTables.complianceInvoicePayments.invoiceId, invA!.id));
    expect(paymentsA).toHaveLength(1);

    const [attemptA] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, seqA.attemptPublicId));
    expect(attemptA?.bookingSource).toBe("webhook");
    expect(attemptA?.verifiedWebhookEventId).not.toBeNull();

    // Sequence B: customer lookup first -> late signed webhook second
    const seqB = await createCustomerCheckout();
    fakeStripe.markSessionPaid(seqB.sessionId);

    const lookupFirst = await buyerCaller.payments.confirmCheckoutPayment({
      attemptPublicId: seqB.attemptPublicId,
    });
    expect(lookupFirst.state).toBe("paid");
    expect(lookupFirst.bookedNow).toBe(true);
    expect(lookupFirst.bookingSource).toBe("provider_lookup");

    const lateEventId = `evt_test_wh_late_${ulid().toLowerCase()}`;
    const whB = await deliverSignedCompletedWebhook(seqB.sessionId, lateEventId);
    expect(whB.httpStatus).toBe(200);
    expect(whB.accepted).toBe(true);
    expect(whB.booked).toBe(true);
    expect(whB.reasonCode).toBe("ALREADY_PAID");

    const [invB] = await tdb.db
      .select()
      .from(complianceTables.complianceInvoices)
      .where(eq(complianceTables.complianceInvoices.publicId, seqB.invoicePublicId));
    const paymentsB = await tdb.db
      .select()
      .from(complianceTables.complianceInvoicePayments)
      .where(eq(complianceTables.complianceInvoicePayments.invoiceId, invB!.id));
    expect(paymentsB).toHaveLength(1);

    const [attemptB] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, seqB.attemptPublicId));
    expect(attemptB?.bookingSource).toBe("provider_lookup");
    expect(attemptB?.verifiedWebhookEventId).not.toBeNull();

    const [whRowB] = await tdb.db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.externalEventId, lateEventId));
    expect(whRowB?.status).toBe("processed");
    expect(whRowB?.reasonCode).toBe("ALREADY_PAID");
  });

  it("serializes concurrent confirmCheckoutPayment and provider-lookup calls under FOR UPDATE so ledger books once", async () => {
    const stack = await buildActivatedStack();
    const { fakeStripe, paymentsMod, admin, buyer, createCustomerCheckout } = stack;

    // 1. Two simultaneous customer confirmCheckoutPayment calls (one hits Stripe + books, sibling hits cooldown or sees paid)
    const customerRace = await createCustomerCheckout();
    fakeStripe.markSessionPaid(customerRace.sessionId);

    let customerRacePaidEvents = 0;
    stack.complianceMod.invoices.onInvoicePaid(async (ev) => {
      if (ev.invoicePublicId === customerRace.invoicePublicId) {
        customerRacePaidEvents += 1;
      }
    });

    const [c1, c2] = await Promise.all([
      paymentsMod.confirmCheckoutPayment(buyer.principal, {
        attemptPublicId: customerRace.attemptPublicId,
      }),
      paymentsMod.confirmCheckoutPayment(buyer.principal, {
        attemptPublicId: customerRace.attemptPublicId,
      }),
    ]);

    expect([c1.state, c2.state]).toContain("paid");
    expect([c1.bookedNow, c2.bookedNow].filter(Boolean)).toHaveLength(1);
    expect(customerRacePaidEvents).toBe(1);

    const [invCustomerRace] = await tdb.db
      .select()
      .from(complianceTables.complianceInvoices)
      .where(eq(complianceTables.complianceInvoices.publicId, customerRace.invoicePublicId));
    const customerRaceLedger = await tdb.db
      .select()
      .from(complianceTables.complianceInvoicePayments)
      .where(eq(complianceTables.complianceInvoicePayments.invoiceId, invCustomerRace!.id));
    expect(customerRaceLedger).toHaveLength(1);

    // 2. Two independent provider lookups synchronized at the Stripe GET boundary so BOTH enter
    // bookAuthoritativeAttemptPaymentInTx concurrently and contend directly on SELECT ... FOR UPDATE.
    const lockRace = await createCustomerCheckout();
    fakeStripe.markSessionPaid(lockRace.sessionId);

    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let arrived = 0;

    fakeStripe.setSessionGetTransform(async (sid, base) => {
      if (sid === lockRace.sessionId) {
        arrived += 1;
        if (arrived >= 2) {
          releaseBarrier();
        }
        await barrier;
      }
      return base;
    });

    let paidEventsCount = 0;
    stack.complianceMod.invoices.onInvoicePaid(async (ev) => {
      if (ev.invoicePublicId === lockRace.invoicePublicId) {
        paidEventsCount += 1;
      }
    });

    const [customerOut, adminOut] = await Promise.all([
      paymentsMod.confirmCheckoutPayment(buyer.principal, {
        attemptPublicId: lockRace.attemptPublicId,
      }),
      paymentsMod.admin.checkWithStripeNow(admin.principal, {
        attemptPublicId: lockRace.attemptPublicId,
      }),
    ]);
    fakeStripe.setSessionGetTransform(null);

    expect(customerOut.state).toBe("paid");
    expect(customerOut.receiptPublicId).toBeTruthy();
    expect(adminOut.invoiceStatus).toBe("paid");
    expect([customerOut.bookedNow, adminOut.booked].filter(Boolean)).toHaveLength(1);
    expect(paidEventsCount).toBe(1);

    const [inv] = await tdb.db
      .select()
      .from(complianceTables.complianceInvoices)
      .where(eq(complianceTables.complianceInvoices.publicId, lockRace.invoicePublicId));
    const ledgerRows = await tdb.db
      .select()
      .from(complianceTables.complianceInvoicePayments)
      .where(eq(complianceTables.complianceInvoicePayments.invoiceId, inv!.id));
    expect(ledgerRows).toHaveLength(1);
  });

  it("enforces ownership on confirmCheckoutPayment (NOT_FOUND with zero egress for another customer; FORBIDDEN for staff/admin)", async () => {
    const stack = await buildActivatedStack();
    const { fakeStripe, admin, staff, otherBuyer, callerFor, createCustomerCheckout } = stack;

    const aliceCheckout = await createCustomerCheckout();
    fakeStripe.markSessionPaid(aliceCheckout.sessionId);

    const reqCountBefore = fakeStripe.requests.length;

    // Another customer gets NOT_FOUND indistinguishable from an unknown ULID, with zero Stripe calls
    const bobCaller = callerFor(otherBuyer.principal);
    await expect(
      bobCaller.payments.confirmCheckoutPayment({ attemptPublicId: aliceCheckout.attemptPublicId }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await expect(
      bobCaller.payments.confirmCheckoutPayment({ attemptPublicId: ulid() }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    expect(fakeStripe.requests.length).toBe(reqCountBefore);

    // Staff and admin sessions are rejected with FORBIDDEN (CUSTOMER_ONLY)
    await expect(
      callerFor(staff.principal).payments.confirmCheckoutPayment({
        attemptPublicId: aliceCheckout.attemptPublicId,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    await expect(
      callerFor(admin.principal).payments.confirmCheckoutPayment({
        attemptPublicId: aliceCheckout.attemptPublicId,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(fakeStripe.requests.length).toBe(reqCountBefore);
  });

  it("reconcilePendingAttempts books directly, emits missing-webhook alert + setup diagnostics after grace window, and admin checkWithStripeNow repairs pre-upgrade attempts with step-up", async () => {
    const stack = await buildActivatedStack();
    const {
      h,
      fakeStripe,
      paymentsMod,
      admin,
      adminNoStepUp,
      staff,
      callerFor,
      createCustomerCheckout,
    } = stack;

    // Advance clock past earlier tests' shared-DB webhook timestamps before creating this unwebhooked checkout
    h.clock.advance(60 * 1_000);

    // 1. Reconciliation job books paid Stripe attempt directly (replaces Decision 12 awaiting_webhook)
    const reconCheckout = await createCustomerCheckout();
    fakeStripe.markSessionPaid(reconCheckout.sessionId);

    const reconPass1 = await paymentsMod.reconcilePendingAttempts();
    expect(reconPass1.booked).toBeGreaterThanOrEqual(1);

    const [reconAttemptAfter1] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, reconCheckout.attemptPublicId));
    expect(reconAttemptAfter1?.status).toBe("paid");
    expect(reconAttemptAfter1?.bookingSource).toBe("provider_lookup");
    expect(reconAttemptAfter1?.verifiedWebhookEventId).toBeNull();
    expect(reconAttemptAfter1?.missingWebhookAlertedAt).toBeNull();

    // Inject an invalid-signature webhook rejection so recentRejectionReasons is populated on setup diagnostics
    await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: Buffer.from(JSON.stringify({ id: "evt_bad_sig", type: "checkout.session.completed" }), "utf8"),
      headers: {
        "stripe-signature": `t=${Math.floor(h.clock.now().getTime() / 1000)},v1=${"ab".repeat(32)}`,
      },
      notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    });

    // Advance past the 10-minute missing-webhook grace window -> emits ops alert once & surfaces setup diagnostics
    h.clock.advance(11 * 60 * 1_000);
    await paymentsMod.reconcilePendingAttempts();

    const [reconAttemptAfterGrace] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, reconCheckout.attemptPublicId));
    expect(reconAttemptAfterGrace?.missingWebhookAlertedAt).not.toBeNull();

    const missingAlerts = await tdb.db
      .select()
      .from(opsAlertTables.operationalAlerts)
      .where(eq(opsAlertTables.operationalAlerts.code, "STRIPE_WEBHOOK_DELIVERY_MISSING"));
    expect(missingAlerts.length).toBeGreaterThanOrEqual(1);

    const settingsView = await callerFor(admin.principal).payments.admin.getSettings();
    expect(settingsView.stripe.webhookDelivery.missingWebhookDetected).toBe(true);
    expect(settingsView.stripe.webhookDelivery.unwebhookedLookupPaidCount).toBeGreaterThanOrEqual(1);
    expect(settingsView.stripe.webhookDelivery.endpointUrl).toBe(
      "https://portal.example.test/api/payments/webhooks/stripe",
    );
    expect(settingsView.stripe.webhookDelivery.requiredEvents).toHaveLength(9);
    expect(settingsView.stripe.webhookDelivery.usualCauses).toHaveLength(3);
    expect(settingsView.stripe.webhookDelivery.usualCauses[0]).toMatch(/endpoint/i);
    expect(settingsView.stripe.webhookDelivery.usualCauses[1]).toMatch(/required events|subscribed/i);
    expect(settingsView.stripe.webhookDelivery.usualCauses[2]).toMatch(/signing secret|self-test/i);
    expect(settingsView.stripe.webhookDelivery.recentRejectionCount).toBeGreaterThanOrEqual(1);
    expect(
      settingsView.stripe.webhookDelivery.recentRejectionReasons.some(
        (r) => r.reasonCode === "STRIPE_SIGNATURE_INVALID" || r.reasonCode === "INVALID_SIGNATURE",
      ),
    ).toBe(true);

    // 2. Admin "Check with Stripe now" enforces step-up + admin capability and repairs pre-upgrade attempts
    const legacyCheckout = await createCustomerCheckout();
    fakeStripe.markSessionPaid(legacyCheckout.sessionId);

    // Simulate a pre-upgrade attempt that aged into "expired" while the customer had actually paid on Stripe
    await tdb.db
      .update(paymentAttempts)
      .set({
        status: "expired",
        reconciliationNote: "awaiting_webhook",
      })
      .where(eq(paymentAttempts.publicId, legacyCheckout.attemptPublicId));

    await expect(
      callerFor(staff.principal).payments.admin.checkWithStripeNow({
        invoicePublicId: legacyCheckout.invoicePublicId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      callerFor(adminNoStepUp.principal).payments.admin.checkWithStripeNow({
        invoicePublicId: legacyCheckout.invoicePublicId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const freshStepUpAdmin = {
      ...admin.principal,
      stepUpAt: h.clock.now(),
    };
    const repaired = await callerFor(freshStepUpAdmin).payments.admin.checkWithStripeNow({
      invoicePublicId: legacyCheckout.invoicePublicId,
    });
    expect(repaired.booked).toBe(true);
    expect(repaired.alreadyPaid).toBe(false);
    expect(repaired.invoiceStatus).toBe("paid");
    expect(repaired.bookingSource).toBe("provider_lookup");
    expect(repaired.receiptPublicId).toBeTruthy();

    const [repairedAttempt] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, legacyCheckout.attemptPublicId));
    expect(repairedAttempt?.status).toBe("paid");
    expect(repairedAttempt?.bookingSource).toBe("provider_lookup");
  });

  it("repairs an exact 07.2-shaped Stripe Checkout Session via step-up admin checkWithStripeNow", async () => {
    const stack = await buildActivatedStack();
    const { h, fakeStripe, admin, callerFor, createCustomerCheckout } = stack;

    const session072 = await createCustomerCheckout();
    fakeStripe.markSessionPaid(session072.sessionId);

    // 07.2 (`2c3367f:server/modules/payments/providers/stripe.ts:251-256`) wrote:
    // - `client_reference_id = attemptPublicId`
    // - `metadata = { attempt_public_id, invoice_public_id, order_public_id }`
    // - `payment_intent.metadata = { attempt_public_id, invoice_public_id }` (no `order_public_id` on PI)
    fakeStripe.setSessionGetTransform((sid, base) => {
      if (sid !== session072.sessionId) return base;
      const pi = { ...(base.payment_intent as Record<string, unknown>) };
      pi.metadata = {
        attempt_public_id: session072.attemptPublicId,
        invoice_public_id: session072.invoicePublicId,
      };
      return {
        ...base,
        client_reference_id: session072.attemptPublicId,
        metadata: {
          attempt_public_id: session072.attemptPublicId,
          invoice_public_id: session072.invoicePublicId,
          order_public_id: session072.orderPublicId,
        },
        payment_intent: pi,
      };
    });

    await tdb.db
      .update(paymentAttempts)
      .set({
        status: "expired",
        reconciliationNote: "awaiting_webhook",
      })
      .where(eq(paymentAttempts.publicId, session072.attemptPublicId));

    const freshStepUpAdmin: SessionPrincipal = {
      ...admin.principal,
      stepUpAt: h.clock.now(),
    };
    const repaired = await callerFor(freshStepUpAdmin).payments.admin.checkWithStripeNow({
      invoicePublicId: session072.invoicePublicId,
    });
    fakeStripe.setSessionGetTransform(null);

    expect(repaired.booked).toBe(true);
    expect(repaired.alreadyPaid).toBe(false);
    expect(repaired.invoiceStatus).toBe("paid");
    expect(repaired.attemptStatus).toBe("paid");
    expect(repaired.bookingSource).toBe("provider_lookup");
    expect(repaired.receiptPublicId).toBeTruthy();
  });

  it("holds customer confirmation without mutating cancelled attempts paid on Stripe, emits PAID_ON_CANCELLED_ATTEMPT ops alert, repairs via step-up admin check, and blocks delayed mutations on terminal attempts/void invoices", async () => {
    const stack = await buildActivatedStack();
    const {
      h,
      fakeStripe,
      complianceMod,
      paymentsMod,
      admin,
      buyer,
      stripeWh,
      callerFor,
      createCustomerCheckout,
    } = stack;
    const buyerCaller = callerFor(buyer.principal);

    // 1. Cancelled attempt whose Stripe session was genuinely paid in another tab:
    //    - Customer confirmCheckoutPayment performs ZERO DB mutation on payment_attempts / compliance_invoices / orders
    //    - Surfaces `PAID_ON_CANCELLED_ATTEMPT` ops alert + security audit event
    //    - Step-up `admin.checkWithStripeNow` repairs & books it and resolves the alert
    const paidAfterCancel = await createCustomerCheckout();
    await paymentsMod.cancelAttemptIfUnpaid(buyer.principal, {
      attemptPublicId: paidAfterCancel.attemptPublicId,
    });
    fakeStripe.markSessionPaid(paidAfterCancel.sessionId);

    const [attemptBeforeCustomerCheck] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, paidAfterCancel.attemptPublicId));
    expect(attemptBeforeCustomerCheck?.status).toBe("cancelled");

    const [invBeforeCustomerCheck] = await tdb.db
      .select()
      .from(complianceTables.complianceInvoices)
      .where(eq(complianceTables.complianceInvoices.publicId, paidAfterCancel.invoicePublicId));
    const [orderBeforeCustomerCheck] = await tdb.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, paidAfterCancel.orderPublicId));

    h.clock.advance(5_000);
    const heldConfirm = await buyerCaller.payments.confirmCheckoutPayment({
      attemptPublicId: paidAfterCancel.attemptPublicId,
    });
    expect(heldConfirm.bookedNow).toBe(false);
    expect(heldConfirm.state).toBe("unpaid");
    expect(heldConfirm.attemptStatus).toBe("cancelled");
    expect(heldConfirm.invoiceStatus).toBe("issued");

    const [attemptAfterCustomerCheck] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, paidAfterCancel.attemptPublicId));
    const [invAfterCustomerCheck] = await tdb.db
      .select()
      .from(complianceTables.complianceInvoices)
      .where(eq(complianceTables.complianceInvoices.publicId, paidAfterCancel.invoicePublicId));
    const [orderAfterCustomerCheck] = await tdb.db
      .select()
      .from(orderTables.orders)
      .where(eq(orderTables.orders.publicId, paidAfterCancel.orderPublicId));

    // Strict zero-mutation proof across payment_attempts, compliance_invoices, and orders
    expect(attemptAfterCustomerCheck).toEqual(attemptBeforeCustomerCheck);
    expect(invAfterCustomerCheck).toEqual(invBeforeCustomerCheck);
    expect(orderAfterCustomerCheck).toEqual(orderBeforeCustomerCheck);

    const [cancelledPaidAlert] = await tdb.db
      .select()
      .from(opsAlertTables.operationalAlerts)
      .where(
        and(
          eq(opsAlertTables.operationalAlerts.code, "PAID_ON_CANCELLED_ATTEMPT"),
          eq(opsAlertTables.operationalAlerts.orderPublicId, paidAfterCancel.orderPublicId),
        ),
      );
    expect(cancelledPaidAlert?.state).toBe("open");
    expect(cancelledPaidAlert?.code).toBe("PAID_ON_CANCELLED_ATTEMPT");
    expect(
      h.audit.events.some(
        (e) =>
          e.eventName === "payments.attempt.paid_after_cancel_held" &&
          e.resource?.publicId === paidAfterCancel.attemptPublicId,
      ),
    ).toBe(true);

    // Admin repairs it via step-up Check with Stripe now -> books cleanly and resolves alert
    const freshStepUpAdmin: SessionPrincipal = {
      ...admin.principal,
      stepUpAt: h.clock.now(),
    };
    const adminRepair = await callerFor(freshStepUpAdmin).payments.admin.checkWithStripeNow({
      invoicePublicId: paidAfterCancel.invoicePublicId,
    });
    expect(adminRepair.booked).toBe(true);
    expect(adminRepair.invoiceStatus).toBe("paid");
    expect(adminRepair.attemptStatus).toBe("paid");
    expect(adminRepair.receiptPublicId).toBeTruthy();

    const [resolvedCancelledAlert] = await tdb.db
      .select()
      .from(opsAlertTables.operationalAlerts)
      .where(
        and(
          eq(opsAlertTables.operationalAlerts.code, "PAID_ON_CANCELLED_ATTEMPT"),
          eq(opsAlertTables.operationalAlerts.orderPublicId, paidAfterCancel.orderPublicId),
        ),
      );
    expect(resolvedCancelledAlert?.state).toBe("resolved");

    // 2. Delayed asyncPending / expired outcomes on customer, webhook, and worker paths NEVER mutate a cancelled attempt
    const delayedAsyncOnCancelled = await createCustomerCheckout();
    await paymentsMod.cancelAttemptIfUnpaid(buyer.principal, {
      attemptPublicId: delayedAsyncOnCancelled.attemptPublicId,
    });
    fakeStripe.markSessionAsyncProcessing(delayedAsyncOnCancelled.sessionId);

    const [cancelledSnapBefore] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, delayedAsyncOnCancelled.attemptPublicId));

    h.clock.advance(5_000);
    const asyncCustomerRes = await buyerCaller.payments.confirmCheckoutPayment({
      attemptPublicId: delayedAsyncOnCancelled.attemptPublicId,
    });
    expect(asyncCustomerRes.state).toBe("unpaid");
    expect(asyncCustomerRes.attemptStatus).toBe("cancelled");

    // Signed expired webhook on an already-cancelled attempt must NOT overwrite `cancelled` to `expired`
    const s = fakeStripe.sessions.get(delayedAsyncOnCancelled.sessionId)!;
    s.status = "expired";
    const nowSec = Math.floor(h.clock.now().getTime() / 1000);
    const expWebhookBody = Buffer.from(
      JSON.stringify({
        id: `evt_exp_after_cancel_${ulid().toLowerCase()}`,
        object: "event",
        type: "checkout.session.expired",
        created: nowSec,
        livemode: false,
        data: {
          object: {
            id: s.id,
            object: "checkout.session",
            status: "expired",
            payment_status: "unpaid",
            metadata: s.metadata,
          },
        },
      }),
      "utf8",
    );
    const expWhOut = await paymentsMod.handleSignedWebhook({
      provider: "stripe",
      rawBody: expWebhookBody,
      headers: { "stripe-signature": signStripeWebhook(expWebhookBody, stripeWh, nowSec) },
      notificationUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    });
    expect(expWhOut.booked).toBe(false);
    expect(expWhOut.reasonCode).toBe("ATTEMPT_NOT_ACTIVE");

    await paymentsMod.reconcilePendingAttempts();

    const [cancelledSnapAfter] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, delayedAsyncOnCancelled.attemptPublicId));
    expect(cancelledSnapAfter?.status).toBe("cancelled");
    expect(cancelledSnapAfter?.reconciliationNote).toBeNull();
    expect(cancelledSnapAfter?.version).toBe(cancelledSnapBefore?.version);

    // 3. Voided invoice is treated as terminal on customer confirmCheckoutPayment before mismatch/async/status
    const voidCheckout = await createCustomerCheckout();
    fakeStripe.markSessionAsyncProcessing(voidCheckout.sessionId);
    await complianceMod.invoices.admin.void(freshStepUpAdmin, {
      invoicePublicId: voidCheckout.invoicePublicId,
      reason: "Order cancelled before payment settlement",
    });

    h.clock.advance(5_000);
    const voidConfirm = await buyerCaller.payments.confirmCheckoutPayment({
      attemptPublicId: voidCheckout.attemptPublicId,
    });
    expect(voidConfirm.bookedNow).toBe(false);
    expect(voidConfirm.invoiceStatus).toBe("void");
    expect(voidConfirm.state).toBe("unpaid");
  });

  it("does not suppress missing-webhook alert when an unrelated Stripe webhook is processed later in the same mode", async () => {
    const stack = await buildActivatedStack();
    const {
      h,
      fakeStripe,
      paymentsMod,
      admin,
      buyer,
      callerFor,
      createCustomerCheckout,
      deliverSignedCompletedWebhook,
    } = stack;
    const buyerCaller = callerFor(buyer.principal);

    // Attempt 1 is booked via customer provider_lookup with NO webhook ever arriving for Attempt 1
    const unmatchedLookup = await createCustomerCheckout();
    fakeStripe.markSessionPaid(unmatchedLookup.sessionId);
    const bookedLookup = await buyerCaller.payments.confirmCheckoutPayment({
      attemptPublicId: unmatchedLookup.attemptPublicId,
    });
    expect(bookedLookup.bookedNow).toBe(true);
    expect(bookedLookup.bookingSource).toBe("provider_lookup");

    // Clear any prior test's deduped alert row in the shared test DB so we observe a fresh emission
    await tdb.db
      .delete(opsAlertTables.operationalAlerts)
      .where(eq(opsAlertTables.operationalAlerts.code, "STRIPE_WEBHOOK_DELIVERY_MISSING"));

    // 2 minutes later, a DIFFERENT Attempt 2 receives a genuine signed Stripe webhook in the same mode
    h.clock.advance(2 * 60 * 1_000);
    const unrelatedWebhookCheckout = await createCustomerCheckout();
    fakeStripe.markSessionPaid(unrelatedWebhookCheckout.sessionId);
    const whRes = await deliverSignedCompletedWebhook(
      unrelatedWebhookCheckout.sessionId,
      `evt_unrelated_${ulid().toLowerCase()}`,
    );
    expect(whRes.booked).toBe(true);

    // Advance past Attempt 1's 10-minute grace window: Attempt 1 is STILL unmatched (`verifiedWebhookEventId IS NULL`)
    // and MUST raise `STRIPE_WEBHOOK_DELIVERY_MISSING` despite Attempt 2's later webhook!
    h.clock.advance(9 * 60 * 1_000);
    await paymentsMod.reconcilePendingAttempts();

    const [unmatchedAfter] = await tdb.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, unmatchedLookup.attemptPublicId));
    expect(unmatchedAfter?.verifiedWebhookEventId).toBeNull();
    expect(unmatchedAfter?.missingWebhookAlertedAt).not.toBeNull();

    const [openMissingAlert] = await tdb.db
      .select()
      .from(opsAlertTables.operationalAlerts)
      .where(
        and(
          eq(opsAlertTables.operationalAlerts.code, "STRIPE_WEBHOOK_DELIVERY_MISSING"),
          eq(opsAlertTables.operationalAlerts.state, "open"),
        ),
      );
    expect(openMissingAlert?.state).toBe("open");

    const settings = await callerFor(admin.principal).payments.admin.getSettings();
    expect(settings.stripe.webhookDelivery.missingWebhookDetected).toBe(true);
    expect(settings.stripe.webhookDelivery.unwebhookedLookupPaidCount).toBeGreaterThanOrEqual(1);
  });
});
