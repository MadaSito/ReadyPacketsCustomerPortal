/**
 * Shared column helpers so every module declares identifiers and timestamps identically.
 *
 * Conventions (see docs/engineering/BUILD_CONTRACT.md):
 *  - `id`        BIGINT UNSIGNED auto-increment primary key — installation-local, never exported as identity.
 *  - `public_id` CHAR(26) ULID, unique — the STABLE PORTABLE identifier, also used in URLs and audit refs.
 *  - timestamps  DATETIME(3) in UTC.
 *  - money       BIGINT minor units + CHAR(3) currency. Never floats/decimals for amounts.
 */
import { bigint, char, datetime, int } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { ulid } from "../core/ids.js";

export const idColumn = () => bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey();

export const publicIdColumn = () =>
  char("public_id", { length: 26 })
    .notNull()
    .unique()
    .$defaultFn(() => ulid());

/** Foreign key column type matching `idColumn`. Add `.references(() => table.id)` yourself. */
export const refColumn = (name: string) => bigint(name, { mode: "number", unsigned: true });

export const utcDateTime = (name: string) => datetime(name, { mode: "date", fsp: 3 });

export const createdAtColumn = () =>
  utcDateTime("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`);

export const updatedAtColumn = () =>
  utcDateTime("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .$onUpdateFn(() => new Date());

export const amountMinorColumn = (name: string) => bigint(name, { mode: "number" });
export const currencyColumn = (name = "currency") => char(name, { length: 3 });

/** Optimistic-concurrency / fencing counter. */
export const versionColumn = (name = "version") => int(name, { unsigned: true }).notNull().default(1);
