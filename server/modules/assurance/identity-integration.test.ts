import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Services } from "../../container.js";
import { randomToken, ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal, SessionTransport } from "../../core/types.js";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { createTestDeps } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createIdentityModule } from "../identity/index.js";
import { identityRouter } from "../identity/router.js";
import { identityTokens, userSessions, users } from "../identity/schema.js";
import { createAssuranceModule } from "./index.js";
import { assuranceRouter } from "./router.js";
import * as assuranceSchema from "./schema.js";
import { totp } from "./store.js";

const caller = createCallerFactory(router({ identity: identityRouter, assurance: assuranceRouter }));

describe("assurance against real identity policies and sessions", () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb({ schema: { users, userSessions, identityTokens, ...assuranceSchema } }); });
  afterAll(() => db?.cleanup());

  it("rotates every assurance elevation, revokes target sessions in all modes and enforces the next password step", async () => {
    const h = createTestDeps({ db: db.db });
    h.services.identity = createIdentityModule(h.deps);
    h.services.assurance = createAssuranceModule(h.deps);
    h.services.engagement = { notify: vi.fn() } as unknown as Services["engagement"];
    h.services.integrations = { smtp: { getReadiness: async () => ({ ready: true }) } } as unknown as Services["integrations"];

    function browser() {
      let token: string | undefined;
      const transport: SessionTransport = {
        issue: (session) => { token = session.token; },
        clear: () => { token = undefined; },
      };
      const resolve = (input = token) => h.services.identity.sessionResolver.resolve({ token: input, transport: "cookie" });
      const api = (session: SessionPrincipal | null) => caller({ session, transport, services: h.services, request: newRequestContext("test") });
      return { api, resolve, token: () => token };
    }
    async function prepare(role: "admin" | "customer") {
      const publicId = ulid(+h.clock.now());
      const email = `${publicId.toLowerCase()}@example.test`;
      const password = randomToken(24);
      await db.db.insert(users).values({
        publicId, role, status: "active", emailVerifiedAt: h.clock.now(),
        emailEnc: h.deps.crypto.encrypt(email, `users.email:${publicId}`),
        emailIndex: h.deps.crypto.blindIndex(email, "users.email"),
        nameEnc: h.deps.crypto.encrypt("Synthetic User", `users.name:${publicId}`),
      });
      const [row] = await db.db.select().from(users).where(eq(users.publicId, publicId)).limit(1);
      await h.services.identity.setPassword(row!.id, password, { mustChange: false });
      return { email, password, customerId: publicId, userId: row!.id };
    }
    async function enroll(account: { email: string; password: string }) {
      const b = browser();
      await expect(b.api(null).identity.signIn(account)).resolves.toEqual({ nextStep: "enroll_mfa" });
      const initial = await b.resolve();
      expect(initial?.state).toBe("remediation");
      const setup = await b.api(initial).assurance.beginTotpEnrollment();
      const getCode = () => totp(setup.secret).generate({ timestamp: +h.clock.now() });
      const oldToken = b.token();
      const batch = await b.api(initial).assurance.confirmTotpEnrollment({ code: getCode() });
      expect(b.token()).not.toBe(oldToken);
      await expect(b.resolve(oldToken)).resolves.toBeNull();
      const awaitingAck = await b.resolve();
      expect(awaitingAck?.pendingSteps).toEqual(["acknowledge_recovery_codes"]);
      await b.api(awaitingAck).assurance.acknowledgeRecoveryCodes({ recoverySetId: batch.recoverySetId! });
      expect((await b.resolve())?.state).toBe("full");
      return { ...b, getCode };
    }

    const admin = await prepare("admin");
    const adminBrowser = await enroll({ email: admin.email, password: admin.password });
    h.clock.advance(30_000);
    const adminPreStepUp = adminBrowser.token();
    const preStepUpPrincipal = await adminBrowser.resolve();
    await adminBrowser.api(preStepUpPrincipal).assurance.stepUp({ password: admin.password, factor: { method: "totp", code: adminBrowser.getCode() } });
    expect(adminBrowser.token()).not.toBe(adminPreStepUp);
    await expect(adminBrowser.resolve(adminPreStepUp)).resolves.toBeNull();
    const adminApi = adminBrowser.api(await adminBrowser.resolve()).assurance.admin;
    // The verifier rejects a revoked/rotated principal even if its pre-rotation authorization was valid.
    await expect(adminBrowser.api(preStepUpPrincipal).assurance.stepUp({
      password: admin.password, factor: { method: "totp", code: adminBrowser.getCode() },
    })).rejects.toMatchObject({ cause: { reasonCode: "SESSION_NOT_CURRENT" } });

    const pendingRecovery = await adminBrowser.api(await adminBrowser.resolve()).assurance.regenerateRecoveryCodes();
    const recoveryPrincipal = await adminBrowser.resolve();
    expect(recoveryPrincipal?.pendingSteps).toEqual(["acknowledge_recovery_codes"]);
    h.clock.advance(30_000);
    const reissued = await adminBrowser.api(recoveryPrincipal).assurance.recoverUnacknowledgedCodes({
      factor: { method: "totp", code: adminBrowser.getCode() },
    });
    expect(reissued.recoverySetId).not.toBe(pendingRecovery.recoverySetId);
    await expect(adminBrowser.api(recoveryPrincipal).assurance.acknowledgeRecoveryCodes({ recoverySetId: pendingRecovery.recoverySetId }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await adminBrowser.api(recoveryPrincipal).assurance.acknowledgeRecoveryCodes({ recoverySetId: reissued.recoverySetId });
    expect((await adminBrowser.resolve())?.state).toBe("full");

    for (const mode of ["email_link", "generate_temporary", "enter_temporary"] as const) {
      const target = await prepare("customer");
      const customer = await enroll({ email: target.email, password: target.password });
      const oldSession = customer.token();
      const entered = randomToken(24);
      const result = await adminApi.setCredential(mode === "enter_temporary"
        ? { customerId: target.customerId, mode, password: entered } : { customerId: target.customerId, mode });
      expect(result.ok).toBe(true);
      await expect(customer.resolve(oldSession)).resolves.toBeNull();
      await expect(customer.api(null).identity.signIn({ email: target.email, password: target.password })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect((await h.services.identity.getUser(target.userId))?.mustChangePassword).toBe(true);

      let nextPassword: string;
      if (mode === "email_link") {
        expect(result).toEqual({ ok: true });
        const mail = h.mailer.last("auth.admin_set_password");
        const link = new URL(String(mail?.vars.link));
        const token = link.searchParams.get("token")!;
        nextPassword = randomToken(24);
        await expect(customer.api(null).identity.resetPassword({ token, password: nextPassword })).resolves.toEqual({ reset: true });
        await expect(customer.api(null).identity.resetPassword({ token, password: nextPassword })).rejects.toBeDefined();
        expect((await h.services.identity.getUser(target.userId))?.mustChangePassword).toBe(false);
      } else {
        nextPassword = mode === "generate_temporary" ? result.temporaryPassword! : entered;
      }

      await expect(customer.api(null).identity.signIn({ email: target.email, password: nextPassword })).resolves.toEqual({ nextStep: "mfa_challenge" });
      const mfaPending = await customer.resolve();
      const preChallengeToken = customer.token();
      h.clock.advance(30_000);
      await expect(customer.api(mfaPending).assurance.challenge({ method: "totp", code: customer.getCode() })).resolves.toEqual({ ok: true });
      expect(customer.token()).not.toBe(preChallengeToken);
      await expect(customer.resolve(preChallengeToken)).resolves.toBeNull();
      const afterChallenge = await customer.resolve();
      if (mode === "email_link") {
        expect(afterChallenge?.state).toBe("full");
        const beforeMfaReset = customer.token();
        await expect(adminApi.resetMfa({ customerId: target.customerId })).resolves.toEqual({ ok: true });
        await expect(customer.resolve(beforeMfaReset)).resolves.toBeNull();
        await expect(customer.api(null).identity.signIn({ email: target.email, password: nextPassword })).resolves.toEqual({ nextStep: "enroll_mfa" });
      } else {
        expect(afterChallenge?.pendingSteps[0]).toBe("change_password");
        await expect(customer.api(afterChallenge).assurance.listPasskeys()).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(customer.api(afterChallenge).identity.changePassword({ currentPassword: nextPassword, newPassword: randomToken(24) }))
          .resolves.toEqual({ nextStep: null });
        expect((await customer.resolve())?.state).toBe("full");
      }
    }
  });
});
