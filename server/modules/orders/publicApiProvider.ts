/**
 * Increment 04 (package H): the `orders` provider for /api/v1. The caller is a service principal (API key), never a
 * user; scopes are enforced by the public API module before these run. Lists are keyset-paginated (newest first),
 * bounded to 100, and filter only by `customerId` / `status` / `updatedSince`. Writes audit as `system` with the
 * API request id as correlation id. Transitions are allowed only where the pinned workflow lists actor `api`.
 *
 * Item `tierKey`: the product's packet tier in lowercase (`basic`, `standard`, `premium`), or `default` for
 * products without a tier; a mismatch is refused so an integration never orders a different tier by accident.
 */
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { DomainError, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import type { Db } from "../../core/types.js";
import type { Services } from "../../container.js";
import type { CatalogService } from "./catalog.js";
import { decodeCursor, encodeCursor, type OrderService } from "./orderService.js";
import { identityPort } from "./ports.js";
import { orderLineItems, orders } from "./schema.js";
import type { WorkflowService } from "./workflows.js";
import { findState } from "./workflowTypes.js";

/** Structural copies of the public API port types (features never import each other's internals). */
interface ApiCaller {
  kind: "api_key";
  keyPublicId: string;
  scopes: readonly string[];
  requestId: string;
  replay: boolean;
  idempotencyKey?: string;
}
interface ApiListQuery {
  cursor: string | null;
  limit: number;
  updatedSince?: Date;
  filter: Record<string, string>;
}
export interface OrderApiDto {
  id: string;
  reference: string;
  customerId: string;
  status: { key: string; label: string };
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  items: { packetNumber: number | null; tier: string | null; name: string }[];
  version: number;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  closedAt: string | null;
}

export interface OrdersApiProviderDeps {
  db: Db;
  services: Services;
  workflows: WorkflowService;
  catalog: CatalogService;
  orders: OrderService;
}

const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, ".000Z");

export function createOrdersApiProvider(deps: OrdersApiProviderDeps) {
  async function toDtos(rows: (typeof orders.$inferSelect)[]): Promise<OrderApiDto[]> {
    if (rows.length === 0) return [];
    const lines = await deps.db
      .select({ orderId: orderLineItems.orderId, packetNumber: orderLineItems.packetNumber, tier: orderLineItems.tier, name: orderLineItems.name, sortOrder: orderLineItems.sortOrder })
      .from(orderLineItems)
      .where(inArray(orderLineItems.orderId, rows.map((row) => row.id)));
    const identity = identityPort(deps.services);
    const owners = new Map<number, string>();
    const out: OrderApiDto[] = [];
    for (const row of rows) {
      if (!owners.has(row.ownerUserId)) owners.set(row.ownerUserId, (await identity.getUser(row.ownerUserId))?.publicId ?? "");
      const bound = await deps.workflows.byVersionId(deps.db, row.workflowVersionId);
      const state = findState(bound.definition, row.statusKey);
      out.push({
        id: row.publicId,
        reference: row.reference,
        customerId: owners.get(row.ownerUserId)!,
        status: { key: row.statusKey, label: state?.customerLabel ?? row.statusKey },
        currency: row.currency,
        subtotalMinor: row.subtotalMinor,
        discountMinor: row.discountMinor,
        totalMinor: row.totalMinor,
        items: lines
          .filter((line) => line.orderId === row.id)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .slice(0, 200)
          .map((line) => ({ packetNumber: line.packetNumber, tier: line.tier, name: line.name })),
        version: row.version,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
        submittedAt: row.submittedAt ? iso(row.submittedAt) : null,
        closedAt: state?.kind === "terminal" ? iso(row.updatedAt) : null,
      });
    }
    return out;
  }

  async function getDto(publicId: string): Promise<OrderApiDto | null> {
    if (!ULID_PATTERN.test(publicId)) return null;
    const [row] = await deps.db.select().from(orders).where(eq(orders.publicId, publicId)).limit(1);
    return row ? (await toDtos([row]))[0]! : null;
  }

  return {
    async list(query: ApiListQuery, _caller: ApiCaller) {
      const limit = Math.min(Math.max(query.limit, 1), 100);
      let before: number | null;
      try {
        before = decodeCursor(query.cursor);
      } catch {
        throw validation("INVALID_CURSOR", "The cursor is not valid.");
      }
      let ownerId: number | undefined;
      if (query.filter.customerId) {
        const owner = ULID_PATTERN.test(query.filter.customerId) ? await identityPort(deps.services).getUserByPublicId(query.filter.customerId) : null;
        if (!owner || owner.role !== "customer") return { items: [], nextCursor: null };
        ownerId = owner.id;
      }
      const status = query.filter.status;
      if (status !== undefined && !/^[a-z][a-z0-9_]{1,47}$/.test(status)) throw validation("INVALID_FILTER", "The status filter is not valid.");
      const rows = await deps.db
        .select()
        .from(orders)
        .where(
          and(
            ownerId !== undefined ? eq(orders.ownerUserId, ownerId) : undefined,
            status ? eq(orders.statusKey, status) : undefined,
            query.updatedSince ? gte(orders.updatedAt, query.updatedSince) : undefined,
            before !== null ? lt(orders.id, before) : undefined,
          ),
        )
        .orderBy(desc(orders.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      return { items: await toDtos(page), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null };
    },

    get: (publicId: string, _caller: ApiCaller) => getDto(publicId),

    async create(input: { customerId: string; items: { productId: string; tierKey: string; quantity: number }[]; customerNote?: string }, caller: ApiCaller) {
      const products = new Map((await deps.catalog.listActive()).flatMap((group) => group.products).map((product) => [product.publicId, product]));
      for (const item of input.items) {
        const product = products.get(item.productId);
        if (!product) throw validation("PRODUCT_UNAVAILABLE", "One of the products is not available.");
        const expected = product.tier ? product.tier.toLowerCase() : "default";
        if (item.tierKey.toLowerCase() !== expected) throw validation("TIER_MISMATCH", `Product ${item.productId} is offered as tier “${expected}”.`);
      }
      const key = (caller.idempotencyKey ?? caller.requestId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 72);
      const created = await deps.orders.createAsSystem({
        ownerPublicId: input.customerId,
        projectName: "API order",
        items: input.items.map((item) => ({ productPublicId: item.productId, quantity: item.quantity })),
        ...(input.customerNote?.trim() ? { note: input.customerNote.trim() } : {}),
        idempotencyKey: `api_${key}`.padEnd(16, "0"),
        correlationId: caller.requestId,
      });
      const dto = await getDto(created.publicId);
      if (!dto) throw new DomainError("UNAVAILABLE", "ORDER_UNAVAILABLE", "The order could not be read back.");
      return dto;
    },

    async transition(publicId: string, input: { toStatusKey: string; expectedVersion: number; note?: string }, caller: ApiCaller) {
      if (!ULID_PATTERN.test(publicId)) throw notFound("ORDER_NOT_FOUND");
      await deps.orders.transitionAsSystem({
        orderPublicId: publicId,
        expectedVersion: input.expectedVersion,
        toStatus: input.toStatusKey,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        correlationId: caller.requestId,
      });
      const dto = await getDto(publicId);
      if (!dto) throw notFound("ORDER_NOT_FOUND");
      return dto;
    },
  };
}
