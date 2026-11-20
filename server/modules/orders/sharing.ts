/**
 * Order sharing. A share is a GRANT, never ownership. Invitations are addressed to an e-mail (blind-indexed,
 * encrypted) and become effective only when a signed-in customer whose VERIFIED account e-mail matches accepts
 * it. The owner sees the same "pending" state whether or not the address belongs to an account, so sharing is
 * not an account-enumeration oracle. Revocation takes effect on the very next request (the policy re-reads
 * grants on every call).
 */
import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import { conflict, DomainError, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, FieldCrypto, Logger, SessionPrincipal, SettingsStore, Tx } from "../../core/types.js";
import { createActorCheck } from "./actor.js";
import type { Services } from "../../container.js";
import { readSetting } from "../platform/index.js";
import { ORDER_NOT_FOUND, type OrderPolicy } from "./policy.js";
import { identityPort } from "./ports.js";
import { orderGrants, orders } from "./schema.js";
import { ORDER_INVITE_TTL_DAYS } from "./settings.js";
import type { GrantRole } from "./types.js";

export interface SharingDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  crypto: FieldCrypto;
  settings: SettingsStore;
  logger: Logger;
  services: Services;
  policy: OrderPolicy;
}

export const INVITEE_INDEX_PURPOSE = "order_grants.invitee_email";
export const MAX_LIVE_GRANTS_PER_ORDER = 25;

