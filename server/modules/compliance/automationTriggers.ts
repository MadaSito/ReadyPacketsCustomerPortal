/**
 * Increment 03 — worker-side context resolvers for `invoice.issued` and `invoice.paid`
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
import { complianceInvoices } from "./schema.js";

async function resolveInvoiceTriggerContext({
  triggerKey,
  event,
  db,
  services,
  signal,
}: AutomationTriggerResolveInput): Promise<AutomationResolvedTriggerContext> {
  signal.throwIfAborted();

  let invoicePublicId: string | null = null;
  if (triggerKey === "invoice.issued" && event.resource?.type === "invoice") {
    invoicePublicId = event.resource.publicId ?? null;
  } else if (typeof event.attributes.invoice_public_id === "string") {
    invoicePublicId = event.attributes.invoice_public_id;
  }

  if (!invoicePublicId || invoicePublicId.length !== 26 || !ULID_PATTERN.test(invoicePublicId)) {
    return {};
  }

  const [invoice] = await db
    .select({
      publicId: complianceInvoices.publicId,
      invoiceNumber: complianceInvoices.invoiceNumber,
      orderPublicId: complianceInvoices.orderPublicId,
    })
    .from(complianceInvoices)
    .where(eq(complianceInvoices.publicId, invoicePublicId))
    .limit(1);

  if (!invoice) return {};

  const [order] = await db
    .select({
      publicId: orders.publicId,
      reference: orders.reference,
      ownerUserId: orders.ownerUserId,
      statusKey: orders.statusKey,
      workflowVersionId: orders.workflowVersionId,
    })
    .from(orders)
    .where(eq(orders.publicId, invoice.orderPublicId))
    .limit(1);

  if (!order) {
    return {
      orderPublicId: invoice.orderPublicId,
      fields: {
        invoice_number: invoice.invoiceNumber ?? invoice.publicId,
        invoice_link: new URL(`/invoices/${invoice.publicId}`, services.config.canonicalOrigin).href,
      },
    };
  }

  const bound = await services.orders.workflows.byVersionId(db, order.workflowVersionId);
  const state = findState(bound.definition, order.statusKey);

  return {
    orderPublicId: order.publicId,
    fields: {
      order_public_id: order.publicId,
      order_reference: order.reference,
      order_status_label: state?.customerLabel ?? order.statusKey,
      order_link: new URL(`/orders/${order.publicId}`, services.config.canonicalOrigin).href,
      invoice_number: invoice.invoiceNumber ?? invoice.publicId,
      invoice_link: new URL(`/invoices/${invoice.publicId}`, services.config.canonicalOrigin).href,
    },
    recipients: {
      order_owner: [order.ownerUserId],
    },
  };
}

for (const key of ["invoice.issued", "invoice.paid"] as const) {
  registerAutomationTrigger({ key, resolveContext: resolveInvoiceTriggerContext });
}

export { resolveInvoiceTriggerContext };
