/**
 * Increment 09 (D2): the orders side of trash, restore and permanent deletion. Called by the trash coordinator
 * (`server/modules/trash`) inside ITS transaction; the coordinator checks the actor's capability, step-up, typed
 * intent and idempotency. This module owns the orders rows: the trash columns, the group rules and the tombstone.
 * The coordinator emits the order.trashed / order.restored / order.purge_started / order.purged audit events.
 *
 * One claim per cascade (D2.8): every state change is a compare-and-set on the trash columns of rows locked
 * FOR UPDATE, so trash/restore/purge races and double submits have exactly one winner; the loser gets a plain 409.
 *
 * Lock order: order rows in ascending id (a group root is always older than its additions, so root → additions),
 * then users rows (identity's isTrashedInTx). Same order as every existing-order write.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, lt, lte, or, sql } from "drizzle-orm";
import { conflict, notFound } from "../../core/errors.js";
import type { Clock, Db, DbOrTx, Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import type { TrashActor, TrashEntityRef, TrashParticipant, TrashPurgeResult } from "../trash/ports.js";
import { orderQuestionAnswers, orderAdminTasks, orderQuestions } from "./questionsSchema.js";
import {
  orderAcknowledgements,
  orderGrants,
  orderLineItems,
  orderLockHistory,
  orderNameHistory,
  orderNotes,
  orderPhaseLocks,
  orderStageProgress,
  orderStatusHistory,
  orderTaskNotes,
  orderTaskWaivers,
  orders,
} from "./schema.js";
import { isGroupOrderCancelled, type GroupWorkflows } from "./orderGroups.js";
import { isLiveOrderRow } from "./trashGate.js";
import { affectedRows } from "./orderService.js";

export const TOMBSTONE_PROJECT_NAME = "Deleted order";
export const TRASH_LIST_MAX = 1000;

type OrderRow = typeof orders.$inferSelect;

const orderNotFound = () => notFound("ORDER_NOT_FOUND");
export const orderAlreadyInTrash = () => conflict("ORDER_ALREADY_IN_TRASH", "This order is already in the trash.");
export const orderNotInTrash = () => conflict("ORDER_NOT_IN_TRASH", "This order is not in the trash.");
export const orderPurgeStarted = () => conflict("PURGE_IN_PROGRESS", "This order is being deleted permanently and can no longer be restored.");
export const orderRootInTrash = () => conflict("ROOT_IN_TRASH", "Restore the first order of this project first.");
export const orderOwnerInTrash = () => conflict("OWNER_IN_TRASH", "Restore the customer account first.");
export const restorePacketConflict = () =>
  conflict("PACKET_ALREADY_IN_PROJECT", "This project now has the same packet in another order, so this order cannot be restored. Nothing was restored.");
const trashStateChanged = () => conflict("ORDER_TRASH_STATE_CHANGED", "This order changed while you were working. Refresh and try again.");

export interface TrashedOrderRow {
  id: number;
  publicId: string;
  reference: string;
  ownerUserId: number;
  trashedAt: Date;
  trashedByUserId: number | null;
  batchId: string | null;
  reason: string | null;
  purgeStartedAt: Date | null;
  groupRootPublicId: string | null;
  groupRootTrashed: boolean;
  projectName: string;
}

export interface OrderTrashRef {
  id: number;
  publicId: string;
  reference: string;
  projectName: string;
  batchId: string | null;
  ownerUserId: number;
  trashedAt: Date | null;
  purgeStartedAt: Date | null;
  purgedAt: Date | null;
  groupRootOrderId: number | null;
  groupRootPublicId: string | null;
}

export interface TrashListInput {
  /** Order number prefix or project name fragment. */
  q?: string;
  from?: Date;
  to?: Date;
  trashedByUserId?: number;
  ownerUserId?: number;
  /** Only rows trashed at or before this instant (the coordinator turns "due within N days" into this). */
  trashedBefore?: Date;
  cursor?: number | null;
  limit?: number;
}

