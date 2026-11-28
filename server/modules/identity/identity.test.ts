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
import { deriveNameParts } from "./normalize.js";
import { createIdentityModule, type IdentityModule } from "./index.js";
import { createPasswordHasher } from "./password/hasher.js";
import { customerRefHistory, customerRefReservations, identityTokens, sessionRestrictions, signInEvents, users, userSessions } from "./schema.js";

/** D1: tests written with one display name use the same lazy split as legacy accounts. */
const partsOf = (name: string) => deriveNameParts(name);

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
  /** Users the fake break-glass policy refuses to let lose access (assurance owns the real rules). */
  const breakGlassBlocked = new Set<number>();

  function build(config: Partial<AppConfig> = {}) {
    h = createTestDeps({ db: db.db, config });
    assurance = new Map();
    h.services.assurance = {
      getAssuranceState: async (userId: number) => {
        const state = assurance.get(userId) ?? { mfaEnrolled: false, recoveryCodesAcknowledged: false };
        return { ...state, passkeyCount: 0, totpEnrolled: state.mfaEnrolled };
      },
      lockLocalAdministratorPolicy: async () => {},
      assertLocalAdministratorMayLoseAccess: async (_tx: Tx, userId: number) => {
        if (breakGlassBlocked.has(userId)) throw new DomainError("CONFLICT", "LOCAL_MFA_ADMIN_REQUIRED", "Keep a local administrator.");
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
    db = await createTestDb({ schema: { users, userSessions, identityTokens, customerRefReservations, customerRefHistory, signInEvents, sessionRestrictions } });
  });
  afterAll(async () => db?.cleanup());
  beforeEach(() => build());

  /* ------------------------------------------------------------------ registration + sign-in */

  describe("registration", () => {
    it("creates an account, sends verification, audits in tx; preview returns only its own link", async () => {
      build({ deploymentProfile: "preview" });
      const result = await identity.auth.register({ email: `new${Date.now()}@example.test`, nameParts: partsOf("Nova Tester"), password: PW }, {});
      expect(result.previewLink).toMatch(/^\/verify-email\?token=[A-Za-z0-9_-]{43}$/);
      expect(h.mailer.last("auth.verify_email")).toBeDefined();
      expect(h.audit.named("auth.register.requested")[0]?.outcome).toBe("completed");
      expect(h.audit.recordedInTx.every(Boolean)).toBe(true);
    });

    it("existing address: same response shape, no link, notification mail, audited in tx (no enumeration)", async () => {
      build({ deploymentProfile: "preview" });
      const existing = await makeUser();
      const result = await identity.auth.register({ email: existing.email.toUpperCase(), nameParts: partsOf("Other"), password: PW2 }, {});
      expect(result).toEqual({ accepted: true });
      expect(h.mailer.last("auth.account_exists")).toBeDefined();
      expect(h.audit.named("auth.register.requested")[0]).toMatchObject({ outcome: "refused", reasonCode: "EXISTING_ACCOUNT" });
      expect(h.audit.recordedInTx).toEqual([true]);
    });

    it("rejects weak passwords before any lookup, and closed registration", async () => {
      await rejects(identity.auth.register({ email: "weak@example.test", nameParts: partsOf("W"), password: "short" }, {}), "PASSWORD_TOO_SHORT");
      h.settings.values.set("identity.registration.enabled", false);
      await rejects(identity.auth.register({ email: "closed@example.test", nameParts: partsOf("C"), password: PW }, {}), "REGISTRATION_DISABLED");
    });

    it("throttles by account blind index (never the raw address)", async () => {
      await identity.auth.register({ email: `thr${Date.now()}@example.test`, nameParts: partsOf("T"), password: PW }, {});
      const call = h.rateLimiter.calls.find((c) => c.category === "auth_high_risk")!;
      expect(call.key).toMatch(/^register:[0-9a-f]{64}$/);
      h.rateLimiter.blocked.add("auth_high_risk");
      await rejects(identity.auth.register({ email: "x@example.test", nameParts: partsOf("T"), password: PW }, {}), "RATE_LIMITED");
      // I-3: one sampled note per subject per minute; the subject key never appears.
      await rejects(identity.auth.register({ email: "x@example.test", nameParts: partsOf("T"), password: PW }, {}), "RATE_LIMITED");
      const notes = h.audit.notes.filter((n) => n.eventName === "auth.rate_limited");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ outcome: "denied", attributes: { category: "auth_high_risk", subject: "register" } });
      expect(JSON.stringify(notes)).not.toMatch(/[0-9a-f]{64}|example\.test/);
    });

    it("audit failure ⇒ no account row", async () => {
      const email = `af${Date.now()}@example.test`;
      h.audit.failRecords = true;
      await expect(identity.auth.register({ email, nameParts: partsOf("A"), password: PW }, {})).rejects.toThrow();
      h.audit.failRecords = false;
      expect(await identity.findUserIdByEmail(email)).toBeNull();
    });

    /* ---- increment 08: D1 names + D4 optional billing at registration ---- */

    const BILLING = {
      fullName: "Zeus Greene", company: "", email: "billing@example.test", country: "US", region: "",
      addressLine1: "1 Synthetic Way", addressLine2: "", city: "Testville", postalCode: "00001", taxId: "",
    };
    function fakeBillingPort() {
      const calls: { userId: number; actor: unknown; inTx: boolean }[] = [];
      (h.services as unknown as { billingProfile?: unknown }).billingProfile = {
        saveForUserInTx: async (tx: unknown, userId: number, _details: unknown, actor: unknown) => {
          calls.push({ userId, actor, inTx: Boolean(tx) });
          return { details: BILLING, version: 1, updatedAt: h.clock.now() };
        },
      };
      return calls;
    }

    it("D1: stores the name parts; display name is \"<First> <Last>\"; greeting uses preferred, else first", async () => {
      build({ deploymentProfile: "preview" });
      const email = `parts${Date.now()}@example.test`;
      await identity.auth.register({ email, nameParts: { firstName: "Zeus", lastName: "Greene", preferredName: "Zed" }, password: PW }, {});
      const found = (await identity.findUserIdByEmail(email))!;
      const row = await userRow(found.userId);
      expect(row.firstNameEnc).not.toBeNull();
      expect(row.lastNameEnc).not.toBeNull();
      const view = (await identity.getUser(found.userId))!;
      expect(view).toMatchObject({ name: "Zeus Greene", firstName: "Zeus", lastName: "Greene", preferredName: "Zed", greetingName: "Zed", namePartsStored: true });
      expect(h.mailer.last("auth.verify_email")?.vars).toMatchObject({ name: "Zed" });
      expect(JSON.stringify(h.audit.events)).not.toMatch(/Zeus|Greene|Zed/);
    });

    it("D4: billing is saved in the registration tx only for a NEW account; existing address gets the same response", async () => {
      build({ deploymentProfile: "production" });
      const calls = fakeBillingPort();
      const fresh = await identity.auth.register({ email: `bill${Date.now()}@example.test`, nameParts: partsOf("Zeus Greene"), password: PW, billing: BILLING }, {});
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ actor: { role: "customer", via: "registration" }, inTx: true });
      expect(h.audit.named("auth.register.requested").at(-1)?.attributes).toMatchObject({ billing: "saved" });

      const existing = await makeUser();
      const again = await identity.auth.register({ email: existing.email, nameParts: partsOf("Zeus Greene"), password: PW2, billing: BILLING }, {});
      expect(calls).toHaveLength(1);
      expect(again).toEqual(fresh);
      expect(JSON.stringify(h.audit.events)).not.toMatch(/Synthetic Way|billing@example/);
    });

    it("D4: a missing billing module means 'skip saving' (account still created, audited as skipped)", async () => {
      (h.services as unknown as { billingProfile?: unknown }).billingProfile = undefined;
      const email = `skip${Date.now()}@example.test`;
      await identity.auth.register({ email, nameParts: partsOf("Zeus Greene"), password: PW, billing: BILLING }, {});
      expect(await identity.findUserIdByEmail(email)).not.toBeNull();
      expect(h.audit.named("auth.register.requested").at(-1)?.attributes).toMatchObject({ billing: "skipped" });
    });

    it("D4: a billing save failure rolls the whole registration back (atomic)", async () => {
      (h.services as unknown as { billingProfile?: unknown }).billingProfile = {
        saveForUserInTx: async () => { throw new DomainError("VALIDATION", "BILLING_INVALID", "Check the billing details."); },
      };
      const email = `roll${Date.now()}@example.test`;
      await rejects(identity.auth.register({ email, nameParts: partsOf("Zeus Greene"), password: PW, billing: BILLING }, {}), "BILLING_INVALID");
      expect(await identity.findUserIdByEmail(email)).toBeNull();
    });

    it("D1 router: names are validated (required first/last, ≤50, no markup) and billing is validated before any lookup", async () => {
      const caller = createCallerFactory(identityRouter)({ services: h.services, session: null, request: newRequestContext("test"), transport: { issue() {}, clear() {} } } as never);
      const base = { email: `r${Date.now()}@example.test`, password: PW };
      await expect(caller.register({ ...base, firstName: "", lastName: "Greene" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(caller.register({ ...base, firstName: "Z".repeat(51), lastName: "Greene" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(caller.register({ ...base, firstName: "<b>", lastName: "Greene" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(caller.register({ ...base, firstName: "Zeus", lastName: "Greene", billing: { ...BILLING, city: "" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(h.audit.named("auth.register.requested")).toHaveLength(0);
      expect(h.mailer.sent).toHaveLength(0);
    });
  });

  describe("D1 backward compatibility (pre-08 clients send `name`)", () => {
    const anon = () => createCallerFactory(identityRouter)({ services: h.services, session: null, request: newRequestContext("test"), transport: { issue() {}, clear() {} } } as never);
    it("register still accepts the legacy single name; parts are derived lazily; mixing both forms is refused", async () => {
      const email = `legacy${Date.now()}@example.test`;
      expect(await anon().register({ email, name: "Zeus Greene", password: PW })).toEqual({ accepted: true });
      const found = (await identity.findUserIdByEmail(email))!;
      expect((await userRow(found.userId)).firstNameEnc).toBeNull();
      expect(await identity.getUser(found.userId)).toMatchObject({ name: "Zeus Greene", firstName: "Zeus", lastName: "Greene", namePartsStored: false });
      await expect(anon().register({ email: `mix${Date.now()}@example.test`, name: "Zeus Greene", firstName: "Zeus", lastName: "Greene", password: PW })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(anon().register({ email: `none${Date.now()}@example.test`, password: PW })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("a legacy profile save replaces the display name and clears stored parts", async () => {
      const u = await makeUser();
      const { principal } = await session(u.email);
      await identity.admin.updateOwnProfile(principal, { nameParts: { firstName: "Zeus", lastName: "Greene", preferredName: "Zed" } });
      await identity.admin.updateOwnProfile(principal, { name: "Ice Queen" });
      expect(await identity.getUser(u.id)).toMatchObject({ name: "Ice Queen", firstName: "Ice", lastName: "Queen", preferredName: null, namePartsStored: false });
    });
  });

  describe("D1 name parts (legacy + ports)", () => {
    it("legacy accounts derive parts lazily (first/last token; one token → last \"\"), stored at the next profile save", async () => {
      const u = await makeUser();
      await db.db.update(users).set({ firstNameEnc: null, lastNameEnc: null, preferredNameEnc: null }).where(eq(users.id, u.id));
      const view = (await identity.getUser(u.id))!;
      expect(view).toMatchObject({ firstName: "Synthetic", lastName: view.name.split(" ").at(-1), namePartsStored: false, greetingName: "Synthetic" });
      expect(await identity.users.namePartsInTx(db.db, u.id)).toMatchObject({ firstName: "Synthetic", preferredName: null });
      const { principal } = await session(u.email);
      await identity.admin.updateOwnProfile(principal, { nameParts: { firstName: "Zeus", lastName: "Greene", preferredName: null } });
      const after = (await identity.getUser(u.id))!;
      expect(after).toMatchObject({ name: "Zeus Greene", namePartsStored: true, greetingName: "Zeus" });
      expect(h.audit.named("identity.profile.updated").at(-1)?.attributes).toMatchObject({ name_changed: true });
    });

    it("namePartsInTx: parts + customerRef; unknown user → NOT_FOUND USER_NOT_FOUND; no audit", async () => {
      const u = await makeUser();
      const parts = await identity.users.namePartsInTx(db.db, u.id);
      expect(parts.customerRef).toBe(u.customerRef);
      expect(h.audit.events).toHaveLength(0);
      await rejects(identity.users.namePartsInTx(db.db, 99_999_999), "USER_NOT_FOUND");
    });

    it("admin updateCustomerName: capability-gated, optimistic version, audited without the name", async () => {
      const admin = await makeUser({ role: "admin" });
      const cust = await makeUser();
      const { principal } = await session(admin.email, { stepUp: true });
      const version = (await userRow(cust.id)).version;
      const out = await identity.admin.updateCustomerName(principal, cust.publicId, { nameParts: { firstName: "Zeus", lastName: "Greene", preferredName: "Zed" }, expectedVersion: version });
      expect(out.version).toBe(version + 1);
      expect((await identity.getUser(cust.id))!).toMatchObject({ name: "Zeus Greene", preferredName: "Zed" });
      const [event] = h.audit.named("admin.customer.name_updated");
      expect(event).toMatchObject({ resource: { type: "user", publicId: cust.publicId } });
      expect(JSON.stringify(h.audit.events)).not.toMatch(/Zeus|Greene|Zed/);
      await rejects(identity.admin.updateCustomerName(principal, cust.publicId, { nameParts: partsOf("Other Name"), expectedVersion: version }), "STALE_VERSION");
      const { principal: custPrincipal } = await session(cust.email);
      await rejects(identity.admin.updateCustomerName(custPrincipal, cust.publicId, { nameParts: partsOf("Other Name"), expectedVersion: out.version }), "CAPABILITY_NOT_GRANTED");
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

    it("a password change racing a sign-in is refused uniformly and recorded after rollback (I-5)", async () => {
      const user = await makeUser();
      const target = db.db as unknown as { transaction: (...args: unknown[]) => Promise<unknown> };
      const original = target.transaction;
      target.transaction = async (...args: unknown[]) => {
        target.transaction = original; // one-shot: the hash changes between verification and the locked re-check
        await db.db.update(users).set({ passwordHash: "$argon2id$changed-concurrently" }).where(eq(users.id, user.id));
        return original.apply(db.db, args);
      };
      try {
        await rejects(identity.auth.signIn({ email: user.email, password: PW }, {}), "BAD_CREDENTIALS");
      } finally {
        target.transaction = original;
      }
      expect(h.audit.named("auth.login.failed").at(-1)).toMatchObject({ reasonCode: "CREDENTIAL_CHANGED_CONCURRENTLY", resource: { publicId: user.publicId } });
      expect(h.audit.recordedInTx.at(-1)).toBe(false);
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
      const r = await identity.auth.register({ email: `v${Date.now()}@example.test`, nameParts: partsOf("V"), password: PW }, {});
      const token = tokenOf(r.previewLink);
      await identity.auth.verifyEmail(token, null);
      await rejects(identity.auth.verifyEmail(token, null), "LINK_INVALID");
      expect(h.audit.named("auth.token.rejected").at(-1)).toMatchObject({ reasonCode: "LINK_INVALID", attributes: { purpose: "verify_email" } });
      expect(JSON.stringify(h.audit.events)).not.toContain(token);

      const r2 = await identity.auth.register({ email: `v2${Date.now()}@example.test`, nameParts: partsOf("V"), password: PW }, {});
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
        const r = await identity.auth.register({ email: `p${profile}${Date.now()}@example.test`, nameParts: partsOf("P"), password: PW }, {});
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
        for (const job of h.jobs.enqueued) expect(Object.keys(job.payload as object)).toEqual(["emailIndex", "userId"]); // blind index + internal id bound at intake (D2.8), never the address
        expect(h.jobs.enqueued.map((j) => typeof (j.payload as { userId: unknown }).userId === "number")).toEqual([true, false, true]);
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
      expect(h.audit.named("auth.token.rejected").at(-1)).toMatchObject({ attributes: { purpose: "password_reset" } });
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
      expect(await identity.auth.dispatchPasswordReset({ emailIndex, userId: user.id })).toBe("issued");
      expect(await identity.auth.dispatchPasswordReset({ emailIndex, userId: user.id })).toBe("cooldown");
      expect(await identity.auth.dispatchPasswordReset({ emailIndex: "zz" })).toBe("ineligible");
      // Concurrent dispatches (adjoining enqueue slots) after the cooldown: exactly one issues.
      h.clock.advance(61_000);
      const outcomes = await Promise.all([identity.auth.dispatchPasswordReset({ emailIndex, userId: user.id }), identity.auth.dispatchPasswordReset({ emailIndex, userId: user.id })]);
      expect([...outcomes].sort()).toEqual(["cooldown", "issued"]);
    });
  });

  describe("change password", () => {
    it("requires the current password, revokes other sessions and rotates the current one", async () => {
      const user = await makeUser();
      const other = await session(user.email);
      const current = await session(user.email);
      await rejects(identity.auth.changePassword(current.principal, { currentPassword: PW2, newPassword: PW2 }), "CURRENT_PASSWORD_INCORRECT");
      // I-1: recorded durably after the rollback (outside the failed tx).
      expect(h.audit.named("auth.password.change_denied")[0]).toMatchObject({ outcome: "denied", reasonCode: "CURRENT_PASSWORD_INCORRECT", resource: { publicId: user.publicId } });
      expect(h.audit.recordedInTx.at(-1)).toBe(false);
      expect(JSON.stringify(h.audit.events)).not.toContain(PW2);
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
      await rejects(identity.admin.createCustomer(c.principal, { email: "n@example.test", nameParts: partsOf("N") }), "CAPABILITY_NOT_GRANTED");
      const s = await session(staff.email, { stepUp: true });
      await rejects(identity.admin.createStaff(s.principal, { email: "n@example.test", nameParts: partsOf("N"), role: "admin" }), "CAPABILITY_NOT_GRANTED");
      const remediation = { ...(await session(admin.email, { stepUp: true })).principal, state: "remediation" as const, pendingSteps: ["change_password" as const] };
      await rejects(identity.admin.createCustomer(remediation, { email: "n@example.test", nameParts: partsOf("N") }), "CAPABILITY_NOT_GRANTED");
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

    it("break-glass (I-A01): demoting or deactivating the sole local-MFA admin is refused even with another active admin", async () => {
      const actor = await makeUser({ role: "admin" });
      const sole = await makeUser({ role: "admin" });
      breakGlassBlocked.add(sole.id);
      try {
        const sa = await session(actor.email, { stepUp: true });
        await rejects(identity.admin.changeRole(sa.principal, sole.publicId, "staff", (await userRow(sole.id)).version), "LOCAL_MFA_ADMIN_REQUIRED");
        await rejects(identity.admin.setStaffStatus(sa.principal, sole.publicId, "deactivated", "SECURITY_REVIEW"), "LOCAL_MFA_ADMIN_REQUIRED");
        expect((await userRow(sole.id)).role).toBe("admin");
        expect((await userRow(sole.id)).status).toBe("active");
      } finally {
        breakGlassBlocked.delete(sole.id);
      }
    });

    it("listLocalAdministratorCandidates: active local admins with verified e-mail and a password only", async () => {
      const ok = await makeUser({ role: "admin" });
      const unverified = await makeUser({ role: "admin", verified: false });
      const entra = await makeUser({ role: "admin" });
      await db.db.update(users).set({ authSource: "entra" }).where(eq(users.id, entra.id));
      const staff = await makeUser({ role: "staff" });
      const ids = await db.db.transaction((tx) => identity.listLocalAdministratorCandidates(tx as Tx));
      expect(ids).toContain(ok.id);
      expect(ids).not.toContain(unverified.id);
      expect(ids).not.toContain(entra.id);
      expect(ids).not.toContain(staff.id);
      expect([...ids].sort((x, y) => x - y)).toEqual(ids);
      const plain = await db.db.transaction((tx) => identity.listLocalAdministratorCandidates(tx as Tx, { lock: false }));
      expect(plain).toEqual(ids);
    });

    it("recoverLocalAdministratorPassword: forces change, resets auth source, revokes sessions, refuses non-admins", async () => {
      const admin = await makeUser({ role: "admin" });
      await session(admin.email);
      await db.db.update(users).set({ authSource: "entra" }).where(eq(users.id, admin.id));
      const result = await db.db.transaction((tx) => identity.recoverLocalAdministratorPassword(admin.id, PW2, { tx: tx as Tx }));
      expect(result.sessionsRevoked).toBeGreaterThanOrEqual(1);
      const row = await userRow(admin.id);
      expect(row.mustChangePassword).toBe(true);
      expect(row.authSource).toBe("local");
      expect(h.audit.named("identity.admin.local_password_recovered")).toHaveLength(1);
      const staff = await makeUser({ role: "staff" });
      await rejects(db.db.transaction((tx) => identity.recoverLocalAdministratorPassword(staff.id, PW2, { tx: tx as Tx })), "NOT_ACTIVE_ADMINISTRATOR");
    });
  });

  describe("admin customer management", () => {
    it("create (invitation) → activate; preview returns the invitation link to the admin only in preview", async () => {
      build({ deploymentProfile: "preview" });
      const admin = await makeUser({ role: "admin" });
      const { principal } = await session(admin.email, { stepUp: true });
      const created = await identity.admin.createCustomer(principal, { email: `cust${Date.now()}@example.test`, nameParts: partsOf("Cara Customer") });
      expect(created.customerRef).toMatch(/^RPCUS-[0-9A-Z]{9}$/);
      expect(created.previewLink).toMatch(/^\/activate\?token=/);
      await identity.auth.activateAccount({ token: tokenOf(created.previewLink), password: PW2 });
      await rejects(identity.auth.activateAccount({ token: tokenOf(created.previewLink), password: PW2 }), "LINK_INVALID");
      expect(h.audit.named("auth.token.rejected").at(-1)).toMatchObject({ attributes: { purpose: "activation" } });
      expect(h.audit.named("admin.customer.created")).toHaveLength(1);

      for (const profile of ["test", "production"] as const) {
        build({ deploymentProfile: profile });
        const admin2 = await makeUser({ role: "admin" });
        const s = await session(admin2.email, { stepUp: true });
        const c = await identity.admin.createCustomer(s.principal, { email: `c${profile}${Date.now()}@example.test`, nameParts: partsOf("Cara") });
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
      expect(h.audit.named("admin.customer.searched").length).toBeGreaterThan(0);
      expect(h.audit.notes.some((n) => n.eventName === "admin.customer.searched")).toBe(false);
    });

    it("admin PII reads are durable and fail closed (I-4)", async () => {
      const customer = await makeUser();
      const admin = await makeUser({ role: "admin" });
      const { principal } = await session(admin.email, { stepUp: true });
      await identity.admin.getCustomer(principal, customer.publicId);
      expect(h.audit.named("admin.customer.viewed")[0]?.resource).toEqual({ type: "user", publicId: customer.publicId });
      h.audit.failRecords = true;
      await expect(identity.admin.getCustomer(principal, customer.publicId)).rejects.toThrow();
      await expect(identity.searchCustomers(principal, {})).rejects.toThrow();
      h.audit.failRecords = false;
    });
  });

  describe("getUsersByIds (batch read port)", () => {
    it("resolves a page of users in one query with decrypted name/e-mail and customer reference; caps the batch", async () => {
      const a = await makeUser();
      const b = await makeUser({ role: "staff" });
      const map = await identity.getUsersByIds([a.id, b.id, a.id, 987_654_321]);
      expect([...map.keys()].sort()).toEqual([a.id, b.id].sort());
      expect(map.get(a.id)).toMatchObject({ publicId: a.publicId, email: a.email, name: expect.stringMatching(/^Synthetic Person/), role: "customer" });
      expect(map.get(a.id)!.customerRef).toMatch(/^RPCUS-/);
      expect((await identity.getUsersByIds([])).size).toBe(0);
      await expect(identity.getUsersByIds(Array.from({ length: 501 }, (_, i) => i + 1))).rejects.toThrow(/at most 500/);
    });

    it("findCustomerIds: e-mail exact, reference prefix, name prefix; customers only; empty query ⇒ none", async () => {
      const c = await makeUser();
      const staff = await makeUser({ role: "staff" });
      const ref = (await identity.getUsersByIds([c.id])).get(c.id)!.customerRef!;
      expect(await identity.findCustomerIds(c.email)).toEqual([c.id]);
      expect(await identity.findCustomerIds(staff.email)).toEqual([]);
      expect(await identity.findCustomerIds(ref.toLowerCase())).toContain(c.id);
      const name = (await identity.getUsersByIds([c.id])).get(c.id)!.name;
      expect(await identity.findCustomerIds(name.split(" ")[0]!.toLowerCase())).toContain(c.id);
      expect(await identity.findCustomerIds("   ")).toEqual([]);
      expect(await identity.findCustomerIds("zz-nobody-matches")).toEqual([]);
    });
  });

  describe("provisionLocalAccount (ops scripts)", () => {
    const provision = (role: "admin" | "customer", reason: "bootstrap_admin" | "demo_seed", email = `ops${++seq}.${Date.now()}@example.test`) =>
      db.db.transaction((tx) => identity.provisionLocalAccount({ email, name: "Ops Person", role, password: PW, mustChangePassword: true }, { tx: tx as Tx, reason }));

    it("bootstrap creates an active verified admin (mustChange, no MFA ⇒ first sign-in forces enrolment), audited as system", async () => {
      await db.db.update(users).set({ status: "deactivated" }).where(eq(users.role, "admin"));
      const email = `boot${Date.now()}@example.test`;
      const created = await provision("admin", "bootstrap_admin", email);
      const row = await userRow(created.userId);
      expect(row).toMatchObject({ role: "admin", status: "active", mustChangePassword: true, authSource: "local" });
      expect(row.emailVerifiedAt).not.toBeNull();
      expect(h.audit.named("identity.account.provisioned")[0]).toMatchObject({ actor: { role: "system" }, attributes: { reason: "bootstrap_admin", role: "admin" } });
      expect(JSON.stringify(h.audit.events)).not.toContain(email);
      const signed = await identity.auth.signIn({ email, password: PW }, {});
      expect(signed.nextStep).toBe("enroll_mfa");
    });

    it("bootstrap refuses when an active administrator exists (ADMIN_EXISTS)", async () => {
      await makeUser({ role: "admin" });
      await rejects(provision("admin", "bootstrap_admin"), "ADMIN_EXISTS");
    });

    it("two concurrent bootstraps on an empty install: exactly one succeeds", async () => {
      await db.db.update(users).set({ status: "deactivated" }).where(eq(users.role, "admin"));
      const results = await Promise.allSettled([provision("admin", "bootstrap_admin"), provision("admin", "bootstrap_admin")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect((loser.reason as DomainError).reasonCode).toBe("ADMIN_EXISTS");
    });

    it("demo_seed is refused in production and allowed elsewhere; policy and duplicates still apply", async () => {
      build({ deploymentProfile: "production" });
      await rejects(provision("customer", "demo_seed"), "DEMO_SEED_FORBIDDEN");
      build({ deploymentProfile: "preview" });
      const email = `seed${Date.now()}@example.test`;
      const created = await provision("customer", "demo_seed", email);
      expect(created.customerRef).toMatch(/^RPCUS-/);
      await rejects(provision("customer", "demo_seed", email), "EMAIL_IN_USE");
      await rejects(
        db.db.transaction((tx) => identity.provisionLocalAccount({ email: "w@example.test", name: "W", role: "customer", password: "short", mustChangePassword: false }, { tx: tx as Tx, reason: "demo_seed" })),
        "PASSWORD_TOO_SHORT",
      );
    });

    it("audit failure ⇒ no account", async () => {
      build({ deploymentProfile: "preview" });
      const email = `seedaf${Date.now()}@example.test`;
      h.audit.failRecords = true;
      await expect(provision("customer", "demo_seed", email)).rejects.toThrow();
      h.audit.failRecords = false;
      expect(await identity.findUserIdByEmail(email)).toBeNull();
    });
  });

  describe("sessions.principalForJob (background jobs)", () => {
    it("re-hydrates the full live principal, which passes assertCurrent, without touching lastSeenAt", async () => {
      const user = await makeUser({ role: "staff" });
      const { principal } = await session(user.email, { stepUp: true });
      const before = (await db.db.select().from(userSessions).where(eq(userSessions.publicId, principal.sessionId)))[0]!;
      h.clock.advance(2 * 60_000);
      const job = await identity.sessions.principalForJob(principal.sessionId, user.id);
      expect(job).toEqual({ ...principal, state: "full", pendingSteps: [] });
      const inTx = await db.db.transaction(async (tx) => {
        const p = await identity.sessions.principalForJob(principal.sessionId, user.id, { tx: tx as Tx });
        return identity.sessions.assertCurrent(p, tx as Tx);
      });
      expect(inTx).toMatchObject({ pendingSteps: [], role: "staff" });
      const after = (await db.db.select().from(userSessions).where(eq(userSessions.publicId, principal.sessionId)))[0]!;
      expect(after.lastSeenAt).toEqual(before.lastSeenAt);
      expect(JSON.stringify(h.audit.events)).not.toContain(job.csrfSecret);
    });

    it("refuses another user, unknown, revoked, idle-expired and inactive sessions", async () => {
      const user = await makeUser();
      const other = await makeUser();
      const { principal } = await session(user.email);
      await rejects(identity.sessions.principalForJob(principal.sessionId, other.id), "SESSION_NOT_CURRENT");
      await rejects(identity.sessions.principalForJob("no-such-session", user.id), "SESSION_NOT_CURRENT");
      await db.db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
      await rejects(identity.sessions.principalForJob(principal.sessionId, user.id), "SESSION_NOT_CURRENT");
      await db.db.update(users).set({ status: "active" }).where(eq(users.id, user.id));
      h.clock.advance(31 * 60_000);
      await rejects(identity.sessions.principalForJob(principal.sessionId, user.id), "SESSION_NOT_CURRENT");
      const fresh = (await session(user.email)).principal;
      await identity.sessions.revoke(fresh.sessionId, "test");
      await rejects(identity.sessions.principalForJob(fresh.sessionId, user.id), "SESSION_NOT_CURRENT");
    });

    it("refuses a session with pending account steps", async () => {
      const user = await makeUser();
      const { principal } = await session(user.email);
      await db.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, user.id));
      await rejects(identity.sessions.principalForJob(principal.sessionId, user.id), "ACCOUNT_STEP_PENDING");
    });
  });

  describe("ops sessions (demo seeder)", () => {
    const seed = (email = `seedops${++seq}.${Date.now()}@example.test`) =>
      db.db.transaction((tx) => identity.provisionLocalAccount({ email, name: "Seed Person", role: "customer", password: PW, mustChangePassword: false }, { tx: tx as Tx, reason: "demo_seed" }));

    it("opens a short-lived FULL principal for a demo_seed account that passes assertCurrent, audited in tx", async () => {
      build({ deploymentProfile: "preview" });
      const created = await seed();
      h.audit.clear();
      const principal = await identity.sessions.openOpsSession(created.userId, { reason: "demo_seed" });
      expect(principal).toMatchObject({ userId: created.userId, state: "full", pendingSteps: [], role: "customer" });
      expect(h.audit.named("identity.session.ops_opened")[0]).toMatchObject({ actor: { role: "system" }, attributes: { reason: "demo_seed", ttl_seconds: 600 } });
      expect(h.audit.recordedInTx).toEqual([true]);
      const current = await db.db.transaction((tx) => identity.sessions.assertCurrent(principal, tx as Tx));
      expect(current.pendingSteps).toEqual([]);
      const row = (await db.db.select().from(userSessions).where(eq(userSessions.publicId, principal.sessionId)))[0]!;
      expect(row.absoluteExpiresAt.getTime() - h.clock.now().getTime()).toBe(600_000);
      // The human still enrols MFA at first sign-in: the waiver applies to the ops session only.
      expect((await identity.auth.signIn({ email: (await identity.getUser(created.userId))!.email, password: PW }, {})).nextStep).toBe("enroll_mfa");
      await identity.sessions.revoke(principal.sessionId, "demo_seed_complete");
      await expect(db.db.transaction((tx) => identity.sessions.assertCurrent(principal, tx as Tx))).rejects.toThrow();
    });

    it("is refused in production, for non-seed accounts, and can never be resolved over HTTP", async () => {
      build({ deploymentProfile: "preview" });
      const created = await seed();
      const ordinary = await makeUser({ mfa: false });
      await rejects(identity.sessions.openOpsSession(ordinary.id, { reason: "demo_seed" }), "OPS_SESSION_FORBIDDEN");
      const principal = await identity.sessions.openOpsSession(created.userId, { reason: "demo_seed" });
      const row = (await db.db.select().from(userSessions).where(eq(userSessions.publicId, principal.sessionId)))[0]!;
      expect(row.deviceSummary).toBe("ops:demo_seed");
      build({ deploymentProfile: "production" });
      await rejects(identity.sessions.openOpsSession(created.userId, { reason: "demo_seed" }), "OPS_SESSION_FORBIDDEN");
      // An ops row that survives into a production process is not current there either.
      await expect(db.db.transaction((tx) => identity.sessions.assertCurrent(principal, tx as Tx))).rejects.toThrow();
    });
  });

  /* ------------------------------------------------------------------ increment 06 (D7, D13) */

  describe("sign-in signals (D7)", () => {
    type Signal = { ip: unknown; accountRef?: string; kind: string; outcome: string; correlationId: string; at: Date };
    let signals: Signal[];
    let failPort = false;
    beforeEach(() => {
      signals = [];
      failPort = false;
      (h.services as unknown as { protection: unknown }).protection = {
        recordSignInSignal: async (s: Signal) => {
          if (failPort) throw new Error("protection down");
          signals.push(s);
        },
      };
    });

    it("publishes password failure/success with a blind account ref and never the e-mail", async () => {
      const user = await makeUser();
      await rejects(identity.auth.signIn({ email: user.email, password: PW2 }, {}), "BAD_CREDENTIALS");
      await rejects(identity.auth.signIn({ email: `ghost${seq}@example.test`, password: PW }, {}), "BAD_CREDENTIALS");
      await identity.auth.signIn({ email: user.email, password: PW }, {});
      expect(signals.map((x) => `${x.kind}:${x.outcome}`)).toEqual(["password:failure", "password:failure", "password:success"]);
      const ref = identity.signInSignals.accountRefForEmail(user.email);
      expect(ref).toBeTruthy();
      expect(signals[0]!.accountRef).toBe(ref);
      expect(signals[2]!.accountRef).toBe(ref);
      expect(signals[1]!.accountRef).toBeTruthy(); // unknown accounts are counted too
      expect(signals[1]!.accountRef).not.toBe(ref);
      expect(JSON.stringify(signals)).not.toContain("@example.test");
      expect(await identity.signInSignals.accountRefForUser(user.id)).toBe(ref);
      // Audit correlation attributes.
      const failed = h.audit.named("auth.login.failed");
      expect(failed.length).toBeGreaterThan(0);
      for (const e of failed) {
        expect(e.attributes?.step).toBe("password");
        expect(e.attributes?.account_ref).toBeTruthy();
      }
      expect(h.audit.named("auth.login.succeeded")[0]!.attributes?.account_ref).toBe(ref);
    });

    it("a failing protection port never changes the sign-in result", async () => {
      const user = await makeUser();
      failPort = true;
      await rejects(identity.auth.signIn({ email: user.email, password: PW2 }, {}), "BAD_CREDENTIALS");
      const ok = await identity.auth.signIn({ email: user.email, password: PW }, {});
      expect(ok.sessionId).toBeTruthy();
    });

    it("publishes password_reset failure on a bad link and success on redemption; change-password failure", async () => {
      const user = await makeUser();
      await rejects(identity.auth.resetPassword({ token: "x".repeat(43), password: PW2 }), "LINK_INVALID");
      await identity.auth.requestPasswordReset({ email: user.email });
      await h.jobs.runAll(PASSWORD_RESET_JOB);
      const link = tokenFromMail(h.mailer.last("auth.password_reset")!.vars.link);
      await identity.auth.resetPassword({ token: link, password: PW2 });
      const ref = identity.signInSignals.accountRefForEmail(user.email);
      const resets = signals.filter((x) => x.kind === "password_reset");
      expect(resets.map((x) => x.outcome)).toEqual(["failure", "success"]);
      expect(resets[1]!.accountRef).toBe(ref);
      expect(h.audit.named("auth.password.reset_completed")[0]!.attributes?.step).toBe("password_reset");

      const other = await makeUser();
      const { principal } = await session(other.email);
      signals = [];
      await rejects(identity.auth.changePassword(principal, { currentPassword: PW2, newPassword: PW2 }), "CURRENT_PASSWORD_INCORRECT");
      expect(signals.map((x) => `${x.kind}:${x.outcome}`)).toEqual(["password:failure"]);
    });

    it("publish() by user id never throws, even for unknown users or a failing port", async () => {
      failPort = true;
      await expect(identity.signInSignals.publish({ kind: "mfa", outcome: "failure", userId: 999_999_999 })).resolves.toBeUndefined();
      failPort = false;
      await identity.signInSignals.publish({ kind: "passkey", outcome: "success", userId: 999_999_999 });
      expect(signals).toHaveLength(1);
      expect(signals[0]!.accountRef).toBeUndefined();
    });
  });

  describe("profile name change (D11)", () => {
    it("is audited in the transaction with a flag only, never the name", async () => {
      const user = await makeUser();
      const { principal } = await session(user.email);
      h.audit.clear();
      await identity.admin.updateOwnProfile(principal, { nameParts: partsOf("Renamed Synthetic Person") });
      const [event] = h.audit.named("identity.profile.updated");
      expect(event?.attributes).toEqual({ name_changed: true });
      expect(JSON.stringify(event)).not.toContain("Renamed");
      expect((await identity.getUser(user.id))?.name).toBe("Renamed Person");
    });
  });

  describe("endSessionsForUser (D13)", () => {
    it("ends every session, audits with the reason and validates input", async () => {
      const user = await makeUser();
      const a = await session(user.email);
      const b = await session(user.email);
      await db.db.transaction((tx) => identity.endSessionsForUser(user.id, "policy_declined", { tx: tx as Tx }));
      for (const t of [a.token, b.token]) expect(await identity.sessionResolver.resolve({ token: t, transport: "cookie" })).toBeNull();
      const [event] = h.audit.named("auth.session.revoked_all");
      expect(event?.reasonCode).toBe("POLICY_DECLINED");
      expect(event?.attributes?.source).toBe("policy_enforcement");
      await rejects(identity.endSessionsForUser(user.id, "Bad Reason!"), "REASON_INVALID");
      await rejects(identity.endSessionsForUser(999_999_999, "policy_deadline"), "USER_NOT_FOUND");
    });
  });

  describe("accept_policy step (D13)", () => {
    function enforce(fn: (userId: number, role: string) => Promise<boolean>) {
      (h.services as unknown as { compliance: unknown }).compliance = { policyEnforcement: { requiresRemediation: fn } };
    }

    it("a user with a required policy gets accept_policy as the next step; none when not required", async () => {
      const user = await makeUser();
      enforce(async (id) => id === user.id);
      const signed = await identity.auth.signIn({ email: user.email, password: PW }, {});
      expect(signed.nextStep).toBe("mfa_challenge");
      const issued = await identity.sessions.markMfaVerified(signed.sessionId);
      const principal = await identity.sessionResolver.resolve({ token: issued.token, transport: "cookie" });
      expect(principal?.pendingSteps).toEqual(["accept_policy"]);
      enforce(async () => false);
      const again = await identity.sessionResolver.resolve({ token: issued.token, transport: "cookie" });
      expect(again?.pendingSteps ?? []).toEqual([]);
    });

    it("an existing full session past the deadline is held to accept_policy before any sweeper runs: protected calls refused, full again only after acceptance", async () => {
      const user = await makeUser();
      const { token } = await session(user.email); // full session opened before the policy became overdue
      let accepted = false;
      enforce(async (id) => id === user.id && !accepted);
      const held = await identity.sessionResolver.resolve({ token, transport: "cookie" });
      expect(held?.state).toBe("remediation");
      expect(held?.pendingSteps).toEqual(["accept_policy"]);
      const callerFor = (p: SessionPrincipal) =>
        createCallerFactory(identityRouter)({ services: h.services, session: p, request: newRequestContext("test"), transport: { issue() {}, clear() {} } } as never);
      await expect(callerFor(held!).profile.update({ firstName: "Blocked", lastName: "Change" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(callerFor(held!).sessions.list()).rejects.toThrow();
      accepted = true; // compliance records the acceptance
      const restored = await identity.sessionResolver.resolve({ token, transport: "cookie" });
      expect(restored?.state).toBe("full");
      await expect(callerFor(restored!).sessions.list()).resolves.toBeTruthy();
    });

    it("fails closed when compliance is mounted without the enforcement port (wiring regression)", async () => {
      const user = await makeUser();
      const { token } = await session(user.email);
      (h.services as unknown as { compliance: unknown }).compliance = {};
      const principal = await identity.sessionResolver.resolve({ token, transport: "cookie" }).catch(() => null);
      expect(principal === null || principal.state !== "full").toBe(true);
    });

    it("fails closed when the enforcement port throws", async () => {
      const user = await makeUser();
      const { token } = await session(user.email);
      enforce(async () => Promise.reject(new Error("db down")));
      const principal = await identity.sessionResolver.resolve({ token, transport: "cookie" }).catch(() => null);
      expect(principal === null || principal.pendingSteps.length > 0).toBe(true);
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

    it("me reports the idle policy and this session's effective absolute expiry", async () => {
      h.settings.values.set("identity.session.idle_minutes", 20);
      const user = await makeUser();
      const { principal } = await session(user.email);
      const me = await caller(principal).me();
      expect(me.session.idleTimeoutSeconds).toBe(1200);
      const state = await identity.sessions.getState(principal.sessionId);
      expect(me.session.absoluteExpiresAt).toBe(state!.absoluteExpiresAt.toISOString());
    });

    it("rejects unknown input keys (strict schemas)", async () => {
      await expect(caller(null).requestPasswordReset({ email: "a@example.test", extra: 1 } as never)).rejects.toThrow();
    });
  });
});
