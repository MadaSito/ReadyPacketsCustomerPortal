/** Integrity administration: status, verify, checkpoints. Owner: audit engineer. */
import { desc } from "drizzle-orm";
import type { AuditEventInput, SessionPrincipal, Tx } from "../../core/types.js";
import { actorOf, assertActorCurrent, assertAuditCapability, type AuditCtx } from "./access.js";
import { lockGate } from "./retention.js";
import { HORIZON_MS, type ChainVerification } from "./chain.js";
import { isDurableAuditEmitter } from "./emitter.js";
import { integrityCounts } from "./search.js";
import { auditCheckpoints } from "./schema.js";

export interface IntegrityStatus {
  headSeq: number;
  headHash: string;
  lastSealedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerifyOk: boolean | null;
  lastVerifyBreakSeq: number | null;
  unsealed: number;
  oldestUnsealedAgeSeconds: number | null;
  horizonSeconds: number;
  counts: { events: number; sealed: number; tombstones: number };
  checkpointPublicKey: string;
  checkpointKeyRef: string;
  emitter: { recordFailures: number; lastRecordFailureAt: string | null; notesDropped: number; notesQueued: number } | null;
}

export async function integrityStatus(ctx: AuditCtx, principal: SessionPrincipal): Promise<IntegrityStatus> {
  assertAuditCapability(ctx, principal, "audit.read");
  const head = await ctx.chain.head();
  const backlog = await ctx.chain.unsealedBacklog();
  const counts = await integrityCounts(ctx);
  const now = ctx.deps.clock.now().getTime();
  const audit = ctx.deps.audit;
  const emitterStats = isDurableAuditEmitter(audit) ? audit.stats() : null;
  return {
    headSeq: head.headSeq,
    headHash: head.headHash,
    lastSealedAt: head.lastSealedAt?.toISOString() ?? null,
    lastVerifiedAt: head.lastVerifiedAt?.toISOString() ?? null,
    lastVerifyOk: head.lastVerifyOk,
    lastVerifyBreakSeq: head.lastVerifyBreakSeq,
    unsealed: backlog.count,
    oldestUnsealedAgeSeconds: backlog.oldestObservedAt ? Math.max(0, Math.round((now - backlog.oldestObservedAt.getTime()) / 1000)) : null,
    horizonSeconds: HORIZON_MS / 1000,
    counts,
    checkpointPublicKey: ctx.chain.keys.publicKeyB64,
    checkpointKeyRef: ctx.chain.keys.signingKeyRef,
    emitter: emitterStats
      ? { recordFailures: emitterStats.recordFailures, lastRecordFailureAt: emitterStats.lastRecordFailureAt, notesDropped: emitterStats.notesDropped, notesQueued: emitterStats.notesQueued }
      : null,
  };
}

export async function verifyIntegrity(ctx: AuditCtx, principal: SessionPrincipal, options: { fromSeq?: number; maxEvents?: number } = {}): Promise<ChainVerification> {
  assertAuditCapability(ctx, principal, "audit.read");
  await ctx.chain.sealPending();
  const result = await ctx.chain.verify(options);
  await ctx.deps.audit.record({
    category: "security",
    eventName: result.ok ? "audit.integrity.verified" : "audit.integrity.break_detected",
    action: "verify",
    outcome: result.ok ? "completed" : "failed",
    severity: result.ok ? "INFO" : "ERROR",
    reasonCode: result.firstBreak?.reason,
    actor: actorOf(principal),
    attributes: { break_seq: result.firstBreak?.seq ?? null, complete: result.complete },
    safeCounts: { checked: result.checked, pruned: result.pruned, checkpoints: result.checkpointsVerified, unsealed_old: result.unsealedOlderThanHorizon },
  });
  return result;
}

export async function listCheckpoints(ctx: AuditCtx, principal: SessionPrincipal) {
  assertAuditCapability(ctx, principal, "audit.read");
  const rows = await ctx.deps.db.select().from(auditCheckpoints).orderBy(desc(auditCheckpoints.id)).limit(50);
  return rows.map((r) => ({
    id: r.publicId,
    seq: r.seq,
    headHash: r.headHash,
    signedAt: r.signedAt.toISOString(),
    algorithm: r.algorithm,
    keyRef: r.keyRef,
    publicKey: r.publicKey,
    signature: r.signature,
    reason: r.reason,
    installationRef: r.installationRef,
  }));
}

export async function createCheckpointAsAdmin(ctx: AuditCtx, principal: SessionPrincipal) {
  // Signing is a privileged integrity action: requires the step-up retention-management capability.
  assertAuditCapability(ctx, principal, "audit.retention.manage");
  await ctx.chain.sealPending();
  return ctx.deps.db.transaction(async (tx) => {
    // Hold the head steady while it is read, signed and the checkpoint + its audit row commit together.
    // Gate first (uniform lock order: chain head, then user row).
    await lockGate(tx, "share");
    await assertActorCurrent(ctx, principal, tx, "audit.retention.manage");
    return checkpointWithEvent(ctx, "manual", tx, actorOf(principal));
  });
}

/**
 * Creates a signed checkpoint and, in the SAME transaction, an `audit.checkpoint.created` event carrying the
 * checkpoint seq and head link (HMAC-SHA256, not secret). The event is forwarded to SIEM (both keys are on the
 * external allowlist), so an off-host copy of (seq, head link) exists for every checkpoint: compare it with
 * `audit_checkpoints` / `audit_chain.link_hash` at that seq to detect history rewrite or truncation.
 */
export async function checkpointWithEvent(
  ctx: AuditCtx,
  reason: "manual" | "scheduled" | "retention",
  tx?: Tx,
  actor: NonNullable<AuditEventInput["actor"]> = { role: "system" },
): Promise<{ publicId: string; seq: number; headHash: string }> {
  const run = async (db: Tx) => {
    const cp = await ctx.chain.createCheckpoint(reason, db);
    await ctx.deps.audit.record(
      {
        category: "security",
        eventName: "audit.checkpoint.created",
        action: "create",
        outcome: "completed",
        actor,
        resource: { type: "audit_checkpoint", publicId: cp.publicId },
        attributes: { checkpoint_seq: cp.seq, checkpoint_reason: reason, head_link_hmac_sha256: cp.headHash },
      },
      db,
    );
    return cp;
  };
  return tx ? run(tx) : ctx.deps.db.transaction(run);
}
