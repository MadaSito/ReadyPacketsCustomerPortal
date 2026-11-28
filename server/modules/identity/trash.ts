/**
 * Increment 09 (D2) — the customer side of the Trash centre. Owner: identity engineer.
 *
 * Trusted, in-process functions for the trash coordinator (`server/modules/trash`). They are NOT on tRPC: the
 * coordinator authorises (trash.manage / trash.purge + step-up), owns idempotency and moves the customer's orders.
 * Identity owns the `users` row: every change here locks it (FOR UPDATE) and compare-and-sets the trash columns so
 * that trash-vs-restore-vs-purge, double submits and job-vs-administrator races have exactly one winner (D2.8).
 *
 * Rules (D2.2): customers only (staff and administrators are refused as not found); trash only when suspended;
 * restore returns the account still suspended; once `purge_started_at` is set nothing restores it; the tombstone
 * (D2.6) frees the e-mail address (placeholder + fresh blind index) and erases names, password, tokens, sessions and
 * SSO links. MFA factors live in the assurance module and are erased by its own participant.
 * Audit: the coordinator records customer.trashed / customer.restored / customer.purge_started / customer.purged in
 * the same transaction (agreed with recovery_ops_engineer, so nothing is emitted twice). Identity emits none of them.
 */
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, like, lt, lte, type SQL } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import type { DbOrTx, FieldCrypto, Tx } from "../../core/types.js";
import { conflict, notFound } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { TrashActor, TrashEntityRef, TrashParticipant } from "../trash/ports.js";
import { identityTokens, IDENTITY_TOKEN_PURPOSES, ssoAuthRequests, ssoIdentities, userSessions, users, type UserRow, type UserStatus } from "./schema.js";
import type { SessionService } from "./sessions.js";
import type { TokenService } from "./tokens.js";
import { emailColumns, nameColumns } from "./users.js";

export const DELETED_ACCOUNT_NAME = "Deleted account";
export const TOMBSTONE_EMAIL_DOMAIN = "tombstone.invalid";
export const TRASH_REASON_MAX = 200;
const LIST_MAX = 1000;

export interface TrashCustomerRef {
  id: number;
  publicId: string;
  customerRef: string | null;
  status: UserStatus;
  trashedAt: Date | null;
  trashBatchId: string | null;
  purgeStartedAt: Date | null;
  purgedAt: Date | null;
}

export interface TrashedCustomerItem {
  id: number;
  publicId: string;
  customerRef: string | null;
  trashedAt: Date;
  trashedByUserId: number | null;
  trashedByPublicId: string | null;
  batchId: string | null;
  reason: string | null;
  purgeStartedAt: Date | null;
}

export interface TrashedCustomerQuery {
  limit?: number;
  cursor?: string | null;
  /** Public id of the administrator who moved it. */
  movedBy?: string;
  from?: Date;
  to?: Date;
  /** Customer ID prefix (names and e-mail addresses are encrypted and not searchable here). */
  q?: string;
  /** Only rows whose trashed_at is at or before this instant (the coordinator's "due" filter). */
  trashedBefore?: Date;
}

const refOf = (row: UserRow): TrashCustomerRef => ({
  id: row.id,
  publicId: row.publicId,
  customerRef: row.customerRef ?? null,
  status: row.status,
  trashedAt: row.trashedAt ?? null,
  trashBatchId: row.trashBatchId ?? null,
  purgeStartedAt: row.purgeStartedAt ?? null,
  purgedAt: row.purgedAt ?? null,
});


const actorUserId = (actor: TrashActor): number | null => (actor.kind === "user" ? actor.userId : null);

/** Bounded, control-free reason (the coordinator validates too; this is the owner's own guard). */
export function cleanTrashReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  const cleaned = reason.replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return [...cleaned].slice(0, TRASH_REASON_MAX).join("").slice(0, TRASH_REASON_MAX);
}

/** Non-routable, unique placeholder (RFC 2606 `.invalid`). Never derived from the old address. */
export function tombstoneEmail(now: Date): string {
  return `deleted-${ulid(now.getTime()).toLowerCase()}@${TOMBSTONE_EMAIL_DOMAIN}`;
}

/** Every personal / secret / free-text column of a tombstone (D2.6). Shared with the portable import of tombstones. */
export function tombstoneColumns(crypto: FieldCrypto, publicId: string, now: Date) {
  return {
    ...emailColumns(crypto, publicId, tombstoneEmail(now)),
    ...nameColumns(crypto, publicId, DELETED_ACCOUNT_NAME),
    nameFirstPrefixIndex: null,
    nameLastPrefixIndex: null,
    firstNameEnc: null,
    lastNameEnc: null,
    preferredNameEnc: null,
    emailVerifiedAt: null,
    passwordHash: null,
    passwordChangedAt: null,
    mustChangePassword: false,
    authSource: "local" as const,
    status: "deactivated" as const,
    statusReasonCode: "PURGED",
    statusChangedAt: now,
    trashReason: null,
    purgedAt: now,
  };
}

