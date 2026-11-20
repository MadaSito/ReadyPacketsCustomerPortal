/**
 * The order access policy — the resource-authorization authority for orders and everything attached to
 * them (files, messages, intake, invoices). Re-evaluated from the database on EVERY call; no caching.
 */
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import { DomainError, notFound } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import type { AuditEmitter, Clock, DbOrTx, SessionPrincipal } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { orderGrants, orders } from "./schema.js";
import type {
  AccessibleOrderIds,
  AccessOptions,
  OrderAccessRole,
  OrderAccessView,
  OrderLockState,
  OrderWriteKind,
} from "./types.js";

export const ORDER_NOT_FOUND = () => notFound("ORDER_NOT_FOUND");

export const orderLocked = (lockState: OrderLockState) =>
  new DomainError("LOCKED", "ORDER_LOCKED", "This order is locked and cannot be changed right now.", { lockState });

interface PolicyDeps {
  db: DbOrTx;
  clock: Clock;
  audit: AuditEmitter;
}

type OrderKey = { publicId: string } | { id: number };

async function loadOrder(db: DbOrTx, key: OrderKey, forUpdate: boolean) {
  const query = db
    .select({
      id: orders.id,
      publicId: orders.publicId,
      reference: orders.reference,
      ownerUserId: orders.ownerUserId,
      ownerPublicId: users.publicId,
      statusKey: orders.statusKey,
      lockState: orders.lockState,
      origin: orders.origin,
      version: orders.version,
      workflowVersionId: orders.workflowVersionId,
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.ownerUserId))
    .where("publicId" in key ? eq(orders.publicId, key.publicId) : eq(orders.id, key.id))
    .limit(1);
  const rows = forUpdate ? await query.for("update") : await query;
  return rows[0] ?? null;
}

/** Current, accepted, unrevoked grant for (order, user) — or null. */
export async function currentGrant(db: DbOrTx, orderId: number, userId: number, now: Date) {
  const [grant] = await db
    .select({ id: orderGrants.id, role: orderGrants.role })
    .from(orderGrants)
    .where(
      and(
        eq(orderGrants.orderId, orderId),
        eq(orderGrants.granteeUserId, userId),
        eq(orderGrants.status, "active"),
        or(isNull(orderGrants.expiresAt), gt(orderGrants.expiresAt, now)),
      ),
    )
    .limit(1);
  return grant ?? null;
}

function isFull(principal: SessionPrincipal): boolean {
  return principal.state === "full" && principal.pendingSteps.length === 0;
}

const has = (principal: SessionPrincipal, capability: Capability) => roleHasCapability(principal.role, capability);

/** Lock matrix (writes only). Returns true when the write is blocked. */
export function lockBlocks(lockState: OrderLockState, staffSide: boolean, kind: OrderWriteKind): boolean {
  switch (lockState) {
    case "none":
      return false;
    case "review":
      return !staffSide;
    case "finalized":
      return !staffSide || !(kind === "status" || kind === "invoice");
    case "legal_hold":
    case "imported_read_only":
      return true;
  }
}

const STAFF_WRITE_CAPABILITY: Record<OrderWriteKind, Capability> = {
  order: "orders.manage",
  sharing: "orders.manage",
  file: "files.manage",
  message: "orders.manage",
  intake: "orders.manage",
  invoice: "invoices.manage",
  status: "orders.transition",
};

