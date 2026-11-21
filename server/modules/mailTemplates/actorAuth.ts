import { eq } from "drizzle-orm";
import { roleHasCapability, STEP_UP_CAPABILITIES, type Capability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { users } from "../identity/schema.js";

export async function runMailTemplatesTx<T>(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  resource: { type: string; publicId?: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await deps.db.transaction(fn);
  } catch (err) {
    if (
      err instanceof DomainError &&
      (err.code === "FORBIDDEN" ||
        err.code === "STEP_UP_REQUIRED" ||
        err.code === "REMEDIATION_REQUIRED")
    ) {
      await deps.audit.record({
        category: "security",
        eventName: "authz.mail_templates.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: err.reasonCode,
        actor: { userId: principal.userId, role: principal.role },
        resource,
      });
    }
    throw err;
  }
}

export async function assertLiveMailAdminInTx(
  deps: ModuleDeps,
  principal: SessionPrincipal | null,
  tx: Tx,
  requiredCapability: Capability = "mail.manage",
): Promise<{ userId: number; role: "customer" | "staff" | "admin" }> {
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
    throw new DomainError(
      "UNAUTHENTICATED",
      "SESSION_NOT_CURRENT",
      "Your session is no longer active. Please sign in again.",
    );
  }

  if (!roleHasCapability(liveUser.role, requiredCapability)) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }

  if (STEP_UP_CAPABILITIES.has(requiredCapability)) {
    const now = deps.clock.now();
    let stepUpAt = principal.stepUpAt;
    if (identitySvc?.sessions?.getState) {
      const liveSession = await identitySvc.sessions.getState(principal.sessionId, { tx });
      if (!liveSession || !liveSession.live) {
        throw new DomainError(
          "UNAUTHENTICATED",
          "SESSION_NOT_CURRENT",
          "Your session is no longer active.",
        );
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

  return { userId: liveUser.id, role: liveUser.role };
}
