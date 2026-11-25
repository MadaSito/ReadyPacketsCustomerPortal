/**
 * Increment 07 (D5): Immediate and delayed order completion percentage policy admission,
 * single-roll server CSPRNG range resolution (`crypto.randomInt(min, max + 1)`),
 * revision-fenced one-shot background execution, superseding on stage exit / cancel / reopen /
 * newer completion write, and administrator cancellation.
 */
import { randomInt } from "node:crypto";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { StageCompletion } from "../../../shared/workflowStages.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, forbidden, notFound } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { ClaimedJob, Db, FieldCrypto, JobResult, SessionPrincipal, Tx } from "../../core/types.js";
import { automationCorrelationId } from "../audit/tap.js";
import { users } from "../identity/schema.js";
import { lockBlocks, orderLocked } from "../orders/policy.js";
import { orders } from "../orders/schema.js";
import {
  assertAutomationsActorInTx,
  assertAutomationsCapabilityPreflight,
  recordAutomationsDenied,
} from "./authz.js";
import type {
  CompletionJobSource,
  CompletionJobState,
  OrderCompletionJobView,
  OrderStageRunActorView,
} from "./contracts.js";
import { orderCompletionJobs } from "./schema.js";

export const JOB_APPLY_COMPLETION = "automations.apply_completion";
export const MAX_COMPLETION_JOB_ATTEMPTS = 3;

export interface ApplyCompletionJobPayload {
  completionJobPublicId: string;
}

