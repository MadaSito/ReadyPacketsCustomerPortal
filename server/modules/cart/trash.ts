/**
 * Cart & Checkout Trash & Permanent Deletion integration (Increment 09, Decisions D2.5, D2.6, D2.8).
 * Owner: recovery_ops_engineer.
 *
 * Invariants:
 *  - Canonical lock order: `trash_purge_runs (FOR SHARE) -> users (FOR SHARE) -> orders (FOR SHARE) -> carts (FOR UPDATE) -> cart_items`.
 *  - `onTrashedInTx`: when an order moves to trash, any open cart targeting it (`add_to_order_public_id`) clears that target.
 *  - `summarize`: reports `{ carts }` for a customer when non-zero; `{}` for orders.
 *  - `purge`: calls `await run.assertCurrentInTx(tx)` as the first statement of its mutation transaction, verifies
 *    `purge_started_at` on the target row, deletes all owned `carts` (cascading `cart_items`, `cart_upsell_cart_states`,
 *    and `cart_upsell_acceptances`) on customer deletion, and scrubs order link columns on `carts` on order deletion.
 */
import { and, asc, count, eq, inArray, or, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { conflict, notFound } from "../../core/errors.js";
import type { DbOrTx, Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { orders } from "../orders/schema.js";
import { isLiveOrderRow, liveOrderPredicate } from "../orders/trashGate.js";
import type {
  TrashEntityRef,
  TrashParticipant,
  TrashPurgeResult,
  TrashPurgeRun,
} from "../trash/ports.js";
import { cartItems, carts, type CartRow } from "./schema.js";

export function isMysqlDeadlockError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === "object"; depth += 1) {
    const e = cur as { code?: unknown; errno?: unknown; sqlState?: unknown; cause?: unknown };
    if (e.code === "ER_LOCK_DEADLOCK" || e.errno === 1213 || e.sqlState === "40001") {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

/**
 * Returns `true` iff a checked-out cart still points to a live (neither trashed nor tombstoned) order.
 * Fails closed when order links were scrubbed or the `orders` row is trashed, tombstoned, or absent.
 * When `opts.forShare` is set, acquires `FOR SHARE` on `orders` (call BEFORE locking `carts` to preserve
 * `users -> orders -> carts` lock order).
 */
export async function isCheckoutOrderLive(
  db: DbOrTx,
  cartRow: Pick<CartRow, "checkoutInvoicePublicId" | "checkoutOrderId" | "checkoutOrderPublicId">,
  opts?: { forShare?: boolean },
): Promise<boolean> {
  if (!cartRow.checkoutInvoicePublicId) return false;
  if (cartRow.checkoutOrderId === null && !cartRow.checkoutOrderPublicId) {
    return false;
  }
  const predicate =
    cartRow.checkoutOrderId !== null
      ? eq(orders.id, cartRow.checkoutOrderId)
      : eq(orders.publicId, cartRow.checkoutOrderPublicId!);
  if (opts?.forShare) {
    const [ordRow] = await (db as Tx)
      .select({ trashedAt: orders.trashedAt, purgedAt: orders.purgedAt })
      .from(orders)
      .where(predicate)
      .for("share")
      .limit(1);
    return Boolean(ordRow && isLiveOrderRow(ordRow));
  }
  const [ordRow] = await db
    .select({ trashedAt: orders.trashedAt, purgedAt: orders.purgedAt })
    .from(orders)
    .where(predicate)
    .limit(1);
  return Boolean(ordRow && isLiveOrderRow(ordRow));
}

async function peekOwnedLiveAddOnIds(
  tx: Tx,
  ownerUserId: number,
  orderPublicId: string,
): Promise<{ seenId: number; rootId: number } | null> {
  const [seen] = await tx
    .select({ id: orders.id, groupRootOrderId: orders.groupRootOrderId })
    .from(orders)
    .where(and(eq(orders.publicId, orderPublicId), eq(orders.ownerUserId, ownerUserId), liveOrderPredicate()))
    .limit(1);
  if (!seen) return null;
  const rootId = seen.groupRootOrderId ?? seen.id;
  if (rootId !== seen.id) {
    const [seenRoot] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, rootId), eq(orders.ownerUserId, ownerUserId), liveOrderPredicate()))
      .limit(1);
    if (!seenRoot) return null;
  }
  return { seenId: seen.id, rootId };
}

