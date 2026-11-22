/**
 * Increment 04 package D regression tests on an isolated MySQL database (synthetic data only).
 * Session centre authz, forced ends (one / user / all customers, uncapped batches, idempotent under concurrency),
 * concurrency limit (stale rows after enabling), restrictions (validation, version, lock-out, disabling allowed),
 * IP / country admission at sign-in and per request, customer maintenance gates, referral attribution,
 * sign-in log rows, CSV export formula guard and IP filter by blind index.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext, runWithRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createIdentityModule, type IdentityModule } from "./index.js";
import { customerRefHistory, customerRefReservations, identityTokens, sessionRestrictions, signInEvents, users, userSessions } from "./schema.js";
import { admission, ipInCidrs, parseCidr, parseIp, DEFAULT_RESTRICTIONS, type Restrictions } from "./sessionPolicy.js";

const PW = "copper lantern drifts beyond quiet harbor";
const ADMIN_IP = "203.0.113.7";

async function rejects(promise: Promise<unknown>, reasonCode: string): Promise<DomainError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).reasonCode).toBe(reasonCode);
  return error as DomainError;
}

/* ------------------------------------------------------------------ pure policy */

describe("session policy (pure)", () => {
  it("parses IPv4, IPv6 and IPv4-mapped addresses; refuses junk", () => {
    expect(parseIp("203.0.113.7")?.normalized).toBe("203.0.113.7");
    expect(parseIp("::ffff:203.0.113.7")?.normalized).toBe("203.0.113.7");
    expect(parseIp("2001:DB8::1")?.normalized).toBe("2001:db8::1");
    for (const bad of ["", "300.1.1.1", "1.2.3", "01.2.3.4", "abc", "2001:db8::1::2", undefined]) expect(parseIp(bad as string)).toBeNull();
  });

  it("parses CIDRs with host bits zero within allowed prefix ranges and matches membership", () => {
    expect(parseCidr("203.0.113.0/24")?.normalized).toBe("203.0.113.0/24");
    expect(parseCidr("203.0.113.7")?.normalized).toBe("203.0.113.7/32");
    expect(parseCidr("203.0.113.1/24")).toBeNull();
    expect(parseCidr("10.0.0.0/4")).toBeNull();
    expect(parseCidr("2001:db8::/32")?.normalized).toBe("2001:db8::/32");
    expect(ipInCidrs(parseIp("203.0.113.7")!, [parseCidr("203.0.113.0/24")!])).toBe(true);
    expect(ipInCidrs(parseIp("203.0.114.7")!, [parseCidr("203.0.113.0/24")!])).toBe(false);
    expect(ipInCidrs(parseIp("2001:db8::5")!, [parseCidr("2001:db8::/32")!])).toBe(true);
    expect(ipInCidrs(parseIp("203.0.113.7")!, [parseCidr("2001:db8::/32")!])).toBe(false);
  });

  it("admission: disabled or break-glass admits; console allow-list applies to staff/admin only; country scopes", () => {
    const r: Restrictions = { ...DEFAULT_RESTRICTIONS, enabled: true, consoleIpAllowList: ["203.0.113.0/24"] };
    expect(admission({ ...r, enabled: false }, "admin", "198.51.100.1", null)).toBeNull();
    expect(admission(r, "admin", "198.51.100.1", null, true)).toBeNull();
    expect(admission(r, "admin", "198.51.100.1", null)).toBe("RESTRICTION_IP");
    expect(admission(r, "staff", null, null)).toBe("RESTRICTION_IP");
    expect(admission(r, "customer", "198.51.100.1", null)).toBeNull();
    expect(admission(r, "admin", ADMIN_IP, null)).toBeNull();
    const c: Restrictions = { ...DEFAULT_RESTRICTIONS, enabled: true, countryMode: "allow", countryScope: "customers", countries: ["US"], allowUnknownCountry: false };
    expect(admission(c, "customer", null, "US")).toBeNull();
    expect(admission(c, "customer", null, "GB")).toBe("RESTRICTION_COUNTRY");
    expect(admission(c, "customer", null, null)).toBe("RESTRICTION_COUNTRY");
    expect(admission(c, "admin", null, "GB")).toBeNull();
    expect(admission({ ...c, countryMode: "deny", countries: ["GB"], allowUnknownCountry: true }, "customer", null, null)).toBeNull();
    expect(admission({ ...c, countryMode: "deny", countries: ["GB"] }, "customer", null, "GB")).toBe("RESTRICTION_COUNTRY");
  });
});

