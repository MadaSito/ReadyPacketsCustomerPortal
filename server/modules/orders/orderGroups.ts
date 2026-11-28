/**
 * Increment 08 (D3): order groups ("add packets to this project"). An addition is a new, separate order (own line
 * items, invoice, payment and workflow instance) whose `group_root_order_id` points at the group root. Groups are
 * flat: an addition always points at the root, never at another addition.
 *
 * Every write-side check here runs under the root row lock (`SELECT … FOR UPDATE` on the root), so two concurrent
 * additions to one project serialise and cannot both buy the same packet. Under that fence, members and their line
 * items are read with LOCKING reads (`FOR SHARE`), which see the latest committed rows rather than the transaction's
 * repeatable-read snapshot (that snapshot may predate a concurrent addition that committed while we waited).
 * Lock order: root order row → member order rows → member line items, all before any users row (see lockGroupRoot).
 */
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { conflict } from "../../core/errors.js";
import type { DbOrTx, Tx } from "../../core/types.js";
import { orderLineItems, orders } from "./schema.js";
import { isLiveOrderRow, liveOrderPredicate } from "./trashGate.js";
import { ORDER_NOT_FOUND } from "./policy.js";
import { findState, isCancelState } from "./workflowTypes.js";
import type { BoundWorkflow } from "./workflows.js";

export interface GroupWorkflows {
  byVersionId(tx: DbOrTx, versionId: number): Promise<BoundWorkflow>;
}

export type GroupRootRow = typeof orders.$inferSelect;

export const packetAlreadyInProject = () =>
  conflict("PACKET_ALREADY_IN_PROJECT", "A selected packet is already part of this project. Remove it and try again.");

export const addOnTargetUnavailable = () =>
  conflict("ADD_ON_TARGET_UNAVAILABLE", "Packets can no longer be added to this project.");

async function isCancelled(tx: DbOrTx, workflows: GroupWorkflows, row: { workflowVersionId: number; statusKey: string }): Promise<boolean> {
  const bound = await workflows.byVersionId(tx, row.workflowVersionId);
  const state = findState(bound.definition, row.statusKey);
  return state ? isCancelState(state) : /cancel/.test(row.statusKey);
}

/**
 * Locks the project of `orderPublicId` for an addition by `ownerUserId` and returns the root, or null when the
 * addressed order or its root is missing or not this owner's (callers answer ORDER_NOT_FOUND).
 *
 * Lock order — every ORDER-row lock is taken here, BEFORE any users-row lock (the actor check), matching existing
 * order mutations (order row → users rows, actor.ts): root FOR UPDATE → addressed member FOR SHARE → all members FOR
 * SHARE → their line items FOR SHARE. Call it first in the transaction; calling it again later is a no-op for locks.
 *
 * Foreign ids never take a lock: a plain read with the owner in the WHERE clause gates first (InnoDB would keep a
 * lock on a scanned non-matching row under repeatable read). Ownership is then DECIDED only from locking (current)
 * reads under the root fence: the root again with the owner predicate, and the addressed member re-read FOR SHARE so
 * a child reassigned while we waited can no longer select the project.
 */
export async function lockGroupRoot(tx: Tx, orderPublicId: string, ownerUserId: number): Promise<GroupRootRow | null> {
  const [seen] = await tx
    .select({ id: orders.id, groupRootOrderId: orders.groupRootOrderId })
    .from(orders)
    .where(and(eq(orders.publicId, orderPublicId), eq(orders.ownerUserId, ownerUserId), liveOrderPredicate()))
    .limit(1);
  if (!seen) return null;
  const rootId = seen.groupRootOrderId ?? seen.id;
  if (rootId !== seen.id) {
    const [seenRoot] = await tx.select({ id: orders.id }).from(orders).where(and(eq(orders.id, rootId), eq(orders.ownerUserId, ownerUserId), liveOrderPredicate())).limit(1);
    if (!seenRoot) return null;
  }
  const [root] = await tx.select().from(orders).where(and(eq(orders.id, rootId), eq(orders.ownerUserId, ownerUserId))).for("update").limit(1);
  // Increment 09: a trashed or tombstoned root (current read under the lock) takes no additions.
  if (!root || root.groupRootOrderId !== null || !isLiveOrderRow(root)) return null;
  if (seen.id !== rootId) {
    const [member] = await tx
      .select({ ownerUserId: orders.ownerUserId, groupRootOrderId: orders.groupRootOrderId, trashedAt: orders.trashedAt, purgedAt: orders.purgedAt })
      .from(orders)
      .where(eq(orders.id, seen.id))
      .for("share")
      .limit(1);
    if (!member || member.ownerUserId !== ownerUserId || member.groupRootOrderId !== rootId || !isLiveOrderRow(member)) return null;
  }
  const members = await groupMembers(tx, root, { locking: true });
  await packetNumbersByOrder(tx, members.map((m) => m.id), { locking: true });
  return root;
}

/** Lock-order alias used before the actor check (decides nothing; the caller re-checks through assertAddOnAllowed). */
export async function prelockGroupRoot(tx: Tx, orderPublicId: string, ownerUserId: number): Promise<void> {
  await lockGroupRoot(tx, orderPublicId, ownerUserId);
}

