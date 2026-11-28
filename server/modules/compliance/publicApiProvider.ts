import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError, validation } from "../../core/errors.js";
import { liveUserPredicate } from "../identity/live.js";
import { users } from "../identity/schema.js";
import { liveOrderIdPredicate } from "../orders/trashGate.js";
import type { ApiCaller, ApiListQuery, ApiPage, InvoiceDto, PublicApiProviders } from "../publicApi/ports.js";
import { decodeIdCursor, deriveInvoiceStatus, encodeIdCursor } from "./domain.js";
import {
  complianceInvoicePayments,
  complianceInvoiceRefunds,
  complianceInvoices,
  INVOICE_STATUSES,
  type InvoiceStatus,
} from "./schema.js";

function isInvoiceStatus(value: string): value is InvoiceStatus {
  return (INVOICE_STATUSES as readonly string[]).includes(value);
}

export function createInvoicesPublicApiProvider(
  deps: ModuleDeps,
): PublicApiProviders["invoices"] {
  function requireOrdersService() {
    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if (!ordersSvc) {
      throw new DomainError("UNAVAILABLE", "ORDERS_UNAVAILABLE", "Order service is temporarily unavailable.");
    }
    return ordersSvc;
  }

  async function hydrateDtos(rows: (typeof complianceInvoices.$inferSelect)[]): Promise<InvoiceDto[]> {
    if (rows.length === 0) return [];
    const ordersSvc = requireOrdersService();
    const invoiceIds = rows.map((r) => r.id);

    const [payments, refunds] = await Promise.all([
      deps.db
        .select({
          invoiceId: complianceInvoicePayments.invoiceId,
          status: complianceInvoicePayments.status,
          amountMinor: complianceInvoicePayments.amountMinor,
          receivedAt: complianceInvoicePayments.receivedAt,
        })
        .from(complianceInvoicePayments)
        .where(inArray(complianceInvoicePayments.invoiceId, invoiceIds)),
      deps.db
        .select({
          invoiceId: complianceInvoiceRefunds.invoiceId,
          amountMinor: complianceInvoiceRefunds.amountMinor,
        })
        .from(complianceInvoiceRefunds)
        .where(inArray(complianceInvoiceRefunds.invoiceId, invoiceIds)),
    ]);

    const sumsByInvoiceId = new Map<
      number,
      { grossPaidMinor: number; refundedMinor: number; latestPaidAt: Date | null }
    >();
    for (const id of invoiceIds) {
      sumsByInvoiceId.set(id, { grossPaidMinor: 0, refundedMinor: 0, latestPaidAt: null });
    }
    for (const p of payments) {
      if (p.status !== "succeeded") continue;
      const entry = sumsByInvoiceId.get(p.invoiceId);
      if (!entry) continue;
      entry.grossPaidMinor += p.amountMinor;
      if (!entry.latestPaidAt || p.receivedAt.getTime() > entry.latestPaidAt.getTime()) {
        entry.latestPaidAt = p.receivedAt;
      }
    }
    for (const r of refunds) {
      const entry = sumsByInvoiceId.get(r.invoiceId);
      if (entry) entry.refundedMinor += r.amountMinor;
    }

    const ownerUserIdByOrderId = new Map<number, number>();
    const uniqueOrderIds = Array.from(new Set(rows.map((r) => r.orderId)));
    for (const orderId of uniqueOrderIds) {
      const ref = typeof ordersSvc.getOrderRefById === "function" ? await ordersSvc.getOrderRefById(orderId) : null;
      if (ref) ownerUserIdByOrderId.set(orderId, ref.ownerUserId);
    }

    const uniqueOwnerIds = Array.from(new Set(ownerUserIdByOrderId.values()));
    const userRows =
      uniqueOwnerIds.length > 0
        ? await deps.db
            .select({ id: users.id, publicId: users.publicId })
            .from(users)
            .where(and(inArray(users.id, uniqueOwnerIds), liveUserPredicate()))
        : [];
    const userPublicIdById = new Map(userRows.map((u) => [u.id, u.publicId]));

    const result: InvoiceDto[] = [];
    for (const inv of rows) {
      const ownerId = ownerUserIdByOrderId.get(inv.orderId);
      const customerPublicId = ownerId !== undefined ? userPublicIdById.get(ownerId) : undefined;
      if (!customerPublicId) continue;

      const sums = sumsByInvoiceId.get(inv.id) ?? {
        grossPaidMinor: 0,
        refundedMinor: 0,
        latestPaidAt: null,
      };
      const derivedStatus = deriveInvoiceStatus({
        issuedAt: inv.issuedAt,
        voidedAt: inv.voidedAt,
        totalMinor: inv.totalMinor,
        grossPaidMinor: sums.grossPaidMinor,
        refundedMinor: sums.refundedMinor,
      });
      const netPaidMinor = Math.max(0, sums.grossPaidMinor - sums.refundedMinor);
      const amountDueMinor =
        derivedStatus === "void" || derivedStatus === "draft"
          ? 0
          : Math.max(0, inv.totalMinor - netPaidMinor);

      result.push({
        id: inv.publicId,
        number: inv.invoiceNumber ?? `DRAFT-${inv.publicId.slice(-8)}`,
        customerId: customerPublicId,
        orderIds: [inv.orderPublicId],
        status: derivedStatus,
        currency: inv.currency,
        totalMinor: inv.totalMinor,
        amountDueMinor,
        issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
        dueAt: inv.dueAt ? inv.dueAt.toISOString() : null,
        paidAt: derivedStatus === "paid" && sums.latestPaidAt ? sums.latestPaidAt.toISOString() : null,
      });
    }
    return result;
  }

  async function resolveCustomerOrderIds(customerPublicId: string): Promise<number[]> {
    const [customer] = await deps.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.publicId, customerPublicId), liveUserPredicate()))
      .limit(1);
    if (!customer) return [];

    const ordersSvc = requireOrdersService();
    const orderIds: number[] = [];
    let after: number | undefined;
    for (let page = 0; page < 25; page += 1) {
      const batch = await ordersSvc.portableOrders(deps.db, {
        customerIds: [customer.id],
        limit: 200,
        ...(after !== undefined ? { after } : {}),
      });
      for (const item of batch.items) {
        if (!item.trash) orderIds.push(item.id);
      }
      if (batch.nextAfter === null) break;
      after = batch.nextAfter;
    }
    return orderIds;
  }

  return {
    async list(query: ApiListQuery, _caller: ApiCaller): Promise<ApiPage<InvoiceDto>> {
      const limit = Math.min(Math.max(query.limit, 1), 100);
      const afterId = query.cursor ? decodeIdCursor(query.cursor) : null;
      if (query.cursor && afterId === null) {
        throw validation("INVALID_CURSOR", "Invalid pagination cursor.");
      }

      const conds = [liveOrderIdPredicate(complianceInvoices.orderId)];
      if (afterId !== null) conds.push(lt(complianceInvoices.id, afterId));
      if (query.updatedSince) conds.push(gte(complianceInvoices.updatedAt, query.updatedSince));

      const statusFilter = query.filter.status;
      if (statusFilter !== undefined && statusFilter !== "") {
        if (!isInvoiceStatus(statusFilter)) {
          throw validation("INVALID_STATUS_FILTER", "Unsupported invoice status filter.");
        }
        conds.push(eq(complianceInvoices.status, statusFilter));
      }

      const customerFilter = query.filter.customerId;
      if (customerFilter !== undefined && customerFilter !== "") {
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(customerFilter)) {
          throw validation("INVALID_CUSTOMER_ID", "Customer filter must be a 26-character ULID.");
        }
        const orderIds = await resolveCustomerOrderIds(customerFilter);
        if (orderIds.length === 0) {
          return { items: [], nextCursor: null };
        }
        conds.push(inArray(complianceInvoices.orderId, orderIds));
      }

      const rows = await deps.db
        .select()
        .from(complianceInvoices)
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(complianceInvoices.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const slice = hasMore ? rows.slice(0, limit) : rows;
      const items = await hydrateDtos(slice);

      return {
        items,
        nextCursor: hasMore && slice.length > 0 ? encodeIdCursor(slice[slice.length - 1]!.id) : null,
      };
    },

    async get(publicId: string, _caller: ApiCaller): Promise<InvoiceDto | null> {
      const [inv] = await deps.db
        .select()
        .from(complianceInvoices)
        .where(eq(complianceInvoices.publicId, publicId))
        .limit(1);
      if (!inv) return null;
      const [dto] = await hydrateDtos([inv]);
      return dto ?? null;
    },
  };
}
