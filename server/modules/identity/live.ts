/**
 * Increment 09 (D2.5) — the identity trash gate other modules reuse.
 *
 * An account is LIVE when it is neither in the trash (`trashed_at`) nor a tombstone (`purged_at`). Every list, count,
 * search, picker, reminder, mail recipient or export that reads `users` without going through the identity service
 * must AND this predicate into its WHERE clause (or join condition):
 *
 *   import { liveUserPredicate } from "../identity/live.js";
 *   db.select().from(users).where(and(eq(users.role, "customer"), liveUserPredicate()));
 *   // aliased table: liveUserPredicate(alias)
 *
 * A trashed or tombstoned account must look exactly like a row that never existed (no existence oracle).
 */
import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../../core/types.js";
import { users } from "./schema.js";

type TrashColumns = { trashedAt: typeof users.trashedAt; purgedAt: typeof users.purgedAt };

/** SQL: `<t>.trashed_at IS NULL AND <t>.purged_at IS NULL`. */
export function liveUserPredicate(table: TrashColumns = users): SQL {
  return and(isNull(table.trashedAt), isNull(table.purgedAt)) as SQL;
}

/** Plain-row form for code that already holds a users row. */
export function isLiveUserRow(row: { trashedAt: Date | null; purgedAt: Date | null }): boolean {
  return row.trashedAt === null && row.purgedAt === null;
}

/**
 * True when the user is in the trash OR is a tombstone (both are "gone" for every caller except the Trash centre).
 * An unknown id answers false (callers keep their own not-found handling).
 */
export async function isTrashedUserInTx(tx: DbOrTx, userId: number): Promise<boolean> {
  const [row] = await tx.select({ trashedAt: users.trashedAt, purgedAt: users.purgedAt }).from(users).where(eq(users.id, userId)).limit(1);
  return row ? !isLiveUserRow(row) : false;
}
