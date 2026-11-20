/** Shared service context + zero-trust capability checks for the audit center. Owner: audit engineer. */
import { STEP_UP_CAPABILITIES, roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { DbOrTx, SessionPrincipal } from "../../core/types.js";
import type { ModuleDeps } from "../../container.js";
import { hasFreshStepUp } from "../../trpc/trpc.js";
import type { ChainService } from "./chain.js";

export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;

export interface AuditCtx {
  deps: ModuleDeps;
  chain: ChainService;
}

/**
 * Re-checks role capability (+ fresh step-up where the catalogue demands it) INSIDE the service, so a
 * mis-wired router or raw route cannot bypass it. Customers never reach audit data.
 */
export function assertAuditCapability(ctx: AuditCtx, principal: SessionPrincipal, capability: Capability): void {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
  }
  if (principal.role === "customer" || !roleHasCapability(principal.role, capability)) throw forbidden("CAPABILITY_NOT_GRANTED");
  if (STEP_UP_CAPABILITIES.has(capability)) {
    if (!hasFreshStepUp(principal, ctx.deps.clock.now(), STEP_UP_MAX_AGE_MS)) {
      throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your password and authentication code to continue.", { capability });
    }
  }
}

export function actorOf(principal: SessionPrincipal) {
  return { userId: principal.userId, role: principal.role } as const;
}

/**
 * Re-validates the ACTOR inside the mutation's transaction (zero trust: the session snapshot is from
 * request start). Locks the user row so a concurrent demotion/disable serialises with this mutation.
 */
export async function assertActorCurrent(ctx: AuditCtx, principal: SessionPrincipal, tx: DbOrTx, capability: Capability): Promise<void> {
  const user = await ctx.deps.services.identity.getUser(principal.userId, { tx, forUpdate: true });
  if (!user || user.status !== "active" || user.role !== principal.role || !roleHasCapability(user.role, capability)) {
    throw forbidden("ACTOR_NO_LONGER_AUTHORISED");
  }
}
