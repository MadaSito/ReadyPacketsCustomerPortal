import { validation } from "../../core/errors.js";
import type { Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import type { WorkflowStage } from "../../../shared/workflowStages.js";

type WebhookValidator = {
  validateTargetKey?: (targetKey: string | null | undefined, tx?: Tx) => Promise<{ valid: boolean; reasonCode?: string | null; message?: string | null }>;
};
type FileSyncValidator = { validateStageFileSyncTargets?: (stages: readonly WorkflowStage[], tx: Tx) => Promise<void> };

/**
 * Increment 07 (D6/D7): phase webhook targets (integrations) and file-sync targets (storage) are checked at draft
 * save and publish. A phase that names a webhook target while the integrations port is absent is refused (fail closed).
 */
export async function checkStageTargets(services: Services, stages: readonly WorkflowStage[], tx: Tx): Promise<void> {
  const optional = services as unknown as {
    integrations?: { workflowWebhooks?: WebhookValidator };
    storageConnections?: FileSyncValidator;
  };
  const webhooks = optional.integrations?.workflowWebhooks;
  for (const [index, stage] of stages.entries()) {
    const targetKey = stage.stageActions?.webhookTargetKey;
    if (!targetKey) continue;
    if (!webhooks?.validateTargetKey)
      throw validation("STAGE_WEBHOOK_TARGET_UNAVAILABLE", "Webhook targets cannot be checked right now.", { path: `stages.${index}.stageActions.webhookTargetKey` });
    const result = await webhooks.validateTargetKey(targetKey, tx);
    if (!result.valid)
      throw validation(result.reasonCode ?? "STAGE_WEBHOOK_TARGET_INVALID", result.message ?? "Choose an existing webhook target.", { path: `stages.${index}.stageActions.webhookTargetKey` });
  }
  const hasFileSync = stages.some((stage) => Object.values(stage.fileSync ?? {}).some(Boolean));
  if (!hasFileSync) return;
  const storage = optional.storageConnections;
  if (!storage?.validateStageFileSyncTargets) throw validation("STAGE_FILE_SYNC_UNAVAILABLE", "File sync targets cannot be checked right now.");
  await storage.validateStageFileSyncTargets(stages, tx);
}
