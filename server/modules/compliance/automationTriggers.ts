/**
 * Increment 03 & 07 — worker-side context resolvers for invoice, payment, and intake triggers
 * in the curated automations trigger catalogue (`server/modules/audit/triggerCatalogue.ts`).
 */
import { eq } from "drizzle-orm";
import { ULID_PATTERN } from "../../core/ids.js";
import {
  registerAutomationTrigger,
  type AutomationResolvedTriggerContext,
  type AutomationTriggerResolveInput,
} from "../automations/contracts.js";
import { orders } from "../orders/schema.js";
import { findState } from "../orders/workflowTypes.js";
import { complianceInvoices, intakeSubmissions } from "./schema.js";

function validUlid(raw: unknown): string | null {
  return typeof raw === "string" && raw.length === 26 && ULID_PATTERN.test(raw) ? raw : null;
}

async function resolveOrderFields(
  orderPublicId: string,
  { db, services }: Pick<AutomationTriggerResolveInput, "db" | "services">,
) {
  const [order] = await db
    .select({
      publicId: orders.publicId,
      reference: orders.reference,
      ownerUserId: orders.ownerUserId,
      statusKey: orders.statusKey,
      workflowVersionId: orders.workflowVersionId,
    })
    .from(orders)
    .where(eq(orders.publicId, orderPublicId))
    .limit(1);

  if (!order) return null;

  const bound = await services.orders.workflows.byVersionId(db, order.workflowVersionId);
  const state = findState(bound.definition, order.statusKey);

  return {
    order,
    fields: {
      order_public_id: order.publicId,
      order_reference: order.reference,
      order_status_label: state?.customerLabel ?? order.statusKey,
      order_link: new URL(`/orders/${order.publicId}`, services.config.canonicalOrigin).href,
    },
    recipients: {
      order_owner: [order.ownerUserId],
      order_assignee: [] as number[],
    },
  };
}

async function resolveInvoiceTriggerContext({
  triggerKey,
  event,
  db,
  services,
  signal,
}: AutomationTriggerResolveInput): Promise<AutomationResolvedTriggerContext> {
  signal.throwIfAborted();

  const invoicePublicId =
    triggerKey === "invoice.issued" && event.resource?.type === "invoice"
      ? validUlid(event.resource.publicId)
      : validUlid(event.attributes.invoice_public_id);

  if (invoicePublicId) {
    const [invoice] = await db
      .select({
        publicId: complianceInvoices.publicId,
        invoiceNumber: complianceInvoices.invoiceNumber,
        orderPublicId: complianceInvoices.orderPublicId,
      })
      .from(complianceInvoices)
      .where(eq(complianceInvoices.publicId, invoicePublicId))
      .limit(1);

    if (invoice) {
      const invoiceFields = {
        invoice_number: invoice.invoiceNumber ?? invoice.publicId,
        invoice_link: new URL(`/invoices/${invoice.publicId}`, services.config.canonicalOrigin).href,
      };
      const resolvedOrder = await resolveOrderFields(invoice.orderPublicId, { db, services });
      if (!resolvedOrder) {
        return {
          orderPublicId: invoice.orderPublicId,
          fields: invoiceFields,
        };
      }
      return {
        orderPublicId: resolvedOrder.order.publicId,
        fields: {
          ...resolvedOrder.fields,
          ...invoiceFields,
        },
        recipients: resolvedOrder.recipients,
      };
    }
  }

  const fallbackOrderPublicId = validUlid(event.attributes.order_public_id);
  if (!fallbackOrderPublicId) {
    return {};
  }
  const resolvedOrder = await resolveOrderFields(fallbackOrderPublicId, { db, services });
  if (!resolvedOrder) {
    return { orderPublicId: fallbackOrderPublicId };
  }
  return {
    orderPublicId: resolvedOrder.order.publicId,
    fields: resolvedOrder.fields,
    recipients: resolvedOrder.recipients,
  };
}

async function resolveIntakeTriggerContext({
  event,
  db,
  services,
  signal,
}: AutomationTriggerResolveInput): Promise<AutomationResolvedTriggerContext> {
  signal.throwIfAborted();

  let orderPublicId = validUlid(event.attributes.order_public_id);
  if (!orderPublicId && event.resource?.type === "intake_submission") {
    const submissionPublicId = validUlid(event.resource.publicId);
    if (submissionPublicId) {
      const [sub] = await db
        .select({ orderId: intakeSubmissions.orderId })
        .from(intakeSubmissions)
        .where(eq(intakeSubmissions.publicId, submissionPublicId))
        .limit(1);
      if (sub) {
        const [ord] = await db
          .select({ publicId: orders.publicId })
          .from(orders)
          .where(eq(orders.id, sub.orderId))
          .limit(1);
        orderPublicId = ord?.publicId ?? null;
      }
    }
  }

  if (!orderPublicId) {
    return {};
  }

  const resolvedOrder = await resolveOrderFields(orderPublicId, { db, services });
  if (!resolvedOrder) {
    return { orderPublicId };
  }
  return {
    orderPublicId: resolvedOrder.order.publicId,
    fields: resolvedOrder.fields,
    recipients: resolvedOrder.recipients,
  };
}

for (const key of [
  "invoice.issued",
  "invoice.paid",
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
] as const) {
  registerAutomationTrigger({ key, resolveContext: resolveInvoiceTriggerContext });
}

for (const key of ["intake.submitted", "intake.reviewed"] as const) {
  registerAutomationTrigger({ key, resolveContext: resolveIntakeTriggerContext });
}

export { resolveIntakeTriggerContext, resolveInvoiceTriggerContext };
