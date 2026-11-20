/**
 * Retention policies, legal holds and the retention job. Owner: audit engineer.
 *
 * - No policy for a category ⇒ keep forever (no invented universal legal period).
 * - Policy bounds 30..3650 days. Only SEALED events are removable, and each removal writes a tombstone that
 *   preserves the chain digest, so `verifyChain` still verifies end to end ("pruned" count).
 * - Active legal holds (time window × optional categories) and events attached to non-closed incident
 *   cases are never removed.
 * - Every run (dry or real) is recorded in `audit_retention_runs` and audited; a real run that removed
 *   events also writes a signed checkpoint.
 * The ONLY code path in the system that deletes from `audit_events` is `removeBatch` below.
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { notFound, validation } from "../../core/errors.js";
import { checkpointWithEvent } from "./integrity.js";
import { ulid, ULID_PATTERN } from "../../core/ids.js";
import { AUDIT_CATEGORIES, type AuditCategory, type SessionPrincipal } from "../../core/types.js";
import { neutraliseControl } from "../../observability/redact.js";
import type { DbOrTx } from "../../core/types.js";
import { actorOf, assertActorCurrent, assertAuditCapability, type AuditCtx } from "./access.js";
import { auditCaseEvents, auditCases, auditChain, auditChainHead, auditEvents, auditLegalHolds, auditRetentionPolicies, auditRetentionRuns, auditTombstones } from "./schema.js";

export const RETENTION_JOB = "audit.retention.run";
export const MIN_RETAIN_DAYS = 30;
export const MAX_RETAIN_DAYS = 3650;
const BATCH = 500;
const MAX_BATCHES_PER_RUN = 200;

/**
 * Retention gate. Deletion takes it EXCLUSIVELY; anything that can newly protect an event (legal hold
 * create, case create/attach/reopen) takes it SHARED as the first lock in its transaction. Row locks on
 * the anti-join tables cannot do this (a new hold/case row is an insert the deleter never locked).
 * The gate is the singleton chain-head row; the sealer also locks it first, so lock order is uniform.
 */
export async function retentionGateReady(ctx: AuditCtx): Promise<void> {
  // Call BEFORE opening the transaction: ensures the singleton row exists, on its own connection.
  await ctx.chain.head();
}

/** Must be the FIRST lock taken in the caller's transaction. */
export async function lockGate(tx: DbOrTx, mode: "share" | "update"): Promise<void> {
  await tx.select({ id: auditChainHead.id }).from(auditChainHead).where(eq(auditChainHead.id, 1)).for(mode);
}

export interface RetentionPolicyView {
  category: AuditCategory;
  retainDays: number | null;
  updatedAt: string | null;
}

export interface LegalHoldView {
  id: string;
  label: string;
  categories: AuditCategory[] | null;
  from: string;
  to: string;
  active: boolean;
  createdAt: string;
  releasedAt: string | null;
}

export interface RetentionRunView {
  id: string;
  dryRun: boolean;
  status: string;
  counts: Record<string, number>;
  startedAt: string;
  finishedAt: string | null;
  checkpointId: string | null;
}

export async function getRetention(ctx: AuditCtx, principal: SessionPrincipal): Promise<{ policies: RetentionPolicyView[]; holds: LegalHoldView[]; runs: RetentionRunView[] }> {
  assertAuditCapability(ctx, principal, "audit.read");
  const policies = await ctx.deps.db.select().from(auditRetentionPolicies);
  const byCat = new Map(policies.map((p) => [p.category, p]));
  const holds = await ctx.deps.db.select().from(auditLegalHolds).orderBy(desc(auditLegalHolds.id)).limit(100);
  const runs = await ctx.deps.db.select().from(auditRetentionRuns).orderBy(desc(auditRetentionRuns.id)).limit(20);
  return {
    policies: AUDIT_CATEGORIES.map((category) => ({ category, retainDays: byCat.get(category)?.retainDays ?? null, updatedAt: byCat.get(category)?.updatedAt.toISOString() ?? null })),
    holds: holds.map((h) => {
      let label = "[unreadable]";
      try {
        label = ctx.deps.crypto.decrypt(h.labelEnc, `audit_legal_holds.label:${h.publicId}`);
      } catch {
        /* keep placeholder */
      }
      return { id: h.publicId, label, categories: (h.categories as AuditCategory[] | null) ?? null, from: h.fromAt.toISOString(), to: h.toAt.toISOString(), active: h.releasedAt === null, createdAt: h.createdAt.toISOString(), releasedAt: h.releasedAt?.toISOString() ?? null };
    }),
    runs: runs.map((r) => ({ id: r.publicId, dryRun: r.dryRun, status: r.status, counts: r.counts, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, checkpointId: r.checkpointPublicId })),
  };
}

