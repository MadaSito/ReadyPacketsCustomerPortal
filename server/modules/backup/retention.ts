/**
 * Retention planning and legal-hold protection for backup archives.
 *
 * Invariants (Architecture §7.2, §7.4):
 *  - NEVER prune the `lastKnownGood` backup (newest non-purged `completed` archive with `verificationStatus === "verified"`).
 *  - NEVER prune any archive with one or more active (`releasedAt IS NULL`) legal holds.
 *  - NEVER prune archives in `queued`, `running`, or `unknown` state (`unknown` outcomes stay preserved for investigation).
 *  - Retain at least `keepLastCount` newest completed archives AND any archive newer than `maxAgeDays`.
 */
import type { OperationState } from "../../../shared/domain.js";
import type { BackupVerificationStatus } from "./schema.js";

export type RetentionKeepReason =
  | "last_known_good"
  | "legal_hold"
  | "within_retention_count"
  | "within_retention_age"
  | "non_terminal_or_unknown";

export interface RetentionPlanCandidate {
  id: number;
  publicId: string;
  state: OperationState;
  verificationStatus: BackupVerificationStatus;
  storageKey: string | null;
  activeHoldCount: number;
  createdAt: Date;
  purgedAt: Date | null;
}

export interface RetentionPlanEntry {
  id: number;
  backupPublicId: string;
  storageKey: string | null;
  createdAt: Date;
  action: "keep" | "prune";
  keepReason: RetentionKeepReason | null;
}

export function findLastKnownGoodPublicId(candidates: readonly RetentionPlanCandidate[]): string | null {
  const verified = candidates
    .filter((c) => c.purgedAt === null && c.state === "completed" && c.verificationStatus === "verified")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
  return verified[0]?.publicId ?? null;
}

export function buildRetentionPlan(
  candidates: readonly RetentionPlanCandidate[],
  policy: { keepLastCount: number; maxAgeDays: number },
  now: Date,
): RetentionPlanEntry[] {
  const active = candidates
    .filter((c) => c.purgedAt === null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);

  const lastKnownGoodId = findLastKnownGoodPublicId(active);
  const maxAgeMs = policy.maxAgeDays * 24 * 60 * 60 * 1000;
  let completedRank = 0;

  return active.map((c): RetentionPlanEntry => {
    const isCompleted = c.state === "completed";
    if (isCompleted) {
      completedRank += 1;
    }

    if (c.state === "queued" || c.state === "running" || c.state === "unknown") {
      return {
        id: c.id,
        backupPublicId: c.publicId,
        storageKey: c.storageKey,
        createdAt: c.createdAt,
        action: "keep",
        keepReason: "non_terminal_or_unknown",
      };
    }

    if (c.publicId === lastKnownGoodId) {
      return {
        id: c.id,
        backupPublicId: c.publicId,
        storageKey: c.storageKey,
        createdAt: c.createdAt,
        action: "keep",
        keepReason: "last_known_good",
      };
    }

    if (c.activeHoldCount > 0) {
      return {
        id: c.id,
        backupPublicId: c.publicId,
        storageKey: c.storageKey,
        createdAt: c.createdAt,
        action: "keep",
        keepReason: "legal_hold",
      };
    }

    if (isCompleted && completedRank <= policy.keepLastCount) {
      return {
        id: c.id,
        backupPublicId: c.publicId,
        storageKey: c.storageKey,
        createdAt: c.createdAt,
        action: "keep",
        keepReason: "within_retention_count",
      };
    }

    if (now.getTime() - c.createdAt.getTime() <= maxAgeMs) {
      return {
        id: c.id,
        backupPublicId: c.publicId,
        storageKey: c.storageKey,
        createdAt: c.createdAt,
        action: "keep",
        keepReason: "within_retention_age",
      };
    }

    return {
      id: c.id,
      backupPublicId: c.publicId,
      storageKey: c.storageKey,
      createdAt: c.createdAt,
      action: "prune",
      keepReason: null,
    };
  });
}
