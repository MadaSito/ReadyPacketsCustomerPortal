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
import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { DbOrTx, Tx } from "../../core/types.js";
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

/** Options for mutation consumers (D2 integration, http_security review). */
export interface TrashedCheckOptions {
  /**
   * "share": a current (locking) read, `SELECT … FOR SHARE`, held until the caller's transaction ends, so a
   * concurrent trash / purge of the owner (which takes `FOR UPDATE` on the same row) waits for the caller, and the
   * caller never decides on a stale repeatable-read snapshot. With a lock, an UNKNOWN id answers true (fail closed).
   * Requires a transaction (`Tx`); lock owners before child rows to keep one lock order (users → owned rows).
   */
  lock?: "share";
}

/**
 * True when the user is in the trash OR is a tombstone (both are "gone" for every caller except the Trash centre).
 * Without `lock`: a plain read; an unknown id answers false (read callers keep their own not-found handling).
 * With `{ lock: "share" }`: a locking current read; an unknown id answers true (fail closed for mutations).
 */
export async function isTrashedUserInTx(tx: DbOrTx, userId: number, opts: TrashedCheckOptions = {}): Promise<boolean> {
  if (opts.lock === "share") return (await lockGoneUsersInTx(tx as Tx, [userId])).length > 0;
  const [row] = await tx.select({ trashedAt: users.trashedAt, purgedAt: users.purgedAt }).from(users).where(eq(users.id, userId)).limit(1);
  return row ? !isLiveUserRow(row) : false;
}

/**
 * Locks the given owners `FOR SHARE` in ascending id order (one lock order across modules, no deadlock between two
 * consumers) and returns the ids that are NOT live: trashed, tombstoned or unknown (fail closed), ascending.
 * An empty result means every owner is live and stays live until the caller's transaction ends.
 */
export async function lockGoneUsersInTx(tx: Tx, userIds: readonly number[]): Promise<number[]> {
  const ids = [...new Set(userIds.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
  const invalid = userIds.filter((id) => !(Number.isSafeInteger(id) && id > 0));
  if (ids.length === 0) return [...new Set(invalid)];
  const rows = await tx
    .select({ id: users.id, trashedAt: users.trashedAt, purgedAt: users.purgedAt })
    .from(users)
    .where(inArray(users.id, ids))
    .orderBy(asc(users.id))
    .for("share");
  const live = new Set(rows.filter(isLiveUserRow).map((r) => r.id));
  return [...new Set([...invalid, ...ids.filter((id) => !live.has(id))])].sort((a, b) => a - b);
}
