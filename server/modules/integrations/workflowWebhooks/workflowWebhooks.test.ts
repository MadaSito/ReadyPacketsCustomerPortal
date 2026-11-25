/**
 * Increment 07 Package K (Decision D7) — Outbound Webhooks, Phase Triggers, Signing,
 * Stop / Eligible Retry / Order Filter, Ops Alerts, Egress Presets & Microsoft Graph.
 */
import type { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, forbidden } from "../../../core/errors.js";
import { newRequestContext } from "../../../core/requestContext.js";
import type { Db, SessionPrincipal, Tx } from "../../../core/types.js";
import type { AuditTap, AuditTapEvent } from "../../audit/tap.js";
import type { UserView } from "../../identity/index.js";
import type { OutboxJobDisposition } from "../../jobs/index.js";
import "../../jobs/mailSettings.js";
import type { EmitOpsAlert, OpsAlertIdentity } from "../../opsAlerts/index.js";
import type { OrderAccessView, OrderLockState, OrderProductionScope } from "../../orders/types.js";
import { platformSettings } from "../../platform/schema.js";
import { createSettingsStore } from "../../platform/settingsStore.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../../tests/helpers/testDb.js";
import {
  createIntegrationsModule,
  GraphApiError,
  PRODUCTION_DELIVERY_JOB,
  WEBHOOK_DELIVER_JOB,
  type EgressFetchResponse,
  type IntegrationsModule,
  type PinnedEgressTarget,
} from "../index.js";
import { integrationsRouter } from "../router.js";
import { integrationWebhookDeliveries } from "../schema.js";
import { signWebhookPayload } from "../webhooks/crypto.js";

const PROD_HOST = "hooks.production.example.test";
const SUB_HOST = "hooks.partner.example.test";
const P101_URL = `https://${PROD_HOST}/webhooks/p101-secret-9876`;
const P201_URL = `https://${PROD_HOST}/webhooks/p201-secret-4321`;
const SUB_URL = `https://${SUB_HOST}/v1/events/secret-token-9999?token=do-not-leak`;

const TENANT_GUID = "11111111-2222-4333-8444-555555555555";
const CLIENT_GUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GRAPH_SECRET = "top-secret-entra-credential-value-7777";

function makeStepUpAdmin(h: TestHarness, overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
  const now = h.clock.now();
  return fakePrincipal({
    userId: 1,
    userPublicId: "01JD7ADM1N0000000000000001",
    role: "admin",
    state: "full",
    pendingSteps: [],
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: now,
    ...overrides,
  });
}

function makeAdminNoStepUp(h: TestHarness): SessionPrincipal {
  const now = h.clock.now();
  return fakePrincipal({
    userId: 1,
    userPublicId: "01JD7ADM1N0000000000000001",
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
    userPublicId: "01JD7STAFF0000000000000002",
    role: "staff",
    state: "full",
    pendingSteps: [],
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: null,
  });
}

function makeCustomer(h: TestHarness): SessionPrincipal {
  const now = h.clock.now();
  return fakePrincipal({
    userId: 3,
    userPublicId: "01JD7C0ST00000000000000003",
    role: "customer",
    state: "full",
    pendingSteps: [],
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: null,
  });
}

