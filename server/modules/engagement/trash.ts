/**
 * Increment 09 (D2.5 & D2.8): Engagement TrashParticipant (`module: "engagement"`).
 *
 * - `summarize`: counts messages and support tickets tied to the target order or customer (partitioned so customer
 *   summaries never double-count tickets/messages already summarized under the customer's non-purged orders).
 * - `purge`: fail-closed verification that the target order/customer is marked for purge (`trashed_at IS NOT NULL AND
 *   purge_started_at IS NOT NULL`, or already tombstoned for idempotent retry), backfills legacy notification target
 *   columns, and permanently erases order-tied or customer-tied messages, tickets, search tokens, import provenance,
 *   notifications, read receipts, and notification preferences.
 */
import { and, count, eq, inArray, or, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { conflict, notFound } from "../../core/errors.js";
import type { Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { orders } from "../orders/schema.js";
import type { TrashEntityRef, TrashParticipant, TrashPurgeResult, TrashPurgeRun } from "../trash/ports.js";
import type { NotificationsService } from "./notificationsService.js";
import {
  engagementImportProvenance,
  engagementNotificationPreferences,
  engagementNotifications,
  engagementOrderMessageAttachments,
  engagementOrderMessageReads,
  engagementOrderMessages,
  engagementSearchTokens,
  engagementSupportTicketHistory,
  engagementSupportTicketMessages,
  engagementSupportTickets,
} from "./schema.js";

function affectedCount(res: unknown): number {
  if (Array.isArray(res) && res[0] && typeof res[0] === "object" && "affectedRows" in res[0]) {
    return Number((res[0] as { affectedRows?: number }).affectedRows ?? 0);
  }
  if (res && typeof res === "object" && "affectedRows" in res) {
    return Number((res as { affectedRows?: number }).affectedRows ?? 0);
  }
  return 0;
}

async function assertPurgeTargetAuthorizedInTx(tx: Tx, entity: TrashEntityRef): Promise<void> {
  if (entity.kind === "order") {
    const [ord] = await tx
      .select({
        id: orders.id,
        publicId: orders.publicId,
        trashedAt: orders.trashedAt,
        purgeStartedAt: orders.purgeStartedAt,
        purgedAt: orders.purgedAt,
      })
      .from(orders)
      .where(eq(orders.id, entity.id))
      .limit(1)
      .for("update");
    if (!ord || ord.publicId !== entity.publicId) {
      throw notFound("ORDER_NOT_FOUND");
    }
    const authorized = Boolean(ord.purgedAt) || (Boolean(ord.trashedAt) && Boolean(ord.purgeStartedAt));
    if (!authorized) {
      throw conflict("ORDER_PURGE_NOT_STARTED", "Order purge has not been initiated by the Trash coordinator.");
    }
    return;
  }

  const [usr] = await tx
    .select({
      id: users.id,
      publicId: users.publicId,
      trashedAt: users.trashedAt,
      purgeStartedAt: users.purgeStartedAt,
      purgedAt: users.purgedAt,
    })
    .from(users)
    .where(eq(users.id, entity.id))
    .limit(1)
    .for("update");
  if (!usr || usr.publicId !== entity.publicId) {
    throw notFound("USER_NOT_FOUND");
  }
  const authorized = Boolean(usr.purgedAt) || (Boolean(usr.trashedAt) && Boolean(usr.purgeStartedAt));
  if (!authorized) {
    throw conflict("PURGE_NOT_STARTED", "Account purge has not been initiated by the Trash coordinator.");
  }
}

async function eraseMessagesByIdsInTx(tx: Tx, messageIds: readonly number[]): Promise<number> {
  if (messageIds.length === 0) return 0;
  await tx
    .delete(engagementSearchTokens)
    .where(
      and(
        eq(engagementSearchTokens.domain, "order_message"),
        inArray(engagementSearchTokens.recordId, [...messageIds]),
      ),
    );
  await tx
    .delete(engagementImportProvenance)
    .where(
      and(
        eq(engagementImportProvenance.entityType, "order_message"),
        inArray(engagementImportProvenance.targetId, [...messageIds]),
      ),
    );
  await tx
    .delete(engagementOrderMessageAttachments)
    .where(inArray(engagementOrderMessageAttachments.messageId, [...messageIds]));
  await tx
    .delete(engagementOrderMessageReads)
    .where(inArray(engagementOrderMessageReads.messageId, [...messageIds]));
  const delRes = await tx
    .delete(engagementOrderMessages)
    .where(inArray(engagementOrderMessages.id, [...messageIds]));
  return affectedCount(delRes);
}

async function eraseTicketsByIdsInTx(tx: Tx, ticketIds: readonly number[]): Promise<number> {
  if (ticketIds.length === 0) return 0;
  const ticketMsgRows = await tx
    .select({ id: engagementSupportTicketMessages.id })
    .from(engagementSupportTicketMessages)
    .where(inArray(engagementSupportTicketMessages.ticketId, [...ticketIds]));
  const ticketMsgIds = ticketMsgRows.map((r) => r.id);

  await tx
    .delete(engagementSearchTokens)
    .where(
      and(
        eq(engagementSearchTokens.domain, "ticket"),
        inArray(engagementSearchTokens.recordId, [...ticketIds]),
      ),
    );
  await tx
    .delete(engagementImportProvenance)
    .where(
      and(
        eq(engagementImportProvenance.entityType, "ticket"),
        inArray(engagementImportProvenance.targetId, [...ticketIds]),
      ),
    );
  if (ticketMsgIds.length > 0) {
    await tx
      .delete(engagementImportProvenance)
      .where(
        and(
          eq(engagementImportProvenance.entityType, "ticket_message"),
          inArray(engagementImportProvenance.targetId, ticketMsgIds),
        ),
      );
  }
  await tx
    .delete(engagementSupportTicketMessages)
    .where(inArray(engagementSupportTicketMessages.ticketId, [...ticketIds]));
  await tx
    .delete(engagementSupportTicketHistory)
    .where(inArray(engagementSupportTicketHistory.ticketId, [...ticketIds]));
  const delRes = await tx
    .delete(engagementSupportTickets)
    .where(inArray(engagementSupportTickets.id, [...ticketIds]));
  return affectedCount(delRes);
}

export function createEngagementTrashParticipant(
  deps: ModuleDeps,
  notifications: NotificationsService,
): TrashParticipant {
  const { db } = deps;

  return {
    module: "engagement",

    async summarize(entity: TrashEntityRef): Promise<Record<string, number>> {
      if (entity.kind === "order") {
        const [[msgRow], [tktRow]] = await Promise.all([
          db
            .select({ total: count(engagementOrderMessages.id) })
            .from(engagementOrderMessages)
            .where(eq(engagementOrderMessages.orderId, entity.id)),
          db
            .select({ total: count(engagementSupportTickets.id) })
            .from(engagementSupportTickets)
            .where(eq(engagementSupportTickets.relatedOrderId, entity.id)),
        ]);
        return {
          messages: Number(msgRow?.total ?? 0),
          tickets: Number(tktRow?.total ?? 0),
        };
      }

      // Customer summary: exclude rows already summarized under the customer's non-tombstoned orders.
      const notUnderCustomerLiveOrTrashedOrder = (orderIdCol: typeof engagementOrderMessages.orderId | typeof engagementSupportTickets.relatedOrderId) =>
        sql`(${orderIdCol} is null or not exists (
          select 1 from ${orders}
          where ${orders.id} = ${orderIdCol}
            and ${orders.ownerUserId} = ${entity.id}
            and ${orders.purgedAt} is null
        ))`;

      const [[msgRow], [tktRow]] = await Promise.all([
        db
          .select({ total: count(engagementOrderMessages.id) })
          .from(engagementOrderMessages)
          .where(
            and(
              eq(engagementOrderMessages.authorUserId, entity.id),
              notUnderCustomerLiveOrTrashedOrder(engagementOrderMessages.orderId),
            ),
          ),
        db
          .select({ total: count(engagementSupportTickets.id) })
          .from(engagementSupportTickets)
          .where(
            and(
              eq(engagementSupportTickets.requesterUserId, entity.id),
              notUnderCustomerLiveOrTrashedOrder(engagementSupportTickets.relatedOrderId),
            ),
          ),
      ]);

      return {
        messages: Number(msgRow?.total ?? 0),
        tickets: Number(tktRow?.total ?? 0),
      };
    },

    async purge(entity: TrashEntityRef, run: TrashPurgeRun): Promise<TrashPurgeResult> {
      return db.transaction(async (tx) => {
        await run.assertCurrentInTx(tx);
        await assertPurgeTargetAuthorizedInTx(tx, entity);
        await notifications.backfillLegacyTargets(tx);

        if (entity.kind === "order") {
          const msgRows = await tx
            .select({ id: engagementOrderMessages.id })
            .from(engagementOrderMessages)
            .where(eq(engagementOrderMessages.orderId, entity.id));
          const ticketRows = await tx
            .select({ id: engagementSupportTickets.id })
            .from(engagementSupportTickets)
            .where(eq(engagementSupportTickets.relatedOrderId, entity.id));

          const messageIds = msgRows.map((r) => r.id);
          const ticketIds = ticketRows.map((r) => r.id);

          const notifRes = await tx.delete(engagementNotifications).where(
            ticketIds.length > 0
              ? or(
                  eq(engagementNotifications.orderId, entity.id),
                  inArray(engagementNotifications.ticketId, ticketIds),
                )
              : eq(engagementNotifications.orderId, entity.id),
          );
          await tx
            .delete(engagementOrderMessageReads)
            .where(eq(engagementOrderMessageReads.orderId, entity.id));

          const deletedMessages = await eraseMessagesByIdsInTx(tx, messageIds);
          const deletedTickets = await eraseTicketsByIdsInTx(tx, ticketIds);
          const deletedNotifications = affectedCount(notifRes);

          const deleted: Record<string, number> = {};
          if (deletedMessages > 0) deleted.messages = deletedMessages;
          if (deletedTickets > 0) deleted.tickets = deletedTickets;
          if (deletedNotifications > 0) deleted.notifications = deletedNotifications;
          return { deleted };
        }

        // Customer purge: preferences, read receipts, notifications (own + any staff notifications referencing their tickets),
        // all customer tickets, and any remaining customer-authored order messages.
        const ticketRows = await tx
          .select({ id: engagementSupportTickets.id })
          .from(engagementSupportTickets)
          .where(eq(engagementSupportTickets.requesterUserId, entity.id));
        const msgRows = await tx
          .select({ id: engagementOrderMessages.id })
          .from(engagementOrderMessages)
          .where(eq(engagementOrderMessages.authorUserId, entity.id));

        const ticketIds = ticketRows.map((r) => r.id);
        const messageIds = msgRows.map((r) => r.id);

        const prefRes = await tx
          .delete(engagementNotificationPreferences)
          .where(eq(engagementNotificationPreferences.userId, entity.id));
        await tx
          .delete(engagementOrderMessageReads)
          .where(eq(engagementOrderMessageReads.userId, entity.id));
        const notifRes = await tx.delete(engagementNotifications).where(
          ticketIds.length > 0
            ? or(
                eq(engagementNotifications.userId, entity.id),
                inArray(engagementNotifications.ticketId, ticketIds),
              )
            : eq(engagementNotifications.userId, entity.id),
        );

        const deletedTickets = await eraseTicketsByIdsInTx(tx, ticketIds);
        await tx
          .delete(engagementSupportTicketMessages)
          .where(eq(engagementSupportTicketMessages.authorUserId, entity.id));
        const deletedMessages = await eraseMessagesByIdsInTx(tx, messageIds);

        const deletedPreferences = affectedCount(prefRes);
        const deletedNotifications = affectedCount(notifRes);

        const deleted: Record<string, number> = {};
        if (deletedMessages > 0) deleted.messages = deletedMessages;
        if (deletedTickets > 0) deleted.tickets = deletedTickets;
        if (deletedNotifications > 0) deleted.notifications = deletedNotifications;
        if (deletedPreferences > 0) deleted.notificationPreferences = deletedPreferences;
        return { deleted };
      });
    },
  };
}
