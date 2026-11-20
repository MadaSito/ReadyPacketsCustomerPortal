/**
 * Zero-trust authorization helper for privileged `integrations.manage` mutations.
 *
 * Enforces BOTH:
 *  1. Immediate pre-check on the verified `SessionPrincipal` (full session, capability, fresh step-up).
 *  2. Authoritative in-transaction re-validation via `services.identity.sessions.assertCurrent(principal, tx)`
 *     when the identity service is present — locking the actor's user + session rows FOR UPDATE so a
 *     revoked session, suspended admin, demoted role, or expired step-up cannot complete a write.
 */
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { STEP_UP_MAX_AGE_MS, hasFreshStepUp } from "../../trpc/trpc.js";

export function assertIntegrationsManagePreflight(principal: SessionPrincipal, now: Date): void {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
  if (!roleHasCapability(principal.role, "integrations.manage")) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
  if (!hasFreshStepUp(principal, now)) {
    throw new DomainError(
      "STEP_UP_REQUIRED",
      "STEP_UP_REQUIRED",
      "Please confirm your password and authentication code to continue.",
      { capability: "integrations.manage" },
    );
  }
}

export async function assertIntegrationsManageInTx(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  tx: Tx,
): Promise<void> {
  const now = deps.clock.now();
  assertIntegrationsManagePreflight(principal, now);

  const assertCurrent = deps.services.identity?.sessions?.assertCurrent;
  if (typeof assertCurrent === "function") {
    const current = await assertCurrent(principal, tx);
    if (current.pendingSteps.length > 0) {
      throw new DomainError(
        "REMEDIATION_REQUIRED",
        "ACCOUNT_STEP_PENDING",
        "Please finish securing your account to continue.",
      );
    }
    if (!roleHasCapability(current.role, "integrations.manage")) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    const stepUpAge = current.stepUpAt ? now.getTime() - current.stepUpAt.getTime() : -1;
    if (!(stepUpAge >= 0 && stepUpAge <= STEP_UP_MAX_AGE_MS)) {
      throw new DomainError(
        "STEP_UP_REQUIRED",
        "STEP_UP_REQUIRED",
        "Please confirm your password and authentication code to continue.",
        { capability: "integrations.manage" },
      );
    }
  }
}