export async function setRetentionPolicy(ctx: AuditCtx, principal: SessionPrincipal, input: { category: AuditCategory; retainDays: number | null }): Promise<void> {
  assertAuditCapability(ctx, principal, "audit.retention.manage");
  if (!AUDIT_CATEGORIES.includes(input.category)) throw validation("CATEGORY_INVALID", "Choose a valid category.");
  if (input.retainDays !== null && (!Number.isInteger(input.retainDays) || input.retainDays < MIN_RETAIN_DAYS || input.retainDays > MAX_RETAIN_DAYS)) {
    throw validation("RETENTION_OUT_OF_RANGE", `Retention must be between ${MIN_RETAIN_DAYS} and ${MAX_RETAIN_DAYS} days.`);
  }
  await ctx.deps.db.transaction(async (tx) => {
    await assertActorCurrent(ctx, principal, tx, "audit.retention.manage");
    const [before] = await tx.select().from(auditRetentionPolicies).where(eq(auditRetentionPolicies.category, input.category)).for("update");
    if (input.retainDays === null) await tx.delete(auditRetentionPolicies).where(eq(auditRetentionPolicies.category, input.category));
    else
      await tx
        .insert(auditRetentionPolicies)
        .values({ category: input.category, retainDays: input.retainDays, updatedBy: principal.userId, updatedAt: ctx.deps.clock.now() })
        .onDuplicateKeyUpdate({ set: { retainDays: input.retainDays, updatedBy: principal.userId, updatedAt: ctx.deps.clock.now() } });
    await ctx.deps.audit.record(
      {
        category: "admin",
        eventName: "audit.retention.policy_changed",
        action: "update",
        outcome: "completed",
        severity: "WARN",
        actor: actorOf(principal),
        resource: { type: "audit_retention_policy", publicId: input.category },
        attributes: { audit_category: input.category, from_days: before?.retainDays ?? null, to_days: input.retainDays },
      },
      tx,
    );
  });
}

export async function createLegalHold(
  ctx: AuditCtx,
  principal: SessionPrincipal,
  input: { label: string; categories: AuditCategory[] | null; from: string; to: string },
): Promise<{ id: string }> {
  assertAuditCapability(ctx, principal, "audit.retention.manage");
  const label = neutraliseControl(input.label.normalize("NFC").trim()).slice(0, 120);
  if (!label) throw validation("LABEL_REQUIRED", "Give the legal hold a label.");
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || !(from < to)) throw validation("HOLD_RANGE_INVALID", "The hold must start before it ends.");
  if (input.categories && input.categories.some((c) => !AUDIT_CATEGORIES.includes(c))) throw validation("CATEGORY_INVALID", "Choose valid categories.");
  const publicId = ulid(ctx.deps.clock.now().getTime());
  await retentionGateReady(ctx);
  await ctx.deps.db.transaction(async (tx) => {
    await lockGate(tx, "share");
    await assertActorCurrent(ctx, principal, tx, "audit.retention.manage");
    await tx.insert(auditLegalHolds).values({
      publicId,
      labelEnc: ctx.deps.crypto.encrypt(label, `audit_legal_holds.label:${publicId}`),
      categories: input.categories && input.categories.length > 0 ? [...new Set(input.categories)] : null,
      fromAt: from,
      toAt: to,
      createdBy: principal.userId,
    });
    await ctx.deps.audit.record(
      { category: "admin", eventName: "audit.legal_hold.created", action: "create", outcome: "completed", severity: "WARN", actor: actorOf(principal), resource: { type: "audit_legal_hold", publicId }, safeCounts: { categories: input.categories?.length ?? 0 } },
      tx,
    );
  });
  return { id: publicId };
}

