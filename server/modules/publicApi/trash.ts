/**
 * Public API v1 Trash & Permanent Deletion integration (Increment 09, D2.2 / D2.5 / D2.6 / D2.8).
 *
 * - Gateway-level visibility gate: trashed and tombstoned orders and customers answer 404 on single-item,
 *   nested, and mutation endpoints, and are absent from list endpoints across `/api/v1`.
 * - Key lifecycle: when a customer is trashed, any API keys created for/by that account are immediately revoked;
 *   when the customer is permanently deleted, those API keys and their nonces/rate-windows/idempotency records
 *   are revoked and erased, and encrypted request/response/replay payloads referencing the purged order or
 *   customer are scrubbed.
 */
import { and, count, eq, inArray, isNotNull, like, or, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { notFound } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import type { DbOrTx } from "../../core/types.js";
import { isLiveUserRow, isTrashedUserInTx } from "../identity/live.js";
import { users } from "../identity/schema.js";
import { orders } from "../orders/schema.js";
import { isLiveOrderRow } from "../orders/trashGate.js";
import type { TrashEntityRef, TrashParticipant, TrashPurgeResult } from "../trash/ports.js";
import type {
  ApiCaller,
  ApiListQuery,
  ApiPage,
  CustomerDto,
  InvoiceDto,
  OrderDto,
  ProviderKey,
  PublicApiProviders,
  TicketDto,
} from "./ports.js";
import {
  apiIdempotency,
  apiKeys,
  apiRateWindows,
  apiRequestLog,
  apiSignatureNonces,
} from "./schema.js";

const MAX_FILTER_PAGES = 5;

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

export async function isKeyOwnerTrashed(db: DbOrTx, userId: number): Promise<boolean> {
  try {
    return await isTrashedUserInTx(db, userId);
  } catch (err) {
    if (isMissingTableError(err)) return false;
    throw err;
  }
}

export async function isNonLiveCustomerPublicId(
  db: DbOrTx,
  publicId: string,
): Promise<boolean> {
  if (!ULID_PATTERN.test(publicId)) return false;
  try {
    const [row] = await db
      .select({ trashedAt: users.trashedAt, purgedAt: users.purgedAt })
      .from(users)
      .where(eq(users.publicId, publicId))
      .limit(1);
    return row ? !isLiveUserRow(row) : false;
  } catch (err) {
    if (isMissingTableError(err)) return false;
    throw err;
  }
}

export async function findNonLiveCustomerPublicIds(
  db: DbOrTx,
  publicIds: readonly string[],
): Promise<Set<string>> {
  const valid = [...new Set(publicIds.filter((id) => ULID_PATTERN.test(id)))];
  if (valid.length === 0) return new Set();
  try {
    const rows = await db
      .select({
        publicId: users.publicId,
        trashedAt: users.trashedAt,
        purgedAt: users.purgedAt,
      })
      .from(users)
      .where(inArray(users.publicId, valid));
    const out = new Set<string>();
    for (const row of rows) {
      if (!isLiveUserRow(row)) out.add(row.publicId);
    }
    return out;
  } catch (err) {
    if (isMissingTableError(err)) return new Set();
    throw err;
  }
}

export async function isNonLiveOrderPublicId(
  db: DbOrTx,
  publicId: string,
): Promise<boolean> {
  if (!ULID_PATTERN.test(publicId)) return false;
  try {
    const [row] = await db
      .select({
        orderTrashedAt: orders.trashedAt,
        orderPurgedAt: orders.purgedAt,
        ownerTrashedAt: users.trashedAt,
        ownerPurgedAt: users.purgedAt,
      })
      .from(orders)
      .leftJoin(users, eq(users.id, orders.ownerUserId))
      .where(eq(orders.publicId, publicId))
      .limit(1);
    if (!row) return false;
    if (!isLiveOrderRow({ trashedAt: row.orderTrashedAt, purgedAt: row.orderPurgedAt })) {
      return true;
    }
    if (
      (row.ownerTrashedAt !== null || row.ownerPurgedAt !== null) &&
      !isLiveUserRow({ trashedAt: row.ownerTrashedAt, purgedAt: row.ownerPurgedAt })
    ) {
      return true;
    }
    return false;
  } catch (err) {
    if (isMissingTableError(err)) return false;
    throw err;
  }
}

export async function findNonLiveOrderPublicIds(
  db: DbOrTx,
  publicIds: readonly string[],
): Promise<Set<string>> {
  const valid = [...new Set(publicIds.filter((id) => ULID_PATTERN.test(id)))];
  if (valid.length === 0) return new Set();
  try {
    const rows = await db
      .select({
        publicId: orders.publicId,
        orderTrashedAt: orders.trashedAt,
        orderPurgedAt: orders.purgedAt,
        ownerTrashedAt: users.trashedAt,
        ownerPurgedAt: users.purgedAt,
      })
      .from(orders)
      .leftJoin(users, eq(users.id, orders.ownerUserId))
      .where(inArray(orders.publicId, valid));
    const out = new Set<string>();
    for (const row of rows) {
      const orderLive = isLiveOrderRow({
        trashedAt: row.orderTrashedAt,
        purgedAt: row.orderPurgedAt,
      });
      const ownerLive =
        row.ownerTrashedAt === null && row.ownerPurgedAt === null
          ? true
          : isLiveUserRow({ trashedAt: row.ownerTrashedAt, purgedAt: row.ownerPurgedAt });
      if (!orderLive || !ownerLive) out.add(row.publicId);
    }
    return out;
  } catch (err) {
    if (isMissingTableError(err)) return new Set();
    throw err;
  }
}

async function collectLivePage<T>(
  query: ApiListQuery,
  fetchPage: (q: ApiListQuery) => Promise<ApiPage<T>>,
  filterItems: (items: T[]) => Promise<T[]>,
): Promise<ApiPage<T>> {
  const collected: T[] = [];
  let cursor = query.cursor;
  let pages = 0;

  while (collected.length < query.limit && pages < MAX_FILTER_PAGES) {
    pages += 1;
    const remaining = query.limit - collected.length;
    const page = await fetchPage({ ...query, cursor, limit: Math.max(remaining, query.limit) });
    const live = await filterItems(page.items);
    for (const item of live) {
      if (collected.length < query.limit) {
        collected.push(item);
      }
    }
    cursor = page.nextCursor;
    if (!cursor || page.items.length === 0) {
      return { items: collected, nextCursor: null };
    }
    if (collected.length >= query.limit) {
      return { items: collected, nextCursor: cursor };
    }
  }

  return { items: collected, nextCursor: cursor };
}

export function wrapProviderWithTrashGate<K extends ProviderKey>(
  deps: Pick<ModuleDeps, "db">,
  key: K,
  provider: PublicApiProviders[K],
): PublicApiProviders[K] {
  const { db } = deps;

  if (key === "customers") {
    const p = provider as PublicApiProviders["customers"];
    const wrapped: PublicApiProviders["customers"] = {
      async list(query: ApiListQuery, caller: ApiCaller): Promise<ApiPage<CustomerDto>> {
        return collectLivePage(
          query,
          (q) => p.list(q, caller),
          async (items) => {
            const nonLive = await findNonLiveCustomerPublicIds(
              db,
              items.map((item) => item.id),
            );
            return nonLive.size === 0 ? items : items.filter((item) => !nonLive.has(item.id));
          },
        );
      },
      async get(publicId: string, caller: ApiCaller): Promise<CustomerDto | null> {
        if (await isNonLiveCustomerPublicId(db, publicId)) return null;
        return p.get(publicId, caller);
      },
    };
    return wrapped as PublicApiProviders[K];
  }

  if (key === "orders") {
    const p = provider as PublicApiProviders["orders"];
    const wrapped: PublicApiProviders["orders"] = {
      async list(query: ApiListQuery, caller: ApiCaller): Promise<ApiPage<OrderDto>> {
        if (query.filter.customerId && (await isNonLiveCustomerPublicId(db, query.filter.customerId))) {
          return { items: [], nextCursor: null };
        }
        return collectLivePage(
          query,
          (q) => p.list(q, caller),
          async (items) => {
            if (items.length === 0) return items;
            const [nonLiveOrders, nonLiveCustomers] = await Promise.all([
              findNonLiveOrderPublicIds(
                db,
                items.map((item) => item.id),
              ),
              findNonLiveCustomerPublicIds(
                db,
                items.map((item) => item.customerId),
              ),
            ]);
            if (nonLiveOrders.size === 0 && nonLiveCustomers.size === 0) return items;
            return items.filter(
              (item) => !nonLiveOrders.has(item.id) && !nonLiveCustomers.has(item.customerId),
            );
          },
        );
      },
      async get(publicId: string, caller: ApiCaller): Promise<OrderDto | null> {
        if (await isNonLiveOrderPublicId(db, publicId)) return null;
        const item = await p.get(publicId, caller);
        if (!item) return null;
        if (await isNonLiveCustomerPublicId(db, item.customerId)) return null;
        return item;
      },
      async create(input, caller, tx) {
        if (await isNonLiveCustomerPublicId(tx ?? db, input.customerId)) {
          throw notFound("CUSTOMER_NOT_FOUND", "Customer not found.");
        }
        return p.create(input, caller, tx);
      },
      async transition(publicId, input, caller) {
        if (await isNonLiveOrderPublicId(db, publicId)) {
          throw notFound("ORDER_NOT_FOUND", "Order not found.");
        }
        return p.transition(publicId, input, caller);
      },
    };
    return wrapped as PublicApiProviders[K];
  }

  if (key === "orderFiles") {
    const p = provider as PublicApiProviders["orderFiles"];
    const wrapped: PublicApiProviders["orderFiles"] = {
      async list(orderPublicId, query, caller) {
        if (await isNonLiveOrderPublicId(db, orderPublicId)) return null;
        return p.list(orderPublicId, query, caller);
      },
    };
    return wrapped as PublicApiProviders[K];
  }

  if (key === "invoices") {
    const p = provider as PublicApiProviders["invoices"];
    const wrapped: PublicApiProviders["invoices"] = {
      async list(query: ApiListQuery, caller: ApiCaller): Promise<ApiPage<InvoiceDto>> {
        if (query.filter.customerId && (await isNonLiveCustomerPublicId(db, query.filter.customerId))) {
          return { items: [], nextCursor: null };
        }
        return collectLivePage(
          query,
          (q) => p.list(q, caller),
          async (items) => {
            if (items.length === 0) return items;
            const allOrderIds = items.flatMap((item) => item.orderIds);
            const [nonLiveCustomers, nonLiveOrders] = await Promise.all([
              findNonLiveCustomerPublicIds(
                db,
                items.map((item) => item.customerId),
              ),
              findNonLiveOrderPublicIds(db, allOrderIds),
            ]);
            if (nonLiveCustomers.size === 0 && nonLiveOrders.size === 0) return items;
            return items.filter(
              (item) =>
                !nonLiveCustomers.has(item.customerId) &&
                !item.orderIds.some((oid) => nonLiveOrders.has(oid)),
            );
          },
        );
      },
      async get(publicId: string, caller: ApiCaller): Promise<InvoiceDto | null> {
        const item = await p.get(publicId, caller);
        if (!item) return null;
        if (await isNonLiveCustomerPublicId(db, item.customerId)) return null;
        if (item.orderIds.length > 0) {
          const nonLiveOrders = await findNonLiveOrderPublicIds(db, item.orderIds);
          if (nonLiveOrders.size > 0) return null;
        }
        return item;
      },
    };
    return wrapped as PublicApiProviders[K];
  }

  if (key === "tickets") {
    const p = provider as PublicApiProviders["tickets"];
    const wrapped: PublicApiProviders["tickets"] = {
      async list(query: ApiListQuery, caller: ApiCaller): Promise<ApiPage<TicketDto>> {
        if (query.filter.customerId && (await isNonLiveCustomerPublicId(db, query.filter.customerId))) {
          return { items: [], nextCursor: null };
        }
        return collectLivePage(
          query,
          (q) => p.list(q, caller),
          async (items) => {
            if (items.length === 0) return items;
            const orderIds = items
              .map((item) => item.orderId)
              .filter((oid): oid is string => typeof oid === "string");
            const [nonLiveCustomers, nonLiveOrders] = await Promise.all([
              findNonLiveCustomerPublicIds(
                db,
                items.map((item) => item.customerId),
              ),
              findNonLiveOrderPublicIds(db, orderIds),
            ]);
            if (nonLiveCustomers.size === 0 && nonLiveOrders.size === 0) return items;
            return items.filter(
              (item) =>
                !nonLiveCustomers.has(item.customerId) &&
                (item.orderId === null || !nonLiveOrders.has(item.orderId)),
            );
          },
        );
      },
      async get(publicId: string, caller: ApiCaller): Promise<TicketDto | null> {
        const item = await p.get(publicId, caller);
        if (!item) return null;
        if (await isNonLiveCustomerPublicId(db, item.customerId)) return null;
        if (item.orderId && (await isNonLiveOrderPublicId(db, item.orderId))) return null;
        return item;
      },
      async create(input, caller) {
        if (await isNonLiveCustomerPublicId(db, input.customerId)) {
          throw notFound("CUSTOMER_NOT_FOUND", "Customer not found.");
        }
        if (input.orderId && (await isNonLiveOrderPublicId(db, input.orderId))) {
          throw notFound("ORDER_NOT_FOUND", "Order not found.");
        }
        return p.create(input, caller);
      },
    };
    return wrapped as PublicApiProviders[K];
  }

  return provider;
}

/**
 * Checks whether a cached 2xx idempotent response body references an order or customer that has since
 * been trashed or permanently deleted so stale cached 200/201 responses never leak trashed items.
 */
export async function isStoredIdempotentResponseTrashed(
  db: DbOrTx,
  routeTemplate: string,
  responseBody: string,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(responseBody) as {
      data?: { id?: unknown; customerId?: unknown; orderId?: unknown };
    };
    const data = parsed?.data;
    if (!data || typeof data !== "object") return false;
    if (typeof data.customerId === "string" && (await isNonLiveCustomerPublicId(db, data.customerId))) {
      return true;
    }
    if (typeof data.orderId === "string" && (await isNonLiveOrderPublicId(db, data.orderId))) {
      return true;
    }
    if (
      routeTemplate.startsWith("/orders") &&
      typeof data.id === "string" &&
      (await isNonLiveOrderPublicId(db, data.id))
    ) {
      return true;
    }
    if (
      routeTemplate.startsWith("/customers") &&
      typeof data.id === "string" &&
      (await isNonLiveCustomerPublicId(db, data.id))
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function scrubRequestLogForEntityPath(
  db: DbOrTx,
  prefixPath: string,
): Promise<number> {
  const hasPayload = or(
    isNotNull(apiRequestLog.requestViewEnc),
    isNotNull(apiRequestLog.responseViewEnc),
    isNotNull(apiRequestLog.replayEnc),
    isNotNull(apiRequestLog.ipEnc),
  )!;
  const pathMatch = or(
    eq(apiRequestLog.path, prefixPath),
    like(apiRequestLog.path, `${prefixPath}/%`),
  )!;
  const [res] = await db
    .update(apiRequestLog)
    .set({
      requestViewEnc: null,
      responseViewEnc: null,
      replayEnc: null,
      ipEnc: null,
    })
    .where(and(pathMatch, hasPayload));
  return Number(res.affectedRows ?? 0);
}

export function createPublicApiTrashParticipant(
  deps: Pick<ModuleDeps, "db" | "clock">,
): TrashParticipant {
  const { db, clock } = deps;

  return {
    module: "publicApi",

    async onTrashedInTx(tx, entity: TrashEntityRef): Promise<void> {
      if (entity.kind !== "customer") return;
      const now = clock.now();
      const keyRows = await tx
        .select({ id: apiKeys.id, state: apiKeys.state })
        .from(apiKeys)
        .where(eq(apiKeys.createdByUserId, entity.id));
      if (keyRows.length === 0) return;

      const keyIds = keyRows.map((k) => k.id);
      await tx
        .update(apiKeys)
        .set({
          state: "revoked",
          signingSecretEnc: null,
          revokedAt: now,
          version: sql`${apiKeys.version} + 1`,
        })
        .where(and(inArray(apiKeys.id, keyIds), eq(apiKeys.state, "active")));
      await tx.delete(apiSignatureNonces).where(inArray(apiSignatureNonces.keyId, keyIds));
      await tx.delete(apiRateWindows).where(inArray(apiRateWindows.keyId, keyIds));
      await tx.delete(apiIdempotency).where(inArray(apiIdempotency.keyId, keyIds));
    },

    async summarize(entity: TrashEntityRef): Promise<Record<string, number>> {
      if (entity.kind !== "customer") return {};
      const [row] = await db
        .select({ cnt: count() })
        .from(apiKeys)
        .where(eq(apiKeys.createdByUserId, entity.id));
      const apiKeysCount = Number(row?.cnt ?? 0);
      return apiKeysCount > 0 ? { apiKeys: apiKeysCount } : {};
    },

    async purge(entity: TrashEntityRef): Promise<TrashPurgeResult> {
      if (entity.kind === "order") {
        const scrubbed = await scrubRequestLogForEntityPath(db, `/orders/${entity.publicId}`);
        return {
          deleted: scrubbed > 0 ? { apiRequestPayloads: scrubbed } : {},
        };
      }

      const now = clock.now();
      const keyRows = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.createdByUserId, entity.id));

      let deletedKeys = 0;
      let scrubbedLogs = 0;

      if (keyRows.length > 0) {
        const keyIds = keyRows.map((k) => k.id);
        await db
          .update(apiKeys)
          .set({
            state: "revoked",
            signingSecretEnc: null,
            revokedAt: now,
            version: sql`${apiKeys.version} + 1`,
          })
          .where(inArray(apiKeys.id, keyIds));

        await db.delete(apiSignatureNonces).where(inArray(apiSignatureNonces.keyId, keyIds));
        await db.delete(apiRateWindows).where(inArray(apiRateWindows.keyId, keyIds));
        await db.delete(apiIdempotency).where(inArray(apiIdempotency.keyId, keyIds));

        const [logRes] = await db
          .update(apiRequestLog)
          .set({
            keyId: null,
            keyPublicId: null,
            requestViewEnc: null,
            responseViewEnc: null,
            replayEnc: null,
            ipEnc: null,
          })
          .where(inArray(apiRequestLog.keyId, keyIds));
        scrubbedLogs += Number(logRes.affectedRows ?? 0);

        const [delRes] = await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
        deletedKeys = Number(delRes.affectedRows ?? 0);
      }

      scrubbedLogs += await scrubRequestLogForEntityPath(db, `/customers/${entity.publicId}`);

      return {
        deleted: {
          ...(deletedKeys > 0 ? { apiKeys: deletedKeys } : {}),
          ...(scrubbedLogs > 0 ? { apiRequestPayloads: scrubbedLogs } : {}),
        },
      };
    },
  };
}
