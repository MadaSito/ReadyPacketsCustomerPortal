/**
 * Narrow structural peer contracts consumed by the engagement module at call time,
 * plus transactional actor re-validation with deterministic lock ordering.
 */
import { asc, inArray } from "drizzle-orm";
import { roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import type { UserRole } from "../../../shared/domain.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import type { FilesModule } from "../files/index.js";
import { isLiveUserRow } from "../identity/live.js";
import { users, type UserStatus } from "../identity/schema.js";
import type { OrdersModule } from "../orders/index.js";

export interface IdentityUserSummary {
  id: number;
  publicId: string;
  role: UserRole;
  status: UserStatus;
  email: string;
  name: string;
  customerRef: string | null;
}

export interface IdentityCustomerSearchItem {
  publicId: string;
  customerRef: string | null;
  name: string;
  email: string;
  status: UserStatus;
  createdAt: Date;
}

export interface IdentitySessionState {
  sessionId: string;
  userId: number;
  userPublicId: string;
  role: UserRole;
  userStatus: UserStatus;
  live: boolean;
}

export interface IdentityPeer {
  getUser?(userId: number, opts?: { tx?: DbOrTx }): Promise<IdentityUserSummary | null>;
  getUserByPublicId?(publicId: string, opts?: { tx?: DbOrTx }): Promise<IdentityUserSummary | null>;
  searchCustomers?(
    principal: SessionPrincipal,
    input: { query?: string; status?: UserStatus; cursor?: string; limit?: number },
  ): Promise<{ items: IdentityCustomerSearchItem[]; nextCursor: string | null }>;
  sessions?: {
    assertCurrent?(
      principal: SessionPrincipal,
      tx: Tx,
    ): Promise<{ pendingSteps: readonly string[]; role: UserRole; stepUpAt: Date | null; mfaVerifiedAt: Date | null }>;
    getState?(sessionId: string, opts?: { tx?: DbOrTx }): Promise<IdentitySessionState | null>;
  };
}

export interface LockedUserSummary {
  id: number;
  publicId: string;
  role: UserRole;
  status: UserStatus;
  trashedAt: Date | null;
  purgedAt: Date | null;
}

/**
 * Re-validates the acting principal INSIDE `tx` against authoritative `users` (+ `identity.sessions.assertCurrent`
 * when wired) and acquires `SELECT … FOR UPDATE` locks on `[principal.userId, ...extraLockUserIds]` in deterministic
 * ascending `users.id` order (`users` first, before locking domain rows).
 */
export async function assertCurrentActorInTx(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  tx: Tx,
  options: { capability?: Capability; extraLockUserIds?: readonly number[] } = {},
): Promise<Map<number, LockedUserSummary>> {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }

  // Always lock actor + any target user IDs in ascending `users.id` order FIRST to prevent AB/BA deadlocks.
  const idsToLock = [...new Set([principal.userId, ...(options.extraLockUserIds ?? [])])].sort((a, b) => a - b);
  const lockedRows = await tx
    .select({
      id: users.id,
      publicId: users.publicId,
      role: users.role,
      status: users.status,
      trashedAt: users.trashedAt,
      purgedAt: users.purgedAt,
    })
    .from(users)
    .where(inArray(users.id, idsToLock))
    .orderBy(asc(users.id))
    .for("update");

  const lockedMap = new Map<number, LockedUserSummary>(lockedRows.map((row) => [row.id, row]));
  const actorRow = lockedMap.get(principal.userId);
  if (
    !actorRow ||
    actorRow.status !== "active" ||
    !isLiveUserRow(actorRow) ||
    actorRow.role !== principal.role
  ) {
    throw new DomainError(
      "UNAUTHENTICATED",
      "SESSION_NOT_CURRENT",
      "Your session is no longer active. Please sign in again.",
    );
  }

  const identity = getIdentityPeer(deps);
  let effectiveRole: UserRole = actorRow.role;

  if (identity.sessions?.assertCurrent) {
    const current = await identity.sessions.assertCurrent(principal, tx);
    if (current.pendingSteps.length > 0) {
      throw new DomainError(
        "REMEDIATION_REQUIRED",
        "ACCOUNT_STEP_PENDING",
        "Please finish securing your account to continue.",
      );
    }
    effectiveRole = current.role;
  } else if (identity.sessions?.getState) {
    const sessionState = await identity.sessions.getState(principal.sessionId, { tx });
    if (
      sessionState === null ||
      !sessionState.live ||
      sessionState.role !== actorRow.role ||
      sessionState.userStatus !== "active"
    ) {
      throw new DomainError(
        "UNAUTHENTICATED",
        "SESSION_NOT_CURRENT",
        "Your session is no longer active. Please sign in again.",
      );
    }
  }

  if (options.capability && !roleHasCapability(effectiveRole, options.capability)) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }

  return lockedMap;
}

export function getOrdersPeer(deps: ModuleDeps): OrdersModule {
  const orders = deps.services.orders as Partial<OrdersModule> | undefined;
  if (!orders?.assertCanReadOrder || !orders.assertCanWriteOrder) {
    throw new DomainError(
      "UNAVAILABLE",
      "ORDERS_POLICY_UNAVAILABLE",
      "Order authorization is temporarily unavailable.",
    );
  }
  return orders as OrdersModule;
}

export function getFilesPeer(deps: ModuleDeps): FilesModule {
  const files = deps.services.files as Partial<FilesModule> | undefined;
  if (!files?.assertCanReadFile) {
    throw new DomainError(
      "UNAVAILABLE",
      "FILES_POLICY_UNAVAILABLE",
      "File authorization is temporarily unavailable.",
    );
  }
  return files as FilesModule;
}

export function getIdentityPeer(deps: ModuleDeps): IdentityPeer {
  return (deps.services.identity ?? {}) as unknown as IdentityPeer;
}
