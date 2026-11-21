/**
 * Increment 04 item 13 — console access grants: an administrator gives another existing customer account viewer or
 * contributor access to ONE order, or to ALL current and future orders of a customer. Grants are active at once
 * (the grantee is an existing, active account found by exact e-mail; no invitation round-trip). Gated by the
 * `orders.console_access.enabled` setting (default off), admin + `orders.access.grant` + fresh persisted step-up.
 *
 * Lock order: order rows (ascending id, FOR UPDATE) → actor (users, user_sessions) → order_customer_grants →
 * order_grants. Notifications to both parties run after commit (best effort).
 */
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid, ULID_PATTERN } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, FieldCrypto, Logger, SessionPrincipal, SettingsStore, Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import { readSetting } from "../platform/index.js";
import type { ActorCheck } from "./actor.js";
import { ORDER_NOT_FOUND, type OrderPolicy } from "./policy.js";
import { engagementPort, identityPort } from "./ports.js";
import { orderCustomerGrants, orderGrants, orders, type GRANT_ROLES } from "./schema.js";
import { ORDER_CONSOLE_ACCESS_ENABLED } from "./settings.js";
import { INVITEE_INDEX_PURPOSE, MAX_LIVE_GRANTS_PER_ORDER, normalizeEmail } from "./sharing.js";

export interface AccessDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  crypto: FieldCrypto;
  settings: SettingsStore;
  logger: Logger;
  services: Services;
  policy: OrderPolicy;
  actorCheck: ActorCheck;
}

type GrantRole = (typeof GRANT_ROLES)[number];
export type AccessScope = { orderId: string } | { customerPublicId: string };

/** Upper bound of orders a customer-wide grant fans out to in one transaction. */
export const MAX_CUSTOMER_GRANT_ORDERS = 500;

export interface AccessGrantItem {
  grantId: string;
  scope: "order" | "customer";
  role: GrantRole;
  status: string;
  granteeName: string | null;
  granteeEmailMasked: string | null;
  grantedAt: string;
}