describe("Increment 07 Package K (D7) — workflowWebhooks, signing, stop/retry, opsAlerts & Graph", () => {
  let tdb: TestDb;
  let h: TestHarness;
  let mod: IntegrationsModule;
  let registeredTaps: AuditTap[];
  let emittedAlerts: EmitOpsAlert[];
  let resolvedAlerts: OpsAlertIdentity[];

  interface MockOrderRecord {
    access: OrderAccessView;
    scope: OrderProductionScope;
    workflowKey: string;
    currentStageKey: string;
    intakeLocked: boolean;
  }

  const mockOrders = new Map<string, MockOrderRecord>();
  const mockUsers = new Map<number, UserView>();
  const mockWorkflows = [
    {
      publicId: "01JWFDEFAV1T00000000000001",
      workflowKey: "default_packet_v3",
      name: "Default Packet Workflow",
      isDefault: true,
    },
  ];

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
    method: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }) => Promise<EgressFetchResponse>;

  beforeAll(async () => {
    tdb = await createTestDb();
  });

  afterAll(async () => {
    await tdb.cleanup();
  });

  function seedOrder(opts?: {
    orderId?: number;
    orderPublicId?: string;
    reference?: string;
    currentStageKey?: string;
    intakeLocked?: boolean;
    lockState?: OrderLockState;
  }) {
    const orderId = opts?.orderId ?? 701;
    const orderPublicId = opts?.orderPublicId ?? "01J0RDER000000000000000701";
    const reference = opts?.reference ?? "ORD-2026-0701";
    const ownerUserId = 1000 + orderId;
    const lockState: OrderLockState = opts?.lockState ?? "review";
    const currentStageKey = opts?.currentStageKey ?? "phase_1_intake";
    const intakeLocked = opts?.intakeLocked ?? false;

    mockUsers.set(ownerUserId, {
      id: ownerUserId,
      publicId: `01J0SER0000000000000000${String(orderId).padStart(3, "0")}`,
      email: "customer.d7@client.example.test",
      name: "Alex Rivera",
      role: "customer",
      status: "active",
      customerRef: "RP-D700701",
      emailVerified: true,
      authSource: "local",
      mustChangePassword: false,
      hasPassword: true,
      version: 1,
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
    });

    mockOrders.set(orderPublicId, {
      access: {
        id: orderId,
        publicId: orderPublicId,
        reference,
        ownerUserId,
        ownerPublicId: mockUsers.get(ownerUserId)!.publicId,
        statusKey: currentStageKey === "awaiting_payment" ? "awaiting_payment" : "intake_open",
        lockState,
        locked: lockState !== "none",
        readOnlyImported: false,
        accessRole: "staff",
        canWrite: true,
        origin: "portal",
        version: 1,
        workflowVersionId: 7,
      },
      scope: {
        orderId,
        orderPublicId,
        reference,
        ownerUserId,
        statusKey: currentStageKey === "awaiting_payment" ? "awaiting_payment" : "intake_open",
        lockState,
        origin: "portal",
        packets: [{ packetNumber: 1, tier: "Standard" }],
        otherItemCount: 0,
      },
      workflowKey: "default_packet_v3",
      currentStageKey,
      intakeLocked,
    });

    return { orderId, orderPublicId, reference, ownerUserId };
  }

  function wireDeps(targetHarness: TestHarness, dbHandle: Db) {
    targetHarness.deps.db = dbHandle;
    targetHarness.deps.settings = createSettingsStore({
      db: dbHandle,
      crypto: targetHarness.deps.crypto,
      clock: targetHarness.clock,
      audit: targetHarness.audit,
      logger: targetHarness.deps.logger,
    });

    targetHarness.services.auditCenter = {
      registerTap(tap: AuditTap) {
        registeredTaps.push(tap);
      },
    } as never;

    targetHarness.services.opsAlerts = {
      emit: vi.fn(async (input: EmitOpsAlert) => {
        emittedAlerts.push(input);
        return { publicId: "01JA1ERT000000000000000001", created: true, occurrenceCount: 1 };
      }),
      resolve: vi.fn(async (input: OpsAlertIdentity) => {
        resolvedAlerts.push(input);
        return { resolved: true };
      }),
    } as never;

    targetHarness.services.identity = {
      sessions: {
        assertCurrent: vi.fn(async (principal: SessionPrincipal, _tx: Tx) => ({
          pendingSteps: principal.pendingSteps,
          role: principal.role,
          stepUpAt: principal.stepUpAt,
          mfaVerifiedAt: principal.mfaVerifiedAt,
        })),
      },
      getUser: vi.fn(async (userId: number) => mockUsers.get(userId) ?? null),
    } as never;

    targetHarness.services.orders = {
      assertCanReadOrder: vi.fn(async (principal: SessionPrincipal, orderPublicId: string) => {
        if (principal.role === "customer") throw forbidden("STAFF_ONLY");
        const entry = mockOrders.get(orderPublicId);
        if (!entry) throw new DomainError("NOT_FOUND", "ORDER_NOT_FOUND", "Order not found.");
        return {
          ...entry.access,
          accessRole: principal.role === "admin" ? "admin" : "staff",
        };
      }),
      getOrderRefByPublicId: vi.fn(async (orderPublicId: string) => {
        const entry = mockOrders.get(orderPublicId);
        if (!entry) return null;
        return {
          id: entry.access.id,
          publicId: entry.access.publicId,
          reference: entry.access.reference,
          name: "D7 Test Order",
          ownerUserId: entry.access.ownerUserId,
          lockState: entry.access.lockState,
          statusKey: entry.access.statusKey,
          workflowVersionId: entry.access.workflowVersionId,
        };
      }),
      getProductionScope: vi.fn(async (orderId: number) => {
        for (const entry of mockOrders.values()) {
          if (entry.scope.orderId === orderId) return entry.scope;
        }
        return null;
      }),
      isStatusPhaseLocked: vi.fn(async (orderId: number) => {
        for (const entry of mockOrders.values()) {
          if (entry.access.id === orderId) return entry.intakeLocked;
        }
        return false;
      }),
      stages: {
        contextForRun: vi.fn(async (orderPublicId: string) => {
          const entry = mockOrders.get(orderPublicId);
          if (!entry) throw new DomainError("NOT_FOUND", "ORDER_NOT_FOUND", "Order not found.");
          return {
            orderId: entry.access.id,
            orderPublicId: entry.access.publicId,
            workflowVersionId: entry.access.workflowVersionId,
            currentStageKey: entry.currentStageKey,
            stages: [
              {
                key: "awaiting_payment",
                label: "Payment",
                statusKeys: ["awaiting_payment"],
                completesOn: "payment",
                progression: "automatic",
              },
              {
                key: "phase_1_intake",
                label: "Phase 1 Intake",
                statusKeys: ["intake_open"],
                completesOn: "submission",
                progression: "submit_lock",
              },
            ],
          };
        }),
      },
      workflows: {
        list: vi.fn(async () => mockWorkflows),
        byVersionId: vi.fn(async (_tx: Db, _versionId: number) => ({
          workflowKey: "default_packet_v3",
        })),
      },
    } as never;

    targetHarness.services.jobAdmin = {
      reconcileOutboxJob: vi.fn(
        async (
          jobPublicId: string,
          _tx: Tx,
          options?: { cancelQueued?: boolean },
        ): Promise<OutboxJobDisposition> => {
          const idx = targetHarness.jobs.enqueued.findIndex((j) => j.jobId === jobPublicId);
          if (idx >= 0) {
            if (options?.cancelQueued) {
              targetHarness.jobs.enqueued.splice(idx, 1);
              return { state: "canceled_queued" };
            }
            return { state: "queued_live" };
          }
          return { state: "missing" };
        },
      ),
      registerMailTransport: vi.fn(),
    } as never;
  }

  function createCaller(session: SessionPrincipal | null) {
    return integrationsRouter.createCaller({
      services: h.services,
      session,
      request: newRequestContext("test"),
      transport: { issue() {}, clear() {} },
    });
  }

  async function configureWebhooksAndProduction(admin: SessionPrincipal) {
    for (const host of [PROD_HOST, SUB_HOST]) {
      await mod.egress.createAllowlistRule(admin, {
        purpose: "webhook",
        matchType: "host",
        pattern: host,
        port: 443,
        protocol: "https:",
        allowPrivateAddress: false,
        enabled: true,
        justification: `Allow ${host} for D7 tests`,
      });
    }
    await mod.production.updateSettings(admin, {
      enabled: true,
      p101Url: P101_URL,
      p201Url: P201_URL,
      canonVersion: "canon-2026.11",
      runMode: "production",
      timeoutMs: 10_000,
    });
    await mod.webhooks.updateSettings(admin, {
      enabled: true,
      retentionDays: 30,
      autoDisableThreshold: 3,
      deliveryTimeoutMs: 5_000,
    });
  }

  beforeEach(async () => {
    const conn = await tdb.pool.getConnection();
    try {
      await conn.query("DELETE FROM integration_webhook_delivery_attempts");
      await conn.query("DELETE FROM integration_webhook_deliveries");
      await conn.query("DELETE FROM integration_webhook_subscriptions");
      await conn.query("DELETE FROM integration_production_dispatches");
      await conn.query("DELETE FROM integration_egress_allowlist");
      await conn.query("DELETE FROM integration_provider_checks");
      await conn.query("DELETE FROM integration_webhook_events");
      await conn.query("DELETE FROM platform_settings");
    } finally {
      conn.release();
    }

    mockOrders.clear();
    mockUsers.clear();
    registeredTaps = [];
    emittedAlerts = [];
    resolvedAlerts = [];
    httpCalls = [];
    nextHttpHandler = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}', "utf8"),
    });

    const dnsAnswers: Record<string, Array<{ address: string; family: 4 | 6 }>> = {
      [PROD_HOST]: [{ address: "93.184.216.34", family: 4 }],
      [SUB_HOST]: [{ address: "93.184.216.35", family: 4 }],
      "login.microsoftonline.com": [{ address: "40.126.32.10", family: 4 }],
      "graph.microsoft.com": [{ address: "20.190.159.2", family: 4 }],
      "contoso.sharepoint.com": [{ address: "52.105.12.34", family: 4 }],
    };

    h = createTestDeps({ db: tdb.db });
    wireDeps(h, tdb.db);

    mod = createIntegrationsModule(h.deps, {
      egress: {
        dnsLookup: async (hostname) => dnsAnswers[hostname] ?? [],
        httpsRequester: async (pinned, url, options) => {
          const nonStreamBody =
            typeof options.body === "string" || options.body instanceof Uint8Array ? options.body : undefined;
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
            method: options.method,
            headers: options.headers,
            body: nonStreamBody,
          });
        },
      },
    });
    h.services.integrations = mod;
    mod.init();
  });

  it("parses pre-Increment-07 stored production settings without signing fields and delivers unsigned by default", async () => {
    const admin = makeStepUpAdmin(h);
    await configureWebhooksAndProduction(admin);

    // Overwrite `integrations.production.config` in MySQL with pre-Increment-07 JSON shape (no signing keys)
    await tdb.db
      .update(platformSettings)
      .set({
        valueJson: {
          canonVersion: "canon-2026.05-legacy",
          runMode: "production",
          timeoutMs: 12_000,
          authHeaderName: "",
        },
      })
      .where(eq(platformSettings.settingKey, "integrations.production.config"));

    // Re-create settingsStore + module so readSetting loads the uncached pre-Increment-07 row directly from MySQL
    h.deps.settings = createSettingsStore({
      db: tdb.db,
      crypto: h.deps.crypto,
      clock: h.clock,
      audit: h.audit,
      logger: h.deps.logger,
    });
    const freshMod = createIntegrationsModule(h.deps, {
      egress: {
        dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        httpsRequester: async (_pinned, url, options) => {
          const bodyStr =
            typeof options.body === "string"
              ? options.body
              : options.body instanceof Uint8Array
                ? Buffer.from(options.body).toString("utf8")
                : "";
          httpCalls.push({
            pinned: _pinned,
            url: url.toString(),
            method: options.method,
            headers: options.headers,
            body: bodyStr,
          });
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from('{"ok":true}', "utf8"),
          };
        },
      },
    });

    const settings = await freshMod.production.getSettings();
    expect(settings.canonVersion).toBe("canon-2026.05-legacy");
    expect(settings.signingEnabled).toBe(false);
    expect(settings.signingSecretConfigured).toBe(false);
    expect(settings.signingSecretLast4).toBeNull();
    expect(settings.configured).toBe(true);

    const { orderPublicId } = seedOrder({ currentStageKey: "phase_1_intake", intakeLocked: false });
    const req = await freshMod.production.requestP101(admin, { orderPublicId });
    expect(req.state).toBe("queued");
    expect(req.triggerSource).toBe("manual");

    const prodHandler = h.jobs.handlers.get(PRODUCTION_DELIVERY_JOB)!;
    await prodHandler({
      jobId: h.jobs.enqueued[0]!.jobId,
      type: PRODUCTION_DELIVERY_JOB,
      attempt: 1,
      fencingToken: 1,
      correlationId: req.correlationId,
      payload: { dispatchId: req.publicId } as never,
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });

    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]!.headers?.["X-ReadyPackets-Signature"]).toBeUndefined();
  });

  it("enforces router authz on workflowWebhooks.listOptions, never leaks URLs/secrets, validates targetKeys, and resolves portable refs", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    const customer = makeCustomer(h);
    await configureWebhooksAndProduction(admin);

    const createdSub = await mod.webhooks.createSubscription(admin, {
      name: "CRM Stage Hook",
      targetUrl: SUB_URL,
      events: ["order.created"],
    });

    await expect(createCaller(null).workflowWebhooks.listOptions({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    } satisfies Partial<TRPCError>);
    await expect(createCaller(customer).workflowWebhooks.listOptions({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    } satisfies Partial<TRPCError>);

    const options = await createCaller(staff).workflowWebhooks.listOptions({ kind: "all" });
    expect(options.map((o) => o.targetKey)).toEqual([
      "production:P101",
      "production:P201",
      "production:P301",
      "production:P401",
      `subscription:${createdSub.subscription.publicId}`,
    ]);
    const serialized = JSON.stringify(options);
    expect(serialized).not.toContain(PROD_HOST);
    expect(serialized).not.toContain(SUB_HOST);
    expect(serialized).not.toContain("do-not-leak");
    expect(serialized).not.toContain(createdSub.signingSecretOnce);

    expect(await mod.workflowWebhooks.validateTargetKey(null)).toMatchObject({
      valid: true,
      normalizedKey: null,
      configured: true,
      enabled: true,
    });
    expect(await mod.workflowWebhooks.validateTargetKey("production:P101")).toMatchObject({
      valid: true,
      kind: "production",
      configured: true,
      enabled: true,
    });
    expect(await mod.workflowWebhooks.validateTargetKey("production:P301")).toMatchObject({
      valid: true,
      kind: "production",
      configured: false,
    });
    expect(
      await mod.workflowWebhooks.validateTargetKey(`subscription:${createdSub.subscription.publicId}`),
    ).toMatchObject({
      valid: true,
      kind: "subscription",
      exists: true,
      enabled: true,
    });
    expect(await mod.workflowWebhooks.validateTargetKey("subscription:01J00000000000000000000999")).toMatchObject({
      valid: false,
      exists: false,
      reasonCode: "STAGE_WEBHOOK_TARGET_NOT_FOUND",
    });
    expect(await mod.workflowWebhooks.validateTargetKey("https://evil.example/hook")).toMatchObject({
      valid: false,
      reasonCode: "STAGE_WEBHOOK_TARGET_INVALID",
    });

    expect(await mod.workflowWebhooks.resolvePortableTargetRef("production:P201")).toEqual({
      targetKey: "production:P201",
      warningCode: null,
    });
    expect(await mod.workflowWebhooks.resolvePortableTargetRef("CRM Stage Hook")).toEqual({
      targetKey: `subscription:${createdSub.subscription.publicId}`,
      warningCode: null,
    });
    expect(await mod.workflowWebhooks.resolvePortableTargetRef("Missing Hook")).toEqual({
      targetKey: null,
      warningCode: "WEBHOOK_SUBSCRIPTION_NOT_FOUND",
    });
  });

  it("enforces P201 preconditions on enqueueStageWebhook without throwing, links subscription deliveries to orderPublicId, and supports opt-in lifecycle auto-queue with backfill guard", async () => {
    const admin = makeStepUpAdmin(h);
    await configureWebhooksAndProduction(admin);

    const createdSub = await mod.webhooks.createSubscription(admin, {
      name: "Fulfillment Subscription",
      targetUrl: SUB_URL,
      events: ["order.created"],
      signingEnabled: false,
    });
    expect(createdSub.subscription.signingEnabled).toBe(false);

    const { orderPublicId } = seedOrder({
      currentStageKey: "awaiting_payment",
      intakeLocked: false,
    });

    // Unmet P201 precondition (no delivered P101 + intake unlocked) returns refused_precondition and NEVER throws
    const refusedP201 = await tdb.db.transaction((tx) =>
      mod.workflowWebhooks.enqueueStageWebhook(
        {
          targetKey: "production:P201",
          orderPublicId,
          stageKey: "phase_1_intake",
          triggerSource: "stage_bundle",
          idempotencyKey: `stage-bundle:${orderPublicId}:phase_1_intake:P201`,
          correlationId: "corr-stage-p201",
        },
        tx,
      ),
    );
    expect(refusedP201.outcome).toBe("refused_precondition");
    expect(refusedP201.reasonCode).toBe("PHASE1_INTAKE_NOT_LOCKED");
    expect(
      h.audit.events.some(
        (e) => e.eventName === "integration.production.dispatch.refused" && e.orderPublicId === orderPublicId,
      ),
    ).toBe(true);

    // Subscription stage webhook enqueues delivery linked to orderPublicId + stageKey and delivers unsigned when signingEnabled = false
    const subQueued = await tdb.db.transaction((tx) =>
      mod.workflowWebhooks.enqueueStageWebhook(
        {
          targetKey: `subscription:${createdSub.subscription.publicId}`,
          orderPublicId,
          stageKey: "phase_1_intake",
          triggerSource: "stage_bundle",
          idempotencyKey: `stage-bundle:${orderPublicId}:phase_1_intake:sub`,
          correlationId: "corr-stage-sub",
          eventKey: "order.stage.entered",
        },
        tx,
      ),
    );
    expect(subQueued.outcome).toBe("queued");
    expect(subQueued.deliveryPublicId).toBeTruthy();

    const filteredByOrder = await createCaller(admin).admin.webhooks.deliveries.list({
      orderPublicId,
    });
    expect(filteredByOrder.items).toHaveLength(1);
    expect(filteredByOrder.items[0]!.orderPublicId).toBe(orderPublicId);
    expect(filteredByOrder.items[0]!.stageKey).toBe("phase_1_intake");

    const webhookHandler = h.jobs.handlers.get(WEBHOOK_DELIVER_JOB)!;
    const subJob = h.jobs.enqueued.find((j) => j.type === WEBHOOK_DELIVER_JOB)!;
    await webhookHandler({
      jobId: subJob.jobId,
      type: WEBHOOK_DELIVER_JOB,
      attempt: 1,
      fencingToken: 1,
      correlationId: "corr-sub-unsigned",
      payload: subJob.payload as never,
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]!.headers?.["X-ReadyPackets-Signature"]).toBeUndefined();

    // Lifecycle auto-queue is OFF by default -> payment event does nothing
    const lifecycleTap = registeredTaps.find((t) => t.listens("order.payment_state.changed"))!;
    expect(lifecycleTap).toBeDefined();

    const makePaymentTapEvent = (overrides: Partial<AuditTapEvent> = {}): AuditTapEvent => ({
      eventId: "01JTAPEVT00000000000000001",
      eventName: "order.payment_state.changed",
      category: "business",
      action: "update",
      outcome: "completed",
      reasonCode: "INVOICE_PAID",
      occurredAt: h.clock.now().toISOString(),
      actor: { role: "customer", userId: 3 },
      resource: { type: "order", publicId: orderPublicId },
      correlationId: "corr-pay-1",
      jobId: null,
      attributes: { from_state: "unpaid", to_state: "paid", ref: "stripe" },
      safeCounts: {},
      ...overrides,
    });

    await tdb.db.transaction((tx) => lifecycleTap.onRecorded(makePaymentTapEvent(), tx));
    expect((await mod.production.orderHistory(admin, { orderPublicId })).items.length).toBe(0);

    // Enable lifecycle auto-queue for default_packet_v3 via tRPC router
    const listedBefore = await createCaller(admin).production.workflowAutoQueue.list();
    expect(listedBefore.items[0]).toMatchObject({
      workflowKey: "default_packet_v3",
      p101OnPaymentConfirmed: false,
      p201OnPhase1Locked: false,
    });

    const updatedPolicies = await createCaller(admin).production.workflowAutoQueue.set({
      workflowPublicId: mockWorkflows[0]!.publicId,
      p101OnPaymentConfirmed: true,
      p201OnPhase1Locked: true,
    });
    expect(updatedPolicies.items[0]).toMatchObject({
      p101OnPaymentConfirmed: true,
      p201OnPhase1Locked: true,
    });

    // Backfill payment event MUST NEVER queue P101
    await tdb.db.transaction((tx) =>
      lifecycleTap.onRecorded(
        makePaymentTapEvent({
          reasonCode: "PAYMENT_BACKFILL",
          attributes: { from_state: "unpaid", to_state: "paid", ref: "backfill" },
        }),
        tx,
      ),
    );
    expect((await mod.production.orderHistory(admin, { orderPublicId })).items.length).toBe(0);

    // Live payment confirmation queues P101 in-tx even while order stage hasn't yet advanced past awaiting_payment
    await tdb.db.transaction((tx) => lifecycleTap.onRecorded(makePaymentTapEvent(), tx));
    const afterPayHistory = (await mod.production.orderHistory(admin, { orderPublicId })).items;
    expect(afterPayHistory).toHaveLength(1);
    expect(afterPayHistory[0]).toMatchObject({
      phase: "P101",
      state: "queued",
      triggerSource: "lifecycle_payment_confirmed",
    });

    // Deliver P101 so P201 precondition is satisfied when Phase 1 locks
    const prodHandler = h.jobs.handlers.get(PRODUCTION_DELIVERY_JOB)!;
    const p101Job = h.jobs.enqueued.find(
      (j) =>
        j.type === PRODUCTION_DELIVERY_JOB &&
        (j.payload as { dispatchId: string }).dispatchId === afterPayHistory[0]!.publicId,
    )!;
    const p101DeliverRes = await prodHandler({
      jobId: p101Job.jobId,
      type: PRODUCTION_DELIVERY_JOB,
      attempt: 1,
      fencingToken: 1,
      correlationId: afterPayHistory[0]!.correlationId,
      payload: p101Job.payload as never,
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });
    expect(p101DeliverRes.outcome).toBe("completed");

    // Advance order into locked Phase 1 and fire order.stage.submitted
    const orderEntry = mockOrders.get(orderPublicId)!;
    orderEntry.currentStageKey = "phase_1_intake";
    orderEntry.intakeLocked = true;

    await tdb.db.transaction((tx) =>
      lifecycleTap.onRecorded(
        {
          eventId: "01JTAPEVT00000000000000002",
          eventName: "order.stage.submitted",
          category: "business",
          action: "submit",
          outcome: "completed",
          reasonCode: "STAGE_SUBMITTED",
          occurredAt: h.clock.now().toISOString(),
          actor: { role: "customer", userId: 3 },
          resource: { type: "order", publicId: orderPublicId },
          correlationId: "corr-stage-lock-1",
          jobId: null,
          attributes: { stage_key: "phase_1_intake", locked: true },
          safeCounts: {},
        },
        tx,
      ),
    );

    const afterLockHistory = (await mod.production.orderHistory(admin, { orderPublicId })).items;
    expect(afterLockHistory.find((d) => d.phase === "P201")).toMatchObject({
      phase: "P201",
      state: "queued",
      triggerSource: "lifecycle_phase1_locked",
      stageKey: "phase_1_intake",
    });
  });

  it("supports optional HMAC signing + overlap rotation on production endpoints, stop + eligible retry vs redeliver, and opsAlerts", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureWebhooksAndProduction(admin);

    // Cannot enable production signing before rotating a signing secret
    await expect(
      createCaller(admin).production.setSigningEnabled({ signingEnabled: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" } satisfies Partial<TRPCError>);

    // Rotate secret #1, enable signing, then rotate secret #2 with 60-minute overlap
    const firstRot = await createCaller(admin).production.rotateSigningSecret({ overlapMinutes: 60 });
    expect(firstRot.signingSecretOnce).toMatch(/^whsec_[0-9a-f]{48}$/);
    await createCaller(admin).production.setSigningEnabled({ signingEnabled: true });
    const secondRot = await createCaller(admin).production.rotateSigningSecret({ overlapMinutes: 60 });
    expect(secondRot.settings.signingEnabled).toBe(true);
    expect(secondRot.settings.previousSigningSecretActive).toBe(true);

    const { orderPublicId } = seedOrder({ currentStageKey: "phase_1_intake" });
    const p101Queued = await createCaller(staff).production.order.requestP101({ orderPublicId });
    expect(p101Queued.state).toBe("queued");

    // Staff stops queued production dispatch -> state = stopped, job canceled
    const stoppedDispatch = await createCaller(staff).production.order.stop({
      orderPublicId,
      dispatchPublicId: p101Queued.publicId,
      reason: "Hold while verifying packet tier",
    });
    expect(stoppedDispatch.state).toBe("stopped");
    expect(stoppedDispatch.stoppedByPublicId).toBe(staff.userPublicId);
    expect(
      h.audit.events.some(
        (e) => e.eventName === "integration.production.dispatch.stopped" && e.orderPublicId === orderPublicId,
      ),
    ).toBe(true);

    // Stopped dispatch is eligible for retry along the same intent chain
    const retriedDispatch = await createCaller(staff).production.order.retry({
      orderPublicId,
      dispatchPublicId: stoppedDispatch.publicId,
    });
    expect(retriedDispatch.state).toBe("queued");
    expect(retriedDispatch.retryOf).toBe(stoppedDispatch.publicId);
    expect(retriedDispatch.resendReason).toBe("OPERATOR_RETRY_AFTER_STOP");

    // Deliver the retried dispatch and verify dual overlap HMAC signature on wire
    const prodHandler = h.jobs.handlers.get(PRODUCTION_DELIVERY_JOB)!;
    const retryJob = h.jobs.enqueued.find(
      (j) =>
        j.type === PRODUCTION_DELIVERY_JOB &&
        (j.payload as { dispatchId: string }).dispatchId === retriedDispatch.publicId,
    )!;
    await prodHandler({
      jobId: retryJob.jobId,
      type: PRODUCTION_DELIVERY_JOB,
      attempt: 1,
      fencingToken: 1,
      correlationId: retriedDispatch.correlationId,
      payload: retryJob.payload as never,
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });

    expect(httpCalls).toHaveLength(1);
    const sigHeader = httpCalls[0]!.headers?.["X-ReadyPackets-Signature"];
    expect(sigHeader).toBeDefined();
    const tsMatch = /^t=(\d+),v1=([0-9a-f]{64}),v1=([0-9a-f]{64})$/.exec(sigHeader!);
    expect(tsMatch).not.toBeNull();
    const expectedDual = signWebhookPayload(
      Buffer.from(httpCalls[0]!.body, "utf8"),
      Number(tsMatch![1]),
      secondRot.signingSecretOnce,
      firstRot.signingSecretOnce,
    );
    expect(sigHeader).toBe(expectedDual);

    // Stopping a delivered dispatch is refused
    await expect(
      createCaller(staff).production.order.stop({
        orderPublicId,
        dispatchPublicId: retriedDispatch.publicId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);

    // Outbound webhook subscription: stop -> eligible retry (same delivery record, manualRetryCount=1, no Replay header) -> redeliver (distinct new record with X-ReadyPackets-Replay: 1)
    const createdSub = await mod.webhooks.createSubscription(admin, {
      name: "Ops Webhook",
      targetUrl: SUB_URL,
      events: ["order.created"],
      signingEnabled: true,
    });
    const subEnq = await tdb.db.transaction((tx) =>
      mod.webhooks.enqueueWorkflowSubscription(
        {
          subscriptionPublicId: createdSub.subscription.publicId,
          orderPublicId,
          stageKey: "phase_1_intake",
          triggerSource: "automation_rule",
          idempotencyKey: `auto-rule:${orderPublicId}:1`,
          actor: null,
          actorPublicId: null,
          eventKey: "order.stage.entered",
          payload: { stage: "phase_1_intake" },
        },
        tx,
      ),
    );
    expect(subEnq.outcome).toBe("queued");
    const deliveryId = subEnq.deliveryPublicId!;

    const stoppedSub = await createCaller(admin).admin.webhooks.deliveries.stop({
      publicId: deliveryId,
      reason: "Pause partner maintenance",
    });
    expect(stoppedSub.status).toBe("stopped");
    expect(stoppedSub.canStop).toBe(false);
    expect(stoppedSub.canRetry).toBe(true);

    // Retry re-queues the SAME delivery record (manualRetryCount = 1, zero X-ReadyPackets-Replay header)
    const retriedSub = await createCaller(admin).admin.webhooks.deliveries.retry({ publicId: deliveryId });
    expect(retriedSub.publicId).toBe(deliveryId);
    expect(retriedSub.status).toBe("queued");
    expect(retriedSub.manualRetryCount).toBe(1);

    httpCalls = [];
    const webhookHandler = h.jobs.handlers.get(WEBHOOK_DELIVER_JOB)!;
    const subRetryJob = h.jobs.enqueued.find(
      (j) =>
        j.type === WEBHOOK_DELIVER_JOB &&
        (j.payload as { deliveryPublicId: string }).deliveryPublicId === deliveryId,
    )!;
    await webhookHandler({
      jobId: subRetryJob.jobId,
      type: WEBHOOK_DELIVER_JOB,
      attempt: 1,
      fencingToken: 1,
      correlationId: "corr-sub-retry",
      payload: subRetryJob.payload as never,
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]!.headers?.["X-ReadyPackets-Replay"]).toBeUndefined();
    expect(httpCalls[0]!.headers?.["X-ReadyPackets-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    // Once delivered, Retry is refused and Redeliver creates a distinct replay delivery with X-ReadyPackets-Replay: 1
    await expect(
      createCaller(admin).admin.webhooks.deliveries.retry({ publicId: deliveryId }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);

    const replayedSub = await createCaller(admin).admin.webhooks.deliveries.redeliver({ publicId: deliveryId });
    expect(replayedSub.publicId).not.toBe(deliveryId);
    expect(replayedSub.replayOfPublicId).toBe(deliveryId);

    // Simulate dead-letter to verify opsAlerts emission
    const subEnqDead = await tdb.db.transaction((tx) =>
      mod.webhooks.enqueueWorkflowSubscription(
        {
          subscriptionPublicId: createdSub.subscription.publicId,
          orderPublicId,
          stageKey: "phase_1_intake",
          triggerSource: "automation_rule",
          idempotencyKey: `auto-rule:${orderPublicId}:dead`,
          actor: null,
          actorPublicId: null,
          eventKey: "order.stage.entered",
          payload: { stage: "phase_1_intake" },
        },
        tx,
      ),
    );
    nextHttpHandler = async () => ({
      status: 500,
      headers: {},
      body: Buffer.from("upstream error", "utf8"),
    });
    const deadJob = h.jobs.enqueued.find(
      (j) =>
        j.type === WEBHOOK_DELIVER_JOB &&
        (j.payload as { deliveryPublicId: string }).deliveryPublicId === subEnqDead.deliveryPublicId,
    )!;
    await tdb.db
      .update(integrationWebhookDeliveries)
      .set({ maxAttempts: 1 })
      .where(eq(integrationWebhookDeliveries.publicId, subEnqDead.deliveryPublicId!));
    const deadOutcome = await webhookHandler({
      jobId: deadJob.jobId,
      type: WEBHOOK_DELIVER_JOB,
      attempt: 1,
      fencingToken: 1,
      correlationId: "corr-dead",
      payload: deadJob.payload as never,
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });
    expect(deadOutcome).toMatchObject({
      outcome: "failed",
      reasonCode: "HTTP_500",
      retryable: false,
    });
    expect(emittedAlerts.some((a) => a.source === "webhook" && a.orderPublicId === orderPublicId)).toBe(true);
  });

  it("honours Graph Retry-After, evicts cached token on 401, verifies Sites.Selected write non-destructively, and exposes Entra runbook", async () => {
    const admin = makeStepUpAdmin(h);
    const adminNoStepUp = makeAdminNoStepUp(h);
    const staff = makeStaff(h);

    // Enable both Microsoft Graph egress presets via visible preset switch procedure
    await createCaller(admin).admin.egress.setPreset({ presetKey: "microsoft_graph", enabled: true });
    await createCaller(admin).admin.egress.setPreset({ presetKey: "microsoft_graph_upload", enabled: true });

    await h.deps.settings.set("jobs.mail.sender", {
      fromAddress: "noreply@readypackets.example.test",
      fromName: "ReadyPackets Portal",
      replyToAddress: "",
    });

    await mod.graphAdmin.updateConfig(admin, {
      enabled: true,
      tenantId: TENANT_GUID,
      clientId: CLIENT_GUID,
      clientSecret: GRAPH_SECRET,
      senderMailbox: "noreply@readypackets.example.test",
      enableEgressPreset: true,
    });

    // Step-up & role authz on verifySitesSelectedWrite
    await expect(
      createCaller(staff).admin.graph.verifySitesSelectedWrite({ siteUrlOrId: "https://contoso.sharepoint.com/sites/Packets" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
    await expect(
      createCaller(adminNoStepUp).admin.graph.verifySitesSelectedWrite({ siteUrlOrId: "https://contoso.sharepoint.com/sites/Packets" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);

    let tokenFetches = 0;
    let firstGraphCall401 = true;
    nextHttpHandler = async ({ url, method }): Promise<EgressFetchResponse> => {
      if (url.hostname === "login.microsoftonline.com") {
        tokenFetches += 1;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({ token_type: "Bearer", expires_in: 3600, access_token: `tok-${tokenFetches}` }),
            "utf8",
          ),
        };
      }
      if (url.pathname === "/v1.0/throttled") {
        return {
          status: 429,
          headers: { "retry-after": "42", "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ error: { code: "activityLimitReached" } }), "utf8"),
        };
      }
      if (url.pathname === "/v1.0/unauthorized-once") {
        if (firstGraphCall401) {
          firstGraphCall401 = false;
          return {
            status: 401,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify({ error: { code: "InvalidAuthenticationToken" } }), "utf8"),
          };
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ ok: true }), "utf8"),
        };
      }
      if (url.pathname.startsWith("/v1.0/sites/") && !url.pathname.endsWith("/drive")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ id: "contoso.sharepoint.com,site1,web1" }), "utf8"),
        };
      }
      if (url.pathname.endsWith("/drive")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ id: "b!drive12345" }), "utf8"),
        };
      }
      if (url.pathname.includes("/createUploadSession")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({
              uploadUrl: "https://contoso.sharepoint.com/sites/Packets/_api/v2.0/drive/uploadSession?secret=1",
            }),
            "utf8",
          ),
        };
      }
      if (url.hostname === "contoso.sharepoint.com" && method === "DELETE") {
        return {
          status: 204,
          headers: {},
          body: Buffer.alloc(0),
        };
      }
      return { status: 404, headers: {}, body: Buffer.from("{}", "utf8") };
    };

    // 1) Retry-After parsed onto GraphApiError.retryAfterSeconds
    let caught429: unknown;
    try {
      await mod.graph.request({ method: "GET", path: "/throttled" });
    } catch (err) {
      caught429 = err;
    }
    expect(caught429).toBeInstanceOf(GraphApiError);
    expect((caught429 as GraphApiError).retryAfterSeconds).toBe(42);
    expect(tokenFetches).toBe(1);

    // 2) HTTP 401 evicts cached token so subsequent request re-fetches OAuth token
    await expect(mod.graph.request({ method: "GET", path: "/unauthorized-once" })).rejects.toBeInstanceOf(
      GraphApiError,
    );
    const recovered = await mod.graph.request<{ ok: boolean }>({ method: "GET", path: "/unauthorized-once" });
    expect(recovered.json().ok).toBe(true);
    expect(tokenFetches).toBe(2);

    // 3) Sites.Selected non-destructive write check (createUploadSession + immediate DELETE)
    httpCalls = [];
    const checkResult = await createCaller(admin).admin.graph.verifySitesSelectedWrite({
      siteUrlOrId: "https://contoso.sharepoint.com/sites/Packets",
    });
    expect(checkResult).toMatchObject({
      outcome: "succeeded",
      reasonCode: "GRAPH_SITES_SELECTED_WRITE_VERIFIED",
      graphEgressEnabled: true,
      uploadEgressEnabled: true,
      tokenAcquired: true,
      readVerified: true,
      writeVerified: true,
    });
    expect(httpCalls.some((c) => c.method === "DELETE" && new URL(c.url).hostname === "contoso.sharepoint.com")).toBe(true);
    // DELETE to SharePoint uploadUrl MUST NOT leak Authorization header
    const deleteCall = httpCalls.find((c) => c.method === "DELETE")!;
    expect(deleteCall.headers?.Authorization).toBeUndefined();

    // Live SharePoint provider card reflects verified readiness with scaffoldOnly: false
    const sharepointStatus = await mod.providers.getStatus("sharepoint");
    expect(sharepointStatus.scaffoldOnly).toBe(false);
    expect(sharepointStatus.verified).toBe(true);
    expect(sharepointStatus.state).toBe("configured");

    // 4) Entra least-privilege runbook
    const runbook = await createCaller(admin).admin.graph.entraRunbook();
    expect(runbook.requiredApplicationPermission).toBe("Sites.Selected");
    expect(runbook.discouragedBroadPermissions).toContain("Sites.ReadWrite.All");
    expect(runbook.powershellExample).toContain("New-MgSitePermission");
  });
});
