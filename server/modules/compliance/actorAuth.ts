import { eq } from "drizzle-orm";
import { roleHasCapability, STEP_UP_CAPABILITIES, type Capability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { isLiveUserRow } from "../identity/live.js";
import { users } from "../identity/schema.js";

/**
 * Records `authz.compliance.denied` outside any transaction and throws `FORBIDDEN`.
 */
export async function denyComplianceAuthz(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  reasonCode: string,
  resource: { type: string; publicId?: string },
): Promise<never> {
  await deps.audit.record({
    category: "security",
    eventName: "authz.compliance.denied",
    action: "authorize",
    outcome: "denied",
    severity: "WARN",
    reasonCode,
    actor: { userId: principal.userId, role: principal.role },
    resource,
  });
  throw forbidden(reasonCode);
}

/**
 * Runs a compliance write transaction and, AFTER rollback on authz/step-up/remediation denial
 * (or caller-supplied business refusal), records the durable audit event outside any transaction
 * so neither rollback nor single-connection pools drop or deadlock the denial audit.
 */
export async function runComplianceTx<T>(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  resource: { type: string; publicId?: string },
  fn: (tx: Tx) => Promise<T>,
  options?: {
    onRefusalAfterRollback?: (err: DomainError) => Promise<void>;
  },
): Promise<T> {
  try {
    return await deps.db.transaction(fn);
  } catch (err) {
    if (err instanceof DomainError) {
      if (
        err.code === "FORBIDDEN" ||
        err.code === "STEP_UP_REQUIRED" ||
        err.code === "REMEDIATION_REQUIRED"
      ) {
        await deps.audit.record({
          category: "security",
          eventName: "authz.compliance.denied",
          action: "authorize",
          outcome: "denied",
          severity: "WARN",
          reasonCode: err.reasonCode,
          actor: { userId: principal.userId, role: principal.role },
          resource,
        });
      } else if (options?.onRefusalAfterRollback) {
        await options.onRefusalAfterRollback(err);
      }
    }
    throw err;
  }
}

/**
 * Re-validates the acting principal INSIDE `tx` so a mid-flight role demotion, account suspension,
 * or session revocation aborts the privileged write (fail closed).
 *
 * Lock ordering follows identity/API.md: `users` row FOR UPDATE (and `user_sessions` via
 * `identity.sessions.assertCurrent` when wired) BEFORE any compliance rows.
 */
export async function assertLiveActorInTx(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  tx: Tx,
  requiredCapability?: Capability,
  options?: { allowPolicyRemediation?: boolean },
): Promise<{ userId: number; role: "customer" | "staff" | "admin" }> {
  const allowsRemediation =
    options?.allowPolicyRemediation === true &&
    principal.state === "remediation" &&
    principal.pendingSteps[0] === "accept_policy";

  if (!allowsRemediation && (principal.state !== "full" || principal.pendingSteps.length > 0)) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }

  const identitySvc = (deps.services as Partial<typeof deps.services>).identity;
  if (identitySvc?.sessions?.assertCurrent) {
    const { pendingSteps } = await identitySvc.sessions.assertCurrent(principal, tx);
    const liveAllowsRemediation =
      options?.allowPolicyRemediation === true &&
      (pendingSteps.length === 0 || pendingSteps[0] === "accept_policy");
    if (!liveAllowsRemediation && pendingSteps.length > 0) {
      throw new DomainError(
        "REMEDIATION_REQUIRED",
        "ACCOUNT_STEP_PENDING",
        "Please finish securing your account to continue.",
      );
    }
  }

  const [liveUser] = await tx
    .select({
      id: users.id,
      role: users.role,
      status: users.status,
      trashedAt: users.trashedAt,
      purgedAt: users.purgedAt,
    })
    .from(users)
    .where(eq(users.id, principal.userId))
    .for("update")
    .limit(1);

  if (!liveUser || liveUser.status !== "active" || !isLiveUserRow(liveUser)) {
    throw new DomainError(
      "UNAUTHENTICATED",
      "SESSION_NOT_CURRENT",
      "Your session is no longer active. Please sign in again.",
    );
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
  }

  return { userId: liveUser.id, role: liveUser.role };
}