function encodeCursor(id: number): string {
  return Buffer.from(String(id), "utf8").toString("base64url");
}
function decodeCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function createIdentityTrash(i: { deps: ModuleDeps; sessions: SessionService; tokens: TokenService }) {
  const { deps } = i;

  /** Lock the users row (trashed and tombstoned included). Customers only: anything else answers not found. */
  async function lockCustomer(tx: Tx, userId: number): Promise<UserRow> {
    const [row] = await tx.select().from(users).where(eq(users.id, userId)).limit(1).for("update");
    if (!row || row.role !== "customer") throw notFound("CUSTOMER_NOT_FOUND");
    return row;
  }

  async function sessionAndLinkCounts(db: DbOrTx, userId: number) {
    const [s] = await db.select({ n: count() }).from(userSessions).where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
    const [l] = await db.select({ n: count() }).from(ssoIdentities).where(eq(ssoIdentities.userId, userId));
    return { sessions: s?.n ?? 0, ssoLinks: l?.n ?? 0 };
  }

  /** Erases identity-owned credentials of the account. Idempotent (a second run deletes nothing). */
  async function eraseCredentialsInTx(tx: Tx, userId: number): Promise<Record<string, number>> {
    const [t] = await tx.select({ n: count() }).from(identityTokens).where(eq(identityTokens.userId, userId));
    const [s] = await tx.select({ n: count() }).from(userSessions).where(eq(userSessions.userId, userId));
    const [l] = await tx.select({ n: count() }).from(ssoIdentities).where(eq(ssoIdentities.userId, userId));
    const [r] = await tx.select({ n: count() }).from(ssoAuthRequests).where(eq(ssoAuthRequests.userId, userId));
    await tx.delete(identityTokens).where(eq(identityTokens.userId, userId));
    await tx.delete(userSessions).where(eq(userSessions.userId, userId));
    await tx.delete(ssoIdentities).where(eq(ssoIdentities.userId, userId));
    await tx.delete(ssoAuthRequests).where(eq(ssoAuthRequests.userId, userId));
    return { tokens: t?.n ?? 0, sessions: s?.n ?? 0, ssoLinks: l?.n ?? 0, ssoRequests: r?.n ?? 0 };
  }

  const service = {
    /** Trash-path read: sees trashed and tombstoned customers. null for unknown ids and non-customers. */
    async resolveCustomerInTx(tx: DbOrTx, publicId: string): Promise<TrashCustomerRef | null> {
      const [row] = await tx.select().from(users).where(and(eq(users.publicId, publicId), eq(users.role, "customer"))).limit(1);
      return row ? refOf(row) : null;
    },

    async resolveCustomerByIdInTx(tx: DbOrTx, userId: number): Promise<TrashCustomerRef | null> {
      const [row] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.role, "customer"))).limit(1);
      return row ? refOf(row) : null;
    },

    /**
     * Move a SUSPENDED customer to the trash (inside the coordinator's transaction). Revokes every session and every
     * pending token. Same batch again → no-op (idempotent). Already in another batch → 409 ALREADY_IN_TRASH.
     */
    async trashCustomerInTx(tx: Tx, userId: number, input: { actor: TrashActor; batchId: string; reason?: string | null }): Promise<{ publicId: string; customerRef: string | null; changed: boolean; sessionsRevoked: number }> {
      const row = await lockCustomer(tx, userId);
      if (row.purgedAt) throw notFound("CUSTOMER_NOT_FOUND");
      if (row.trashedAt) {
        if (row.trashBatchId === input.batchId) return { publicId: row.publicId, customerRef: row.customerRef ?? null, changed: false, sessionsRevoked: 0 };
        throw conflict("ALREADY_IN_TRASH", "This account is already in the trash.");
      }
      if (row.status !== "suspended") throw conflict("CUSTOMER_NOT_SUSPENDED", "Suspend this account first.");
      const now = deps.clock.now();
      const updated = await tx
        .update(users)
        .set({
          trashedAt: now,
          trashedByUserId: actorUserId(input.actor),
          trashBatchId: input.batchId,
          trashReason: cleanTrashReason(input.reason),
          purgeStartedAt: null,
          version: row.version + 1,
        })
        .where(and(eq(users.id, row.id), isNull(users.trashedAt), eq(users.status, "suspended"), eq(users.version, row.version)));
      if (affected(updated) !== 1) throw conflict("TRASH_STATE_CHANGED", "This account changed meanwhile. Reload and try again.");
      const sessionsRevoked = await i.sessions.revokeAllForUser(row.id, { reason: "account_trashed", tx, ...(actorUserId(input.actor) !== null ? { actorUserId: actorUserId(input.actor)! } : {}) });
      await i.tokens.retireAll(tx, row.id, IDENTITY_TOKEN_PURPOSES, "account_trashed");
      return { publicId: row.publicId, customerRef: row.customerRef ?? null, changed: true, sessionsRevoked };
    },

    /**
     * Restore from the trash; the account stays SUSPENDED (an administrator reactivates it separately). Not in the
     * trash → no-op. Another batch → 409. Purge started or done → 409 PURGE_STARTED (no way back).
     */
    async restoreCustomerInTx(tx: Tx, userId: number, input: { actor: TrashActor; batchId: string }): Promise<{ publicId: string; changed: boolean }> {
      const row = await lockCustomer(tx, userId);
      if (row.purgedAt || row.purgeStartedAt) throw conflict("PURGE_IN_PROGRESS", "Permanent deletion has already started for this account.");
      if (!row.trashedAt) return { publicId: row.publicId, changed: false };
      if (row.trashBatchId !== input.batchId) throw conflict("TRASH_BATCH_MISMATCH", "This account was moved to the trash again. Reload and try again.");
      const updated = await tx
        .update(users)
        .set({ trashedAt: null, trashedByUserId: null, trashBatchId: null, trashReason: null, version: row.version + 1 })
        .where(and(eq(users.id, row.id), eq(users.trashBatchId, input.batchId), isNull(users.purgeStartedAt), eq(users.version, row.version)));
      if (affected(updated) !== 1) throw conflict("TRASH_STATE_CHANGED", "This account changed meanwhile. Reload and try again.");
      return { publicId: row.publicId, changed: true };
    },

    /** The purge claim: from here restore is refused. Must be in the trash (batch checked). Idempotent. */
    async markPurgeStartedInTx(tx: Tx, userId: number, input: { batchId: string; runId?: string; actor?: TrashActor }): Promise<{ publicId: string; changed: boolean }> {
      const row = await lockCustomer(tx, userId);
      if (row.purgedAt) throw notFound("CUSTOMER_NOT_FOUND");
      if (!row.trashedAt || row.trashBatchId !== input.batchId) throw conflict("NOT_IN_TRASH", "This account is not in the trash.");
      if (row.purgeStartedAt) return { publicId: row.publicId, changed: false };
      const updated = await tx
        .update(users)
        .set({ purgeStartedAt: deps.clock.now(), version: row.version + 1 })
        .where(and(eq(users.id, row.id), eq(users.trashBatchId, input.batchId), isNull(users.purgeStartedAt), eq(users.version, row.version)));
      if (affected(updated) !== 1) throw conflict("TRASH_STATE_CHANGED", "This account changed meanwhile. Reload and try again.");
      return { publicId: row.publicId, changed: true };
    },

    /**
     * LAST step of a purge (after every participant reported success). Turns the row into a tombstone: e-mail →
     * unique non-routable placeholder with a NEW blind index (the old address may register again, as a NEW user
     * id that inherits nothing), names → "Deleted account", password and every credential gone, status
     * `deactivated`, free text cleared, `purged_at` set. Customer ID stays (reservation). Idempotent.
     */
    async tombstoneCustomerInTx(tx: Tx, userId: number, _input: { runId: string; actor?: TrashActor }): Promise<{ publicId: string; changed: boolean; erased: Record<string, number> }> {
      const row = await lockCustomer(tx, userId);
      if (row.purgedAt) return { publicId: row.publicId, changed: false, erased: {} };
      if (!row.trashedAt || !row.purgeStartedAt) throw conflict("PURGE_NOT_STARTED", "Permanent deletion has not started for this account.");
      const now = deps.clock.now();
      const erased = await eraseCredentialsInTx(tx, row.id);
      const updated = await tx
        .update(users)
        .set({ ...tombstoneColumns(deps.crypto, row.publicId, now), version: row.version + 1 })
        .where(and(eq(users.id, row.id), isNull(users.purgedAt), isNotNull(users.purgeStartedAt), eq(users.version, row.version)));
      if (affected(updated) !== 1) throw conflict("TRASH_STATE_CHANGED", "This account changed meanwhile. Retry the deletion.");
      return { publicId: row.publicId, changed: true, erased };
    },

    /** Trash centre read (customers in the trash, tombstones excluded). Newest first, keyset paging. No names. */
    async listTrashedCustomers(query: TrashedCustomerQuery = {}, db: DbOrTx = deps.db): Promise<{ items: TrashedCustomerItem[]; nextCursor: string | null }> {
      const limit = Math.min(Math.max(query.limit ?? 25, 1), LIST_MAX);
      const after = decodeCursor(query.cursor);
      const conditions: (SQL | undefined)[] = [eq(users.role, "customer"), isNotNull(users.trashedAt), isNull(users.purgedAt)];
      if (after !== null) conditions.push(lt(users.id, after));
      if (query.from) conditions.push(gte(users.trashedAt, query.from));
      if (query.to) conditions.push(lte(users.trashedAt, query.to));
      if (query.trashedBefore) conditions.push(lte(users.trashedAt, query.trashedBefore));
      const q = query.q?.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
      if (q) conditions.push(like(users.customerRef, `${q}%`));
      if (query.movedBy) {
        const [mover] = await db.select({ id: users.id }).from(users).where(eq(users.publicId, query.movedBy)).limit(1);
        if (!mover) return { items: [], nextCursor: null };
        conditions.push(eq(users.trashedByUserId, mover.id));
      }
      const rows = await db.select().from(users).where(and(...conditions)).orderBy(desc(users.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const moverIds = [...new Set(page.map((r) => r.trashedByUserId).filter((v): v is number => v !== null))];
      const movers = new Map<number, string>(
        moverIds.length ? (await db.select({ id: users.id, publicId: users.publicId }).from(users).where(inArray(users.id, moverIds))).map((m) => [m.id, m.publicId] as const) : [],
      );
      return {
        items: page.map((r) => ({
          id: r.id,
          publicId: r.publicId,
          customerRef: r.customerRef ?? null,
          trashedAt: r.trashedAt!,
          trashedByUserId: r.trashedByUserId ?? null,
          trashedByPublicId: r.trashedByUserId !== null ? (movers.get(r.trashedByUserId) ?? null) : null,
          batchId: r.trashBatchId ?? null,
          reason: r.trashReason ?? null,
          purgeStartedAt: r.purgeStartedAt ?? null,
        })),
        nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null,
      };
    },

    /**
     * Batch trash metadata for the Orders tab (owner customer ID, OWNER_IN_TRASH, same-batch retention). Ungated
     * (trash paths only), customers only, at most 500 distinct ids; unknown ids are absent.
     */
    async getCustomerTrashMetaByIds(userIds: readonly number[], db: DbOrTx = deps.db): Promise<Map<number, { publicId: string; customerRef: string | null; trashedAt: Date | null; trashBatchId: string | null }>> {
      const unique = [...new Set(userIds)].filter((id) => Number.isSafeInteger(id));
      if (unique.length === 0) return new Map();
      if (unique.length > 500) throw new Error("getCustomerTrashMetaByIds accepts at most 500 ids");
      const rows = await db
        .select({ id: users.id, publicId: users.publicId, customerRef: users.customerRef, trashedAt: users.trashedAt, trashBatchId: users.trashBatchId })
        .from(users)
        .where(and(inArray(users.id, unique), eq(users.role, "customer")));
      return new Map(rows.map((r) => [r.id, { publicId: r.publicId, customerRef: r.customerRef ?? null, trashedAt: r.trashedAt ?? null, trashBatchId: r.trashBatchId ?? null }]));
    },

    /** The identity TrashParticipant (customers only; orders are not identity's). */
    participant(): TrashParticipant {
      const isCustomer = (entity: TrashEntityRef) => entity.kind === "customer";
      return {
        module: "identity",
        async summarize(entity) {
          if (!isCustomer(entity)) return {};
          return sessionAndLinkCounts(deps.db, Number(entity.id));
        },
        async purge(entity, run) {
          if (!isCustomer(entity)) return { deleted: {} };
          const deleted = await deps.db.transaction(async (tx) => {
            // D2.8 fence: FIRST statement of the only data-changing transaction (no external provider calls here).
            await run.assertCurrentInTx(tx);
            const row = await lockCustomer(tx, Number(entity.id));
            if (row.publicId !== entity.publicId) throw notFound("CUSTOMER_NOT_FOUND");
            if (row.purgedAt) return {};
            if (!row.purgeStartedAt) throw conflict("PURGE_NOT_STARTED", "Permanent deletion has not started for this account.");
            return eraseCredentialsInTx(tx, row.id);
          });
          return { deleted };
        },
      };
    },
  };
  return service;
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return Number((header as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

export type IdentityTrash = ReturnType<typeof createIdentityTrash>;
