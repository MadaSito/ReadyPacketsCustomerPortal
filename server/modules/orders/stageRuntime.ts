/**
 * Increment 07 (D1/D2/D3): per-order stage runtime, progress and attention. Everything here runs INSIDE the
 * caller's transaction with the order row already locked (`FOR UPDATE`); nothing opens its own transaction except
 * `fillForRead` (old orders are filled on first read).
 *
 * - `order_stage_progress` rows: opened when a format-3 stage is first reached; marked `accepted` when the order
 *   moves past the stage by a status change, Next, review or payment.
 * - `orders.progress_percent`: shown = max(derived, explicit completion); never lowered except by an audited
 *   administrator reopen (`allowLower`). A canceled order is frozen.
 * - `orders.attention` / `attention_since`: stage state first, then the status catalogue (D2). `attention_since`
 *   changes only when the value changes.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { computeProgress, type WorkflowStage } from "../../../shared/workflowStages.js";
import { fallbackStatusCatalogLookup, type StatusCatalogLookup } from "../../../shared/orderStatusCatalog.js";
import type { Services } from "../../container.js";
import type { Clock, Db, DbOrTx, Tx } from "../../core/types.js";
import { hasUnansweredStageQuestions } from "./questions.js";
import { orders, orderStageProgress, type OrderAttention } from "./schema.js";
import { stageHasCustomerWork, stageIndexOfStatus, stageModelOf, type StageModel } from "./stageModel.js";
import type { BoundWorkflow, WorkflowService } from "./workflows.js";
import { findState } from "./workflowTypes.js";

export interface StageRuntimeDeps {
  db: Db;
  clock: Clock;
  services: Services;
  workflows: Pick<WorkflowService, "byVersionId">;
}

export type StageProgressRow = typeof orderStageProgress.$inferSelect;

export interface RecalcResult {
  progressPercent: number;
  previousPercent: number | null;
  canceled: boolean;
  attention: OrderAttention;
}

type StatusLookupPort = { getManyInTx?: (keys: readonly string[], tx?: DbOrTx) => Promise<Map<string, StatusCatalogLookup>> };

export function isCanceledStatus(statusKey: string, lookup: Pick<StatusCatalogLookup, "category"> | undefined): boolean {
  return statusKey.includes("cancel") || lookup?.category === "canceled";
}

/**
 * Completed stages for D3: every stage before the current one (the order moved past it), plus accepted rows up to
 * and including the current stage. After an administrator reopens an earlier phase, phases after it that were
 * accepted before no longer count, matching the stepper (stateAt). With no current stage (final or unmapped
 * status), every accepted row counts.
 */
export function completedStageKeys(model: StageModel, rows: readonly Pick<StageProgressRow, "stageKey" | "state">[], statusKey: string): Set<string> {
  const current = stageIndexOfStatus(model, statusKey);
  const indexOf = new Map(model.stages.map((stage, index) => [stage.key, index]));
  const done = new Set(
    rows.filter((row) => row.state === "accepted" && (current < 0 || (indexOf.get(row.stageKey) ?? Infinity) <= current)).map((row) => row.stageKey),
  );
  if (current > 0) for (const stage of model.stages.slice(0, current)) done.add(stage.key);
  return done;
}