/**
 * Acquires `FOR SHARE` on the owned add-on root (and addressed member when distinct) in `orders.id ASC` order
 * BEFORE `carts FOR UPDATE`, verifying live current-read status so concurrent `moveToTrash(order)` serializes cleanly.
 */
export async function shareLockLiveAddOnTargetInTx(
  tx: Tx,
  ownerUserId: number,
  orderPublicId: string,
): Promise<{ rootId: number; rootPublicId: string } | null> {
  const peeked = await peekOwnedLiveAddOnIds(tx, ownerUserId, orderPublicId);
  if (!peeked) return null;
  const lockIds = [...new Set([peeked.rootId, peeked.seenId])].sort((a, b) => a - b);
  const lockedRows = await tx
    .select({
      id: orders.id,
      publicId: orders.publicId,
      ownerUserId: orders.ownerUserId,
      groupRootOrderId: orders.groupRootOrderId,
      trashedAt: orders.trashedAt,
      purgedAt: orders.purgedAt,
    })
    .from(orders)
    .where(and(inArray(orders.id, lockIds), eq(orders.ownerUserId, ownerUserId)))
    .orderBy(asc(orders.id))
    .for("share");
  const rootRow = lockedRows.find((r) => r.id === peeked.rootId);
  if (!rootRow || rootRow.groupRootOrderId !== null || !isLiveOrderRow(rootRow)) return null;
  if (peeked.seenId !== peeked.rootId) {
    const memberRow = lockedRows.find((r) => r.id === peeked.seenId);
    if (!memberRow || memberRow.groupRootOrderId !== peeked.rootId || !isLiveOrderRow(memberRow)) return null;
  }
  return { rootId: rootRow.id, rootPublicId: rootRow.publicId };
}

/**
 * Ordered `orders` lock fence for `restoreCheckout` (called AFTER `actorCheck` and BEFORE `compliance`/`payments`/`carts` locks):
 * acquires `FOR UPDATE` on the checkout order and `FOR SHARE` on any `sourceCart` / `openCart` add-on roots/members in a
 * single `orders.id ASC` pass, returning authoritative current-read liveness for each.
 */