export interface OrderTrashService {
  trashOrderInTx(tx: Tx, input: { orderPublicId: string; batchId: string; actor: TrashActor; reason: string | null }): Promise<{ entities: TrashEntityRef[] }>;
  trashOrdersOfCustomerInTx(tx: Tx, input: { ownerUserId: number; batchId: string; actor: TrashActor; reason: string | null }): Promise<{ entities: TrashEntityRef[] }>;
  restoreOrderInTx(tx: Tx, input: { orderPublicId: string; actor: TrashActor }): Promise<{ entities: TrashEntityRef[] }>;
  restoreOrdersOfBatchInTx(tx: Tx, input: { ownerUserId: number; batchId: string; actor: TrashActor }): Promise<{ entities: TrashEntityRef[] }>;
  markPurgeStartedInTx(tx: Tx, input: { orderId: number; runId: string; actor: TrashActor }): Promise<void>;
  tombstoneOrderInTx(tx: Tx, input: { orderId: number; runId: string; actor: TrashActor }): Promise<void>;
  listTrashed(input: TrashListInput, db?: DbOrTx): Promise<{ items: TrashedOrderRow[]; nextCursor: number | null }>;
  ordersOfCustomerInTx(tx: DbOrTx, ownerUserId: number, opts: { state: "live" | "trashed" | "all" }): Promise<(TrashEntityRef & { trashedAt: Date | null; purgeStartedAt: Date | null })[]>;
  trashRefInTx(tx: DbOrTx, orderPublicId: string): Promise<OrderTrashRef | null>;
  /** Every order (any owner) carrying this batch id, ascending id; tombstones excluded. */
  ordersInBatchInTx(tx: DbOrTx, batchId: string): Promise<OrderTrashRef[]>;
  isTrashedInTx(tx: DbOrTx, orderId: number): Promise<boolean>;
  participant: TrashParticipant;
}

interface Deps {
  db: Db;
  clock: Clock;
  services: Services;
  workflows: GroupWorkflows;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function entityOf(row: { id: number; publicId: string }, batchId: string): TrashEntityRef {
  return { kind: "order", id: row.id, publicId: row.publicId, batchId };
}

/** Identity's trash gate for the owner (fails closed when identity does not expose it). */
async function ownerIsTrashed(services: Services, tx: Tx, userId: number): Promise<boolean> {
  const users = (services as Partial<Services>).identity as unknown as { users?: { isTrashedInTx?: (tx: Tx, userId: number) => Promise<boolean> } } | undefined;
  const check = users?.users?.isTrashedInTx;
  if (typeof check !== "function") throw conflict("OWNER_STATE_UNVERIFIABLE", "The customer account could not be checked. Try again later.");
  return check.call(users!.users, tx, userId);
}

export function createOrderTrash(deps: Deps): OrderTrashService {
  /** Locks rows by id ascending (current reads); returns them in id order. */
  async function lockRows(tx: Tx, ids: number[]): Promise<OrderRow[]> {
    if (ids.length === 0) return [];
    return tx.select().from(orders).where(inArray(orders.id, [...new Set(ids)])).orderBy(asc(orders.id)).for("update");
  }

  /** Root + every addition (any trash state), locked in ascending id. Group size is bounded by the add-on cap. */
  async function lockGroupOf(tx: Tx, publicId: string): Promise<{ target: OrderRow; rows: OrderRow[] } | null> {
    if (!ULID.test(publicId)) return null;
    const [seen] = await tx.select({ id: orders.id, groupRootOrderId: orders.groupRootOrderId }).from(orders).where(eq(orders.publicId, publicId)).limit(1);
    if (!seen) return null;
    const rootId = seen.groupRootOrderId ?? seen.id;
    // Root first (lowest id), then the additions: the same order as add-on creation (root → members).
    const [root] = await tx.select().from(orders).where(eq(orders.id, rootId)).for("update").limit(1);
    if (!root) return null;
    const children = await tx.select().from(orders).where(eq(orders.groupRootOrderId, rootId)).orderBy(asc(orders.id)).limit(1001).for("update");
    if (children.length > 1000) throw conflict("ORDER_GROUP_TOO_LARGE", "This project has too many orders to change at once.");
    const rows = [root, ...children];
    const target = rows.find((row) => row.id === seen.id);
    return target ? { target, rows } : null;
  }

  async function setTrashed(tx: Tx, rows: OrderRow[], input: { batchId: string; actor: TrashActor; reason: string | null }) {
    if (rows.length === 0) return;
    const now = deps.clock.now();
    const result = await tx
      .update(orders)
      .set({
        trashedAt: now,
        trashedByUserId: input.actor.kind === "user" ? input.actor.userId : null,
        trashBatchId: input.batchId,
        trashReason: input.reason,
        updatedAt: now,
      })
      .where(and(inArray(orders.id, rows.map((r) => r.id)), isNull(orders.trashedAt), isNull(orders.purgedAt)));
    if (affectedRows(result) !== rows.length) throw trashStateChanged();
  }

  function normalizeReason(reason: string | null): string | null {
    if (reason === null) return null;
    const value = reason.normalize("NFC").trim();
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) throw conflict("TRASH_REASON_INVALID", "The reason may not contain control characters.");
    return value ? value.slice(0, 200) : null;
  }