export function normalizeEmail(raw: string): string {
  const value = raw.normalize("NFC").trim().toLowerCase();
  if (value.length < 3 || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw validation("INVALID_EMAIL", "Enter a valid e-mail address.");
  return value;
}

const actorOf = (principal: SessionPrincipal) => ({ userId: principal.userId, role: principal.role });
const grantNotFound = () => notFound("GRANT_NOT_FOUND");

export function createSharingService(deps: SharingDeps) {
  const indexOf = (email: string) => deps.crypto.blindIndex(email, INVITEE_INDEX_PURPOSE);
  const actorCheck = createActorCheck(deps.services, deps.clock);
  /** After the order row lock (canonical order: order → users → session → grants). Staff need orders.manage. */
  const assertActorCurrent = (principal: SessionPrincipal, tx: Tx, staffSide: boolean) =>
    actorCheck(principal, tx, staffSide ? "orders.manage" : undefined);
  const isStaffSide = (role: string) => role === "staff" || role === "admin";

  /** Owner, or staff/admin holding orders.manage. Revocation is allowed under locks (it only reduces access). */
  async function assertCanManage(principal: SessionPrincipal, orderPublicId: string, tx?: Tx, forUpdate = tx !== undefined) {
    const view = await deps.policy.assertCanReadOrder(principal, orderPublicId, { tx, forUpdate });
    if (view.accessRole === "owner") return view;
    if ((view.accessRole === "staff" || view.accessRole === "admin") && roleHasCapability(principal.role, "orders.manage")) return view;
    throw new DomainError("FORBIDDEN", "OWNER_ONLY", "Only the order owner can manage sharing.");
  }

  async function myVerifiedEmailIndex(principal: SessionPrincipal, tx?: Tx): Promise<string | null> {
    const user = await identityPort(deps.services).getUser(principal.userId, { tx });
    if (!user || user.status !== "active" || user.role !== "customer") return null;
    if ((user as { emailVerified?: boolean }).emailVerified !== true) return null;
    return indexOf(normalizeEmail(user.email));
  }

  return {
    async list(principal: SessionPrincipal, orderPublicId: string) {
      // Authorization and the grant projection share ONE consistent snapshot (O-02).
      const rows = await deps.db.transaction(
        async (tx) => {
          const view = await assertCanManage(principal, orderPublicId, tx, false);
          return tx
            .select()
            .from(orderGrants)
            .where(eq(orderGrants.orderId, view.id))
            .orderBy(desc(orderGrants.id))
            .limit(100);
        },
        { isolationLevel: "repeatable read", withConsistentSnapshot: true },
      );
      const now = deps.clock.now();
      return rows.map((row) => {
        let email: string | null = null;
        try {
          email = deps.crypto.decrypt(row.inviteeEmailEnc, `order_grants.invitee_email:${row.publicId}`);
        } catch {
          deps.logger.warn("grant invitee could not be decrypted", { grantPublicId: row.publicId });
        }
        const expired = row.status === "pending" && row.expiresAt !== null && row.expiresAt <= now;
        return {
          publicId: row.publicId,
          email,
          role: row.role,
          status: expired ? ("expired" as const) : row.status,
          acceptedAt: row.acceptedAt,
          endedAt: row.endedAt,
          endReasonCode: row.endReasonCode,
          createdAt: row.createdAt,
        };
      });
    },

    async invite(principal: SessionPrincipal, input: { orderId: string; email: string; role: GrantRole }) {
      const email = normalizeEmail(input.email);
      const emailIndex = indexOf(email);
      const now = deps.clock.now();
      const ttlDays = await readSetting(deps.settings, ORDER_INVITE_TTL_DAYS);
      try {
        return await deps.db.transaction(async (tx) => {
          const view = await deps.policy.assertCanWriteOrder(principal, input.orderId, { kind: "sharing", tx, forUpdate: true });
          await assertActorCurrent(principal, tx, isStaffSide(view.accessRole));
          const owner = await identityPort(deps.services).getUser(view.ownerUserId, { tx });
          if (owner && normalizeEmail(owner.email) === email) throw validation("ALREADY_OWNER", "The owner already has full access to this order.");
          // Expire stale pending invitations first so they do not block a fresh one.
          await tx
            .update(orderGrants)
            .set({ status: "declined", liveKey: null, endedAt: now, endReasonCode: "EXPIRED" })
            .where(and(eq(orderGrants.orderId, view.id), eq(orderGrants.status, "pending"), lte(orderGrants.expiresAt, now)));
          const live = await tx
            .select({ id: orderGrants.id, emailIndex: orderGrants.inviteeEmailIndex })
            .from(orderGrants)
            .where(and(eq(orderGrants.orderId, view.id), inArray(orderGrants.status, ["pending", "active"])));
          if (live.some((g) => g.emailIndex === emailIndex)) throw conflict("ALREADY_SHARED", "This address has already been invited to this order.");
          if (live.length >= MAX_LIVE_GRANTS_PER_ORDER) throw validation("TOO_MANY_GRANTS", "This order has reached the sharing limit.");
          const publicId = ulid(now.getTime());
          await tx.insert(orderGrants).values({
            publicId,
            orderId: view.id,
            inviteeEmailIndex: emailIndex,
            inviteeEmailEnc: deps.crypto.encrypt(email, `order_grants.invitee_email:${publicId}`),
            role: input.role,
            status: "pending",
            liveKey: `${view.id}:${emailIndex}`,
            grantedByUserId: principal.userId,
            expiresAt: new Date(now.getTime() + ttlDays * 86_400_000),
            createdAt: now,
            updatedAt: now,
          });
          await deps.audit.record(
            {
              category: "business",
              eventName: "order.share.invited",
              action: "share",
              outcome: "completed",
              actor: actorOf(principal),
              resource: { type: "order", publicId: view.publicId },
              attributes: { grantPublicId: publicId, role: input.role },
            },
            tx,
          );
          return { publicId, status: "pending" as const };
        });
      } catch (error) {
        if ((error as { code?: string })?.code === "ER_DUP_ENTRY" || (error as { cause?: { code?: string } })?.cause?.code === "ER_DUP_ENTRY")
          throw conflict("ALREADY_SHARED", "This address has already been invited to this order.");
        throw error;
      }
    },

    async revoke(principal: SessionPrincipal, input: { orderId: string; grantId: string }) {
      return deps.db.transaction(async (tx) => {
        const view = await assertCanManage(principal, input.orderId, tx);
        await assertActorCurrent(principal, tx, isStaffSide(view.accessRole));
        const [grant] = await tx
          .select()
          .from(orderGrants)
          .where(and(eq(orderGrants.publicId, input.grantId), eq(orderGrants.orderId, view.id)))
          .limit(1)
          .for("update");
        if (!grant) throw grantNotFound();
        if (grant.status === "revoked" || grant.status === "declined") return { status: grant.status };
        const now = deps.clock.now();
        await tx
          .update(orderGrants)
          .set({ status: "revoked", liveKey: null, endedAt: now, endedByUserId: principal.userId, endReasonCode: "REVOKED_BY_OWNER" })
          .where(eq(orderGrants.id, grant.id));
        await deps.audit.record(
          {
            category: "business",
            eventName: "order.share.revoked",
            action: "revoke",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "order", publicId: view.publicId },
            attributes: { grantPublicId: grant.publicId, previousStatus: grant.status },
          },
          tx,
        );
        return { status: "revoked" as const };
      });
    },

    /** Pending, unexpired invitations addressed to the caller's VERIFIED account e-mail. */
    async myInvitations(principal: SessionPrincipal) {
      if (principal.state !== "full" || principal.role !== "customer") return [];
      const emailIndex = await myVerifiedEmailIndex(principal);
      if (!emailIndex) return [];
      const now = deps.clock.now();
      const rows = await deps.db
        .select({ grant: orderGrants, reference: orders.reference, projectName: orders.projectName, ownerUserId: orders.ownerUserId })
        .from(orderGrants)
        .innerJoin(orders, eq(orders.id, orderGrants.orderId))
        .where(and(eq(orderGrants.inviteeEmailIndex, emailIndex), eq(orderGrants.status, "pending"), gt(orderGrants.expiresAt, now)))
        .orderBy(desc(orderGrants.id))
        .limit(50);
      return rows
        .filter((row) => row.ownerUserId !== principal.userId)
        .map((row) => ({
          publicId: row.grant.publicId,
          role: row.grant.role,
          orderReference: row.reference,
          projectName: row.projectName,
          expiresAt: row.grant.expiresAt,
          createdAt: row.grant.createdAt,
        }));
    },

    async respond(principal: SessionPrincipal, input: { grantId: string; accept: boolean }) {
      if (principal.state !== "full" || principal.role !== "customer") throw grantNotFound();
      const emailIndex = await myVerifiedEmailIndex(principal);
      if (!emailIndex) throw grantNotFound();
      return deps.db.transaction(async (tx) => {
        // Canonical lock order: order row, THEN grant row (a join FOR UPDATE could lock the grant first).
        const [located] = await tx.select({ orderId: orderGrants.orderId }).from(orderGrants).where(eq(orderGrants.publicId, input.grantId)).limit(1);
        if (!located) throw grantNotFound();
        const [order] = await tx
          .select({ orderPublicId: orders.publicId, ownerUserId: orders.ownerUserId })
          .from(orders)
          .where(eq(orders.id, located.orderId))
          .limit(1)
          .for("update");
        const [grant] = await tx
          .select()
          .from(orderGrants)
          .where(and(eq(orderGrants.publicId, input.grantId), eq(orderGrants.orderId, located.orderId)))
          .limit(1)
          .for("update");
        const row = order && grant ? { grant, ...order } : undefined;
        const now = deps.clock.now();
        if (
          !row ||
          row.grant.inviteeEmailIndex !== emailIndex ||
          row.grant.status !== "pending" ||
          (row.grant.expiresAt !== null && row.grant.expiresAt <= now) ||
          row.ownerUserId === principal.userId
        ) {
          throw grantNotFound();
        }
        // Grant + order rows are locked above; now the actor (users → session), then re-derive the verified
        // e-mail from the locked users row so a just-changed or unverified address cannot accept.
        await actorCheck(principal, tx);
        if ((await myVerifiedEmailIndex(principal, tx)) !== emailIndex) throw grantNotFound();
        await tx
          .update(orderGrants)
          .set(
            input.accept
              ? { status: "active", granteeUserId: principal.userId, acceptedAt: now, expiresAt: null }
              : { status: "declined", liveKey: null, endedAt: now, endedByUserId: principal.userId, endReasonCode: "DECLINED" },
          )
          .where(eq(orderGrants.id, row.grant.id));
        await deps.audit.record(
          {
            category: "business",
            eventName: input.accept ? "order.share.accepted" : "order.share.declined",
            action: input.accept ? "accept" : "decline",
            outcome: "completed",
            actor: actorOf(principal),
            resource: { type: "order", publicId: row.orderPublicId },
            attributes: { grantPublicId: row.grant.publicId, role: row.grant.role },
          },
          tx,
        );
        return { status: input.accept ? ("active" as const) : ("declined" as const), orderPublicId: input.accept ? row.orderPublicId : null };
      });
    },
  };
}

export type SharingService = ReturnType<typeof createSharingService>;
export { ORDER_NOT_FOUND };
