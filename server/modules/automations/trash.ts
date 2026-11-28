/**
 * Automations trash participant (Increment 09, D2.2 / D2.5 / D2.6 / D2.8). Owner: siem_engineer.
 *
 * Contract invariants:
 * - On move to trash (`onTrashedInTx`), queued automation runs and scheduled completion jobs for
 *   the order or customer are cancelled inside the trash transaction so no queued side effects fire.
 * - On permanent deletion (`purge`), every data-modifying transaction calls `await run.assertCurrentInTx(tx)`
 *   as its first statement (D2.8 fence), erases run payload copies (`automation_runs.evaluated_fields_json`,
 *   `automation_runs.context_snapshot_enc`) and step summaries/references (`automation_run_steps`)
 *   for purged orders and customers, and deletes order-scoped `order_stage_runs` and
 *   `order_completion_jobs` rows.
 */
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import type { Tx } from "../../core/types.js";
import type {
  TrashEntityRef,
  TrashParticipant,
  TrashPurgeResult,
  TrashPurgeRun,
} from "../trash/ports.js";
import {
  automationRunSteps,
  automationRuns,
  orderCompletionJobs,
  orderStageRuns,
} from "./schema.js";

function affectedCount(res: unknown): number {
  const header = Array.isArray(res) ? res[0] : res;
  if (header && typeof header === "object" && "affectedRows" in header) {
    return Number((header as { affectedRows?: number }).affectedRows ?? 0);
  }
  return 0;
}

