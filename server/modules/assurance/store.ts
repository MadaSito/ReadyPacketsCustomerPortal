import { randomBytes } from "node:crypto";
import { and, asc, count, eq, isNull, lte, sql } from "drizzle-orm";
import { Secret, TOTP } from "otpauth";
import type { ModuleDeps } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, Tx } from "../../core/types.js";
import { liveUserPredicate } from "../identity/live.js";
import { users } from "../identity/schema.js";
import { assuranceAccounts, assuranceChallenges, assurancePasskeys, assuranceRecoveryCodes } from "./schema.js";

export const PASSKEY_LIMIT = 10;
export const TOTP_TTL_MS = 10 * 60_000;
export type AssuranceAccount = typeof assuranceAccounts.$inferSelect;

export function totp(secret: string, label = "ReadyPackets"): TOTP {
  return new TOTP({ issuer: "ReadyPackets", label, secret: Secret.fromBase32(secret), digits: 6, algorithm: "SHA1", period: 30 });
}

export function totpStep(secret: string, code: string, now: Date): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const delta = totp(secret).validate({ token: code, timestamp: +now, window: 1 });
  return delta === null ? null : Math.max(0, Math.floor(+now / 30_000) + delta);
}

export function secretAad(account: AssuranceAccount, pending: boolean): string {
  return `assurance_accounts.${pending ? "pending_totp_secret_enc" : "totp_secret_enc"}:${account.publicId}`;
}

export async function lockAccount(tx: Tx, userId: number, now: Date): Promise<AssuranceAccount> {
  await tx.insert(assuranceAccounts).values({ userId, createdAt: now, updatedAt: now })
    .onDuplicateKeyUpdate({ set: { userId } });
  const [account] = await tx.select().from(assuranceAccounts).where(eq(assuranceAccounts.userId, userId)).limit(1).for("update");
  if (!account) throw new DomainError("UNAVAILABLE", "ASSURANCE_UNAVAILABLE", "Account security is temporarily unavailable.");
  return account;
}

export function getPasskeys(db: DbOrTx, userId: number) {
  return db.select().from(assurancePasskeys).where(eq(assurancePasskeys.userId, userId))
    .orderBy(asc(assurancePasskeys.id)).limit(PASSKEY_LIMIT + 1);
}

export async function getState(db: DbOrTx, userId: number) {
  const [account] = await db.select({
    secretEnc: assuranceAccounts.totpSecretEnc, acknowledgedAt: assuranceAccounts.recoveryAcknowledgedAt,
    passkeyCount: sql<number>`(select count(*) from ${assurancePasskeys}
      where ${assurancePasskeys.userId} = ${assuranceAccounts.userId})`.mapWith(Number),
  }).from(assuranceAccounts)
    .innerJoin(users, and(eq(users.id, assuranceAccounts.userId), liveUserPredicate()))
    .where(eq(assuranceAccounts.userId, userId)).limit(1);
  const passkeyCount = account?.passkeyCount ?? 0;
  const totpEnrolled = !!account?.secretEnc;
  return {
    mfaEnrolled: totpEnrolled || passkeyCount > 0, totpEnrolled, passkeyCount,
    recoveryCodesAcknowledged: !!account?.acknowledgedAt,
  };
}

export async function recoveryCount(db: DbOrTx, userId: number): Promise<number> {
  const [row] = await db.select({ total: count() }).from(assuranceRecoveryCodes)
    .where(and(eq(assuranceRecoveryCodes.userId, userId), isNull(assuranceRecoveryCodes.usedAt)));
  return row?.total ?? 0;
}

export function recoveryHash(deps: ModuleDeps, userId: number, input: string): string | null {
  if (input.length < 32 || input.length > 40) return null;
  const candidate = input.trim().toUpperCase();
  if (!/^(?:[0-9A-F]{32}|[0-9A-F]{8}(?:-[0-9A-F]{8}){3})$/.test(candidate)) return null;
  const normalized = candidate.replaceAll("-", "");
  return deps.crypto.hashToken(`assurance-recovery:${userId}:${normalized}`);
}

export interface RecoveryBatch {
  recoverySetId: string;
  recoveryCodes: string[];
}

export async function replaceRecoveryCodes(deps: ModuleDeps, tx: Tx, account: AssuranceAccount, now: Date): Promise<RecoveryBatch> {
  const recoverySetId = ulid(+now);
  const recoveryCodes = Array.from({ length: 10 }, () =>
    randomBytes(16).toString("hex").toUpperCase().replace(/(.{8})(?=.)/g, "$1-"),
  );
  await tx.delete(assuranceRecoveryCodes).where(eq(assuranceRecoveryCodes.userId, account.userId));
  await tx.insert(assuranceRecoveryCodes).values(recoveryCodes.map((code) => ({
    userId: account.userId, codeHash: recoveryHash(deps, account.userId, code)!, createdAt: now,
  })));
  await tx.update(assuranceAccounts).set({ recoverySetId, recoveryAcknowledgedAt: null, updatedAt: now })
    .where(eq(assuranceAccounts.id, account.id));
  return { recoveryCodes, recoverySetId };
}

export async function clearFactors(tx: Tx, userId: number, now: Date): Promise<void> {
  const account = await lockAccount(tx, userId, now);
  await tx.delete(assuranceRecoveryCodes).where(eq(assuranceRecoveryCodes.userId, userId));
  await tx.delete(assurancePasskeys).where(eq(assurancePasskeys.userId, userId));
  await tx.delete(assuranceChallenges).where(eq(assuranceChallenges.userId, userId));
  await tx.update(assuranceAccounts).set({
    totpSecretEnc: null, lastTotpStep: null, totpFailures: 0, totpLockedUntil: null,
    pendingTotpSecretEnc: null, pendingTotpSessionId: null,
    pendingTotpExpiresAt: null, recoverySetId: null, recoveryAcknowledgedAt: null, updatedAt: now,
  }).where(eq(assuranceAccounts.id, account.id));
}

export async function pruneChallenges(tx: Tx, now: Date): Promise<number> {
  const [result] = await tx.delete(assuranceChallenges).where(lte(assuranceChallenges.expiresAt, now)).limit(500);
  return result.affectedRows;
}

export async function prunePendingTotp(tx: Tx, now: Date): Promise<number> {
  const [result] = await tx.update(assuranceAccounts).set({
    pendingTotpSecretEnc: null, pendingTotpExpiresAt: null, pendingTotpSessionId: null, updatedAt: now,
  }).where(lte(assuranceAccounts.pendingTotpExpiresAt, now)).limit(500);
  return result.affectedRows;
}
