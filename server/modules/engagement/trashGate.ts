/**
 * Engagement trash / tombstone gates (`server/modules/engagement/trashGate.ts`).
 *
 * Composes `identity`'s live-user predicate and `orders`'s live-order predicate so nothing
 * about a trashed or tombstoned order or customer appears in message lists, ticket lists,
 * notifications, unread counts, global search, portable exports, or public API v1 responses,
 * and no notification or outbound mail is produced for them.
 */
import { and, eq, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../../core/types.js";
import { complianceInvoices } from "../compliance/schema.js";
import { isLiveUserRow, isTrashedUserInTx } from "../identity/live.js";
import { users } from "../identity/schema.js";
import { orders } from "../orders/schema.js";
import { isLiveOrderRow, liveOrderIdPredicate } from "../orders/trashGate.js";
import {
  engagementNotifications,
  engagementOrderMessages,
  engagementSupportTickets,
} from "./schema.js";

const ULID_CAPTURE = "([0-9A-HJKMNP-TV-Z]{26})";
const ORDER_PATH_RE = new RegExp(
  `^/(?:(?:admin|console)/)?orders/${ULID_CAPTURE}(?:[/?#]|$)`,
  "i",
);
const INVOICE_PATH_RE = new RegExp(
  `^/(?:(?:admin|console)/)?invoices/${ULID_CAPTURE}(?:[/?#]|$)`,
  "i",
);
const TICKET_PATH_RE = new RegExp(
  `^/(?:support(?:/tickets)?|(?:(?:admin|console)/)?tickets)/${ULID_CAPTURE}(?:[/?#]|$)`,
  "i",
);

/**
 * SQL predicate asserting that `userIdCol` references a live (neither trashed nor tombstoned)
 * `users` row. Note: if `userIdCol` is NULL, this evaluates to FALSE.
 */
export function liveUserIdPredicate(userIdCol: AnyColumn | SQL): SQL {
  return sql`exists (select 1 from ${users} where ${users.id} = ${userIdCol} and ${users.trashedAt} is null and ${users.purgedAt} is null)`;
}

/**
 * SQL predicate for nullable `order_id` columns: passes when `orderIdCol IS NULL` OR the
 * referenced order is live (`trashed_at IS NULL AND purged_at IS NULL`).
 */
export function nullableLiveOrderIdPredicate(orderIdCol: AnyColumn): SQL {
  return or(isNull(orderIdCol), liveOrderIdPredicate(orderIdCol))!;
}

/**
 * SQL predicate for `engagement_order_messages`: the order is live AND the message author is live.
 */
export function liveOrderMessagePredicate(): SQL {
  return and(
    liveOrderIdPredicate(engagementOrderMessages.orderId),
    liveUserIdPredicate(engagementOrderMessages.authorUserId),
  )!;
}

/**
 * SQL predicate for `engagement_support_tickets`: a ticket is live iff its requester customer
 * is live AND (if linked to an order) that order is live.
 */
export function liveTicketPredicate(): SQL {
  return and(
    liveUserIdPredicate(engagementSupportTickets.requesterUserId),
    nullableLiveOrderIdPredicate(engagementSupportTickets.relatedOrderId),
  )!;
}

/**
 * SQL predicate for nullable `ticket_id` columns: passes when `ticketIdCol IS NULL` OR the
 * referenced support ticket exists and is live (live requester AND nullable-live order).
 */
export function nullableLiveTicketIdPredicate(ticketIdCol: AnyColumn): SQL {
  return or(
    isNull(ticketIdCol),
    sql`exists (
      select 1 from ${engagementSupportTickets}
      where ${engagementSupportTickets.id} = ${ticketIdCol}
        and exists (
          select 1 from ${users}
          where ${users.id} = ${engagementSupportTickets.requesterUserId}
            and ${users.trashedAt} is null
            and ${users.purgedAt} is null
        )
        and (
          ${engagementSupportTickets.relatedOrderId} is null
          or exists (
            select 1 from ${orders}
            where ${orders.id} = ${engagementSupportTickets.relatedOrderId}
              and ${orders.trashedAt} is null
              and ${orders.purgedAt} is null
          )
        )
    )`,
  )!;
}

/**
 * SQL predicate for `engagement_notifications`: recipient user is live, any associated
 * `order_id` is live, and any associated `ticket_id` is live.
 */
export function liveNotificationPredicate(): SQL {
  return and(
    liveUserIdPredicate(engagementNotifications.userId),
    nullableLiveOrderIdPredicate(engagementNotifications.orderId),
    nullableLiveTicketIdPredicate(engagementNotifications.ticketId),
  )!;
}

/**
 * Checks inside `tx` whether an internal `orderId` belongs to a live order whose owner
 * customer is also live.
 */
export async function isLiveOrderByIdInTx(db: DbOrTx, orderId: number): Promise<boolean> {
  const [row] = await db
    .select({
      id: orders.id,
      trashedAt: orders.trashedAt,
      purgedAt: orders.purgedAt,
      ownerTrashedAt: users.trashedAt,
      ownerPurgedAt: users.purgedAt,
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.ownerUserId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) return false;
  return (
    isLiveOrderRow(row) &&
    isLiveUserRow({ trashedAt: row.ownerTrashedAt, purgedAt: row.ownerPurgedAt })
  );
}

/**
 * Checks inside `tx` whether a ticket row's requester and optional related order are both live.
 */
export async function isLiveTicketRowInTx(
  db: DbOrTx,
  ticket: { requesterUserId: number; relatedOrderId: number | null },
): Promise<boolean> {
  if (await isTrashedUserInTx(db, ticket.requesterUserId)) {
    return false;
  }
  if (ticket.relatedOrderId !== null) {
    if (!(await isLiveOrderByIdInTx(db, ticket.relatedOrderId))) {
      return false;
    }
  }
  return true;
}

export interface ParsedNotificationLinkRef {
  kind: "order" | "invoice" | "ticket";
  publicId: string;
}

export function parseNotificationLinkRef(
  link: string | null | undefined,
): ParsedNotificationLinkRef | null {
  if (!link) return null;
  const orderMatch = ORDER_PATH_RE.exec(link);
  if (orderMatch?.[1]) {
    return { kind: "order", publicId: orderMatch[1].toUpperCase() };
  }
  const invoiceMatch = INVOICE_PATH_RE.exec(link);
  if (invoiceMatch?.[1]) {
    return { kind: "invoice", publicId: invoiceMatch[1].toUpperCase() };
  }
  const ticketMatch = TICKET_PATH_RE.exec(link);
  if (ticketMatch?.[1]) {
    return { kind: "ticket", publicId: ticketMatch[1].toUpperCase() };
  }
  return null;
}

export interface ResolvedNotificationTargets {
  orderId: number | null;
  ticketId: number | null;
  /** True when the notification targets a missing, trashed, or tombstoned order/ticket. */
  suppressed: boolean;
}

/**
 * Resolves `orderId` / `ticketId` for a notification from explicit caller IDs and/or its
 * relative portal `link`, and verifies that every referenced target is currently live.
 */
export async function resolveNotificationTargetsInTx(
  db: DbOrTx,
  input: {
    orderId?: number | null;
    ticketId?: number | null;
    link?: string | null;
  },
): Promise<ResolvedNotificationTargets> {
  let orderId: number | null = input.orderId ?? null;
  let ticketId: number | null = input.ticketId ?? null;

  if (orderId === null && ticketId === null) {
    const parsed = parseNotificationLinkRef(input.link);
    if (parsed?.kind === "order") {
      const [ord] = await db
        .select({
          id: orders.id,
          trashedAt: orders.trashedAt,
          purgedAt: orders.purgedAt,
          ownerTrashedAt: users.trashedAt,
          ownerPurgedAt: users.purgedAt,
        })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.ownerUserId))
        .where(eq(orders.publicId, parsed.publicId))
        .limit(1);
      if (
        !ord ||
        !isLiveOrderRow(ord) ||
        !isLiveUserRow({ trashedAt: ord.ownerTrashedAt, purgedAt: ord.ownerPurgedAt })
      ) {
        return { orderId: ord?.id ?? null, ticketId: null, suppressed: true };
      }
      orderId = ord.id;
    } else if (parsed?.kind === "invoice") {
      const [inv] = await db
        .select({ orderId: complianceInvoices.orderId })
        .from(complianceInvoices)
        .where(eq(complianceInvoices.publicId, parsed.publicId))
        .limit(1);
      if (!inv) {
        return { orderId: null, ticketId: null, suppressed: true };
      }
      orderId = inv.orderId;
      if (!(await isLiveOrderByIdInTx(db, orderId))) {
        return { orderId, ticketId: null, suppressed: true };
      }
    } else if (parsed?.kind === "ticket") {
      const [tkt] = await db
        .select({
          id: engagementSupportTickets.id,
          requesterUserId: engagementSupportTickets.requesterUserId,
          relatedOrderId: engagementSupportTickets.relatedOrderId,
        })
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.publicId, parsed.publicId))
        .limit(1);
      if (!tkt) {
        return { orderId: null, ticketId: null, suppressed: true };
      }
      ticketId = tkt.id;
      orderId = tkt.relatedOrderId;
      if (!(await isLiveTicketRowInTx(db, tkt))) {
        return { orderId, ticketId, suppressed: true };
      }
    }
  } else {
    if (ticketId !== null) {
      const [tkt] = await db
        .select({
          id: engagementSupportTickets.id,
          requesterUserId: engagementSupportTickets.requesterUserId,
          relatedOrderId: engagementSupportTickets.relatedOrderId,
        })
        .from(engagementSupportTickets)
        .where(eq(engagementSupportTickets.id, ticketId))
        .limit(1);
      if (!tkt || !(await isLiveTicketRowInTx(db, tkt))) {
        return { orderId: orderId ?? tkt?.relatedOrderId ?? null, ticketId, suppressed: true };
      }
      if (orderId === null && tkt.relatedOrderId !== null) {
        orderId = tkt.relatedOrderId;
      }
    }
    if (orderId !== null && !(await isLiveOrderByIdInTx(db, orderId))) {
      return { orderId, ticketId, suppressed: true };
    }
  }

  return { orderId, ticketId, suppressed: false };
}