/* ------------------------------------------------------------------ MySQL */

describe("session centre (MySQL)", () => {
  let db: TestDb;
  let h: TestHarness;
  let identity: IdentityModule;
  let seq = 0;
  let country: string | null = null;
  let maintenance = { active: false, message: null as string | null, expectedEnd: null as string | null };
  let referral: ReturnType<typeof vi.fn>;

  const ctx = (ip: string | undefined) => newRequestContext("test", ip ? { ipAddress: ip } : {});
  const at = <T>(ip: string | undefined, fn: () => Promise<T>) => runWithRequestContext(ctx(ip), fn);

  function build() {
    h = createTestDeps({ db: db.db });
    h.services.assurance = {
      getAssuranceState: async () => ({ mfaEnrolled: true, recoveryCodesAcknowledged: true, passkeyCount: 0, totpEnrolled: true }),
      lockLocalAdministratorPolicy: async () => {},
      assertLocalAdministratorMayLoseAccess: async () => {},
    } as unknown as Services["assurance"];
    country = null;
    maintenance = { active: false, message: null, expectedEnd: null };
    referral = vi.fn(async () => ({ attributed: true, referralPublicId: "01JD00000000000000000REF01" }));
    const services = h.services as unknown as Record<string, unknown>;
    services.protection = { clientCountry: () => country };
    services.jobAdmin = { maintenance: { customerAccess: async () => maintenance } };
    services.referrals = { attributeRegistration: referral };
    identity = createIdentityModule(h.deps);
    h.services.identity = identity;
  }

  async function makeUser(role: "customer" | "staff" | "admin" = "customer") {
    seq += 1;
    const email = `dc${seq}.${Date.now().toString(36)}@example.test`;
    const created = await db.db.transaction((tx) =>
      identity.auth.insertUser(tx as Tx, { email, name: `Synthetic D${seq}`, role, status: "active", origin: "test", emailVerifiedAt: h.clock.now() }),
    );
    await identity.setPassword(created.id, PW, { mustChange: false });
    h.audit.clear();
    return { ...created, email, role };
  }

  async function signIn(email: string, opts: { stepUp?: boolean; ip?: string } = {}): Promise<SessionPrincipal> {
    return at(opts.ip ?? ADMIN_IP, async () => {
      const signed = await identity.auth.signIn({ email, password: PW }, { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0" });
      let issued = await identity.sessions.markMfaVerified(signed.sessionId);
      if (opts.stepUp) issued = await identity.sessions.markStepUp(signed.sessionId);
      const principal = await identity.sessionResolver.resolve({ token: issued.token, transport: "cookie" });
      expect(principal).not.toBeNull();
      return principal!;
    });
  }

  /** Bulk-inserts live sessions directly (fast population setup). */
  async function insertSessions(userId: number, count: number, lastSeenAt = h.clock.now()) {
    const now = h.clock.now();
    for (let offset = 0; offset < count; offset += 500) {
      const rows = Array.from({ length: Math.min(500, count - offset) }, () => {
        const publicId = ulid();
        return {
          publicId, userId, tokenHash: h.deps.crypto.hashToken(`${publicId}-token`), csrfSecretEnc: "x", authMethod: "local" as const,
          authenticatedAt: lastSeenAt, lastSeenAt, absoluteExpiresAt: new Date(now.getTime() + 3_600_000), mfaVerifiedAt: lastSeenAt,
        };
      });
      await db.db.insert(userSessions).values(rows);
    }
  }

  const liveCount = async (userId: number) =>
    (await db.db.select({ id: userSessions.id }).from(userSessions).where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))).length;
  const events = async (userId: number) => db.db.select().from(signInEvents).where(eq(signInEvents.userId, userId));

  async function restrictionsInput(admin: SessionPrincipal, patch: Partial<Restrictions> = {}) {
    const view = await at(ADMIN_IP, () => identity.centre.getRestrictions(admin));
    return {
      expectedVersion: view.version, enabled: view.enabled, maxConcurrentPerUser: view.maxConcurrentPerUser,
      idleMinutes: view.idleMinutes, absoluteHours: view.absoluteHours, consoleIpAllowList: view.consoleIpAllowList,
      countryMode: view.countryMode, countryScope: view.countryScope, countries: view.countries, allowUnknownCountry: view.allowUnknownCountry,
      ...patch,
    };
  }

  beforeAll(async () => {
    db = await createTestDb({ schema: { users, userSessions, identityTokens, customerRefReservations, customerRefHistory, signInEvents, sessionRestrictions } });
  });
  afterAll(async () => db?.cleanup());
  beforeEach(async () => {
    await db.db.delete(sessionRestrictions);
    build();
  });

  describe("authorisation", () => {
    it("customers and staff cannot read the centre (admin-only capability); admins need step-up to end", async () => {
      const customer = await makeUser("customer");
      const staff = await makeUser("staff");
      const admin = await makeUser("admin");
      const c = await signIn(customer.email);
      const s = await signIn(staff.email);
      const a = await signIn(admin.email);
      await rejects(identity.centre.listSessions(c, {}), "CAPABILITY_NOT_GRANTED");
      await rejects(identity.centre.listSignInLog(c, {}), "CAPABILITY_NOT_GRANTED");
      await rejects(identity.centre.listSessions(s, {}), "CAPABILITY_NOT_GRANTED");
      await rejects(identity.centre.listSignInLog(s, {}), "CAPABILITY_NOT_GRANTED");
      const listed = await identity.centre.listSessions(a, { userId: customer.publicId });
      expect(listed.items.map((i) => i.user.publicId)).toEqual([customer.publicId]);
      await rejects(identity.centre.endSession(s, listed.items[0]!.sessionId, "SECURITY_REVIEW"), "CAPABILITY_NOT_GRANTED");
      await rejects(identity.centre.endAllCustomers(s, { reasonCode: "SECURITY_REVIEW" }), "CAPABILITY_NOT_GRANTED");
      await rejects(identity.centre.getRestrictions(s), "CAPABILITY_NOT_GRANTED");
      await rejects(identity.centre.endSession(a, listed.items[0]!.sessionId, "SECURITY_REVIEW"), "STEP_UP_REQUIRED");
      expect(await liveCount(customer.id)).toBe(1);
    });

    it("an admin cannot end their own current session from the centre", async () => {
      const admin = await makeUser("admin");
      const a = await signIn(admin.email, { stepUp: true });
      await rejects(identity.centre.endSession(a, a.sessionId, "SECURITY_REVIEW"), "OWN_SESSION");
    });

    it("an admin demoted after resolution is refused inside the transaction", async () => {
      const customer = await makeUser("customer");
      await signIn(customer.email);
      const admin = await makeUser("admin");
      const a = await signIn(admin.email, { stepUp: true });
      await db.db.update(users).set({ role: "staff" }).where(eq(users.id, admin.id));
      await expect(identity.centre.endForUser(a, customer.publicId, "SECURITY_REVIEW")).rejects.toBeInstanceOf(DomainError);
      expect(await liveCount(customer.id)).toBe(1);
    });
  });

  describe("forced ends", () => {
    it("end one session: audited in tx, logged as forced_end with the actor", async () => {
      const customer = await makeUser("customer");
      const target = await signIn(customer.email);
      const admin = await makeUser("admin");
      const a = await signIn(admin.email, { stepUp: true });
      await identity.centre.endSession(a, target.sessionId, "SUSPECTED_COMPROMISE");
      expect(await identity.sessionResolver.resolve({ token: "nope", transport: "cookie" })).toBeNull();
      expect(await liveCount(customer.id)).toBe(0);
      expect(h.audit.named("auth.session.ended_by_admin")[0]).toBeDefined();
      expect(h.audit.recordedInTx.every(Boolean)).toBe(true);
      const forced = (await events(customer.id)).filter((e) => e.kind === "forced_end");
      expect(forced).toHaveLength(1);
      expect(forced[0]).toMatchObject({ actorUserId: admin.id, sessionPublicId: target.sessionId });
      // Second end of the same session: nothing to end, no second log row.
      await expect(identity.centre.endSession(a, target.sessionId, "SUSPECTED_COMPROMISE")).rejects.toBeInstanceOf(DomainError);
      expect((await events(customer.id)).filter((e) => e.kind === "forced_end")).toHaveLength(1);
    });

    it("end all customers: only customers, more than one batch (no cap), audited, step-up required", async () => {
      const big = await makeUser("customer");
      const small = await makeUser("customer");
      const staff = await makeUser("staff");
      await insertSessions(big.id, 1_205);
      await insertSessions(small.id, 3);
      await insertSessions(staff.id, 2);
      const admin = await makeUser("admin");
      const plain = await signIn(admin.email);
      await rejects(identity.centre.endAllCustomers(plain, { reasonCode: "SECURITY_REVIEW" }), "STEP_UP_REQUIRED");
      const a = await signIn(admin.email, { stepUp: true });
      const result = await identity.centre.endAllCustomers(a, { reasonCode: "SECURITY_REVIEW" });
      expect(result.ended).toBeGreaterThanOrEqual(1_208);
      expect(await liveCount(big.id)).toBe(0);
      expect(await liveCount(small.id)).toBe(0);
      expect(await liveCount(staff.id)).toBe(2);
      expect(await liveCount(admin.id)).toBeGreaterThan(0);
      expect((await events(big.id)).filter((e) => e.kind === "forced_end")).toHaveLength(1_205);
      expect(h.audit.named("auth.session.ended_all_customers")[0]).toBeDefined();
    });

    it("concurrent end-all for the same user is idempotent: every session ended and logged exactly once", async () => {
      const customer = await makeUser("customer");
      await insertSessions(customer.id, 40);
      const admin = await makeUser("admin");
      const a = await signIn(admin.email, { stepUp: true });
      const results = await Promise.allSettled([
        identity.centre.endForUser(a, customer.publicId, "SECURITY_REVIEW"),
        identity.centre.endForUser(a, customer.publicId, "SECURITY_REVIEW"),
        identity.sessions.revokeAllForUser(customer.id, { reason: "admin_revoke" }),
      ]);
      const ended = results.map((r) => (r.status === "fulfilled" ? (typeof r.value === "number" ? r.value : r.value.ended) : 0));
      expect(ended.reduce((x, y) => x + y, 0)).toBe(40);
      expect(await liveCount(customer.id)).toBe(0);
      const ends = (await events(customer.id)).filter((e) => e.kind === "forced_end" || e.kind === "sign_out");
      expect(ends).toHaveLength(40);
      expect(new Set(ends.map((e) => e.sessionPublicId)).size).toBe(40);
    });
  });

  describe("restrictions", () => {
    it("validates input, enforces the expected version, audits enabling", async () => {
      const admin = await makeUser("admin");
      const a = await signIn(admin.email, { stepUp: true });
      await rejects(at(ADMIN_IP, async () => identity.centre.updateRestrictions(a, await restrictionsInput(a, { consoleIpAllowList: ["203.0.113.1/24"] }))), "RESTRICTIONS_INVALID");
      await rejects(at(ADMIN_IP, async () => identity.centre.updateRestrictions(a, await restrictionsInput(a, { countryMode: "allow", countries: [] }))), "RESTRICTIONS_INVALID");
      const input = await restrictionsInput(a, { enabled: true, maxConcurrentPerUser: 2 });
      const saved = await at(ADMIN_IP, () => identity.centre.updateRestrictions(a, input));
      expect(saved).toMatchObject({ enabled: true, maxConcurrentPerUser: 2, version: input.expectedVersion + 1 });
      expect(h.audit.named("identity.session_restrictions.enabled")[0]).toBeDefined();
      await rejects(at(ADMIN_IP, () => identity.centre.updateRestrictions(a, input)), "STALE_VERSION");
    });

    it("refuses settings that would lock the acting admin out (WOULD_LOCK_OUT); disabling is always allowed", async () => {
      const admin = await makeUser("admin");
      const a = await signIn(admin.email, { stepUp: true });
      await rejects(
        at(ADMIN_IP, async () => identity.centre.updateRestrictions(a, await restrictionsInput(a, { enabled: true, consoleIpAllowList: ["198.51.100.0/24"] }))),
        "WOULD_LOCK_OUT",
      );
      await at(ADMIN_IP, async () => identity.centre.updateRestrictions(a, await restrictionsInput(a, { enabled: true, consoleIpAllowList: ["203.0.113.0/24"] })));
      // Admin now on a network that is no longer allowed (e.g. moved): disabling must still succeed.
      const moved = await at(ADMIN_IP, async () => restrictionsInput(a, { enabled: false }));
      const off = await at("203.0.113.9", () => identity.centre.updateRestrictions(a, moved));
      expect(off.enabled).toBe(false);
      expect(h.audit.named("identity.session_restrictions.disabled")[0]).toBeDefined();
    });

    it("console allow-list refuses staff sign-in from outside and ends live sessions at the next request", async () => {
      const staff = await makeUser("staff");
      const admin = await makeUser("admin");
      const a = await signIn(admin.email, { stepUp: true });
      const s = await at("198.51.100.20", async () => {
        const signed = await identity.auth.signIn({ email: staff.email, password: PW }, {});
        return identity.sessions.markMfaVerified(signed.sessionId);
      });
      await at(ADMIN_IP, async () => identity.centre.updateRestrictions(a, await restrictionsInput(a, { enabled: true, consoleIpAllowList: ["203.0.113.0/24"] })));
      h.clock.advance(6_000); // past the 5 s policy cache
      expect(await at("198.51.100.20", () => identity.sessionResolver.resolve({ token: s.token, transport: "cookie" }))).toBeNull();
      await rejects(at("198.51.100.20", () => identity.auth.signIn({ email: staff.email, password: PW }, {})), "SESSION_RESTRICTED");
      const kinds = (await events(staff.id)).map((e) => [e.kind, e.reasonCode]);
      expect(kinds).toContainEqual(["forced_end", "RESTRICTION_IP"]);
      expect(kinds.some(([k]) => k === "refused")).toBe(true);
      // Customers are not subject to the console allow-list.
      const customer = await makeUser("customer");
      await signIn(customer.email, { ip: "198.51.100.20" });
    });

    it("country rule for customers refuses unknown/blocked countries at sign-in", async () => {
      const admin = await makeUser("admin");
      const a = await signIn(admin.email, { stepUp: true });
      country = "US";
      await at(ADMIN_IP, async () =>
        identity.centre.updateRestrictions(a, await restrictionsInput(a, { enabled: true, countryMode: "allow", countryScope: "customers", countries: ["US"], allowUnknownCountry: false })));
      h.clock.advance(6_000);
      const customer = await makeUser("customer");
      country = "GB";
      await rejects(at("198.51.100.30", () => identity.auth.signIn({ email: customer.email, password: PW }, {})), "SESSION_RESTRICTED");
      country = null;
      await rejects(at("198.51.100.30", () => identity.auth.signIn({ email: customer.email, password: PW }, {})), "SESSION_RESTRICTED");
      country = "US";
      await signIn(customer.email, { ip: "198.51.100.30" });
    });

    it("concurrency limit counts only effectively live rows: stale rows from before enabling are ended, newest kept", async () => {
      const customer = await makeUser("customer");
      // 5 stale-but-unrevoked rows (idle-expired) and 3 live ones from before the limit existed.
      await insertSessions(customer.id, 5, new Date(h.clock.now().getTime() - 6 * 60 * 60_000));
      await insertSessions(customer.id, 3);
      const admin = await makeUser("admin");
      const a = await signIn(admin.email, { stepUp: true });
      await at(ADMIN_IP, async () => identity.centre.updateRestrictions(a, await restrictionsInput(a, { enabled: true, maxConcurrentPerUser: 2 })));
      h.clock.advance(6_000);
      const fresh = await signIn(customer.email);
      const live = await db.db.select().from(userSessions).where(and(eq(userSessions.userId, customer.id), isNull(userSessions.revokedAt)));
      const effectivelyLive = live.filter((r) => r.lastSeenAt.getTime() > h.clock.now().getTime() - 60 * 60_000);
      expect(effectivelyLive).toHaveLength(2);
      expect(effectivelyLive.map((r) => r.publicId)).toContain(fresh.sessionId);
      const limited = (await events(customer.id)).filter((e) => e.reasonCode === "CONCURRENCY_LIMIT" || e.reasonCode === "concurrency_limit");
      expect(limited).toHaveLength(2);
    });

    it("idle timeout is role-specific", async () => {
      const admin = await makeUser("admin");
      const a = await signIn(admin.email, { stepUp: true });
      await at(ADMIN_IP, async () =>
        identity.centre.updateRestrictions(a, await restrictionsInput(a, { enabled: true, idleMinutes: { customer: 240, staff: 5, admin: null } })));
      const staff = await makeUser("staff");
      const customer = await makeUser("customer");
      const st = await at(ADMIN_IP, async () => identity.sessions.markMfaVerified((await identity.auth.signIn({ email: staff.email, password: PW }, {})).sessionId));
      const cu = await at(ADMIN_IP, async () => identity.sessions.markMfaVerified((await identity.auth.signIn({ email: customer.email, password: PW }, {})).sessionId));
      h.clock.advance(10 * 60_000);
      expect(await at(ADMIN_IP, () => identity.sessionResolver.resolve({ token: st.token, transport: "cookie" }))).toBeNull();
      expect(await at(ADMIN_IP, () => identity.sessionResolver.resolve({ token: cu.token, transport: "cookie" }))).not.toBeNull();
    });
  });

  describe("customer maintenance and referrals", () => {
    it("customer sign-in and registration are refused during maintenance; staff are not", async () => {
      const customer = await makeUser("customer");
      const staff = await makeUser("staff");
      maintenance = { active: true, message: null, expectedEnd: "2026-11-21T03:00:00.000Z" };
      const refused = await rejects(at(ADMIN_IP, () => identity.auth.signIn({ email: customer.email, password: PW }, {})), "CUSTOMER_MAINTENANCE");
      expect(refused.details).toMatchObject({ expectedEnd: "2026-11-21T03:00:00.000Z" });
      await rejects(identity.auth.register({ email: `m${Date.now()}@example.test`, name: "M", password: PW }, {}), "CUSTOMER_MAINTENANCE");
      await signIn(staff.email);
      expect((await events(customer.id)).some((e) => e.kind === "refused" && e.reasonCode === "CUSTOMER_MAINTENANCE")).toBe(true);
      expect(await liveCount(customer.id)).toBe(0);
    });

    it("attributes a referral code only for genuinely new accounts, never refusing on attribution failure", async () => {
      const email = `ref${Date.now()}@example.test`;
      await identity.auth.register({ email, name: "Ref New", password: PW, referralCode: "abcde12345" }, {});
      const newId = (await identity.findUserIdByEmail(email))?.userId;
      expect(referral).toHaveBeenCalledTimes(1);
      expect(referral.mock.calls[0]![0]).toBe("ABCDE12345");
      expect(referral.mock.calls[0]![1]).toBe(newId);
      await identity.auth.register({ email, name: "Again", password: PW, referralCode: "ABCDE12345" }, {});
      expect(referral).toHaveBeenCalledTimes(1);
      referral.mockRejectedValueOnce(new Error("boom"));
      const other = `ref2${Date.now()}@example.test`;
      await identity.auth.register({ email: other, name: "Ref Fail", password: PW, referralCode: "ABCDE12345" }, {});
      expect(await identity.findUserIdByEmail(other)).not.toBeNull();
      await identity.auth.register({ email: `ref3${Date.now()}@example.test`, name: "Bad code", password: PW, referralCode: "x" }, {});
      expect(referral).toHaveBeenCalledTimes(2);
    });
  });

  describe("sign-in log", () => {
    it("records success and failure with encrypted IP; filters by exact IP via blind index; never stores raw IP", async () => {
      const customer = await makeUser("customer");
      await signIn(customer.email, { ip: "198.51.100.44" });
      await rejects(at("198.51.100.45", () => identity.auth.signIn({ email: customer.email, password: "wrong passphrase entirely here" }, {})), "BAD_CREDENTIALS");
      const rows = await events(customer.id);
      expect(rows.map((r) => r.kind).sort()).toEqual(["failure", "success"]);
      expect(JSON.stringify(rows)).not.toContain("198.51.100.44");
      const admin = await makeUser("admin");
      const s = await signIn(admin.email);
      const hit = await identity.centre.listSignInLog(s, { ip: "198.51.100.44" });
      expect(hit.items.map((i) => [i.kind, i.ipAddress])).toEqual([["success", "198.51.100.44"]]);
      await rejects(identity.centre.listSignInLog(s, { ip: "198.51" }), "IP_INVALID");
    });

    it("own security overview shows only the caller's sessions and activity", async () => {
      const one = await makeUser("customer");
      const two = await makeUser("customer");
      const p1 = await signIn(one.email);
      await signIn(two.email);
      const view = await identity.centre.securityOverview(p1);
      expect(view.sessions.every((s) => s.current || s.sessionId !== p1.sessionId)).toBe(true);
      expect(view.sessions).toHaveLength(1);
      expect(view.activity.every((a) => a.current || a.kind !== "success" || a.ipAddress === ADMIN_IP)).toBe(true);
      expect(view.activity.length).toBeGreaterThan(0);
    });

    it("export is admin-only, step-up gated, audited, and neutralises spreadsheet formulas", async () => {
      seq += 1;
      const evil = await db.db.transaction((tx) =>
        identity.auth.insertUser(tx as Tx, { email: `evil${seq}@example.test`, name: "=HYPERLINK(\"x\")", role: "customer", status: "active", origin: "test", emailVerifiedAt: h.clock.now() }),
      );
      await identity.setPassword(evil.id, PW, { mustChange: false });
      await signIn(`evil${seq}@example.test`);
      const staff = await makeUser("staff");
      await rejects(identity.centre.exportSignInLog(await signIn(staff.email), {}), "CAPABILITY_NOT_GRANTED");
      const admin = await makeUser("admin");
      await rejects(identity.centre.exportSignInLog(await signIn(admin.email), {}), "STEP_UP_REQUIRED");
      const a = await signIn(admin.email, { stepUp: true });
      const out = await identity.centre.exportSignInLog(a, { userId: evil.publicId });
      expect(out.rows).toBeGreaterThan(0);
      expect(out.csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
      expect(out.csv).toContain("'=HYPERLINK");
      expect(h.audit.named("identity.sign_in_log.exported")[0]).toBeDefined();
    });
  });
});
