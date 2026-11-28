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
import { isLiveOrderRow } from "../orders/trashGate.js";
import type {
  TrashEntityRef,
  TrashParticipant,
  TrashPurgeResult,
  TrashPurgeRun,
} from "../trash/ports.js";
import { cartItems, carts, type CartRow } from "./schema.js";

function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errno?: unknown; cause?: unknown };
  if (e.code === "ER_NO_SUCH_TABLE" || e.errno === 1146) return true;
  if (e.cause && typeof e.cause === "object") {
    const c = e.cause as { code?: unknown; errno?: unknown };
    return c.code === "ER_NO_SUCH_TABLE" || c.errno === 1146;
  }
  return false;
}

/**
 * Returns `true` iff a checked-out cart still points to a live (neither trashed nor tombstoned) order.
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
  try {
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
  } catch (err) {
    if (isMissingTableError(err)) return true;
    throw err;
  }
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