export function createOrderPolicy(deps: PolicyDeps) {
  async function deny(principal: SessionPrincipal, reasonCode: string, orderPublicId: string | null, action: string) {
    try {
      await deps.audit.record({
        category: "security",
        eventName: "authz.order.denied",
        action,
        outcome: "denied",
        severity: "WARN",
        reasonCode,
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "order", publicId: orderPublicId && ULID_PATTERN.test(orderPublicId) ? orderPublicId : null },
      });
    } catch {
      // The request is refused regardless; a denial performs no write that needs audit atomicity.
    }
  }

  async function resolve(principal: SessionPrincipal, key: OrderKey, options: AccessOptions, action: string) {
    const label = "publicId" in key ? key.publicId : null;
    if (!isFull(principal)) {
      await deny(principal, "REMEDIATION_SESSION", label, action);
      throw ORDER_NOT_FOUND();
    }
    if ("publicId" in key && (typeof key.publicId !== "string" || !ULID_PATTERN.test(key.publicId))) {
      throw ORDER_NOT_FOUND();
    }
    const db = options.tx ?? deps.db;
    const row = await loadOrder(db, key, options.forUpdate ?? false);
    if (!row) throw ORDER_NOT_FOUND();

    let accessRole: OrderAccessRole | null = null;
    if (principal.role === "admin" || principal.role === "staff") {
      if (has(principal, "orders.read_all")) accessRole = principal.role;
    } else if (row.ownerUserId === principal.userId) {
      accessRole = "owner";
    } else {
      const grant = await currentGrant(db, row.id, principal.userId, deps.clock.now());
      if (grant) accessRole = grant.role;
    }
    if (!accessRole) {
      await deny(principal, principal.role === "customer" ? "NOT_OWNER_OR_GRANTEE" : "CAPABILITY_NOT_GRANTED", row.publicId, action);
      throw ORDER_NOT_FOUND();
    }
    return { row, accessRole };
  }

  function toView(row: NonNullable<Awaited<ReturnType<typeof loadOrder>>>, accessRole: OrderAccessRole, principal: SessionPrincipal): OrderAccessView {
    return {
      id: row.id,
      publicId: row.publicId,
      reference: row.reference,
      ownerUserId: row.ownerUserId,
      ownerPublicId: row.ownerPublicId,
      statusKey: row.statusKey,
      lockState: row.lockState,
      locked: row.lockState !== "none",
      readOnlyImported: row.lockState === "imported_read_only",
      accessRole,
      canWrite: writeVerdict(principal, accessRole, row.lockState, "order") === null,
      origin: row.origin,
      version: row.version,
      workflowVersionId: row.workflowVersionId,
    };
  }

  /** null ⇒ allowed; otherwise the error to throw. */
  function writeVerdict(
    principal: SessionPrincipal,
    accessRole: OrderAccessRole,
    lockState: OrderLockState,
    kind: OrderWriteKind,
  ): DomainError | null {
    const staffSide = accessRole === "staff" || accessRole === "admin";
    if (staffSide) {
      if (!has(principal, STAFF_WRITE_CAPABILITY[kind])) return ORDER_NOT_FOUND();
    } else {
      if (accessRole === "viewer")
        return new DomainError("FORBIDDEN", "GRANT_READ_ONLY", "You have view-only access to this order.");
      if (kind === "invoice") return new DomainError("FORBIDDEN", "STAFF_ONLY", "You do not have permission to perform this action.");
      if ((kind === "sharing" || kind === "status") && accessRole !== "owner")
        return new DomainError("FORBIDDEN", "OWNER_ONLY", "Only the order owner can do this.");
    }
    if (lockBlocks(lockState, staffSide, kind)) return orderLocked(lockState);
    return null;
  }

  return {
    async assertCanReadOrder(principal: SessionPrincipal, orderPublicId: string, options: AccessOptions = {}): Promise<OrderAccessView> {
      const { row, accessRole } = await resolve(principal, { publicId: orderPublicId }, options, "read");
      return toView(row, accessRole, principal);
    },
    async assertCanReadOrderById(principal: SessionPrincipal, orderId: number, options: AccessOptions = {}): Promise<OrderAccessView> {
      const { row, accessRole } = await resolve(principal, { id: orderId }, options, "read");
      return toView(row, accessRole, principal);
    },
    async assertCanWriteOrder(
      principal: SessionPrincipal,
      orderPublicId: string,
      options: AccessOptions & { kind: OrderWriteKind },
    ): Promise<OrderAccessView> {
      const { row, accessRole } = await resolve(principal, { publicId: orderPublicId }, options, "write");
      const verdict = writeVerdict(principal, accessRole, row.lockState, options.kind);
      if (verdict) {
        await deny(principal, verdict.reasonCode, row.publicId, "write");
        throw verdict;
      }
      return toView(row, accessRole, principal);
    },
    async assertCanWriteOrderById(
      principal: SessionPrincipal,
      orderId: number,
      options: AccessOptions & { kind: OrderWriteKind },
    ): Promise<OrderAccessView> {
      const { row, accessRole } = await resolve(principal, { id: orderId }, options, "write");
      const verdict = writeVerdict(principal, accessRole, row.lockState, options.kind);
      if (verdict) {
        await deny(principal, verdict.reasonCode, row.publicId, "write");
        throw verdict;
      }
      return toView(row, accessRole, principal);
    },
    async listAccessibleOrderIds(principal: SessionPrincipal, options: { limit?: number; tx?: DbOrTx } = {}): Promise<AccessibleOrderIds> {
      if (!isFull(principal)) return { all: false, orderIds: [], truncated: false };
      if (principal.role !== "customer") {
        return has(principal, "orders.read_all") ? { all: true } : { all: false, orderIds: [], truncated: false };
      }
      const limit = Math.min(Math.max(options.limit ?? 500, 1), 500);
      const db = options.tx ?? deps.db;
      const owned = await db
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.ownerUserId, principal.userId))
        .orderBy(orders.id)
        .limit(limit + 1);
      const now = deps.clock.now();
      const shared = await db
        .select({ id: orderGrants.orderId })
        .from(orderGrants)
        .where(
          and(
            eq(orderGrants.granteeUserId, principal.userId),
            eq(orderGrants.status, "active"),
            or(isNull(orderGrants.expiresAt), gt(orderGrants.expiresAt, now)),
          ),
        )
        .orderBy(orderGrants.orderId)
        .limit(limit + 1);
      const ids = [...new Set([...owned.map((r) => r.id), ...shared.map((r) => r.id)])].sort((a, b) => a - b);
      return { all: false, orderIds: ids.slice(0, limit), truncated: ids.length > limit };
    },
    writeVerdict,
  };
}

export type OrderPolicy = ReturnType<typeof createOrderPolicy>;
