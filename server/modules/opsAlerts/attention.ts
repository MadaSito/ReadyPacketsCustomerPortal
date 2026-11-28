import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import type { ModuleDeps } from "../../container.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { liveUserPredicate } from "../identity/live.js";
import { users } from "../identity/schema.js";
import { orders } from "../orders/schema.js";
import { liveOrderPredicate } from "../orders/trashGate.js";
import { defineSetting, readSetting } from "../platform/index.js";
import type { OpsAlertsModule } from "./index.js";

export const attentionHoursSchema = z.number().int().min(1).max(24 * 365);
export const ATTENTION_ALERT_HOURS = defineSetting({
  key: "orders.attention_alert_hours", owner: "ops_alerts", group: "orders",
  label: "Order attention reminder threshold (hours)", description: "How long a waiting order must remain in the same attention state.",
  schema: attentionHoursSchema, default: 48,
  managedBy: { label: "Operational alerts", href: "/admin/alerts" },
});
export const ATTENTION_ALERTS_ENABLED = defineSetting({
  key: "orders.attention_alerts_enabled", owner: "ops_alerts", group: "orders",
  label: "Order attention reminders", description: "Creates staff alerts for overdue waiting orders. Never sends customer email.",
  schema: z.boolean(), default: false,
  managedBy: { label: "Operational alerts", href: "/admin/alerts" },
});

const JOB = "ops.alerts.attention_check";
const PAGE = 50;
const continuation = z.strictObject({
  after: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sweep: z.string().regex(ULID_PATTERN),
});

export function registerAttentionReminder(deps: ModuleDeps, alerts: Pick<OpsAlertsModule, "emit">) {
  deps.jobs.register(JOB, async (job) => {
    const cursor = job.payload === null || job.payload === undefined ? null : continuation.safeParse(job.payload);
    if (cursor && !cursor.success) return { outcome: "failed", retryable: false, reasonCode: "ATTENTION_ALERT_CURSOR_INVALID" };
    return deps.db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      if (!await readSetting(deps.settings, ATTENTION_ALERTS_ENABLED, tx)) return { outcome: "completed" } as const;
      const hours = await readSetting(deps.settings, ATTENTION_ALERT_HOURS, tx);
      const cutoff = new Date(deps.clock.now().getTime() - hours * 60 * 60 * 1_000);
      const rows = await tx.select({
        id: orders.id, publicId: orders.publicId, attention: orders.attention, since: orders.attentionSince,
      }).from(orders).innerJoin(users, eq(users.id, orders.ownerUserId)).where(and(
        liveOrderPredicate(),
        liveUserPredicate(),
        inArray(orders.attention, ["staff_review", "customer_response"]),
        lte(orders.attentionSince, cutoff), gt(orders.id, cursor?.data.after ?? 0),
      )).orderBy(asc(orders.id)).limit(PAGE).for("update");
      for (const order of rows) {
        if (!order.since) continue;
        await alerts.emit({
          source: "attention", severity: "warning", code: "ORDER_ATTENTION_OVERDUE",
          title: order.attention === "staff_review" ? "Order waiting for staff review" : "Order waiting for customer response",
          text: "Review the order and decide whether a follow-up is needed.",
          orderPublicId: order.publicId, runPublicId: job.jobId, correlationId: job.correlationId,
          dedupKey: `${order.publicId}:${order.attention}:${order.since.getTime()}`,
        }, tx);
      }
      if (rows.length === PAGE) {
        const after = rows[PAGE - 1]!.id;
        const sweep = cursor?.data.sweep ?? job.jobId;
        await deps.jobs.enqueue(JOB, { after, sweep }, { idempotencyKey: `${sweep}:${after}`, correlationId: job.correlationId }, tx);
      }
      return { outcome: "completed", safeCounts: { orders_checked: rows.length } } as const;
    }, { isolationLevel: "read committed" });
  }, { retrySafe: true });
  deps.jobs.registerSchedule({ name: JOB, type: JOB, everyMs: 24 * 60 * 60 * 1_000 });
}