  /** Packets already in live, non-cancelled orders of the group, excluding `except`. */
  async function livePacketsOf(tx: Tx, rows: OrderRow[], except: Set<number>): Promise<Set<number>> {
    const live: number[] = [];
    for (const row of rows) {
      if (except.has(row.id) || !isLiveOrderRow(row)) continue;
      if (!(await isGroupOrderCancelled(tx, deps.workflows, row))) live.push(row.id);
    }
    return packetsOf(tx, live);
  }

  async function packetsOf(tx: Tx, ids: number[]): Promise<Set<number>> {
    if (ids.length === 0) return new Set();
    const lines = await tx.select({ packetNumber: orderLineItems.packetNumber }).from(orderLineItems).where(inArray(orderLineItems.orderId, ids)).for("share");
    return new Set(lines.map((l) => l.packetNumber).filter((n): n is number => n !== null));
  }

  /** The increment 08 rule on restore: no packet number twice among the group's live, non-cancelled orders. */
  async function assertNoPacketConflict(tx: Tx, groupRows: OrderRow[], restoring: OrderRow[]) {
    const restoringIds = new Set(restoring.map((r) => r.id));
    const taken = await livePacketsOf(tx, groupRows, restoringIds);
    for (const row of restoring) {
      if (await isGroupOrderCancelled(tx, deps.workflows, row)) continue;
      for (const n of await packetsOf(tx, [row.id])) {
        if (taken.has(n)) throw restorePacketConflict();
        taken.add(n);
      }
    }
  }

  async function clearTrash(tx: Tx, rows: OrderRow[], batchId: string) {
    const now = deps.clock.now();
    const result = await tx
      .update(orders)
      .set({ trashedAt: null, trashedByUserId: null, trashBatchId: null, trashReason: null, updatedAt: now })
      .where(and(inArray(orders.id, rows.map((r) => r.id)), eq(orders.trashBatchId, batchId), isNotNull(orders.trashedAt), isNull(orders.purgeStartedAt), isNull(orders.purgedAt)));
    if (affectedRows(result) !== rows.length) throw trashStateChanged();
  }

  function refQuery(tx: DbOrTx) {
    return tx
      .select({
        id: orders.id,
        publicId: orders.publicId,
        reference: orders.reference,
        projectName: orders.projectName,
        batchId: orders.trashBatchId,
        ownerUserId: orders.ownerUserId,
        trashedAt: orders.trashedAt,
        purgeStartedAt: orders.purgeStartedAt,
        purgedAt: orders.purgedAt,
        groupRootOrderId: orders.groupRootOrderId,
      })
      .from(orders)
      .$dynamic();
  }