export function createStageRuntime(deps: StageRuntimeDeps) {
  /** D2 catalogue (recovery_ops' port on services.orders.statusCatalog), else the deterministic fallback. */
  async function statusLookup(db: DbOrTx, bound: BoundWorkflow, statusKey: string): Promise<StatusCatalogLookup> {
    const port = (deps.services as unknown as { orders?: { statusCatalog?: StatusLookupPort } }).orders?.statusCatalog;
    if (port && typeof port.getManyInTx === "function") {
      const found = (await port.getManyInTx([statusKey], db)).get(statusKey);
      if (found) return found;
    }
    const state = findState(bound.definition, statusKey);
    return fallbackStatusCatalogLookup(statusKey, state ? { staffLabel: state.label, customerLabel: state.customerLabel, kind: state.kind } : undefined);
  }

  async function progressRows(db: DbOrTx, orderId: number, workflowVersionId: number, forUpdate = false): Promise<StageProgressRow[]> {
    const query = db
      .select()
      .from(orderStageProgress)
      .where(and(eq(orderStageProgress.orderId, orderId), eq(orderStageProgress.workflowVersionId, workflowVersionId)));
    return forUpdate ? (query as unknown as { for(mode: "update"): Promise<StageProgressRow[]> }).for("update") : query;
  }

  async function openStage(tx: Tx, orderId: number, workflowVersionId: number, stage: WorkflowStage, rows: StageProgressRow[]): Promise<void> {
    if (rows.some((row) => row.stageKey === stage.key)) return;
    const now = deps.clock.now();
    await tx.insert(orderStageProgress).values({ orderId, workflowVersionId, stageKey: stage.key, state: "open", openedAt: now, createdAt: now, updatedAt: now });
  }

  async function markAccepted(tx: Tx, row: StageProgressRow, how: "next" | "submit" | "review" | "payment" | "status"): Promise<void> {
    if (row.state === "accepted") return;
    const now = deps.clock.now();
    await tx
      .update(orderStageProgress)
      .set({ state: "accepted", completedAt: now, completedHow: how, version: row.version + 1, updatedAt: now })
      .where(eq(orderStageProgress.id, row.id));
  }

  const completedKeys = completedStageKeys;

  async function attentionOf(db: DbOrTx, input: { orderId: number; workflowVersionId: number; statusKey: string; model: StageModel; rows: StageProgressRow[]; lookup: StatusCatalogLookup }): Promise<OrderAttention> {
    if (isCanceledStatus(input.statusKey, input.lookup)) return "none";
    const index = stageIndexOfStatus(input.model, input.statusKey);
    const stage = index >= 0 ? input.model.stages[index]! : null;
    if (stage && !input.model.derived) {
      const row = input.rows.find((candidate) => candidate.stageKey === stage.key);
      if (row && (row.state === "submitted" || row.state === "in_review")) return "staff_review";
      // The customer finished the phase but the status could not move on by itself: staff take it from here.
      if (row?.state === "accepted" && stageHasCustomerWork(stage)) return "staff_review";
      if (stage.actions.answerQuestions && (!row || row.state === "open" || row.state === "reopened")) {
        if (await hasUnansweredStageQuestions(input.orderId, input.workflowVersionId, stage.key, db, true)) return "customer_response";
      }
    }
    const fromCatalogue = input.lookup.attention;
    return fromCatalogue === "staff_review" || fromCatalogue === "customer_response" ? fromCatalogue : "none";
  }

  /**
   * Recalculates progress and attention for one order and stores them (caller holds the order row lock).
   * `allowLower` only for an audited administrator reopen.
   */
  async function recalcInTx(tx: Tx, orderId: number, options: { allowLower?: boolean } = {}): Promise<RecalcResult> {
    const [order] = await tx
      .select({
        statusKey: orders.statusKey,
        workflowVersionId: orders.workflowVersionId,
        progressPercent: orders.progressPercent,
        completionPercent: orders.completionPercent,
        attention: orders.attention,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) throw new Error("order vanished inside its own transaction");
    const bound = await deps.workflows.byVersionId(tx, order.workflowVersionId);
    const model = stageModelOf(bound.definition);
    const rows = await progressRows(tx, orderId, order.workflowVersionId);
    const lookup = await statusLookup(tx, bound, order.statusKey);
    const canceled = isCanceledStatus(order.statusKey, lookup);
    const computed = computeProgress({
      stages: model.stages,
      completedStageKeys: completedKeys(model, rows, order.statusKey),
      statusCategory: lookup.category,
      explicitPercent: order.completionPercent,
    }).shown;
    const previous = order.progressPercent;
    let percent: number;
    if (canceled) percent = previous ?? computed; // frozen
    else if (options.allowLower || previous === null) percent = computed;
    else percent = Math.max(previous, computed);
    const attention = await attentionOf(tx, { orderId, workflowVersionId: order.workflowVersionId, statusKey: order.statusKey, model, rows, lookup });
    const patch: Partial<typeof orders.$inferInsert> = {};
    if (percent !== previous) patch.progressPercent = percent;
    if (attention !== order.attention) {
      patch.attention = attention;
      patch.attentionSince = attention === "none" ? null : deps.clock.now();
    }
    if (Object.keys(patch).length) await tx.update(orders).set(patch).where(eq(orders.id, orderId));
    return { progressPercent: percent, previousPercent: previous, canceled, attention };
  }

  return {
    statusLookup,
    progressRows,
    openStage,
    markAccepted,
    recalcInTx,

    /** Same tx as every status write (transition, system transition, create, stage moves, overrides, payment). */
    async afterStatusChangeInTx(tx: Tx, input: { orderId: number; bound: BoundWorkflow; fromStatus: string | null; toStatus: string }): Promise<RecalcResult> {
      const model = stageModelOf(input.bound.definition);
      if (!model.derived) {
        const rows = await progressRows(tx, input.orderId, input.bound.versionId, true);
        const toIndex = stageIndexOfStatus(model, input.toStatus);
        const fromIndex = input.fromStatus === null ? -1 : stageIndexOfStatus(model, input.fromStatus);
        if (fromIndex >= 0 && toIndex > fromIndex) {
          for (const stage of model.stages.slice(fromIndex, toIndex)) {
            const row = rows.find((candidate) => candidate.stageKey === stage.key);
            if (row) await markAccepted(tx, row, "status");
          }
        }
        if (toIndex >= 0) await openStage(tx, input.orderId, input.bound.versionId, model.stages[toIndex]!, rows);
      }
      return recalcInTx(tx, input.orderId);
    },

    /** Port for assurance (D4): after a question is asked, answered or withdrawn. Caller holds the order lock. */
    async refreshAttentionInTx(orderId: number, tx: Tx): Promise<void> {
      await recalcInTx(tx, orderId);
    },

    /** Old orders (progress_percent null) are filled on first read; failures leave the cache empty (shown as 0). */
    async fillForRead(orderIds: number[]): Promise<Map<number, number>> {
      const filled = new Map<number, number>();
      for (const orderId of orderIds.slice(0, 100)) {
        try {
          await deps.db.transaction(async (tx) => {
            const [row] = await tx
              .select({ id: orders.id })
              .from(orders)
              .where(and(eq(orders.id, orderId), isNull(orders.progressPercent)))
              .limit(1)
              .for("update");
            if (!row) return;
            const result = await recalcInTx(tx, orderId);
            filled.set(orderId, result.progressPercent);
          });
        } catch {
          // read path: never fail a list because a cache could not be filled
        }
      }
      return filled;
    },

    /**
     * Lead ruling (QA on e8fe1ec): the progress rule changed (every phase counts), so stored values computed under the
     * old rule are recalculated once per start for orders on format-3 versions. `allowLower` drops a stale 50 or
     * 100; a canceled order stays frozen (recalcInTx). Each order runs in its own short transaction with its row lock.
     */
    async recalcStored(orderIds: number[]): Promise<number> {
      let changed = 0;
      for (const orderId of orderIds) {
        try {
          await deps.db.transaction(async (tx) => {
            const [row] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).limit(1).for("update");
            if (!row) return;
            const result = await recalcInTx(tx, orderId, { allowLower: true });
            if (result.progressPercent !== result.previousPercent) changed += 1;
          });
        } catch {
          // start-up maintenance: one order failing must not stop the rest (the next start tries again)
        }
      }
      return changed;
    },

    /** Batch read of current-stage rows for list projections (no locks). */
    async rowsForOrders(db: DbOrTx, orderIds: number[]): Promise<StageProgressRow[]> {
      if (!orderIds.length) return [];
      return db.select().from(orderStageProgress).where(inArray(orderStageProgress.orderId, orderIds));
    },
  };
}

export type StageRuntime = ReturnType<typeof createStageRuntime>;
