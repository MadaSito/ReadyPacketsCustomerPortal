/**
 * Increment 03 — context resolvers for the engagement triggers in `TRIGGER_CATALOGUE`:
 *  - `message.posted` (`visibility: "customer"`)
 *  - `message.internal_note` (`visibility: "internal"`, `staffOnly: true`)
 *  - `ticket.opened`
 *  - `ticket.replied` (`internal_only: false`)
 *  - `ticket.closed` (`to_status: "closed"`)
 *
 * Read-only, worker-side resolvers. Never include message/ticket bodies, names, or e-mail addresses.
 */
import { eq } from "drizzle-orm";
import { ULID_PATTERN } from "../../core/ids.js";
import {
  registerAutomationTrigger,
  type AutomationResolvedTriggerContext,
  type AutomationTriggerResolveInput,
} from "../automations/contracts.js";
import { engagementOrderMessages, engagementSupportTickets } from "./schema.js";

async function resolveMessageContext({
  triggerKey,
  event,
  db,
  services,
  signal,
}: AutomationTriggerResolveInput): Promise<AutomationResolvedTriggerContext> {
  signal.throwIfAborted();
  const messagePublicId =
    event.resource?.type === "order_message" ? event.resource.publicId : null;
  if (!messagePublicId || !ULID_PATTERN.test(messagePublicId)) return {};

  const [msg] = await db
    .select({
      orderPublicId: engagementOrderMessages.orderPublicId,
      orderReference: engagementOrderMessages.orderReference,
      visibility: engagementOrderMessages.visibility,
    })
    .from(engagementOrderMessages)
    .where(eq(engagementOrderMessages.publicId, messagePublicId))
    .limit(1);
  if (!msg) return {};

  // Defense-in-depth visibility match (`J-A01`): never resolve `order_owner` for an internal note.
  const isInternal = msg.visibility === "internal" || triggerKey === "message.internal_note";
  const orderRef = await services.orders?.getOrderRefByPublicId?.(msg.orderPublicId, db);
  const linkPath = isInternal
    ? `/admin/orders/${msg.orderPublicId}/messages`
    : `/orders/${msg.orderPublicId}/messages`;

  return {
    orderPublicId: msg.orderPublicId,
    fields: {
      order_public_id: msg.orderPublicId,
      order_reference: orderRef?.reference ?? msg.orderReference,
      order_status_label: orderRef?.statusKey ?? "",
      order_link: new URL(linkPath, services.config.canonicalOrigin).href,
    },
    recipients: isInternal
      ? { order_assignee: [] }
      : {
          order_owner: orderRef ? [orderRef.ownerUserId] : [],
          order_assignee: [],
        },
  };
}

async function resolveTicketContext({
  event,
  db,
  services,
  signal,
}: AutomationTriggerResolveInput): Promise<AutomationResolvedTriggerContext> {
  signal.throwIfAborted();
  const ticketPublicId = event.resource?.type === "ticket" ? event.resource.publicId : null;
  if (!ticketPublicId || !ULID_PATTERN.test(ticketPublicId)) return {};

  const [ticket] = await db
    .select({
      publicId: engagementSupportTickets.publicId,
      ticketNumber: engagementSupportTickets.ticketNumber,
      requesterUserId: engagementSupportTickets.requesterUserId,
      assigneeUserId: engagementSupportTickets.assigneeUserId,
      relatedOrderPublicId: engagementSupportTickets.relatedOrderPublicId,
    })
    .from(engagementSupportTickets)
    .where(eq(engagementSupportTickets.publicId, ticketPublicId))
    .limit(1);
  if (!ticket) return {};

  return {
    orderPublicId: ticket.relatedOrderPublicId,
    fields: {
      ticket_number: ticket.ticketNumber,
      ticket_link: new URL(`/support/${ticket.publicId}`, services.config.canonicalOrigin).href,
    },
    recipients: {
      ticket_requester: [ticket.requesterUserId],
      ticket_assignee: ticket.assigneeUserId ? [ticket.assigneeUserId] : [],
    },
  };
}

registerAutomationTrigger({ key: "message.posted", resolveContext: resolveMessageContext });
registerAutomationTrigger({ key: "message.internal_note", resolveContext: resolveMessageContext });
registerAutomationTrigger({ key: "ticket.opened", resolveContext: resolveTicketContext });
registerAutomationTrigger({ key: "ticket.replied", resolveContext: resolveTicketContext });
registerAutomationTrigger({ key: "ticket.closed", resolveContext: resolveTicketContext });
