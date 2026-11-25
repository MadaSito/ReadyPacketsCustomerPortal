/**
 * Production Webhooks (P101 & P201) — server integration, security, queue & concurrency tests.
 *
 * Covers:
 *  - Default-disabled settings, FieldCrypto secret storage, URL masking, canonVersion/runMode/header validation
 *  - Dry-run `settings.test`: zero HTTP requests, zero `normalizedUrl` projection, mandatory `webhook` allowlist
 *    rule + public-only DNS enforcement (even when `allowPrivateAddress: true`), single-evaluation DNS pinning
 *  - Role-based authorization (`orders.production.trigger`, admin + step-up `resend`, customer denial,
 *    staff PII masking vs admin full preview, in-tx session revocation rollback)
 *  - P101 -> P201 state machine: non-packet/empty-packet refusal with durable `dispatch.refused` audit,
 *    P201 gate on `phase1ArtifactsConfirmed` + delivered P101, verbatim `{ customer_id, order_id, run_mode }`
 *    copy from delivered P101 even after upstream mutations, `payload_enc` wipe on terminal states
 *  - Queue semantics (`integrations.production.deliver`, `retrySafe: false`): stable `Idempotency-Key` across
 *    retries, 5xx/429 retry -> `dead` at attempt 5, 4xx/3xx immediate `failed`, preexisting `sending` refusal
 *  - Single-connection pool (`connectionLimit: 1`) non-deadlock verification (`tx` passed everywhere)
 */
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, forbidden } from "../../../core/errors.js";
import { newRequestContext, runWithRequestContext } from "../../../core/requestContext.js";
import type { Db, SessionPrincipal, Tx } from "../../../core/types.js";
import type { UserView } from "../../identity/index.js";
import type { OrderAccessView, OrderLockState, OrderProductionScope } from "../../orders/types.js";
import { createConfigTransfer } from "../../platform/configTransfer.js";
import { platformSettings } from "../../platform/schema.js";
import { createSettingsStore } from "../../platform/settingsStore.js";
import { createAuditEmitter } from "../../audit/emitter.js";
import { createAuditModule } from "../../audit/index.js";
import { createJobsModule, type OutboxJobDisposition } from "../../jobs/index.js";
import { createJobQueue } from "../../jobs/queue.js";
import { jobRuns } from "../../jobs/schema.js";
import { STEP_UP_MAX_AGE_MS } from "../../../trpc/trpc.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../../tests/helpers/testDb.js";
import {
  createIntegrationsModule,
  PRODUCTION_DELIVERY_JOB,
  PRODUCTION_DISPATCH_MAX_TTL_MS,
  PRODUCTION_MAX_ATTEMPTS,
  PRODUCTION_RECONCILE_JOB,
  PRODUCTION_SENDING_GRACE_MS,
  PRODUCTION_STALE_QUEUED_MS,
  type EgressFetchResponse,
  type IntegrationsModule,
  type PinnedEgressTarget,
} from "../index.js";
import { integrationsRouter } from "../router.js";
import {
  integrationProductionDispatches,
} from "../schema.js";
import {
  INTEGRATIONS_PRODUCTION_AUTH_VALUE,
  INTEGRATIONS_PRODUCTION_P101_URL,
} from "../settings.js";

const P101_TEST_URL = "https://hooks.production.example.test/webhooks/p101-secret-9876";
const P201_TEST_URL = "https://hooks.production.example.test/webhooks/p201-secret-4321";
const P301_TEST_URL = "https://hooks.production.example.test/webhooks/p301-secret-3301";
const P401_TEST_URL = "https://hooks.production.example.test/webhooks/p401-secret-4401";

function makeStepUpAdmin(h: TestHarness, overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
  const now = h.clock.now();
  return fakePrincipal({
    userId: 1,
    userPublicId: "01JPRODADMIN00000000000001",
    role: "admin",
    state: "full",
    pendingSteps: [],
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: now,
    ...overrides,
  });
}

function makeStaff(h: TestHarness, overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
  const now = h.clock.now();
  return fakePrincipal({
    userId: 2,
    userPublicId: "01JPRODSTAFF00000000000002",
    role: "staff",
    state: "full",
    pendingSteps: [],
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: null,
    ...overrides,
  });
}

function makeCustomer(h: TestHarness): SessionPrincipal {
  const now = h.clock.now();
  return fakePrincipal({
    userId: 10,
    userPublicId: "01JPRODCUST000000000000010",
    role: "customer",
    state: "full",
    pendingSteps: [],
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: null,
  });
}

