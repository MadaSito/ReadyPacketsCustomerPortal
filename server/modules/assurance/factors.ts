import { and, eq, isNull } from "drizzle-orm";
import { Secret } from "otpauth";
import QRCode from "qrcode";
import type { ModuleDeps } from "../../container.js";
import { conflict, forbidden, notFound } from "../../core/errors.js";
import type { AuditEventInput, SessionPrincipal, Tx } from "../../core/types.js";
import type { SecondFactorInput } from "./input.js";
import * as passkeys from "./passkeys.js";
import { assertCurrent, badProof, isFull, requireFresh, requireFull, requireTransition, throttle } from "./policy.js";
import { assuranceAccounts, assurancePasskeys, assuranceRecoveryCodes } from "./schema.js";
import {
  getPasskeys, getState, lockAccount, recoveryCount, recoveryHash, replaceRecoveryCodes, secretAad, totp, totpStep,
  TOTP_TTL_MS, type AssuranceAccount,
} from "./store.js";

type EventOptions = Partial<Pick<AuditEventInput, "action" | "outcome" | "reasonCode" | "severity">>;
type AuditActor = Pick<SessionPrincipal, "userId" | "userPublicId" | "role">;
interface AuthenticationBinding {
  sessionId?: string;
  purpose?: passkeys.AuthenticationPurpose;
}

const clearedPending = { pendingTotpSecretEnc: null, pendingTotpExpiresAt: null, pendingTotpSessionId: null } as const;
const clearedTotpFailures = { totpFailures: 0, totpLockedUntil: null } as const;
const TOTP_COOLDOWN_THRESHOLD = 10;
const TOTP_FAILURE_LIMIT = 50;
const ok = { ok: true } as const;

