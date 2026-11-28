/**
 * Public API (/api/v1) engine + admin service against LOCAL FAKES ONLY: fake providers, fake audit, fake rate
 * limiter, fake identity, and the local dev MySQL test database. Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { DomainError } from "../../core/errors.js";
import { createJobQueue } from "../jobs/queue.js";
import { users } from "../identity/schema.js";
import { orders } from "../orders/schema.js";
import { createTrashRegistry } from "../trash/ports.js";
import type { SessionPrincipal } from "../../core/types.js";
import { TOKEN_RE, computeSignature, generateKeyToken, hasControlChar, ipAllowed, normaliseCidr, parseBearer } from "./credentials.js";
import type { ApiHttpRequest } from "./engine.js";
import { PURGE_JOB, createPublicApiModule, type ApiCaller, type KeyInput, type OrderDto, type PublicApiModule } from "./index.js";
import { apiIdempotency, apiKeys, apiRateWindows, apiRequestLog, apiSettings, apiSignatureNonces } from "./schema.js";

const CUSTOMER = "01JCVSTMR00000000000000001";
const ORDER = "01JQRDER000000000000000001";
const PRODUCT = "01JPRDCT000000000000000001";
const tables = [apiRequestLog, apiIdempotency, apiSignatureNonces, apiRateWindows, apiKeys, apiSettings, orders, users];

let db: TestDb;
let h: TestHarness;
let mod: PublicApiModule;
let admin: SessionPrincipal;
let calls: { op: string; caller: ApiCaller }[];
let liveRole: SessionPrincipal["role"];
let orderList: () => Promise<unknown>;
let createOrder: () => Promise<unknown>;

const order = (): OrderDto => ({
  id: ORDER,
  reference: "RP-2026-0001",
  customerId: CUSTOMER,
  status: { key: "new", label: "New" },
  currency: "USD",
  subtotalMinor: 1000,
  discountMinor: 0,
  totalMinor: 1000,
  items: [{ packetNumber: 1, tier: "gold", name: "Packet" }],
  version: 1,
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  submittedAt: null,
  closedAt: null,
});

beforeAll(async () => {
  db = await createTestDb({ schema: { apiSettings, apiKeys, apiRequestLog, apiIdempotency, apiSignatureNonces, apiRateWindows, users, orders } });
});
afterAll(() => db?.cleanup());

beforeEach(async () => {
  for (const t of tables) await db.db.delete(t);
  h = createTestDeps({ db: db.db });
  admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
  calls = [];
  liveRole = "admin";
  orderList = async () => ({ items: [{ ...order(), secretField: "x" }], nextCursor: null });
  createOrder = async () => order();
  h.services.identity = {
    sessions: { assertCurrent: async (p: SessionPrincipal) => ({ role: liveRole, stepUpAt: p.stepUpAt, pendingSteps: [], mfaVerifiedAt: p.mfaVerifiedAt }) },
  } as never;
  mod = createPublicApiModule(h.deps);
  h.services.publicApi = mod;
  mod.registerProvider("orders", {
    list: async (_q, caller) => (calls.push({ op: "list", caller }), orderList()) as never,
    get: async (id, caller) => (calls.push({ op: "get", caller }), id === ORDER ? order() : null),
    create: async (_input, caller) => (calls.push({ op: "create", caller }), createOrder()) as never,
    transition: async () => order(),
  });
});

const keyInput = (over: Partial<KeyInput> = {}): KeyInput => ({ name: "ERP sync", scopes: ["orders:read", "orders:write"], expiresAt: null, ipAllowList: [], rateLimitPerMinute: 100, requireSigning: false, ...over });

async function enable() {
  await mod.settings.update(admin, { expectedVersion: 0, enabled: true, retentionDays: 30 });
}

async function newKey(over: Partial<KeyInput> = {}) {
  return mod.keys.create(admin, keyInput(over));
}

function req(token: string | null, over: Partial<ApiHttpRequest> = {}): ApiHttpRequest {
  return { method: "GET", target: "/orders", headers: token ? { authorization: `Bearer ${token}` } : {}, body: Buffer.alloc(0), ipAddress: "203.0.113.5", ...over };
}

const createBody = JSON.stringify({ customerId: CUSTOMER, items: [{ productId: PRODUCT, tierKey: "gold", quantity: 1 }] });
function post(token: string, idem: string | undefined, body = createBody): ApiHttpRequest {
  return req(token, { method: "POST", body: Buffer.from(body), headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(idem ? { "idempotency-key": idem } : {}) } });
}

const json = (body: string) => JSON.parse(body) as Record<string, unknown>;

describe("credentials", () => {
  it("generates well-formed tokens and parses bearer headers strictly", () => {
    const { token, prefix } = generateKeyToken();
    expect(TOKEN_RE.test(token)).toBe(true);
    expect(parseBearer(`Bearer ${token}`)).toEqual({ token, prefix });
    expect(parseBearer(`bearer ${token}x`)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });
  it("normalises CIDRs and checks allow-lists", () => {
    expect(normaliseCidr("203.0.113.0/24")).toBe("203.0.113.0/24");
    expect(normaliseCidr("not-an-ip")).toBeNull();
    expect(ipAllowed("203.0.113.9", ["203.0.113.0/24"])).toBe(true);
    expect(ipAllowed("198.51.100.1", ["203.0.113.0/24"])).toBe(false);
    expect(ipAllowed(undefined, ["203.0.113.0/24"])).toBe(false);
    expect(ipAllowed("198.51.100.1", [])).toBe(true);
  });
  it("flags control characters", () => {
    expect(hasControlChar("a\u0000b")).toBe(true);
    expect(hasControlChar("plain")).toBe(false);
  });
});

describe("public API engine (local fakes only)", () => {
  it("is off by default: 404 for every call, but the OpenAPI document is served", async () => {
    const { token } = await newKey();
    expect((await mod.handle(req(token))).status).toBe(404);
    expect(await db.db.select().from(apiRequestLog)).toHaveLength(0);
    const doc = await mod.handle(req(null, { target: "/openapi.json" }));
    expect(doc.status).toBe(200);
    expect(json(doc.body)).toMatchObject({ openapi: expect.stringMatching(/^3\./u) });
  });

  it("enabling is audited", async () => {
    await enable();
    expect(h.audit.named("api.settings.enabled")).toHaveLength(1);
    await mod.settings.update(admin, { expectedVersion: 1, enabled: false, retentionDays: 30 });
    expect(h.audit.named("api.settings.disabled")).toHaveLength(1);
    await expect(mod.settings.update(admin, { expectedVersion: 1, enabled: true, retentionDays: 30 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("returns identical 401s for a wrong secret, an unknown prefix and a malformed token (no enumeration)", async () => {
    await enable();
    const { token } = await newKey();
    const wrongSecret = `${token.slice(0, 17)}${"2".repeat(40)}`;
    const unknownPrefix = `rpk_${"3".repeat(12)}_${token.slice(-40)}`;
    const results = await Promise.all([wrongSecret, unknownPrefix, "garbage", null].map((t) => mod.handle(req(t))));
    for (const r of results) {
      expect(r.status).toBe(401);
      expect(r.headers["www-authenticate"]).toContain("Bearer");
      const { request_id: _id, ...rest } = json(r.body);
      expect(rest).toEqual({ type: "urn:readypackets:problem:api_key_invalid", title: "Authentication required", status: 401, code: "API_KEY_INVALID" });
    }
    expect(h.rateLimiter.calls.filter((c) => c.category === "auth_high_risk")).toHaveLength(4);
    expect(h.audit.notes.filter((n) => n.eventName === "api.auth.denied")).toHaveLength(4);
  });

  it("throttles authentication floods with 429 and does not store them", async () => {
    await enable();
    h.rateLimiter.blocked.add("auth_high_risk");
    const r = await mod.handle(req("garbage"));
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBe("30");
    expect(await db.db.select().from(apiRequestLog)).toHaveLength(0);
  });

  it("refuses revoked and expired keys", async () => {
    await enable();
    const a = await newKey();
    await mod.keys.revoke(admin, a.key.keyId, a.key.version);
    expect((await mod.handle(req(a.token))).status).toBe(401);
    const b = await newKey({ expiresAt: new Date(h.clock.now().getTime() + 60_000) });
    expect((await mod.handle(req(b.token))).status).toBe(200);
    h.clock.advance(120_000);
    expect((await mod.handle(req(b.token))).status).toBe(401);
  });

  it("enforces the IP allow-list", async () => {
    await enable();
    const { token } = await newKey({ ipAllowList: ["198.51.100.0/24"] });
    const r = await mod.handle(req(token));
    expect(r.status).toBe(403);
    expect(json(r.body).code).toBe("IP_NOT_ALLOWED");
    expect((await mod.handle(req(token, { ipAddress: "198.51.100.7" }))).status).toBe(200);
  });

  it("verifies request signatures: valid once, stale and replayed refused", async () => {
    await enable();
    const { token, signingSecret } = await newKey({ requireSigning: true });
    expect(signingSecret).toBeTruthy();
    const now = Math.floor(h.clock.now().getTime() / 1000);
    const signed = (ts: number) => req(token, { headers: { authorization: `Bearer ${token}`, "x-rp-timestamp": String(ts), "x-rp-signature": computeSignature(signingSecret!, String(ts), "GET", "/api/v1/orders", Buffer.alloc(0)) } });
    expect((await mod.handle(req(token))).status).toBe(401);
    expect((await mod.handle(signed(now))).status).toBe(200);
    const replayed = await mod.handle(signed(now));
    expect(json(replayed.body).code).toBe("SIGNATURE_REPLAYED");
    const stale = await mod.handle(signed(now - 301));
    expect(json(stale.body).code).toBe("SIGNATURE_STALE");
    const bad = await mod.handle(req(token, { headers: { authorization: `Bearer ${token}`, "x-rp-timestamp": String(now), "x-rp-signature": `v1=${"0".repeat(64)}` } }));
    expect(json(bad.body).code).toBe("SIGNATURE_INVALID");
  });

  it("applies the per-key rate limit with RateLimit headers", async () => {
    await enable();
    const { token } = await newKey({ rateLimitPerMinute: 2 });
    const first = await mod.handle(req(token));
    expect(first.headers["ratelimit-limit"]).toBe("2");
    expect(first.headers["ratelimit-remaining"]).toBe("1");
    expect((await mod.handle(req(token))).status).toBe(200);
    const third = await mod.handle(req(token));
    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBeTruthy();
  });

  it("enforces scopes, routes and methods", async () => {
    await enable();
    const { token } = await newKey({ scopes: ["tickets:read"] });
    expect(json((await mod.handle(req(token))).body).code).toBe("INSUFFICIENT_SCOPE");
    expect((await mod.handle(req(token, { target: "/nope" }))).status).toBe(404);
    expect((await mod.handle(req(token, { method: "DELETE" }))).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it("validates query filters and bodies", async () => {
    await enable();
    const { token } = await newKey();
    expect(json((await mod.handle(req(token, { target: "/orders?evil=1" }))).body).code).toBe("INVALID_QUERY");
    expect(json((await mod.handle(req(token, { target: "/orders?status=a%00b" }))).body).code).toBe("INVALID_FILTER");
    expect((await mod.handle(req(token, { target: "/orders?status=new&limit=5" }))).status).toBe(200);
    const badBody = await mod.handle(post(token, "k1", JSON.stringify({ customerId: CUSTOMER, items: [], extra: true })));
    expect(badBody.status).toBe(422);
    const notJson = await mod.handle(req(token, { method: "POST", body: Buffer.from("x"), headers: { authorization: `Bearer ${token}`, "content-type": "text/plain", "idempotency-key": "k2" } }));
    expect(notJson.status).toBe(415);
    expect(calls).toHaveLength(1);
  });

  it("strips fields outside the DTO and wraps lists", async () => {
    await enable();
    const { token } = await newKey();
    const r = await mod.handle(req(token));
    expect(r.status).toBe(200);
    const body = json(r.body) as { data: Record<string, unknown>[]; next_cursor: null };
    expect(body.next_cursor).toBeNull();
    expect(body.data[0]).not.toHaveProperty("secretField");
    expect(body.data[0]!.id).toBe(ORDER);
    expect(calls[0]!.caller).toMatchObject({ kind: "api_key", scopes: ["orders:read", "orders:write"], replay: false });
  });

  it("returns 503 when a provider is not registered", async () => {
    await enable();
    const { token } = await newKey({ scopes: ["tickets:read"] });
    const r = await mod.handle(req(token, { target: "/tickets" }));
    expect(r.status).toBe(503);
    expect(json(r.body).code).toBe("RESOURCE_UNAVAILABLE");
  });

  it("requires an Idempotency-Key on writes and returns the stored response for repeats", async () => {
    await enable();
    const { token } = await newKey();
    expect(json((await mod.handle(post(token, undefined))).body).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const first = await mod.handle(post(token, "order-1"));
    expect(first.status).toBe(201);
    const again = await mod.handle(post(token, "order-1"));
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(calls.filter((c) => c.op === "create")).toHaveLength(1);
    const reused = await mod.handle(post(token, "order-1", JSON.stringify({ customerId: CUSTOMER, items: [{ productId: PRODUCT, tierKey: "gold", quantity: 2 }] })));
    expect(reused.status).toBe(422);
    expect(json(reused.body).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(h.audit.named("api.request.write").map((e) => e.outcome)).toEqual(["attempted", "completed"]);
  });

  it("keeps an unknown-outcome write reserved so it is not re-run", async () => {
    await enable();
    const { token } = await newKey();
    createOrder = async () => ({ broken: true });
    const first = await mod.handle(post(token, "order-2"));
    expect(json(first.body).code).toBe("PROVIDER_CONTRACT_VIOLATION");
    createOrder = async () => order();
    const retry = await mod.handle(post(token, "order-2"));
    expect(json(retry.body).code).toBe("IDEMPOTENCY_OUTCOME_UNKNOWN");
    expect(calls.filter((c) => c.op === "create")).toHaveLength(1);
    const reservations = await db.db.select().from(apiIdempotency);
    expect(reservations).toHaveLength(1);
    expect(JSON.stringify(reservations)).not.toContain("order-2");
    // Neither the unknown-outcome write, its refused retry, nor a write without Idempotency-Key is replayable.
    await mod.handle(post(token, undefined));
    const rows = (await mod.log.list(admin)).items;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      await expect(mod.log.replay(admin, row.requestId, { confirmWrite: true })).rejects.toMatchObject({ reasonCode: "API_REPLAY_UNAVAILABLE" });
    }
  });

  it("fails closed when the write audit is unavailable", async () => {
    await enable();
    const { token } = await newKey();
    h.audit.failRecords = true;
    const r = await mod.handle(post(token, "order-3"));
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(calls).toHaveLength(0);
  });

  it("logs without raw client input in clear columns", async () => {
    await enable();
    const { token } = await newKey();
    await mod.handle(req(token, { target: "/orders", headers: { authorization: `Bearer ${token}`, "x-correlation-id": "erp-batch.7" }, requestId: "01JHTTPREQ0000000000000002" }));
    await mod.handle(req(token, { target: `/zz/${token}`, headers: { authorization: `Bearer ${token}`, "x-correlation-id": token.slice(4, 60) } }));
    const rows = await db.db.select().from(apiRequestLog).orderBy(apiRequestLog.id);
    expect(rows[0]).toMatchObject({ publicId: "01JHTTPREQ0000000000000002", path: "/orders", route: "/orders" });
    expect(rows[0]!.correlationId).toMatch(/^c:/u);
    expect((await mod.log.list(admin, { correlationId: "erp-batch.7" })).items.map((i) => i.requestId)).toEqual(["01JHTTPREQ0000000000000002"]);
    expect(rows[1]).toMatchObject({ path: "unmatched", route: "unmatched", replayEnc: null });
    expect(rows[1]!.correlationId).toMatch(/^c:/u);
    expect(JSON.stringify(rows)).not.toContain(token.slice(-40));
    expect(JSON.stringify(rows)).not.toContain("erp-batch.7");
  });
});

describe("public API administration", () => {
  it("shows the token once and never stores it in clear", async () => {
    const created = await newKey({ requireSigning: true });
    expect(TOKEN_RE.test(created.token)).toBe(true);
    expect(created.key.prefix).toBe(created.token.slice(0, 16));
    const fetched = await mod.keys.get(admin, created.key.keyId);
    expect(JSON.stringify(fetched)).not.toContain(created.token.slice(-40));
    const [row] = await db.db.select().from(apiKeys);
    expect(JSON.stringify(row)).not.toContain(created.token.slice(-40));
    expect(JSON.stringify(row)).not.toContain(created.signingSecret!);
    expect(JSON.stringify(h.audit.events)).not.toContain(created.token.slice(-40));
    expect(h.audit.named("api.key.created")).toHaveLength(1);
  });

  it("rotates: the old token stops working immediately", async () => {
    await enable();
    const created = await newKey();
    const rotated = await mod.keys.rotate(admin, created.key.keyId, created.key.version);
    expect((await mod.handle(req(created.token))).status).toBe(401);
    expect((await mod.handle(req(rotated.token))).status).toBe(200);
    await expect(mod.keys.rotate(admin, created.key.keyId, created.key.version)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("validates key input", async () => {
    await expect(newKey({ name: "bad\u0000name" })).rejects.toMatchObject({ reasonCode: "API_KEY_NAME_INVALID" });
    await expect(newKey({ scopes: [] })).rejects.toMatchObject({ reasonCode: "API_KEY_SCOPES_REQUIRED" });
    await expect(newKey({ ipAllowList: ["999.1.1.1"] })).rejects.toMatchObject({ reasonCode: "API_KEY_IP_INVALID" });
    await expect(newKey({ rateLimitPerMinute: 0 })).rejects.toMatchObject({ reasonCode: "API_KEY_RATE_INVALID" });
    await expect(newKey({ expiresAt: new Date("2020-01-01T00:00:00Z") })).rejects.toMatchObject({ reasonCode: "API_KEY_EXPIRY_PAST" });
  });

  it("authorization matrix: non-admins, stale step-up and demoted admins are refused and audited", async () => {
    const customer = fakePrincipal({ role: "customer" });
    const staff = fakePrincipal({ role: "staff", stepUpAt: h.clock.now() });
    const noStepUp = fakePrincipal({ role: "admin", stepUpAt: null });
    for (const p of [customer, staff]) {
      await expect(mod.keys.list(p)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(mod.log.list(p)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(mod.log.replay(p, ORDER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(mod.keys.create(noStepUp, keyInput())).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    await expect(mod.log.replay(noStepUp, ORDER)).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    await expect(mod.log.list(noStepUp)).resolves.toMatchObject({ items: [] }); // reading the log needs no step-up
    liveRole = "staff";
    await expect(mod.keys.list(admin)).rejects.toBeInstanceOf(DomainError);
    expect(h.audit.named("api.admin.denied").length).toBeGreaterThanOrEqual(9);
  });

  it("lists and filters the request log, and shows redacted detail", async () => {
    await enable();
    const { token, key } = await newKey();
    await mod.handle(req(token));
    await mod.handle(req(token, { target: "/nope" }));
    const all = await mod.log.list(admin);
    expect(all.items).toHaveLength(2);
    expect((await mod.log.list(admin, { statusClass: "4xx" })).items).toHaveLength(1);
    expect((await mod.log.list(admin, { keyId: key.keyId, pathPrefix: "/orders" })).items).toHaveLength(1);
    expect((await mod.log.list(admin, { replay: true })).items).toHaveLength(0);
    const detail = await mod.log.get(admin, all.items[1]!.requestId);
    expect(detail.ipAddress).toBe("203.0.113.5");
    expect(JSON.stringify(detail)).not.toContain(token.slice(-40));
  });

  it("replays admitted calls only, under current scopes, with write confirmation", async () => {
    await enable();
    const { token, key } = await newKey();
    await mod.handle(post(token, "order-9"));
    await mod.handle(req(token, { target: "/orders?evil=1" }));
    const [write, refused] = (await mod.log.list(admin)).items.reverse();
    await expect(mod.log.replay(admin, write!.requestId)).rejects.toMatchObject({ reasonCode: "API_REPLAY_CONFIRM_WRITE" });
    const replayed = await mod.log.replay(admin, write!.requestId, { confirmWrite: true });
    expect(replayed.status).toBe(201);
    expect(calls.filter((c) => c.op === "create").map((c) => c.caller.replay)).toEqual([false, true]);
    expect(h.audit.named("api.request.replayed")).toHaveLength(1);
    await expect(mod.log.replay(admin, refused!.requestId)).rejects.toMatchObject({ reasonCode: "API_REPLAY_UNAVAILABLE" });
    const current = await mod.keys.get(admin, key.keyId);
    await mod.keys.update(admin, key.keyId, current.version, keyInput({ scopes: ["orders:read"] }));
    const denied = await mod.log.replay(admin, write!.requestId, { confirmWrite: true });
    expect(denied.status).toBe(403);
    expect((await mod.log.list(admin, { replay: true })).items).toHaveLength(2);
  });

  it("registers its job and schedule with the real job queue", () => {
    const real = createTestDeps({ db: db.db });
    real.deps.jobs = createJobQueue(real.deps);
    expect(() => createPublicApiModule(real.deps)).not.toThrow();
  });

  it("purges expired log rows on schedule", async () => {
    await enable();
    const { token } = await newKey();
    await mod.handle(req(token));
    expect(h.jobs.schedules).toContainEqual(expect.objectContaining({ type: PURGE_JOB, everyMs: 3_600_000 }));
    const handler = h.jobs.handlers.get(PURGE_JOB)!;
    expect((await handler({ payload: {} } as never)).outcome).toBe("completed");
    expect(await db.db.select().from(apiRequestLog)).toHaveLength(1);
    h.clock.advance(31 * 86_400_000);
    expect(await handler({ payload: {} } as never)).toMatchObject({ outcome: "completed" });
    expect(await db.db.select().from(apiRequestLog)).toHaveLength(0);
  });

  it("Increment 09 D2.2 / D2.6: hides trashed and tombstoned orders & customers (404 + absent from lists) and revokes/erases API keys on purge", async () => {
    const LIVE_CUSTOMER = "01JCVSTMR00000000000000002";
    const TRASHED_CUSTOMER = "01JCVSTMR00000000000000003";
    const PURGED_CUSTOMER = "01JCVSTMR00000000000000004";
    const LIVE_ORDER = "01JQRDER000000000000000002";
    const TRASHED_ORDER = "01JQRDER000000000000000003";
    const PURGED_ORDER = "01JQRDER000000000000000004";

    const now = h.clock.now();
    const [liveCustRes] = await db.db.insert(users).values({
      publicId: LIVE_CUSTOMER,
      customerRef: "RPCUS-A1B2CJJG5",
      role: "customer",
      status: "active",
      emailEnc: h.deps.crypto.encrypt("zeus.greene@example.test", `users.email:${LIVE_CUSTOMER}`),
      emailIndex: h.deps.crypto.blindIndex("zeus.greene@example.test", "users.email"),
      nameEnc: h.deps.crypto.encrypt("Zeus Greene", `users.name:${LIVE_CUSTOMER}`),
    });
    const liveCustId = Number(liveCustRes.insertId);

    const [trashedCustRes] = await db.db.insert(users).values({
      publicId: TRASHED_CUSTOMER,
      customerRef: "RPCUS-TRSH00001",
      role: "customer",
      status: "suspended",
      emailEnc: h.deps.crypto.encrypt("trashed.synthetic@example.test", `users.email:${TRASHED_CUSTOMER}`),
      emailIndex: h.deps.crypto.blindIndex("trashed.synthetic@example.test", "users.email"),
      nameEnc: h.deps.crypto.encrypt("Synthetic Trashed", `users.name:${TRASHED_CUSTOMER}`),
      trashedAt: now,
      trashBatchId: "01JETRASHBATCH000000000001",
    });
    const trashedCustId = Number(trashedCustRes.insertId);

    const [purgedCustRes] = await db.db.insert(users).values({
      publicId: PURGED_CUSTOMER,
      role: "customer",
      status: "deactivated",
      emailEnc: "tombstone",
      emailIndex: h.deps.crypto.blindIndex(`purged:${PURGED_CUSTOMER}`, "users.email"),
      nameEnc: "tombstone",
      trashedAt: now,
      purgedAt: now,
      trashBatchId: "01JETRASHBATCH000000000002",
    });
    const purgedCustId = Number(purgedCustRes.insertId);

    await db.db.insert(orders).values([
      {
        publicId: LIVE_ORDER,
        reference: "RP-2026-1001",
        ownerUserId: liveCustId,
        projectName: "Ice Queen",
        workflowVersionId: 1,
        statusKey: "new",
        subtotalMinor: 1000,
        totalMinor: 1000,
        currency: "USD",
      },
      {
        publicId: TRASHED_ORDER,
        reference: "RP-2026-1002",
        ownerUserId: liveCustId,
        projectName: "Ice Queen",
        workflowVersionId: 1,
        statusKey: "new",
        subtotalMinor: 1000,
        totalMinor: 1000,
        currency: "USD",
        trashedAt: now,
        trashBatchId: "01JETRASHBATCH000000000003",
      },
      {
        publicId: PURGED_ORDER,
        reference: "RP-2026-1003",
        ownerUserId: purgedCustId,
        projectName: "erased",
        workflowVersionId: 1,
        statusKey: "new",
        subtotalMinor: 1000,
        totalMinor: 1000,
        currency: "USD",
        trashedAt: now,
        purgedAt: now,
        trashBatchId: "01JETRASHBATCH000000000002",
      },
    ]);

    const trashRegistry = createTrashRegistry();
    h.services.trash = trashRegistry;
    await mod.init?.();

    const custDto = (id: string) => ({
      id,
      customerRef: id === LIVE_CUSTOMER ? "RPCUS-A1B2CJJG5" : null,
      displayName: "Zeus Greene",
      email: "zeus.greene@example.test",
      status: "active",
      createdAt: "2026-11-20T10:00:00.000Z",
      updatedAt: "2026-11-20T10:00:00.000Z",
    });

    mod.registerProvider("customers", {
      list: async () => ({
        items: [custDto(LIVE_CUSTOMER), custDto(TRASHED_CUSTOMER), custDto(PURGED_CUSTOMER)],
        nextCursor: null,
      }),
      get: async (id) => custDto(id),
    });
    mod.registerProvider("orderFiles", {
      list: async (orderId) => ({
        items: [
          {
            id: "01JFILE0000000000000000001",
            orderId,
            displayName: "packet.pdf",
            category: "deliverable",
            contentType: "application/pdf",
            size: 512,
            version: 1,
            createdAt: "2026-11-20T10:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    });

    orderList = async () => ({
      items: [
        { ...order(), id: LIVE_ORDER, customerId: LIVE_CUSTOMER },
        { ...order(), id: TRASHED_ORDER, customerId: LIVE_CUSTOMER },
        { ...order(), id: PURGED_ORDER, customerId: PURGED_CUSTOMER },
      ],
      nextCursor: null,
    });

    await enable();
    const { token } = await newKey({
      scopes: ["customers:read", "orders:read", "orders:write", "files:read"],
    });

    // Lists exclude trashed and tombstoned orders & customers
    const custListRes = await mod.handle(req(token, { target: "/customers" }));
    expect(custListRes.status).toBe(200);
    expect((json(custListRes.body).data as { id: string }[]).map((c) => c.id)).toEqual([LIVE_CUSTOMER]);

    const ordListRes = await mod.handle(req(token, { target: "/orders" }));
    expect(ordListRes.status).toBe(200);
    expect((json(ordListRes.body).data as { id: string }[]).map((o) => o.id)).toEqual([LIVE_ORDER]);

    // Single-item GET / files / transitions / create against trashed or tombstoned items answer 404
    expect((await mod.handle(req(token, { target: `/customers/${TRASHED_CUSTOMER}` }))).status).toBe(404);
    expect((await mod.handle(req(token, { target: `/customers/${PURGED_CUSTOMER}` }))).status).toBe(404);
    expect((await mod.handle(req(token, { target: `/orders/${TRASHED_ORDER}` }))).status).toBe(404);
    expect((await mod.handle(req(token, { target: `/orders/${PURGED_ORDER}` }))).status).toBe(404);
    expect((await mod.handle(req(token, { target: `/orders/${TRASHED_ORDER}/files` }))).status).toBe(404);
    expect(
      (
        await mod.handle(
          req(token, {
            method: "POST",
            target: `/orders/${TRASHED_ORDER}/transitions`,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "idempotency-key": "idem-trans-trashed",
            },
            body: Buffer.from(JSON.stringify({ toStatusKey: "closed", expectedVersion: 1 })),
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await mod.handle(
          post(
            token,
            "idem-create-trashed-cust",
            JSON.stringify({ customerId: TRASHED_CUSTOMER, items: [{ productId: PRODUCT, tierKey: "gold", quantity: 1 }] }),
          ),
        )
      ).status,
    ).toBe(404);

    // TrashParticipant: API keys belonging to a customer are revoked on trash and erased on purge
    const customerKeyPrincipal = fakePrincipal({ userId: trashedCustId, role: "admin", stepUpAt: h.clock.now() });
    const { token: custKeyToken } = await mod.keys.create(customerKeyPrincipal, keyInput({ name: "Customer key" }));
    // Because trashedCustId has trashedAt set, auth immediately refuses with 401
    expect((await mod.handle(req(custKeyToken))).status).toBe(401);

    const participant = trashRegistry.participants().find((p) => p.module === "publicApi")!;
    expect(participant).toBeDefined();
    expect(
      await participant.summarize!({
        kind: "customer",
        id: trashedCustId,
        publicId: TRASHED_CUSTOMER,
        batchId: "01JETRASHBATCH000000000001",
      }),
    ).toEqual({ apiKeys: 1 });

    await db.db.transaction(async (tx) => {
      await participant.onTrashedInTx!(
        tx,
        {
          kind: "customer",
          id: trashedCustId,
          publicId: TRASHED_CUSTOMER,
          batchId: "01JETRASHBATCH000000000001",
        },
        { kind: "system", job: "test" },
      );
    });

    const purgeResult = await participant.purge!(
      {
        kind: "customer",
        id: trashedCustId,
        publicId: TRASHED_CUSTOMER,
        batchId: "01JETRASHBATCH000000000001",
      },
      { runId: "01JEPURGERUN00000000000001" },
    );
    expect(purgeResult.deleted.apiKeys).toBe(1);
    expect(
      await participant.summarize!({
        kind: "customer",
        id: trashedCustId,
        publicId: TRASHED_CUSTOMER,
        batchId: "01JETRASHBATCH000000000001",
      }),
    ).toEqual({});
    expect((await mod.handle(req(custKeyToken))).status).toBe(401);
  });
});
