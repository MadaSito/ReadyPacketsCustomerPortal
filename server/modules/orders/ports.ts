/**
 * The narrow slices of peer modules that orders calls, resolved at call time from `deps.services`.
 * A missing method fails closed (UNAVAILABLE) instead of silently skipping a security step.
 */
import { DomainError } from "../../core/errors.js";
import type { DbOrTx, Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import type { UserRole } from "../../../shared/domain.js";

export interface OrdersUserView {
  id: number;
  publicId: string;
  role: UserRole;
  status: string;
  email: string;
  name: string;
  customerRef: string | null;
}

export interface IdentityPort {
  getUser(userId: number, opts?: { tx?: DbOrTx; forUpdate?: boolean }): Promise<OrdersUserView | null>;
  getUserByPublicId(publicId: string, opts?: { tx?: DbOrTx; forUpdate?: boolean }): Promise<OrdersUserView | null>;
}

export interface FilesPort {
  reassignOrderFiles(orderId: number, ownerUserId: number, tx: Tx): Promise<void>;
}

export interface EngagementPort {
  notify(input: { userId: number; kind: string; title: string; body: string; link?: string; idempotencyKey?: string; skipEmail?: boolean }, tx?: Tx): Promise<unknown>;
}

const unavailable = (reason: string) =>
  new DomainError("UNAVAILABLE", reason, "This action is temporarily unavailable. Please try again later.");

function method<T>(holder: unknown, name: string): T | null {
  if (holder && typeof (holder as Record<string, unknown>)[name] === "function") {
    const fn = (holder as Record<string, (...args: unknown[]) => unknown>)[name]!;
    return fn.bind(holder) as T;
  }
  return null;
}

export function identityPort(services: Services): IdentityPort {
  const holder = (services as Partial<Services>).identity;
  const getUser = method<IdentityPort["getUser"]>(holder, "getUser");
  const getUserByPublicId = method<IdentityPort["getUserByPublicId"]>(holder, "getUserByPublicId");
  if (!getUser || !getUserByPublicId) throw unavailable("IDENTITY_UNAVAILABLE");
  return { getUser, getUserByPublicId };
}

export function filesPort(services: Services): FilesPort {
  const fn = method<FilesPort["reassignOrderFiles"]>((services as Partial<Services>).files, "reassignOrderFiles");
  if (!fn) throw unavailable("FILES_UNAVAILABLE");
  return { reassignOrderFiles: fn };
}

/** Notifications are best-effort side channels; absence is tolerated (returns null). */
export function engagementPort(services: Services): EngagementPort | null {
  const fn = method<EngagementPort["notify"]>((services as Partial<Services>).engagement, "notify");
  return fn ? { notify: fn } : null;
}

export interface CompliancePort {
  assertRequiredPoliciesAccepted(userId: number, opts?: { audience?: "customer" | "staff"; tx?: DbOrTx }): Promise<void>;
}

/** Policy-acceptance gate for order creation. Absent compliance module ⇒ null (gate not installed). */
export function compliancePort(services: Services): CompliancePort | null {
  const fn = method<CompliancePort["assertRequiredPoliciesAccepted"]>((services as Partial<Services>).compliance, "assertRequiredPoliciesAccepted");
  return fn ? { assertRequiredPoliciesAccepted: fn } : null;
}