  async function withRootPublicIds(tx: DbOrTx, rows: Omit<OrderTrashRef, "groupRootPublicId">[]): Promise<OrderTrashRef[]> {
    const rootIds = [...new Set(rows.map((r) => r.groupRootOrderId).filter((id): id is number => id !== null))];
    const roots = rootIds.length ? new Map((await tx.select({ id: orders.id, publicId: orders.publicId }).from(orders).where(inArray(orders.id, rootIds))).map((r) => [r.id, r.publicId])) : new Map<number, string>();
    return rows.map((r) => ({ ...r, groupRootPublicId: r.groupRootOrderId !== null ? (roots.get(r.groupRootOrderId) ?? null) : null }));
  }

  const service: OrderTrashService = {
    async trashOrderInTx(tx, input) {
      const reason = normalizeReason(input.reason);
      const group = await lockGroupOf(tx, input.orderPublicId);
      if (!group || group.target.purgedAt) throw orderNotFound();
      const { target } = group;
      if (target.trashedAt) {
        // Replay of the same cascade: answer with what that batch holds; anything else is a second claim.
        if (target.trashBatchId !== input.batchId) throw orderAlreadyInTrash();
        return { entities: group.rows.filter((r) => r.trashBatchId === input.batchId).map((r) => entityOf(r, input.batchId)) };
      }
      // A root takes its live additions into the same batch; additions already in the trash keep their own batch.
      const moving = target.groupRootOrderId === null ? group.rows.filter((r) => r.id === target.id || isLiveOrderRow(r)) : [target];
      await setTrashed(tx, moving, { batchId: input.batchId, actor: input.actor, reason });
      return { entities: moving.map((r) => entityOf(r, input.batchId)) };
    },

    async trashOrdersOfCustomerInTx(tx, input) {
      const reason = normalizeReason(input.reason);
      const ids = await tx.select({ id: orders.id }).from(orders).where(eq(orders.ownerUserId, input.ownerUserId)).orderBy(asc(orders.id)).limit(10_001);
      if (ids.length > 10_000) throw conflict("CUSTOMER_TOO_MANY_ORDERS", "This customer has too many orders to move at once.");
      const rows = await lockRows(tx, ids.map((r) => r.id));
      // Current re-read under the locks: only rows still owned by this customer.
      const owned = rows.filter((r) => r.ownerUserId === input.ownerUserId);
      const moving = owned.filter(isLiveOrderRow);
      await setTrashed(tx, moving, { batchId: input.batchId, actor: input.actor, reason });
      const inBatch = owned.filter((r) => r.trashBatchId === input.batchId || moving.some((m) => m.id === r.id));
      return { entities: inBatch.map((r) => entityOf(r, input.batchId)) };
    },

    async restoreOrderInTx(tx, input) {
      const group = await lockGroupOf(tx, input.orderPublicId);
      if (!group || group.target.purgedAt) throw orderNotFound();
      const { target } = group;
      if (!target.trashedAt || !target.trashBatchId) throw orderNotInTrash();
      if (target.purgeStartedAt) throw orderPurgeStarted();
      const batchId = target.trashBatchId;
      const root = group.rows[0]!;
      if (target.id !== root.id && !isLiveOrderRow(root)) throw orderRootInTrash();
      // A root brings back the additions of its own batch (not those trashed separately).
      const restoring = target.id === root.id ? group.rows.filter((r) => r.trashBatchId === batchId && r.trashedAt && !r.purgedAt) : [target];
      if (restoring.some((r) => r.purgeStartedAt)) throw orderPurgeStarted();
      if (await ownerIsTrashed(deps.services, tx, target.ownerUserId)) throw orderOwnerInTrash();
      await assertNoPacketConflict(tx, group.rows, restoring);
      await clearTrash(tx, restoring, batchId);
      return { entities: restoring.map((r) => entityOf(r, batchId)) };
    },

    async restoreOrdersOfBatchInTx(tx, input) {
      if (!ULID.test(input.batchId)) throw orderNotInTrash();
      const ids = await tx.select({ id: orders.id }).from(orders).where(and(eq(orders.ownerUserId, input.ownerUserId), eq(orders.trashBatchId, input.batchId))).orderBy(asc(orders.id)).limit(10_001);
      if (ids.length > 10_000) throw conflict("CUSTOMER_TOO_MANY_ORDERS", "This customer has too many orders to restore at once.");
      // Group roots of those orders (a root is older, so locking all in ascending id keeps root → additions).
      const seen = await tx.select({ id: orders.id, groupRootOrderId: orders.groupRootOrderId }).from(orders).where(inArray(orders.id, ids.length ? ids.map((r) => r.id) : [0]));
      const rootIds = [...new Set(seen.map((r) => r.groupRootOrderId ?? r.id))];
      const groupIds = rootIds.length
        ? (await tx.select({ id: orders.id }).from(orders).where(or(inArray(orders.id, rootIds), inArray(orders.groupRootOrderId, rootIds)))).map((r) => r.id)
        : [];
      const rows = await lockRows(tx, [...groupIds, ...ids.map((r) => r.id)]);
      const restoring = rows.filter((r) => r.ownerUserId === input.ownerUserId && r.trashBatchId === input.batchId && r.trashedAt && !r.purgedAt);
      if (restoring.some((r) => r.purgeStartedAt)) throw orderPurgeStarted();
      const restoringIds = new Set(restoring.map((r) => r.id));
      for (const row of restoring) {
        if (row.groupRootOrderId === null) continue;
        const root = rows.find((r) => r.id === row.groupRootOrderId);
        if (!root || (!isLiveOrderRow(root) && !restoringIds.has(root.id))) throw orderRootInTrash();
      }
      for (const rootId of rootIds) {
        const groupRows = rows.filter((r) => r.id === rootId || r.groupRootOrderId === rootId);
        await assertNoPacketConflict(tx, groupRows, groupRows.filter((r) => restoringIds.has(r.id)));
      }
      await clearTrash(tx, restoring, input.batchId);
      return { entities: restoring.map((r) => entityOf(r, input.batchId)) };
    },

    async markPurgeStartedInTx(tx, input) {
      const [row] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).for("update").limit(1);
      if (!row || row.purgedAt) throw orderNotFound();
      if (!row.trashedAt) throw orderNotInTrash();
      if (row.purgeStartedAt) return; // the same purge resumed (the coordinator keeps one run per entity)
      const result = await tx
        .update(orders)
        .set({ purgeStartedAt: deps.clock.now() })
        .where(and(eq(orders.id, row.id), isNotNull(orders.trashedAt), isNull(orders.purgeStartedAt), isNull(orders.purgedAt)));
      if (affectedRows(result) !== 1) throw trashStateChanged();
    },

