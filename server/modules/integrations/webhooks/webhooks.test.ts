/**
 * Package I — Outbound Webhook Subscriptions, Signed Inbound Endpoints, Delivery Log,
 * Redeliver / Reprocess, Public API v1 Provider, and Stripe/Square Egress Presets.
 *
 * Includes defensive regression for I-01 (unsigned header substitution cannot override
 * HMAC-authenticated body `id` / `type` for deduplication or automation trigger routing).
 */
import type { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newRequestContext } from "../../../core/requestContext.js";
import type {
  Db,
  SessionPrincipal,
  Tx,
} from "../../../core/types.js";
import type { AuditTap, AuditTapEvent } from "../../audit/tap.js";
import type {
  ApiCaller,
  ApiListQuery,
  ApiPage,
  WebhookSubscriptionDto,
} from "../../publicApi/ports.js";
import { createSettingsStore } from "../../platform/settingsStore.js";
import {
  createTestDeps,
  fakePrincipal,
  type TestHarness,
} from "../../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../../tests/helpers/testDb.js";
import {
  createInboundWebhooksHttpRouter,
  createIntegrationsModule,
  WEBHOOK_DELIVER_JOB,
  WEBHOOK_PURGE_JOB,
  type EgressFetchResponse,
  type IntegrationsModule,
  type PinnedEgressTarget,
} from "../index.js";
import { signWebhookPayload } from "./crypto.js";
import { integrationsRouter } from "../router.js";
import {
  integrationWebhookDeliveries,
  integrationWebhookSubscriptions,
} from "../schema.js";

interface RegisteredWebhookProvider {
  list(query: ApiListQuery, caller: ApiCaller): Promise<ApiPage<WebhookSubscriptionDto>>;
  get(publicId: string, caller: ApiCaller): Promise<WebhookSubscriptionDto | null>;
}

const PARTNER_HOST = "hooks.partner.example.test";
const PARTNER_URL = `https://${PARTNER_HOST}/v1/events/secret-token-path-9999?api_key=leak`;

function makeStepUpAdmin(
  h: TestHarness,
  overrides: Partial<SessionPrincipal> = {},
): SessionPrincipal {
  const now = h.clock.now();
  return fakePrincipal({
    userId: 1,
    userPublicId: "01JWHKADMIN000000000000001",
    role: "admin",
    state: "full",
    pendingSteps: [],
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: now,
    ...overrides,
  });
}

function makeAdminWithoutStepUp(h: TestHarness): SessionPrincipal {
  const now = h.clock.now();
  return fakePrincipal({
    userId: 1,
    userPublicId: "01JWHKADMIN000000000000001",
    role: "admin",
    state: "full",
    pendingSteps: [],
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: null,
  });
}

function makeStaff(h: TestHarness): SessionPrincipal {
  const now = h.clock.now();
  return fakePrincipal({
    userId: 2,
    userPublicId: "01JWHKSTAFF000000000000002",
    role: "staff",
    state: "full",
    pendingSteps: [],
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: now,
  });
}

function makeCustomer(h: TestHarness): SessionPrincipal {
  const now = h.clock.now();
  return fakePrincipal({
    userId: 10,
    userPublicId: "01JWHKCUST0000000000000010",
    role: "customer",
    state: "full",
    pendingSteps: [],
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: null,
  });
}

async function postRawHttp(
  baseUrl: string,
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
  },
): Promise<{ status: number; headers: Headers; json: Record<string, unknown> }> {
  const method = opts.method ?? "POST";
  const bodyInit =
    opts.body === undefined
      ? undefined
      : typeof opts.body === "string"
        ? opts.body
        : new Uint8Array(opts.body);
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: opts.headers,
    body: method === "GET" ? undefined : bodyInit,
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, headers: res.headers, json };
}

