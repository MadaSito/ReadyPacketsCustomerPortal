import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { hasFreshStepUp } from "../../trpc/trpc.js";

export function assertStorageAdmin(principal: SessionPrincipal, now: Date): void {
  if (principal.state !== "full" || principal.pendingSteps.length) {
    throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
  }
  if (principal.role !== "admin" || !roleHasCapability(principal.role, "storage.manage")) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
  if (!hasFreshStepUp(principal, now)) {
    throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your identity to continue.", { capability: "storage.manage" });
  }
}

export async function assertCurrentStorageAdmin(deps: ModuleDeps, principal: SessionPrincipal, tx: Tx): Promise<void> {
  assertStorageAdmin(principal, deps.clock.now());
  const sessions = deps.services.identity?.sessions;
  if (!sessions?.assertCurrent) throw forbidden("ACTOR_UNVERIFIABLE");
  const current = await sessions.assertCurrent(principal, tx);
  assertStorageAdmin({ ...principal, role: current.role, pendingSteps: current.pendingSteps, stepUpAt: current.stepUpAt }, deps.clock.now());
}