export async function lockRestoreOrdersFenceInTx(
  tx: Tx,
  input: {
    ownerUserId: number;
    checkoutCart: Pick<CartRow, "checkoutInvoicePublicId" | "checkoutOrderId" | "checkoutOrderPublicId"> | null;
    sourceAddToOrderPublicId: string | null;
    openAddToOrderPublicId: string | null;
  },
): Promise<{
  checkoutOrderLive: boolean;
  liveSourceRootPublicId: string | null;
  liveOpenRootPublicId: string | null;
}> {
  let checkoutOrderIdToLock: number | null = null;
  let checkoutPossiblyLive = false;
  if (input.checkoutCart && input.checkoutCart.checkoutInvoicePublicId) {
    if (input.checkoutCart.checkoutOrderId !== null || input.checkoutCart.checkoutOrderPublicId) {
      const predicate =
        input.checkoutCart.checkoutOrderId !== null
          ? eq(orders.id, input.checkoutCart.checkoutOrderId)
          : eq(orders.publicId, input.checkoutCart.checkoutOrderPublicId!);
      const [peekCheckout] = await tx
        .select({
          id: orders.id,
          ownerUserId: orders.ownerUserId,
          trashedAt: orders.trashedAt,
          purgedAt: orders.purgedAt,
        })
        .from(orders)
        .where(predicate)
        .limit(1);
      if (peekCheckout && peekCheckout.ownerUserId === input.ownerUserId && isLiveOrderRow(peekCheckout)) {
        checkoutOrderIdToLock = peekCheckout.id;
        checkoutPossiblyLive = true;
      }
    }
  }

  const sourcePeek = input.sourceAddToOrderPublicId
    ? await peekOwnedLiveAddOnIds(tx, input.ownerUserId, input.sourceAddToOrderPublicId)
    : null;
  const openPeek = input.openAddToOrderPublicId
    ? await peekOwnedLiveAddOnIds(tx, input.ownerUserId, input.openAddToOrderPublicId)
    : null;

  const forUpdateIds = new Set<number>();
  if (checkoutOrderIdToLock !== null) {
    forUpdateIds.add(checkoutOrderIdToLock);
  }
  const forShareIds = new Set<number>();
  for (const p of [sourcePeek, openPeek]) {
    if (!p) continue;
    if (!forUpdateIds.has(p.rootId)) forShareIds.add(p.rootId);
    if (!forUpdateIds.has(p.seenId)) forShareIds.add(p.seenId);
  }

  const sortedOrderIds = [...new Set([...forUpdateIds, ...forShareIds])].sort((a, b) => a - b);
  const lockedById = new Map<
    number,
    {
      id: number;
      publicId: string;
      ownerUserId: number;
      groupRootOrderId: number | null;
      trashedAt: Date | null;
      purgedAt: Date | null;
    }
  >();

  for (const ordId of sortedOrderIds) {
    const baseQuery = tx
      .select({
        id: orders.id,
        publicId: orders.publicId,
        ownerUserId: orders.ownerUserId,
        groupRootOrderId: orders.groupRootOrderId,
        trashedAt: orders.trashedAt,
        purgedAt: orders.purgedAt,
      })
      .from(orders)
      .where(eq(orders.id, ordId))
      .limit(1);
    const [row] = forUpdateIds.has(ordId) ? await baseQuery.for("update") : await baseQuery.for("share");
    if (row) {
      lockedById.set(row.id, row);
    }
  }

  const lockedCheckout = checkoutOrderIdToLock !== null ? lockedById.get(checkoutOrderIdToLock) : undefined;
  const checkoutOrderLive = Boolean(
    checkoutPossiblyLive &&
      lockedCheckout &&
      lockedCheckout.ownerUserId === input.ownerUserId &&
      isLiveOrderRow(lockedCheckout),
  );

  const verifyLockedAddOn = (peek: { seenId: number; rootId: number } | null): string | null => {
    if (!peek) return null;
    const rootRow = lockedById.get(peek.rootId);
    if (
      !rootRow ||
      rootRow.ownerUserId !== input.ownerUserId ||
      rootRow.groupRootOrderId !== null ||
      !isLiveOrderRow(rootRow)
    ) {
      return null;
    }
    if (peek.seenId !== peek.rootId) {
      const memberRow = lockedById.get(peek.seenId);
      if (
        !memberRow ||
        memberRow.ownerUserId !== input.ownerUserId ||
        memberRow.groupRootOrderId !== peek.rootId ||
        !isLiveOrderRow(memberRow)
      ) {
        return null;
      }
    }
    return rootRow.publicId;
  };

  return {
    checkoutOrderLive,
    liveSourceRootPublicId: verifyLockedAddOn(sourcePeek),
    liveOpenRootPublicId: verifyLockedAddOn(openPeek),
  };
}