export async function releaseLegalHold(ctx: AuditCtx, principal: SessionPrincipal, id: string): Promise<void> {
  assertAuditCapability(ctx, principal, "audit.retention.manage");
  if (!ULID_PATTERN.test(id)) throw notFound();
  await ctx.deps.db.transaction(async (tx) => {
    await assertActorCurrent(ctx, principal, tx, "audit.retention.manage");
    const [hold] = await tx.select().from(auditLegalHolds).where(eq(auditLegalHolds.publicId, id)).for("update");
    if (!hold) throw notFound();
    if (hold.releasedAt) return;
    await tx.update(auditLegalHolds).set({ releasedAt: ctx.deps.clock.now(), releasedBy: principal.userId }).where(eq(auditLegalHolds.id, hold.id));
    await ctx.deps.audit.record(
      { category: "admin", eventName: "audit.legal_hold.released", action: "release", outcome: "completed", severity: "WARN", actor: actorOf(principal), resource: { type: "audit_legal_hold", publicId: id } },
      tx,
    );
  });
}

/** Eligible = sealed, older than cutoff, not under an active hold, not attached to an open case. */
function eligibleWhere(category: string, cutoff: Date) {
  return and(
    eq(auditEvents.category, category),
    lt(auditEvents.occurredAt, cutoff),
    sql`NOT EXISTS (SELECT 1 FROM ${auditLegalHolds} h WHERE h.released_at IS NULL AND ${auditEvents.occurredAt} >= h.from_at AND ${auditEvents.occurredAt} <= h.to_at AND (h.categories IS NULL OR JSON_CONTAINS(h.categories, JSON_QUOTE(${auditEvents.category}))))`,
    sql`NOT EXISTS (SELECT 1 FROM ${auditCaseEvents} ce INNER JOIN ${auditCases} c ON c.id = ce.case_id WHERE ce.event_id = ${auditEvents.eventId} AND c.status <> 'closed')`,
  );
}

async function removeBatch(ctx: AuditCtx, category: string, cutoff: Date, runId: string, counts: Record<string, number>): Promise<number> {
  return ctx.deps.db.transaction(async (tx) => {
    // Exclusive gate first: no hold/case can newly protect an event while this batch decides + deletes.
    await lockGate(tx, "update");
    const rows = await tx
      .select({ id: auditEvents.id, eventId: auditEvents.eventId, occurredAt: auditEvents.occurredAt, seq: auditChain.seq, digest: auditChain.eventDigest })
      .from(auditEvents)
      .innerJoin(auditChain, eq(auditChain.eventRowId, auditEvents.id))
      .where(eligibleWhere(category, cutoff))
      .orderBy(auditEvents.id)
      .limit(BATCH)
      .for("update");
    if (rows.length === 0) return 0;
    const now = ctx.deps.clock.now();
    // Durable audit of THIS batch, in the same transaction, BEFORE the delete: no destructive effect can
    // commit without its record, and a crash leaves neither.
    await ctx.deps.audit.record(
      {
        category: "system",
        eventName: "audit.retention.batch_removed",
        action: "delete",
        outcome: "completed",
        severity: "WARN",
        actor: { role: "system" },
        resource: { type: "audit_retention_run", publicId: runId },
        correlationId: runId,
        attributes: { audit_category: category, first_seq: rows[0]!.seq, last_seq: rows[rows.length - 1]!.seq },
        safeCounts: { events: rows.length },
      },
      tx,
    );
    await tx.insert(auditTombstones).values(
      rows.map((r) => ({
        eventRowId: r.id,
        eventId: r.eventId,
        seq: r.seq,
        eventDigest: r.digest,
        category,
        occurredAt: r.occurredAt,
        retentionRunId: runId,
        removedAt: now,
        receipt: ctx.chain.keys.tombstone(r.seq, r.eventId, r.digest, runId),
      })),
    );
    await tx.delete(auditEvents).where(inArray(auditEvents.id, rows.map((r) => r.id)));
    // Progress receipt in the same transaction.
    const next = { ...counts, [category]: (counts[category] ?? 0) + rows.length };
    await tx.update(auditRetentionRuns).set({ counts: next }).where(eq(auditRetentionRuns.publicId, runId));
    Object.assign(counts, next);
    return rows.length;
  });
}

