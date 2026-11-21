import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken, ulid } from "../../server/core/ids.js";
import { newRequestContext, runWithRequestContext } from "../../server/core/requestContext.js";
import type { SessionPrincipal, SessionTransport } from "../../server/core/types.js";
import { createAssuranceModule } from "../../server/modules/assurance/index.js";
import { assuranceRouter } from "../../server/modules/assurance/router.js";
import * as assuranceSchema from "../../server/modules/assurance/schema.js";
import { totp } from "../../server/modules/assurance/store.js";
import { createAuditEmitter } from "../../server/modules/audit/emitter.js";
import { auditEvents } from "../../server/modules/audit/schema.js";
import { createIdentityModule } from "../../server/modules/identity/index.js";
import { identityRouter } from "../../server/modules/identity/router.js";
import { identityTokens, ssoIdentities, userSessions, users } from "../../server/modules/identity/schema.js";
import { createCallerFactory, router } from "../../server/trpc/trpc.js";
import { createTestDeps, FakeAudit } from "../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../tests/helpers/testDb.js";
import { recoverAdministrator } from "./lib/recoverAdmin.js";

const caller = createCallerFactory(router({ identity: identityRouter, assurance: assuranceRouter }));
const { assuranceAccounts, assuranceChallenges, assurancePasskeys, assuranceRecoveryCodes } = assuranceSchema;

