import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, DbOrTx, JobResult, Logger, Tx } from "../../core/types.js";
import { workflowDefinitionSchema } from "./workflowTypes.js";
import { orderWorkflowVersions, orderWorkflows, orders } from "./schema.js";
import { STANDARD_V3_DEFINITION, STANDARD_V3_WORKFLOW_KEY, STANDARD_V3_WORKFLOW_NAME } from "./stageModel.js";

/**
 * Increment 07 (D1) idempotent start-up work, run by the `orders.increment07.startup` schedule:
 * - a fresh install (no workflow and no order) gets the format-3 ReadyPackets standard workflow as its default;
 * - upgraded installs get nothing automatically: /admin/workflows offers "add" / "convert" (workflows.phases.*);
 * - paid backfill of existing orders' payment state (see backfillPaid). Nothing is published; no order is re-pinned;
 * - progress refresh: orders on format-3 versions get progress_percent recalculated under the current D3 rule.
 */
export const STAGE_STARTUP_JOB = "orders.increment07.startup";

export interface StageStartupDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  logger: Logger;
  /** Compliance's paid-invoice summary (registered at init); absent = no backfill. */
  paymentSummary?: () => ((orderPublicIds: string[], tx: DbOrTx) => Promise<Map<string, { state: string }>>) | null;
  /** Stage runtime's stored-progress recalculation (absent = skipped). */
  recalcStoredProgress?: (orderIds: number[]) => Promise<number>;
}

const BACKFILL_BATCH = 200;

export type StageStartupOutcome = "installed_standard" | "nothing_to_do";

export function createStageStartup(deps: StageStartupDeps) {
  /** Process-local cursor: each start walks the old orders once, in batches. */
  let backfillAfter = 0;
  let backfillDone = false;
  let progressAfter = 0;
  let progressDone = false;

  /** One batch per call (the job runs up to 25 per run); walks orders whose pinned version has phases (format 3). Versions are never re-pinned. */
  async function refreshProgress(): Promise<number> {
    if (!deps.recalcStoredProgress || progressDone) return 0;
    const versions = await deps.db.select({ id: orderWorkflowVersions.id, definition: orderWorkflowVersions.definition }).from(orderWorkflowVersions);
    const format3 = versions.filter((version) => {
      const stages = (version.definition as { stages?: unknown } | null)?.stages;
      return Array.isArray(stages) && stages.length > 0;
    }).map((version) => version.id);
    if (format3.length === 0) {
      progressDone = true;
      return 0;
    }
    const rows = await deps.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(gt(orders.id, progressAfter), inArray(orders.workflowVersionId, format3)))
      .orderBy(asc(orders.id))
      .limit(BACKFILL_BATCH);
    if (rows.length < BACKFILL_BATCH) progressDone = true;
    if (rows.length === 0) return 0;
    progressAfter = rows[rows.length - 1]!.id;
    return deps.recalcStoredProgress(rows.map((row) => row.id));
  }

  /**
   * D9 backfill: existing orders keep `not_required` unless the invoice summary says they are paid; then only the
   * payment state is recorded (no status move, no phase completion: nothing fires retroactively).
   */
  async function backfillPaid(): Promise<number> {
    const provider = deps.paymentSummary?.();
    if (!provider || backfillDone) return 0;
    return deps.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: orders.id, publicId: orders.publicId })
        .from(orders)
        .where(and(gt(orders.id, backfillAfter), eq(orders.paymentState, "not_required"), gt(orders.totalMinor, 0), isNull(orders.paidAt)))
        .orderBy(asc(orders.id))
        .limit(BACKFILL_BATCH)
        .for("update");
      if (rows.length < BACKFILL_BATCH) backfillDone = true;
      if (rows.length === 0) return 0;
      backfillAfter = rows[rows.length - 1]!.id;
      const summary = await provider(rows.map((row) => row.publicId), tx);
      let changed = 0;
      const now = deps.clock.now();
      for (const row of rows) {
        if (summary.get(row.publicId)?.state !== "paid") continue;
        await tx.update(orders).set({ paymentState: "paid", paidAt: now }).where(eq(orders.id, row.id));
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.payment_state.changed",
            action: "update",
            outcome: "completed",
            actor: { role: "system" },
            resource: { type: "order", publicId: row.publicId },
            reasonCode: "PAYMENT_BACKFILL",
            attributes: { from_state: "not_required", to_state: "paid", ref: "backfill" },
          },
          tx,
        );
        changed += 1;
      }
      return changed;
    });
  }

  async function installStandardV3(tx: Tx) {
    const now = deps.clock.now();
    const definition = workflowDefinitionSchema.parse(STANDARD_V3_DEFINITION);
    const publicId = ulid(now.getTime());
    await tx.insert(orderWorkflows).values({ publicId, workflowKey: STANDARD_V3_WORKFLOW_KEY, name: STANDARD_V3_WORKFLOW_NAME, isDefault: true });
    const [workflow] = await tx.select({ id: orderWorkflows.id }).from(orderWorkflows).where(eq(orderWorkflows.publicId, publicId));
    const versionPublicId = ulid(now.getTime());
    await tx.insert(orderWorkflowVersions).values({ publicId: versionPublicId, workflowId: workflow!.id, versionNumber: 1, definition, createdByUserId: null, createdAt: now });
    const [version] = await tx.select({ id: orderWorkflowVersions.id }).from(orderWorkflowVersions).where(eq(orderWorkflowVersions.publicId, versionPublicId));
    await tx.update(orderWorkflows).set({ currentVersionId: version!.id }).where(eq(orderWorkflows.id, workflow!.id));
    await deps.audit.record(
      {
        category: "system",
        eventName: "workflow.changed",
        action: "create",
        outcome: "completed",
        actor: { role: "system" },
        resource: { type: "order_workflow", publicId },
        reasonCode: "STANDARD_V3_INSTALLED",
        safeCounts: { states: definition.states.length, transitions: definition.transitions.length, stages: definition.stages?.length ?? 0 },
      },
      tx,
    );
  }

  return {
    backfillPaid,
    refreshProgress,
    async run(): Promise<StageStartupOutcome> {
      return deps.db.transaction(async (tx) => {
        const [workflowCount] = await tx.select({ n: sql<number>`count(*)` }).from(orderWorkflows);
        const [orderCount] = await tx.select({ n: sql<number>`count(*)` }).from(orders);
        if (Number(workflowCount?.n ?? 0) === 0 && Number(orderCount?.n ?? 0) === 0) {
          await installStandardV3(tx);
          return "installed_standard";
        }
        // Increment 07 QA: upgraded installs are no longer given a silent draft; /admin/workflows shows a phases
        // notice with explicit "add" and "convert" actions (workflows.phases.*) instead.
        return "nothing_to_do";
      });
    },
    async job(): Promise<JobResult> {
      try {
        const outcome = await this.run();
        const paid = await backfillPaid();
        let progress = 0;
        for (let batch = 0; batch < 25 && !progressDone; batch += 1) progress += await refreshProgress();
        return { outcome: "completed", safeCounts: { installed: outcome === "installed_standard" ? 1 : 0, paid, progress } };
      } catch (err) {
        deps.logger.warn("orders increment 07 start-up work deferred", { errorName: err instanceof Error ? err.name : "unknown" });
        throw err;
      }
    },
  };
}
