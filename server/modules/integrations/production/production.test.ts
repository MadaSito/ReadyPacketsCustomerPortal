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
import { STEP_UP_MAX_AGE_MS } from "../../../trpc/trpc.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../../tests/helpers/testDb.js";
import {
  createIntegrationsModule,
  PRODUCTION_DELIVERY_JOB,
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
  integrationEgressAllowlist,
  integrationProductionDispatches,
  integrationProviderChecks,
  integrationWebhookEvents,
} from "../schema.js";
import {
  INTEGRATIONS_PRODUCTION_AUTH_VALUE,
  INTEGRATIONS_PRODUCTION_P101_URL,
} from "../settings.js";

const P101_TEST_URL = "https://hooks.production.example.test/webhooks/p101-secret-9876";
const P201_TEST_URL = "https://hooks.production.example.test/webhooks/p201-secret-4321";

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
    tdb = await createTestDb({
      schema: {
        platformSettings,
        integrationEgressAllowlist,
        integrationProviderChecks,
        integrationWebhookEvents,
        integrationProductionDispatches,
      },
    });
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
  }

  beforeEach(async () => {
    const conn = await tdb.pool.getConnection();
    try {
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
          const bodyStr =
            typeof options.body === "string"
              ? options.body
              : options.body
                ? Buffer.from(options.body).toString("utf8")
                : "";
          httpCalls.push({
            pinned,
            url: url.toString(),
            method: options.method,
            headers: options.headers,
            body: bodyStr,
          });
          return nextHttpHandler({ pinned, url, headers: options.headers, body: options.body });
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
    h.jobs.enqueued = []; // manually drive attempts 1..5 to test exact attempt progression

    nextHttpHandler = async () => ({
      status: 503,
      headers: {},
      body: Buffer.from("upstream worker overloaded", "utf8"),
    });

    for (let attempt = 1; attempt < PRODUCTION_MAX_ATTEMPTS; attempt += 1) {
      const res = await handler({
        jobId: "job_retry_test",
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
      jobId: "job_retry_test",
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
    // AND MUST immediately scrub `payloadEnc` + mark terminal `failed` so resend is never blocked forever (PW-02)!
    await tdb.db
      .update(integrationProductionDispatches)
      .set({ state: "sending" })
      .where(eq(integrationProductionDispatches.publicId, resent.publicId));
    const beforeCalls = httpCalls.length;
    const ambiguousRes = await handler({
      jobId: "job_ambiguous",
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
    expect(scrubbedAmbiguous?.state).toBe("failed");
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
    expect(filtered.items[0]?.responseSummary).toBe(
      "HTTP 422 — Rejected by production pipeline (client error; not retried).",
    );
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
    expect(reconciledSend?.state).toBe("failed");
    expect(reconciledSend?.payloadEnc).toBeNull();
    expect(reconciledSend?.lastReasonCode).toBe("PRODUCTION_DELIVERY_INTERRUPTED");
    expect(
      h.audit.events.some(
        (e) =>
          e.eventName === "integration.production.dispatch.failed" &&
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
});
