import express from "express";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import { createProtectionModule } from "./index.js";
import { addressOf, defaultPolicy, parseNetwork, type ProtectionPolicy } from "./policy.js";
import { isRecoveryPath } from "./request.js";
import { protectionBlocks, protectionEvents, protectionPolicies } from "./schema.js";

describe("application protection", () => {
  let database: TestDb;
  beforeAll(async () => { database = await createTestDb({ schema: { protectionBlocks, protectionEvents, protectionPolicies } }); });
  afterAll(async () => { await database?.cleanup(); });

  function fixture(protectionDisabled = false, trustedProxy = true) {
    const h = createTestDeps({ db: database.db, config: { protectionDisabled, protectionCountryHeader: "x-readypackets-country" } });
    const admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
    let liveRole: "admin" | "customer" = "admin";
    let stepUpAt: Date | null = h.clock.now();
    h.services.identity = {
      sessions: { assertCurrent: async () => ({ role: liveRole, stepUpAt, pendingSteps: [], mfaVerifiedAt: null }) },
    } as unknown as typeof h.services.identity;
    const module = createProtectionModule(h.deps);
    const app = express();
    if (trustedProxy) app.set("trust proxy", "loopback");
    let outcome: Promise<unknown> | undefined;
    let change: { policy: ProtectionPolicy; version: number } | undefined;
    app.use((req, res, next) => {
      runWithRequestContext(newRequestContext("http", { ipAddress: req.ip }), () => {
        void (async () => {
          const decision = await module.inspect(req);
          if (decision.action === "block") return res.status(403).end();
          if (req.path === "/test-save" && change) {
            outcome = module.setPolicy(admin, change);
            try { await outcome; } catch { /* The test asserts the original promise. */ }
          }
          return res.json({ country: module.clientCountry() });
        })().catch(next);
      });
    });
    const http = supertest(app);
    const get = (path: string, address: string, country?: string) => {
      const request = http.get(path).set("X-Forwarded-For", address);
      return country ? request.set("X-ReadyPackets-Country", country) : request;
    };
    return {
      ...h, admin, module, get, http,
      setAuthorization(role: typeof liveRole, at: Date | null) { liveRole = role; stepUpAt = at; },
      async save(policy: ProtectionPolicy, version: number) {
        change = { policy, version };
        await get("/test-save", "198.51.100.90", "US").expect(200);
        return await outcome;
      },
    };
  }

  it("normalizes IPv4-mapped addresses and permits only canonical bounded networks", () => {
    expect(addressOf("::ffff:c633:640a")?.text).toBe("198.51.100.10");
    expect(parseNetwork("198.51.100.25/24")).toBeUndefined();
    expect(parseNetwork("198.51.100.0/24")?.length).toBe(24);
    expect(parseNetwork("2001:db8::/32")?.length).toBe(32);
    expect(parseNetwork("0.0.0.0/0")).toBeUndefined();
    expect(parseNetwork("::ffff:198.51.100.0/120")).toBeUndefined();
  });

  it("recovers only named methods and recovery-only batches", () => {
    expect(isRecoveryPath("/mfa/recovery-codes", "GET")).toBe(true);
    expect(isRecoveryPath("/api/trpc/identity.me,assurance.getstate", "GET")).toBe(true);
    expect(isRecoveryPath("/api/trpc/assurance.beginpasskeyauthentication", "POST")).toBe(true);
    expect(isRecoveryPath("/api/trpc/assurance.challenge,orders.admin.create", "POST")).toBe(false);
    expect(isRecoveryPath("/api/trpc/assurance.challenge", "GET")).toBe(false);
  });

  it("checks live authorization, step-up, atomic audit, recovery reachability and cross-request policy", async () => {
    const f = fixture();
    for (const actor of [null, fakePrincipal({ role: "customer" }), fakePrincipal({ role: "staff" }), fakePrincipal({ role: "admin", state: "remediation" })]) {
      await expect(f.module.getPolicy(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const enforce: ProtectionPolicy = { ...defaultPolicy, mode: "enforce" };
    f.setAuthorization("customer", f.clock.now());
    await expect(f.module.getPolicy(f.admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    f.setAuthorization("admin", null);
    await expect(f.save(enforce, 1)).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    f.setAuthorization("admin", f.clock.now());
    for (const policy of [
      { ...enforce, countries: { mode: "allow" as const, codes: ["CA"] } },
      { ...enforce, ipLists: [{ network: "198.51.100.0/24", action: "deny" as const, reason: "Synthetic example", expiresAt: null }] },
      { ...enforce, custom: [{ id: "22222222-2222-4222-8222-222222222222", label: "MFA path", field: "path" as const, operator: "contains" as const, value: "assurance.challenge", action: "block" as const }] },
    ]) {
      await expect(f.save(policy, 1)).rejects.toMatchObject({ reasonCode: "PROTECTION_SELF_LOCKOUT" });
    }
    f.audit.failRecords = true;
    await expect(f.save(enforce, 1)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(await f.module.getPolicy(f.admin)).toMatchObject({ version: 1, policy: { mode: "detect" } });
    f.audit.failRecords = false;
    const policy: ProtectionPolicy = {
      ...enforce,
      managed: { ...enforce.managed, traversal: "block" },
      countries: { mode: "deny", codes: ["CA"] },
      custom: [{ id: "33333333-3333-4333-8333-333333333333", label: "Synthetic test", field: "query", operator: "contains", value: "example-marker", action: "block" }],
      automatic: { enabled: true, threshold: 5, minutes: 10 },
    };
    await expect(f.save(policy, 1)).resolves.toMatchObject({ version: 2 });
    await expect(f.save(policy, 1)).rejects.toMatchObject({ reasonCode: "PROTECTION_VERSION_CONFLICT" });
    const untrusted = fixture(false, false);
    await untrusted.get("/other", "198.51.100.91", "CA").expect(200, { country: null });
    await f.get("/healthz", "198.51.100.91", "CA").expect(200);
    await f.get("/.well-known/acme-challenge/synthetic", "198.51.100.91", "CA").expect(200);
    await f.get("/mfa", "198.51.100.92", "US").query({ input: "example-marker" }).expect(200);
    await f.get("/api/trpc/identity.me,assurance.getstate", "198.51.100.92", "US").query({ batch: "1", input: "example-marker" }).expect(200);
    await f.get("/api/trpc/identity.me,orders.list", "198.51.100.92", "US").query({ batch: "1", input: "example-marker" }).expect(403);
    for (let i = 0; i < 5; i++) {
      await f.get("/another", "198.51.100.91", "CA").query({ input: "example-marker-do-not-copy" }).expect(403);
    }
    await f.get("/another", "198.51.100.91", "US").expect(403);
    const { automatic } = await f.module.listBlocks(f.admin);
    const block = automatic.find((r) => r.ipAddress === "198.51.100.91");
    expect(block).toBeDefined();
    await expect(f.module.releaseBlock(f.admin, { source: "automatic", publicId: block!.publicId })).resolves.toEqual({ released: true });
    await f.get("/another", "198.51.100.91", "US").expect(200);
    const all = await f.module.exportEvents(f.admin, {});
    expect(all.items.length).toBeGreaterThan(0);
    expect(all.items.length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(all)).not.toContain("example-marker");
    expect(JSON.stringify(f.audit.events)).not.toContain("198.51.100.91");
    expect(f.audit.events.some((event) => event.eventName === "protection.events_exported")).toBe(true);
    await fixture(true).get("/another", "198.51.100.91", "CA").expect(200, { country: "CA" });
  });
});
