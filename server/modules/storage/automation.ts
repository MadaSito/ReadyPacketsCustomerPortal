import { z } from "zod";
import { registerAutomationAction, type AutomationActionRegistration } from "../automations/contracts.js";
import { storagePublicId } from "./validation.js";

const configSchema = z.strictObject({ connectionPublicId: storagePublicId.optional() });

export const orderFilesCopyAction: AutomationActionRegistration<z.infer<typeof configSchema>> = {
  key: "storage.copy_order_files",
  owner: "storage",
  label: "Copy order files",
  description: "Queue current order files for active storage connections assigned to order files.",
  category: "Storage and sync",
  configSchema,
  configFields: [{ key: "connectionPublicId", label: "Storage connection", type: "storage_connection",
    required: false, helpText: "Leave blank to use all active order-file destinations." }],
  requiresOrderContext: true,
  supportedTriggerModes: ["event", "manual"],
  retrySafe: true,
  async run(ctx) {
    if (ctx.dryRun) return { outcome: "skipped", reasonCode: "STORAGE_COPY_DRY_RUN" };
    if (!ctx.orderPublicId) return { outcome: "skipped", reasonCode: "STORAGE_COPY_SOURCE_INACTIVE" };
    const result = await ctx.deps.services.storageConnections.stageOrderFilesForAutomation({
      orderPublicId: ctx.orderPublicId, connectionPublicId: ctx.config.connectionPublicId, correlationId: ctx.correlationId,
      signal: ctx.signal, assertStillOwned: ctx.assertStillOwned,
    });
    if (result.cause) return { outcome: "skipped", reasonCode: result.cause };
    return { outcome: "completed", safeCounts: { queued: result.queued }, safeSummary: "Eligible file copies were staged." };
  },
};

registerAutomationAction(orderFilesCopyAction);
