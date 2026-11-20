import { datetime, index, int, mysqlEnum, mysqlTable, primaryKey } from "drizzle-orm/mysql-core";
import { RATE_LIMIT_CATEGORIES } from "../core/types.js";

export const rateLimitCounters = mysqlTable("http_rate_limit_counters", {
  category: mysqlEnum("category", RATE_LIMIT_CATEGORIES).notNull(),
  slot: int("slot", { unsigned: true }).notNull(),
  hits: int("hits", { unsigned: true }).notNull(),
  resetAt: datetime("reset_at", { mode: "date", fsp: 3 }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.category, t.slot] }),
  index("http_rate_limit_reset_idx").on(t.resetAt),
]);
