/**
 * Increment 07 (D2) — global order status catalogue Drizzle MySQL schema.
 * Owner: recovery_ops_engineer (Package C).
 *
 * Re-exported from `./schema.ts` so Drizzle kit includes `order_status_catalog` in `0007_increment_07.sql`.
 */
import { boolean, index, int, mysqlEnum, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import {
  createdAtColumn,
  idColumn,
  publicIdColumn,
  updatedAtColumn,
  utcDateTime,
  versionColumn,
} from "../../db/columns.js";
import {
  ORDER_STATUS_ATTENTIONS,
  ORDER_STATUS_CATEGORIES,
  ORDER_STATUS_TONES,
} from "../../../shared/orderStatusCatalog.js";

export { ORDER_STATUS_ATTENTIONS, ORDER_STATUS_CATEGORIES, ORDER_STATUS_TONES };

export const orderStatusCatalog = mysqlTable(
  "order_status_catalog",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    /** Immutable lowercase status key (matches `orders.status_key`). */
    key: varchar("key", { length: 48 }).notNull(),
    staffLabel: varchar("staff_label", { length: 60 }).notNull(),
    customerLabel: varchar("customer_label", { length: 60 }).notNull(),
    tone: mysqlEnum("tone", ORDER_STATUS_TONES).notNull().default("neutral"),
    category: mysqlEnum("category", ORDER_STATUS_CATEGORIES).notNull(),
    attention: mysqlEnum("attention", ORDER_STATUS_ATTENTIONS).notNull().default("none"),
    position: int("position", { unsigned: true }).notNull().default(0),
    retired: boolean("retired").notNull().default(false),
    retiredAt: utcDateTime("retired_at"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("order_status_catalog_key_uq").on(t.key),
    index("order_status_catalog_pos_idx").on(t.retired, t.position, t.id),
  ],
);

export type OrderStatusCatalogRow = typeof orderStatusCatalog.$inferSelect;
export type NewOrderStatusCatalogRow = typeof orderStatusCatalog.$inferInsert;