const actorOf = (principal: SessionPrincipal) => ({ userId: principal.userId, role: principal.role });
const granteeNotFound = () => validation("GRANTEE_NOT_FOUND", "No active customer account other than the owner uses that e-mail address.");

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${domain}`;
}

interface FindByEmail {
  (email: string, opts?: { tx?: Tx }): Promise<{ userId: number; publicId: string; role: string; status: string } | null>;
}
interface SearchCustomers {
  (principal: SessionPrincipal, input: { query?: string; status?: string; limit?: number }): Promise<{ items: { publicId: string; name: string; email: string; customerRef: string | null; status: string; role: string }[] }>;
}

export function createAccessService(deps: AccessDeps) {
  const indexOf = (email: string) => deps.crypto.blindIndex(email, INVITEE_INDEX_PURPOSE);

  function identityMethod<T>(name: string): T {
    const holder = (deps.services as Partial<Services>).identity as unknown as Record<string, unknown> | undefined;
    const fn = holder?.[name];
    if (typeof fn !== "function") throw new DomainError("UNAVAILABLE", "IDENTITY_UNAVAILABLE", "This action is temporarily unavailable. Please try again later.");
    return (fn as (...args: unknown[]) => unknown).bind(holder) as T;
  }

  async function assertEnabled(tx?: Tx) {
    if (!(await readSetting(deps.settings, ORDER_CONSOLE_ACCESS_ENABLED, tx)))
      throw new DomainError("FORBIDDEN", "FEATURE_DISABLED", "Console access grants are switched off in Settings.");
  }

  function assertAdmin(principal: SessionPrincipal) {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) throw ORDER_NOT_FOUND();
    if (principal.role !== "admin" || !roleHasCapability(principal.role, "orders.access.grant")) throw forbidden("CAPABILITY_NOT_GRANTED");
  }

  async function resolveGrantee(email: string, ownerUserId: number, tx: Tx) {
    const normalized = normalizeEmail(email);
    const found = await identityMethod<FindByEmail>("findUserIdByEmail")(normalized, { tx });
    if (!found || found.role !== "customer" || found.status !== "active" || found.userId === ownerUserId) throw granteeNotFound();
    return { userId: found.userId, publicId: found.publicId, email: normalized };
  }

  /** Inserts an ACTIVE order grant unless the grantee already has a live one. Returns the new publicId or null. */
  async function insertOrderGrant(tx: Tx, input: { orderId: number; granteeUserId: number; email: string; role: GrantRole; grantedBy: number | null; customerGrantId: number | null; now: Date }) {
    const emailIndex = indexOf(input.email);
    const live = await tx
      .select({ id: orderGrants.id, emailIndex: orderGrants.inviteeEmailIndex, granteeUserId: orderGrants.granteeUserId })
      .from(orderGrants)
      .where(and(eq(orderGrants.orderId, input.orderId), inArray(orderGrants.status, ["pending", "active"])))
      .for("update");
    if (live.some((grant) => grant.emailIndex === emailIndex || grant.granteeUserId === input.granteeUserId)) return null;
    if (live.length >= MAX_LIVE_GRANTS_PER_ORDER) throw validation("TOO_MANY_GRANTS", "This order has reached the sharing limit.");
    const publicId = ulid(input.now.getTime());
    await tx.insert(orderGrants).values({
      publicId,
      orderId: input.orderId,
      inviteeEmailIndex: emailIndex,
      inviteeEmailEnc: deps.crypto.encrypt(input.email, `order_grants.invitee_email:${publicId}`),
      granteeUserId: input.granteeUserId,
      role: input.role,
      status: "active",
      liveKey: `${input.orderId}:${emailIndex}`,
      grantedByUserId: input.grantedBy,
      acceptedAt: input.now,
      customerGrantId: input.customerGrantId,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return publicId;
  }

  async function notifyBoth(input: { ownerUserId: number; granteeUserId: number; granted: boolean; role: GrantRole; label: string; link: string; key: string }) {
    const engagement = engagementPort(deps.services);
    if (!engagement) return;
    try {
      const verb = input.granted ? "now has" : "no longer has";
      await engagement.notify({
        userId: input.ownerUserId,
        kind: input.granted ? "order.access_granted" : "order.access_revoked",
        title: input.granted ? "Access to your orders was shared" : "Shared access was removed",
        body: `Our team changed who can see ${input.label}: another account ${verb} ${input.role} access.`,
        link: input.link,
        idempotencyKey: `${input.key}:owner`,
        skipEmail: true,
      });
      await engagement.notify({
        userId: input.granteeUserId,
        kind: input.granted ? "order.access_granted" : "order.access_revoked",
        title: input.granted ? "You were given access to an order" : "Your access to an order was removed",
        body: input.granted ? `You now have ${input.role} access to ${input.label}.` : `You no longer have access to ${input.label}.`,
        link: input.granted ? input.link : "/orders",
        idempotencyKey: `${input.key}:grantee`,
        skipEmail: true,
      });
    } catch (error) {
      deps.logger.warn("access notification failed", { errorName: error instanceof Error ? error.name : "unknown" });
    }
  }

  async function lockCustomerOrders(tx: Tx, ownerUserId: number) {
    const rows = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.ownerUserId, ownerUserId))
      .orderBy(asc(orders.id))
      .limit(MAX_CUSTOMER_GRANT_ORDERS + 1)
      .for("update");
    if (rows.length > MAX_CUSTOMER_GRANT_ORDERS) throw validation("TOO_MANY_ORDERS", "This customer has too many orders for a customer-wide grant. Grant access per order instead.");
    return rows.map((row) => row.id);
  }

  async function activeCustomer(publicId: string, tx?: Tx) {
    if (!ULID_PATTERN.test(publicId)) throw notFound("CUSTOMER_NOT_FOUND");
    const user = await identityPort(deps.services).getUserByPublicId(publicId, { tx });
    if (!user || user.role !== "customer" || user.status !== "active") throw notFound("CUSTOMER_NOT_FOUND");
    return user;
  }

  return {
    /** Customer picker for console actions (staff + customers.read_all, enforced by identity as well). */
    async customerLookup(principal: SessionPrincipal, input: { query: string }) {
      if (principal.role === "customer" || !roleHasCapability(principal.role, "customers.read_all")) throw forbidden("CAPABILITY_NOT_GRANTED");
      const page = await identityMethod<SearchCustomers>("searchCustomers")(principal, { query: input.query, status: "active", limit: 20 });
      return page.items
        .filter((item) => item.role === "customer" && item.status === "active")
        .slice(0, 20)
        .map((item) => ({ publicId: item.publicId, name: item.name, customerRef: item.customerRef, emailMasked: maskEmail(item.email) }));
    },

    async list(principal: SessionPrincipal, input: AccessScope): Promise<{ items: AccessGrantItem[] }> {
      if (principal.role === "customer" || !roleHasCapability(principal.role, "orders.read_all")) throw ORDER_NOT_FOUND();
      const identity = identityPort(deps.services);
      const items: AccessGrantItem[] = [];
      if ("orderId" in input) {
        const view = await deps.policy.assertCanReadOrder(principal, input.orderId);
        const rows = await deps.db
          .select()
          .from(orderGrants)
          .where(and(eq(orderGrants.orderId, view.id), inArray(orderGrants.status, ["pending", "active"])))
          .orderBy(asc(orderGrants.id))
          .limit(MAX_LIVE_GRANTS_PER_ORDER);
        for (const row of rows) {
          const user = row.granteeUserId ? await identity.getUser(row.granteeUserId) : null;
          items.push({
            grantId: row.publicId,
            scope: row.customerGrantId ? "customer" : "order",
            role: row.role,
            status: row.status,
            granteeName: user?.name ?? null,
            granteeEmailMasked: user ? maskEmail(user.email) : null,
            grantedAt: row.createdAt.toISOString(),
          });
        }
        return { items };
      }
      const owner = await activeCustomer(input.customerPublicId);
      const rows = await deps.db
        .select()
        .from(orderCustomerGrants)
        .where(and(eq(orderCustomerGrants.ownerUserId, owner.id), eq(orderCustomerGrants.status, "active")))
        .orderBy(asc(orderCustomerGrants.id))
        .limit(50);
      for (const row of rows) {
        const user = await identity.getUser(row.granteeUserId);
        items.push({
          grantId: row.publicId,
          scope: "customer",
          role: row.role,
          status: row.status,
          granteeName: user?.name ?? null,
          granteeEmailMasked: user ? maskEmail(user.email) : null,
          grantedAt: row.createdAt.toISOString(),
        });
      }
      return { items };
    },

    async grant(principal: SessionPrincipal, input: { scope: AccessScope; email: string; role: GrantRole }) {
      assertAdmin(principal);
      const now = deps.clock.now();
      if ("orderId" in input.scope) {
        const orderPublicId = input.scope.orderId;
        const done = await deps.db.transaction(async (tx) => {
          const view = await deps.policy.assertCanReadOrder(principal, orderPublicId, { tx, forUpdate: true });
          await deps.actorCheck(principal, tx, "orders.access.grant");
          await assertEnabled(tx);
          if (view.lockState === "legal_hold") throw new DomainError("LOCKED", "ORDER_LOCKED", "This order is on legal hold.");
          const grantee = await resolveGrantee(input.email, view.ownerUserId, tx);
          const publicId = await insertOrderGrant(tx, { orderId: view.id, granteeUserId: grantee.userId, email: grantee.email, role: input.role, grantedBy: principal.userId, customerGrantId: null, now });
          if (!publicId) throw conflict("ALREADY_SHARED", "That account already has access to this order.");
          await deps.audit.record(
            {
              category: "business",
              eventName: "order.access.granted",
              action: "share",
              outcome: "completed",
              actor: actorOf(principal),
              resource: { type: "order", publicId: view.publicId },
              attributes: { grant_public_id: publicId, scope: "order", role: input.role, grantee_public_id: grantee.publicId },
            },
            tx,
          );
          return { publicId, view, grantee };
        });
        await notifyBoth({ ownerUserId: done.view.ownerUserId, granteeUserId: done.grantee.userId, granted: true, role: input.role, label: `order ${done.view.reference}`, link: `/orders/${done.view.publicId}`, key: `order.access:${done.publicId}:granted` });
        return { grantId: done.publicId, scope: "order" as const, ordersCovered: 1 };
      }
      const owner = await activeCustomer(input.scope.customerPublicId);
      const done = await deps.db.transaction(async (tx) => {
        const orderIds = await lockCustomerOrders(tx, owner.id);
        await deps.actorCheck(principal, tx, "orders.access.grant");
        await assertEnabled(tx);
        const fresh = await activeCustomer(input.scope.customerPublicId, tx);
        const grantee = await resolveGrantee(input.email, fresh.id, tx);
        const liveKey = `${fresh.id}:${grantee.userId}`;
        const [existing] = await tx.select({ id: orderCustomerGrants.id }).from(orderCustomerGrants).where(eq(orderCustomerGrants.liveKey, liveKey)).limit(1).for("update");
        if (existing) throw conflict("ALREADY_SHARED", "That account already has access to all of this customer's orders.");
        const publicId = ulid(now.getTime());
        await tx.insert(orderCustomerGrants).values({ publicId, ownerUserId: fresh.id, granteeUserId: grantee.userId, role: input.role, status: "active", liveKey, grantedByUserId: principal.userId, createdAt: now, updatedAt: now });
        const [row] = await tx.select({ id: orderCustomerGrants.id }).from(orderCustomerGrants).where(eq(orderCustomerGrants.publicId, publicId));
        let covered = 0;
        for (const orderId of orderIds) {
          if (await insertOrderGrant(tx, { orderId, granteeUserId: grantee.userId, email: grantee.email, role: input.role, grantedBy: principal.userId, customerGrantId: row!.id, now })) covered += 1;
        }
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.access.granted",
            action: "share",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "customer", publicId: fresh.publicId },
            attributes: { grant_public_id: publicId, scope: "customer", role: input.role, grantee_public_id: grantee.publicId },
            safeCounts: { orders_covered: covered },
          },
          tx,
        );
        return { publicId, grantee, covered };
      });
      await notifyBoth({ ownerUserId: owner.id, granteeUserId: done.grantee.userId, granted: true, role: input.role, label: "all of the orders on this account", link: "/orders", key: `order.access:${done.publicId}:granted` });
      return { grantId: done.publicId, scope: "customer" as const, ordersCovered: done.covered };
    },

    async revoke(principal: SessionPrincipal, input: { grantId: string }) {
      assertAdmin(principal);
      const now = deps.clock.now();
      const [customerGrant] = await deps.db.select().from(orderCustomerGrants).where(eq(orderCustomerGrants.publicId, input.grantId)).limit(1);
      if (customerGrant) {
        const done = await deps.db.transaction(async (tx) => {
          const orderIds = await lockCustomerOrders(tx, customerGrant.ownerUserId);
          await deps.actorCheck(principal, tx, "orders.access.grant");
          const [row] = await tx.select().from(orderCustomerGrants).where(eq(orderCustomerGrants.id, customerGrant.id)).for("update");
          if (!row || row.status !== "active") throw conflict("GRANT_NOT_ACTIVE", "This access has already been removed.");
          await tx.update(orderCustomerGrants).set({ status: "revoked", liveKey: null, endedAt: now, endedByUserId: principal.userId, updatedAt: now }).where(eq(orderCustomerGrants.id, row.id));
          const derived = orderIds.length
            ? await tx
                .select({ id: orderGrants.id })
                .from(orderGrants)
                .where(and(eq(orderGrants.customerGrantId, row.id), eq(orderGrants.status, "active"), inArray(orderGrants.orderId, orderIds)))
                .for("update")
            : [];
          if (derived.length)
            await tx
              .update(orderGrants)
              .set({ status: "revoked", liveKey: null, endedAt: now, endedByUserId: principal.userId, endReasonCode: "CONSOLE_REVOKED", updatedAt: now })
              .where(inArray(orderGrants.id, derived.map((grant) => grant.id)));
          const owner = await identityPort(deps.services).getUser(row.ownerUserId, { tx });
          await deps.audit.record(
            {
              category: "business",
              eventName: "order.access.revoked",
              action: "revoke",
              outcome: "completed",
              actor: actorOf(principal),
              resource: { type: "customer", publicId: owner?.publicId ?? null },
              attributes: { grant_public_id: row.publicId, scope: "customer" },
              safeCounts: { orders_revoked: derived.length },
            },
            tx,
          );
          return row;
        });
        await notifyBoth({ ownerUserId: done.ownerUserId, granteeUserId: done.granteeUserId, granted: false, role: done.role, label: "the orders on this account", link: "/orders", key: `order.access:${done.publicId}:revoked` });
        return { revoked: true as const };
      }
      const [grant] = await deps.db.select({ orderId: orderGrants.orderId }).from(orderGrants).where(eq(orderGrants.publicId, input.grantId)).limit(1);
      if (!grant) throw notFound("GRANT_NOT_FOUND");
      const done = await deps.db.transaction(async (tx) => {
        const view = await deps.policy.assertCanReadOrderById(principal, grant.orderId, { tx, forUpdate: true });
        await deps.actorCheck(principal, tx, "orders.access.grant");
        const [row] = await tx.select().from(orderGrants).where(eq(orderGrants.publicId, input.grantId)).for("update");
        if (!row || !(row.status === "active" || row.status === "pending")) throw conflict("GRANT_NOT_ACTIVE", "This access has already been removed.");
        await tx
          .update(orderGrants)
          .set({ status: "revoked", liveKey: null, endedAt: now, endedByUserId: principal.userId, endReasonCode: "CONSOLE_REVOKED", updatedAt: now })
          .where(eq(orderGrants.id, row.id));
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.access.revoked",
            action: "revoke",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "order", publicId: view.publicId },
            attributes: { grant_public_id: row.publicId, scope: row.customerGrantId ? "customer" : "order" },
          },
          tx,
        );
        return { view, row };
      });
      if (done.row.granteeUserId)
        await notifyBoth({ ownerUserId: done.view.ownerUserId, granteeUserId: done.row.granteeUserId, granted: false, role: done.row.role, label: `order ${done.view.reference}`, link: `/orders/${done.view.publicId}`, key: `order.access:${done.row.publicId}:revoked` });
      return { revoked: true as const };
    },

    /** Inside order creation: copy every active customer-wide grant of the owner onto the new order. */
    async onOrderCreated(tx: Tx, input: { orderId: number; ownerUserId: number; now: Date }): Promise<number> {
      const grants = await tx
        .select()
        .from(orderCustomerGrants)
        .where(and(eq(orderCustomerGrants.ownerUserId, input.ownerUserId), eq(orderCustomerGrants.status, "active"), isNotNull(orderCustomerGrants.liveKey)))
        .orderBy(asc(orderCustomerGrants.id))
        .limit(MAX_LIVE_GRANTS_PER_ORDER);
      let copied = 0;
      for (const grant of grants) {
        const grantee = await identityPort(deps.services).getUser(grant.granteeUserId, { tx });
        if (!grantee || grantee.role !== "customer" || grantee.status !== "active") continue;
        if (await insertOrderGrant(tx, { orderId: input.orderId, granteeUserId: grantee.id, email: normalizeEmail(grantee.email), role: grant.role, grantedBy: grant.grantedByUserId, customerGrantId: grant.id, now: input.now }))
          copied += 1;
      }
      return copied;
    },
  };
}

export type AccessService = ReturnType<typeof createAccessService>;
