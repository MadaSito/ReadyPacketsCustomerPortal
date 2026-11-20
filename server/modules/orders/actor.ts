/**
 * In-transaction ACTOR re-validation (zero trust: never rely on the session snapshot taken at request start).
 *
 * Uses identity's `sessions.assertCurrent(principal, tx)`, which locks the actor's `users` row and then the
 * `user_sessions` row, and rejects revoked/expired/rotated sessions, inactive users and role changes. This
 * helper then re-derives authority from the PERSISTED state returned inside the transaction: no pending account
 * steps, the persisted role still grants the capability, and — for step-up capabilities — the persisted
 * step-up is fresh.
 *
 * Lock order (shared with files): order row (alone, never joined with the owner's users row) → [policy grant
 * re-check FOR SHARE] → users row(s) (ascending id) → user_sessions → grant rows FOR UPDATE → files. The order row
 * serializes every writer of that order, so grant locks of one order cannot form a cycle with users rows.
 * Mutations on an existing order lock the order row FIRST and call this afterwards. Mutations that lock no
 * order row (create, catalog, workflows) call it as the first statement.
 *
 * Fails closed: if identity does not expose `sessions.assertCurrent`, the write is refused (ACTOR_UNVERIFIABLE).
 */
import { STEP_UP_CAPABILITIES, roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { Clock, SessionPrincipal, Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";

export interface PersistedAuthority {
  pendingSteps: readonly unknown[];
  role: SessionPrincipal["role"];
  stepUpAt: Date | null;
}

interface SessionsLike {
  assertCurrent(principal: SessionPrincipal, tx: Tx): Promise<PersistedAuthority>;
}

/** Throws unless the actor is still entitled; `capability` omitted ⇒ only session/role currency is checked. */
export type ActorCheck = (principal: SessionPrincipal, tx: Tx, capability?: Capability) => Promise<PersistedAuthority>;

export function createActorCheck(services: Services, clock: Clock): ActorCheck {
  return async (principal, tx, capability) => {
    const sessions = (services as Partial<Services>).identity as unknown as { sessions?: Partial<SessionsLike> } | undefined;
    const assertCurrent = sessions?.sessions?.assertCurrent;
    if (typeof assertCurrent !== "function") throw forbidden("ACTOR_UNVERIFIABLE");
    const current = await assertCurrent.call(sessions!.sessions, principal, tx);
    if (current.pendingSteps.length > 0)
      throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
    if (current.role !== principal.role) throw forbidden("ACTOR_NOT_AUTHORIZED");
    if (capability) {
      if (!roleHasCapability(current.role, capability)) throw forbidden("ACTOR_NOT_AUTHORIZED");
      if (STEP_UP_CAPABILITIES.has(capability)) {
        const at = current.stepUpAt?.getTime();
        if (at === undefined || clock.now().getTime() - at > STEP_UP_MAX_AGE_MS)
          throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your password and authentication code to continue.");
      }
    }
    return current;
  };
}