/** Upper bound of a group; the write path fails closed above it instead of checking a truncated list. */
export const GROUP_MEMBER_CAP = 500;

/**
 * Orders of the group with the root's owner (root first, then by id). `locking` = authoritative current read under
 * the root fence (write path); otherwise a snapshot read for display.
 */
export async function groupMembers(tx: DbOrTx, root: { id: number; ownerUserId: number }, opts: { locking?: boolean; includeTrashed?: boolean } = {}) {
  const query = tx
    .select({
      id: orders.id,
      publicId: orders.publicId,
      reference: orders.reference,
      createdAt: orders.createdAt,
      statusKey: orders.statusKey,
      workflowVersionId: orders.workflowVersionId,
      groupRootOrderId: orders.groupRootOrderId,
    })
    .from(orders)
    // Increment 09: trashed and tombstoned members are not part of the live group (view, packets, add-on checks).
    .where(and(eq(orders.ownerUserId, root.ownerUserId), or(eq(orders.id, root.id), eq(orders.groupRootOrderId, root.id)), opts.includeTrashed ? undefined : liveOrderPredicate()))
    .orderBy(asc(orders.id))
    .limit(GROUP_MEMBER_CAP + 1);
  const rows = opts.locking ? await query.for("share") : await query;
  if (opts.locking && rows.length > GROUP_MEMBER_CAP) throw addOnTargetUnavailable();
  return rows.slice(0, GROUP_MEMBER_CAP);
}

/** Packet numbers per order id for the given orders. */
export async function packetNumbersByOrder(tx: DbOrTx, orderIds: number[], opts: { locking?: boolean } = {}): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (orderIds.length === 0) return map;
  const query = tx
    .select({ orderId: orderLineItems.orderId, packetNumber: orderLineItems.packetNumber })
    .from(orderLineItems)
    .where(inArray(orderLineItems.orderId, orderIds));
  const rows = opts.locking ? await query.for("share") : await query;
  for (const row of rows) {
    if (row.packetNumber === null) continue;
    const list = map.get(row.orderId) ?? [];
    if (!list.includes(row.packetNumber)) list.push(row.packetNumber);
    map.set(row.orderId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a - b);
  return map;
}

/** Packet numbers already bought in the group (any tier), ignoring cancelled orders. */
export async function packetsInGroup(tx: DbOrTx, workflows: GroupWorkflows, root: { id: number; ownerUserId: number }, opts: { locking?: boolean } = {}): Promise<number[]> {
  const members = await groupMembers(tx, root, opts);
  const live: number[] = [];
  for (const member of members) if (!(await isCancelled(tx, workflows, member))) live.push(member.id);
  const byOrder = await packetNumbersByOrder(tx, live, opts);
  return [...new Set([...byOrder.values()].flat())].sort((a, b) => a - b);
}

/**
 * Write-side validation for a new addition, under the root lock. Throws ORDER_NOT_FOUND (missing or foreign),
 * ADD_ON_TARGET_UNAVAILABLE (cancelled root, different currency) or PACKET_ALREADY_IN_PROJECT.
 */
export async function assertAddOnAllowed(
  tx: Tx,
  workflows: GroupWorkflows,
  input: { orderPublicId: string; ownerUserId: number; currency: string; packetNumbers: (number | null)[] },
): Promise<GroupRootRow> {
  const root = await lockGroupRoot(tx, input.orderPublicId, input.ownerUserId);
  if (!root) throw ORDER_NOT_FOUND();
  if (await isCancelled(tx, workflows, root)) throw addOnTargetUnavailable();
  if (root.currency !== input.currency) throw addOnTargetUnavailable();
  const taken = new Set(await packetsInGroup(tx, workflows, root, { locking: true }));
  if (input.packetNumbers.some((n) => n !== null && taken.has(n))) throw packetAlreadyInProject();
  return root;
}

/** Read port (cart, checkout summary, NewOrderPage): null when the owner may not add to this order's project. */
export async function addOnTarget(
  tx: DbOrTx,
  workflows: GroupWorkflows,
  ownerUserId: number,
  orderPublicId: string,
): Promise<{ rootPublicId: string; rootReference: string; projectName: string; currency: string; packetNumbers: number[] } | null> {
  const [member] = await tx
    .select({ id: orders.id, groupRootOrderId: orders.groupRootOrderId, ownerUserId: orders.ownerUserId })
    .from(orders)
    .where(and(eq(orders.publicId, orderPublicId), liveOrderPredicate()))
    .limit(1);
  if (!member || member.ownerUserId !== ownerUserId) return null;
  const [root] = await tx.select().from(orders).where(and(eq(orders.id, member.groupRootOrderId ?? member.id), liveOrderPredicate())).limit(1);
  if (!root || root.ownerUserId !== ownerUserId) return null;
  if (await isCancelled(tx, workflows, root)) return null;
  return {
    rootPublicId: root.publicId,
    rootReference: root.reference,
    projectName: root.projectName,
    currency: root.currency,
    packetNumbers: await packetsInGroup(tx, workflows, root),
  };
}

export { isCancelled as isGroupOrderCancelled };
