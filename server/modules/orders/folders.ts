/**
 * Part B (B7) — storage folder routing for order files (consumer: portable_ops_engineer's copy worker).
 * Trusted read from the order's PINNED workflow version; the caller validates and resolves the template with
 * shared/orderFileFolder.ts at copy time and applies the precedence slot → workflow → assignment default.
 */
import { eq } from "drizzle-orm";
import type { Tx } from "../../core/types.js";
import { orders } from "./schema.js";
import type { WorkflowService } from "./workflows.js";
import { findState } from "./workflowTypes.js";

export interface OrderFileFolderRouting {
  slotTemplate: string | null;
  workflowTemplate: string | null;
  phaseLabel: string | null;
}

export function createFolderRouting(deps: { workflows: WorkflowService }) {
  return async function getOrderFileFolderRouting(
    input: { orderPublicId: string; statusKey: string; slotKey: string | null },
    tx: Tx,
  ): Promise<OrderFileFolderRouting | null> {
    const [row] = await tx.select({ workflowVersionId: orders.workflowVersionId }).from(orders).where(eq(orders.publicId, input.orderPublicId)).limit(1);
    if (!row) return null;
    const { definition } = await deps.workflows.byVersionId(tx, row.workflowVersionId);
    const state = findState(definition, input.statusKey);
    const slot = input.slotKey ? state?.requirements?.uploads.find((candidate) => candidate.key === input.slotKey) : undefined;
    const phase = state?.phase ? definition.phases?.find((candidate) => candidate.key === state.phase) : undefined;
    return {
      slotTemplate: slot?.storageFolder ?? null,
      workflowTemplate: definition.storageFolder ?? null,
      phaseLabel: phase?.label ?? null,
    };
  };
}