describe("integrations.production — settings, strict egress, P101/P201 outbox, authz & concurrency", () => {
  let tdb: TestDb;
  let h: TestHarness;
  let mod: IntegrationsModule;

  const mockOrders = new Map<
    string,
    {
      access: OrderAccessView;
      scope: OrderProductionScope;
    }
  >();
  const mockUsers = new Map<number, UserView>();

  let dnsCalls: string[] = [];
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
    await tdb.cleanup();
  });

  function seedOrderAndCustomer(opts?: {
    orderId?: number;
    orderPublicId?: string;
    reference?: string;
    statusKey?: string;
    lockState?: OrderLockState;
    packets?: OrderProductionScope["packets"];
    otherItemCount?: number;
    customerRef?: string | null;
    clientName?: string;
    clientEmail?: string;
  }) {
    const orderId = opts?.orderId ?? 101;
    const orderPublicId = opts?.orderPublicId ?? "01JORDER000000000000000101";
    const reference = opts?.reference ?? "ORD-2026-0101";
    const ownerUserId = 500 + orderId;
    const lockState: OrderLockState = opts?.lockState ?? "review";

    mockUsers.set(ownerUserId, {
      id: ownerUserId,
      publicId: `01JUSER0000000000000000${String(orderId).padStart(3, "0")}`,
      email: opts?.clientEmail ?? "jane.doe@client.example.test",
      name: opts?.clientName ?? "Jane Doe",
      role: "customer",
      status: "active",
      customerRef: opts?.customerRef === undefined ? "RP-7H9K2M4" : opts.customerRef,
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
        statusKey: opts?.statusKey ?? "in_production",
        lockState,
        locked: lockState !== "none",
        readOnlyImported: lockState === "imported_read_only",
        accessRole: "staff",
        canWrite: true,
        origin: "portal",
        version: 1,
        workflowVersionId: 1,
      },
      scope: {
        orderId,
        orderPublicId,
        reference,
        ownerUserId,
        statusKey: opts?.statusKey ?? "in_production",
        lockState,
        origin: "portal",
        packets: opts?.packets ?? [
          { packetNumber: 1, tier: "Standard" },
          { packetNumber: 4, tier: "Premium" },
        ],
        otherItemCount: opts?.otherItemCount ?? 0,
      },
    });

    return { orderId, orderPublicId, ownerUserId, reference };
  }

  function wireMockServices(targetHarness: TestHarness, dbHandle: Db) {
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
        if (principal.role === "customer") {
          throw forbidden("STAFF_ONLY");
        }
        const entry = mockOrders.get(orderPublicId);
        if (!entry) {
          throw new DomainError("NOT_FOUND", "ORDER_NOT_FOUND", "Order not found.");
        }
        return {
          ...entry.access,
          accessRole: principal.role === "admin" ? "admin" : "staff",
        };
      }),
      getProductionScope: vi.fn(async (orderId: number) => {
        for (const entry of mockOrders.values()) {
          if (entry.scope.orderId === orderId) return entry.scope;
        }
        return null;
      }),
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
    } as never;
  }

  beforeEach(async () => {
    const conn = await tdb.pool.getConnection();
    try {
      await conn.query("DELETE FROM integration_production_dispatches");
      await conn.query("DELETE FROM integration_egress_allowlist");
      await conn.query("DELETE FROM integration_provider_checks");
      await conn.query("DELETE FROM integration_webhook_events");
      await conn.query("DELETE FROM platform_settings");
      await conn.query("DELETE FROM job_attempts");
      await conn.query("DELETE FROM job_runs");
      await conn.query("DELETE FROM job_maintenance");
      await conn.query("DELETE FROM audit_chain");
      await conn.query("DELETE FROM audit_chain_head");
      await conn.query("DELETE FROM audit_events");
    } finally {
      conn.release();
    }

    mockOrders.clear();
    mockUsers.clear();
    dnsCalls = [];
    dnsAnswers = {
      "hooks.production.example.test": [{ address: "93.184.216.34", family: 4 }],
    };
    httpCalls = [];
    nextHttpHandler = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"status":"accepted","workflow":"P101_OK"}', "utf8"),
    });

    h = createTestDeps();
    wireMockServices(h, tdb.db);

    mod = createIntegrationsModule(h.deps, {
      egress: {
        dnsLookup: async (hostname) => {
          dnsCalls.push(hostname);
          return dnsAnswers[hostname] ?? [];
        },
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
          return nextHttpHandler({ pinned, url, headers: options.headers, body: nonStreamBody });
        },
      },
    });
    h.services.integrations = mod;
  });

  function createCaller(session: SessionPrincipal | null) {
    return integrationsRouter.createCaller({
      services: h.services,
      session,
      request: newRequestContext("test"),
      transport: { issue() {}, clear() {} },
    });
  }

  async function configureEnabledProduction(admin: SessionPrincipal) {
    await mod.egress.createAllowlistRule(admin, {
      purpose: "webhook",
      matchType: "host",
      pattern: "hooks.production.example.test",
      port: 443,
      protocol: "https:",
      allowPrivateAddress: false,
      enabled: true,
      justification: "Allowlisted ReadyPackets P101/P201 n8n receiver",
    });
    return mod.production.updateSettings(admin, {
      enabled: true,
      p101Url: P101_TEST_URL,
      p201Url: P201_TEST_URL,
      authHeaderName: "X-Webhook-Token",
      authHeaderValue: "wh_live_super_secret_token_value",
      canonVersion: "v3.0",
      runMode: "production",
      timeoutMs: 12_000,
    });
  }

  it("ships disabled with no default canonVersion, encrypts secrets via FieldCrypto, masks URLs, and excludes secrets from audit", async () => {
    const admin = makeStepUpAdmin(h);
    const caller = createCaller(admin);

    const initial = await caller.production.settings.get();
    expect(initial).toMatchObject({
      enabled: false,
      configured: false,
      state: "disabled",
      p101UrlConfigured: false,
      p101UrlMask: null,
      p201UrlConfigured: false,
      p201UrlMask: null,
      authHeaderName: "",
      authHeaderValueConfigured: false,
      canonVersion: "",
      runMode: "production",
      timeoutMs: 10_000,
    });

    // Cannot enable without canonVersion or without both HTTPS URLs
    await expect(
      caller.production.settings.update({
        enabled: true,
        p101Url: P101_TEST_URL,
        p201Url: P201_TEST_URL,
        canonVersion: "",
      }),
    ).rejects.toThrow(TRPCError);

    await expect(
      caller.production.settings.update({
        enabled: true,
        p101Url: "http://hooks.production.example.test/plain",
        p201Url: P201_TEST_URL,
        canonVersion: "v3.0",
      }),
    ).rejects.toThrow(TRPCError);

    // Reserved headers (Host, Idempotency-Key) are refused as custom auth header names
    await expect(
      caller.production.settings.update({
        enabled: false,
        authHeaderName: "Idempotency-Key",
        canonVersion: "v3.0",
      }),
    ).rejects.toThrow(TRPCError);

    const saved = await configureEnabledProduction(admin);
    expect(saved).toMatchObject({
      enabled: true,
      configured: true,
      state: "configured",
      p101UrlConfigured: true,
      p101UrlMask: { host: "hooks.production.example.test", last4: "9876" },
      p201UrlConfigured: true,
      p201UrlMask: { host: "hooks.production.example.test", last4: "4321" },
      authHeaderName: "X-Webhook-Token",
      authHeaderValueConfigured: true,
      canonVersion: "v3.0",
      runMode: "production",
      timeoutMs: 12_000,
    });
    expect(JSON.stringify(saved)).not.toContain("p101-secret");
    expect(JSON.stringify(saved)).not.toContain("wh_live_super_secret_token_value");

    // Verify encrypted at rest in platform_settings
    const rows = await tdb.db.select().from(platformSettings);
    const serializedDb = JSON.stringify(rows);
    expect(serializedDb).not.toContain(P101_TEST_URL);
    expect(serializedDb).not.toContain(P201_TEST_URL);
    expect(serializedDb).not.toContain("wh_live_super_secret_token_value");

    // Verify audit never carries URLs, auth header secret, OR auth_header_name (PW-07)
    const settingsAudit = h.audit.events.find(
      (e) => e.eventName === "integration.production.settings.changed",
    );
    expect(settingsAudit).toBeDefined();
    expect(settingsAudit?.attributes).toMatchObject({
      auth_header_configured: true,
      auth_header_value_configured: true,
    });
    expect("auth_header_name" in (settingsAudit?.attributes ?? {})).toBe(false);
    expect(JSON.stringify(settingsAudit)).not.toContain("X-Webhook-Token");
    expect(JSON.stringify(settingsAudit)).not.toContain("p101-secret");
    expect(JSON.stringify(settingsAudit)).not.toContain("wh_live_super_secret_token_value");
  });

  it("enforces dry-run settings.test with zero HTTP calls, zero normalizedUrl leakage, mandatory allowlist rule, and public-only DNS", async () => {
    const admin = makeStepUpAdmin(h);
    const caller = createCaller(admin);

    await caller.production.settings.update({
      enabled: false,
      p101Url: P101_TEST_URL,
      p201Url: P201_TEST_URL,
      canonVersion: "v3.0",
    });

    // 1. Public DNS WITHOUT an enabled webhook allowlist rule -> refused!
    const withoutRule = await caller.production.settings.test({ phase: "P101" });
    expect(withoutRule.allowed).toBe(false);
    expect(withoutRule.reasonCode).toBe("EGRESS_ALLOWLIST_REQUIRED");
    expect(httpCalls).toHaveLength(0);
    expect("normalizedUrl" in withoutRule).toBe(false);
    expect(JSON.stringify(withoutRule)).not.toContain("p101-secret-9876");

    // 2. Add allowlist rule with allowPrivateAddress: true, but point DNS at RFC1918 private IP -> STILL refused!
    const rule = await mod.egress.createAllowlistRule(admin, {
      purpose: "webhook",
      matchType: "host",
      pattern: "hooks.production.example.test",
      port: 443,
      protocol: "https:",
      allowPrivateAddress: true,
      enabled: true,
      justification: "Testing public-only production webhook enforcement",
    });

    dnsAnswers["hooks.production.example.test"] = [{ address: "10.20.30.40", family: 4 }];
    const privateRefused = await caller.production.settings.test({ phase: "P101" });
    expect(privateRefused.allowed).toBe(false);
    expect(privateRefused.reasonCode).toBe("EGRESS_NON_PUBLIC_ADDRESS_BLOCKED");
    expect(httpCalls).toHaveLength(0);

    // 3. Mixed public + private DNS answer -> refused!
    dnsAnswers["hooks.production.example.test"] = [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.10", family: 4 },
    ];
    const mixedRefused = await caller.production.settings.test({ phase: "P101" });
    expect(mixedRefused.allowed).toBe(false);
    expect(mixedRefused.reasonCode).toBe("EGRESS_NON_PUBLIC_ADDRESS_BLOCKED");

    // 4. Cloud metadata IP -> refused!
    dnsAnswers["hooks.production.example.test"] = [{ address: "169.254.169.254", family: 4 }];
    const metadataRefused = await caller.production.settings.test({ phase: "P101" });
    expect(metadataRefused.allowed).toBe(false);
    expect(metadataRefused.reasonCode).toBe("EGRESS_METADATA_BLOCKED");

    // 5. Public-only DNS + enabled webhook allowlist rule -> allowed dry-run with zero HTTP calls & zero URL path leakage!
    dnsAnswers["hooks.production.example.test"] = [{ address: "93.184.216.34", family: 4 }];
    const allowed = await caller.production.settings.test({ phase: "P101" });
    expect(allowed).toMatchObject({
      phase: "P101",
      allowed: true,
      reasonCode: "DRY_RUN_ALLOWED",
      host: "hooks.production.example.test",
      resolvedAddresses: ["93.184.216.34"],
      matchedAllowlistRulePublicId: rule.publicId,
    });
    expect(httpCalls).toHaveLength(0);
    expect("normalizedUrl" in allowed).toBe(false);
    expect(JSON.stringify(allowed)).not.toContain("p101-secret-9876");
  });

  it("enforces role capabilities, masks client PII for staff previews, and reveals full payload to admin", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    const customer = makeCustomer(h);
    await configureEnabledProduction(admin);
    const { orderPublicId } = seedOrderAndCustomer({
      clientName: "Alice Rivera",
      clientEmail: "alice.rivera@acme.example.test",
    });

    // Customer denied across all production endpoints
    const customerCaller = createCaller(customer);
    await expect(customerCaller.production.order.preview({ orderPublicId })).rejects.toThrow(TRPCError);
    await expect(customerCaller.production.order.requestP101({ orderPublicId })).rejects.toThrow(TRPCError);
    await expect(customerCaller.production.order.history({ orderPublicId })).rejects.toThrow(TRPCError);
    await expect(customerCaller.production.settings.get()).rejects.toThrow(TRPCError);

    // Staff sees masked client_name and client_email, and omitted releaseStatus defaults to "" (PW-08)
    const staffCaller = createCaller(staff);
    const staffPreview = await staffCaller.production.order.preview({ orderPublicId });
    expect(staffPreview.p101.eligible).toBe(true);
    expect(staffPreview.p101.maskedForViewer).toBe(true);
    expect(staffPreview.p101.payload?.client_name).toBe("A*** R***");
    expect(staffPreview.p101.payload?.client_email).toBe("a***@acme.example.test");
    expect(staffPreview.p101.payload?.packet).toBe("7");
    expect(staffPreview.p101.payload?.tier).toBe("Mixed");
    expect(staffPreview.p101.payload?.release_status).toBe("");

    // Admin sees unmasked client_name and client_email
    const adminCaller = createCaller(admin);
    const adminPreview = await adminCaller.production.order.preview({ orderPublicId });
    expect(adminPreview.p101.maskedForViewer).toBe(false);
    expect(adminPreview.p101.payload?.client_name).toBe("Alice Rivera");
    expect(adminPreview.p101.payload?.client_email).toBe("alice.rivera@acme.example.test");
  });

  it("executes P101 -> P201 end-to-end with single-DNS-eval pinning, encrypted retry payload cleared on delivery, and verbatim P201 identity reuse", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(admin);

    // Verify delivery job handler was registered with retrySafe: false
    expect(h.jobs.handlerOptions.get(PRODUCTION_DELIVERY_JOB)).toEqual({ retrySafe: false });

    const { orderPublicId, ownerUserId } = seedOrderAndCustomer({
      reference: "ORD-2026-0777",
      customerRef: "RP-9A8B7C6",
      clientName: "Morgan Sterling",
      clientEmail: "morgan@sterling.example.test",
      packets: [
        { packetNumber: 2, tier: "Basic" },
        { packetNumber: 6, tier: "Premium" },
      ],
    });

    const staffCaller = createCaller(staff);

    // P201 before P101 is delivered -> refused + durable audit!
    await expect(
      staffCaller.production.order.requestP201({
        orderPublicId,
        phase1ArtifactsConfirmed: true,
      }),
    ).rejects.toThrow(TRPCError);
    expect(
      h.audit.events.some(
        (e) =>
          e.eventName === "integration.production.dispatch.refused" &&
          e.reasonCode === "PRODUCTION_P101_NOT_DELIVERED",
      ),
    ).toBe(true);

    // Request P101 as staff inside a correlated request context
    const reqCtx = newRequestContext("test");
    reqCtx.correlationId = "corr_p101_run_01";
    const queuedP101 = await runWithRequestContext(reqCtx, () =>
      staffCaller.production.order.requestP101({ orderPublicId, releaseStatus: "released" }),
    );
    expect(queuedP101.phase).toBe("P101");
    expect(queuedP101.state).toBe("queued");
    expect(queuedP101.packet).toBe("7");
    expect(queuedP101.tier).toBe("Mixed");
    expect(queuedP101.bundleScopeManifest).toBe('{"packet_2":"Basic","packet_6":"Premium"}');
    expect(queuedP101.identityTriple).toEqual({
      customerId: "RP-9A8B7C6",
      orderId: "ORD-2026-0777",
      runMode: "production",
    });

    // While queued, payload_enc is encrypted (no raw client PII in DB column)
    const [queuedDbRow] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, queuedP101.publicId));
    expect(queuedDbRow?.payloadEnc).toBeTruthy();
    expect(queuedDbRow?.payloadEnc).not.toContain("Morgan Sterling");
    expect(queuedDbRow?.payloadEnc).not.toContain("morgan@sterling.example.test");

    // Reset DNS counter and run the delivery job -> must perform ONLY ONE DNS lookup (no preflight + re-resolve!)
    dnsCalls = [];
    nextHttpHandler = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true,"receiver_secret":"REMOTE_ECHO_SECRET_999","ssn":"000-11-2222"}', "utf8"),
    });

    const jobResults = await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(jobResults).toEqual([{ outcome: "completed" }]);
    expect(dnsCalls).toEqual(["hooks.production.example.test"]);
    expect(httpCalls).toHaveLength(1);

    const p101Http = httpCalls[0]!;
    expect(p101Http.pinned.address).toBe("93.184.216.34");
    expect(p101Http.pinned.allowlistRulePublicId).toBeTruthy();
    expect(p101Http.headers).toMatchObject({
      "Content-Type": "application/json",
      "Idempotency-Key": queuedP101.idempotencyKey,
      "X-ReadyPackets-Delivery": queuedP101.publicId,
      "X-Correlation-Id": "corr_p101_run_01",
      "X-Webhook-Token": "wh_live_super_secret_token_value",
    });

    const sentP101Json = JSON.parse(p101Http.body) as Record<string, unknown>;
    expect(sentP101Json).toEqual({
      customer_id: "RP-9A8B7C6",
      order_id: "ORD-2026-0777",
      packet: "7",
      tier: "Mixed",
      canon_version: "v3.0",
      run_mode: "production",
      client_name: "Morgan Sterling",
      client_email: "morgan@sterling.example.test",
      release_status: "released",
      bundle_scope_manifest: '{"packet_2":"Basic","packet_6":"Premium"}',
    });
    expect("order_scope_mode" in sentP101Json).toBe(false);

    // PW-01: After delivery, payload_enc MUST be cleared (NULL) and responseSummary MUST be fixed local status ONLY!
    const [deliveredDbRow] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, queuedP101.publicId));
    expect(deliveredDbRow?.state).toBe("delivered");
    expect(deliveredDbRow?.payloadEnc).toBeNull();
    expect(deliveredDbRow?.responseSummary).toBe("HTTP 200 — Accepted by production pipeline.");
    expect(JSON.stringify(deliveredDbRow)).not.toContain("REMOTE_ECHO_SECRET_999");
    expect(JSON.stringify(deliveredDbRow)).not.toContain("000-11-2222");

    // Duplicate P101 request is refused
    await expect(staffCaller.production.order.requestP101({ orderPublicId })).rejects.toThrow(TRPCError);

    // P201 without phase1ArtifactsConfirmed === true -> refused + audited!
    await expect(
      staffCaller.production.order.requestP201({
        orderPublicId,
        phase1ArtifactsConfirmed: false,
      }),
    ).rejects.toThrow(TRPCError);

    // Mutate upstream customerRef, order reference, and settings runMode AFTER P101 delivered —
    // P201 MUST copy the exact triple from the delivered P101 row, NEVER recomputing!
    mockUsers.get(ownerUserId)!.customerRef = "RP-CHANGED9";
    mockOrders.get(orderPublicId)!.scope.reference = "ORD-CHANGED-9999";
    await mod.production.updateSettings(admin, {
      enabled: true,
      canonVersion: "v3.0",
      runMode: "staging_override",
    });

    const queuedP201 = await staffCaller.production.order.requestP201({
      orderPublicId,
      phase1ArtifactsConfirmed: true,
    });
    expect(queuedP201.identityTriple).toEqual({
      customerId: "RP-9A8B7C6",
      orderId: "ORD-2026-0777",
      runMode: "production",
    });

    const p201Results = await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(p201Results).toEqual([{ outcome: "completed" }]);
    expect(httpCalls).toHaveLength(2);
    expect(JSON.parse(httpCalls[1]!.body)).toEqual({
      customer_id: "RP-9A8B7C6",
      order_id: "ORD-2026-0777",
      run_mode: "production",
    });

    // Verify audit trail carries safe attributes ONLY (no URLs, auth tokens, client_name, or client_email)
    const serializedAudits = JSON.stringify(h.audit.events);
    expect(serializedAudits).not.toContain("Morgan Sterling");
    expect(serializedAudits).not.toContain("morgan@sterling.example.test");
    expect(serializedAudits).not.toContain("p101-secret");
    expect(serializedAudits).not.toContain("p201-secret");
    expect(serializedAudits).not.toContain("wh_live_super_secret_token_value");
  });

  it("refuses orders with non-packet items or zero packets and records durable dispatch.refused audits", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(admin);

    const mixedCatalog = seedOrderAndCustomer({
      orderId: 202,
      orderPublicId: "01JORDER000000000000000202",
      packets: [{ packetNumber: 1, tier: "Basic" }],
      otherItemCount: 1,
    });
    const emptyOrder = seedOrderAndCustomer({
      orderId: 203,
      orderPublicId: "01JORDER000000000000000203",
      packets: [],
      otherItemCount: 0,
    });

    const staffCaller = createCaller(staff);
    await expect(
      staffCaller.production.order.requestP101({ orderPublicId: mixedCatalog.orderPublicId }),
    ).rejects.toThrow(TRPCError);
    await expect(
      staffCaller.production.order.requestP101({ orderPublicId: emptyOrder.orderPublicId }),
    ).rejects.toThrow(TRPCError);

    const refusedCodes = h.audit.events
      .filter((e) => e.eventName === "integration.production.dispatch.refused")
      .map((e) => e.reasonCode);
    expect(refusedCodes).toContain("ORDER_HAS_NON_PACKET_ITEMS");
    expect(refusedCodes).toContain("ORDER_HAS_NO_PACKETS");
  });

  it("handles 5xx retries with stable Idempotency-Key up to dead-letter at attempt 5, refuses preexisting sending, and enforces admin+step-up resend", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(admin);

    const { orderPublicId } = seedOrderAndCustomer({
      orderId: 301,
      orderPublicId: "01JORDER000000000000000301",
      packets: [{ packetNumber: 3, tier: "Standard" }],
    });

    const staffCaller = createCaller(staff);
    const dispatch = await staffCaller.production.order.requestP101({ orderPublicId });

    const handler = h.jobs.handlers.get(PRODUCTION_DELIVERY_JOB)!;
    const enqueuedJobId = h.jobs.enqueued[0]!.jobId;
    h.jobs.enqueued = []; // manually drive attempts 1..5 to test exact attempt progression

    nextHttpHandler = async () => ({
      status: 503,
      headers: {},
      body: Buffer.from("upstream worker overloaded", "utf8"),
    });

    for (let attempt = 1; attempt < PRODUCTION_MAX_ATTEMPTS; attempt += 1) {
      const res = await handler({
        jobId: enqueuedJobId,
        type: PRODUCTION_DELIVERY_JOB,
        payload: { dispatchId: dispatch.publicId } as never,
        attempt,
        fencingToken: attempt,
        correlationId: "corr_retry_test",
        signal: new AbortController().signal,
        assertStillOwned: async () => {},
      });
      expect(res).toEqual({
        outcome: "failed",
        reasonCode: "PRODUCTION_HTTP_5XX",
        retryable: true,
      });

      // Row returned to `queued` with `payloadEnc` still present for next retry
      const [midRow] = await tdb.db
        .select()
        .from(integrationProductionDispatches)
        .where(eq(integrationProductionDispatches.publicId, dispatch.publicId));
      expect(midRow?.state).toBe("queued");
      expect(midRow?.payloadEnc).toBeTruthy();
    }

    // Attempt 5 exhausts retries -> transitions to `dead`, clears `payloadEnc`, returns `retryable: false`!
    const finalRes = await handler({
      jobId: enqueuedJobId,
      type: PRODUCTION_DELIVERY_JOB,
      payload: { dispatchId: dispatch.publicId } as never,
      attempt: PRODUCTION_MAX_ATTEMPTS,
      fencingToken: PRODUCTION_MAX_ATTEMPTS,
      correlationId: "corr_retry_test",
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });
    expect(finalRes).toEqual({
      outcome: "failed",
      reasonCode: "PRODUCTION_HTTP_5XX",
      retryable: false,
    });

    // Every HTTP attempt sent the exact same Idempotency-Key
    expect(httpCalls).toHaveLength(PRODUCTION_MAX_ATTEMPTS);
    const idempotencyKeys = new Set(httpCalls.map((c) => c.headers?.["Idempotency-Key"]));
    expect(idempotencyKeys.size).toBe(1);
    expect(idempotencyKeys.has(dispatch.idempotencyKey)).toBe(true);

    const [deadRow] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dispatch.publicId));
    expect(deadRow?.state).toBe("dead");
    expect(deadRow?.payloadEnc).toBeNull();
    expect(h.audit.events.some((e) => e.eventName === "integration.production.dispatch.dead")).toBe(true);

    // Staff cannot resend; admin without step-up cannot resend; admin with step-up + reason CAN resend!
    await expect(
      staffCaller.production.order.resend({
        orderPublicId,
        phase: "P101",
        reason: "Downstream recovered after maintenance",
      }),
    ).rejects.toThrow(TRPCError);

    const nonStepUpAdmin = makeStepUpAdmin(h, { stepUpAt: null });
    await expect(
      createCaller(nonStepUpAdmin).production.order.resend({
        orderPublicId,
        phase: "P101",
        reason: "Downstream recovered after maintenance",
      }),
    ).rejects.toThrow(TRPCError);

    nextHttpHandler = async () => ({
      status: 200,
      headers: {},
      body: Buffer.from('{"ok":true}', "utf8"),
    });
    const resent = await createCaller(admin).production.order.resend({
      orderPublicId,
      phase: "P101",
      reason: "Downstream recovered after maintenance — contact jane.secret@example.test",
    });
    expect(resent.publicId).not.toBe(dispatch.publicId);
    // PW-07: Only controlled code is stored/projected/audited; raw operator prose is NEVER stored!
    expect(resent.resendReason).toBe("OPERATOR_RETRY_AFTER_DEAD_LETTER");
    expect(JSON.stringify(resent)).not.toContain("jane.secret@example.test");
    expect(JSON.stringify(h.audit.events)).not.toContain("jane.secret@example.test");
    expect(h.audit.events.some((e) => e.eventName === "integration.production.dispatch.resent")).toBe(true);

    // Simulate a crashed worker leaving `sending` in DB -> handler MUST NOT auto-replay (`outcome: "unknown"`)
    // AND MUST immediately scrub `payloadEnc` + mark terminal `unknown` so resend is never blocked forever (PW-02)!
    const resentJobId = h.jobs.enqueued[0]!.jobId;
    await tdb.db
      .update(integrationProductionDispatches)
      .set({ state: "sending" })
      .where(eq(integrationProductionDispatches.publicId, resent.publicId));
    const beforeCalls = httpCalls.length;
    const ambiguousRes = await handler({
      jobId: resentJobId,
      type: PRODUCTION_DELIVERY_JOB,
      payload: { dispatchId: resent.publicId } as never,
      attempt: 2,
      fencingToken: 99,
      correlationId: "corr_ambiguous",
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });
    expect(ambiguousRes).toEqual({
      outcome: "unknown",
      reasonCode: "PRODUCTION_AMBIGUOUS_IN_FLIGHT",
    });
    expect(httpCalls).toHaveLength(beforeCalls);

    const [scrubbedAmbiguous] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, resent.publicId));
    expect(scrubbedAmbiguous?.state).toBe("unknown");
    expect(scrubbedAmbiguous?.payloadEnc).toBeNull();
    expect(scrubbedAmbiguous?.lastReasonCode).toBe("PRODUCTION_AMBIGUOUS_IN_FLIGHT");
  });

  it("aborts mutations when session is revoked in-tx and never deadlocks on a 1-connection pool", async () => {
    // 1. Single-connection pool (`connectionLimit: 1`) verification
    const singlePool = mysql.createPool({
      uri: tdb.url,
      connectionLimit: 1,
      timezone: "Z",
      supportBigNumbers: true,
      charset: "utf8mb4",
    });
    const singleDb = drizzle(singlePool, { mode: "default" }) as unknown as Db;

    try {
      const singleHarness = createTestDeps();
      wireMockServices(singleHarness, singleDb);
      const singleMod = createIntegrationsModule(singleHarness.deps, {
        egress: {
          dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
          httpsRequester: async () => ({
            status: 200,
            headers: {},
            body: Buffer.from('{"ok":true}', "utf8"),
          }),
        },
      });
      singleHarness.services.integrations = singleMod;

      const admin = makeStepUpAdmin(singleHarness);
      const staff = makeStaff(singleHarness);
      const { orderPublicId } = seedOrderAndCustomer({
        orderId: 401,
        orderPublicId: "01JORDER000000000000000401",
        packets: [{ packetNumber: 5, tier: "Premium" }],
      });

      await singleMod.egress.createAllowlistRule(admin, {
        purpose: "webhook",
        matchType: "host",
        pattern: "hooks.production.example.test",
        port: 443,
        protocol: "https:",
        allowPrivateAddress: false,
        enabled: true,
        justification: "Single-connection pool test allowlist rule",
      });
      await singleMod.production.updateSettings(admin, {
        enabled: true,
        p101Url: P101_TEST_URL,
        p201Url: P201_TEST_URL,
        canonVersion: "v3.0",
      });

      const preview = await singleMod.production.previewOrder(staff, { orderPublicId });
      expect(preview.p101.eligible).toBe(true);

      const p101 = await singleMod.production.requestP101(staff, { orderPublicId });
      expect(p101.state).toBe("queued");
      const [deliverP101] = await singleHarness.jobs.runAll(PRODUCTION_DELIVERY_JOB);
      expect(deliverP101).toEqual({ outcome: "completed" });

      const p201 = await singleMod.production.requestP201(staff, {
        orderPublicId,
        phase1ArtifactsConfirmed: true,
      });
      expect(p201.state).toBe("queued");
      const [deliverP201] = await singleHarness.jobs.runAll(PRODUCTION_DELIVERY_JOB);
      expect(deliverP201).toEqual({ outcome: "completed" });

      // 2. In-transaction actor session revocation rolls back cleanly
      vi.mocked(singleHarness.services.identity.sessions.assertCurrent).mockRejectedValueOnce(
        forbidden("SESSION_REVOKED"),
      );
      await expect(
        singleMod.production.resend(admin, {
          orderPublicId,
          phase: "P101",
          reason: "Should be aborted by revoked session",
        }),
      ).rejects.toThrow();

      const history = await singleMod.production.orderHistory(staff, { orderPublicId });
      expect(history.items).toHaveLength(2); // only P101 + P201, zero resend row committed!
    } finally {
      await singlePool.end();
    }
  });

  it("marks 3xx redirects and non-429 4xx responses immediately failed without retry, clears payload_enc, and supports admin.listDispatches filtering", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(admin);

    const o1 = seedOrderAndCustomer({
      orderId: 501,
      orderPublicId: "01JORDER000000000000000501",
      reference: "ORD-REDIR-501",
      packets: [{ packetNumber: 1, tier: "Basic" }],
    });
    const o2 = seedOrderAndCustomer({
      orderId: 502,
      orderPublicId: "01JORDER000000000000000502",
      reference: "ORD-422-502",
      packets: [{ packetNumber: 2, tier: "Standard" }],
    });

    const staffCaller = createCaller(staff);
    const adminCaller = createCaller(admin);

    // 1. 302 redirect -> immediate non-retryable `EGRESS_REDIRECT_REFUSED` + `payload_enc = NULL`
    const d1 = await staffCaller.production.order.requestP101({ orderPublicId: o1.orderPublicId });
    nextHttpHandler = async () => ({
      status: 302,
      headers: { location: "https://evil.example.test/steal" },
      body: Buffer.alloc(0),
    });
    const [r1] = await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(r1).toEqual({
      outcome: "failed",
      reasonCode: "EGRESS_REDIRECT_REFUSED",
      retryable: false,
    });
    const [row1] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, d1.publicId));
    expect(row1?.state).toBe("failed");
    expect(row1?.payloadEnc).toBeNull();

    // 2. 422 response -> immediate non-retryable `PRODUCTION_HTTP_4XX` + `payload_enc = NULL` + zero remote body stored (PW-01)
    const d2 = await staffCaller.production.order.requestP101({ orderPublicId: o2.orderPublicId });
    nextHttpHandler = async () => ({
      status: 422,
      headers: {},
      body: Buffer.from("invalid canon_version; debug_token=SECRET_422_TOKEN; client=alice@secret.test", "utf8"),
    });
    const [r2] = await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(r2).toEqual({
      outcome: "failed",
      reasonCode: "PRODUCTION_HTTP_4XX",
      retryable: false,
    });
    const [row2] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, d2.publicId));
    expect(row2?.state).toBe("failed");
    expect(row2?.payloadEnc).toBeNull();
    expect(row2?.httpStatus).toBe(422);
    expect(row2?.responseSummary).toBe("HTTP 422 — Rejected by production pipeline (client error; not retried).");
    expect(JSON.stringify(row2)).not.toContain("SECRET_422_TOKEN");
    expect(JSON.stringify(row2)).not.toContain("alice@secret.test");

    // 3. Admin dispatch log filters by orderReference prefix and state; staff is forbidden
    await expect(staffCaller.production.admin.listDispatches({})).rejects.toThrow(TRPCError);
    const filtered = await adminCaller.production.admin.listDispatches({
      phase: "P101",
      state: "failed",
      orderReference: "ORD-422-",
    });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]?.publicId).toBe(d2.publicId);
    expect(filtered.items[0]?.nextAttemptAt).toBeNull();
    expect(filtered.items[0]?.responseSummary).toBe(
      "HTTP 422 — Rejected by production pipeline (client error; not retried).",
    );

    // 4. Retryable 502 with scheduled job_runs row exposes `nextAttemptAt` and filters under `state: "retrying"` (not `"failed"` or `"queued"`)
    const o3 = seedOrderAndCustomer({
      orderId: 503,
      orderPublicId: "01JORDER000000000000000503",
      reference: "ORD-502-RETRY",
      packets: [{ packetNumber: 3, tier: "Premium" }],
    });
    const d3 = await staffCaller.production.order.requestP101({ orderPublicId: o3.orderPublicId });
    nextHttpHandler = async () => ({
      status: 502,
      headers: {},
      body: Buffer.from("upstream gateway timeout", "utf8"),
    });
    const [r3] = await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(r3).toEqual({
      outcome: "failed",
      reasonCode: "PRODUCTION_HTTP_5XX",
      retryable: true,
    });
    const [row3] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, d3.publicId));
    expect(row3?.state).toBe("queued");
    expect(row3?.attemptCount).toBe(1);

    const scheduledRetryAt = new Date(h.clock.now().getTime() + 60_000);
    await tdb.db.insert(jobRuns).values({
      publicId: row3!.jobPublicId,
      type: PRODUCTION_DELIVERY_JOB,
      state: "queued",
      correlationId: d3.correlationId,
      attempt: 1,
      maxAttempts: PRODUCTION_MAX_ATTEMPTS,
      runAt: scheduledRetryAt,
    });

    const retryingList = await adminCaller.production.admin.listDispatches({ state: "retrying" });
    expect(retryingList.items.map((item) => item.publicId)).toEqual([d3.publicId]);
    expect(retryingList.items[0]?.nextAttemptAt).toEqual(scheduledRetryAt);

    const history3 = await staffCaller.production.order.history({ orderPublicId: o3.orderPublicId });
    expect(history3.items[0]?.nextAttemptAt).toEqual(scheduledRetryAt);

    const queuedOnlyList = await adminCaller.production.admin.listDispatches({
      state: "queued",
      orderReference: "ORD-502-RETRY",
    });
    expect(queuedOnlyList.items).toHaveLength(0);

    const failedOnlyList = await adminCaller.production.admin.listDispatches({
      state: "failed",
      orderReference: "ORD-502-RETRY",
    });
    expect(failedOnlyList.items).toHaveLength(0);
  });

  it("reconciles interrupted sending and stalled queued dispatches on bounded timeouts, scrubs payload_enc, and unblocks resend without auto-replay (PW-02)", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(admin);

    // Verify background reconciliation schedule is registered
    expect(h.jobs.schedules.some((s) => s.type === PRODUCTION_RECONCILE_JOB && s.everyMs === 60_000)).toBe(true);

    // 1. Orphaned `sending` row where worker crashed mid-flight (`payloadEnc != null`, job vanished because `retrySafe: false`)
    const oSend = seedOrderAndCustomer({
      orderId: 601,
      orderPublicId: "01JORDER000000000000000601",
      reference: "ORD-STALE-SEND-601",
      packets: [{ packetNumber: 1, tier: "Standard" }],
    });
    const staffCaller = createCaller(staff);
    const dSend = await staffCaller.production.order.requestP101({ orderPublicId: oSend.orderPublicId });
    h.jobs.enqueued = []; // simulate reaped `retrySafe: false` worker job

    await tdb.db
      .update(integrationProductionDispatches)
      .set({ state: "sending", attemptCount: 1, updatedAt: h.clock.now() })
      .where(eq(integrationProductionDispatches.publicId, dSend.publicId));

    // Before timeout (`timeoutMs` = 12_000 + grace 30_000 = 42_000ms), resend is still refused as in-progress
    h.clock.advance(10_000);
    await expect(
      createCaller(makeStepUpAdmin(h)).production.order.resend({
        orderPublicId: oSend.orderPublicId,
        phase: "P101",
        reason: "Checking before timeout expires",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Advance past `timeoutMs + PRODUCTION_SENDING_GRACE_MS` and run background `PRODUCTION_RECONCILE_JOB`
    h.clock.advance(12_000 + PRODUCTION_SENDING_GRACE_MS + 1_000);
    const reconcileHandler = h.jobs.handlers.get(PRODUCTION_RECONCILE_JOB)!;
    const recRes = await reconcileHandler({
      jobId: "job_reconcile_1",
      type: PRODUCTION_RECONCILE_JOB,
      payload: {} as never,
      attempt: 1,
      fencingToken: 1,
      correlationId: "corr_reconcile_1",
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });
    expect(recRes).toEqual({ outcome: "completed" });
    expect(httpCalls).toHaveLength(0); // NEVER auto-replays HTTP!

    const [reconciledSend] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dSend.publicId));
    expect(reconciledSend?.state).toBe("unknown");
    expect(reconciledSend?.payloadEnc).toBeNull();
    expect(reconciledSend?.lastReasonCode).toBe("PRODUCTION_DELIVERY_INTERRUPTED");
    expect(
      h.audit.events.some(
        (e) =>
          e.eventName === "integration.production.dispatch.failed" &&
          e.outcome === "unknown" &&
          e.reasonCode === "PRODUCTION_DELIVERY_INTERRUPTED" &&
          e.attributes?.reconciled === true &&
          e.attributes?.delivery_uncertain === true,
      ),
    ).toBe(true);

    // Admin with fresh step-up can now resend — never permanently blocked!
    const freshAdmin = makeStepUpAdmin(h);
    const unblockedResend = await createCaller(freshAdmin).production.order.resend({
      orderPublicId: oSend.orderPublicId,
      phase: "P101",
      reason: "Confirmed downstream did not receive interrupted run",
    });
    expect(unblockedResend.state).toBe("queued");
    expect(unblockedResend.resendReason).toBe("OPERATOR_RETRY_AFTER_INTERRUPTION");

    // 2. Orphaned `queued` row past `PRODUCTION_STALE_QUEUED_MS` is also scrubbed on synchronous `resend` / `history`
    const oQueue = seedOrderAndCustomer({
      orderId: 602,
      orderPublicId: "01JORDER000000000000000602",
      reference: "ORD-STALE-QUEUE-602",
      packets: [{ packetNumber: 4, tier: "Premium" }],
    });
    const dQueue = await staffCaller.production.order.requestP101({ orderPublicId: oQueue.orderPublicId });
    h.jobs.enqueued = [];

    h.clock.advance(PRODUCTION_STALE_QUEUED_MS + 5_000);
    const histAfterStall = await staffCaller.production.order.history({ orderPublicId: oQueue.orderPublicId });
    expect(histAfterStall.items[0]?.state).toBe("failed");
    expect(histAfterStall.items[0]?.lastReasonCode).toBe("PRODUCTION_QUEUE_STALLED");

    const [reconciledQueue] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dQueue.publicId));
    expect(reconciledQueue?.payloadEnc).toBeNull();
  });

  it("pins dispatches to their authorized destination fingerprint and cancels queued/retried sends on URL or auth drift (PW-04)", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(admin);

    dnsAnswers["new-hooks.production.example.test"] = [{ address: "93.184.216.35", family: 4 }];
    await mod.egress.createAllowlistRule(admin, {
      purpose: "webhook",
      matchType: "host",
      pattern: "new-hooks.production.example.test",
      port: 443,
      protocol: "https:",
      allowPrivateAddress: false,
      justification: "Secondary production webhook receiver",
    });

    // 1. Changing P101 URL via `settings.update` after queueing cancels queued dispatch with DESTINATION_CHANGED
    const o1 = seedOrderAndCustomer({
      orderId: 701,
      orderPublicId: "01JORDER000000000000000701",
      reference: "ORD-DEST-URL-701",
      packets: [{ packetNumber: 2, tier: "Basic" }],
    });
    const staffCaller = createCaller(staff);
    const dUrl = await staffCaller.production.order.requestP101({ orderPublicId: o1.orderPublicId });

    await mod.production.updateSettings(admin, {
      enabled: true,
      p101Url: "https://new-hooks.production.example.test/webhooks/p101-rotated-0001",
      canonVersion: "v3.0",
      runMode: "production",
    });

    const [resUrl] = await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(resUrl).toEqual({
      outcome: "failed",
      reasonCode: "DESTINATION_CHANGED",
      retryable: false,
    });
    expect(httpCalls).toHaveLength(0); // ZERO HTTP calls to the new endpoint!

    const [rowUrl] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dUrl.publicId));
    expect(rowUrl?.state).toBe("failed");
    expect(rowUrl?.payloadEnc).toBeNull();
    expect(rowUrl?.lastReasonCode).toBe("DESTINATION_CHANGED");

    // 2. Direct secret mutation via generic `deps.settings.setSecret` (bypassing `integrations.production.settings.update`)
    // ALSO triggers DESTINATION_CHANGED before any network call!
    const o2 = seedOrderAndCustomer({
      orderId: 702,
      orderPublicId: "01JORDER000000000000000702",
      reference: "ORD-DEST-AUTH-702",
      packets: [{ packetNumber: 3, tier: "Standard" }],
    });
    const dAuth = await staffCaller.production.order.requestP101({ orderPublicId: o2.orderPublicId });

    await h.deps.settings.setSecret(INTEGRATIONS_PRODUCTION_AUTH_VALUE.key, "wh_rotated_via_platform_secret_store");

    const [resAuth] = await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(resAuth).toEqual({
      outcome: "failed",
      reasonCode: "DESTINATION_CHANGED",
      retryable: false,
    });
    expect(httpCalls).toHaveLength(0);

    const [rowAuth] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dAuth.publicId));
    expect(rowAuth?.state).toBe("failed");
    expect(rowAuth?.payloadEnc).toBeNull();
    expect(rowAuth?.lastReasonCode).toBe("DESTINATION_CHANGED");

    // Also verify `destinationFingerprint` is internal-only and never projected to API callers
    const history = await staffCaller.production.order.history({ orderPublicId: o2.orderPublicId });
    expect("destinationFingerprint" in (history.items[0] ?? {})).toBe(false);
  });

  it("revalidates order legal hold, owner reassignment, and cancellation in worker immediately before send and clears payload_enc (PW-03)", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(admin);
    const staffCaller = createCaller(staff);

    // 1. Legal hold applied after queueing -> `ORDER_LOCKED`, zero HTTP, `payload_enc = NULL`
    const oHold = seedOrderAndCustomer({
      orderId: 801,
      orderPublicId: "01JORDER000000000000000801",
      reference: "ORD-HOLD-801",
      packets: [{ packetNumber: 1, tier: "Basic" }],
    });
    const dHold = await staffCaller.production.order.requestP101({ orderPublicId: oHold.orderPublicId });
    mockOrders.get(oHold.orderPublicId)!.scope.lockState = "legal_hold";

    // 2. Order reassigned to a different customer after queueing -> `ORDER_OWNER_CHANGED`, zero HTTP, `payload_enc = NULL`
    const oReassign = seedOrderAndCustomer({
      orderId: 802,
      orderPublicId: "01JORDER000000000000000802",
      reference: "ORD-REASSIGN-802",
      packets: [{ packetNumber: 2, tier: "Standard" }],
    });
    const dReassign = await staffCaller.production.order.requestP101({ orderPublicId: oReassign.orderPublicId });
    mockUsers.set(9999, {
      ...mockUsers.get(oReassign.ownerUserId)!,
      id: 9999,
      publicId: "01JUSER0000000000000009999",
      email: "other.owner@client.example.test",
    });
    mockOrders.get(oReassign.orderPublicId)!.scope.ownerUserId = 9999;

    // 3. Order canceled after queueing -> `ORDER_CANCELED`, zero HTTP, `payload_enc = NULL`
    const oCancel = seedOrderAndCustomer({
      orderId: 803,
      orderPublicId: "01JORDER000000000000000803",
      reference: "ORD-CANCEL-803",
      packets: [{ packetNumber: 5, tier: "Premium" }],
    });
    const dCancel = await staffCaller.production.order.requestP101({ orderPublicId: oCancel.orderPublicId });
    mockOrders.get(oCancel.orderPublicId)!.scope.statusKey = "canceled";

    const results = await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(results).toEqual([
      { outcome: "failed", reasonCode: "ORDER_LOCKED", retryable: false },
      { outcome: "failed", reasonCode: "ORDER_OWNER_CHANGED", retryable: false },
      { outcome: "failed", reasonCode: "ORDER_CANCELED", retryable: false },
    ]);
    expect(httpCalls).toHaveLength(0);

    for (const [pubId, expectedCode] of [
      [dHold.publicId, "ORDER_LOCKED"],
      [dReassign.publicId, "ORDER_OWNER_CHANGED"],
      [dCancel.publicId, "ORDER_CANCELED"],
    ] as const) {
      const [row] = await tdb.db
        .select()
        .from(integrationProductionDispatches)
        .where(eq(integrationProductionDispatches.publicId, pubId));
      expect(row?.state).toBe("failed");
      expect(row?.payloadEnc).toBeNull();
      expect(row?.lastReasonCode).toBe(expectedCode);
    }
  });

  it("acquires order lock before identity lock, fails closed when identity is absent, and rechecks step-up freshness post-lock (PW-05 & PW-06)", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(admin);

    const { orderPublicId } = seedOrderAndCustomer({
      orderId: 901,
      orderPublicId: "01JORDER000000000000000901",
      reference: "ORD-LOCK-ORDER-901",
      packets: [{ packetNumber: 1, tier: "Basic" }],
    });

    // 1. Verify lock acquisition order: `orders.assertCanReadOrder(..., { forUpdate: true })` BEFORE `identity.sessions.assertCurrent`
    const lockEvents: string[] = [];
    vi.mocked(h.services.orders.assertCanReadOrder).mockImplementation(async (principal, pubId, opts) => {
      lockEvents.push(opts?.forUpdate ? "orders:forUpdate" : "orders:read");
      const entry = mockOrders.get(pubId);
      if (!entry) throw new DomainError("NOT_FOUND", "ORDER_NOT_FOUND", "Order not found.");
      return {
        ...entry.access,
        accessRole: principal.role === "admin" ? "admin" : "staff",
      };
    });
    vi.mocked(h.services.identity.sessions.assertCurrent).mockImplementation(async (principal) => {
      lockEvents.push("identity:assertCurrent");
      return {
        pendingSteps: [...principal.pendingSteps],
        role: principal.role,
        stepUpAt: principal.stepUpAt,
        mfaVerifiedAt: principal.mfaVerifiedAt,
      };
    });

    const d1 = await mod.production.requestP101(staff, { orderPublicId });
    expect(lockEvents).toEqual(["orders:forUpdate", "identity:assertCurrent"]);

    // Fail delivery so we can also test `resend` lock order and post-lock step-up expiry
    nextHttpHandler = async () => ({ status: 422, headers: {}, body: Buffer.from("bad", "utf8") });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(d1.phase).toBe("P101");

    // 2. Post-lock clock step-up expiry: preflight passes, lock wait advances clock past STEP_UP_MAX_AGE_MS -> STEP_UP_REQUIRED!
    lockEvents.length = 0;
    const stepUpAdmin = makeStepUpAdmin(h);
    vi.mocked(h.services.identity.sessions.assertCurrent).mockImplementationOnce(async (principal) => {
      lockEvents.push("identity:assertCurrent");
      h.clock.advance(STEP_UP_MAX_AGE_MS + 1_000);
      return {
        pendingSteps: [...principal.pendingSteps],
        role: principal.role,
        stepUpAt: principal.stepUpAt,
        mfaVerifiedAt: principal.mfaVerifiedAt,
      };
    });
    await expect(
      mod.production.resend(stepUpAdmin, {
        orderPublicId,
        phase: "P101",
        reason: "Testing post-lock step-up window",
      }),
    ).rejects.toMatchObject({ code: "STEP_UP_REQUIRED", reasonCode: "STEP_UP_REQUIRED" });
    expect(lockEvents).toEqual(["orders:forUpdate", "identity:assertCurrent"]);

    // 3. Fail-closed `ACTOR_UNVERIFIABLE` when `services.identity` is missing
    const savedIdentity = h.services.identity;
    (h.services as unknown as { identity: unknown }).identity = undefined;
    try {
      await expect(mod.production.requestP101(staff, { orderPublicId })).rejects.toMatchObject({
        code: "FORBIDDEN",
        reasonCode: "ACTOR_UNVERIFIABLE",
      });
    } finally {
      h.services.identity = savedIdentity;
    }
  });

  it("excludes production webhook URLs and auth header value from generic Platform settings exports and rejects forged imports (Decision #6)", async () => {
    const admin = makeStepUpAdmin(h);
    await configureEnabledProduction(admin);

    const platformStore = createSettingsStore({
      db: tdb.db,
      crypto: h.deps.crypto,
      clock: h.clock,
      audit: h.audit,
      logger: h.deps.logger,
    });
    const transfer = createConfigTransfer({
      db: tdb.db,
      clock: h.clock,
      audit: h.audit,
      settings: platformStore,
      installationId: "inst_test_01",
      releaseRef: "2026.11.20",
    });

    // Export WITH `includeSecrets: true` -> zero production webhook secrets may appear in counts or serialized document!
    const passphrase = "correct-horse-battery-staple-export-key";
    const exported = await transfer.exportDocument(
      { includeSecrets: true, passphrase },
      async () => {},
    );
    expect(exported.counts.secrets).toBe(0);
    expect(exported.document).not.toContain(P101_TEST_URL);
    expect(exported.document).not.toContain(P201_TEST_URL);
    expect(exported.document).not.toContain("wh_live_super_secret_token_value");
    expect(exported.document).not.toContain(INTEGRATIONS_PRODUCTION_P101_URL.key);
    expect(exported.document).not.toContain(INTEGRATIONS_PRODUCTION_AUTH_VALUE.key);
  });

  it("fences reconciliation via job ledger, filters stale candidates in SQL before LIMIT, protects live queued/sending jobs, preserves unknown outcome on prior attempts, and blocks stale finalize from overwriting reconciled/resent rows (PW-02)", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(admin);

    type LedgerEntry = {
      state: "queued" | "running" | "completed" | "failed" | "canceled" | "unknown";
      leaseUntilMs: number | null;
    };
    const jobLedger = new Map<string, LedgerEntry>();
    const origEnqueue = h.jobs.enqueue.bind(h.jobs);
    vi.spyOn(h.jobs, "enqueue").mockImplementation(async (type, payload, options) => {
      const res = await origEnqueue(type, payload, options);
      if (!jobLedger.has(res.jobId)) {
        jobLedger.set(res.jobId, { state: "queued", leaseUntilMs: null });
      }
      return res;
    });

    const reconcileSpy = vi.fn(
      async (
        jobPublicId: string,
        _tx: Tx,
        options?: { cancelQueued?: boolean },
      ): Promise<OutboxJobDisposition> => {
        const entry = jobLedger.get(jobPublicId);
        if (!entry) return { state: "missing" };
        if (entry.state === "running") {
          if (entry.leaseUntilMs !== null && entry.leaseUntilMs > h.clock.now().getTime()) {
            return { state: "running_live" };
          }
          entry.state = "unknown";
          entry.leaseUntilMs = null;
          return { state: "settled_unknown" };
        }
        if (entry.state === "queued") {
          if (!options?.cancelQueued) return { state: "queued_live" };
          entry.state = "canceled";
          return { state: "canceled_queued" };
        }
        return { state: "terminal", jobState: entry.state };
      },
    );
    h.services.jobAdmin = { reconcileOutboxJob: reconcileSpy } as never;

    const deliveryHandler = h.jobs.handlers.get(PRODUCTION_DELIVERY_JOB)!;
    const reconcileHandler = h.jobs.handlers.get(PRODUCTION_RECONCILE_JOB)!;
    const runReconcileTick = () =>
      reconcileHandler({
        jobId: "job_reconcile_tick",
        type: PRODUCTION_RECONCILE_JOB,
        payload: {} as never,
        attempt: 1,
        fencingToken: 1,
        correlationId: "corr_reconcile_tick",
        signal: new AbortController().signal,
        assertStillOwned: async () => {},
      });

    // ── Part A: Fake-clock live `queued` (`queued_live`) vs TTL expiry (`attemptCount === 0` vs `attemptCount > 0`) ──
    const oZero = seedOrderAndCustomer({
      orderId: 901,
      orderPublicId: "01JORDER000000000000000901",
      reference: "ORD-PW02-ZERO-901",
      packets: [{ packetNumber: 1, tier: "Standard" }],
    });
    const oAttempted = seedOrderAndCustomer({
      orderId: 902,
      orderPublicId: "01JORDER000000000000000902",
      reference: "ORD-PW02-ATTEMPTED-902",
      packets: [{ packetNumber: 2, tier: "Premium" }],
    });

    const staffCaller = createCaller(staff);
    const dZero = await staffCaller.production.order.requestP101({ orderPublicId: oZero.orderPublicId });
    const dAttempted = await staffCaller.production.order.requestP101({ orderPublicId: oAttempted.orderPublicId });
    const attemptedJobId = h.jobs.enqueued.find(
      (j) => (j.payload as { dispatchId?: string })?.dispatchId === dAttempted.publicId,
    )!.jobId;

    // Run attempt 1 on `dAttempted` returning HTTP 503 -> returns to `queued` with `attemptCount = 1`, retry still live in `jobLedger`
    nextHttpHandler = async () => ({
      status: 503,
      headers: {},
      body: Buffer.from("temporary 503", "utf8"),
    });
    const attempt1Res = await deliveryHandler({
      jobId: attemptedJobId,
      type: PRODUCTION_DELIVERY_JOB,
      payload: { dispatchId: dAttempted.publicId } as never,
      attempt: 1,
      fencingToken: 1,
      correlationId: "corr_attempt1_503",
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });
    expect(attempt1Res).toEqual({
      outcome: "failed",
      reasonCode: "PRODUCTION_HTTP_5XX",
      retryable: true,
    });

    // Advance FakeClock 2h 15m (well past `PRODUCTION_STALE_QUEUED_MS` = 15m, well before 24h `expiresAt`!)
    h.clock.advance(PRODUCTION_STALE_QUEUED_MS + 2 * 60 * 60_000);
    await runReconcileTick();

    // Healthy live `queued` dispatches MUST NOT be marked failed!
    const [liveZero] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dZero.publicId));
    const [liveAttempted] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dAttempted.publicId));
    expect(liveZero?.state).toBe("queued");
    expect(liveZero?.payloadEnc).toBeTruthy();
    expect(liveAttempted?.state).toBe("queued");
    expect(liveAttempted?.attemptCount).toBe(1);
    expect(liveAttempted?.payloadEnc).toBeTruthy();

    // Advance FakeClock past `PRODUCTION_DISPATCH_MAX_TTL_MS` (24h total) -> fenced `cancelQueued: true`!
    h.clock.advance(PRODUCTION_DISPATCH_MAX_TTL_MS);
    await runReconcileTick();

    const [expiredZero] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dZero.publicId));
    const [expiredAttempted] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dAttempted.publicId));

    // `attemptCount === 0` -> safely `failed` (`PRODUCTION_DELIVERY_EXPIRED`)
    expect(expiredZero?.state).toBe("failed");
    expect(expiredZero?.lastReasonCode).toBe("PRODUCTION_DELIVERY_EXPIRED");
    expect(expiredZero?.payloadEnc).toBeNull();

    // `attemptCount > 0` -> conservatively `unknown` (`PRODUCTION_PRIOR_ATTEMPT_UNCERTAIN`, `outcome: "unknown"`, `delivery_uncertain: true`)
    expect(expiredAttempted?.state).toBe("unknown");
    expect(expiredAttempted?.lastReasonCode).toBe("PRODUCTION_PRIOR_ATTEMPT_UNCERTAIN");
    expect(expiredAttempted?.payloadEnc).toBeNull();
    expect(
      h.audit.events.some(
        (e) =>
          e.eventName === "integration.production.dispatch.failed" &&
          e.outcome === "unknown" &&
          e.reasonCode === "PRODUCTION_PRIOR_ATTEMPT_UNCERTAIN" &&
          e.attributes?.delivery_uncertain === true,
      ),
    ).toBe(true);

    // ── Part B: SQL staleness predicate BEFORE `LIMIT` (zero starvation behind >200 fresh rows) ──
    const baseNow = h.clock.now();
    const freshBatch = Array.from({ length: 205 }, (_, idx) => {
      const n = idx + 1;
      const jobId = `job_fresh_${String(n).padStart(4, "0")}`;
      jobLedger.set(jobId, {
        state: n % 2 === 0 ? "queued" : "running",
        leaseUntilMs: n % 2 === 0 ? null : baseNow.getTime() + 120_000,
      });
      return {
        publicId: `01JFRESH00000000000000${String(n).padStart(4, "0")}`,
        orderId: 2000 + n,
        orderPublicId: `01JFRORD00000000000000${String(n).padStart(4, "0")}`,
        orderReference: `ORD-FRESH-${n}`,
        expectedOwnerUserId: 2500 + n,
        destinationFingerprint: "a".repeat(64),
        jobPublicId: jobId,
        activeFencingToken: n % 2 === 0 ? 0 : 1,
        expiresAt: new Date(baseNow.getTime() + PRODUCTION_DISPATCH_MAX_TTL_MS),
        phase: "P101" as const,
        state: n % 2 === 0 ? ("queued" as const) : ("sending" as const),
        attemptCount: n % 2 === 0 ? 0 : 1,
        idempotencyKey: `idem-fresh-${n}`,
        payloadSha256: "b".repeat(64),
        payloadEnc: "enc_fresh_payload",
        sentCustomerId: "RP-FRESH01",
        sentOrderId: `ORD-FRESH-${n}`,
        sentRunMode: "production",
        packet: "1",
        tier: "Standard",
        requestedByUserId: 2,
        correlationId: `corr_fresh_${n}`,
        version: 1,
        createdAt: baseNow,
        updatedAt: baseNow,
      };
    });
    await tdb.db.insert(integrationProductionDispatches).values(freshBatch);

    const staleSendJobId = "job_behind_stale_send";
    jobLedger.set(staleSendJobId, { state: "running", leaseUntilMs: baseNow.getTime() - 5_000 });
    const staleExpJobId = "job_behind_expired_queue";
    jobLedger.set(staleExpJobId, { state: "queued", leaseUntilMs: null });

    const staleBehindPubSend = "01JBEHINDSEND0000000000001";
    const staleBehindPubExp = "01JBEHINDEXP00000000000002";
    await tdb.db.insert(integrationProductionDispatches).values([
      {
        publicId: staleBehindPubSend,
        orderId: 2991,
        orderPublicId: "01JBEHINDORD00000000002991",
        orderReference: "ORD-BEHIND-SEND-2991",
        expectedOwnerUserId: 3491,
        destinationFingerprint: "a".repeat(64),
        jobPublicId: staleSendJobId,
        activeFencingToken: 3,
        expiresAt: new Date(baseNow.getTime() + PRODUCTION_DISPATCH_MAX_TTL_MS),
        phase: "P101",
        state: "sending",
        attemptCount: 1,
        idempotencyKey: "idem-behind-send-2991",
        payloadSha256: "b".repeat(64),
        payloadEnc: "enc_stale_behind_send",
        sentCustomerId: "RP-BEHIND1",
        sentOrderId: "ORD-BEHIND-SEND-2991",
        sentRunMode: "production",
        packet: "1",
        tier: "Standard",
        requestedByUserId: 2,
        correlationId: "corr_behind_send_2991",
        version: 2,
        createdAt: new Date(baseNow.getTime() - 120_000),
        updatedAt: new Date(baseNow.getTime() - 120_000),
      },
      {
        publicId: staleBehindPubExp,
        orderId: 2992,
        orderPublicId: "01JBEHINDORD00000000002992",
        orderReference: "ORD-BEHIND-EXP-2992",
        expectedOwnerUserId: 3492,
        destinationFingerprint: "a".repeat(64),
        jobPublicId: staleExpJobId,
        activeFencingToken: 0,
        expiresAt: new Date(baseNow.getTime() - 1_000),
        phase: "P101",
        state: "queued",
        attemptCount: 0,
        idempotencyKey: "idem-behind-exp-2992",
        payloadSha256: "b".repeat(64),
        payloadEnc: "enc_stale_behind_exp",
        sentCustomerId: "RP-BEHIND2",
        sentOrderId: "ORD-BEHIND-EXP-2992",
        sentRunMode: "production",
        packet: "1",
        tier: "Standard",
        requestedByUserId: 2,
        correlationId: "corr_behind_exp_2992",
        version: 1,
        createdAt: new Date(baseNow.getTime() - PRODUCTION_DISPATCH_MAX_TTL_MS - 1_000),
        updatedAt: baseNow, // fresh updatedAt, expired expiresAt -> caught by Pass 3!
      },
    ]);

    reconcileSpy.mockClear();
    await runReconcileTick();

    // SQL filtered out all 205 fresh rows BEFORE `LIMIT` -> `reconcileOutboxJob` was called ONLY for the 2 stale rows!
    expect(reconcileSpy).toHaveBeenCalledTimes(2);

    const [reconciledBehindSend] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, staleBehindPubSend));
    const [reconciledBehindExp] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, staleBehindPubExp));
    expect(reconciledBehindSend?.state).toBe("unknown");
    expect(reconciledBehindSend?.payloadEnc).toBeNull();
    expect(reconciledBehindExp?.state).toBe("failed");
    expect(reconciledBehindExp?.lastReasonCode).toBe("PRODUCTION_DELIVERY_EXPIRED");
    expect(reconciledBehindExp?.payloadEnc).toBeNull();

    // Clean up the 205 synthetic fresh rows before Part C
    for (const row of freshBatch) {
      jobLedger.delete(row.jobPublicId);
    }
    const conn = await tdb.pool.getConnection();
    try {
      await conn.query("DELETE FROM integration_production_dispatches WHERE order_id >= 2000 AND order_id <= 2300");
    } finally {
      conn.release();
    }

    // ── Part C: Active `sending` (`running_live`) untouched + Reaper-versus-Finalize race (503 & 200) + P201 blocked on `unknown` ──
    const oRace503 = seedOrderAndCustomer({
      orderId: 903,
      orderPublicId: "01JORDER000000000000000903",
      reference: "ORD-PW02-RACE503-903",
      packets: [{ packetNumber: 3, tier: "Standard" }],
    });
    const oRace200 = seedOrderAndCustomer({
      orderId: 904,
      orderPublicId: "01JORDER000000000000000904",
      reference: "ORD-PW02-RACE200-904",
      packets: [{ packetNumber: 4, tier: "Premium" }],
    });

    const dRace503 = await staffCaller.production.order.requestP101({ orderPublicId: oRace503.orderPublicId });
    const dRace200 = await staffCaller.production.order.requestP101({ orderPublicId: oRace200.orderPublicId });
    const job503Id = h.jobs.enqueued.find(
      (j) => (j.payload as { dispatchId?: string })?.dispatchId === dRace503.publicId,
    )!.jobId;
    const job200Id = h.jobs.enqueued.find(
      (j) => (j.payload as { dispatchId?: string })?.dispatchId === dRace200.publicId,
    )!.jobId;

    let entered503!: () => void;
    let release503!: (resp: EgressFetchResponse) => void;
    const entered503Promise = new Promise<void>((resolve) => {
      entered503 = resolve;
    });
    const gate503Promise = new Promise<EgressFetchResponse>((resolve) => {
      release503 = resolve;
    });

    let entered200!: () => void;
    let release200!: (resp: EgressFetchResponse) => void;
    const entered200Promise = new Promise<void>((resolve) => {
      entered200 = resolve;
    });
    const gate200Promise = new Promise<EgressFetchResponse>((resolve) => {
      release200 = resolve;
    });

    nextHttpHandler = async ({ headers }) => {
      if (headers?.["Idempotency-Key"] === dRace503.idempotencyKey) {
        entered503();
        return gate503Promise;
      }
      entered200();
      return gate200Promise;
    };

    // Both jobs hold a 120s worker lease
    const leaseStartMs = h.clock.now().getTime();
    jobLedger.set(job503Id, { state: "running", leaseUntilMs: leaseStartMs + 120_000 });
    jobLedger.set(job200Id, { state: "running", leaseUntilMs: leaseStartMs + 120_000 });

    const inFlight503 = deliveryHandler({
      jobId: job503Id,
      type: PRODUCTION_DELIVERY_JOB,
      payload: { dispatchId: dRace503.publicId } as never,
      attempt: 1,
      fencingToken: 7,
      correlationId: "corr_race_503",
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });
    const inFlight200 = deliveryHandler({
      jobId: job200Id,
      type: PRODUCTION_DELIVERY_JOB,
      payload: { dispatchId: dRace200.publicId } as never,
      attempt: 1,
      fencingToken: 8,
      correlationId: "corr_race_200",
      signal: new AbortController().signal,
      assertStillOwned: async () => {},
    });

    await Promise.all([entered503Promise, entered200Promise]);

    // Advance 47s (past `timeoutMs + PRODUCTION_SENDING_GRACE_MS` = 42s, while 120s worker lease is STILL LIVE!)
    h.clock.advance(12_000 + PRODUCTION_SENDING_GRACE_MS + 5_000);
    await runReconcileTick();

    const [stillLive503] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dRace503.publicId));
    expect(stillLive503?.state).toBe("sending");
    expect(stillLive503?.activeFencingToken).toBe(7);
    expect(stillLive503?.payloadEnc).toBeTruthy();

    // Advance another 90s so the 120s worker lease expires -> reaper settles both dispatches to `unknown`!
    h.clock.advance(90_000);
    await runReconcileTick();

    const [reaped503] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dRace503.publicId));
    const [reaped200] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dRace200.publicId));
    expect(reaped503?.state).toBe("unknown");
    expect(reaped503?.payloadEnc).toBeNull();
    expect(reaped503?.activeFencingToken).toBe(0);
    expect(reaped200?.state).toBe("unknown");
    expect(reaped200?.payloadEnc).toBeNull();

    // P201 remains strictly delivered-only when P101 is `unknown`!
    const previewUnknown = await staffCaller.production.order.preview({ orderPublicId: oRace503.orderPublicId });
    expect(previewUnknown.p201.eligible).toBe(false);
    await expect(
      staffCaller.production.order.requestP201({
        orderPublicId: oRace503.orderPublicId,
        phase1ArtifactsConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Operator queues a fresh resend on `oRace503` BEFORE stale worker `inFlight503` finishes!
    const stepUpAdminNow = makeStepUpAdmin(h);
    const dResentAfterReap = await createCaller(stepUpAdminNow).production.order.resend({
      orderPublicId: oRace503.orderPublicId,
      phase: "P101",
      reason: "Verified downstream pipeline has no record of interrupted run",
    });
    expect(dResentAfterReap.state).toBe("queued");
    expect(dResentAfterReap.resendReason).toBe("OPERATOR_RETRY_AFTER_INTERRUPTION");

    // Stale workers finally return HTTP 503 (retryable!) and HTTP 200 (delivered!)
    release503({
      status: 503,
      headers: {},
      body: Buffer.from("late 503 from wedged socket", "utf8"),
    });
    release200({
      status: 200,
      headers: {},
      body: Buffer.from('{"ok":true}', "utf8"),
    });

    const [res503, res200] = await Promise.all([inFlight503, inFlight200]);
    expect(res503).toEqual({
      outcome: "unknown",
      reasonCode: "PRODUCTION_FENCE_SUPERSEDED",
    });
    expect(res200).toEqual({
      outcome: "unknown",
      reasonCode: "PRODUCTION_FENCE_SUPERSEDED",
    });

    // Claim fence prevented stale workers from setting `queued` with `payloadEnc=null` OR flipping `unknown` to `delivered`!
    const [afterLate503] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dRace503.publicId));
    const [afterLate200] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dRace200.publicId));
    const [intactResend] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dResentAfterReap.publicId));

    expect(afterLate503?.state).toBe("unknown");
    expect(afterLate503?.payloadEnc).toBeNull();
    expect(afterLate200?.state).toBe("unknown");
    expect(afterLate200?.payloadEnc).toBeNull();
    expect(intactResend?.state).toBe("queued");
    expect(intactResend?.payloadEnc).toBeTruthy();

    // Also verify `admin.listDispatches` supports filtering by `"unknown"` state
    const unknownList = await createCaller(stepUpAdminNow).production.admin.listDispatches({ state: "unknown" });
    const unknownIds = new Set(unknownList.items.map((item) => item.publicId));
    expect(unknownIds.has(dRace503.publicId)).toBe(true);
    expect(unknownIds.has(dRace200.publicId)).toBe(true);
  });

  it("integrates with real JobsModule.reconcileOutboxJob and rolls back job cancellation if dispatch state moves before lock (PW-02)", async () => {
    const realHarness = createTestDeps();
    wireMockServices(realHarness, tdb.db);
    realHarness.deps.audit = createAuditEmitter(realHarness.deps);
    realHarness.deps.settings = createSettingsStore({
      db: tdb.db,
      crypto: realHarness.deps.crypto,
      clock: realHarness.clock,
      audit: realHarness.deps.audit,
      logger: realHarness.deps.logger,
    });
    const realAuditCenter = createAuditModule(realHarness.deps);
    realHarness.deps.jobs = createJobQueue(realHarness.deps);
    const realJobAdmin = createJobsModule(realHarness.deps);
    realHarness.services.jobAdmin = realJobAdmin;

    const realMod = createIntegrationsModule(realHarness.deps, {
      egress: {
        dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        httpsRequester: async () => ({
          status: 200,
          headers: {},
          body: Buffer.from('{"ok":true}', "utf8"),
        }),
      },
    });
    realHarness.services.integrations = realMod;

    const admin = makeStepUpAdmin(realHarness);
    const staff = makeStaff(realHarness);
    const realCaller = (session: SessionPrincipal | null) =>
      integrationsRouter.createCaller({
        request: newRequestContext("test"),
        session,
        services: realHarness.services,
        transport: { issue: () => {}, clear: () => {} },
      });

    await realMod.egress.createAllowlistRule(admin, {
      purpose: "webhook",
      matchType: "host",
      pattern: "hooks.production.example.test",
      port: 443,
      protocol: "https:",
      allowPrivateAddress: false,
      enabled: true,
      justification: "Real JobsModule outbox reconciliation test",
    });
    await realMod.production.updateSettings(admin, {
      enabled: true,
      p101Url: P101_TEST_URL,
      p201Url: P201_TEST_URL,
      canonVersion: "v3.0",
    });

    const oMoved = seedOrderAndCustomer({
      orderId: 951,
      orderPublicId: "01JORDER000000000000000951",
      reference: "ORD-REAL-MOVED-951",
      packets: [{ packetNumber: 1, tier: "Standard" }],
    });
    const dMoved = await runWithRequestContext(newRequestContext("test"), () =>
      realCaller(staff).production.order.requestP101({ orderPublicId: oMoved.orderPublicId }),
    );

    const [createdRow] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dMoved.publicId));
    expect(createdRow?.jobPublicId).toBeTruthy();

    // Advance past `PRODUCTION_STALE_QUEUED_MS` -> real `reconcileOutboxJob` reports `queued_live`, dispatch stays `queued`
    realHarness.clock.advance(PRODUCTION_STALE_QUEUED_MS + 60_000);
    const histLive = await realCaller(staff).production.order.history({ orderPublicId: oMoved.orderPublicId });
    expect(histLive.items[0]?.state).toBe("queued");

    // Advance past `PRODUCTION_DISPATCH_MAX_TTL_MS` AND simulate concurrent delivery changing dispatch `state`/`version`
    // right before `reconcileSingleCandidate` locks the dispatch row -> outer `tx` MUST roll back `cancelQueued`!
    realHarness.clock.advance(PRODUCTION_DISPATCH_MAX_TTL_MS + 1_000);
    const origReconcile = realJobAdmin.reconcileOutboxJob.bind(realJobAdmin);
    let injectedConcurrentMove = false;
    realHarness.services.jobAdmin = {
      ...realJobAdmin,
      reconcileOutboxJob: async (jobPublicId, tx, options) => {
        const res = await origReconcile(jobPublicId, tx, options);
        if (!injectedConcurrentMove && jobPublicId === createdRow!.jobPublicId) {
          injectedConcurrentMove = true;
          // Separate pool connection commits `delivered` before `reconcileSingleCandidate` locks dispatch
          await tdb.db
            .update(integrationProductionDispatches)
            .set({
              state: "delivered",
              payloadEnc: null,
              version: createdRow!.version + 1,
              deliveredAt: realHarness.clock.now(),
              updatedAt: realHarness.clock.now(),
            })
            .where(eq(integrationProductionDispatches.publicId, dMoved.publicId));
        }
        return res;
      },
    };

    const histAfterRace = await realCaller(staff).production.order.history({ orderPublicId: oMoved.orderPublicId });
    expect(injectedConcurrentMove).toBe(true);
    expect(histAfterRace.items[0]?.state).toBe("delivered");

    // Outer `tx` rollback undid `cancelQueued` inside `job_runs` AND `audit_events` -> job is STILL `queued_live` and zero `job.canceled` committed!
    const postRollbackDisposition = await tdb.db.transaction((tx) =>
      origReconcile(createdRow!.jobPublicId, tx),
    );
    expect(postRollbackDisposition).toEqual({ state: "queued_live" });
    await realAuditCenter.sealPending();
    const auditAfterRollback = await realAuditCenter.readEventsAfter(null, 100);
    expect(auditAfterRollback.events.filter((e) => e.event_name === "job.canceled")).toHaveLength(0);

    // Restore unwrapped `realJobAdmin`, enqueue a second dispatch, advance past TTL, and verify clean fenced cancellation
    realHarness.services.jobAdmin = realJobAdmin;
    const oExpire = seedOrderAndCustomer({
      orderId: 952,
      orderPublicId: "01JORDER000000000000000952",
      reference: "ORD-REAL-EXPIRE-952",
      packets: [{ packetNumber: 2, tier: "Premium" }],
    });
    const dExpire = await runWithRequestContext(newRequestContext("test"), () =>
      realCaller(staff).production.order.requestP101({ orderPublicId: oExpire.orderPublicId }),
    );
    const [expireCreated] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, dExpire.publicId));

    realHarness.clock.advance(PRODUCTION_DISPATCH_MAX_TTL_MS + 1_000);
    const histExpired = await realCaller(staff).production.order.history({ orderPublicId: oExpire.orderPublicId });
    expect(histExpired.items[0]?.state).toBe("failed");
    expect(histExpired.items[0]?.lastReasonCode).toBe("PRODUCTION_DELIVERY_EXPIRED");

    const postExpireDisposition = await tdb.db.transaction((tx) =>
      origReconcile(expireCreated!.jobPublicId, tx),
    );
    expect(postExpireDisposition).toEqual({ state: "terminal", jobState: "canceled" });
    await realAuditCenter.sealPending();
    const auditAfterExpire = await realAuditCenter.readEventsAfter(null, 100);
    expect(
      auditAfterExpire.events.some(
        (e) => e.event_name === "job.canceled" && e.job_id === expireCreated!.jobPublicId,
      ),
    ).toBe(true);
    expect(
      auditAfterExpire.events.some(
        (e) =>
          e.event_name === "integration.production.dispatch.failed" &&
          e.reason_code === "PRODUCTION_DELIVERY_EXPIRED",
      ),
    ).toBe(true);
  });

  it("Part B: supports optional P301/P401 endpoints, preview disabledReasons + settingsHref, verbatim identity parity, destination pinning, and pre-send order revalidation", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    const adminCaller = createCaller(admin);
    const staffCaller = createCaller(staff);

    const { orderPublicId, ownerUserId } = seedOrderAndCustomer({
      orderId: 960,
      orderPublicId: "01JORDER000000000000000960",
      reference: "ORD-2026-0960",
      customerRef: "RPCUS-960ABCDEF",
      packets: [{ packetNumber: 3, tier: "Premium" }],
    });

    // 1. Pipeline disabled -> disabledReasons reports pipeline_off + endpoint_missing + settingsHref
    const offPreview = await staffCaller.production.order.preview({ orderPublicId });
    expect(offPreview.settingsHref).toBe("/admin/integrations/production");
    expect(offPreview.p301.configured).toBe(false);
    expect(offPreview.p401.configured).toBe(false);
    expect(offPreview.p101.disabledReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PIPELINE_DISABLED",
          category: "pipeline_off",
          settingsActionable: true,
        }),
      ]),
    );
    expect(offPreview.p301.disabledReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "P301_ENDPOINT_NOT_CONFIGURED",
          category: "endpoint_missing",
          settingsActionable: true,
        }),
      ]),
    );

    // 2. Enable P101 + P201 ONLY (P301/P401 unconfigured) -> requestP301 & requestP401 refused with NOT_CONFIGURED
    await configureEnabledProduction(admin);
    await expect(staffCaller.production.order.requestP301({ orderPublicId })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      cause: expect.objectContaining({
        code: "NOT_CONFIGURED",
        reasonCode: "PRODUCTION_PHASE_ENDPOINT_NOT_CONFIGURED",
      }),
    });
    await expect(staffCaller.production.order.requestP401({ orderPublicId })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      cause: expect.objectContaining({
        code: "NOT_CONFIGURED",
        reasonCode: "PRODUCTION_PHASE_ENDPOINT_NOT_CONFIGURED",
      }),
    });
    expect(
      h.audit.events.some(
        (e) =>
          e.eventName === "integration.production.dispatch.refused" &&
          e.reasonCode === "PRODUCTION_PHASE_ENDPOINT_NOT_CONFIGURED" &&
          e.orderPublicId === orderPublicId,
      ),
    ).toBe(true);

    // 3. Configure P401 WITHOUT P301 -> verify masking, export exclusion, and direct P201 -> P401 gate
    const withP401Only = await adminCaller.production.settings.update({
      enabled: true,
      canonVersion: "v3.0",
      runMode: "production",
      p401Url: P401_TEST_URL,
    });
    expect(withP401Only.p301UrlConfigured).toBe(false);
    expect(withP401Only.p301UrlMask).toBeNull();
    expect(withP401Only.p401UrlConfigured).toBe(true);
    expect(withP401Only.p401UrlMask).toEqual({
      host: "hooks.production.example.test",
      last4: "4401",
    });

    const platformStore = createSettingsStore({
      db: tdb.db,
      crypto: h.deps.crypto,
      clock: h.clock,
      audit: h.audit,
      logger: h.deps.logger,
    });
    const transfer = createConfigTransfer({
      db: tdb.db,
      clock: h.clock,
      audit: h.audit,
      settings: platformStore,
      installationId: "inst_test_part_b",
      releaseRef: "2026.11.21",
    });
    const exportedBundle = await transfer.exportDocument(
      { includeSecrets: true, passphrase: "correct-horse-battery-staple-export-key" },
      async () => {},
    );
    expect(exportedBundle.document).not.toContain("p401-secret-4401");

    const preRunPreview = await staffCaller.production.order.preview({ orderPublicId });
    expect(preRunPreview.p401.configured).toBe(true);
    expect(preRunPreview.p401.eligible).toBe(false);
    expect(preRunPreview.p401.disabledReasons.map((r) => r.code)).toContain("P101_NOT_DELIVERED");

    // Deliver P101 first -> P401 now reports P201_NOT_DELIVERED (and NOT P301_NOT_DELIVERED since P301 is unconfigured)
    await staffCaller.production.order.requestP101({ orderPublicId });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    const afterP101Preview = await staffCaller.production.order.preview({ orderPublicId });
    expect(afterP101Preview.p401.disabledReasons.map((r) => r.code)).toEqual(["P201_NOT_DELIVERED"]);

    // Deliver P201, mutate upstream identifiers, then dispatch P401
    await staffCaller.production.order.requestP201({ orderPublicId, phase1ArtifactsConfirmed: true });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    mockUsers.get(ownerUserId)!.customerRef = "RPCUS-MUTATED99";
    mockOrders.get(orderPublicId)!.scope.reference = "ORD-MUTATED-9999";
    await adminCaller.production.settings.update({
      enabled: true,
      canonVersion: "v3.0",
      runMode: "staging",
    });

    const readyP401Preview = await staffCaller.production.order.preview({ orderPublicId });
    expect(readyP401Preview.p401.eligible).toBe(true);
    expect(readyP401Preview.p401.disabledReasons).toEqual([]);

    const queuedP401 = await staffCaller.production.order.requestP401({ orderPublicId });
    expect(queuedP401.phase).toBe("P401");
    expect(queuedP401.idempotencyKey).toBe(`rp-prod:p401:${queuedP401.publicId}`);
    expect(queuedP401.identityTriple).toEqual({
      customerId: "RPCUS-960ABCDEF",
      orderId: "ORD-2026-0960",
      runMode: "production",
    });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(httpCalls).toHaveLength(3);
    expect(httpCalls[2]!.url).toBe(P401_TEST_URL);
    expect(httpCalls[2]!.headers?.["Idempotency-Key"]).toBe(`rp-prod:p401:${queuedP401.publicId}`);
    expect(JSON.parse(httpCalls[2]!.body)).toEqual({
      customer_id: "RPCUS-960ABCDEF",
      order_id: "ORD-2026-0960",
      run_mode: "production",
    });

    // 4. Configure P301 as well -> verify dry-run test, P401 blocked on P301, DESTINATION_CHANGED & ORDER_LOCKED pre-send checks
    await adminCaller.production.settings.update({
      enabled: true,
      canonVersion: "v3.0",
      runMode: "production",
      p301Url: P301_TEST_URL,
      p401Url: P401_TEST_URL,
    });
    const httpCountBeforeDryRun = httpCalls.length;
    const dryRunP301 = await adminCaller.production.settings.test({ phase: "P301" });
    const dryRunP401 = await adminCaller.production.settings.test({ phase: "P401" });
    expect(dryRunP301.allowed).toBe(true);
    expect(dryRunP401.allowed).toBe(true);
    expect(httpCalls).toHaveLength(httpCountBeforeDryRun);

    const order2 = seedOrderAndCustomer({
      orderId: 961,
      orderPublicId: "01JORDER000000000000000961",
      reference: "ORD-2026-0961",
      customerRef: "RPCUS-961ABCDEF",
      packets: [{ packetNumber: 1, tier: "Basic" }],
    });
    await staffCaller.production.order.requestP101({ orderPublicId: order2.orderPublicId });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    await staffCaller.production.order.requestP201({
      orderPublicId: order2.orderPublicId,
      phase1ArtifactsConfirmed: true,
    });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    const previewNeedP301 = await staffCaller.production.order.preview({ orderPublicId: order2.orderPublicId });
    expect(previewNeedP301.p301.eligible).toBe(true);
    expect(previewNeedP301.p401.eligible).toBe(false);
    expect(previewNeedP301.p401.disabledReasons.map((r) => r.code)).toContain("P301_NOT_DELIVERED");
    await expect(
      staffCaller.production.order.requestP401({ orderPublicId: order2.orderPublicId }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "PRODUCTION_P301_NOT_DELIVERED" }),
    });

    // Queue P301, rotate P301 URL before worker runs -> worker stops with DESTINATION_CHANGED (zero HTTP calls)
    const p301Pinned = await staffCaller.production.order.requestP301({ orderPublicId: order2.orderPublicId });
    await adminCaller.production.settings.update({
      enabled: true,
      canonVersion: "v3.0",
      runMode: "production",
      p301Url: "https://hooks.production.example.test/webhooks/p301-rotated-7777",
    });
    const countBeforeRotatedRun = httpCalls.length;
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(httpCalls).toHaveLength(countBeforeRotatedRun);
    const histAfterRotate = await staffCaller.production.order.history({ orderPublicId: order2.orderPublicId });
    const failedPinned = histAfterRotate.items.find((i) => i.publicId === p301Pinned.publicId);
    expect(failedPinned?.state).toBe("failed");
    expect(failedPinned?.lastReasonCode).toBe("DESTINATION_CHANGED");

    // Staff retry is refused after URL rotation (Rule 2); admin step-up resend delivers against the rotated URL -> then queue P401 and place order on legal_hold before worker runs -> ORDER_LOCKED
    await expect(
      staffCaller.production.order.retry({
        orderPublicId: order2.orderPublicId,
        dispatchPublicId: p301Pinned.publicId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "PRODUCTION_DESTINATION_CHANGED" }),
    });
    const resentP301 = await adminCaller.production.order.resend({
      orderPublicId: order2.orderPublicId,
      phase: "P301",
      reason: "Re-send P301 to rotated webhook endpoint after URL rotation.",
    });
    expect(resentP301.idempotencyKey).toBe(p301Pinned.idempotencyKey);
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    const p401Locked = await staffCaller.production.order.requestP401({ orderPublicId: order2.orderPublicId });
    mockOrders.get(order2.orderPublicId)!.scope.lockState = "legal_hold";
    const countBeforeLockedRun = httpCalls.length;
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(httpCalls).toHaveLength(countBeforeLockedRun);
    const histAfterLock = await staffCaller.production.order.history({ orderPublicId: order2.orderPublicId });
    const lockedRow = histAfterLock.items.find((i) => i.publicId === p401Locked.publicId);
    expect(lockedRow?.state).toBe("failed");
    expect(lockedRow?.lastReasonCode).toBe("ORDER_LOCKED");
  });

  it("Part B: allows staff with orders.production.trigger to retry failed/dead dispatches while blocking retry once delivered or superseded", async () => {
    const admin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    const customer = makeCustomer(h);
    await configureEnabledProduction(admin);

    const staffCaller = createCaller(staff);
    const customerCaller = createCaller(customer);

    const { orderPublicId } = seedOrderAndCustomer({
      orderId: 962,
      orderPublicId: "01JORDER000000000000000962",
      reference: "ORD-2026-0962",
      packets: [{ packetNumber: 2, tier: "Standard" }],
    });
    const otherOrder = seedOrderAndCustomer({
      orderId: 963,
      orderPublicId: "01JORDER000000000000000963",
      reference: "ORD-2026-0963",
      packets: [{ packetNumber: 1, tier: "Basic" }],
    });

    // First attempt returns 400 -> terminal `failed`
    nextHttpHandler = async () => ({
      status: 400,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"error":"bad_config"}', "utf8"),
    });
    const first = await staffCaller.production.order.requestP101({ orderPublicId });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    // Customer cannot retry or read history
    await expect(
      customerCaller.production.order.retry({ orderPublicId, dispatchPublicId: first.publicId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(customerCaller.production.order.history({ orderPublicId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // Cross-order dispatchPublicId refused with NOT_FOUND
    await expect(
      staffCaller.production.order.retry({
        orderPublicId: otherOrder.orderPublicId,
        dispatchPublicId: first.publicId,
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: expect.objectContaining({ reasonCode: "PRODUCTION_DISPATCH_NOT_FOUND" }),
    });

    // Staff retries failed dispatch (no step-up required) -> new row with `retryOf`
    const retry1 = await staffCaller.production.order.retry({
      orderPublicId,
      dispatchPublicId: first.publicId,
    });
    expect(retry1.publicId).not.toBe(first.publicId);
    expect(retry1.retryOf).toBe(first.publicId);
    expect(retry1.redeliveryOf).toBeNull();
    expect(retry1.resendReason).toBe("OPERATOR_RETRY_AFTER_FAILURE");
    expect(
      h.audit.events.some(
        (e) =>
          e.eventName === "integration.production.dispatch.retried" &&
          e.orderPublicId === orderPublicId &&
          e.attributes?.retry_of_public_id === first.publicId,
      ),
    ).toBe(true);

    // While retry1 is queued, retrying again fails with PRODUCTION_DISPATCH_IN_PROGRESS
    await expect(
      staffCaller.production.order.retry({ orderPublicId, dispatchPublicId: first.publicId }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "PRODUCTION_DISPATCH_IN_PROGRESS" }),
    });

    // Exhaust retry1 to `dead` (5 x 503)
    const handler = h.jobs.handlers.get(PRODUCTION_DELIVERY_JOB)!;
    const retry1JobId = h.jobs.enqueued[h.jobs.enqueued.length - 1]!.jobId;
    h.jobs.enqueued = [];
    nextHttpHandler = async () => ({
      status: 503,
      headers: {},
      body: Buffer.from("unavailable", "utf8"),
    });
    for (let attempt = 1; attempt <= PRODUCTION_MAX_ATTEMPTS; attempt += 1) {
      await handler({
        jobId: retry1JobId,
        type: PRODUCTION_DELIVERY_JOB,
        payload: { dispatchId: retry1.publicId } as never,
        attempt,
        fencingToken: attempt,
        correlationId: "corr_partb_retry_dead",
        signal: new AbortController().signal,
        assertStillOwned: async () => {},
      });
    }

    // Retrying superseded `first` fails with PRODUCTION_DISPATCH_SUPERSEDED
    await expect(
      staffCaller.production.order.retry({ orderPublicId, dispatchPublicId: first.publicId }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "PRODUCTION_DISPATCH_SUPERSEDED" }),
    });

    // Retrying latest `dead` `retry1` succeeds (`OPERATOR_RETRY_AFTER_DEAD_LETTER`) and delivers on 200
    nextHttpHandler = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}', "utf8"),
    });
    const retry2 = await staffCaller.production.order.retry({
      orderPublicId,
      dispatchPublicId: retry1.publicId,
    });
    expect(retry2.retryOf).toBe(retry1.publicId);
    expect(retry2.resendReason).toBe("OPERATOR_RETRY_AFTER_DEAD_LETTER");
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    // Abuse guard: once P101 is delivered, staff CANNOT call `retry` on either `retry1` (old dead) or `retry2` (delivered)
    for (const targetId of [first.publicId, retry1.publicId, retry2.publicId]) {
      await expect(
        staffCaller.production.order.retry({ orderPublicId, dispatchPublicId: targetId }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        cause: expect.objectContaining({ reasonCode: "PRODUCTION_ALREADY_DELIVERED" }),
      });
    }
  });

  it("Part B: enforces orders.production.redeliver step-up, REDELIVER phrase, audit reason hygiene, redeliveryOf linkage, and X-ReadyPackets-Redelivery-Of header", async () => {
    const stepUpAdmin = makeStepUpAdmin(h);
    const noStepUpAdmin = makeStepUpAdmin(h, { stepUpAt: null });
    const staleStepUpAdmin = makeStepUpAdmin(h, {
      stepUpAt: new Date(h.clock.now().getTime() - STEP_UP_MAX_AGE_MS - 5_000),
    });
    const staff = makeStaff(h);
    const customer = makeCustomer(h);
    await configureEnabledProduction(stepUpAdmin);

    const adminCaller = createCaller(stepUpAdmin);
    const noStepUpCaller = createCaller(noStepUpAdmin);
    const staleStepUpCaller = createCaller(staleStepUpAdmin);
    const staffCaller = createCaller(staff);
    const customerCaller = createCaller(customer);

    const { orderPublicId } = seedOrderAndCustomer({
      orderId: 964,
      orderPublicId: "01JORDER000000000000000964",
      reference: "ORD-2026-0964",
      packets: [{ packetNumber: 5, tier: "Premium" }],
    });

    // Deliver original P101
    const original = await staffCaller.production.order.requestP101({ orderPublicId });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    // Also create a failed P201 to verify redeliver rejects non-delivered rows
    nextHttpHandler = async () => ({
      status: 422,
      headers: {},
      body: Buffer.from("invalid", "utf8"),
    });
    const failedP201 = await staffCaller.production.order.requestP201({
      orderPublicId,
      phase1ArtifactsConfirmed: true,
    });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    // 1. Customer & staff denied (`orders.production.redeliver` is admin + step-up only)
    await expect(
      customerCaller.production.order.redeliver({
        orderPublicId,
        dispatchPublicId: original.publicId,
        reason: "Customer attempt",
        confirmation: "REDELIVER",
        idempotencyKey: "rdlv-cust-attempt-001",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      staffCaller.production.order.redeliver({
        orderPublicId,
        dispatchPublicId: original.publicId,
        reason: "Staff attempt without capability",
        confirmation: "REDELIVER",
        idempotencyKey: "rdlv-staff-attempt-001",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      cause: expect.objectContaining({ reasonCode: "CAPABILITY_NOT_GRANTED" }),
    });

    // 2. Admin without fresh step-up -> STEP_UP_REQUIRED
    for (const caller of [noStepUpCaller, staleStepUpCaller]) {
      await expect(
        caller.production.order.redeliver({
          orderPublicId,
          dispatchPublicId: original.publicId,
          reason: "Valid audit reason",
          confirmation: "REDELIVER",
          idempotencyKey: "rdlv-nostepup-001",
        }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        cause: expect.objectContaining({
          code: "STEP_UP_REQUIRED",
          reasonCode: "STEP_UP_REQUIRED",
        }),
      });
    }

    // 3. Server-side validation of typed phrase `REDELIVER`, printable reason (3..280 chars), and `idempotencyKey`
    await expect(
      adminCaller.production.order.redeliver({
        orderPublicId,
        dispatchPublicId: original.publicId,
        reason: "Valid audit reason",
        confirmation: "redeliver",
        idempotencyKey: "rdlv-badphrase-001",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({ reasonCode: "REDELIVER_CONFIRMATION_REQUIRED" }),
    });

    await expect(
      adminCaller.production.order.redeliver({
        orderPublicId,
        dispatchPublicId: original.publicId,
        reason: "  x ",
        confirmation: "REDELIVER",
        idempotencyKey: "rdlv-badreason-001",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({ reasonCode: "REDELIVER_REASON_REQUIRED" }),
    });

    await expect(
      adminCaller.production.order.redeliver({
        orderPublicId,
        dispatchPublicId: original.publicId,
        reason: "bad\r\nheader-injection",
        confirmation: "REDELIVER",
        idempotencyKey: "rdlv-crlf-reason-001",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      cause: expect.objectContaining({ reasonCode: "REDELIVER_REASON_REQUIRED" }),
    });

    await expect(
      adminCaller.production.order.redeliver({
        orderPublicId,
        dispatchPublicId: original.publicId,
        reason: "Valid audit reason",
        confirmation: "REDELIVER",
        idempotencyKey: "short",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // 4. Non-delivered dispatch rejected (`PRODUCTION_DISPATCH_NOT_DELIVERED`)
    await expect(
      adminCaller.production.order.redeliver({
        orderPublicId,
        dispatchPublicId: failedP201.publicId,
        reason: "Trying to redeliver a failed dispatch",
        confirmation: "REDELIVER",
        idempotencyKey: "rdlv-failed-row-001",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "PRODUCTION_DISPATCH_NOT_DELIVERED" }),
    });

    // 5. Valid step-up admin redelivery -> NEW delivery row with `redeliveryOf`, outbound header, and safe audit
    nextHttpHandler = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"replayed":true}', "utf8"),
    });
    const sensitiveProseReason = "SharePoint folder tree purged during maintenance — replay P101";
    const redelivered = await adminCaller.production.order.redeliver({
      orderPublicId,
      dispatchPublicId: original.publicId,
      reason: sensitiveProseReason,
      confirmation: "REDELIVER",
      idempotencyKey: "rdlv-valid-intent-001",
    });

    expect(redelivered.publicId).not.toBe(original.publicId);
    expect(redelivered.redeliveryOf).toBe(original.publicId);
    expect(redelivered.retryOf).toBeNull();
    expect(redelivered.resendReason).toBe("OPERATOR_REPLAY_DELIVERED");
    expect(redelivered.idempotencyKey).toMatch(/^rp-prod:p101:rdlv:[0-9a-f]{40}$/);

    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    const lastHttp = httpCalls[httpCalls.length - 1]!;
    expect(lastHttp.headers?.["X-ReadyPackets-Delivery"]).toBe(redelivered.publicId);
    expect(lastHttp.headers?.["X-ReadyPackets-Redelivery-Of"]).toBe(original.publicId);
    expect(lastHttp.headers?.["Idempotency-Key"]).toBe(redelivered.idempotencyKey);
    // Original P101 did NOT carry X-ReadyPackets-Redelivery-Of
    expect(httpCalls[0]!.headers?.["X-ReadyPackets-Redelivery-Of"]).toBeUndefined();

    // History preserves BOTH the original delivered row and the new redelivery row
    const history = await staffCaller.production.order.history({ orderPublicId });
    const newHistRow = history.items.find((i) => i.publicId === redelivered.publicId);
    const origHistRow = history.items.find((i) => i.publicId === original.publicId);
    expect(newHistRow?.state).toBe("delivered");
    expect(newHistRow?.redeliveryOf).toBe(original.publicId);
    expect(origHistRow?.state).toBe("delivered");
    expect(origHistRow?.redeliveryOf).toBeNull();

    // Audit records `integration.production.dispatch.redelivered` with `orderPublicId` and `reason_length` (NEVER raw prose)
    const redeliverAudit = h.audit.events.find(
      (e) =>
        e.eventName === "integration.production.dispatch.redelivered" &&
        e.resource?.publicId === redelivered.publicId,
    );
    expect(redeliverAudit).toBeDefined();
    expect(redeliverAudit?.severity).toBe("WARN");
    expect(redeliverAudit?.orderPublicId).toBe(orderPublicId);
    expect(redeliverAudit?.attributes).toMatchObject({
      phase: "P101",
      order_public_id: orderPublicId,
      redelivery_of_public_id: original.publicId,
    });
    expect(redeliverAudit?.safeCounts).toEqual({
      reason_length: sensitiveProseReason.length,
    });
    expect(JSON.stringify(h.audit.events)).not.toContain("SharePoint folder tree purged");
  });

  it("Part B security: deduplicates post-delivery redeliver replays by operator idempotencyKey, blocks legacy resend on delivered phases, and refuses redeliver when a prior redelivery is unknown", async () => {
    const stepUpAdmin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(stepUpAdmin);

    const adminCaller = createCaller(stepUpAdmin);
    const staffCaller = createCaller(staff);

    const { orderPublicId } = seedOrderAndCustomer({
      orderId: 965,
      orderPublicId: "01JORDER000000000000000965",
      reference: "ORD-2026-0965",
      packets: [{ packetNumber: 2, tier: "Standard" }],
    });

    // Deliver P101 and P201
    const origP101 = await staffCaller.production.order.requestP101({ orderPublicId });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    const origP201 = await staffCaller.production.order.requestP201({
      orderPublicId,
      phase1ArtifactsConfirmed: true,
    });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    // 1. API-level refusal: legacy `production.order.resend` MUST reject already-delivered phases
    // even when called by a step-up admin with `orders.production.trigger` + reason.
    for (const phase of ["P101", "P201"] as const) {
      await expect(
        adminCaller.production.order.resend({
          orderPublicId,
          phase,
          reason: "Attempting legacy resend bypass after delivery",
          phase1ArtifactsConfirmed: true,
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        cause: expect.objectContaining({ reasonCode: "PRODUCTION_ALREADY_DELIVERED" }),
      });
    }

    // 2. Confirmed redeliver intent #1 delivers HTTP 200; replaying the SAME `idempotencyKey` AFTER
    // delivery returns the existing delivered dispatch with zero new DB row, job, HTTP call, or audit event.
    const rdlv1 = await adminCaller.production.order.redeliver({
      orderPublicId,
      dispatchPublicId: origP101.publicId,
      reason: "Downstream workspace wiped — replay #1",
      confirmation: "REDELIVER",
      idempotencyKey: "rdlv-op-intent-0001",
    });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    const callsAfterFirstDelivery = httpCalls.length;
    const redeliverAuditsAfterFirst = h.audit.events.filter(
      (e) => e.eventName === "integration.production.dispatch.redelivered",
    ).length;

    const postDeliveryReplay = await adminCaller.production.order.redeliver({
      orderPublicId,
      dispatchPublicId: origP101.publicId,
      reason: "Downstream workspace wiped — replay #1",
      confirmation: "REDELIVER",
      idempotencyKey: "rdlv-op-intent-0001",
    });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    expect(postDeliveryReplay.publicId).toBe(rdlv1.publicId);
    expect(postDeliveryReplay.state).toBe("delivered");
    expect(postDeliveryReplay.redeliveryOf).toBe(origP101.publicId);
    expect(httpCalls.length).toBe(callsAfterFirstDelivery);
    expect(
      h.audit.events.filter((e) => e.eventName === "integration.production.dispatch.redelivered")
        .length,
    ).toBe(redeliverAuditsAfterFirst);

    // Reusing the same `idempotencyKey` against a DIFFERENT dispatch on the order is rejected
    await expect(
      adminCaller.production.order.redeliver({
        orderPublicId,
        dispatchPublicId: origP201.publicId,
        reason: "Accidental reuse of key on P201",
        confirmation: "REDELIVER",
        idempotencyKey: "rdlv-op-intent-0001",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "IDEMPOTENCY_KEY_CONFLICT" }),
    });

    // 3. Explicit NEW `idempotencyKey` creates a second redelivery; if it ends in `unknown` (interrupted sending reconciled),
    // replaying its own key returns the `unknown` row idempotently while a 3rd new intent is refused!
    const rdlv2 = await adminCaller.production.order.redeliver({
      orderPublicId,
      dispatchPublicId: origP101.publicId,
      reason: "Explicit second replay intent",
      confirmation: "REDELIVER",
      idempotencyKey: "rdlv-op-intent-0002",
    });
    expect(rdlv2.publicId).not.toBe(rdlv1.publicId);
    h.jobs.enqueued = []; // simulate worker crash after transitioning to `sending`
    await tdb.db
      .update(integrationProductionDispatches)
      .set({ state: "sending", attemptCount: 1, updatedAt: h.clock.now() })
      .where(eq(integrationProductionDispatches.publicId, rdlv2.publicId));
    h.clock.advance(12_000 + PRODUCTION_SENDING_GRACE_MS + 1_000);

    const freshAdmin = makeStepUpAdmin(h);
    const freshAdminCaller = createCaller(freshAdmin);

    const replayUnknownIntent = await freshAdminCaller.production.order.redeliver({
      orderPublicId,
      dispatchPublicId: origP101.publicId,
      reason: "Explicit second replay intent",
      confirmation: "REDELIVER",
      idempotencyKey: "rdlv-op-intent-0002",
    });
    expect(replayUnknownIntent.publicId).toBe(rdlv2.publicId);
    expect(replayUnknownIntent.state).toBe("unknown");

    await expect(
      freshAdminCaller.production.order.redeliver({
        orderPublicId,
        dispatchPublicId: origP101.publicId,
        reason: "Third intent while second redelivery is unknown",
        confirmation: "REDELIVER",
        idempotencyKey: "rdlv-op-intent-0003",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "PRODUCTION_DISPATCH_UNCERTAIN" }),
    });
  });

  it("Part B security: enforces original-payload byte identity on retry and redeliver and refuses mutated relevant data", async () => {
    const stepUpAdmin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(stepUpAdmin);

    const adminCaller = createCaller(stepUpAdmin);
    const staffCaller = createCaller(staff);
    const updateProdSettings = (overrides: {
      canonVersion?: string;
      runMode?: "production" | "staging" | "dry_run";
      p301Url?: string;
    }) =>
      adminCaller.production.settings.update({
        enabled: true,
        canonVersion: overrides.canonVersion ?? "v3.0",
        runMode: overrides.runMode ?? "production",
        authHeaderName: "X-Webhook-Token",
        timeoutMs: 12_000,
        ...(overrides.p301Url !== undefined ? { p301Url: overrides.p301Url } : {}),
      });
    await updateProdSettings({ p301Url: P301_TEST_URL });

    // --- Part 1: P101 retry & redeliver refuse mutated scope/customer/config and preserve exact SHA-256 bytes ---
    const { orderPublicId: p101OrderPub, ownerUserId: p101OwnerId } = seedOrderAndCustomer({
      orderId: 966,
      orderPublicId: "01JORDER000000000000000966",
      reference: "ORD-2026-0966",
      customerRef: "RP-ORIG-966",
      clientName: "Ada Lovelace",
      clientEmail: "ada@client.example.test",
      packets: [{ packetNumber: 1, tier: "Standard" }],
    });

    nextHttpHandler = async () => ({
      status: 422,
      headers: {},
      body: Buffer.from("temporary downstream schema mismatch", "utf8"),
    });
    const failedP101 = await staffCaller.production.order.requestP101({
      orderPublicId: p101OrderPub,
      releaseStatus: "HOLD_INITIAL",
    });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    const failedP101Body = httpCalls[httpCalls.length - 1]!.body;

    // Mutate order packet scope -> `retry` refused with `ORDER_SCOPE_CHANGED`
    const orderEntry = mockOrders.get(p101OrderPub)!;
    const savedPackets = [...orderEntry.scope.packets];
    orderEntry.scope.packets = [
      { packetNumber: 1, tier: "Standard" },
      { packetNumber: 3, tier: "Premium" },
    ];
    await expect(
      staffCaller.production.order.retry({
        orderPublicId: p101OrderPub,
        dispatchPublicId: failedP101.publicId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "ORDER_SCOPE_CHANGED" }),
    });
    orderEntry.scope.packets = savedPackets;

    // Mutate customer email -> `retry` refused with `ORIGINAL_PAYLOAD_UNVERIFIABLE`
    const ownerEntry = mockUsers.get(p101OwnerId)!;
    const savedEmail = ownerEntry.email;
    ownerEntry.email = "mutated-ada@client.example.test";
    await expect(
      staffCaller.production.order.retry({
        orderPublicId: p101OrderPub,
        dispatchPublicId: failedP101.publicId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "ORIGINAL_PAYLOAD_UNVERIFIABLE" }),
    });
    ownerEntry.email = savedEmail;

    // Mutate `run_mode` -> `retry` refused with `ORIGINAL_PAYLOAD_UNVERIFIABLE`
    await updateProdSettings({ runMode: "staging" });
    await expect(
      staffCaller.production.order.retry({
        orderPublicId: p101OrderPub,
        dispatchPublicId: failedP101.publicId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "ORIGINAL_PAYLOAD_UNVERIFIABLE" }),
    });
    await updateProdSettings({ runMode: "production" });

    // Restore original state -> `retry` succeeds with identical SHA-256 and identical wire JSON bytes
    nextHttpHandler = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}', "utf8"),
    });
    const retriedP101 = await staffCaller.production.order.retry({
      orderPublicId: p101OrderPub,
      dispatchPublicId: failedP101.publicId,
    });
    expect(retriedP101.payloadSha256).toBe(failedP101.payloadSha256);
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(httpCalls[httpCalls.length - 1]!.body).toBe(failedP101Body);

    // Mutate `canonVersion` before `redeliver` of delivered P101 -> refused (`ORIGINAL_PAYLOAD_UNVERIFIABLE`)
    await updateProdSettings({ canonVersion: "2026.09-drifted" });
    await expect(
      adminCaller.production.order.redeliver({
        orderPublicId: p101OrderPub,
        dispatchPublicId: retriedP101.publicId,
        reason: "Replay after canon drift must fail closed",
        confirmation: "REDELIVER",
        idempotencyKey: "rdlv-p101-canon-drift",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "ORIGINAL_PAYLOAD_UNVERIFIABLE" }),
    });
    await updateProdSettings({ canonVersion: "v3.0" });

    const redeliveredP101 = await adminCaller.production.order.redeliver({
      orderPublicId: p101OrderPub,
      dispatchPublicId: retriedP101.publicId,
      reason: "Replay with verified original bytes",
      confirmation: "REDELIVER",
      idempotencyKey: "rdlv-p101-verified-001",
    });
    expect(redeliveredP101.payloadSha256).toBe(failedP101.payloadSha256);
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(httpCalls[httpCalls.length - 1]!.body).toBe(failedP101Body);

    // --- Part 2: P201/P301 retry & redeliver replay the SELECTED dispatch's bytes (not newest P101 or mutated live fields) ---
    const origP201 = await staffCaller.production.order.requestP201({
      orderPublicId: p101OrderPub,
      phase1ArtifactsConfirmed: true,
    });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    const origP201Body = httpCalls[httpCalls.length - 1]!.body;
    expect(origP201Body).toBe('{"customer_id":"RP-ORIG-966","order_id":"ORD-2026-0966","run_mode":"production"}');

    nextHttpHandler = async () => ({
      status: 422,
      headers: {},
      body: Buffer.from("transient p301 rejection", "utf8"),
    });
    const failedOrigP301 = await staffCaller.production.order.requestP301({
      orderPublicId: p101OrderPub,
    });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    // Insert a NEWER delivered P101 row with DIFFERENT `{sentCustomerId, sentRunMode}` AND mutate live `customerRef` + `runMode`
    ownerEntry.customerRef = "RP-MUTATED-LIVE";
    await updateProdSettings({ runMode: "staging", p301Url: P301_TEST_URL });
    const newerP101Payload = '{"canon_version":"v3.0","client_email":"ada@client.example.test","client_name":"Ada Lovelace","customer_id":"RP-NEWER-P101","order_id":"ORD-2026-0966","run_mode":"staging","packet":"P1","tier":"Standard","release_status":"","bundle_scope_manifest":""}';
    await tdb.db.insert(integrationProductionDispatches).values({
      publicId: "01JNEWERDELIVEREDP10100966",
      orderId: 966,
      orderPublicId: p101OrderPub,
      orderReference: "ORD-2026-0966",
      expectedOwnerUserId: p101OwnerId,
      destinationFingerprint: "fp-newer-p101",
      jobPublicId: "01JJOBNEWERP10100000000966",
      expiresAt: new Date(h.clock.now().getTime() + PRODUCTION_DISPATCH_MAX_TTL_MS),
      phase: "P101",
      state: "delivered",
      idempotencyKey: "rp-prod:p101:01JNEWERDELIVEREDP10100966",
      payloadSha256: createHash("sha256").update(newerP101Payload).digest("hex"),
      sentCustomerId: "RP-NEWER-P101",
      sentOrderId: "ORD-2026-0966",
      sentRunMode: "staging",
      packet: "P1",
      tier: "Standard",
      bundleScopeManifest: "",
      releaseStatus: "",
      attemptCount: 1,
      requestedByUserId: 1,
      requestedByPublicId: stepUpAdmin.userPublicId,
      correlationId: "corr_newer_p101_966",
      deliveredAt: h.clock.now(),
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    });

    // Re-delivering `origP201` MUST replay `origP201`'s exact original `{customer_id:"RP-ORIG-966", run_mode:"production"}` bytes!
    nextHttpHandler = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}', "utf8"),
    });
    const replayedOrigP201 = await adminCaller.production.order.redeliver({
      orderPublicId: p101OrderPub,
      dispatchPublicId: origP201.publicId,
      reason: "Replay original P201 snapshot despite newer P101 row",
      confirmation: "REDELIVER",
      idempotencyKey: "rdlv-p201-selected-row-001",
    });
    expect(replayedOrigP201.payloadSha256).toBe(origP201.payloadSha256);
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(httpCalls[httpCalls.length - 1]!.body).toBe(origP201Body);

    // Retrying `failedOrigP301` when a newer delivered P101 row differs -> replays selected `failedOrigP301` bytes!
    const retriedP301 = await staffCaller.production.order.retry({
      orderPublicId: p101OrderPub,
      dispatchPublicId: failedOrigP301.publicId,
    });
    expect(retriedP301.payloadSha256).toBe(origP201.payloadSha256);
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(httpCalls[httpCalls.length - 1]!.body).toBe(origP201Body);

    // Tampering persisted `sentRunMode` on delivered `retriedP301` so it disagrees with `payloadSha256` -> refused fail-closed!
    await tdb.db
      .update(integrationProductionDispatches)
      .set({ sentRunMode: "staging" })
      .where(eq(integrationProductionDispatches.publicId, retriedP301.publicId));

    await expect(
      adminCaller.production.order.redeliver({
        orderPublicId: p101OrderPub,
        dispatchPublicId: retriedP301.publicId,
        reason: "Tampered row digest mismatch must refuse",
        confirmation: "REDELIVER",
        idempotencyKey: "rdlv-p301-tampered-001",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "ORIGINAL_PAYLOAD_UNVERIFIABLE" }),
    });
  });

  it("Part B security: carries original root Idempotency-Key across 5xx dead-letter exhaustion into operator retry (including chained retries), while deliberate redeliver issues a distinct key", async () => {
    const stepUpAdmin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(stepUpAdmin);

    const { orderPublicId } = seedOrderAndCustomer({
      orderId: 970,
      orderPublicId: "01JORDER000000000000000970",
      reference: "ORD-2026-0970",
      customerRef: "RP-RETRY-DEDUPE-970",
      packets: [{ packetNumber: 1, tier: "Standard" }],
    });

    const staffCaller = createCaller(staff);
    const adminCaller = createCaller(stepUpAdmin);
    const handler = h.jobs.handlers.get(PRODUCTION_DELIVERY_JOB)!;

    const exhaustWith5xx = async (dispatchPublicId: string, httpStatus: number) => {
      const enqueuedJobId = h.jobs.enqueued[h.jobs.enqueued.length - 1]!.jobId;
      h.jobs.enqueued = [];
      nextHttpHandler = async ({ headers, body }) => {
        const key = headers?.["Idempotency-Key"] ?? "";
        // Simulate downstream committing side effects on attempt 3 before gateway returns 5xx!
        if (!downstreamCommittedByKey.has(key) && httpCalls.length === 3) {
          downstreamCommittedByKey.set(key, String(body ?? ""));
          downstreamSideEffectRuns += 1;
        }
        return {
          status: httpStatus,
          headers: { "content-type": "text/plain" },
          body: Buffer.from(`upstream ${httpStatus}`, "utf8"),
        };
      };

      for (let attempt = 1; attempt <= PRODUCTION_MAX_ATTEMPTS; attempt += 1) {
        const res = await handler({
          jobId: enqueuedJobId,
          type: PRODUCTION_DELIVERY_JOB,
          payload: { dispatchId: dispatchPublicId } as never,
          attempt,
          fencingToken: attempt,
          correlationId: `corr_5xx_${dispatchPublicId}`,
          signal: new AbortController().signal,
          assertStillOwned: async () => {},
        });
        expect(res).toEqual({
          outcome: "failed",
          reasonCode: "PRODUCTION_HTTP_5XX",
          retryable: attempt < PRODUCTION_MAX_ATTEMPTS,
        });
      }
    };

    const downstreamCommittedByKey = new Map<string, string>();
    let downstreamSideEffectRuns = 0;

    // 1. Initial P101 dispatch exhausts all 5 attempts on HTTP 503 -> `dead` (after committing side effects on attempt 3)
    const initialDispatch = await staffCaller.production.order.requestP101({ orderPublicId });
    const rootKey = initialDispatch.idempotencyKey;
    expect(rootKey).toBe(`rp-prod:p101:${initialDispatch.publicId}`);

    await exhaustWith5xx(initialDispatch.publicId, 503);
    expect(downstreamSideEffectRuns).toBe(1);

    const [deadInitial] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, initialDispatch.publicId));
    expect(deadInitial?.state).toBe("dead");

    // 2. Staff retries `dead` initialDispatch -> `retry1` carries root `Idempotency-Key`, while DB column stays unique (`<= 96` chars)
    const retry1 = await staffCaller.production.order.retry({
      orderPublicId,
      dispatchPublicId: initialDispatch.publicId,
    });
    expect(retry1.publicId).not.toBe(initialDispatch.publicId);
    expect(retry1.retryOf).toBe(initialDispatch.publicId);
    expect(retry1.resendReason).toBe("OPERATOR_RETRY_AFTER_DEAD_LETTER");
    expect(retry1.idempotencyKey).toBe(rootKey);

    const [retry1DbRow] = await tdb.db
      .select()
      .from(integrationProductionDispatches)
      .where(eq(integrationProductionDispatches.publicId, retry1.publicId));
    expect(retry1DbRow?.idempotencyKey).toBe(`${rootKey}:r:${retry1.publicId}`);
    expect(retry1DbRow!.idempotencyKey.length).toBeLessThanOrEqual(96);

    // 3. Chained 5xx exhaustion: `retry1` ALSO exhausts 5x HTTP 502 -> `dead`, then staff retries `retry1` -> `retry2`
    await exhaustWith5xx(retry1.publicId, 502);
    const retry2 = await staffCaller.production.order.retry({
      orderPublicId,
      dispatchPublicId: retry1.publicId,
    });
    expect(retry2.retryOf).toBe(retry1.publicId);
    expect(retry2.idempotencyKey).toBe(rootKey);

    // Downstream recovers and deduplicates `retry2` via the preserved root `Idempotency-Key`!
    nextHttpHandler = async ({ headers, body }) => {
      const key = headers?.["Idempotency-Key"] ?? "";
      if (!downstreamCommittedByKey.has(key)) {
        downstreamCommittedByKey.set(key, String(body ?? ""));
        downstreamSideEffectRuns += 1;
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from('{"ok":true,"deduped":true}', "utf8"),
      };
    };
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    // All 11 HTTP attempts (5 on initialDispatch + 5 on retry1 + 1 on retry2) sent the EXACT same root Idempotency-Key!
    expect(httpCalls).toHaveLength(PRODUCTION_MAX_ATTEMPTS * 2 + 1);
    for (const call of httpCalls) {
      expect(call.headers?.["Idempotency-Key"]).toBe(rootKey);
      expect(call.headers?.["X-ReadyPackets-Redelivery-Of"]).toBeUndefined();
    }
    expect(downstreamSideEffectRuns).toBe(1);

    const deliveryHeaders = new Set(httpCalls.map((c) => c.headers?.["X-ReadyPackets-Delivery"]));
    expect(deliveryHeaders).toEqual(
      new Set([initialDispatch.publicId, retry1.publicId, retry2.publicId]),
    );

    // Audit event for `retried` records the wire root Idempotency-Key
    const retryAudits = h.audit.events.filter(
      (e) => e.eventName === "integration.production.dispatch.retried" && e.orderPublicId === orderPublicId,
    );
    expect(retryAudits).toHaveLength(2);
    expect(retryAudits[0]!.attributes?.idempotency_key).toBe(rootKey);
    expect(retryAudits[1]!.attributes?.idempotency_key).toBe(rootKey);

    // 4. Contrast with deliberate `redeliver`: issues a DISTINCT `Idempotency-Key` + `X-ReadyPackets-Redelivery-Of`
    //    so the receiver intentionally executes a second run (`downstreamSideEffectRuns === 2`), while post-delivery
    //    replay of the same `idempotencyKey` is deduplicated and staff `retry` on an already-delivered phase remains blocked!
    nextHttpHandler = async ({ headers, body }) => {
      const key = headers?.["Idempotency-Key"] ?? "";
      if (!downstreamCommittedByKey.has(key)) {
        downstreamCommittedByKey.set(key, String(body ?? ""));
        downstreamSideEffectRuns += 1;
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from('{"ok":true,"freshRun":true}', "utf8"),
      };
    };
    const deliberateRedeliver = await adminCaller.production.order.redeliver({
      orderPublicId,
      dispatchPublicId: retry2.publicId,
      reason: "Deliberate operator re-run after downstream purge",
      confirmation: "REDELIVER",
      idempotencyKey: "rdlv-after-5xx-recovery-001",
    });
    expect(deliberateRedeliver.idempotencyKey).not.toBe(rootKey);
    expect(deliberateRedeliver.idempotencyKey).toMatch(/^rp-prod:p101:rdlv:[0-9a-f]{40}$/);
    expect(deliberateRedeliver.redeliveryOf).toBe(retry2.publicId);
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    const redeliverHttp = httpCalls[httpCalls.length - 1]!;
    expect(redeliverHttp.headers?.["Idempotency-Key"]).toBe(deliberateRedeliver.idempotencyKey);
    expect(redeliverHttp.headers?.["X-ReadyPackets-Redelivery-Of"]).toBe(retry2.publicId);
    expect(downstreamSideEffectRuns).toBe(2);

    // Replaying the admin's `idempotencyKey` after delivery returns `deliberateRedeliver` without another run
    const callsBeforeReplay = httpCalls.length;
    const replayedRedeliver = await adminCaller.production.order.redeliver({
      orderPublicId,
      dispatchPublicId: retry2.publicId,
      reason: "Deliberate operator re-run after downstream purge",
      confirmation: "REDELIVER",
      idempotencyKey: "rdlv-after-5xx-recovery-001",
    });
    expect(replayedRedeliver.publicId).toBe(deliberateRedeliver.publicId);
    expect(replayedRedeliver.state).toBe("delivered");
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(httpCalls).toHaveLength(callsBeforeReplay);
    expect(downstreamSideEffectRuns).toBe(2);

    // Once `deliberateRedeliver` is delivered, retrying it or the earlier dead rows is blocked by `PRODUCTION_ALREADY_DELIVERED`
    await expect(
      staffCaller.production.order.retry({
        orderPublicId,
        dispatchPublicId: deliberateRedeliver.publicId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "PRODUCTION_ALREADY_DELIVERED" }),
    });
  });

  it("Part B B-T1-04 Rule 1: legacy production.order.resend of undelivered dead and unknown phases reuses the root wire Idempotency-Key and exact payload bytes while keeping admin step-up + reason", async () => {
    const stepUpAdmin = makeStepUpAdmin(h);
    const noStepUpAdmin = makeStepUpAdmin(h, { stepUpAt: null });
    const staff = makeStaff(h);
    await configureEnabledProduction(stepUpAdmin);

    const staffCaller = createCaller(staff);
    const adminCaller = createCaller(stepUpAdmin);
    const noStepUpCaller = createCaller(noStepUpAdmin);
    const handler = h.jobs.handlers.get(PRODUCTION_DELIVERY_JOB)!;

    // 1. Undelivered `dead` phase -> `production.order.resend` reuses root wire Idempotency-Key + exact bytes
    const deadOrder = seedOrderAndCustomer({
      orderId: 971,
      orderPublicId: "01JORDER000000000000000971",
      reference: "ORD-2026-0971",
      customerRef: "RP-RESEND-DEAD-971",
      packets: [{ packetNumber: 2, tier: "Standard" }],
    });

    const dDead = await staffCaller.production.order.requestP101({
      orderPublicId: deadOrder.orderPublicId,
    });
    const deadJobId = h.jobs.enqueued[h.jobs.enqueued.length - 1]!.jobId;
    h.jobs.enqueued = [];
    const committedKeys = new Set<string>();
    let downstreamRuns = 0;

    nextHttpHandler = async ({ headers }) => {
      const k = headers?.["Idempotency-Key"] ?? "";
      if (!committedKeys.has(k) && httpCalls.length === 2) {
        committedKeys.add(k);
        downstreamRuns += 1;
      }
      return {
        status: 503,
        headers: {},
        body: Buffer.from("gateway timeout after downstream commit", "utf8"),
      };
    };
    for (let attempt = 1; attempt <= PRODUCTION_MAX_ATTEMPTS; attempt += 1) {
      await handler({
        jobId: deadJobId,
        type: PRODUCTION_DELIVERY_JOB,
        payload: { dispatchId: dDead.publicId } as never,
        attempt,
        fencingToken: attempt,
        correlationId: "corr_rule1_dead",
        signal: new AbortController().signal,
        assertStillOwned: async () => {},
      });
    }
    expect(downstreamRuns).toBe(1);

    // Staff and non-step-up admin remain blocked on `resend`
    await expect(
      staffCaller.production.order.resend({
        orderPublicId: deadOrder.orderPublicId,
        phase: "P101",
        reason: "Staff should not be allowed",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      noStepUpCaller.production.order.resend({
        orderPublicId: deadOrder.orderPublicId,
        phase: "P101",
        reason: "Missing fresh step-up",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Mutating `releaseStatus` on `resend` of an undelivered attempt is refused so payload bytes stay identical to root
    await expect(
      adminCaller.production.order.resend({
        orderPublicId: deadOrder.orderPublicId,
        phase: "P101",
        reason: "Attempted payload mutation on resend",
        releaseStatus: "mutated-release-flag",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "ORDER_SCOPE_CHANGED" }),
    });

    nextHttpHandler = async ({ headers }) => {
      const k = headers?.["Idempotency-Key"] ?? "";
      if (!committedKeys.has(k)) {
        committedKeys.add(k);
        downstreamRuns += 1;
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from('{"ok":true}', "utf8"),
      };
    };
    const resentFromDead = await adminCaller.production.order.resend({
      orderPublicId: deadOrder.orderPublicId,
      phase: "P101",
      reason: "Downstream recovered — resend with preserved root key",
    });
    expect(resentFromDead.publicId).not.toBe(dDead.publicId);
    expect(resentFromDead.idempotencyKey).toBe(dDead.idempotencyKey);
    expect(resentFromDead.payloadSha256).toBe(dDead.payloadSha256);
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(httpCalls[httpCalls.length - 1]!.headers?.["Idempotency-Key"]).toBe(dDead.idempotencyKey);
    expect(downstreamRuns).toBe(1);

    // 2. Undelivered `unknown` phase -> `production.order.resend` also reuses root wire Idempotency-Key
    const unknownOrder = seedOrderAndCustomer({
      orderId: 972,
      orderPublicId: "01JORDER000000000000000972",
      reference: "ORD-2026-0972",
      customerRef: "RP-RESEND-UNK-972",
      packets: [{ packetNumber: 3, tier: "Premium" }],
    });
    const dUnknown = await staffCaller.production.order.requestP101({
      orderPublicId: unknownOrder.orderPublicId,
    });
    h.jobs.enqueued = [];
    await tdb.db
      .update(integrationProductionDispatches)
      .set({ state: "sending", attemptCount: 1, updatedAt: h.clock.now() })
      .where(eq(integrationProductionDispatches.publicId, dUnknown.publicId));
    h.clock.advance(12_000 + PRODUCTION_SENDING_GRACE_MS + 1_000);

    const freshAdminCaller = createCaller(makeStepUpAdmin(h));
    const resentFromUnknown = await freshAdminCaller.production.order.resend({
      orderPublicId: unknownOrder.orderPublicId,
      phase: "P101",
      reason: "Confirmed downstream state after interrupted send",
    });
    expect(resentFromUnknown.idempotencyKey).toBe(dUnknown.idempotencyKey);
    expect(resentFromUnknown.payloadSha256).toBe(dUnknown.payloadSha256);
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(httpCalls[httpCalls.length - 1]!.headers?.["Idempotency-Key"]).toBe(dUnknown.idempotencyKey);
  });

  it("Part B B-T1-04 Rule 2: refuses retry with PRODUCTION_DESTINATION_CHANGED when destination fingerprint differs from root, allowing only admin step-up resend with root Idempotency-Key and destination_changed=true audit (no URL)", async () => {
    const stepUpAdmin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(stepUpAdmin);

    dnsAnswers["failover-hooks.production.example.test"] = [{ address: "93.184.216.36", family: 4 }];
    await mod.egress.createAllowlistRule(stepUpAdmin, {
      purpose: "webhook",
      matchType: "host",
      pattern: "failover-hooks.production.example.test",
      port: 443,
      protocol: "https:",
      allowPrivateAddress: false,
      justification: "Failover production webhook receiver",
    });

    const staffCaller = createCaller(staff);
    const adminCaller = createCaller(stepUpAdmin);
    const handler = h.jobs.handlers.get(PRODUCTION_DELIVERY_JOB)!;

    const { orderPublicId } = seedOrderAndCustomer({
      orderId: 973,
      orderPublicId: "01JORDER000000000000000973",
      reference: "ORD-2026-0973",
      customerRef: "RP-DEST-CHANGE-973",
      packets: [{ packetNumber: 1, tier: "Basic" }],
    });

    const dRoot = await staffCaller.production.order.requestP101({ orderPublicId });
    const rootJobId = h.jobs.enqueued[h.jobs.enqueued.length - 1]!.jobId;
    h.jobs.enqueued = [];

    nextHttpHandler = async () => ({
      status: 502,
      headers: {},
      body: Buffer.from("bad gateway", "utf8"),
    });
    for (let attempt = 1; attempt <= PRODUCTION_MAX_ATTEMPTS; attempt += 1) {
      await handler({
        jobId: rootJobId,
        type: PRODUCTION_DELIVERY_JOB,
        payload: { dispatchId: dRoot.publicId } as never,
        attempt,
        fencingToken: attempt,
        correlationId: "corr_rule2_dead",
        signal: new AbortController().signal,
        assertStillOwned: async () => {},
      });
    }

    // Rotate P101 destination URL (with secret query token to verify zero URL leakage in audits)
    const newSecretUrl =
      "https://failover-hooks.production.example.test/webhooks/p101?sig=super_secret_query_token_973";
    await adminCaller.production.settings.update({
      enabled: true,
      canonVersion: "v3.0",
      runMode: "production",
      timeoutMs: 12_000,
      authHeaderName: "X-Webhook-Secret",
      p101Url: newSecretUrl,
    });

    // Staff `retry` (and even admin `retry`) MUST be refused with CONFLICT / PRODUCTION_DESTINATION_CHANGED
    await expect(
      staffCaller.production.order.retry({
        orderPublicId,
        dispatchPublicId: dRoot.publicId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "PRODUCTION_DESTINATION_CHANGED" }),
    });
    await expect(
      adminCaller.production.order.retry({
        orderPublicId,
        dispatchPublicId: dRoot.publicId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "PRODUCTION_DESTINATION_CHANGED" }),
    });

    // Admin step-up `resend` succeeds, reuses root `Idempotency-Key`, and records `destination_changed: true` with zero URL
    nextHttpHandler = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}', "utf8"),
    });
    const adminResent = await adminCaller.production.order.resend({
      orderPublicId,
      phase: "P101",
      reason: "Switched P101 ingress to failover receiver after outage",
    });
    expect(adminResent.idempotencyKey).toBe(dRoot.idempotencyKey);
    expect(adminResent.payloadSha256).toBe(dRoot.payloadSha256);

    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    const failoverCall = httpCalls[httpCalls.length - 1]!;
    expect(failoverCall.headers?.["Idempotency-Key"]).toBe(dRoot.idempotencyKey);
    expect(failoverCall.url).toContain("failover-hooks.production.example.test");

    const resentAudit = h.audit.events.find(
      (e) =>
        e.eventName === "integration.production.dispatch.resent" &&
        e.resource?.publicId === adminResent.publicId,
    );
    expect(resentAudit).toBeDefined();
    expect(resentAudit?.attributes).toMatchObject({
      phase: "P101",
      order_public_id: orderPublicId,
      idempotency_key: dRoot.idempotencyKey,
      destination_changed: true,
    });
    const serializedAudits = JSON.stringify(h.audit.events);
    expect(serializedAudits).not.toContain("failover-hooks.production.example.test");
    expect(serializedAudits).not.toContain("super_secret_query_token_973");
  });

  it("Part B B-T1-04 Rule 3: after a redelivery ends dead, refuses new redelivery intents with PRODUCTION_REDELIVERY_RETRY_REQUIRED while allowing retry of that dead redelivery row with the same redelivery wire Idempotency-Key via retryOf chain", async () => {
    const stepUpAdmin = makeStepUpAdmin(h);
    const staff = makeStaff(h);
    await configureEnabledProduction(stepUpAdmin);

    const staffCaller = createCaller(staff);
    const adminCaller = createCaller(stepUpAdmin);
    const handler = h.jobs.handlers.get(PRODUCTION_DELIVERY_JOB)!;

    const { orderPublicId } = seedOrderAndCustomer({
      orderId: 974,
      orderPublicId: "01JORDER000000000000000974",
      reference: "ORD-2026-0974",
      customerRef: "RP-RDLV-DEAD-974",
      packets: [{ packetNumber: 4, tier: "Premium" }],
    });

    // 1. Deliver initial P101
    nextHttpHandler = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}', "utf8"),
    });
    const origDelivered = await staffCaller.production.order.requestP101({ orderPublicId });
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);

    // 2. Step-up admin triggers redelivery `rdlvDead`, which commits side effects downstream on attempt 3 then exhausts 5x 503 -> `dead`
    const committedByKey = new Set<string>([origDelivered.idempotencyKey]);
    let downstreamRuns = 1;

    const rdlvDead = await adminCaller.production.order.redeliver({
      orderPublicId,
      dispatchPublicId: origDelivered.publicId,
      reason: "Replay after SharePoint folder cleanup",
      confirmation: "REDELIVER",
      idempotencyKey: "rdlv-rule3-intent-001",
    });
    const rdlvWireKey = rdlvDead.idempotencyKey;
    expect(rdlvWireKey).toMatch(/^rp-prod:p101:rdlv:[0-9a-f]{40}$/);

    const rdlvJobId = h.jobs.enqueued[h.jobs.enqueued.length - 1]!.jobId;
    h.jobs.enqueued = [];
    const callsBeforeRdlv = httpCalls.length;
    nextHttpHandler = async ({ headers }) => {
      const k = headers?.["Idempotency-Key"] ?? "";
      if (!committedByKey.has(k) && httpCalls.length - callsBeforeRdlv === 3) {
        committedByKey.add(k);
        downstreamRuns += 1;
      }
      return {
        status: 503,
        headers: {},
        body: Buffer.from("downstream 503 after accepting redelivery", "utf8"),
      };
    };
    for (let attempt = 1; attempt <= PRODUCTION_MAX_ATTEMPTS; attempt += 1) {
      await handler({
        jobId: rdlvJobId,
        type: PRODUCTION_DELIVERY_JOB,
        payload: { dispatchId: rdlvDead.publicId } as never,
        attempt,
        fencingToken: attempt,
        correlationId: "corr_rule3_rdlv_dead",
        signal: new AbortController().signal,
        assertStillOwned: async () => {},
      });
    }
    expect(downstreamRuns).toBe(2);

    // 3. Same `idempotencyKey` replays idempotently with zero new work; a NEW `idempotencyKey` is refused with PRODUCTION_REDELIVERY_RETRY_REQUIRED!
    const sameIntentReplay = await adminCaller.production.order.redeliver({
      orderPublicId,
      dispatchPublicId: origDelivered.publicId,
      reason: "Replay after SharePoint folder cleanup",
      confirmation: "REDELIVER",
      idempotencyKey: "rdlv-rule3-intent-001",
    });
    expect(sameIntentReplay.publicId).toBe(rdlvDead.publicId);
    expect(sameIntentReplay.state).toBe("dead");
    expect(h.jobs.enqueued).toHaveLength(0);

    await expect(
      adminCaller.production.order.redeliver({
        orderPublicId,
        dispatchPublicId: origDelivered.publicId,
        reason: "Attempting fresh redelivery while previous redelivery is dead",
        confirmation: "REDELIVER",
        idempotencyKey: "rdlv-rule3-intent-002",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining(rdlvDead.publicId),
      cause: expect.objectContaining({ reasonCode: "PRODUCTION_REDELIVERY_RETRY_REQUIRED" }),
    });

    // 4. Retrying `rdlvDead` via `production.order.retry` creates a retry in the `retryOf` chain carrying the SAME redelivery wire key!
    nextHttpHandler = async ({ headers }) => {
      const k = headers?.["Idempotency-Key"] ?? "";
      if (!committedByKey.has(k)) {
        committedByKey.add(k);
        downstreamRuns += 1;
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from('{"ok":true,"dedupedRedelivery":true}', "utf8"),
      };
    };
    const retriedRedelivery = await adminCaller.production.order.retry({
      orderPublicId,
      dispatchPublicId: rdlvDead.publicId,
    });
    expect(retriedRedelivery.retryOf).toBe(rdlvDead.publicId);
    expect(retriedRedelivery.redeliveryOf).toBe(origDelivered.publicId);
    expect(retriedRedelivery.idempotencyKey).toBe(rdlvWireKey);

    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    const retryHttp = httpCalls[httpCalls.length - 1]!;
    expect(retryHttp.headers?.["Idempotency-Key"]).toBe(rdlvWireKey);
    expect(retryHttp.headers?.["X-ReadyPackets-Redelivery-Of"]).toBe(origDelivered.publicId);
    expect(downstreamRuns).toBe(2);

    // Once the retried redelivery is delivered, further `retry` is refused with `PRODUCTION_ALREADY_DELIVERED`,
    // and an explicit new redelivery intent is unblocked again.
    await expect(
      adminCaller.production.order.retry({
        orderPublicId,
        dispatchPublicId: retriedRedelivery.publicId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: expect.objectContaining({ reasonCode: "PRODUCTION_ALREADY_DELIVERED" }),
    });

    const thirdRedeliver = await adminCaller.production.order.redeliver({
      orderPublicId,
      dispatchPublicId: origDelivered.publicId,
      reason: "Subsequent intentional redelivery after dead redelivery was resolved",
      confirmation: "REDELIVER",
      idempotencyKey: "rdlv-rule3-intent-003",
    });
    expect(thirdRedeliver.idempotencyKey).not.toBe(rdlvWireKey);
    await h.jobs.runAll(PRODUCTION_DELIVERY_JOB);
    expect(downstreamRuns).toBe(3);
  });
});