export function sanitizeOpsAlertCopy(raw: string, maxLen: number): string {
  const cleaned = raw
    .replace(/->/g, " to ")
    .replace(/[<>\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Operational alert";
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

export async function loadActorViewsById(
  handle: Db | Tx,
  crypto: FieldCrypto,
  userIds: readonly (number | null | undefined)[],
): Promise<Map<number, OrderStageRunActorView>> {
  const map = new Map<number, OrderStageRunActorView>();
  const uniqueIds = [...new Set(userIds.filter((id): id is number => typeof id === "number" && id > 0))];
  if (uniqueIds.length === 0) return map;
  const rows = await handle
    .select({
      id: users.id,
      publicId: users.publicId,
      nameEnc: users.nameEnc,
      role: users.role,
    })
    .from(users)
    .where(inArray(users.id, uniqueIds));
  for (const r of rows) {
    let displayName: string;
    try {
      displayName = crypto.decrypt(r.nameEnc, `users.name:${r.publicId}`);
    } catch {
      displayName = r.publicId;
    }
    map.set(r.id, {
      publicId: r.publicId,
      displayName,
      role: r.role,
    });
  }
  return map;
}

export function completionJobRowToView(
  row: typeof orderCompletionJobs.$inferSelect,
  actors: ReadonlyMap<number, OrderStageRunActorView>,
): OrderCompletionJobView {
  return {
    publicId: row.publicId,
    orderPublicId: row.orderPublicId,
    stageKey: row.stageKey,
    sourceKind: row.sourceKind,
    sourcePublicId: row.sourcePublicId,
    policyKind: row.policyKind,
    minPercent: row.minPercent,
    maxPercent: row.maxPercent,
    resolvedPercent: row.resolvedPercent,
    delayMinutes: row.delayMinutes,
    dueAt: row.dueAt,
    expectedRevision: row.expectedRevision,
    appliedRevision: row.appliedRevision,
    state: row.state,
    attemptCount: row.attemptCount,
    reasonCode: row.reasonCode,
    createdBy: row.createdByUserId ? (actors.get(row.createdByUserId) ?? null) : null,
    canceledBy: row.canceledByUserId ? (actors.get(row.canceledByUserId) ?? null) : null,
    canceledAt: row.canceledAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}

export async function hydrateCompletionJobViews(
  handle: Db | Tx,
  crypto: FieldCrypto,
  rows: readonly (typeof orderCompletionJobs.$inferSelect)[],
): Promise<OrderCompletionJobView[]> {
  if (rows.length === 0) return [];
  const actorIds: (number | null)[] = [];
  for (const r of rows) {
    actorIds.push(r.createdByUserId, r.canceledByUserId);
  }
  const actors = await loadActorViewsById(handle, crypto, actorIds);
  return rows.map((r) => completionJobRowToView(r, actors));
}

export function resolveCompletionPolicyPercent(policy: StageCompletion): {
  policyKind: "fixed" | "range";
  minPercent: number;
  maxPercent: number;
  resolvedPercent: number;
  delayMinutes: number;
} {
  const delayMinutes = policy.delayMinutes ?? 0;
  if (policy.kind === "fixed") {
    return {
      policyKind: "fixed",
      minPercent: policy.percent,
      maxPercent: policy.percent,
      resolvedPercent: policy.percent,
      delayMinutes,
    };
  }
  const minPercent = Math.min(policy.min, policy.max);
  const maxPercent = Math.max(policy.min, policy.max);
  const resolvedPercent =
    minPercent === maxPercent ? minPercent : randomInt(minPercent, maxPercent + 1);
  return {
    policyKind: "range",
    minPercent,
    maxPercent,
    resolvedPercent,
    delayMinutes,
  };
}

export async function supersedeOrderCompletionJobsInTx(
  deps: ModuleDeps,
  tx: Tx,
  input: {
    orderId: number;
    orderPublicId: string;
    reasonCode: string;
    correlationId?: string;
    onlyJobIds?: readonly number[];
  },
): Promise<number> {
  const pendingRows = await tx
    .select()
    .from(orderCompletionJobs)
    .where(
      and(
        eq(orderCompletionJobs.orderId, input.orderId),
        eq(orderCompletionJobs.state, "scheduled"),
        ...(input.onlyJobIds && input.onlyJobIds.length > 0
          ? [inArray(orderCompletionJobs.id, [...input.onlyJobIds])]
          : []),
      ),
    )
    .for("update");

  if (pendingRows.length === 0) return 0;

  const now = deps.clock.now();
  for (const row of pendingRows) {
    await tx
      .update(orderCompletionJobs)
      .set({
        state: "superseded",
        reasonCode: input.reasonCode,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(orderCompletionJobs.id, row.id));

    await deps.audit.record(
      {
        category: "business",
        eventName: "order.completion.superseded",
        action: "transition",
        outcome: "completed",
        severity: "INFO",
        reasonCode: input.reasonCode,
        actor: { role: "system" },
        resource: { type: "order_completion_job", publicId: row.publicId },
        orderPublicId: input.orderPublicId,
        correlationId: input.correlationId ?? row.correlationId,
        attributes: {
          order_public_id: input.orderPublicId,
          completion_job_public_id: row.publicId,
          stage_key: row.stageKey ?? "none",
          resolved_percent: row.resolvedPercent,
          expected_revision: row.expectedRevision,
          reason_code: input.reasonCode,
        },
      },
      tx,
    );
  }

  return pendingRows.length;
}

export interface AdmitOrderCompletionInput {
  orderId: number;
  orderPublicId: string;
  workflowVersionId: number;
  stageKey: string | null;
  expectedRevision: number;
  policy: StageCompletion;
  sourceKind: CompletionJobSource;
  sourcePublicId: string;
  idempotencyKey: string;
  correlationId: string;
  createdByUserId: number | null;
}

export interface AdmitOrderCompletionResult {
  deduplicated: boolean;
  jobRow: typeof orderCompletionJobs.$inferSelect;
  immediateApplied: boolean;
  supersededReasonCode: string | null;
  currentProgressPercent: number | null;
  currentRevision: number;
}

export async function admitOrderCompletionInTx(
  deps: ModuleDeps,
  tx: Tx,
  input: AdmitOrderCompletionInput,
): Promise<AdmitOrderCompletionResult> {
  const [existing] = await tx
    .select()
    .from(orderCompletionJobs)
    .where(eq(orderCompletionJobs.idempotencyKey, input.idempotencyKey))
    .limit(1);

  if (existing) {
    return {
      deduplicated: true,
      jobRow: existing,
      immediateApplied: existing.state === "applied",
      supersededReasonCode: existing.state === "superseded" ? existing.reasonCode : null,
      currentProgressPercent: existing.state === "applied" ? existing.resolvedPercent : null,
      currentRevision: existing.appliedRevision ?? existing.expectedRevision,
    };
  }

  const [orderLockRow] = await tx
    .select({ lockState: orders.lockState })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for("update");
  if (!orderLockRow) {
    throw notFound("Order not found.");
  }
  if (lockBlocks(orderLockRow.lockState, true, "order")) {
    throw orderLocked(orderLockRow.lockState);
  }

  await supersedeOrderCompletionJobsInTx(deps, tx, {
    orderId: input.orderId,
    orderPublicId: input.orderPublicId,
    reasonCode: "SUPERSEDED_BY_NEWER_COMPLETION",
    correlationId: input.correlationId,
  });

  const now = deps.clock.now();
  const completionJobPublicId = ulid();
  const resolved = resolveCompletionPolicyPercent(input.policy);

  if (resolved.delayMinutes === 0) {
    const applyRes = await deps.services.orders.stages.applyCompletionPercent(
      {
        orderPublicId: input.orderPublicId,
        percent: resolved.resolvedPercent,
        expectedRevision: input.expectedRevision,
        source: input.sourceKind === "stage_run" ? "stage_run" : "rule",
        sourceRef: input.sourcePublicId,
      },
      tx,
    );

    const state: CompletionJobState = applyRes.applied ? "applied" : "superseded";
    const reasonCode = applyRes.applied ? null : "REVISION_MISMATCH";

    await tx.insert(orderCompletionJobs).values({
      publicId: completionJobPublicId,
      orderId: input.orderId,
      orderPublicId: input.orderPublicId,
      workflowVersionId: input.workflowVersionId,
      stageKey: input.stageKey,
      sourceKind: input.sourceKind,
      sourcePublicId: input.sourcePublicId,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      policyKind: resolved.policyKind,
      minPercent: resolved.minPercent,
      maxPercent: resolved.maxPercent,
      resolvedPercent: resolved.resolvedPercent,
      delayMinutes: 0,
      dueAt: now,
      expectedRevision: input.expectedRevision,
      appliedRevision: applyRes.applied ? applyRes.revision : null,
      jobPublicId: null,
      state,
      attemptCount: 1,
      reasonCode,
      createdByUserId: input.createdByUserId,
      canceledByUserId: null,
      canceledAt: null,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const [inserted] = await tx
      .select()
      .from(orderCompletionJobs)
      .where(eq(orderCompletionJobs.publicId, completionJobPublicId))
      .limit(1);

    if (applyRes.applied) {
      await deps.audit.record(
        {
          category: "business",
          eventName: "order.completion.updated",
          action: "update",
          outcome: "completed",
          severity: "INFO",
          actor: input.createdByUserId
            ? { userId: input.createdByUserId, role: "staff" }
            : { role: "system" },
          resource: { type: "order", publicId: input.orderPublicId },
          orderPublicId: input.orderPublicId,
          correlationId: input.correlationId,
          attributes: {
            order_public_id: input.orderPublicId,
            completion_job_public_id: completionJobPublicId,
            stage_key: input.stageKey ?? "none",
            source_kind: input.sourceKind,
            source_public_id: input.sourcePublicId,
            policy_kind: resolved.policyKind,
            resolved_percent: resolved.resolvedPercent,
            delay_minutes: 0,
            expected_revision: input.expectedRevision,
            applied_revision: applyRes.revision,
          },
        },
        tx,
      );
    } else {
      await deps.audit.record(
        {
          category: "business",
          eventName: "order.completion.superseded",
          action: "transition",
          outcome: "completed",
          severity: "INFO",
          reasonCode: "REVISION_MISMATCH",
          actor: { role: "system" },
          resource: { type: "order_completion_job", publicId: completionJobPublicId },
          orderPublicId: input.orderPublicId,
          correlationId: input.correlationId,
          attributes: {
            order_public_id: input.orderPublicId,
            completion_job_public_id: completionJobPublicId,
            stage_key: input.stageKey ?? "none",
            resolved_percent: resolved.resolvedPercent,
            expected_revision: input.expectedRevision,
            current_revision: applyRes.revision,
            reason_code: "REVISION_MISMATCH",
          },
        },
        tx,
      );
    }

    return {
      deduplicated: false,
      jobRow: inserted!,
      immediateApplied: applyRes.applied,
      supersededReasonCode: reasonCode,
      currentProgressPercent: applyRes.progressPercent,
      currentRevision: applyRes.revision,
    };
  }

  const dueAt = new Date(now.getTime() + resolved.delayMinutes * 60_000);
  const jobCorrelationId = automationCorrelationId(completionJobPublicId);

  const enqueued = await deps.jobs.enqueue<ApplyCompletionJobPayload>(
    JOB_APPLY_COMPLETION,
    { completionJobPublicId },
    {
      idempotencyKey: `completion-job:${completionJobPublicId}`,
      runAt: dueAt,
      maxAttempts: MAX_COMPLETION_JOB_ATTEMPTS,
      correlationId: jobCorrelationId,
    },
    tx,
  );

  await tx.insert(orderCompletionJobs).values({
    publicId: completionJobPublicId,
    orderId: input.orderId,
    orderPublicId: input.orderPublicId,
    workflowVersionId: input.workflowVersionId,
    stageKey: input.stageKey,
    sourceKind: input.sourceKind,
    sourcePublicId: input.sourcePublicId,
    idempotencyKey: input.idempotencyKey,
    correlationId: jobCorrelationId,
    policyKind: resolved.policyKind,
    minPercent: resolved.minPercent,
    maxPercent: resolved.maxPercent,
    resolvedPercent: resolved.resolvedPercent,
    delayMinutes: resolved.delayMinutes,
    dueAt,
    expectedRevision: input.expectedRevision,
    appliedRevision: null,
    jobPublicId: enqueued.jobId,
    state: "scheduled",
    attemptCount: 0,
    reasonCode: null,
    createdByUserId: input.createdByUserId,
    canceledByUserId: null,
    canceledAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const [inserted] = await tx
    .select()
    .from(orderCompletionJobs)
    .where(eq(orderCompletionJobs.publicId, completionJobPublicId))
    .limit(1);

  await deps.audit.record(
    {
      category: "business",
      eventName: "order.completion.scheduled",
      action: "create",
      outcome: "completed",
      severity: "INFO",
      actor: input.createdByUserId
        ? { userId: input.createdByUserId, role: "staff" }
        : { role: "system" },
      resource: { type: "order_completion_job", publicId: completionJobPublicId },
      orderPublicId: input.orderPublicId,
      correlationId: input.correlationId,
      attributes: {
        order_public_id: input.orderPublicId,
        completion_job_public_id: completionJobPublicId,
        stage_key: input.stageKey ?? "none",
        source_kind: input.sourceKind,
        source_public_id: input.sourcePublicId,
        policy_kind: resolved.policyKind,
        resolved_percent: resolved.resolvedPercent,
        delay_minutes: resolved.delayMinutes,
        due_at_iso: dueAt.toISOString(),
        expected_revision: input.expectedRevision,
      },
    },
    tx,
  );

  return {
    deduplicated: false,
    jobRow: inserted!,
    immediateApplied: false,
    supersededReasonCode: null,
    currentProgressPercent: null,
    currentRevision: input.expectedRevision,
  };
}

export async function handleOrderChangeForCompletionJobs(
  deps: ModuleDeps,
  event: {
    orderId: number;
    orderPublicId: string;
    kind: "created" | "updated" | "status_changed" | "assigned" | "deleted";
  },
  tx: Tx,
): Promise<void> {
  if (event.kind !== "status_changed" && event.kind !== "deleted") return;

  const scheduled = await tx
    .select()
    .from(orderCompletionJobs)
    .where(
      and(
        eq(orderCompletionJobs.orderId, event.orderId),
        eq(orderCompletionJobs.state, "scheduled"),
      ),
    );
  if (scheduled.length === 0) return;

  if (event.kind === "deleted") {
    await supersedeOrderCompletionJobsInTx(deps, tx, {
      orderId: event.orderId,
      orderPublicId: event.orderPublicId,
      reasonCode: "ORDER_DELETED",
    });
    return;
  }

  const ctx = await deps.services.orders.stages.contextForRun(event.orderPublicId, tx);
  const catalogEntries = deps.services.orders.statusCatalog
    ? await deps.services.orders.statusCatalog.listEntries({ includeRetired: true, tx })
    : [];
  const currentEntry = catalogEntries.find((e) => e.key === ctx.statusKey);
  const isCanceled = ctx.statusKey === "canceled" || currentEntry?.category === "canceled";

  for (const row of scheduled) {
    let reason: string | null = null;
    if (isCanceled) {
      reason = "ORDER_CANCELED";
    } else if (ctx.completionRevision !== row.expectedRevision) {
      reason = "REVISION_CHANGED";
    } else if (row.stageKey !== null && ctx.currentStageKey !== row.stageKey) {
      reason = "STAGE_CHANGED";
    }
    if (reason) {
      await supersedeOrderCompletionJobsInTx(deps, tx, {
        orderId: event.orderId,
        orderPublicId: event.orderPublicId,
        reasonCode: reason,
        onlyJobIds: [row.id],
      });
    }
  }
}

export async function handleApplyCompletionJob(
  deps: ModuleDeps,
  job: ClaimedJob<ApplyCompletionJobPayload>,
): Promise<JobResult> {
  job.signal.throwIfAborted();
  const completionJobPublicId = job.payload?.completionJobPublicId;
  if (!completionJobPublicId) {
    return { outcome: "failed", reasonCode: "INVALID_PAYLOAD", retryable: false };
  }

  try {
    let outcomeKind = "noop" as "applied" | "superseded" | "noop";
    await deps.db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      const [locked] = await tx
        .select()
        .from(orderCompletionJobs)
        .where(eq(orderCompletionJobs.publicId, completionJobPublicId))
        .for("update");

      if (!locked || locked.state !== "scheduled") {
        outcomeKind = "noop";
        return;
      }

      const now = deps.clock.now();
      const [orderRow] = await tx
        .select({
          id: orders.id,
          lockState: orders.lockState,
        })
        .from(orders)
        .where(eq(orders.id, locked.orderId))
        .for("update");

      const markSuperseded = async (reasonCode: string): Promise<void> => {
        await tx
          .update(orderCompletionJobs)
          .set({
            state: "superseded",
            attemptCount: job.attempt,
            reasonCode,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(orderCompletionJobs.id, locked.id));

        await deps.audit.record(
          {
            category: "business",
            eventName: "order.completion.superseded",
            action: "transition",
            outcome: "completed",
            severity: "INFO",
            reasonCode,
            actor: { role: "system" },
            resource: { type: "order_completion_job", publicId: locked.publicId },
            orderPublicId: locked.orderPublicId,
            correlationId: locked.correlationId,
            attributes: {
              order_public_id: locked.orderPublicId,
              completion_job_public_id: locked.publicId,
              stage_key: locked.stageKey ?? "none",
              resolved_percent: locked.resolvedPercent,
              expected_revision: locked.expectedRevision,
              reason_code: reasonCode,
            },
          },
          tx,
        );
        outcomeKind = "superseded";
      };

      if (!orderRow) {
        await markSuperseded("ORDER_DELETED");
        return;
      }
      if (lockBlocks(orderRow.lockState, true, "order")) {
        await markSuperseded("ORDER_LOCKED");
        return;
      }

      const ctx = await deps.services.orders.stages.contextForRun(locked.orderPublicId, tx);
      const catalogEntries = deps.services.orders.statusCatalog
        ? await deps.services.orders.statusCatalog.listEntries({ includeRetired: true, tx })
        : [];
      const currentEntry = catalogEntries.find((e) => e.key === ctx.statusKey);
      const isCanceled = ctx.statusKey === "canceled" || currentEntry?.category === "canceled";

      if (isCanceled) {
        await markSuperseded("ORDER_CANCELED");
        return;
      }
      if (locked.stageKey !== null && ctx.currentStageKey !== locked.stageKey) {
        await markSuperseded("STAGE_CHANGED");
        return;
      }
      if (ctx.completionRevision !== locked.expectedRevision) {
        await markSuperseded("REVISION_MISMATCH");
        return;
      }

      const applyRes = await deps.services.orders.stages.applyCompletionPercent(
        {
          orderPublicId: locked.orderPublicId,
          percent: locked.resolvedPercent,
          expectedRevision: locked.expectedRevision,
          source: "job",
          sourceRef: locked.publicId,
        },
        tx,
      );

      if (!applyRes.applied) {
        await markSuperseded("REVISION_MISMATCH");
        return;
      }

      await tx
        .update(orderCompletionJobs)
        .set({
          state: "applied",
          appliedRevision: applyRes.revision,
          attemptCount: job.attempt,
          reasonCode: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(orderCompletionJobs.id, locked.id));

      await deps.audit.record(
        {
          category: "business",
          eventName: "order.completion.updated",
          action: "update",
          outcome: "completed",
          severity: "INFO",
          actor: { role: "system" },
          resource: { type: "order", publicId: locked.orderPublicId },
          orderPublicId: locked.orderPublicId,
          correlationId: locked.correlationId,
          attributes: {
            order_public_id: locked.orderPublicId,
            completion_job_public_id: locked.publicId,
            stage_key: locked.stageKey ?? "none",
            source_kind: locked.sourceKind,
            source_public_id: locked.sourcePublicId,
            policy_kind: locked.policyKind,
            resolved_percent: locked.resolvedPercent,
            delay_minutes: locked.delayMinutes,
            expected_revision: locked.expectedRevision,
            applied_revision: applyRes.revision,
          },
        },
        tx,
      );
      outcomeKind = "applied";
    }, { isolationLevel: "read committed" });

    return {
      outcome: "completed",
      safeCounts: {
        applied: outcomeKind === "applied" ? 1 : 0,
        superseded: outcomeKind === "superseded" ? 1 : 0,
      },
    };
  } catch (err) {
    deps.logger.error("Delayed order completion job failed", {
      completionJobPublicId,
      attempt: job.attempt,
      err: err instanceof Error ? err.message : String(err),
    });

    const exhausted = job.attempt >= MAX_COMPLETION_JOB_ATTEMPTS;
    try {
      await deps.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(orderCompletionJobs)
          .where(eq(orderCompletionJobs.publicId, completionJobPublicId))
          .for("update");
        if (!locked || locked.state !== "scheduled") return;
        const now = deps.clock.now();
        if (exhausted) {
          await tx
            .update(orderCompletionJobs)
            .set({
              state: "failed",
              attemptCount: job.attempt,
              reasonCode: "EXECUTION_FAILED",
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(orderCompletionJobs.id, locked.id));

          await deps.audit.record(
            {
              category: "business",
              eventName: "order.completion.failed",
              action: "transition",
              outcome: "failed",
              severity: "ERROR",
              reasonCode: "EXECUTION_FAILED",
              actor: { role: "system" },
              resource: { type: "order_completion_job", publicId: locked.publicId },
              orderPublicId: locked.orderPublicId,
              correlationId: locked.correlationId,
              attributes: {
                order_public_id: locked.orderPublicId,
                completion_job_public_id: locked.publicId,
                stage_key: locked.stageKey ?? "none",
                resolved_percent: locked.resolvedPercent,
                attempt_count: job.attempt,
              },
            },
            tx,
          );

          if (deps.services.opsAlerts?.emit) {
            await deps.services.opsAlerts.emit(
              {
                source: "completion_job",
                severity: "error",
                dedupKey: `completion_job:${locked.publicId}`,
                correlationId: locked.correlationId,
                code: "COMPLETION_JOB_FAILED",
                title: sanitizeOpsAlertCopy(
                  `Delayed completion update failed for order ${locked.orderPublicId}`,
                  120,
                ),
                text: sanitizeOpsAlertCopy(
                  `Scheduled completion update (${locked.resolvedPercent}%) exhausted ${job.attempt} attempts without applying.`,
                  500,
                ),
                orderPublicId: locked.orderPublicId,
                runPublicId: locked.publicId,
              },
              tx,
            );
          }
        } else {
          await tx
            .update(orderCompletionJobs)
            .set({
              attemptCount: job.attempt,
              updatedAt: now,
            })
            .where(eq(orderCompletionJobs.id, locked.id));
        }
      });
    } catch {
      // Best-effort bookkeeping on failure path.
    }

    return {
      outcome: "failed",
      reasonCode: exhausted ? "EXECUTION_FAILED" : "TRANSIENT_FAILURE",
      retryable: !exhausted,
    };
  }
}

export async function listOrderCompletionJobsForOrder(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  input: {
    orderPublicId: string;
    stageKey?: string;
    state?: CompletionJobState;
    cursor?: string;
    limit?: number;
  },
): Promise<{ items: OrderCompletionJobView[]; nextCursor: string | null }> {
  if (principal.role !== "admin" && principal.role !== "staff") {
    await recordAutomationsDenied(deps, principal, "orders.stage.run", "STAFF_OR_ADMIN_REQUIRED");
    throw forbidden("Only administrators and staff can view order completion jobs.");
  }

  const [activeOrderRow] = await deps.db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.publicId, input.orderPublicId))
    .limit(1);

  if (!activeOrderRow) {
    throw notFound("Order not found.");
  }

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  let cursorId: number | null = null;
  if (input.cursor) {
    const [cur] = await deps.db
      .select({ id: orderCompletionJobs.id })
      .from(orderCompletionJobs)
      .where(
        and(
          eq(orderCompletionJobs.publicId, input.cursor),
          eq(orderCompletionJobs.orderId, activeOrderRow.id),
        ),
      )
      .limit(1);
    if (cur) cursorId = cur.id;
  }

  const rows = await deps.db
    .select()
    .from(orderCompletionJobs)
    .where(
      and(
        eq(orderCompletionJobs.orderId, activeOrderRow.id),
        ...(input.stageKey ? [eq(orderCompletionJobs.stageKey, input.stageKey)] : []),
        ...(input.state ? [eq(orderCompletionJobs.state, input.state)] : []),
        ...(cursorId !== null ? [lt(orderCompletionJobs.id, cursorId)] : []),
      ),
    )
    .orderBy(desc(orderCompletionJobs.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const views = await hydrateCompletionJobViews(deps.db, deps.crypto, page);
  return {
    items: views,
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.publicId : null,
  };
}

export async function cancelOrderCompletionJobByAdmin(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  input: { completionJobPublicId: string; reason?: string | null },
): Promise<OrderCompletionJobView> {
  await assertAutomationsCapabilityPreflight(deps, principal, "orders.stage.run");
  if (principal.role !== "admin") {
    await recordAutomationsDenied(deps, principal, "orders.stage.run", "ADMIN_ROLE_REQUIRED");
    throw forbidden("Only administrators can cancel scheduled completion updates.");
  }

  return deps.db.transaction(async (tx) => {
    const lockedActors = await assertAutomationsActorInTx(
      deps,
      principal,
      tx,
      "orders.stage.run",
    );
    const liveActor = lockedActors.get(principal.userId);
    if (!liveActor || liveActor.role !== "admin") {
      throw forbidden("Only administrators can cancel scheduled completion updates.");
    }

    const [locked] = await tx
      .select()
      .from(orderCompletionJobs)
      .where(eq(orderCompletionJobs.publicId, input.completionJobPublicId))
      .for("update");

    if (!locked) {
      throw notFound("Scheduled completion update not found.");
    }
    if (locked.state === "canceled") {
      const [alreadyView] = await hydrateCompletionJobViews(tx, deps.crypto, [locked]);
      return alreadyView!;
    }
    if (locked.state !== "scheduled") {
      throw conflict(
        "COMPLETION_JOB_NOT_SCHEDULED",
        `Completion update is already ${locked.state} and cannot be canceled.`,
      );
    }

    const now = deps.clock.now();
    const reasonCode = "ADMIN_CANCELED";
    await tx
      .update(orderCompletionJobs)
      .set({
        state: "canceled",
        reasonCode,
        canceledByUserId: principal.userId,
        canceledAt: now,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(orderCompletionJobs.id, locked.id));

    await deps.audit.record(
      {
        category: "business",
        eventName: "order.completion.canceled",
        action: "transition",
        outcome: "completed",
        severity: "INFO",
        reasonCode,
        actor: {
          userId: principal.userId,
          role: principal.role,
        },
        resource: { type: "order_completion_job", publicId: locked.publicId },
        orderPublicId: locked.orderPublicId,
        attributes: {
          order_public_id: locked.orderPublicId,
          completion_job_public_id: locked.publicId,
          stage_key: locked.stageKey ?? "none",
          resolved_percent: locked.resolvedPercent,
          expected_revision: locked.expectedRevision,
          ...(input.reason?.trim() ? { cancel_reason_length: input.reason.trim().length } : {}),
        },
      },
      tx,
    );

    const [updated] = await tx
      .select()
      .from(orderCompletionJobs)
      .where(eq(orderCompletionJobs.id, locked.id))
      .limit(1);
    const [view] = await hydrateCompletionJobViews(tx, deps.crypto, [updated!]);
    return view!;
  }, { isolationLevel: "read committed" });
}
