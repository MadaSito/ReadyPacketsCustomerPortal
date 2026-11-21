/** "Sync order to SharePoint" automation action (increment 03 package H). Enqueues the fenced sync job only. */
import { z } from "zod";
import { registerAutomationAction, type AutomationActionRegistration } from "../automations/contracts.js";

const configSchema = z.strictObject({});

export const syncOrderAction: AutomationActionRegistration<z.infer<typeof configSchema>> = {
  key: "sharepoint.sync_order",
  label: "Sync order to SharePoint",
  description: "Queue an idempotent SharePoint order-data sync for the order in context.",
  category: "Storage and sync",
  owner: "portable",
  configSchema,
  configFields: [],
  requiresOrderContext: true,
  // External order-data sink: never driven by staff-only triggers (J-A01).
  forbidOnStaffOnlyTrigger: true,
  supportedTriggerModes: ["event", "manual"],
  // Only enqueues a DB job keyed by the step idempotency key; the job itself is idempotent by order public id.
  retrySafe: true,
  async run(ctx) {
    if (ctx.dryRun) return { outcome: "skipped", reasonCode: "SHAREPOINT_SYNC_DRY_RUN" };
    if (ctx.staffOnlyTrigger) return { outcome: "skipped", reasonCode: "SHAREPOINT_SYNC_STAFF_ONLY_TRIGGER" };
    if (!ctx.orderPublicId) return { outcome: "skipped", reasonCode: "SHAREPOINT_SYNC_NO_ORDER" };
    await ctx.assertStillOwned();
    const sharepoint = (ctx.deps.services as { sharepoint?: { enqueueOrder: (id: string, o: { correlationId: string; idempotencyKey: string }) => Promise<string> } }).sharepoint;
    if (!sharepoint) return { outcome: "skipped", reasonCode: "SHAREPOINT_SYNC_UNAVAILABLE" };
    const result = await sharepoint.enqueueOrder(ctx.orderPublicId, { correlationId: ctx.correlationId, idempotencyKey: ctx.idempotencyKey });
    if (result === "disabled") return { outcome: "skipped", reasonCode: "SHAREPOINT_SYNC_DISABLED" };
    if (result === "order_not_found") return { outcome: "skipped", reasonCode: "SHAREPOINT_SYNC_ORDER_NOT_FOUND" };
    return { outcome: "completed", safeCounts: { queued: 1 }, safeSummary: "The order sync was queued." };
  },
};

registerAutomationAction(syncOrderAction);
