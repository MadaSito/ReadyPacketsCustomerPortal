import { eq } from "drizzle-orm";
import { roleHasCapability, STEP_UP_CAPABILITIES, type Capability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { users } from "../identity/schema.js";

/**
 * Re-validates the acting principal INSIDE `tx` so a mid-flight role demotion, account suspension,
 * or session revocation aborts the privileged write (fail closed).
 *
 * Lock ordering follows identity/API.md: `users` row FOR UPDATE (and `user_sessions` via
 * `identity.sessions.assertCurrent` when wired) BEFORE any compliance or order rows.
 */
export async function assertLiveActorInTx(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  tx: Tx,
  requiredCapability?: Capability,
): Promise<{ userId: number; role: "customer" | "staff" | "admin" }> {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }

  const identitySvc = (deps.services as Partial<typeof deps.services>).identity;
  if (identitySvc?.sessions?.assertCurrent) {
    const { pendingSteps } = await identitySvc.sessions.assertCurrent(principal, tx);
    if (pendingSteps.length > 0) {
      throw new DomainError(
        "REMEDIATION_REQUIRED",
        "ACCOUNT_STEP_PENDING",
        "Please finish securing your account to continue.",
      );
    }
  }

  const [liveUser] = await tx
    .select({ id: users.id, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, principal.userId))
    .for("update")
    .limit(1);

  if (!liveUser || liveUser.status !== "active") {
    throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Your session is no longer active. Please sign in again.");
  }

  if (requiredCapability) {
    if (!roleHasCapability(liveUser.role, requiredCapability)) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    if (STEP_UP_CAPABILITIES.has(requiredCapability)) {
      const now = deps.clock.now();
      let stepUpAt = principal.stepUpAt;
      if (identitySvc?.sessions?.getState) {
        const liveSession = await identitySvc.sessions.getState(principal.sessionId, { tx });
        if (!liveSession || !liveSession.live) {
          throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Your session is no longer active.");
        }
        stepUpAt = liveSession.stepUpAt;
      }
      if (!stepUpAt || now.getTime() - stepUpAt.getTime() > STEP_UP_MAX_AGE_MS) {
        throw new DomainError(
          "STEP_UP_REQUIRED",
          "STEP_UP_REQUIRED",
          "Please confirm your password and authentication code to continue.",
          { capability: requiredCapability },
        );
      }
    }
  }

  return { userId: liveUser.id, role: liveUser.role };
}