export function createAutomationsTrashParticipant(deps: ModuleDeps): TrashParticipant {
  return {
    module: "automations",

    async onTrashedInTx(tx: Tx, entity: TrashEntityRef): Promise<void> {
      const now = deps.clock.now();
      if (entity.kind === "order") {
        const queuedRows = await tx
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.orderPublicId, entity.publicId),
              eq(automationRuns.state, "queued"),
            ),
          )
          .for("update");
        const queuedIds = queuedRows.map((r) => r.id);
        if (queuedIds.length > 0) {
          await tx
            .update(automationRunSteps)
            .set({
              state: "skipped",
              reasonCode: "ORDER_TRASHED",
              updatedAt: now,
            })
            .where(
              and(
                inArray(automationRunSteps.runId, queuedIds),
                eq(automationRunSteps.state, "pending"),
              ),
            );
          await tx
            .update(automationRuns)
            .set({
              state: "canceled",
              reasonCode: "ORDER_TRASHED",
              finishedAt: now,
              updatedAt: now,
            })
            .where(inArray(automationRuns.id, queuedIds));
        }

        await tx
          .update(orderCompletionJobs)
          .set({
            state: "canceled",
            reasonCode: "ORDER_TRASHED",
            canceledAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(orderCompletionJobs.orderId, entity.id),
              eq(orderCompletionJobs.state, "scheduled"),
            ),
          );
        return;
      }

      const queuedCustomerRows = await tx
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.subjectUserId, entity.id),
            eq(automationRuns.state, "queued"),
          ),
        )
        .for("update");
      const queuedIds = queuedCustomerRows.map((r) => r.id);
      if (queuedIds.length > 0) {
        await tx
          .update(automationRunSteps)
          .set({
            state: "skipped",
            reasonCode: "CUSTOMER_TRASHED",
            updatedAt: now,
          })
          .where(
            and(
              inArray(automationRunSteps.runId, queuedIds),
              eq(automationRunSteps.state, "pending"),
            ),
          );
        await tx
          .update(automationRuns)
          .set({
            state: "canceled",
            reasonCode: "CUSTOMER_TRASHED",
            finishedAt: now,
            updatedAt: now,
          })
          .where(inArray(automationRuns.id, queuedIds));
      }
    },

    async summarize(entity: TrashEntityRef): Promise<Record<string, number>> {
      const counts: Record<string, number> = {};
      if (entity.kind === "order") {
        const [[runRow], [stageRow], [compRow]] = await Promise.all([
          deps.db
            .select({ count: sql<number>`count(*)` })
            .from(automationRuns)
            .where(
              and(
                eq(automationRuns.orderPublicId, entity.publicId),
                or(
                  isNotNull(automationRuns.contextSnapshotEnc),
                  ne(automationRuns.evaluatedFieldsJson, "{}"),
                ),
              ),
            ),
          deps.db
            .select({ count: sql<number>`count(*)` })
            .from(orderStageRuns)
            .where(eq(orderStageRuns.orderId, entity.id)),
          deps.db
            .select({ count: sql<number>`count(*)` })
            .from(orderCompletionJobs)
            .where(eq(orderCompletionJobs.orderId, entity.id)),
        ]);
        const runs = Number(runRow?.count ?? 0);
        const stages = Number(stageRow?.count ?? 0);
        const comps = Number(compRow?.count ?? 0);
        if (runs > 0) counts.automationRuns = runs;
        if (stages > 0) counts.stageRuns = stages;
        if (comps > 0) counts.completionJobs = comps;
        return counts;
      }

      const [runRow] = await deps.db
        .select({ count: sql<number>`count(*)` })
        .from(automationRuns)
        .where(
          and(
            or(
              eq(automationRuns.subjectUserId, entity.id),
              eq(automationRuns.triggeredByUserId, entity.id),
            ),
            or(
              isNotNull(automationRuns.contextSnapshotEnc),
              ne(automationRuns.evaluatedFieldsJson, "{}"),
            ),
          ),
        );
      const runs = Number(runRow?.count ?? 0);
      if (runs > 0) counts.automationRuns = runs;
      return counts;
    },

    async purge(entity: TrashEntityRef, run: TrashPurgeRun): Promise<TrashPurgeResult> {
      return deps.db.transaction(async (tx) => {
        await run.assertCurrentInTx(tx);
        const deleted: Record<string, number> = {};
        const now = deps.clock.now();

        const targetRuns =
          entity.kind === "order"
            ? await tx
                .select({ id: automationRuns.id })
                .from(automationRuns)
                .where(eq(automationRuns.orderPublicId, entity.publicId))
                .for("update")
            : await tx
                .select({ id: automationRuns.id })
                .from(automationRuns)
                .where(
                  or(
                    eq(automationRuns.subjectUserId, entity.id),
                    eq(automationRuns.triggeredByUserId, entity.id),
                  ),
                )
                .for("update");

        const runIds = targetRuns.map((r) => r.id);
        if (runIds.length > 0) {
          await tx
            .update(automationRunSteps)
            .set({
              safeSummary: null,
              safeCountsJson: null,
              externalRef: null,
              updatedAt: now,
            })
            .where(
              and(
                inArray(automationRunSteps.runId, runIds),
                or(
                  isNotNull(automationRunSteps.safeSummary),
                  isNotNull(automationRunSteps.safeCountsJson),
                  isNotNull(automationRunSteps.externalRef),
                ),
              ),
            );

          const cancelReason = entity.kind === "order" ? "ORDER_PURGED" : "CUSTOMER_PURGED";
          const cancelRes = await tx
            .update(automationRuns)
            .set({
              state: "canceled",
              reasonCode: cancelReason,
              evaluatedFieldsJson: "{}",
              contextSnapshotEnc: null,
              finishedAt: now,
              updatedAt: now,
            })
            .where(and(inArray(automationRuns.id, runIds), eq(automationRuns.state, "queued")));

          const eraseRes = await tx
            .update(automationRuns)
            .set({
              evaluatedFieldsJson: "{}",
              contextSnapshotEnc: null,
              updatedAt: now,
            })
            .where(
              and(
                inArray(automationRuns.id, runIds),
                or(
                  isNotNull(automationRuns.contextSnapshotEnc),
                  ne(automationRuns.evaluatedFieldsJson, "{}"),
                ),
              ),
            );
          const erasedPayloads = affectedCount(cancelRes) + affectedCount(eraseRes);
          if (erasedPayloads > 0) {
            deleted.automationRunPayloads = erasedPayloads;
          }
        }

        if (entity.kind === "order") {
          const stageDelRes = await tx
            .delete(orderStageRuns)
            .where(eq(orderStageRuns.orderId, entity.id));
          const stageDeleted = affectedCount(stageDelRes);
          if (stageDeleted > 0) deleted.stageRuns = stageDeleted;

          const compDelRes = await tx
            .delete(orderCompletionJobs)
            .where(eq(orderCompletionJobs.orderId, entity.id));
          const compDeleted = affectedCount(compDelRes);
          if (compDeleted > 0) deleted.completionJobs = compDeleted;
        }

        return { deleted };
      });
    },
  };
}
