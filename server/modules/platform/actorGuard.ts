/**
 * Re-validates the ACTOR inside the mutation's transaction (zero trust: never rely on the session snapshot
 * taken at request start). Identity's `sessions.assertCurrent(principal, tx)` locks the users row, then the
 * session row; platform rows are always locked AFTER the guard, so the lock order is deterministic
 * (users → sessions → platform_settings → platform_presentation_images).
 */
import { STEP_UP_CAPABILITIES, roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import { forbidden } from "../../core/errors.js";
import type { Clock, SessionPrincipal, Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";

/** Runs first inside a privileged transaction; throws FORBIDDEN when the actor no longer qualifies. */
export type ActorGuard = (tx: Tx) => Promise<void>;

interface SessionsLike {
  assertCurrent(principal: SessionPrincipal, tx: Tx): Promise<{ pendingSteps: readonly unknown[]; role: SessionPrincipal["role"]; stepUpAt: Date | null }>;
}

export function createActorGuard(
  services: Pick<Services, "identity">,
  clock: Clock,
  principal: SessionPrincipal,
  capability: Capability = "platform.settings.manage",
): ActorGuard {
  return async (tx) => {
    const sessions = (services.identity as unknown as { sessions?: Partial<SessionsLike> } | undefined)?.sessions;
    // Fail closed: without identity we cannot prove the actor is still entitled.
    if (!sessions || typeof sessions.assertCurrent !== "function") throw forbidden("ACTOR_UNVERIFIABLE");
    const current = await sessions.assertCurrent(principal, tx);
    if (current.pendingSteps.length > 0) throw forbidden("NO_FULL_SESSION");
    if (current.role !== "admin" || !roleHasCapability(current.role, capability)) throw forbidden("ROLE_NOT_PERMITTED");
    if (STEP_UP_CAPABILITIES.has(capability)) {
      const at = current.stepUpAt?.getTime();
      if (at === undefined || clock.now().getTime() - at > STEP_UP_MAX_AGE_MS) throw forbidden("STEP_UP_REQUIRED");
    }
  };
}