export function createFactorService(deps: ModuleDeps) {
  async function record(eventName: string, tx: Tx | undefined, actor?: AuditActor, options?: EventOptions, passkeyId?: string) {
    await deps.audit.record({
      category: "security", eventName, action: options?.action ?? "authenticate", outcome: options?.outcome ?? "completed",
      severity: options?.severity, reasonCode: options?.reasonCode,
      ...(actor && { actor: { userId: actor.userId, role: actor.role } }),
      ...(passkeyId ? { resource: { type: "passkey", publicId: passkeyId } }
        : actor ? { resource: { type: "user", publicId: actor.userPublicId } } : {}),
    }, tx);
  }

  async function actorTx<T>(
    actor: SessionPrincipal, work: (tx: Tx, account: AssuranceAccount, now: Date) => Promise<T>,
  ): Promise<T> {
    return deps.db.transaction(async (tx) => {
      await assertCurrent(deps, actor, tx);
      const now = deps.clock.now();
      return work(tx, await lockAccount(tx, actor.userId, now), now);
    });
  }

  function authorizeTotpEnrollment(actor: SessionPrincipal, now: Date) {
    if (isFull(actor)) requireFresh(actor, now);
    else requireTransition(actor, "enroll_mfa");
  }

  async function countTotpFailure(tx: Tx, account: AssuranceAccount, now: Date, actor?: AuditActor): Promise<void> {
    const totpFailures = account.totpFailures + 1;
    const hardLock = totpFailures === TOTP_FAILURE_LIMIT;
    const cooldownMs = totpFailures < TOTP_COOLDOWN_THRESHOLD
      ? 0
      : Math.min(3_600_000, 30_000 * 2 ** (totpFailures - TOTP_COOLDOWN_THRESHOLD));
    await tx.update(assuranceAccounts).set({
      totpFailures, totpLockedUntil: hardLock || !cooldownMs ? null : new Date(+now + cooldownMs), updatedAt: now,
    }).where(eq(assuranceAccounts.id, account.id));
    if (totpFailures !== TOTP_COOLDOWN_THRESHOLD && !hardLock) return;
    await record("auth.totp.locked", tx, actor, {
      action: "throttle", outcome: "denied", severity: "WARN",
      reasonCode: hardLock ? "TOTP_REPLACEMENT_REQUIRED" : "TOTP_COOLDOWN",
    });
    await deps.services.engagement.notify({
      userId: account.userId, kind: "security.totp_locked",
      title: hardLock ? "Your authenticator app must be replaced" : "Authenticator attempts temporarily limited",
      body: hardLock
        ? "Authenticator app verification was disabled after repeated unsuccessful attempts. Use another verification method to replace the app, or contact support."
        : "Repeated unsuccessful attempts temporarily limited authenticator app verification. If these attempts were not yours, contact support.",
      link: "/account/security", skipEmail: true,
    }, tx);
  }

  async function proof(
    tx: Tx, account: AssuranceAccount, input: SecondFactorInput, binding: AuthenticationBinding,
    actor?: AuditActor,
  ): Promise<boolean> {
    const now = deps.clock.now();
    if (input.method === "totp") {
      if (!account.totpSecretEnc || account.totpFailures >= TOTP_FAILURE_LIMIT ||
        (account.totpLockedUntil && +account.totpLockedUntil > +now)) return false;
      const secret = deps.crypto.decrypt(account.totpSecretEnc, secretAad(account, false));
      const step = totpStep(secret, input.code, now);
      const replayed = step !== null && account.lastTotpStep !== null && step <= account.lastTotpStep;
      if (replayed)
        await record("auth.totp.replay_denied", tx, actor, { outcome: "denied", reasonCode: "TOTP_REPLAY", severity: "WARN" });
      if (step === null || replayed) {
        await countTotpFailure(tx, account, now, actor);
        return false;
      }
      await tx.update(assuranceAccounts).set({ ...clearedTotpFailures, lastTotpStep: step, updatedAt: now })
        .where(eq(assuranceAccounts.id, account.id));
      return true;
    }
    if (input.method === "recovery_code") {
      if (!account.recoverySetId) return false;
      const hash = recoveryHash(deps, account.userId, input.code);
      if (!hash) return false;
      const [result] = await tx.update(assuranceRecoveryCodes).set({ usedAt: now }).where(and(
        eq(assuranceRecoveryCodes.userId, account.userId), eq(assuranceRecoveryCodes.codeHash, hash), isNull(assuranceRecoveryCodes.usedAt),
      ));
      if (result.affectedRows !== 1) return false;
      await record("auth.recovery_code.redeemed", tx, actor);
      await deps.services.engagement.notify({
        userId: account.userId, kind: "security.recovery_code_used", title: "A recovery code was used",
        body: "A recovery code was used to verify your ReadyPackets account. If this was not you, contact support.",
        link: "/account/security",
      }, tx);
      return true;
    }
    if (!binding.sessionId || !binding.purpose) return false;
    const result = await passkeys.verifyAuthentication(deps, tx, { userId: account.userId, sessionId: binding.sessionId },
      binding.purpose, input.challengeId, input.response, actor?.userPublicId);
    if (result === "counter_regression") {
      await record("auth.passkey.counter_regression", tx, actor, {
        outcome: "denied", reasonCode: "PASSKEY_COUNTER_REGRESSION", severity: "WARN",
      });
    }
    return result === "valid";
  }

  async function denied(eventName: string, actor: SessionPrincipal, tx?: Tx) {
    await record(eventName, tx, actor, { outcome: "denied", reasonCode: "AUTHENTICATION_PROOF_INVALID", severity: "WARN" });
  }

  return {
    async getSecurityState(actor: SessionPrincipal) {
      return {
        ...await getState(deps.db, actor.userId),
        recoveryCodesRemaining: await recoveryCount(deps.db, actor.userId),
      };
    },
    async verifySecondFactor(userId: number, input: SecondFactorInput, binding: AuthenticationBinding = {}): Promise<boolean> {
      await throttle(deps, userId);
      return deps.db.transaction(async (tx) => {
        // Trusted service interface; HTTP ceremonies use actorTx and require a live session.
        const subject = await deps.services.identity.getUser(userId, { tx, forUpdate: true });
        if (subject?.status !== "active" || subject.authSource !== "local") return false;
        const account = await lockAccount(tx, userId, deps.clock.now());
        return proof(tx, account, input, binding, { userId, userPublicId: subject.publicId, role: subject.role });
      });
    },
    async beginTotpEnrollment(actor: SessionPrincipal) {
      authorizeTotpEnrollment(actor, deps.clock.now());
      await throttle(deps, actor.userId);
      return actorTx(actor, async (tx, account, now) => {
        authorizeTotpEnrollment(actor, now);
        if (!isFull(actor) && (account.totpSecretEnc || (await getPasskeys(tx, actor.userId)).length > 0))
          throw forbidden("TRANSITION_NOT_PERMITTED");
        if (account.pendingTotpExpiresAt && +account.pendingTotpExpiresAt > +now && account.pendingTotpSessionId !== actor.sessionId)
          throw conflict("TOTP_SETUP_IN_PROGRESS", "An authenticator setup is already in progress. Try again after it expires.");

        const secret = account.pendingTotpSecretEnc && account.pendingTotpExpiresAt && +account.pendingTotpExpiresAt > +now
          ? deps.crypto.decrypt(account.pendingTotpSecretEnc, secretAad(account, true))
          : new Secret({ size: 20 }).base32;
        const subject = await deps.services.identity.getUser(actor.userId, { tx });
        if (subject?.authSource !== "local") throw forbidden("LOCAL_ACCOUNT_REQUIRED");
        const otpauthUri = totp(secret, subject.email).toString();
        const qrDataUrl = await QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: "M", width: 240 });
        if (!account.pendingTotpExpiresAt || +account.pendingTotpExpiresAt <= +now || !account.pendingTotpSecretEnc) {
          await tx.update(assuranceAccounts).set({
            pendingTotpSecretEnc: deps.crypto.encrypt(secret, secretAad(account, true)),
            pendingTotpExpiresAt: new Date(+now + TOTP_TTL_MS), pendingTotpSessionId: actor.sessionId, updatedAt: now,
          }).where(eq(assuranceAccounts.id, account.id));
          await record("auth.totp.enrollment_started", tx, actor, { action: "create" });
        }
        return { secret, otpauthUri, qrDataUrl };
      });
    },
    async confirmTotpEnrollment(actor: SessionPrincipal, code: string) {
      authorizeTotpEnrollment(actor, deps.clock.now());
      await throttle(deps, actor.userId);
      const result = await actorTx(actor, async (tx, account, now) => {
        authorizeTotpEnrollment(actor, now);
        if (account.pendingTotpSessionId !== actor.sessionId || !account.pendingTotpExpiresAt || +account.pendingTotpExpiresAt <= +now
          || !account.pendingTotpSecretEnc || (!isFull(actor) && account.totpSecretEnc)) {
          await denied("auth.totp.enrollment_denied", actor, tx);
          return null;
        }
        const secret = deps.crypto.decrypt(account.pendingTotpSecretEnc, secretAad(account, true));
        const step = totpStep(secret, code, now);
        if (step === null) {
          await denied("auth.totp.enrollment_denied", actor, tx);
          return null;
        }
        await tx.update(assuranceAccounts).set({
          ...clearedPending, ...clearedTotpFailures,
          totpSecretEnc: deps.crypto.encrypt(secret, secretAad(account, false)), lastTotpStep: step, updatedAt: now,
        }).where(eq(assuranceAccounts.id, account.id));
        const recovery = account.recoverySetId
          ? { recoveryCodes: null, recoverySetId: null }
          : await replaceRecoveryCodes(deps, tx, account, now);
        await record(account.totpSecretEnc ? "auth.totp.replaced" : "auth.totp.enrolled", tx, actor, { action: "update" });
        const issued = isFull(actor) ? undefined : await deps.services.identity.sessions.markMfaVerified(actor.sessionId, { tx });
        return { data: recovery, issued };
      });
      if (!result) throw badProof();
      return result;
    },
    async acknowledgeRecoveryCodes(actor: SessionPrincipal, recoverySetId: string) {
      if (!isFull(actor)) requireTransition(actor, "acknowledge_recovery_codes");
      return actorTx(actor, async (tx, account, now) => {
        if (account.recoverySetId !== recoverySetId)
          throw conflict("RECOVERY_SET_CHANGED", "This recovery-code set has changed. Start a new recovery-code setup.");
        if (!account.recoveryAcknowledgedAt) {
          await tx.update(assuranceAccounts).set({ recoveryAcknowledgedAt: now, updatedAt: now }).where(eq(assuranceAccounts.id, account.id));
          await record("auth.recovery_codes.acknowledged", tx, actor, { action: "transition" });
        }
        return ok;
      });
    },
    async recoverUnacknowledgedCodes(actor: SessionPrincipal, factor: Exclude<SecondFactorInput, { method: "recovery_code" }>) {
      requireTransition(actor, "acknowledge_recovery_codes");
      await throttle(deps, actor.userId);
      const result = await actorTx(actor, async (tx, account, now) => {
        if (account.recoveryAcknowledgedAt || !await proof(tx, account, factor, { sessionId: actor.sessionId, purpose: "recovery_reissue" }, actor)) {
          await denied("auth.recovery_codes.reissue_denied", actor, tx);
          return null;
        }
        const batch = await replaceRecoveryCodes(deps, tx, account, now);
        await record("auth.recovery_codes.reissued", tx, actor, { action: "update" });
        return batch;
      });
      if (!result) throw badProof();
      return result;
    },
    async regenerateRecoveryCodes(actor: SessionPrincipal) {
      requireFresh(actor, deps.clock.now());
      await throttle(deps, actor.userId);
      return actorTx(actor, async (tx, account, now) => {
        requireFresh(actor, now);
        const batch = await replaceRecoveryCodes(deps, tx, account, now);
        await record("auth.recovery_codes.regenerated", tx, actor, { action: "update" });
        return batch;
      });
    },
    async beginPasskeyAuthentication(actor: SessionPrincipal, purpose: passkeys.AuthenticationPurpose) {
      if (purpose === "challenge") requireTransition(actor, "mfa_challenge");
      else if (purpose === "recovery_reissue") requireTransition(actor, "acknowledge_recovery_codes");
      else requireFull(actor);
      await throttle(deps, actor.userId);
      return actorTx(actor, (tx) => passkeys.beginAuthentication(deps, tx, actor, purpose));
    },
    async challenge(actor: SessionPrincipal, factor: SecondFactorInput) {
      requireTransition(actor, "mfa_challenge");
      await throttle(deps, actor.userId);
      const issued = await actorTx(actor, async (tx, account) => {
        if (!await proof(tx, account, factor, { sessionId: actor.sessionId, purpose: "challenge" }, actor)) {
          await denied("auth.mfa.challenge_denied", actor, tx);
          return null;
        }
        await record("auth.mfa.verified", tx, actor);
        return deps.services.identity.sessions.markMfaVerified(actor.sessionId, { tx });
      });
      if (!issued) throw badProof();
      return issued;
    },
    async stepUp(actor: SessionPrincipal, password: string, factor: SecondFactorInput) {
      requireFull(actor);
      await throttle(deps, actor.userId);
      const issued = await actorTx(actor, async (tx, account) => {
        // Verify the currently locked credential, not a password read before a competing reset.
        if (!await deps.services.identity.verifyPassword(actor.userId, password, { tx }) ||
            !await proof(tx, account, factor, { sessionId: actor.sessionId, purpose: "step_up" }, actor)) {
          await denied("auth.step_up.denied", actor, tx);
          return null;
        }
        await record("auth.step_up.verified", tx, actor);
        return deps.services.identity.sessions.markStepUp(actor.sessionId, { tx });
      });
      if (!issued) throw badProof();
      return issued;
    },
    async disableTotp(actor: SessionPrincipal) {
      requireFresh(actor, deps.clock.now());
      return actorTx(actor, async (tx, account, now) => {
        requireFresh(actor, now);
        if ((await getPasskeys(tx, actor.userId)).length < 1)
          throw conflict("LAST_STRONG_FACTOR", "Register a passkey before removing your authenticator app.");
        await tx.update(assuranceAccounts).set({
          ...clearedPending, ...clearedTotpFailures, totpSecretEnc: null, lastTotpStep: null, updatedAt: now,
        }).where(eq(assuranceAccounts.id, account.id));
        await record("auth.totp.disabled", tx, actor, { action: "delete" });
        return ok;
      });
    },
    async listPasskeys(actor: SessionPrincipal) {
      requireFull(actor);
      return (await getPasskeys(deps.db, actor.userId)).map((key) => ({
        publicId: key.publicId, name: deps.crypto.decrypt(key.nameEnc, `assurance_passkeys.name_enc:${key.publicId}`),
        createdAt: key.createdAt, lastUsedAt: key.lastUsedAt,
      }));
    },
    async beginPasskeyRegistration(actor: SessionPrincipal) {
      requireFresh(actor, deps.clock.now());
      await throttle(deps, actor.userId);
      return actorTx(actor, async (tx, _account, now) => {
        requireFresh(actor, now);
        const subject = await deps.services.identity.getUser(actor.userId, { tx });
        if (subject?.authSource !== "local") throw forbidden("LOCAL_ACCOUNT_REQUIRED");
        return passkeys.beginRegistration(deps, tx, actor, subject.email);
      });
    },
    async finishPasskeyRegistration(actor: SessionPrincipal, challengeId: string, response: Parameters<typeof passkeys.finishRegistration>[4], name: string) {
      requireFresh(actor, deps.clock.now());
      await throttle(deps, actor.userId);
      const publicId = await actorTx(actor, async (tx, _account, now) => {
        requireFresh(actor, now);
        const id = await passkeys.finishRegistration(deps, tx, actor, challengeId, response, name);
        if (id) await record("auth.passkey.registered", tx, actor, { action: "create" }, id);
        else await denied("auth.passkey.registration_denied", actor, tx);
        return id;
      });
      if (!publicId) throw badProof();
      return ok;
    },
    async renamePasskey(actor: SessionPrincipal, publicId: string, name: string) {
      requireFresh(actor, deps.clock.now());
      const result = await actorTx(actor, async (tx, _account, now) => {
        requireFresh(actor, now);
        const key = (await getPasskeys(tx, actor.userId)).find((item) => item.publicId === publicId);
        if (!key) {
          await record("auth.passkey.manage_denied", tx, actor, { outcome: "denied", reasonCode: "PASSKEY_NOT_FOUND", severity: "WARN" });
          return false;
        }
        await tx.update(assurancePasskeys).set({
          nameEnc: deps.crypto.encrypt(name, `assurance_passkeys.name_enc:${publicId}`), updatedAt: now,
        }).where(eq(assurancePasskeys.id, key.id));
        await record("auth.passkey.renamed", tx, actor, { action: "update" }, publicId);
        return true;
      });
      if (!result) throw notFound("PASSKEY_NOT_FOUND");
      return ok;
    },
    async removePasskey(actor: SessionPrincipal, publicId: string) {
      requireFresh(actor, deps.clock.now());
      const result = await actorTx(actor, async (tx, account, now) => {
        requireFresh(actor, now);
        const keys = await getPasskeys(tx, actor.userId);
        const key = keys.find((item) => item.publicId === publicId);
        if (!key) {
          await record("auth.passkey.manage_denied", tx, actor, { outcome: "denied", reasonCode: "PASSKEY_NOT_FOUND", severity: "WARN" });
          return false;
        }
        if (keys.length < 2 && !account.totpSecretEnc)
          throw conflict("LAST_STRONG_FACTOR", "Register another passkey or authenticator app before removing this passkey.");
        await tx.delete(assurancePasskeys).where(eq(assurancePasskeys.id, key.id));
        await record("auth.passkey.removed", tx, actor, { action: "delete" }, publicId);
        return true;
      });
      if (!result) throw notFound("PASSKEY_NOT_FOUND");
      return ok;
    },
  };
}
