/**
 * Increment 03 — context resolvers for the order triggers of the automations catalogue (entries are curated in
 * `server/modules/audit/triggerCatalogue.ts`). Worker-side, read-only, no locks. Fields carry identifiers and
 * labels only (never names, e-mail addresses or note bodies); recipients are `users.id` values.
 *
 * Status labels are taken from the workflow VERSION the order is bound to, and for `order.status_changed` from the
 * event's `to_status` (not the order's current status, which may have moved on before the worker ran).
 */
import { eq } from "drizzle-orm";
import { ULID_PATTERN } from "../../core/ids.js";
import { registerAutomationTrigger, type AutomationTriggerResolveInput } from "../automations/contracts.js";
import { orders } from "./schema.js";
import { findState } from "./workflowTypes.js";

const STATUS_KEY = /^[a-z][a-z0-9_]{1,47}$/;

async function resolveOrderContext({ event, db, services, signal }: AutomationTriggerResolveInput) {
  signal.throwIfAborted();
  const orderPublicId = event.resource?.type === "order" ? event.resource.publicId : null;
  if (!orderPublicId || orderPublicId.length !== 26 || !ULID_PATTERN.test(orderPublicId)) return {};
  const [order] = await db
    .select({ publicId: orders.publicId, reference: orders.reference, ownerUserId: orders.ownerUserId, statusKey: orders.statusKey, workflowVersionId: orders.workflowVersionId })
    .from(orders)
    .where(eq(orders.publicId, orderPublicId))
    .limit(1);
  if (!order) return {};
  const attributes = event.attributes;
  const eventStatus = typeof attributes.to_status === "string" && STATUS_KEY.test(attributes.to_status) ? attributes.to_status : null;
  const bound = await services.orders.workflows.byVersionId(db, order.workflowVersionId);
  const statusKey = eventStatus ?? order.statusKey;
  const state = findState(bound.definition, statusKey);
  return {
    orderPublicId: order.publicId,
    fields: {
      order_reference: order.reference,
      order_status_label: state?.customerLabel ?? statusKey,
      order_link: new URL(`/orders/${order.publicId}`, services.config.canonicalOrigin).href,
    },
    // Orders have no staff assignee in this release, so `order_assignee` resolves to nobody.
    recipients: { order_owner: [order.ownerUserId], order_assignee: [] },
  };
}

for (const key of ["order.created", "order.status_changed", "order.assigned"]) registerAutomationTrigger({ key, resolveContext: resolveOrderContext });

export { resolveOrderContext };