describe("host administrator recovery", () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb({ schema: { users, userSessions, identityTokens, ssoIdentities, auditEvents, ...assuranceSchema } });
  });
  afterAll(() => testDb?.cleanup());

  function harness() {
    const h = createTestDeps({ db: testDb.db });
    h.services.identity = createIdentityModule(h.deps);
    h.services.assurance = createAssuranceModule(h.deps);
    let token: string | undefined;
    const transport: SessionTransport = { issue: (session) => { token = session.token; }, clear: () => { token = undefined; } };
    const resolve = (input = token) => h.services.identity.sessionResolver.resolve({ token: input, transport: "cookie" });
    const api = (session: SessionPrincipal | null) => caller({ session, transport, services: h.services, request: newRequestContext("test") });
    const services = { ...h.services, audit: createAuditEmitter(h.deps) };
    return { ...h, services, api, resolve, token: () => token };
  }

  async function seed(h: ReturnType<typeof harness>, role: "admin" | "customer" = "admin", status: "active" | "deactivated" = "active") {
    const publicId = ulid(+h.clock.now());
    const email = `${publicId.toLowerCase()}@example.test`;
    const [user] = await testDb.db.insert(users).values({
      publicId, role, status, emailVerifiedAt: h.clock.now(),
      emailEnc: h.deps.crypto.encrypt(email, `users.email:${publicId}`),
      emailIndex: h.deps.crypto.blindIndex(email, "users.email"),
      nameEnc: h.deps.crypto.encrypt("Synthetic User", `users.name:${publicId}`),
    }).$returningId();
    const password = randomToken(24);
    await h.services.identity.setPassword(user!.id, password, { mustChange: false });
    const read = async () => (await testDb.db.select().from(users).where(eq(users.id, user!.id)))[0];
    return { id: user!.id, email, password, publicId, read };
  }

  it("recovers a locked existing administrator, preserves the Entra link and requires fresh local TOTP and a password change", async () => {
    const h = harness();
    const user = await seed(h);
    const now = h.clock.now();
    await h.api(null).identity.signIn({ email: user.email, password: user.password });
    const sessionToken = h.token();
    const session = await h.resolve();
    expect(sessionToken).toBeTruthy();
    expect(session?.pendingSteps).toContain("enroll_mfa");
    await testDb.db.insert(assuranceAccounts).values({ userId: user.id, totpSecretEnc: "old-test-factor", totpFailures: 50, totpLockedUntil: now });
    await testDb.db.insert(assuranceRecoveryCodes).values({ userId: user.id, codeHash: "old-test-code" });
    await testDb.db.insert(assurancePasskeys).values({
      userId: user.id, credentialId: "old-test-credential", credentialIndex: "a".repeat(64), publicKey: "synthetic", counter: 1, nameEnc: "synthetic",
    });
    await testDb.db.insert(assuranceChallenges).values({
      userId: user.id, sessionId: session!.sessionId, purpose: "step_up", challengeHash: "old-test-challenge", expiresAt: new Date(+now + 60_000),
    });
    await testDb.db.insert(identityTokens).values({
      userId: user.id, purpose: "password_reset", tokenHash: "c".repeat(64), expiresAt: new Date(+now + 60_000),
    });
    await testDb.db.insert(ssoIdentities).values({
      userId: user.id, tenantId: "00000000-0000-4000-8000-000000000001", objectId: "00000000-0000-4000-8000-000000000002",
      linkMethod: "admin", linkedAt: now, verifiedAt: now,
    });
    const linkBefore = await testDb.db.select().from(ssoIdentities).where(eq(ssoIdentities.userId, user.id));
    const request = newRequestContext("cli");
    const { password } = await runWithRequestContext(request, () => recoverAdministrator(h.services, user.email, user.email));

    expect(await user.read()).toMatchObject({ id: user.id, role: "admin", status: "active", authSource: "local", mustChangePassword: true });
    expect(await testDb.db.select().from(ssoIdentities).where(eq(ssoIdentities.userId, user.id))).toEqual(linkBefore);
    expect(await testDb.db.select().from(assuranceAccounts).where(eq(assuranceAccounts.userId, user.id))).toMatchObject([{
      totpSecretEnc: null, totpFailures: 0, totpLockedUntil: null, recoverySetId: null,
    }]);
    expect(await testDb.db.select().from(assuranceRecoveryCodes).where(eq(assuranceRecoveryCodes.userId, user.id))).toHaveLength(0);
    expect(await testDb.db.select().from(assurancePasskeys).where(eq(assurancePasskeys.userId, user.id))).toHaveLength(0);
    expect(await testDb.db.select().from(assuranceChallenges).where(eq(assuranceChallenges.userId, user.id))).toHaveLength(0);
    const [resetLink] = await testDb.db.select().from(identityTokens).where(eq(identityTokens.userId, user.id));
    expect(resetLink?.consumedAt).toBeInstanceOf(Date);
    await expect(h.resolve(sessionToken)).resolves.toBeNull();
    await expect(h.api(null).identity.signIn({ email: user.email, password: user.password })).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const [audit] = await testDb.db.select().from(auditEvents).where(eq(auditEvents.requestId, request.requestId));
    expect(audit).toMatchObject({
      eventName: "auth.admin.host_recovery", severityText: "FATAL", actorRole: "system", attributes: { actor_type: "host-operator" },
      resourcePublicId: user.publicId, requestId: request.requestId, origin: "cli", safeCounts: { sessions_revoked: 1 },
    });
    expect(JSON.stringify(audit)).not.toContain(password);
    expect(JSON.stringify(audit)).not.toContain(user.email);
    await expect(h.api(null).identity.signIn({ email: user.email, password })).resolves.toEqual({ nextStep: "enroll_mfa" });
    const pending = await h.resolve();
    const { secret } = await h.api(pending).assurance.beginTotpEnrollment();
    const { recoverySetId } = await h.api(pending).assurance.confirmTotpEnrollment({ code: totp(secret).generate({ timestamp: +h.clock.now() }) });
    await h.api(await h.resolve()).assurance.acknowledgeRecoveryCodes({ recoverySetId: recoverySetId! });
    const change = await h.resolve();
    expect(change?.pendingSteps).toEqual(["change_password"]);
    await expect(h.api(change).identity.changePassword({ currentPassword: password, newPassword: randomToken(24) })).resolves.toEqual({ nextStep: null });
    expect((await h.resolve())?.state).toBe("full");
  });

  it("refuses mismatched confirmation, unknown accounts, non-admins and inactive admins without changing anything", async () => {
    const h = harness();
    const admin = await seed(h);
    const customer = await seed(h, "customer");
    const inactive = await seed(h, "admin", "deactivated");
    const before = await testDb.db.select().from(users);
    await expect(recoverAdministrator(h.services, admin.email, customer.email)).rejects.toMatchObject({ reasonCode: "HOST_RECOVERY_CONFIRMATION_MISMATCH" });
    for (const email of [customer.email, inactive.email, "missing@example.test"]) {
      await expect(recoverAdministrator(h.services, email, email)).rejects.toMatchObject({ reasonCode: "HOST_RECOVERY_INELIGIBLE" });
    }
    expect(await testDb.db.select().from(users)).toEqual(before);
  });

  it("rolls back password, MFA and session changes if the high-severity audit write fails", async () => {
    const h = harness();
    const user = await seed(h);
    await h.api(null).identity.signIn({ email: user.email, password: user.password });
    const before = await user.read();
    await testDb.db.insert(assuranceAccounts).values({ userId: user.id, totpSecretEnc: "locked-test-factor", totpFailures: 50 });
    const failingHostAudit = new FakeAudit();
    failingHostAudit.failRecords = true;
    await expect(recoverAdministrator({ ...h.services, audit: failingHostAudit }, user.email, user.email)).rejects.toBeDefined();
    expect(h.audit.named("identity.admin.local_password_recovered")).toHaveLength(1);
    expect(await user.read()).toEqual(before);
    expect(await h.resolve()).not.toBeNull();
    expect(await testDb.db.select().from(assuranceAccounts).where(eq(assuranceAccounts.userId, user.id))).toMatchObject([
      { totpSecretEnc: "locked-test-factor", totpFailures: 50 },
    ]);
  });
});
