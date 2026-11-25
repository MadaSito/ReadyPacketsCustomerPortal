import { asc, eq, sql } from "drizzle-orm";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, JobResult, Logger, Tx } from "../../core/types.js";
import { deriveStages } from "../../../shared/workflowStages.js";
import { workflowDefinitionSchema } from "./workflowTypes.js";
import { orderWorkflowDrafts, orderWorkflowVersions, orderWorkflows, orders } from "./schema.js";
import { STANDARD_V3_DEFINITION, STANDARD_V3_WORKFLOW_KEY, STANDARD_V3_WORKFLOW_NAME } from "./stageModel.js";
import { toDraft } from "./workflowDesign.js";

/**
 * Increment 07 (D1) idempotent start-up work, run by the `orders.increment07.startup` schedule:
 * - a fresh install (no workflow and no order) gets the format-3 ReadyPackets standard workflow as its default;
 * - otherwise, when no workflow uses phases yet, the default workflow gets ONE format-3 draft (its statuses grouped
 *   into derived phases) for an administrator to review and publish. Nothing is published and no order is re-pinned.
 */
export const STAGE_STARTUP_JOB = "orders.increment07.startup";

export interface StageStartupDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  logger: Logger;
}

export type StageStartupOutcome = "installed_standard" | "upgrade_draft_created" | "nothing_to_do";

export function createStageStartup(deps: StageStartupDeps) {
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

  async function createUpgradeDraft(tx: Tx): Promise<boolean> {
    const [workflow] = await tx.select().from(orderWorkflows).where(eq(orderWorkflows.isDefault, true)).orderBy(asc(orderWorkflows.id)).limit(1).for("update");
    if (!workflow?.currentVersionId) return false;
    const [open] = await tx.select({ id: orderWorkflowDrafts.id }).from(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.workflowId, workflow.id)).limit(1);
    if (open) return false;
    const [version] = await tx.select().from(orderWorkflowVersions).where(eq(orderWorkflowVersions.id, workflow.currentVersionId)).limit(1);
    if (!version) return false;
    const current = workflowDefinitionSchema.parse(version.definition);
    if (current.stages?.length) return false;
    const draft = toDraft({ ...current, stages: deriveStages(current) });
    const now = deps.clock.now();
    const publicId = ulid(now.getTime());
    await tx.insert(orderWorkflowDrafts).values({
      publicId,
      workflowId: workflow.id,
      workflowKey: workflow.workflowKey,
      name: workflow.name,
      source: "copy",
      baseVersionId: workflow.currentVersionId,
      definition: draft,
      layout: null,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: now,
      updatedAt: now,
    });
    await deps.audit.record(
      {
        category: "system",
        eventName: "workflow.draft.changed",
        action: "create",
        outcome: "completed",
        actor: { role: "system" },
        resource: { type: "order_workflow_draft", publicId },
        reasonCode: "PHASES_UPGRADE_DRAFT",
        attributes: { source: "copy", existing_workflow: true },
        safeCounts: { states: draft.states.length, transitions: draft.transitions.length, stages: draft.stages?.length ?? 0 },
      },
      tx,
    );
    return true;
  }

  return {
    async run(): Promise<StageStartupOutcome> {
      return deps.db.transaction(async (tx) => {
        const [workflowCount] = await tx.select({ n: sql<number>`count(*)` }).from(orderWorkflows);
        const [orderCount] = await tx.select({ n: sql<number>`count(*)` }).from(orders);
        if (Number(workflowCount?.n ?? 0) === 0 && Number(orderCount?.n ?? 0) === 0) {
          await installStandardV3(tx);
          return "installed_standard";
        }
        const versions = await tx
          .select({ definition: orderWorkflowVersions.definition })
          .from(orderWorkflows)
          .innerJoin(orderWorkflowVersions, eq(orderWorkflowVersions.id, orderWorkflows.currentVersionId));
        const drafts = await tx.select({ definition: orderWorkflowDrafts.definition }).from(orderWorkflowDrafts);
        const hasStages = [...versions, ...drafts].some((row) => {
          const stages = (row.definition as { stages?: unknown } | null)?.stages;
          return Array.isArray(stages) && stages.length > 0;
        });
        if (hasStages) return "nothing_to_do";
        return (await createUpgradeDraft(tx)) ? "upgrade_draft_created" : "nothing_to_do";
      });
    },
    async job(): Promise<JobResult> {
      try {
        const outcome = await this.run();
        return { outcome: "completed", safeCounts: { installed: outcome === "installed_standard" ? 1 : 0, drafts: outcome === "upgrade_draft_created" ? 1 : 0 } };
      } catch (err) {
        deps.logger.warn("orders increment 07 start-up work deferred", { errorName: err instanceof Error ? err.name : "unknown" });
        throw err;
      }
    },
  };
}
