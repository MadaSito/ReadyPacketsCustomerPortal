import express from "express";
import { eq } from "drizzle-orm";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { getRequestContext, newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import { ulid } from "../../core/ids.js";
import { clientAddress } from "../../http/edge.js";
import { createProtectionModule } from "./index.js";
import { defaultPolicy, type ProtectionPolicy } from "./policy.js";
import { protectionPolicies, protectionSignInBans, protectionSignInStrikes } from "./schema.js";
import { isSignInRequest, signInBanPolicySchema } from "./signInBans.js";

it("matches credential routes without gating session reads or unrelated requests", () => {
  for (const path of ["identity.signIn", "identity.resetPassword", "identity.activateAccount", "identity.requestPasswordReset",
    "identity.changePassword", "identity.register", "assurance.challenge", "assurance.beginPasskeyAuthentication",
    "assurance.recoverUnacknowledgedCodes", "identity.me,identity.signIn", "identity.me%2Cidentity.signIn"]) {
    expect(isSignInRequest({ method: "POST", path: `/api/trpc/${path}` })).toBe(true);
  }
  expect(isSignInRequest({ method: "POST", path: "/api/identity/sso/complete" })).toBe(true);
  expect(isSignInRequest({ method: "GET", path: "/api/identity/sso/callback" })).toBe(true);
  expect(isSignInRequest({ method: "GET", path: "/api/trpc/identity.me" })).toBe(false);
  expect(isSignInRequest({ method: "POST", path: "/api/trpc/identity.signInNonexistent" })).toBe(false);
  expect(signInBanPolicySchema.parse({})).toEqual({
    enabled: true, threshold: 10, windowMinutes: 10, banMinutes: 15,
    escalation: { factor: 4, maxMinutes: 1440, memoryHours: 24 }, permanentAfter: null, countDistinctAccounts: true,
  });
});

describe("durable sign-in bans", () => {
  let database: TestDb;
  beforeAll(async () => {
    database = await createTestDb({ schema: { protectionPolicies, protectionSignInBans, protectionSignInStrikes } });
  });
  afterAll(async () => { await database?.cleanup(); });

  function fixture(trustedProxies: string[] = ["127.0.0.1", "::1"], protectionDisabled = false) {
    const h = createTestDeps({ db: database.db, config: { trustedProxies, protectionDisabled } });
    const admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
    let steppedUp = true;
    h.services.identity = { sessions: {
      assertCurrent: async () => ({ role: "admin", pendingSteps: [], stepUpAt: steppedUp ? h.clock.now() : null }),
    } } as unknown as typeof h.services.identity;
    const protection = createProtectionModule(h.deps);
    const app = express();
    app.set("trust proxy", trustedProxies.length ? trustedProxies : false);
    let operation: () => Promise<unknown> = async () => null;
    let outcome: Promise<unknown>;
    app.use((req, res, next) => {
      runWithRequestContext(newRequestContext("http", { ipAddress: clientAddress(req) }), () => {
        protection.captureClientAddress(req);
        void (async () => {
          const wait = await protection.credentialRetryAfter(req);
          if (wait) return res.set("Retry-After", String(wait)).status(429).send("Too many requests");
          outcome = operation();
          try { await outcome; } catch { /* Assert the original error in the test. */ }
          return res.json(protection.clientAddressTrust());
        })().catch(next);
      });
    });
    const http = supertest(app);
    return {
      ...h, admin, protection,
      setStepUp(value: boolean) { steppedUp = value; },
      run(address: string, fn: () => Promise<unknown>) {
        operation = fn;
        return http.get("/test").set("X-Forwarded-For", address).expect(200).then(() => outcome);
      },
      signal(account: string, outcome: "success" | "failure" = "failure", ip = getRequestContext()?.ipAddress) {
        return protection.recordSignInSignal({
          ip, accountRef: h.deps.crypto.blindIndex(account, "protection.account_ref"), kind: "password",
          outcome, correlationId: getRequestContext()?.requestId ?? "", at: h.clock.now(),
        });
      },
      check(address?: string) {
        const req = http.post("/api/trpc/identity.me,identity.signIn");
        return address ? req.set("X-Forwarded-For", address) : req;
      },
    };
  }

  it("binds signals to verified request data, preserves other-account strikes, and escalates across instances in detect mode", async () => {
    const f = fixture();
    const address = "198.51.100.16";
    const options = signInBanPolicySchema.parse({ threshold: 3, banMinutes: 2 });
    await f.protection.setSignInBanPolicy(f.admin, options);
    await f.signal("other", "failure", address);
    await f.run(address, () => f.signal("different", "failure", "198.51.100.17"));
    await f.run(address, () => f.signal("first"));
    await f.run(address, () => f.signal("second"));
    await f.run(address, () => f.signal("second", "success"));
    expect(await f.protection.operatorListSignInBans()).toHaveLength(0);
    await f.run(address, () => f.signal("first"));
    await f.check(address).expect(429).expect("Retry-After", "120");
    expect(await f.protection.operatorListSignInBans()).toEqual([expect.objectContaining({ source: "automatic", strikes: 3 })]);
    expect(f.audit.events).toContainEqual(expect.objectContaining({
      eventName: "security.ban.created", correlationId: expect.any(String),
      attributes: { ban_public_id: expect.any(String), automatic: true, address_ref: expect.stringMatching(/^[a-f0-9]{32}$/) },
    }));
    expect(JSON.stringify(f.audit.events)).not.toContain(address);
    const replica = fixture();
    replica.clock.advance(120_001);
    await replica.protection.setSignInBanPolicy(replica.admin, options);
    await replica.check(address).expect(200);
    await replica.run(address, () => replica.signal("first"));
    await replica.run(address, () => replica.signal("second"));
    await replica.run(address, () => replica.signal("third"));
    await replica.check(address).expect(429).expect("Retry-After", "480");
    await replica.protection.operatorClearSignInBans();
    await replica.check(address).expect(200);
  });

  it("does not act with unverified addresses and refuses protected ranges or the current administrator", async () => {
    const f = fixture(["127.0.0.1", "::1", "192.0.2.20"]);
    const noProxy = fixture([]);
    await noProxy.check("198.51.100.23").expect(200, { determinable: false });
    await f.check().expect(200, { determinable: false });
    await f.check("192.0.2.20").expect(200, { determinable: false });
    await f.check("2001:db8::7, 198.51.100.24").expect(200, { determinable: true });
    const manually = { durationMinutes: null, reason: "Synthetic fixture" };
    const policy: ProtectionPolicy = { ...defaultPolicy, ipLists: [
      { network: "203.0.113.5/32", action: "allow", reason: "Synthetic allow", expiresAt: null },
    ] };
    await database.db.update(protectionPolicies).set({ policy });
    for (const address of ["127.0.0.0/8", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "::1"]) {
      await expect(f.run("198.51.100.23", () => f.protection.manualSignInBan(f.admin, { ...manually, address })))
        .rejects.toMatchObject({ reasonCode: "SIGNIN_BAN_PROTECTED_ADDRESS" });
    }
    await expect(f.run("127.0.0.1", () => f.protection.manualSignInBan(f.admin, { ...manually, address: "2001:db8:17::/48" })))
      .rejects.toMatchObject({ reasonCode: "ADMIN_ADDRESS_UNVERIFIABLE" });
    f.setStepUp(false);
    await expect(f.run("198.51.100.23", () => f.protection.manualSignInBan(f.admin, { ...manually, address: "2001:db8:17::/48" })))
      .rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    f.setStepUp(true);
    await f.run("198.51.100.23", () => f.protection.manualSignInBan(f.admin, { ...manually, address: "2001:db8:17::/48" }));
    await f.check("2001:db8:17:22::abc").expect(429).expect("Retry-After", "3600");
    await f.check("2001:db8:18::1").expect(200);
    await database.db.update(protectionPolicies).set({ policy: { ...policy, ipLists: [...policy.ipLists,
      { network: "2001:db8:17:22::1/128", action: "allow", reason: "New allow entry", expiresAt: null },
    ] } }).where(eq(protectionPolicies.id, 1));
    await f.check("2001:db8:17:22::1").expect(200);
    await f.check("2001:db8:17:22::abc").expect(429);
    const bypass = fixture(["127.0.0.1", "::1"], true);
    await bypass.check("2001:db8:17:22::abc").expect(200, { determinable: false });
    await expect(f.protection.listSignInBans(fakePrincipal({ role: "customer" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [item] = await f.protection.operatorListSignInBans();
    f.audit.failRecords = true;
    await expect(f.protection.operatorClearSignInBans(item!.publicId)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    await f.check("2001:db8:17:22::abc").expect(429);
    f.audit.failRecords = false;
    await expect(f.protection.releaseSignInBan(f.admin, { publicId: item!.publicId })).resolves.toEqual({ released: true });
    await f.check("2001:db8:17:22::abc").expect(200);
  });

  it("caps entries and evicts the oldest temporary ban without evicting permanent entries", async () => {
    const f = fixture();
    const now = f.clock.now().getTime();
    const rows = Array.from({ length: 512 }, (_, i) => {
      const addr = `198.18.${Math.floor(i / 256)}.${i % 256}`;
      const publicId = ulid(now - 600 + i);
      return {
        publicId, addressKey: f.deps.crypto.pseudonym(`${addr}/32`, "protection.signin_ban.address"),
        addressEnc: f.deps.crypto.encrypt(addr, `protection_signin_bans.address_enc:${publicId}`),
        source: "manual" as const, reason: "Synthetic seed", expiresAt: i === 0 ? null : new Date(now + 120_000),
        createdAt: new Date(now - 600 + i),
      };
    });
    await database.db.insert(protectionSignInBans).values(rows);
    await f.run("192.0.2.41", () => f.protection.manualSignInBan(f.admin, {
      address: "203.0.113.200", reason: "Synthetic manual ban", durationMinutes: 5,
    }));
    const active = await f.protection.operatorListSignInBans();
    expect(active).toHaveLength(512);
    expect(active.some((row) => row.publicId === rows[0]?.publicId)).toBe(true);
    expect(active.some((row) => row.publicId === rows[1]?.publicId)).toBe(false);
    expect(f.audit.events).toContainEqual(expect.objectContaining({
      eventName: "security.ban.released", attributes: expect.objectContaining({ ban_public_id: rows[1]?.publicId }),
    }));
  });
});
