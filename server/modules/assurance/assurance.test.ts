import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { createCallerFactory } from "../../trpc/trpc.js";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { users, userSessions } from "../identity/schema.js";
import { createAssuranceModule } from "./index.js";
import { assuranceRouter } from "./router.js";
import * as assuranceSchema from "./schema.js";
import { totp, totpStep } from "./store.js";
import { syntheticAuthenticator } from "./webauthn.test-fixture.js";

const { assuranceAccounts, assuranceChallenges, assurancePasskeys, assuranceRecoveryCodes } = assuranceSchema;
const createCaller = createCallerFactory(assuranceRouter);

describe("assurance: isolated transactional model", () => {
  let db: TestDb;
  let h: TestHarness;
  const issue = vi.fn();
  const notify = vi.fn();
  const smtpReadiness = vi.fn();
  const markMfaVerified = vi.fn(() => Promise.resolve({
    token: randomBytes(32).toString("base64url"),
    csrfToken: randomBytes(32).toString("base64url"), absoluteExpiresAt: h.clock.now(),
  }));
  const markStepUp = vi.fn(markMfaVerified);

  function caller(session: SessionPrincipal) {
    return createCaller({ services: h.services, session, request: newRequestContext("test"), transport: { issue, clear() {} } });
  }

  async function fixture(overrides: Partial<SessionPrincipal> = {}, authSource: "local" | "saml" = "local") {
    const publicId = ulid(+h.clock.now());
    const email = `${publicId.toLowerCase()}@example.test`;
    const role = overrides.role ?? "customer";
    await db.db.insert(users).values({
      publicId, role, status: "active", authSource, emailVerifiedAt: h.clock.now(),
      emailEnc: h.deps.crypto.encrypt(email, `users.email:${publicId}`),
      emailIndex: h.deps.crypto.blindIndex(email, "users.email"), nameEnc: h.deps.crypto.encrypt("Synthetic User", `users.name:${publicId}`),
      passwordHash: randomBytes(16).toString("hex"),
    });
    const [user] = await db.db.select().from(users).where(eq(users.publicId, publicId)).limit(1);
    const id = user!.id;
    const sessionId = ulid(+h.clock.now());
    const now = h.clock.now();
    await db.db.insert(userSessions).values({
      publicId: sessionId, userId: id, tokenHash: randomBytes(32).toString("hex"),
      csrfSecretEnc: h.deps.crypto.encrypt(randomBytes(32).toString("base64url"), `user_sessions.csrf:${sessionId}`),
      authenticatedAt: now, lastSeenAt: now, absoluteExpiresAt: new Date(+now + 3_600_000),
    });
    return fakePrincipal({ userId: id, userPublicId: publicId, sessionId, role, ...overrides });
  }

  async function enroll() {
    const account = await fixture({ state: "remediation", pendingSteps: ["enroll_mfa"], mfaVerifiedAt: null });
    const result = await caller(account).beginTotpEnrollment();
    const code = totp(result.secret).generate({ timestamp: +h.clock.now() });
    const recovery = await caller(account).confirmTotpEnrollment({ code });
    const ack = { ...account, pendingSteps: ["acknowledge_recovery_codes"] as const, mfaVerifiedAt: h.clock.now() };
    return { account, result, code, recovery, ack };
  }

  beforeAll(async () => {
    db = await createTestDb({ schema: { users, userSessions, ...assuranceSchema } });
  });
  afterAll(async () => db?.cleanup());
  beforeEach(() => {
    vi.clearAllMocks();
    h = createTestDeps({ db: db.db });
    h.services.assurance = createAssuranceModule(h.deps);
    h.services.engagement = { notify } as unknown as Services["engagement"];
    smtpReadiness.mockResolvedValue({ ready: true });
    h.services.integrations = { smtp: { getReadiness: smtpReadiness } } as unknown as Services["integrations"];
    async function findUser(where: ReturnType<typeof eq>, opts?: { tx?: DbOrTx; forUpdate?: boolean }) {
      const query = (opts?.tx ?? db.db).select().from(users).where(where).limit(1);
      const [row] = await (opts?.forUpdate ? query.for("update") : query);
      if (!row) return null;
      return { ...row, email: h.deps.crypto.decrypt(row.emailEnc, `users.email:${row.publicId}`), emailVerified: !!row.emailVerifiedAt };
    }
    h.services.identity = {
      getUser: (id: number, opts?: { tx?: DbOrTx; forUpdate?: boolean }) => findUser(eq(users.id, id), opts),
      getUserByPublicId: (id: string, opts?: { tx?: DbOrTx; forUpdate?: boolean }) => findUser(eq(users.publicId, id), opts),
      verifyPassword: vi.fn().mockResolvedValue(true),
      setPassword: async (id: number, password: string, opts: { mustChange: boolean; tx: Tx }) => {
        if (password.length < 15) throw new DomainError("VALIDATION", "PASSWORD_TOO_SHORT", "Choose a longer password.");
        await opts.tx.update(users).set({
          mustChangePassword: opts.mustChange, passwordHash: h.deps.crypto.hashToken(password),
        }).where(eq(users.id, id));
      },
      generateTemporaryPassword: () => randomBytes(24).toString("base64url"),
      issueAdminSetPasswordLink: async (id: number, { tx }: { tx: Tx }) => {
        await tx.update(users).set({ mustChangePassword: true, passwordHash: null }).where(eq(users.id, id));
        return { previewLink: `https://portal.example.test/${randomBytes(32).toString("base64url")}` };
      },
      sessions: {
        async assertCurrent(actor: SessionPrincipal, tx: Tx) {
          const user = await findUser(eq(users.id, actor.userId), { tx, forUpdate: true });
          const [session] = await tx.select().from(userSessions).where(and(
            eq(userSessions.userId, actor.userId), eq(userSessions.publicId, actor.sessionId), isNull(userSessions.revokedAt),
          )).limit(1).for("update");
          if (!session || !user || user.role !== actor.role || user.status !== "active")
            throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Sign in again.");
          return { pendingSteps: actor.pendingSteps };
        },
        markMfaVerified, markStepUp,
        async revokeAllForUser(userId: number, { tx, reason }: { tx: Tx; reason: string }) {
          const [result] = await tx.update(userSessions).set({ revokedAt: h.clock.now(), revokeReason: reason })
            .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
          return result.affectedRows;
        },
      },
    } as unknown as Services["identity"];
  });

  it("binds timed setup to one session, encrypts its secret and issues recovery codes only at confirmation", async () => {
    const { account, result, recovery, ack } = await enroll();
    expect(result.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(recovery.recoveryCodes).toHaveLength(10);
    expect(new Set(recovery.recoveryCodes).size).toBe(10);
    expect(issue).toHaveBeenCalledTimes(1);
    const [row] = await db.db.select().from(assuranceAccounts).where(eq(assuranceAccounts.userId, account.userId));
    expect(row?.totpSecretEnc).not.toContain(result.secret);
    expect(row?.pendingTotpSecretEnc).toBeNull();
    const hashes = await db.db.select().from(assuranceRecoveryCodes).where(eq(assuranceRecoveryCodes.userId, account.userId));
    expect(hashes.every((entry) => !recovery.recoveryCodes?.includes(entry.codeHash))).toBe(true);
    await expect(caller(ack).getState()).resolves.toMatchObject({ recoveryCodesAcknowledged: false, recoveryCodesRemaining: 10 });
    await expect(caller(ack).acknowledgeRecoveryCodes({ recoverySetId: ulid() })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller(ack).acknowledgeRecoveryCodes({ recoverySetId: recovery.recoverySetId! })).resolves.toEqual({ ok: true });
    await expect(caller(ack).getState()).resolves.toMatchObject({ recoveryCodesAcknowledged: true, recoveryCodesRemaining: 10 });
    await expect(caller(account).beginTotpEnrollment()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects confirmation from a different session and after expiry", async () => {
    const account = await fixture({ state: "remediation", pendingSteps: ["enroll_mfa"] });
    const nextSessionId = ulid(+h.clock.now());
    const [oldSession] = await db.db.select().from(userSessions).where(eq(userSessions.publicId, account.sessionId));
    await db.db.insert(userSessions).values({
      userId: account.userId, publicId: nextSessionId, tokenHash: randomBytes(32).toString("hex"),
      csrfSecretEnc: oldSession!.csrfSecretEnc, authenticatedAt: h.clock.now(), lastSeenAt: h.clock.now(), absoluteExpiresAt: oldSession!.absoluteExpiresAt,
    });
    const { secret } = await caller(account).beginTotpEnrollment();
    const secondSession = caller({ ...account, sessionId: nextSessionId });
    await expect(secondSession.beginTotpEnrollment()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(secondSession.confirmTotpEnrollment({ code: totp(secret).generate({ timestamp: +h.clock.now() }) }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    h.clock.advance(10 * 60_000);
    await expect(caller(account).confirmTotpEnrollment({ code: totp(secret).generate({ timestamp: +h.clock.now() }) }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects enrollment-code replay, serializes fresh code replay, and throttles per account", async () => {
    const { account, result, code } = await enroll();
    const factor = { method: "totp", code } as const;
    await expect(h.services.assurance.verifySecondFactor(account.userId, factor)).resolves.toBe(false);
    h.clock.advance(30_000);
    const fresh = { ...factor, code: totp(result.secret).generate({ timestamp: +h.clock.now() + 30_000 }) };
    const results = await Promise.all([
      h.services.assurance.verifySecondFactor(account.userId, fresh), h.services.assurance.verifySecondFactor(account.userId, fresh),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(h.audit.named("auth.totp.replay_denied")).toHaveLength(2);
    h.rateLimiter.blocked.add("auth_high_risk");
    const blocked = () => h.services.assurance.verifySecondFactor(account.userId, fresh);
    await expect(blocked()).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(blocked()).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const rateLimitNotes = () => h.audit.notes.filter((event) => event.eventName === "auth.rate_limited");
    expect(rateLimitNotes()).toEqual([{
      category: "security",
      eventName: "auth.rate_limited",
      action: "throttle",
      outcome: "denied",
      reasonCode: "RATE_LIMITED",
      resource: { type: "user", id: account.userId },
      attributes: { category: "auth_high_risk" },
    }]);
    h.clock.advance(10_000);
    await expect(blocked()).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(rateLimitNotes()).toHaveLength(2);
  });

  function wrongTotp(secret: string) {
    const code = ["000000", "000001", "000002", "000003"]
      .find((candidate) => totpStep(secret, candidate, h.clock.now()) === null)!;
    return { method: "totp", code } as const;
  }

  it("serializes consecutive TOTP failures, escalates cooldowns, and resets after a valid proof", async () => {
    const { account, result } = await enroll();
    const verify = (factor: { method: "totp"; code: string }) =>
      h.services.assurance.verifySecondFactor(account.userId, factor);
    const [where, app] = [eq(assuranceAccounts.userId, account.userId), totp(result.secret)];
    const state = async () => (await db.db.select().from(assuranceAccounts).where(where))[0]!;
    for (let i = 0; i < 9; i++)
      await expect(verify(wrongTotp(result.secret))).resolves.toBe(false);
    expect(await state()).toMatchObject({ totpFailures: 9, totpLockedUntil: null });

    h.audit.failRecords = true;
    await expect(verify(wrongTotp(result.secret))).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(await state()).toMatchObject({ totpFailures: 9, totpLockedUntil: null });
    h.audit.failRecords = false;

    const until = new Date(+h.clock.now() + 30_000);
    const failed = wrongTotp(result.secret);
    await expect(Promise.all([verify(failed), verify(failed), verify(failed)])).resolves.toEqual([false, false, false]);
    expect(await state()).toMatchObject({ totpFailures: 10, totpLockedUntil: until });
    expect(h.audit.named("auth.totp.locked")).toMatchObject([{ reasonCode: "TOTP_COOLDOWN" }]);
    expect(h.audit.recordedInTx.at(-1)).toBe(true);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: account.userId, kind: "security.totp_locked", skipEmail: true }),
      expect.anything(),
    );

    h.clock.advance(29_999);
    await expect(verify({ method: "totp", code: app.generate({ timestamp: +h.clock.now() + 30_000 }) })).resolves.toBe(false);
    expect(await state()).toMatchObject({ totpFailures: 10, totpLockedUntil: until });
    h.clock.advance(1);
    await expect(verify(wrongTotp(result.secret))).resolves.toBe(false);
    expect(await state()).toMatchObject({ totpFailures: 11, totpLockedUntil: new Date(+h.clock.now() + 60_000) });
    h.clock.advance(60_000);
    await expect(verify({ method: "totp", code: app.generate({ timestamp: +h.clock.now() }) })).resolves.toBe(true);
    expect(await state()).toMatchObject({ totpFailures: 0, totpLockedUntil: null });
    expect(h.audit.named("auth.totp.locked")).toHaveLength(1);
  });

  it("hard-locks enrolled TOTP until independently authorized replacement without disabling recovery", async () => {
    const { account, result, recovery } = await enroll();
    const where = eq(assuranceAccounts.userId, account.userId);
    const state = async () => (await db.db.select().from(assuranceAccounts).where(where))[0]!;
    await db.db.update(assuranceAccounts).set({ totpFailures: 49 }).where(where);
    await expect(h.services.assurance.verifySecondFactor(account.userId, wrongTotp(result.secret))).resolves.toBe(false);
    expect(await state()).toMatchObject({ totpFailures: 50, totpLockedUntil: null });
    expect(h.audit.named("auth.totp.locked")).toMatchObject([{ reasonCode: "TOTP_REPLACEMENT_REQUIRED" }]);
    h.clock.advance(3_600_000);
    const current = (secret: string) => ({ method: "totp", code: totp(secret).generate({ timestamp: +h.clock.now() }) }) as const;
    await expect(h.services.assurance.verifySecondFactor(account.userId, current(result.secret))).resolves.toBe(false);
    const full = { ...account, state: "full", pendingSteps: [], mfaVerifiedAt: h.clock.now() } as const;
    await expect(caller(full).stepUp({
      password: "synthetic-password", factor: { method: "recovery_code", code: recovery.recoveryCodes![0]! },
    })).resolves.toEqual({ ok: true });
    expect(await state()).toMatchObject({ totpFailures: 50, totpLockedUntil: null });

    const withStepUp = caller({ ...full, stepUpAt: h.clock.now() });
    const replacement = await withStepUp.beginTotpEnrollment();
    await withStepUp.confirmTotpEnrollment({ code: current(replacement.secret).code });
    expect(await state()).toMatchObject({ totpFailures: 0, totpLockedUntil: null });
    h.clock.advance(30_000);
    await expect(h.services.assurance.verifySecondFactor(account.userId, current(replacement.secret))).resolves.toBe(true);
  });

  it("redeems a recovery code exactly once concurrently and notifies only once", async () => {
    const { account, recovery } = await enroll();
    const factor = { method: "recovery_code", code: recovery.recoveryCodes![0]! } as const;
    const verify = () => h.services.assurance.verifySecondFactor(account.userId, factor);
    const results = await Promise.all([verify(), verify(), verify()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(h.audit.named("auth.recovery_code.redeemed")).toHaveLength(1);
    await expect(caller(account).getState()).resolves.toMatchObject({ recoveryCodesRemaining: 9 });
  });

  it("rolls back redemption when required audit is unavailable", async () => {
    const { account, recovery } = await enroll();
    const factor = { method: "recovery_code", code: recovery.recoveryCodes![0]! } as const;
    h.audit.failRecords = true;
    await expect(h.services.assurance.verifySecondFactor(account.userId, factor)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(notify).not.toHaveBeenCalled();
    h.audit.failRecords = false;
    await expect(h.services.assurance.verifySecondFactor(account.userId, factor)).resolves.toBe(true);
  });

  it("invalidates the old recovery batch on regeneration and binds explicit acknowledgment to the new batch", async () => {
    const { account, ack, recovery } = await enroll();
    await caller(ack).acknowledgeRecoveryCodes({ recoverySetId: recovery.recoverySetId! });
    const full = { ...account, state: "full" as const, pendingSteps: [], stepUpAt: h.clock.now() };
    const batch = await caller(full).regenerateRecoveryCodes();
    expect(batch.recoveryCodes).toHaveLength(10);
    expect(batch.recoverySetId).not.toBe(recovery.recoverySetId);
    await expect(h.services.assurance.verifySecondFactor(account.userId, {
      method: "recovery_code", code: recovery.recoveryCodes![0]!,
    })).resolves.toBe(false);
    await expect(caller(ack).acknowledgeRecoveryCodes({ recoverySetId: recovery.recoverySetId! })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller(ack).acknowledgeRecoveryCodes({ recoverySetId: batch.recoverySetId })).resolves.toEqual({ ok: true });
  });

  it("cleans expired pending TOTP and challenges without affecting active biometric credentials", async () => {
    const actor = await fixture({ stepUpAt: h.clock.now() });
    await caller(actor).beginTotpEnrollment();
    await caller(actor).beginPasskeyRegistration();
    h.clock.advance(10 * 60_000);
    await h.jobs.enqueue("assurance.prune_ceremonies", {});
    const [result] = await h.jobs.runAll();
    expect(result?.outcome).toBe("completed");
    const [row] = await db.db.select().from(assuranceAccounts).where(eq(assuranceAccounts.userId, actor.userId));
    expect(row?.pendingTotpSecretEnc).toBeNull();
    await expect(db.db.select().from(assuranceChallenges).where(eq(assuranceChallenges.userId, actor.userId))).resolves.toEqual([]);
  });

  it("rotates a successful sign-in challenge and step-up, and rejects password failures without consuming the factor", async () => {
    const { account, recovery } = await enroll();
    const challenge = { ...account, pendingSteps: ["mfa_challenge"] as const };
    const full = { ...account, state: "full" as const, pendingSteps: [] };
    await expect(caller(challenge).challenge({ method: "recovery_code", code: recovery.recoveryCodes![0]! })).resolves.toEqual({ ok: true });
    const password = randomBytes(28).toString("base64url");
    const factor = { method: "recovery_code", code: recovery.recoveryCodes![1]! } as const;
    vi.mocked(h.services.identity.verifyPassword).mockResolvedValueOnce(false);
    await expect(caller(full).stepUp({ password, factor })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller(full).stepUp({ password, factor })).resolves.toEqual({ ok: true });
    expect(markMfaVerified).toHaveBeenCalledWith(account.sessionId, { tx: expect.anything() });
    expect(markStepUp).toHaveBeenCalledWith(account.sessionId, { tx: expect.anything() });
    expect(issue).toHaveBeenCalledTimes(3);
  });

  it("rejects remediation, stale, future, wrong-role, self and unknown-target management", async () => {
    const target = await fixture();
    const now = h.clock.now();
    const actor = await fixture({ role: "admin", stepUpAt: now });
    const staff = await fixture({ role: "staff", stepUpAt: now });
    const remediation = { ...actor, state: "remediation" as const, pendingSteps: ["change_password"] as const };
    const refused = { cause: expect.objectContaining({ code: "STEP_UP_REQUIRED" }) };
    await expect(caller({ ...actor, stepUpAt: new Date(+now - 600_001) }).admin.resetMfa({ customerId: target.userPublicId })).rejects.toMatchObject(refused);
    await expect(caller({ ...actor, stepUpAt: new Date(+now + 1) }).admin.resetMfa({ customerId: target.userPublicId })).rejects.toMatchObject(refused);
    await expect(caller(remediation).listPasskeys()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(remediation).regenerateRecoveryCodes()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(remediation).beginTotpEnrollment()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(staff).admin.resetMfa({ customerId: target.userPublicId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(actor).admin.resetMfa({ customerId: actor.userPublicId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(actor).admin.resetMfa({ customerId: ulid() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(actor).admin.resetMfa({ customerId: "tampered" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const external = await fixture({}, "saml");
    await expect(caller(actor).admin.resetMfa({ customerId: external.userPublicId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(["email_link", "generate_temporary", "enter_temporary"] as const)("revokes all target sessions and forces change in %s mode", async (mode) => {
    const target = await fixture();
    const actor = await fixture({ role: "admin", stepUpAt: h.clock.now() });
    const customerId = target.userPublicId;
    const generated = randomBytes(24).toString("base64url");
    const result = await caller(actor).admin.setCredential(mode === "enter_temporary"
      ? { customerId, mode, password: generated } : { customerId, mode });
    expect(result.ok).toBe(true);
    if (mode === "generate_temporary") expect(result.temporaryPassword).toHaveLength(32);
    else expect(result).toEqual({ ok: true });
    const [updated] = await db.db.select().from(users).where(eq(users.id, target.userId));
    expect(updated?.mustChangePassword).toBe(true);
    if (mode === "email_link") expect(updated?.passwordHash).toBeNull();
    const liveSessions = await db.db.select().from(userSessions).where(and(eq(userSessions.userId, target.userId), isNull(userSessions.revokedAt)));
    expect(liveSessions).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: target.userId, kind: "security.credential_changed" }), expect.anything());
    expect(h.audit.recordedInTx.at(-1)).toBe(true);
    expect(JSON.stringify(h.audit.events)).not.toContain(generated);
  });

  it("keeps sessions and password unchanged on invalid temporary input or failed audit", async () => {
    const target = await fixture();
    const actor = await fixture({ role: "admin", stepUpAt: h.clock.now() });
    const customerId = target.userPublicId;
    await expect(caller(actor).admin.setCredential({ customerId, mode: "enter_temporary", password: "too-short" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    h.audit.failRecords = true;
    await expect(caller(actor).admin.setCredential({ customerId, mode: "generate_temporary" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    const [updated] = await db.db.select().from(users).where(eq(users.id, target.userId));
    expect(updated?.mustChangePassword).toBe(false);
    expect(updated?.passwordHash).toBeTruthy();
    const [session] = await db.db.select().from(userSessions).where(eq(userSessions.publicId, target.sessionId));
    expect(session?.revokedAt).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses email reset while SMTP is unavailable without locking the target out", async () => {
    smtpReadiness.mockResolvedValue({ ready: false });
    const target = await fixture();
    const actor = await fixture({ role: "admin", stepUpAt: h.clock.now() });
    await expect(caller(actor).admin.setCredential({ customerId: target.userPublicId, mode: "email_link" }))
      .rejects.toMatchObject({ cause: { reasonCode: "SMTP_NOT_READY" } });
    const [updated] = await db.db.select().from(users).where(eq(users.id, target.userId));
    expect(updated?.mustChangePassword).toBe(false);
    expect(updated?.passwordHash).toBeTruthy();
    const [session] = await db.db.select().from(userSessions).where(eq(userSessions.publicId, target.sessionId));
    expect(session?.revokedAt).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses email reset for an unverified address without altering credentials or sessions", async () => {
    const target = await fixture();
    const actor = await fixture({ role: "admin", stepUpAt: h.clock.now() });
    await db.db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, target.userId));
    const [before] = await db.db.select().from(users).where(eq(users.id, target.userId));
    await expect(caller(actor).admin.setCredential({ customerId: target.userPublicId, mode: "email_link" }))
      .rejects.toMatchObject({ cause: { reasonCode: "TARGET_EMAIL_UNVERIFIED" } });
    const [updated] = await db.db.select().from(users).where(eq(users.id, target.userId));
    expect(updated?.mustChangePassword).toBe(false);
    expect(updated?.passwordHash).toBe(before?.passwordHash);
    const [session] = await db.db.select().from(userSessions).where(eq(userSessions.publicId, target.sessionId));
    expect(session?.revokedAt).toBeNull();
    expect(smtpReadiness).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("resets MFA, makes the target re-enroll, and prevents a revoked principal from writing a new factor", async () => {
    const { account, recovery } = await enroll();
    const actor = await fixture({ role: "admin", stepUpAt: h.clock.now() });
    await expect(caller(actor).admin.resetMfa({ customerId: account.userPublicId })).resolves.toEqual({ ok: true });
    await expect(h.services.assurance.getAssuranceState(account.userId)).resolves.toEqual({
      mfaEnrolled: false, totpEnrolled: false, passkeyCount: 0, recoveryCodesAcknowledged: false,
    });
    await expect(h.services.assurance.verifySecondFactor(account.userId, { method: "recovery_code", code: recovery.recoveryCodes![0]! })).resolves.toBe(false);
    await expect(caller(account).beginTotpEnrollment()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("consumes a passkey registration challenge even when verification fails and never reveals the nonce in storage", async () => {
    const actor = await fixture({ stepUpAt: h.clock.now() });
    const { challengeId, options } = await caller(actor).beginPasskeyRegistration();
    const [row] = await db.db.select().from(assuranceChallenges).where(eq(assuranceChallenges.publicId, challengeId));
    expect(row?.challengeHash).not.toBe(options.challenge);
    expect(options.rp.id).toBe(new URL(h.config.canonicalOrigin).hostname);
    const response = {
      id: "AQ", rawId: "AQ", type: "public-key" as const, clientExtensionResults: {},
      response: { clientDataJSON: "e30", attestationObject: "AQ" },
    };
    await expect(caller(actor).finishPasskeyRegistration({ challengeId, response, name: "Synthetic key" }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(db.db.select().from(assuranceChallenges).where(eq(assuranceChallenges.publicId, challengeId))).resolves.toEqual([]);
    await expect(db.db.select().from(assurancePasskeys).where(eq(assurancePasskeys.userId, actor.userId))).resolves.toEqual([]);
  });

  it("supports a signed WebAuthn registration and authentication, binding origin, purpose, TTL and monotonic counters", async () => {
    const { account, ack, recovery } = await enroll();
    await caller(ack).acknowledgeRecoveryCodes({ recoverySetId: recovery.recoverySetId! });
    const actor: SessionPrincipal = { ...account, state: "full", pendingSteps: [], stepUpAt: h.clock.now() };
    const full = caller(actor);
    await expect(full.disableTotp()).rejects.toMatchObject({ code: "CONFLICT" });
    const device = syntheticAuthenticator(h.config.canonicalOrigin);
    const { challengeId, options } = await full.beginPasskeyRegistration();
    await expect(full.finishPasskeyRegistration({ challengeId, response: device.registration(options.challenge), name: "Synthetic key" }))
      .resolves.toEqual({ ok: true });
    const [key] = await full.listPasskeys();
    expect(key?.name).toBe("Synthetic key");
    const other = caller(await fixture({ stepUpAt: h.clock.now() }));
    await expect(other.removePasskey({ publicId: key!.publicId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(full.disableTotp()).resolves.toEqual({ ok: true });
    await expect(full.removePasskey({ publicId: key!.publicId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(full.renamePasskey({ publicId: key!.publicId, name: "Security key" })).resolves.toEqual({ ok: true });

    const password = randomBytes(24).toString("base64url");
    async function optionsForStepUp() {
      const { challengeId: id, options: authOptions } = await full.beginPasskeyAuthentication({ purpose: "step_up" });
      return { id, challenge: authOptions.challenge };
    }
    async function submit(proof: { id: string; challenge: string }, counter: number, origin?: string) {
      return full.stepUp({ password, factor: { method: "passkey", challengeId: proof.id, response: device.authentication(proof.challenge, counter, origin) } });
    }
    const first = await optionsForStepUp();
    await expect(full.stepUp({ password, factor: { method: "passkey", challengeId: first.id, response: {
      ...device.authentication(first.challenge, 2), clientExtensionResults: { unexpected: true },
    } } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A verification challenge can be consumed for its matching purpose only.
    const challengeCaller = caller({ ...actor, state: "remediation", pendingSteps: ["mfa_challenge"] });
    await expect(challengeCaller.challenge({
      method: "passkey", challengeId: first.id, response: device.authentication(first.challenge, 2),
    })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(submit(first, 2)).resolves.toEqual({ ok: true });
    await expect(submit(first, 3)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(submit(await optionsForStepUp(), 3, "https://wrong-origin.example.test")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(submit(await optionsForStepUp(), 1)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(h.audit.named("auth.passkey.counter_regression")).toHaveLength(1);
    const expired = await optionsForStepUp();
    h.clock.advance(120_000);
    await expect(submit(expired, 3)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(submit(await optionsForStepUp(), 3)).resolves.toEqual({ ok: true });
    const [stored] = await db.db.select().from(assurancePasskeys).where(eq(assurancePasskeys.publicId, key!.publicId));
    expect(stored?.counter).toBe(3);
    expect(stored?.nameEnc).not.toContain("Security key");
  });
});