    async tombstoneOrderInTx(tx, input) {
      const [row] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).for("update").limit(1);
      if (!row) throw orderNotFound();
      if (row.purgedAt) return; // already a tombstone
      if (!row.trashedAt || !row.purgeStartedAt) throw conflict("ORDER_PURGE_NOT_STARTED", "Permanent deletion of this order has not started.");
      const now = deps.clock.now();
      const result = await tx
        .update(orders)
        .set({ purgedAt: now, projectName: TOMBSTONE_PROJECT_NAME, trashReason: null, discountLabel: null, promoLabel: null, createKey: null, updatedAt: now })
        .where(and(eq(orders.id, row.id), isNotNull(orders.purgeStartedAt), isNull(orders.purgedAt)));
      if (affectedRows(result) !== 1) throw trashStateChanged();
    },

    async listTrashed(input, db = deps.db) {
      const limit = Math.min(Math.max(input.limit ?? 25, 1), TRASH_LIST_MAX);
      const q = input.q?.normalize("NFC").trim().slice(0, 80) ?? "";
      const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
      const rows = await db
        .select({
          id: orders.id,
          publicId: orders.publicId,
          reference: orders.reference,
          projectName: orders.projectName,
          ownerUserId: orders.ownerUserId,
          trashedAt: orders.trashedAt,
          trashedByUserId: orders.trashedByUserId,
          batchId: orders.trashBatchId,
          reason: orders.trashReason,
          purgeStartedAt: orders.purgeStartedAt,
          groupRootOrderId: orders.groupRootOrderId,
        })
        .from(orders)
        .where(
          and(
            isNotNull(orders.trashedAt),
            isNull(orders.purgedAt),
            input.cursor ? lt(orders.id, input.cursor) : undefined,
            q ? or(like(orders.reference, `${escaped.toUpperCase()}%`), like(orders.projectName, `%${escaped}%`)) : undefined,
            input.from ? gte(orders.trashedAt, input.from) : undefined,
            input.to ? lte(orders.trashedAt, input.to) : undefined,
            input.trashedBefore ? lte(orders.trashedAt, input.trashedBefore) : undefined,
            input.trashedByUserId !== undefined ? eq(orders.trashedByUserId, input.trashedByUserId) : undefined,
            input.ownerUserId !== undefined ? eq(orders.ownerUserId, input.ownerUserId) : undefined,
          ),
        )
        .orderBy(desc(orders.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const rootIds = [...new Set(page.map((r) => r.groupRootOrderId).filter((id): id is number => id !== null))];
      const roots = rootIds.length
        ? new Map((await db.select({ id: orders.id, publicId: orders.publicId, trashedAt: orders.trashedAt, purgedAt: orders.purgedAt }).from(orders).where(inArray(orders.id, rootIds))).map((r) => [r.id, r]))
        : new Map<number, { publicId: string; trashedAt: Date | null; purgedAt: Date | null }>();
      return {
        items: page.map((r) => ({
          id: r.id,
          publicId: r.publicId,
          reference: r.reference,
          ownerUserId: r.ownerUserId,
          trashedAt: r.trashedAt!,
          trashedByUserId: r.trashedByUserId,
          batchId: r.batchId,
          reason: r.reason,
          purgeStartedAt: r.purgeStartedAt,
          projectName: r.projectName,
          groupRootPublicId: r.groupRootOrderId !== null ? (roots.get(r.groupRootOrderId)?.publicId ?? null) : null,
          groupRootTrashed: (() => {
            const root = r.groupRootOrderId !== null ? roots.get(r.groupRootOrderId) : undefined;
            return root ? !isLiveOrderRow(root) : false;
          })(),
        })),
        nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
      };
    },

    async ordersOfCustomerInTx(tx, ownerUserId, opts) {
      const rows = await tx
        .select({ id: orders.id, publicId: orders.publicId, batchId: orders.trashBatchId, trashedAt: orders.trashedAt, purgeStartedAt: orders.purgeStartedAt })
        .from(orders)
        .where(
          and(
            eq(orders.ownerUserId, ownerUserId),
            isNull(orders.purgedAt),
            opts.state === "live" ? isNull(orders.trashedAt) : opts.state === "trashed" ? isNotNull(orders.trashedAt) : undefined,
          ),
        )
        .orderBy(asc(orders.id))
        .limit(10_000);
      return rows.map((r) => ({ kind: "order" as const, id: r.id, publicId: r.publicId, batchId: r.batchId ?? "", trashedAt: r.trashedAt, purgeStartedAt: r.purgeStartedAt }));
    },

    async trashRefInTx(tx, orderPublicId) {
      if (!ULID.test(orderPublicId)) return null;
      const [row] = await refQuery(tx).where(eq(orders.publicId, orderPublicId)).limit(1);
      return row ? (await withRootPublicIds(tx, [row]))[0]! : null;
    },

    async ordersInBatchInTx(tx, batchId) {
      if (!ULID.test(batchId)) return [];
      const rows = await refQuery(tx).where(and(eq(orders.trashBatchId, batchId), isNull(orders.purgedAt))).orderBy(asc(orders.id)).limit(10_000);
      return withRootPublicIds(tx, rows);
    },

    async isTrashedInTx(tx, orderId) {
      const [row] = await tx.select({ trashedAt: orders.trashedAt, purgedAt: orders.purgedAt }).from(orders).where(eq(orders.id, orderId)).limit(1);
      return !row || !isLiveOrderRow(row);
    },

    participant: {
      module: "orders",
      async summarize(entity): Promise<Record<string, number>> {
        if (entity.kind !== "order") return {};
        const [row] = await deps.db.select().from(orders).where(eq(orders.id, entity.id)).limit(1);
        if (!row) return {};
        const additions =
          row.groupRootOrderId === null
            ? (await deps.db.select({ n: sql<number>`count(*)` }).from(orders).where(and(eq(orders.groupRootOrderId, row.id), entity.batchId ? or(eq(orders.trashBatchId, entity.batchId), isNull(orders.trashedAt)) : isNull(orders.trashedAt))))[0]?.n ?? 0
            : 0;
        const [lines] = await deps.db.select({ n: sql<number>`count(*)` }).from(orderLineItems).where(eq(orderLineItems.orderId, row.id));
        const [notes] = await deps.db.select({ n: sql<number>`count(*)` }).from(orderNotes).where(eq(orderNotes.orderId, row.id));
        const [grants] = await deps.db.select({ n: sql<number>`count(*)` }).from(orderGrants).where(and(eq(orderGrants.orderId, row.id), inArray(orderGrants.status, ["pending", "active"])));
        return { additions: Number(additions), lineItems: Number(lines?.n ?? 0), notes: Number(notes?.n ?? 0), shares: Number(grants?.n ?? 0) };
      },
      async purge(entity): Promise<TrashPurgeResult> {
        if (entity.kind !== "order") return { deleted: {} };
        const orderId = entity.id;
        return deps.db.transaction(async (tx) => {
          const [row] = await tx.select({ id: orders.id, trashedAt: orders.trashedAt, purgeStartedAt: orders.purgeStartedAt }).from(orders).where(eq(orders.id, orderId)).for("update").limit(1);
          // Fails closed: only an order whose purge has been claimed by the coordinator is erased.
          if (!row || !row.trashedAt || !row.purgeStartedAt) throw conflict("ORDER_PURGE_NOT_STARTED", "Permanent deletion of this order has not started.");
          const deleted: Record<string, number> = {};
          const del = async (label: string, run: () => Promise<unknown>) => {
            deleted[label] = affectedRows(await run());
          };
          const questionIds = (await tx.select({ id: orderQuestions.id }).from(orderQuestions).where(eq(orderQuestions.orderId, orderId))).map((q) => q.id);
          if (questionIds.length) await del("answers", () => tx.delete(orderQuestionAnswers).where(inArray(orderQuestionAnswers.questionId, questionIds)));
          await del("questions", () => tx.delete(orderQuestions).where(eq(orderQuestions.orderId, orderId)));
          await del("adminTasks", () => tx.delete(orderAdminTasks).where(eq(orderAdminTasks.orderId, orderId)));
          await del("taskNotes", () => tx.delete(orderTaskNotes).where(eq(orderTaskNotes.orderId, orderId)));
          await del("taskWaivers", () => tx.delete(orderTaskWaivers).where(eq(orderTaskWaivers.orderId, orderId)));
          await del("stageProgress", () => tx.delete(orderStageProgress).where(eq(orderStageProgress.orderId, orderId)));
          await del("phaseLocks", () => tx.delete(orderPhaseLocks).where(eq(orderPhaseLocks.orderId, orderId)));
          await del("acknowledgements", () => tx.delete(orderAcknowledgements).where(eq(orderAcknowledgements.orderId, orderId)));
          await del("notes", () => tx.delete(orderNotes).where(eq(orderNotes.orderId, orderId)));
          await del("statusHistory", () => tx.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId)));
          await del("lockHistory", () => tx.delete(orderLockHistory).where(eq(orderLockHistory.orderId, orderId)));
          await del("nameHistory", () => tx.delete(orderNameHistory).where(eq(orderNameHistory.orderId, orderId)));
          await del("shares", () => tx.delete(orderGrants).where(eq(orderGrants.orderId, orderId)));
          const [lines] = await tx.select({ n: sql<number>`count(*)` }).from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
          // Kept (D2.6): the order number reservation, the line items (product, quantity and price only — the evidence
          // behind kept invoices) and the tombstone row itself.
          return { deleted, kept: { lineItems: Number(lines?.n ?? 0), orderNumber: 1 } };
        });
      },
    },
  };
  return service;
}