export function createCartTrashParticipant(deps: ModuleDeps): TrashParticipant {
  return {
    module: "cart",

    async onTrashedInTx(tx: Tx, entity: TrashEntityRef): Promise<void> {
      if (entity.kind !== "order") return;
      const now = deps.clock.now();
      await tx
        .update(carts)
        .set({
          addToOrderPublicId: null,
          version: sql`${carts.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(carts.status, "open"), eq(carts.addToOrderPublicId, entity.publicId)));
    },

    async summarize(entity: TrashEntityRef): Promise<Record<string, number>> {
      if (entity.kind !== "customer") return {};
      if (!Number.isSafeInteger(entity.id) || entity.id <= 0) return {};
      const [row] = await deps.db
        .select({ cnt: count() })
        .from(carts)
        .where(eq(carts.ownerUserId, entity.id));
      const total = Number(row?.cnt ?? 0);
      return total > 0 ? { carts: total } : {};
    },

    async purge(entity: TrashEntityRef, run: TrashPurgeRun): Promise<TrashPurgeResult> {
      return deps.db.transaction(async (tx): Promise<TrashPurgeResult> => {
        // D2.8 fence: FIRST statement of the participant mutation transaction (`trash_purge_runs FOR SHARE`).
        await run.assertCurrentInTx(tx);

        if (entity.kind === "customer") {
          const [custRow] = await tx
            .select({
              id: users.id,
              publicId: users.publicId,
              trashBatchId: users.trashBatchId,
              purgeStartedAt: users.purgeStartedAt,
              purgedAt: users.purgedAt,
            })
            .from(users)
            .where(eq(users.id, entity.id))
            .for("share")
            .limit(1);
          if (!custRow || custRow.publicId !== entity.publicId) {
            throw notFound("CUSTOMER_NOT_FOUND");
          }
          if (!custRow.purgedAt && (!custRow.purgeStartedAt || custRow.trashBatchId !== entity.batchId)) {
            throw conflict(
              "PURGE_NOT_STARTED",
              "Permanent deletion has not started for this customer account.",
            );
          }

          const ownedCarts = await tx
            .select({ id: carts.id })
            .from(carts)
            .where(eq(carts.ownerUserId, entity.id))
            .orderBy(asc(carts.id))
            .for("update");
          if (ownedCarts.length === 0) {
            return { deleted: {} };
          }

          const cartIds = ownedCarts.map((c) => c.id);
          const [itemsCountRow] = await tx
            .select({ cnt: count() })
            .from(cartItems)
            .where(inArray(cartItems.cartId, cartIds));
          const itemCount = Number(itemsCountRow?.cnt ?? 0);

          await tx.delete(carts).where(inArray(carts.id, cartIds));

          const deleted: Record<string, number> = { carts: cartIds.length };
          if (itemCount > 0) {
            deleted.cartItems = itemCount;
          }
          return { deleted };
        }

        const [ordRow] = await tx
          .select({
            id: orders.id,
            publicId: orders.publicId,
            trashBatchId: orders.trashBatchId,
            purgeStartedAt: orders.purgeStartedAt,
            purgedAt: orders.purgedAt,
          })
          .from(orders)
          .where(eq(orders.id, entity.id))
          .for("share")
          .limit(1);
        if (!ordRow || ordRow.publicId !== entity.publicId) {
          throw notFound("ORDER_NOT_FOUND");
        }
        if (!ordRow.purgedAt && (!ordRow.purgeStartedAt || ordRow.trashBatchId !== entity.batchId)) {
          throw conflict("PURGE_NOT_STARTED", "Permanent deletion has not started for this order.");
        }

        const linkedCarts = await tx
          .select({
            id: carts.id,
            addToOrderPublicId: carts.addToOrderPublicId,
            checkoutOrderId: carts.checkoutOrderId,
            checkoutOrderPublicId: carts.checkoutOrderPublicId,
          })
          .from(carts)
          .where(
            or(
              eq(carts.checkoutOrderId, entity.id),
              eq(carts.checkoutOrderPublicId, entity.publicId),
              eq(carts.addToOrderPublicId, entity.publicId),
            ),
          )
          .orderBy(asc(carts.id))
          .for("update");

        if (linkedCarts.length === 0) {
          return { deleted: {} };
        }

        const now = deps.clock.now();
        for (const row of linkedCarts) {
          const matchesCheckout =
            row.checkoutOrderId === entity.id || row.checkoutOrderPublicId === entity.publicId;
          const matchesAddOn = row.addToOrderPublicId === entity.publicId;
          await tx
            .update(carts)
            .set({
              ...(matchesAddOn ? { addToOrderPublicId: null } : {}),
              ...(matchesCheckout
                ? {
                    checkoutOrderId: null,
                    checkoutOrderPublicId: null,
                    checkoutOrderReference: null,
                  }
                : {}),
              version: sql`${carts.version} + 1`,
              updatedAt: now,
            })
            .where(eq(carts.id, row.id));
        }

        return { deleted: { cartOrderLinks: linkedCarts.length } };
      });
    },
  };
}
