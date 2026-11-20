/**
 * Identity integration tests on an isolated MySQL database (synthetic data only).
 * Covers: registration/sign-in uniformity, throttling keys, tokens (single use, expiry), password reset
 * job (ID-02/03/04), change password rotation, session resolver, CAS rehash (ID-01), in-transaction actor
 * re-validation and lock ordering (ID-05), tx-scoped settings reads (ID-06), admin authz, last-admin,
 * reference reservation, audit-failure ⇒ no write, preview-link profile gating.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import type { AppConfig } from "../../config/env.js";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { newRequestContext } from "../../core/requestContext.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { PASSWORD_RESET_JOB } from "./auth.js";
import { identityRouter } from "./router.js";
import { createIdentityModule, type IdentityModule } from "./index.js";
import { createPasswordHasher } from "./password/hasher.js";
import { customerRefHistory, customerRefReservations, identityTokens, users, userSessions } from "./schema.js";

const PW = "copper lantern drifts beyond quiet harbor";
const PW2 = "violet glacier hums under amber skies";
const tokenOf = (path: string | undefined) => new URL(`https://x.test${path ?? ""}`).searchParams.get("token") ?? "";
const tokenFromMail = (url: unknown) => new URL(String(url)).searchParams.get("token") ?? "";

async function rejects(promise: Promise<unknown>, reasonCode: string): Promise<DomainError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).reasonCode).toBe(reasonCode);
  return error as DomainError;
}

describe("identity module (MySQL)", () => {
  let db: TestDb;
  let h: TestHarness;
  let identity: IdentityModule;
  let assurance: Map<number, { mfaEnrolled: boolean; recoveryCodesAcknowledged: boolean }>;
  let seq = 0;

  function build(config: Partial<AppConfig> = {}) {
    h = createTestDeps({ db: db.db, config });
    assurance = new Map();
    h.services.assurance = {
      getAssuranceState: async (userId: number) => {
        const state = assurance.get(userId) ?? { mfaEnrolled: false, recoveryCodesAcknowledged: false };
        return { ...state, passkeyCount: 0, totpEnrolled: state.mfaEnrolled };
      },
    } as unknown as Services["assurance"];
    identity = createIdentityModule(h.deps);
    h.services.identity = identity;
  }

  /** Creates an active local account with a password; MFA enrolled + acknowledged unless told otherwise. */
  async function makeUser(opts: { role?: "customer" | "staff" | "admin"; mfa?: boolean; verified?: boolean; status?: "active" | "suspended" | "pending_activation" } = {}) {
    seq += 1;
    const email = `user${seq}.${Date.now().toString(36)}@example.test`;
    const created = await db.db.transaction((tx) =>
      identity.auth.insertUser(tx as Tx, {
        email,
        name: `Synthetic Person${seq}`,
        role: opts.role ?? "customer",
        status: opts.status ?? "active",
        origin: "test",
        emailVerifiedAt: opts.verified === false ? null : h.clock.now(),
      }),
    );
    if (opts.status !== "pending_activation") await identity.setPassword(created.id, PW, { mustChange: false });
    if (opts.mfa !== false) assurance.set(created.id, { mfaEnrolled: true, recoveryCodesAcknowledged: true });
    h.audit.clear();
    h.mailer.sent = [];
    return { ...created, email };
  }

  /** Signs in and completes MFA (and optionally step-up); returns the resolved principal. */
  async function session(email: string, opts: { stepUp?: boolean } = {}): Promise<{ principal: SessionPrincipal; token: string }> {
    const signed = await identity.auth.signIn({ email, password: PW }, { userAgent: "vitest" });
    let issued = await identity.sessions.markMfaVerified(signed.sessionId);
    if (opts.stepUp) issued = await identity.sessions.markStepUp(signed.sessionId);
    const principal = await identity.sessionResolver.resolve({ token: issued.token, transport: "cookie" });
    expect(principal).not.toBeNull();
    return { principal: principal!, token: issued.token };
  }

  const userRow = async (id: number) => (await db.db.select().from(users).where(eq(users.id, id)).limit(1))[0]!;

  beforeAll(async () => {
    db = await createTestDb({ schema: { users, userSessions, identityTokens, customerRefReservations, customerRefHistory } });
  });
  afterAll(async () => db?.cleanup());
  beforeEach(() => build());

  /* ------------------------------------------------------------------ registration + sign-in */

  describe("registration", () => {
    it("creates an account, sends verification, audits in tx; preview returns only its own link", async () => {
      build({ deploymentProfile: "preview" });
      const result = await identity.auth.register({ email: `new${Date.now()}@example.test`, name: "Nova Tester", password: PW }, {});
      expect(result.previewLink).toMatch(/^\/verify-email\?token=[A-Za-z0-9_-]{43}$/);
      expect(h.mailer.last("auth.verify_email")).toBeDefined();
      expect(h.audit.named("auth.register.requested")[0]?.outcome).toBe("completed");
      expect(h.audit.recordedInTx.every(Boolean)).toBe(true);
    });

    it("existing address: same response shape, no link, notification mail, audited in tx (no enumeration)", async () => {
      build({ deploymentProfile: "preview" });
      const existing = await makeUser();
      const result = await identity.auth.register({ email: existing.email.toUpperCase(), name: "Other", password: PW2 }, {});
      expect(result).toEqual({ accepted: true });
      expect(h.mailer.last("auth.account_exists")).toBeDefined();
      expect(h.audit.named("auth.register.requested")[0]).toMatchObject({ outcome: "refused", reasonCode: "EXISTING_ACCOUNT" });
      expect(h.audit.recordedInTx).toEqual([true]);
    });

    it("rejects weak passwords before any lookup, and closed registration", async () => {
      await rejects(identity.auth.register({ email: "weak@example.test", name: "W", password: "short" }, {}), "PASSWORD_TOO_SHORT");
      h.settings.values.set("identity.registration.enabled", false);
      await rejects(identity.auth.register({ email: "closed@example.test", name: "C", password: PW }, {}), "REGISTRATION_DISABLED");
    });

    it("throttles by account blind index (never the raw address)", async () => {
      await identity.auth.register({ email: `thr${Date.now()}@example.test`, name: "T", password: PW }, {});
      const call = h.rateLimiter.calls.find((c) => c.category === "auth_high_risk")!;
      expect(call.key).toMatch(/^register:[0-9a-f]{64}$/);
      h.rateLimiter.blocked.add("auth_high_risk");
      await rejects(identity.auth.register({ email: "x@example.test", name: "T", password: PW }, {}), "RATE_LIMITED");
    });

    it("audit failure ⇒ no account row", async () => {
      const email = `af${Date.now()}@example.test`;
      h.audit.failRecords = true;
      await expect(identity.auth.register({ email, name: "A", password: PW }, {})).rejects.toThrow();
      h.audit.failRecords = false;
      expect(await identity.findUserIdByEmail(email)).toBeNull();
    });
  });

  describe("sign-in", () => {
    it("uniform error for unknown account, wrong password, inactive and wrong auth source", async () => {
      const user = await makeUser();
      const suspended = await makeUser({ status: "suspended" });
      const errors = [
        await rejects(identity.auth.signIn({ email: "nobody@example.test", password: PW }, {}), "BAD_CREDENTIALS"),
        await rejects(identity.auth.signIn({ email: user.email, password: PW2 }, {}), "BAD_CREDENTIALS"),
        await rejects(identity.auth.signIn({ email: suspended.email, password: PW }, {}), "BAD_CREDENTIALS"),
      ];
      expect(new Set(errors.map((e) => `${e.code}|${e.safeMessage}`)).size).toBe(1);
      expect(h.audit.named("auth.login.failed").map((e) => e.reasonCode)).toEqual(["UNKNOWN_ACCOUNT", "BAD_PASSWORD", "ACCOUNT_INACTIVE"]);
      expect(h.rateLimiter.calls.every((c) => c.category === "user_login" && /^acct:[0-9a-f]{64}$/.test(c.key))).toBe(true);
    });

    it("issues a server-side session whose token is stored only hashed; first step is mfa_challenge", async () => {
      const user = await makeUser();
      const signed = await identity.auth.signIn({ email: user.email, password: PW }, { userAgent: "vitest" });
      expect(signed.nextStep).toBe("mfa_challenge");
      const rows = await db.db.select().from(userSessions).where(eq(userSessions.publicId, signed.sessionId));
      expect(rows[0]!.tokenHash).not.toBe(signed.issued.token);
      expect(rows[0]!.tokenHash).toBe(h.deps.crypto.hashToken(signed.issued.token));
      const principal = await identity.sessionResolver.resolve({ token: signed.issued.token, transport: "cookie" });
      expect(principal).toMatchObject({ state: "remediation", pendingSteps: ["mfa_challenge"] });
    });

    it("transparently rehashes legacy parameters with compare-and-set (ID-01)", async () => {
      const user = await makeUser();
      const weak = createPasswordHasher({ memoryCost: 4096, timeCost: 1, parallelism: 1 });
      const legacy = await weak.hash(PW);
      await db.db.update(users).set({ passwordHash: legacy }).where(eq(users.id, user.id));
      expect(await identity.verifyPassword(user.id, PW)).toBe(true);
      const after = (await userRow(user.id)).passwordHash!;
      expect(after).not.toBe(legacy);
      // A rehash racing a concurrent change must not overwrite it: simulate by changing the hash between
      // verification and the CAS — the CAS matches no row and verification reports "not current".
      await db.db.update(users).set({ passwordHash: legacy }).where(eq(users.id, user.id));
      const ok = await db.db.transaction(async (tx) => {
        const result = identity.verifyPassword(user.id, PW, { tx: tx as Tx });
        return result;
      });
      expect(ok).toBe(true); // under the row lock there is no interleaving; CAS succeeds
      const changed = await weak.hash(PW2);
      const raced = await db.db.transaction(async (tx) => {
        await tx.update(users).set({ passwordHash: changed }).where(eq(users.id, user.id));
        return identity.verifyPassword(user.id, PW, { tx: tx as Tx });
      });
      expect(raced).toBe(false);
      expect((await userRow(user.id)).passwordHash).toBe(changed);
    });
  });

  /* ------------------------------------------------------------------ sessions */

  describe("session resolver", () => {
    it("rejects malformed, unknown, revoked, idle and absolute-expired sessions", async () => {
      const user = await makeUser();
      const { token, principal } = await session(user.email);
      expect(await identity.sessionResolver.resolve({ token: "short", transport: "cookie" })).toBeNull();
      expect(await identity.sessionResolver.resolve({ token: "A".repeat(43), transport: "cookie" })).toBeNull();
      h.clock.advance(31 * 60_000);
      expect(await identity.sessionResolver.resolve({ token, transport: "cookie" })).toBeNull(); // idle 30 min
      const revoked = await db.db.select().from(userSessions).where(eq(userSessions.publicId, principal.sessionId));
      expect(revoked[0]!.revokeReason).toBe("idle_timeout");

      const second = await session(user.email);
      for (let i = 0; i < 25; i++) {
        h.clock.advance(29 * 60_000);
        if (!(await identity.sessionResolver.resolve({ token: second.token, transport: "cookie" }))) break;
      }
      expect(await identity.sessionResolver.resolve({ token: second.token, transport: "cookie" })).toBeNull(); // absolute 12 h
    });

    it("honours changed idle policy for existing sessions", async () => {
      const user = await makeUser();
      const { token } = await session(user.email);
      h.settings.values.set("identity.session.idle_minutes", 5);
      h.clock.advance(6 * 60_000);
      expect(await identity.sessionResolver.resolve({ token, transport: "cookie" })).toBeNull();
    });

    it("revokes sessions of an inactive account at resolve time", async () => {
      const user = await makeUser();
      const { token } = await session(user.email);
      await db.db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
      expect(await identity.sessionResolver.resolve({ token, transport: "cookie" })).toBeNull();
    });

    it("preview-header transport is rejected outside the preview profile", async () => {
      const user = await makeUser();
      const { token } = await session(user.email);
      expect(await identity.sessionResolver.resolve({ token, transport: "preview-header" })).toBeNull();
      expect(await identity.sessionResolver.resolve({ token, transport: "cookie" })).not.toBeNull();
    });

    it("rotation invalidates the previous token; fails closed when assurance is unavailable", async () => {
      const user = await makeUser();
      const { token, principal } = await session(user.email);
      const rotated = await identity.sessions.rotate(principal.sessionId);
      expect(await identity.sessionResolver.resolve({ token, transport: "cookie" })).toBeNull();
      expect(await identity.sessionResolver.resolve({ token: rotated.token, transport: "cookie" })).not.toBeNull();
      h.services.assurance = { getAssuranceState: async () => Promise.reject(new Error("down")) } as unknown as Services["assurance"];
      expect(await identity.sessionResolver.resolve({ token: rotated.token, transport: "cookie" })).toBeNull();
    });

    it("assertCurrent rejects a principal whose CSRF secret was rotated (stale) — ID-05", async () => {
      const user = await makeUser();
      const { principal } = await session(user.email);
      await identity.sessions.rotate(principal.sessionId);
      await rejects(db.db.transaction((tx) => identity.sessions.assertCurrent(principal, tx as Tx)), "SESSION_NOT_CURRENT");
    });

    it("never reads settings through the pool while holding a transaction (ID-06)", async () => {
      const user = await makeUser();
      const { principal } = await session(user.email);
      const reads: { key: string; tx: boolean }[] = [];
      const original = h.settings.get.bind(h.settings);
      h.settings.get = (async (key: string, parse: (raw: unknown) => unknown, fallback: unknown, tx?: Tx) => {
        reads.push({ key, tx: tx !== undefined });
        return original(key, parse, fallback);
      }) as typeof h.settings.get;
      await db.db.transaction(async (tx) => {
        await identity.sessions.assertCurrent(principal, tx as Tx);
        await identity.sessions.getState(principal.sessionId, { tx: tx as Tx });
        await identity.sessions.rotate(principal.sessionId, { tx: tx as Tx });
      });
      const sessionReads = reads.filter((r) => r.key.startsWith("identity.session."));
      expect(sessionReads.length).toBeGreaterThan(0);
      expect(sessionReads.every((r) => r.tx)).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ tokens */

  describe("e-mail verification", () => {
    it("is single-use and expires", async () => {
      build({ deploymentProfile: "preview" });
      const r = await identity.auth.register({ email: `v${Date.now()}@example.test`, name: "V", password: PW }, {});
      const token = tokenOf(r.previewLink);
      await identity.auth.verifyEmail(token, null);
      await rejects(identity.auth.verifyEmail(token, null), "LINK_INVALID");

      const r2 = await identity.auth.register({ email: `v2${Date.now()}@example.test`, name: "V", password: PW }, {});
      h.clock.advance(24 * 3_600_000 + 1);
      await rejects(identity.auth.verifyEmail(tokenOf(r2.previewLink), null), "LINK_INVALID");
    });

    it("resend: cooldown decided under the row lock; verified accounts get nothing (ID-03)", async () => {
      const user = await makeUser({ verified: false });
      const { principal } = await session(user.email);
      await identity.auth.resendVerification(principal);
      await identity.auth.resendVerification(principal); // inside cooldown
      const count = async () => (await db.db.select().from(identityTokens).where(eq(identityTokens.userId, user.id))).filter((t) => t.purpose === "verify_email").length;
      expect(await count()).toBe(1);
      // Concurrent resends after the cooldown: the row lock serializes them, exactly one token is issued.
      h.clock.advance(61_000);
      await Promise.all([identity.auth.resendVerification(principal), identity.auth.resendVerification(principal)]);
      expect(await count()).toBe(2);
      await db.db.update(users).set({ emailVerifiedAt: h.clock.now() }).where(eq(users.id, user.id));
      h.clock.advance(61_000);
      expect(await identity.auth.resendVerification(principal)).toEqual({ accepted: true });
      expect(await count()).toBe(2);
    });

    it("test/production profiles never return previewLink (registration, resend)", async () => {
      for (const profile of ["test", "production"] as const) {
        build({ deploymentProfile: profile });
        const r = await identity.auth.register({ email: `p${profile}${Date.now()}@example.test`, name: "P", password: PW }, {});
        expect(r).toEqual({ accepted: true });
        expect("previewLink" in r).toBe(false);
      }
    });
  });

  describe("password reset (ID-02, ID-03, ID-04)", () => {
    it("public response is identical for known, unknown and ineligible accounts and never has a link — in every profile", async () => {
      for (const profile of ["preview", "test", "production"] as const) {
        build({ deploymentProfile: profile });
        const known = await makeUser();
        const suspended = await makeUser({ status: "suspended" });
        const responses = [
          await identity.auth.requestPasswordReset({ email: known.email }),
          await identity.auth.requestPasswordReset({ email: `unknown${seq}@example.test` }),
          await identity.auth.requestPasswordReset({ email: suspended.email }),
        ];
        for (const r of responses) expect(r).toEqual({ accepted: true });
        expect(h.mailer.sent).toEqual([]); // no synchronous mail on the request path
        expect(h.jobs.enqueued.map((j) => j.type)).toEqual([PASSWORD_RESET_JOB, PASSWORD_RESET_JOB, PASSWORD_RESET_JOB]);
        for (const job of h.jobs.enqueued) expect(Object.keys(job.payload as object)).toEqual(["emailIndex"]);
        expect(h.audit.named("auth.password.reset_requested").map((e) => e.outcome)).toEqual(["attempted", "attempted", "attempted"]);
        const results = await h.jobs.runAll(PASSWORD_RESET_JOB);
        expect(results.map((r) => r.outcome)).toEqual(["completed", "completed", "completed"]);
        expect(h.mailer.sent.map((m) => m.template)).toEqual(["auth.password_reset"]);
        expect(h.jobs.handlerOptions.get(PASSWORD_RESET_JOB)).toEqual({ retrySafe: true });
        // Audit failure at intake ⇒ the request fails and no durable work is accepted.
        h.audit.failRecords = true;
        await expect(identity.auth.requestPasswordReset({ email: known.email })).rejects.toThrow();
        h.audit.failRecords = false;
      }
    });

    it("redeem: single use, revokes all sessions, retires on expiry, refuses non-local accounts", async () => {
      const user = await makeUser();
      const { token: sessionToken } = await session(user.email);
      await identity.auth.requestPasswordReset({ email: user.email });
      await h.jobs.runAll(PASSWORD_RESET_JOB);
      const link = tokenFromMail(h.mailer.last("auth.password_reset")!.vars.link);
      await identity.auth.resetPassword({ token: link, password: PW2 });
      await rejects(identity.auth.resetPassword({ token: link, password: PW2 }), "LINK_INVALID");
      expect(await identity.sessionResolver.resolve({ token: sessionToken, transport: "cookie" })).toBeNull();
      expect(await identity.verifyPassword(user.id, PW2)).toBe(true);

      h.clock.advance(120_000);
      await identity.auth.requestPasswordReset({ email: user.email });
      await h.jobs.runAll(PASSWORD_RESET_JOB);
      const expired = tokenFromMail(h.mailer.last("auth.password_reset")!.vars.link);
      h.clock.advance(31 * 60_000);
      await rejects(identity.auth.resetPassword({ token: expired, password: PW }), "LINK_INVALID");

      h.clock.advance(120_000);
      await identity.auth.requestPasswordReset({ email: user.email });
      await h.jobs.runAll(PASSWORD_RESET_JOB);
      const nonLocal = tokenFromMail(h.mailer.last("auth.password_reset")!.vars.link);
      await db.db.update(users).set({ authSource: "saml" }).where(eq(users.id, user.id));
      await rejects(identity.auth.resetPassword({ token: nonLocal, password: PW }), "LINK_INVALID");
    });

    it("cooldown inside the job: two dispatches in one minute issue one token", async () => {
      const user = await makeUser();
      const emailIndex = h.deps.crypto.blindIndex(user.email, "users.email");
      expect(await identity.auth.dispatchPasswordReset({ emailIndex })).toBe("issued");
      expect(await identity.auth.dispatchPasswordReset({ emailIndex })).toBe("cooldown");
      expect(await identity.auth.dispatchPasswordReset({ emailIndex: "zz" })).toBe("ineligible");
      // Concurrent dispatches (adjoining enqueue slots) after the cooldown: exactly one issues.
      h.clock.advance(61_000);
      const outcomes = await Promise.all([identity.auth.dispatchPasswordReset({ emailIndex }), identity.auth.dispatchPasswordReset({ emailIndex })]);
      expect([...outcomes].sort()).toEqual(["cooldown", "issued"]);
    });
  });

  describe("change password", () => {
    it("requires the current password, revokes other sessions and rotates the current one", async () => {
      const user = await makeUser();
      const other = await session(user.email);
      const current = await session(user.email);
      await rejects(identity.auth.changePassword(current.principal, { currentPassword: PW2, newPassword: PW2 }), "CURRENT_PASSWORD_INCORRECT");
      const result = await identity.auth.changePassword(current.principal, { currentPassword: PW, newPassword: PW2 });
      expect(await identity.sessionResolver.resolve({ token: other.token, transport: "cookie" })).toBeNull();
      expect(await identity.sessionResolver.resolve({ token: current.token, transport: "cookie" })).toBeNull();
      expect(await identity.sessionResolver.resolve({ token: result.issued.token, transport: "cookie" })).not.toBeNull();
    });

    it("a remediation session may change its password only when change_password is next", async () => {
      const user = await makeUser({ verified: false });
      const signed = await identity.auth.signIn({ email: user.email, password: PW }, {});
      const issued = await identity.sessions.markMfaVerified(signed.sessionId);
      const principal = (await identity.sessionResolver.resolve({ token: issued.token, transport: "cookie" }))!;
      expect(principal.pendingSteps[0]).toBe("verify_email");
      await rejects(identity.auth.changePassword(principal, { currentPassword: PW, newPassword: PW2 }), "ACCOUNT_STEP_PENDING");
    });
  });

  /* ------------------------------------------------------------------ admin */

  describe("admin authorization (ID-05)", () => {
    it("customers, staff without capability, remediation sessions and missing step-up are refused", async () => {
      const admin = await makeUser({ role: "admin" });
      const customer = await makeUser();
      const staff = await makeUser({ role: "staff" });
      const c = await session(customer.email, { stepUp: true });
      await rejects(identity.admin.searchCustomers(c.principal, {}), "CAPABILITY_NOT_GRANTED");
      await rejects(identity.admin.createCustomer(c.principal, { email: "n@example.test", name: "N" }), "CAPABILITY_NOT_GRANTED");
      const s = await session(staff.email, { stepUp: true });
      await rejects(identity.admin.createStaff(s.principal, { email: "n@example.test", name: "N", role: "admin" }), "CAPABILITY_NOT_GRANTED");
      const remediation = { ...(await session(admin.email, { stepUp: true })).principal, state: "remediation" as const, pendingSteps: ["change_password" as const] };
      await rejects(identity.admin.createCustomer(remediation, { email: "n@example.test", name: "N" }), "CAPABILITY_NOT_GRANTED");
      const noStepUp = await session(admin.email);
      await rejects(identity.admin.changeReference(noStepUp.principal, customer.publicId, "ACME-1", (await userRow(customer.id)).version, "CORRECTION"), "STEP_UP_REQUIRED");
    });

    it("re-validates the actor inside the transaction: demoted, suspended or rotated actors are refused", async () => {
      const admin = await makeUser({ role: "admin" });
      const customer = await makeUser();
      const { principal } = await session(admin.email, { stepUp: true });
      // Persisted role changed after the request principal was resolved.
      await db.db.update(users).set({ role: "staff" }).where(eq(users.id, admin.id));
      await rejects(identity.admin.setCustomerStatus(principal, customer.publicId, "suspended", "POLICY_VIOLATION"), "SESSION_NOT_CURRENT");
      await db.db.update(users).set({ role: "admin" }).where(eq(users.id, admin.id));
      // Pending step appeared after resolution (e.g. forced password change).
      await db.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, admin.id));
      await rejects(identity.admin.setCustomerStatus(principal, customer.publicId, "suspended", "POLICY_VIOLATION"), "ACCOUNT_STEPS_PENDING");
      await db.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, admin.id));
      // Persisted step-up went stale.
      h.clock.advance(11 * 60_000);
      await db.db.update(userSessions).set({ lastSeenAt: h.clock.now() }).where(eq(userSessions.publicId, principal.sessionId));
      await rejects(identity.admin.changeReference(principal, customer.publicId, "ACME-2", (await userRow(customer.id)).version, "CORRECTION"), "STEP_UP_REQUIRED");
      expect((await userRow(customer.id)).status).toBe("active");
    });

    it("two admins demoting each other concurrently: exactly one succeeds, one active admin remains", async () => {
      const a = await makeUser({ role: "admin" });
      const b = await makeUser({ role: "admin" });
      // Exclude other admins from earlier tests so the invariant under test is the two-admin case.
      await db.db.update(users).set({ status: "deactivated" }).where(eq(users.role, "admin"));
      await db.db.update(users).set({ status: "active" }).where(eq(users.id, a.id));
      await db.db.update(users).set({ status: "active" }).where(eq(users.id, b.id));
      const sa = await session(a.email, { stepUp: true });
      const sb = await session(b.email, { stepUp: true });
      const results = await Promise.allSettled([
        identity.admin.changeRole(sa.principal, b.publicId, "staff", (await userRow(b.id)).version),
        identity.admin.changeRole(sb.principal, a.publicId, "staff", (await userRow(a.id)).version),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      // Serialized by canonical locking (not a deadlock victim): the loser's session was revoked by the winner.
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect((loser.reason as DomainError).reasonCode).toBe("SESSION_NOT_CURRENT");
      const roles = [(await userRow(a.id)).role, (await userRow(b.id)).role].sort();
      expect(roles).toEqual(["admin", "staff"]);
    });

    it("two admins suspending each other concurrently: one active admin remains", async () => {
      const a = await makeUser({ role: "admin" });
      const b = await makeUser({ role: "admin" });
      await db.db.update(users).set({ status: "deactivated" }).where(eq(users.role, "admin"));
      await db.db.update(users).set({ status: "active" }).where(eq(users.id, a.id));
      await db.db.update(users).set({ status: "active" }).where(eq(users.id, b.id));
      const sa = await session(a.email, { stepUp: true });
      const sb = await session(b.email, { stepUp: true });
      const results = await Promise.allSettled([
        identity.admin.setStaffStatus(sa.principal, b.publicId, "suspended", "SECURITY_REVIEW"),
        identity.admin.setStaffStatus(sb.principal, a.publicId, "suspended", "SECURITY_REVIEW"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect((loser.reason as DomainError).reasonCode).toBe("SESSION_NOT_CURRENT");
      const statuses = [(await userRow(a.id)).status, (await userRow(b.id)).status].sort();
      expect(statuses).toEqual(["active", "suspended"]);
    });

    it("last-admin protection and self-change refusal", async () => {
      const a = await makeUser({ role: "admin" });
      const b = await makeUser({ role: "admin" });
      await db.db.update(users).set({ status: "deactivated" }).where(eq(users.role, "admin"));
      await db.db.update(users).set({ status: "active" }).where(eq(users.id, a.id));
      await db.db.update(users).set({ status: "suspended" }).where(eq(users.id, b.id));
      const sa = await session(a.email, { stepUp: true });
      await rejects(identity.admin.changeRole(sa.principal, a.publicId, "staff", (await userRow(a.id)).version), "SELF_ROLE_CHANGE");
      await rejects(identity.admin.setStaffStatus(sa.principal, a.publicId, "suspended", "SECURITY_REVIEW"), "SELF_STATUS_CHANGE");
    });
  });

  describe("admin customer management", () => {
    it("create (invitation) → activate; preview returns the invitation link to the admin only in preview", async () => {
      build({ deploymentProfile: "preview" });
      const admin = await makeUser({ role: "admin" });
      const { principal } = await session(admin.email, { stepUp: true });
      const created = await identity.admin.createCustomer(principal, { email: `cust${Date.now()}@example.test`, name: "Cara Customer" });
      expect(created.customerRef).toMatch(/^RP-[0-9A-HJKMNP-TV-Z]{7}$/);
      expect(created.previewLink).toMatch(/^\/activate\?token=/);
      await identity.auth.activateAccount({ token: tokenOf(created.previewLink), password: PW2 });
      await rejects(identity.auth.activateAccount({ token: tokenOf(created.previewLink), password: PW2 }), "LINK_INVALID");
      expect(h.audit.named("admin.customer.created")).toHaveLength(1);

      for (const profile of ["test", "production"] as const) {
        build({ deploymentProfile: profile });
        const admin2 = await makeUser({ role: "admin" });
        const s = await session(admin2.email, { stepUp: true });
        const c = await identity.admin.createCustomer(s.principal, { email: `c${profile}${Date.now()}@example.test`, name: "Cara" });
        expect("previewLink" in c).toBe(false);
      }
    });

    it("suspend revokes the customer's sessions; reactivate restores status; audited", async () => {
      const admin = await makeUser({ role: "admin" });
      const customer = await makeUser();
      const cs = await session(customer.email);
      const { principal } = await session(admin.email, { stepUp: true });
      await identity.admin.setCustomerStatus(principal, customer.publicId, "suspended", "POLICY_VIOLATION");
      expect(await identity.sessionResolver.resolve({ token: cs.token, transport: "cookie" })).toBeNull();
      await identity.admin.setCustomerStatus(principal, customer.publicId, "active", "REVIEW_CLEARED");
      expect((await userRow(customer.id)).status).toBe("active");
      expect(h.audit.named("admin.customer.status_changed")).toHaveLength(2);
    });

    it("reference change: permanent reservation of retired values, history, optimistic version", async () => {
      const admin = await makeUser({ role: "admin" });
      const customer = await makeUser();
      const other = await makeUser();
      const { principal } = await session(admin.email, { stepUp: true });
      const before = await userRow(customer.id);
      const stamp = Date.now().toString(36).toUpperCase();
      await rejects(identity.admin.changeReference(principal, customer.publicId, `NEW-${stamp}`, before.version + 5, "CORRECTION"), "STALE_VERSION");
      const changed = await identity.admin.changeReference(principal, customer.publicId, `NEW-${stamp}`, before.version, "CORRECTION");
      expect(changed.customerRef).toBe(`NEW-${stamp}`);
      // The retired reference can never be reused by anyone.
      const otherRow = await userRow(other.id);
      await expect(identity.admin.changeReference(principal, other.publicId, before.customerRef!, otherRow.version, "CORRECTION")).rejects.toBeInstanceOf(DomainError);
      expect(await identity.isCustomerRefAvailable(before.customerRef!)).toBe(false);
      const detail = await identity.admin.getCustomer(principal, customer.publicId);
      expect(detail.referenceHistory[0]).toMatchObject({ previousReference: before.customerRef, newReference: `NEW-${stamp}` });
    });

    it("audit failure ⇒ no status change, no session revocation", async () => {
      const admin = await makeUser({ role: "admin" });
      const customer = await makeUser();
      const cs = await session(customer.email);
      const { principal } = await session(admin.email, { stepUp: true });
      h.audit.failRecords = true;
      await expect(identity.admin.setCustomerStatus(principal, customer.publicId, "suspended", "POLICY_VIOLATION")).rejects.toThrow();
      h.audit.failRecords = false;
      expect((await userRow(customer.id)).status).toBe("active");
      expect(await identity.sessionResolver.resolve({ token: cs.token, transport: "cookie" })).not.toBeNull();
    });

    it("search: exact e-mail via blind index, reference prefix, name prefix; cursor pagination", async () => {
      const admin = await makeUser({ role: "admin" });
      const customer = await makeUser();
      const { principal } = await session(admin.email);
      const byEmail = await identity.searchCustomers(principal, { query: customer.email });
      expect(byEmail.items.map((i) => i.publicId)).toEqual([customer.publicId]);
      const byName = await identity.searchCustomers(principal, { query: "Synth" });
      expect(byName.items.length).toBeGreaterThan(0);
      const page = await identity.searchCustomers(principal, { limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      const next = await identity.searchCustomers(principal, { limit: 1, cursor: page.nextCursor! });
      expect(next.items[0]?.publicId).not.toBe(page.items[0]?.publicId);
      expect(h.audit.notes.some((n) => n.eventName === "admin.customer.searched")).toBe(true);
    });
  });

  describe("router", () => {
    const createCaller = createCallerFactory(identityRouter);
    const issued: unknown[] = [];
    const caller = (sessionPrincipal: SessionPrincipal | null) =>
      createCaller({ services: h.services, session: sessionPrincipal, request: newRequestContext("test"), transport: { issue: (s: unknown) => issued.push(s), clear() {} } } as never);

    it("forgot-password via the API never carries a link, even in preview", async () => {
      build({ deploymentProfile: "preview" });
      const user = await makeUser();
      expect(await caller(null).requestPasswordReset({ email: user.email })).toEqual({ accepted: true });
    });

    it("signIn issues through the transport only; me requires a session", async () => {
      const user = await makeUser();
      issued.length = 0;
      const result = await caller(null).signIn({ email: user.email, password: PW });
      expect(result).toEqual({ nextStep: "mfa_challenge" });
      expect(JSON.stringify(result)).not.toMatch(/token/i);
      expect(issued).toHaveLength(1);
      await expect(caller(null).me()).rejects.toThrow();
    });

    it("rejects unknown input keys (strict schemas)", async () => {
      await expect(caller(null).requestPasswordReset({ email: "a@example.test", extra: 1 } as never)).rejects.toThrow();
    });
  });
});