describe("Package I — integrations.webhooks (outbound, inbound HTTP, I-01, replay, purge, API v1 & presets)", () => {
  let tdb: TestDb;
  let h: TestHarness;
  let mod: IntegrationsModule;
  let httpServer: Server;
  let inboundBaseUrl: string;

  let registeredTaps: AuditTap[] = [];
  let registeredApiProvider: RegisteredWebhookProvider | null = null;
  let revokeSessionInTx = false;

  let dnsAnswers: Record<string, Array<{ address: string; family: 4 | 6 }>> = {};
  let httpCalls: Array<{
    pinned: PinnedEgressTarget;
    url: string;
    method: string;
    headers: Record<string, string> | undefined;
    body: string;
  }> = [];
  let nextHttpHandler: (call: {
    pinned: PinnedEgressTarget;
    url: URL;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }) => Promise<EgressFetchResponse>;

  beforeAll(async () => {
    tdb = await createTestDb();
  });

  afterAll(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    await tdb.cleanup();
  });

  function wireServices(targetHarness: TestHarness, dbHandle: Db) {
    targetHarness.deps.db = dbHandle;
    targetHarness.deps.settings = createSettingsStore({
      db: dbHandle,
      crypto: targetHarness.deps.crypto,
      clock: targetHarness.clock,
      audit: targetHarness.audit,
      logger: targetHarness.deps.logger,
    });

    targetHarness.services.identity = {
      sessions: {
        assertCurrent: vi.fn(async (principal: SessionPrincipal, _tx: Tx) => {
          if (revokeSessionInTx) {
            throw new Error("SESSION_REVOKED_IN_TX");
          }
          return {
            pendingSteps: principal.pendingSteps,
            role: principal.role,
            stepUpAt: principal.stepUpAt,
            mfaVerifiedAt: principal.mfaVerifiedAt,
          };
        }),
      },
      getUser: vi.fn(async () => null),
    } as never;

    targetHarness.services.auditCenter = {
      registerTap(tap: AuditTap) {
        registeredTaps.push(tap);
      },
    } as never;

    targetHarness.services.publicApi = {
      registerProvider(
        name: string,
        provider: RegisteredWebhookProvider,
      ) {
        if (name === "webhookSubscriptions") {
          registeredApiProvider = provider;
        }
      },
    } as never;
  }

  beforeEach(async () => {
    const conn = await tdb.pool.getConnection();
    try {
      await conn.query("DELETE FROM integration_webhook_delivery_attempts");
      await conn.query("DELETE FROM integration_webhook_deliveries");
      await conn.query("DELETE FROM integration_webhook_inbound_endpoints");
      await conn.query("DELETE FROM integration_webhook_subscriptions");
      await conn.query("DELETE FROM integration_egress_allowlist");
      await conn.query("DELETE FROM integration_provider_checks");
      await conn.query("DELETE FROM platform_settings");
    } finally {
      conn.release();
    }

    registeredTaps = [];
    registeredApiProvider = null;
    revokeSessionInTx = false;
    dnsAnswers = {
      [PARTNER_HOST]: [{ address: "93.184.216.34", family: 4 }],
      "unlisted.example.test": [{ address: "93.184.216.34", family: 4 }],
    };
    httpCalls = [];
    nextHttpHandler = async () => ({
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "partner_sess=super-secret-cookie",
      },
      body: Buffer.from('{"received":true,"apiKey":"resp-secret-value"}', "utf8"),
    });

    h = createTestDeps();
    wireServices(h, tdb.db);

    mod = createIntegrationsModule(h.deps, {
      egress: {
        dnsLookup: async (hostname) => dnsAnswers[hostname] ?? [],
        httpsRequester: async (pinned, url, options) => {
          const nonStreamBody =
            typeof options.body === "string" || options.body instanceof Uint8Array
              ? options.body
              : undefined;
          const bodyStr =
            typeof nonStreamBody === "string"
              ? nonStreamBody
              : nonStreamBody
                ? Buffer.from(nonStreamBody).toString("utf8")
                : "";
          httpCalls.push({
            pinned,
            url: url.toString(),
            method: options.method,
            headers: options.headers,
            body: bodyStr,
          });
          return nextHttpHandler({
            pinned,
            url,
            headers: options.headers,
            body: nonStreamBody,
          });
        },
      },
    });
    h.services.integrations = mod;
    mod.init();

    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    const app = express();
    app.use(
      "/api/webhooks/inbound",
      express.raw({ type: "application/json", limit: "320kb" }),
      createInboundWebhooksHttpRouter(h.services),
    );
    httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (httpServer.address() as AddressInfo).port;
    inboundBaseUrl = `http://127.0.0.1:${port}`;
  });

  function createCaller(session: SessionPrincipal | null) {
    return integrationsRouter.createCaller({
      services: h.services,
      session,
      request: newRequestContext("test"),
      transport: { issue() {}, clear() {} },
    });
  }

  async function allowWebhookHost(admin: SessionPrincipal, hostPattern = PARTNER_HOST) {
    await mod.egress.createAllowlistRule(admin, {
      purpose: "webhook",
      matchType: "host",
      pattern: hostPattern,
      port: 443,
      protocol: "https:",
      allowPrivateAddress: false,
      enabled: true,
      justification: "Test webhook partner host",
    });
  }

  it("ships disabled by default, blocks execution across outbound/inbound/worker boundaries when disabled, and audits enablement", async () => {
    const admin = makeStepUpAdmin(h);
    const caller = createCaller(admin);

    const initial = await caller.admin.webhooks.settings.get();
    expect(initial).toEqual({
      enabled: false,
      retentionDays: 30,
      autoDisableThreshold: 10,
      deliveryTimeoutMs: 10000,
    });

    const healthList = await mod.health();
    const whHealth = healthList.find((item) => item.component === "integrations.webhooks");
    expect(whHealth?.state).toBe("disabled");

    await allowWebhookHost(admin);
    const created = await caller.admin.webhooks.subscriptions.create({
      name: "Partner ERP",
      targetUrl: PARTNER_URL,
      events: ["order.created"],
    });

    // While disabled: testDelivery refuses, publish enqueues nothing, inbound HTTP returns 503
    await expect(
      caller.admin.webhooks.subscriptions.testDelivery({
        publicId: created.subscription.publicId,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" } satisfies Partial<TRPCError>);

    const pub = await mod.webhooks.publish(
      "order.created",
      { orderPublicId: "01JORD1" },
      { deduplicationKey: "disabled-pub-1" },
    );
    expect(pub.queued).toBe(0);
    expect(h.jobs.enqueued).toHaveLength(0);

    const ep = await caller.admin.webhooks.inbound.create({
      name: "Inbound Partner",
      endpointKey: "partner-disabled",
      enabled: true,
      toleranceSeconds: 300,
    });
    const bodyBuf = Buffer.from(JSON.stringify({ id: "evt_1", type: "partner.ping" }), "utf8");
    const nowSec = Math.floor(h.clock.now().getTime() / 1000);
    const sig = signWebhookPayload(bodyBuf, nowSec, ep.signingSecretOnce);
    const inboundDisabled = await postRawHttp(
      inboundBaseUrl,
      `/api/webhooks/inbound/${ep.endpoint.publicId}`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-ReadyPackets-Signature": sig,
        },
        body: bodyBuf,
      },
    );
    expect(inboundDisabled.status).toBe(503);
    expect(inboundDisabled.json.code).toBe("WEBHOOKS_DISABLED");

    // Enabling requires step-up and records durable audit event
    const updated = await caller.admin.webhooks.settings.update({
      enabled: true,
      retentionDays: 14,
      autoDisableThreshold: 5,
    });
    expect(updated.enabled).toBe(true);
    expect(updated.autoDisableThreshold).toBe(5);
    expect(
      h.audit.events.some((e) => e.eventName === "integration.webhooks.settings_updated"),
    ).toBe(true);
  });

  it("enforces anonymous/customer/staff denial, step-up MFA on mutations & replay, and fail-closed in-tx session check", async () => {
    const anonCaller = createCaller(null);
    const custCaller = createCaller(makeCustomer(h));
    const staffCaller = createCaller(makeStaff(h));
    const noStepUpAdminCaller = createCaller(makeAdminWithoutStepUp(h));
    const stepUpAdmin = makeStepUpAdmin(h);
    const adminCaller = createCaller(stepUpAdmin);

    await expect(anonCaller.admin.webhooks.settings.get()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(custCaller.admin.webhooks.settings.get()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(staffCaller.admin.webhooks.settings.get()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(staffCaller.admin.webhooks.deliveries.list({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // Admin without step-up can read, but cannot mutate settings, subscriptions, secrets, or replay
    const readOk = await noStepUpAdminCaller.admin.webhooks.settings.get();
    expect(readOk.enabled).toBe(false);
    await expect(
      noStepUpAdminCaller.admin.webhooks.settings.update({ enabled: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await allowWebhookHost(stepUpAdmin);
    await expect(
      noStepUpAdminCaller.admin.webhooks.subscriptions.create({
        name: "Blocked Sub",
        targetUrl: PARTNER_URL,
        events: ["order.created"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // In-transaction session revocation rolls back subscription creation
    revokeSessionInTx = true;
    await expect(
      adminCaller.admin.webhooks.subscriptions.create({
        name: "Revoked Sub",
        targetUrl: PARTNER_URL,
        events: ["order.created"],
      }),
    ).rejects.toThrow("SESSION_REVOKED_IN_TX");
    revokeSessionInTx = false;

    const subs = await adminCaller.admin.webhooks.subscriptions.list({});
    expect(subs.items).toHaveLength(0);
  });

  it("enforces HTTPS:443 URL rules, webhook egress allowlist, public-only DNS (blocking loopback/RFC1918/IMDS), and 3xx redirect refusal", async () => {
    const admin = makeStepUpAdmin(h);
    const caller = createCaller(admin);
    await caller.admin.webhooks.settings.update({ enabled: true });

    // Reject HTTP, custom port, credentials, fragment
    for (const badUrl of [
      `http://${PARTNER_HOST}/hook`,
      `https://${PARTNER_HOST}:8443/hook`,
      `https://user:pass@${PARTNER_HOST}/hook`,
      `https://${PARTNER_HOST}/hook#frag`,
    ]) {
      await expect(
        caller.admin.webhooks.subscriptions.create({
          name: "Bad URL",
          targetUrl: badUrl,
          events: ["order.created"],
        }),
      ).rejects.toThrow();
    }

    // Reject host missing from `webhook` egress allowlist
    await expect(
      caller.admin.webhooks.subscriptions.create({
        name: "Unallowlisted Host",
        targetUrl: "https://unlisted.example.test/hook",
        events: ["order.created"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Allowlist host, then verify private/loopback/link-local IMDS DNS answers fail closed at delivery
    await allowWebhookHost(admin);
    const created = await caller.admin.webhooks.subscriptions.create({
      name: "SSRF Guard Sub",
      targetUrl: PARTNER_URL,
      events: ["order.created"],
    });
    expect(created.subscription.targetUrlHost).toBe(PARTNER_HOST);
    expect(created.subscription.targetUrlMasked).not.toContain("secret-token-path-9999");
    expect(created.subscription.targetUrlMasked).not.toContain("api_key=leak");

    for (const privateIp of ["127.0.0.1", "10.0.0.8", "169.254.169.254"]) {
      dnsAnswers[PARTNER_HOST] = [{ address: privateIp, family: 4 }];
      const testRes = await caller.admin.webhooks.subscriptions.testDelivery({
        publicId: created.subscription.publicId,
      });
      expect(testRes.status).toBe("failed");
      expect(httpCalls).toHaveLength(0);
    }

    // Restore public IP, verify HTTP 302 redirect is refused (`WEBHOOK_REDIRECT_FORBIDDEN`) and never followed
    dnsAnswers[PARTNER_HOST] = [{ address: "93.184.216.34", family: 4 }];
    nextHttpHandler = async () => ({
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
      body: Buffer.alloc(0),
    });
    const redirectRes = await caller.admin.webhooks.subscriptions.testDelivery({
      publicId: created.subscription.publicId,
    });
    expect(redirectRes.status).toBe("failed");
    expect(redirectRes.reasonCode).toBe("EGRESS_REDIRECT_REFUSED");
    expect(httpCalls).toHaveLength(1);
  });

  it("encrypts secrets at rest, returns signingSecretOnce once, emits overlap dual signatures, and auto-disables failing subscriptions", async () => {
    const admin = makeStepUpAdmin(h);
    const caller = createCaller(admin);
    await caller.admin.webhooks.settings.update({
      enabled: true,
      autoDisableThreshold: 3,
    });
    await allowWebhookHost(admin);

    // Catalogue excludes staffOnly triggers and rejects subscribing to `message.internal_note`
    const catalogue = await caller.admin.webhooks.catalogue();
    expect(catalogue.some((c) => c.key === "order.created")).toBe(true);
    expect(catalogue.some((c) => c.key === "invoice.paid")).toBe(true);
    expect(catalogue.some((c) => c.key === "message.internal_note")).toBe(false);
    await expect(
      caller.admin.webhooks.subscriptions.create({
        name: "Forbidden Staff Trigger",
        targetUrl: PARTNER_URL,
        events: ["message.internal_note"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const created = await caller.admin.webhooks.subscriptions.create({
      name: "Billing Sink",
      targetUrl: PARTNER_URL,
      events: ["invoice.paid", "order.created"],
    });
    expect(created.signingSecretOnce).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(created.subscription.signingSecretLast4).toBe(
      created.signingSecretOnce.slice(-4),
    );
    expect("signingSecretOnce" in created.subscription).toBe(false);

    // Verify encrypted at rest in DB and absent from audit attributes
    const [dbSub] = await tdb.db
      .select()
      .from(integrationWebhookSubscriptions)
      .where(eq(integrationWebhookSubscriptions.publicId, created.subscription.publicId));
    expect(dbSub).toBeDefined();
    expect(dbSub!.signingSecretEnc).not.toContain(created.signingSecretOnce);
    expect(dbSub!.targetUrlEnc).not.toContain("secret-token-path-9999");
    expect(JSON.stringify(h.audit.events)).not.toContain(created.signingSecretOnce);

    // Rotate secret with 60m overlap -> outbound includes both `v1=<new>,v1=<old>`
    const rotated = await caller.admin.webhooks.subscriptions.rotateSecret({
      publicId: created.subscription.publicId,
      expectedVersion: created.subscription.version,
      overlapMinutes: 60,
    });
    expect(rotated.signingSecretOnce).not.toBe(created.signingSecretOnce);
    expect(rotated.subscription.hasOverlapSecret).toBe(true);

    // Trigger via AuditTap (`invoice.payment.recorded` -> `invoice.paid`) and verify `automation:` correlationId is suppressed
    expect(registeredTaps).toHaveLength(1);
    const tap = registeredTaps[0]!;
    const tapEvent: AuditTapEvent = {
      eventId: "01JAUDITEVT000000000000001",
      occurredAt: h.clock.now().toISOString(),
      category: "business",
      eventName: "invoice.payment.recorded",
      action: "record",
      outcome: "completed",
      actor: { role: "customer", userId: 10 },
      resource: { type: "invoice_payment", publicId: "01JPAY00000000000000000055" },
      correlationId: "corr_tap_invoice_55",
      jobId: null,
      reasonCode: null,
      attributes: {
        invoice_public_id: "01JINV00000000000000000055",
        method: "provider_online",
        amount_minor: 12500,
        currency: "USD",
      },
      safeCounts: {},
    };
    await tdb.db.transaction(async (tx) => {
      await tap.onRecorded(tapEvent, tx);
      // Loop suppression: `correlationId: "automation:01JRUN000000000001"` must NOT enqueue a webhook
      await tap.onRecorded(
        {
          ...tapEvent,
          eventId: "01JAUDITEVT000000000000002",
          correlationId: "automation:01JRUN000000000001",
        },
        tx,
      );
    });
    expect(h.jobs.enqueued.filter((j) => j.type === WEBHOOK_DELIVER_JOB)).toHaveLength(1);

    const jobResults = await h.jobs.runAll(WEBHOOK_DELIVER_JOB);
    expect(jobResults).toEqual([{ outcome: "completed" }]);
    expect(httpCalls).toHaveLength(1);
    const sentSig = httpCalls[0]!.headers?.["X-ReadyPackets-Signature"] ?? "";
    const nowSec = Math.floor(h.clock.now().getTime() / 1000);
    const expectedDual = signWebhookPayload(
      Buffer.from(httpCalls[0]!.body, "utf8"),
      nowSec,
      rotated.signingSecretOnce,
      created.signingSecretOnce,
    );
    expect(sentSig).toBe(expectedDual);
    expect(sentSig.split(",v1=")).toHaveLength(3); // t=..., v1=primary, v1=overlap

    // Advance past 60m overlap -> only primary signature is sent
    h.clock.advance(61 * 60_000);
    const adminAfterOverlap = makeStepUpAdmin(h);
    const callerAfterOverlap = createCaller(adminAfterOverlap);
    await callerAfterOverlap.admin.webhooks.subscriptions.testDelivery({
      publicId: created.subscription.publicId,
    });
    const postOverlapSig = httpCalls[1]!.headers?.["X-ReadyPackets-Signature"] ?? "";
    expect(postOverlapSig.split(",v1=")).toHaveLength(2);

    // Consecutive terminal 410 failures >= threshold (3) auto-disable subscription -> `disabled_failing` & health `degraded`
    nextHttpHandler = async () => ({
      status: 410,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("endpoint gone", "utf8"),
    });
    for (let i = 1; i <= 3; i += 1) {
      await mod.webhooks.publish(
        "order.created",
        { seq: i },
        { deduplicationKey: `fail-seq-${i}` },
      );
      await h.jobs.runAll(WEBHOOK_DELIVER_JOB);
    }

    const subAfterFailures = await callerAfterOverlap.admin.webhooks.subscriptions.get({
      publicId: created.subscription.publicId,
    });
    expect(subAfterFailures.status).toBe("disabled_failing");
    expect(subAfterFailures.consecutiveFailures).toBe(3);

    const degradedHealth = (await mod.health()).find(
      (item) => item.component === "integrations.webhooks",
    );
    expect(degradedHealth?.state).toBe("degraded");
    expect(
      h.audit.events.some(
        (e) => e.eventName === "integration.webhook.subscription_auto_disabled",
      ),
    ).toBe(true);
  });

  it("verifies raw inbound HMAC + timestamp BEFORE JSON.parse, enforces I-01 signed body metadata over unsigned headers, and supports overlap rotation", async () => {
    const admin = makeStepUpAdmin(h);
    const caller = createCaller(admin);
    await caller.admin.webhooks.settings.update({ enabled: true });
    await allowWebhookHost(admin);

    await caller.admin.webhooks.subscriptions.create({
      name: "Outbound Watcher",
      targetUrl: PARTNER_URL,
      events: ["order.created"],
    });

    const createdEp = await caller.admin.webhooks.inbound.create({
      name: "Acme Partner Hook",
      endpointKey: "acme-partner",
      description: "Receives signed partner notifications",
      enabled: true,
      toleranceSeconds: 300,
    });
    const epId = createdEp.endpoint.publicId;
    const path = `/api/webhooks/inbound/${epId}`;

    // 1. Non-POST -> 405 with Allow: POST; non-Buffer Content-Type -> 415; > 256 KiB -> 413; unknown endpoint -> 404
    const methodRes = await postRawHttp(inboundBaseUrl, path, { method: "GET" });
    expect(methodRes.status).toBe(405);
    expect(methodRes.headers.get("allow")).toBe("POST");
    expect(methodRes.headers.get("cache-control")).toBe("no-store");

    const wrongTypeRes = await postRawHttp(inboundBaseUrl, path, {
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(wrongTypeRes.status).toBe(415);

    const hugeBuf = Buffer.alloc(262_145, 0x61);
    const hugeRes = await postRawHttp(inboundBaseUrl, path, {
      headers: { "Content-Type": "application/json" },
      body: hugeBuf,
    });
    expect(hugeRes.status).toBe(413);

    const unknownRes = await postRawHttp(
      inboundBaseUrl,
      "/api/webhooks/inbound/01JUNKNOWNENDPOINT00000000",
      {
        headers: { "Content-Type": "application/json" },
        body: Buffer.from("{}", "utf8"),
      },
    );
    expect(unknownRes.status).toBe(404);

    // 2. Signature & timestamp checked BEFORE JSON.parse: malformed JSON with missing/bad/expired signature -> 401 (never 400)
    const malformedRaw = Buffer.from("{not-valid-json", "utf8");
    const missingSigRes = await postRawHttp(inboundBaseUrl, path, {
      headers: { "Content-Type": "application/json" },
      body: malformedRaw,
    });
    expect(missingSigRes.status).toBe(401);
    expect(missingSigRes.json.code).toBe("MISSING_SIGNATURE");

    const nowSec = Math.floor(h.clock.now().getTime() / 1000);
    const expiredSig = signWebhookPayload(
      malformedRaw,
      nowSec - 301,
      createdEp.signingSecretOnce,
    );
    const expiredRes = await postRawHttp(inboundBaseUrl, path, {
      headers: {
        "Content-Type": "application/json",
        "X-ReadyPackets-Signature": expiredSig,
      },
      body: malformedRaw,
    });
    expect(expiredRes.status).toBe(401);
    expect(expiredRes.json.code).toBe("WEBHOOK_TIMESTAMP_EXPIRED");

    const badHmacRes = await postRawHttp(inboundBaseUrl, path, {
      headers: {
        "Content-Type": "application/json",
        "X-ReadyPackets-Signature": `t=${nowSec},v1=${"0".repeat(64)}`,
      },
      body: malformedRaw,
    });
    expect(badHmacRes.status).toBe(401);
    expect(badHmacRes.json.code).toBe("INVALID_SIGNATURE");

    // 3. I-01 DEFENSIVE REGRESSION:
    //    (a) Signed body missing `id` CANNOT fall back to unsigned `X-ReadyPackets-Event-Id` header -> 400 MISSING_EVENT_ID
    const bodyWithoutId = Buffer.from(
      JSON.stringify({ type: "partner.completed", data: { ok: true } }),
      "utf8",
    );
    const noIdRes = await postRawHttp(inboundBaseUrl, path, {
      headers: {
        "Content-Type": "application/json",
        "X-ReadyPackets-Signature": signWebhookPayload(
          bodyWithoutId,
          nowSec,
          createdEp.signingSecretOnce,
        ),
        "X-ReadyPackets-Event-Id": "evt_unsigned_header_1",
      },
      body: bodyWithoutId,
    });
    expect(noIdRes.status).toBe(400);
    expect(noIdRes.json.code).toBe("MISSING_EVENT_ID");

    //    (b) Valid signed body succeeds (200) and records `integration.webhook.inbound_received` from signed body fields
    const signedBody = Buffer.from(
      JSON.stringify({
        id: "evt_signed_authentic_01",
        type: "partner.kyc_verified",
        data: { reference: "ORD-77", apiKey: "inbound-secret-field" },
      }),
      "utf8",
    );
    const validSig = signWebhookPayload(signedBody, nowSec, createdEp.signingSecretOnce);
    const okRes = await postRawHttp(inboundBaseUrl, path, {
      headers: {
        "Content-Type": "application/json",
        "X-ReadyPackets-Signature": validSig,
        Authorization: "Bearer should-be-redacted",
      },
      body: signedBody,
    });
    expect(okRes.status).toBe(200);
    expect(okRes.json).toMatchObject({ ok: true, duplicate: false });

    const inboundAuditEvents = h.audit.named("integration.webhook.inbound_received");
    expect(inboundAuditEvents).toHaveLength(1);
    expect(inboundAuditEvents[0]!.attributes).toMatchObject({
      endpoint_key: "acme-partner",
      event_type: "partner.kyc_verified",
      is_replay: false,
    });

    //    (c) Substituting unsigned `X-ReadyPackets-Event-Id` or `X-ReadyPackets-Event` headers on the signed body
    //        CANNOT bypass deduplication or alter `event_type` -> rejected with 400 HEADER_BODY_MISMATCH!
    const forgedIdRes = await postRawHttp(inboundBaseUrl, path, {
      headers: {
        "Content-Type": "application/json",
        "X-ReadyPackets-Signature": validSig,
        "X-ReadyPackets-Event-Id": "evt_forged_bypass_999",
      },
      body: signedBody,
    });
    expect(forgedIdRes.status).toBe(400);
    expect(forgedIdRes.json.code).toBe("HEADER_BODY_MISMATCH");

    const forgedTypeRes = await postRawHttp(inboundBaseUrl, path, {
      headers: {
        "Content-Type": "application/json",
        "X-ReadyPackets-Signature": validSig,
        "X-ReadyPackets-Event": "admin.privilege_escalated",
      },
      body: signedBody,
    });
    expect(forgedTypeRes.status).toBe(400);
    expect(forgedTypeRes.json.code).toBe("HEADER_BODY_MISMATCH");
    expect(h.audit.named("integration.webhook.inbound_received")).toHaveLength(1);

    //    (d) Exact replay of same signed `id` is idempotently deduplicated (`duplicate: true`) with zero extra audit event
    const dupRes = await postRawHttp(inboundBaseUrl, path, {
      headers: {
        "Content-Type": "application/json",
        "X-ReadyPackets-Signature": validSig,
      },
      body: signedBody,
    });
    expect(dupRes.status).toBe(200);
    expect(dupRes.json).toMatchObject({ ok: true, duplicate: true });
    expect(h.audit.named("integration.webhook.inbound_received")).toHaveLength(1);
    expect(h.jobs.enqueued.filter((j) => j.type === WEBHOOK_DELIVER_JOB)).toHaveLength(0);

    // 4. Inbound secret rotation with overlap accepts old secret during window and rejects after expiry
    const rotatedEp = await caller.admin.webhooks.inbound.rotateSecret({
      publicId: epId,
      expectedVersion: createdEp.endpoint.version,
      overlapMinutes: 30,
    });
    const overlapBody = Buffer.from(
      JSON.stringify({ id: "evt_overlap_old_key", type: "partner.overlap" }),
      "utf8",
    );
    const overlapNowSec = Math.floor(h.clock.now().getTime() / 1000);
    const overlapRes = await postRawHttp(inboundBaseUrl, path, {
      headers: {
        "Content-Type": "application/json",
        "X-ReadyPackets-Signature": signWebhookPayload(
          overlapBody,
          overlapNowSec,
          createdEp.signingSecretOnce,
        ),
      },
      body: overlapBody,
    });
    expect(overlapRes.status).toBe(200);

    h.clock.advance(31 * 60_000);
    const expiredOverlapBody = Buffer.from(
      JSON.stringify({ id: "evt_after_overlap", type: "partner.overlap" }),
      "utf8",
    );
    const postWindowSec = Math.floor(h.clock.now().getTime() / 1000);
    const rejectedOldKeyRes = await postRawHttp(inboundBaseUrl, path, {
      headers: {
        "Content-Type": "application/json",
        "X-ReadyPackets-Signature": signWebhookPayload(
          expiredOverlapBody,
          postWindowSec,
          createdEp.signingSecretOnce,
        ),
      },
      body: expiredOverlapBody,
    });
    expect(rejectedOldKeyRes.status).toBe(401);

    const acceptedNewKeyRes = await postRawHttp(inboundBaseUrl, path, {
      headers: {
        "Content-Type": "application/json",
        "X-ReadyPackets-Signature": signWebhookPayload(
          expiredOverlapBody,
          postWindowSec,
          rotatedEp.signingSecretOnce,
        ),
      },
      body: expiredOverlapBody,
    });
    expect(acceptedNewKeyRes.status).toBe(200);
  });

  it("redacts stored headers/bodies, enforces 64 KiB truncation & retention purge guards, and supports step-up redeliver & reprocessInbound", async () => {
    const admin = makeStepUpAdmin(h);
    const caller = createCaller(admin);
    await caller.admin.webhooks.settings.update({
      enabled: true,
      retentionDays: 7,
    });
    await allowWebhookHost(admin);

    const sub = await caller.admin.webhooks.subscriptions.create({
      name: "Replay Target",
      targetUrl: PARTNER_URL,
      events: ["order.created"],
    });

    const testOut = await caller.admin.webhooks.subscriptions.testDelivery({
      publicId: sub.subscription.publicId,
    });
    const outDetail = await caller.admin.webhooks.deliveries.get({
      publicId: testOut.publicId,
    });
    // Sensitive request/response headers & JSON secret keys are redacted before storage
    expect(outDetail.requestHeaders).not.toBeNull();
    expect(JSON.stringify(outDetail.requestHeaders)).not.toContain(
      sub.signingSecretOnce.slice(6, 20),
    );
    expect(JSON.stringify(outDetail.responseHeaders)).not.toContain(
      "super-secret-cookie",
    );
    expect(outDetail.responseBody).not.toContain("resp-secret-value");

    // Step-up `redeliver` enqueues and delivers a linked replay row with `X-ReadyPackets-Replay: 1`
    const redelivered = await caller.admin.webhooks.deliveries.redeliver({
      publicId: testOut.publicId,
    });
    await h.jobs.runAll(WEBHOOK_DELIVER_JOB);
    const replayDetail = await caller.admin.webhooks.deliveries.get({
      publicId: redelivered.publicId,
    });
    expect(replayDetail.isReplay).toBe(true);
    expect(replayDetail.replayOfPublicId).toBe(testOut.publicId);
    expect(replayDetail.status).toBe("delivered");
    expect(httpCalls.at(-1)?.headers?.["X-ReadyPackets-Replay"]).toBe("1");

    // Inbound > 64 KiB (72 KiB <= 256 KiB) stores `bodyTruncated: true` and refuses `reprocessInbound` with CONFLICT
    const ep = await caller.admin.webhooks.inbound.create({
      name: "Truncate & Replay Endpoint",
      endpointKey: "trunc-replay",
      enabled: true,
      toleranceSeconds: 300,
    });
    const path = `/api/webhooks/inbound/${ep.endpoint.publicId}`;
    const nowSec = Math.floor(h.clock.now().getTime() / 1000);

    const largeBody = Buffer.from(
      JSON.stringify({
        id: "evt_large_72k",
        type: "partner.bulk",
        padding: "x".repeat(72_000),
      }),
      "utf8",
    );
    const largeRes = await postRawHttp(inboundBaseUrl, path, {
      headers: {
        "Content-Type": "application/json",
        "X-ReadyPackets-Signature": signWebhookPayload(
          largeBody,
          nowSec,
          ep.signingSecretOnce,
        ),
      },
      body: largeBody,
    });
    expect(largeRes.status).toBe(200);
    const largeDeliveryId = String(largeRes.json.deliveryId);
    const largeDetail = await caller.admin.webhooks.deliveries.get({
      publicId: largeDeliveryId,
    });
    expect(largeDetail.bodyTruncated).toBe(true);
    expect(largeDetail.canReplay).toBe(false);

    await expect(
      caller.admin.webhooks.deliveries.reprocessInbound({ publicId: largeDeliveryId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Non-truncated inbound delivery succeeds on `reprocessInbound` and emits `is_replay: true` audit event
    const normalBody = Buffer.from(
      JSON.stringify({
        id: "evt_reprocess_ok",
        type: "partner.ready",
        data: { ticket: "T-100", Authorization: "Bearer secret-in-body" },
      }),
      "utf8",
    );
    const normalRes = await postRawHttp(inboundBaseUrl, path, {
      headers: {
        "Content-Type": "application/json",
        "X-ReadyPackets-Signature": signWebhookPayload(
          normalBody,
          nowSec,
          ep.signingSecretOnce,
        ),
        Authorization: "Bearer inbound-header-secret",
      },
      body: normalBody,
    });
    const normalDeliveryId = String(normalRes.json.deliveryId);
    const normalDetail = await caller.admin.webhooks.deliveries.get({
      publicId: normalDeliveryId,
    });
    expect(JSON.stringify(normalDetail.requestHeaders)).not.toContain(
      "inbound-header-secret",
    );
    expect(normalDetail.requestBody).not.toContain("secret-in-body");

    const reprocessed = await caller.admin.webhooks.deliveries.reprocessInbound({
      publicId: normalDeliveryId,
    });
    expect(reprocessed.isReplay).toBe(true);
    expect(reprocessed.replayOfPublicId).toBe(normalDeliveryId);

    // Retention purge job wipes expired bodies while keeping metadata, and refuses replay with CONFLICT
    h.clock.advance(8 * 86_400_000);
    const adminFresh = makeStepUpAdmin(h);
    const callerFresh = createCaller(adminFresh);
    const purgeHandler = h.jobs.handlers.get(WEBHOOK_PURGE_JOB);
    expect(purgeHandler).toBeDefined();
    await purgeHandler!({
      jobId: "job_purge_1",
      type: WEBHOOK_PURGE_JOB,
      payload: {} as never,
      attempt: 1,
      fencingToken: 1,
      correlationId: "corr_purge_1",
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });

    const purgedDetail = await callerFresh.admin.webhooks.deliveries.get({
      publicId: normalDeliveryId,
    });
    expect(purgedDetail.bodyPurged).toBe(true);
    expect(purgedDetail.requestBody).toBeNull();
    await expect(
      callerFresh.admin.webhooks.deliveries.reprocessInbound({ publicId: normalDeliveryId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // `retentionDays: 0` immediately purges bodies on completion
    await callerFresh.admin.webhooks.settings.update({ retentionDays: 0 });
    const zeroRetTest = await callerFresh.admin.webhooks.subscriptions.testDelivery({
      publicId: sub.subscription.publicId,
    });
    const zeroRetDetail = await callerFresh.admin.webhooks.deliveries.get({
      publicId: zeroRetTest.publicId,
    });
    expect(zeroRetDetail.bodyPurged).toBe(true);
    expect(zeroRetDetail.requestBody).toBeNull();
    const [rawRow] = await tdb.db
      .select()
      .from(integrationWebhookDeliveries)
      .where(eq(integrationWebhookDeliveries.publicId, zeroRetTest.publicId));
    expect(rawRow).toBeDefined();
    expect(rawRow!.payloadEnc).toBeNull();
  });

  it("registers safe Public API v1 `webhookSubscriptions` provider and exposes Stripe/Square egress presets", async () => {
    const admin = makeStepUpAdmin(h);
    const caller = createCaller(admin);
    await caller.admin.webhooks.settings.update({ enabled: true });
    await allowWebhookHost(admin);

    const subA = await caller.admin.webhooks.subscriptions.create({
      name: "Sub Alpha",
      targetUrl: PARTNER_URL,
      events: ["order.created"],
    });
    h.clock.advance(2_000);
    const admin2 = makeStepUpAdmin(h);
    const caller2 = createCaller(admin2);
    const subB = await caller2.admin.webhooks.subscriptions.create({
      name: "Sub Beta",
      targetUrl: PARTNER_URL,
      events: ["invoice.paid"],
      paused: true,
    });

    expect(registeredApiProvider).not.toBeNull();
    const apiCaller: ApiCaller = {
      kind: "api_key",
      keyPublicId: "01JAPIKEY00000000000000001",
      scopes: ["webhooks:read"],
      requestId: "01JAPIREQ00000000000000001",
      replay: false,
    };

    const page1 = await registeredApiProvider!.list(
      { cursor: null, limit: 1, filter: {} },
      apiCaller,
    );
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]!.id).toBe(subB.subscription.publicId);
    expect(page1.items[0]!.targetUrlHost).toBe(PARTNER_HOST);
    expect(JSON.stringify(page1.items[0])).not.toContain("secret-token-path-9999");
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await registeredApiProvider!.list(
      { cursor: page1.nextCursor, limit: 1, filter: {} },
      apiCaller,
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.id).toBe(subA.subscription.publicId);

    const single = await registeredApiProvider!.get(
      subA.subscription.publicId,
      apiCaller,
    );
    expect(single?.name).toBe("Sub Alpha");

    // Stripe & Square egress presets enforce mandatory allowlist rules (`stripe` / `square`)
    const presets = await mod.egress.listPresets();
    const keys = presets.map((p) => p.key);
    expect(keys).toEqual(
      expect.arrayContaining(["stripe", "square", "square_sandbox"]),
    );

    dnsAnswers["api.stripe.com"] = [{ address: "34.102.136.180", family: 4 }];
    // Before enabling the Stripe preset, mandatory cloud allowlist refuses `purpose: "stripe"`
    const blockedCheck = await mod.egress.checkTarget(admin2, {
      target: "https://api.stripe.com/v1/payment_intents",
      purpose: "stripe",
    });
    expect(blockedCheck.allowed).toBe(false);

    const stripeView = await mod.egress.setPresetEnabled(admin2, {
      presetKey: "stripe",
      enabled: true,
    });
    expect(stripeView.enabled).toBe(true);
    expect(stripeView.hosts).toEqual(["api.stripe.com"]);
    expect(stripeView.purpose).toBe("stripe");

    const allowedCheck = await mod.egress.checkTarget(admin2, {
      target: "https://api.stripe.com/v1/payment_intents",
      purpose: "stripe",
    });
    expect(allowedCheck.allowed).toBe(true);

    const squareSandboxView = await mod.egress.setPresetEnabled(admin2, {
      presetKey: "square_sandbox",
      enabled: true,
    });
    expect(squareSandboxView.hosts).toEqual(["connect.squareupsandbox.com"]);
  });
});
