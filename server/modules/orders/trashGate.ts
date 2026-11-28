/**
 * Increment 09 (D2.5): the orders trash gate. An order is LIVE when it is neither in the trash (`trashed_at`) nor a
 * tombstone (`purged_at`). Every read and write path of the orders module answers ORDER_NOT_FOUND for a non-live
 * order, for every principal and the system actor; only the Trash centre read path (trash coordinator ports) sees
 * them. Other modules that read `orders` directly (joins, lists, counts, jobs) apply one of these predicates.
 */
import { and, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { orders } from "./schema.js";

/** `orders.trashed_at IS NULL AND orders.purged_at IS NULL`, for queries that select from or join `orders`. */
export function liveOrderPredicate(): SQL {
  return and(isNull(orders.trashedAt), isNull(orders.purgedAt))!;
}

/**
 * For tables that only hold an order id (no join): `EXISTS (live order with id = <column>)`.
 * Example: `.where(and(eq(files.ownerUserId, id), liveOrderIdPredicate(files.orderId)))`. A NULL column is false.
 */
export function liveOrderIdPredicate(orderIdColumn: AnyColumn | SQL): SQL {
  return sql`exists (select 1 from ${orders} where ${orders.id} = ${orderIdColumn} and ${orders.trashedAt} is null and ${orders.purgedAt} is null)`;
}

/** Row-level check for rows already loaded with the trash columns. */
export function isLiveOrderRow(row: { trashedAt: Date | null; purgedAt: Date | null }): boolean {
  return row.trashedAt === null && row.purgedAt === null;
}