export async function runRetention(ctx: AuditCtx, options: { dryRun: boolean; requestedBy: number | null }, principal?: SessionPrincipal): Promise<RetentionRunView> {
  const runId = ulid(ctx.deps.clock.now().getTime());
  const startedAt = ctx.deps.clock.now();
  const actor = principal ? actorOf(principal) : ({ role: "system" } as const);
  await retentionGateReady(ctx);
  await ctx.chain.sealPending();
  // Durable ATTEMPT before any work (same transaction as the run row).
  await ctx.deps.db.transaction(async (tx) => {
    if (principal && !options.dryRun) await assertActorCurrent(ctx, principal, tx, "audit.retention.manage");
    await tx.insert(auditRetentionRuns).values({ publicId: runId, dryRun: options.dryRun, status: "running", requestedBy: options.requestedBy, counts: {}, startedAt });
    await ctx.deps.audit.record(
      {
        category: "system",
        eventName: options.dryRun ? "audit.retention.preview_started" : "audit.retention.started",
        action: options.dryRun ? "preview" : "delete",
        outcome: "attempted",
        severity: options.dryRun ? "INFO" : "WARN",
        actor,
        resource: { type: "audit_retention_run", publicId: runId },
        correlationId: runId,
      },
      tx,
    );
  });
  const policies = await ctx.deps.db.select().from(auditRetentionPolicies);
  const counts: Record<string, number> = {};
  let status = "completed";
  let checkpointId: string | null = null;
  try {
    for (const policy of policies) {
      const cutoff = new Date(startedAt.getTime() - policy.retainDays * 86_400_000);
      if (options.dryRun) {
        const [row] = await ctx.deps.db
          .select({ n: sql<number>`count(*)` })
          .from(auditEvents)
          .innerJoin(auditChain, eq(auditChain.eventRowId, auditEvents.id))
          .where(eligibleWhere(policy.category, cutoff));
        counts[policy.category] = Number(row?.n ?? 0);
      } else {
        counts[policy.category] = counts[policy.category] ?? 0;
        for (let i = 0; i < MAX_BATCHES_PER_RUN; i += 1) {
          const n = await removeBatch(ctx, policy.category, cutoff, runId, counts);
          if (n < BATCH) break;
        }
      }
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!options.dryRun && total > 0) {
      await ctx.chain.sealPending();
      checkpointId = (await checkpointWithEvent(ctx, "retention")).publicId;
    }
  } catch (error) {
    status = "failed";
    ctx.deps.logger.error("audit retention run failed", { run_id: runId, error });
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  await ctx.deps.db.transaction(async (tx) => {
    await tx.update(auditRetentionRuns).set({ status, counts, finishedAt: ctx.deps.clock.now(), checkpointPublicId: checkpointId }).where(eq(auditRetentionRuns.publicId, runId));
    await ctx.deps.audit.record(
      {
        category: "system",
        eventName: options.dryRun ? "audit.retention.previewed" : "audit.retention.run",
        action: options.dryRun ? "preview" : "delete",
        outcome: status === "completed" ? "completed" : "failed",
        reasonCode: status === "completed" ? undefined : "RETENTION_FAILED",
        severity: options.dryRun ? "INFO" : "WARN",
        actor,
        resource: { type: "audit_retention_run", publicId: runId },
        correlationId: runId,
        safeCounts: { events: total, categories: Object.keys(counts).length },
      },
      tx,
    );
  });
  return { id: runId, dryRun: options.dryRun, status, counts, startedAt: startedAt.toISOString(), finishedAt: ctx.deps.clock.now().toISOString(), checkpointId };
}

export async function runRetentionAsAdmin(ctx: AuditCtx, principal: SessionPrincipal, dryRun: boolean): Promise<RetentionRunView> {
  // Previews need only read access; deletion needs the step-up retention capability.
  assertAuditCapability(ctx, principal, dryRun ? "audit.read" : "audit.retention.manage");
  return runRetention(ctx, { dryRun, requestedBy: principal.userId }, principal);
}
