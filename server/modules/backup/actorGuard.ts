/**
 * Zero-trust actor re-validation for backup administrative operations.
 *
 * Pre-transaction checks enforce full session, role, capability, and fresh step-up.
 * Inside every mutation transaction, `assertBackupActorInTx` calls `services.identity.sessions.assertCurrent(principal, tx)`
 * FIRST so lock acquisition order is always `users` -> `user_sessions` -> `backup_*` tables, and revoked sessions
 * or downgraded roles fail closed before any mutation commits.
 */
import { STEP_UP_CAPABILITIES, roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import type { Services } from "../../container.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { Clock, SessionPrincipal, Tx } from "../../core/types.js";
import { hasFreshStepUp, STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";

interface IdentitySessionsAssertLike {
  assertCurrent(
    principal: SessionPrincipal,
    tx: Tx,
  ): Promise<{
    pendingSteps: readonly unknown[];
    role: SessionPrincipal["role"];
    stepUpAt: Date | null;
  }>;
}

export function assertBackupPrincipalPrecheck(
  principal: SessionPrincipal | null | undefined,
  capability: Capability,
  now: Date,
): asserts principal is SessionPrincipal {
  if (!principal) {
    throw new DomainError("UNAUTHENTICATED", "NO_SESSION", "Please sign in to continue.");
  }
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
  if (principal.role !== "admin" || !roleHasCapability(principal.role, capability)) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
  if (STEP_UP_CAPABILITIES.has(capability) && !hasFreshStepUp(principal, now, STEP_UP_MAX_AGE_MS)) {
    throw new DomainError(
      "STEP_UP_REQUIRED",
      "STEP_UP_REQUIRED",
      "Please confirm your password and authentication code to continue.",
      { capability },
    );
  }
}

export async function assertBackupActorInTx(
  services: Pick<Services, "identity">,
  clock: Clock,
  principal: SessionPrincipal,
  capability: Capability,
  tx: Tx,
): Promise<void> {
  assertBackupPrincipalPrecheck(principal, capability, clock.now());
  const sessions = (services.identity as unknown as { sessions?: Partial<IdentitySessionsAssertLike> } | undefined)?.sessions;
  if (!sessions || typeof sessions.assertCurrent !== "function") {
    throw forbidden("ACTOR_UNVERIFIABLE");
  }
  const live = await sessions.assertCurrent(principal, tx);
  if (live.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
  if (live.role !== "admin" || !roleHasCapability(live.role, capability)) {
    throw forbidden("CAPABILITY_REVOKED");
  }
  if (STEP_UP_CAPABILITIES.has(capability)) {
    const at = live.stepUpAt?.getTime();
    if (at === undefined || clock.now().getTime() - at > STEP_UP_MAX_AGE_MS) {
      throw new DomainError(
        "STEP_UP_REQUIRED",
        "STEP_UP_REQUIRED",
        "Please confirm your password and authentication code to continue.",
        { capability },
      );
    }
  }
}
