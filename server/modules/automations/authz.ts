/**
 * Automations module — capability & step-up enforcement (preflight + in-transaction).
 *
 * Re-validates the acting administrator both before opening a transaction and INSIDE `tx`
 * against authoritative `users` (`FOR UPDATE`, ascending `users.id` lock order) and
 * `identity.sessions.assertCurrent(principal, tx)` when wired.
 */
import { asc, inArray } from "drizzle-orm";
import {
  STEP_UP_CAPABILITIES,
  roleHasCapability,
  type Capability,
} from "../../../shared/capabilities.js";
import type { UserRole } from "../../../shared/domain.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { users, type UserStatus } from "../identity/schema.js";

interface IdentitySessionsPeer {
  sessions?: {
    assertCurrent?(
      principal: SessionPrincipal,
      tx: Tx,
    ): Promise<{
      pendingSteps: readonly string[];
      role: UserRole;
      stepUpAt: Date | null;
      mfaVerifiedAt: Date | null;
    }>;
  };
}

function isFreshStepUp(stepUpAt: Date | null | undefined, now: Date): boolean {
  if (!(stepUpAt instanceof Date)) return false;
  const age = now.getTime() - stepUpAt.getTime();
  return Number.isFinite(age) && age >= -5_000 && age <= STEP_UP_MAX_AGE_MS;
}

function throwStepUpRequired(capability: Capability): never {
  throw new DomainError(
    "STEP_UP_REQUIRED",
    "STEP_UP_REQUIRED",
    "Please confirm your password and authentication code to continue.",
    { capability },
  );
}

export type AutomationsCheckedCapability =
  | "automations.read"
  | "automations.manage"
  | "orders.automations.run"
  | "orders.stage.run"
  | "orders.transition";

export async function recordAutomationsDenied(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  capability: Capability,
  reasonCode: string,
  tx?: Tx,
): Promise<void> {
  await deps.audit.record(
    {
      category: "security",
      eventName: "authz.automations.denied",
      action:
        capability === "automations.manage"
          ? "manage"
          : capability === "orders.automations.run" ||
              capability === "orders.stage.run" ||
              capability === "orders.transition"
            ? "execute"
            : "read",
      outcome: "denied",
      severity: "WARN",
      reasonCode,
      actor: { userId: principal.userId, role: principal.role },
      resource: { type: "automation" },
      attributes: { capability },
    },
    tx,
  );
}

export async function assertAutomationsCapabilityPreflight(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  capability: AutomationsCheckedCapability,
): Promise<void> {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    await recordAutomationsDenied(deps, principal, capability, "ACCOUNT_STEP_PENDING");
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }

  if (!roleHasCapability(principal.role, capability)) {
    await recordAutomationsDenied(deps, principal, capability, "CAPABILITY_MISSING");
    throw forbidden("AUTOMATIONS_FORBIDDEN");
  }

  const [liveUser] = await deps.db
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(inArray(users.id, [principal.userId]))
    .limit(1);
  if (!liveUser || liveUser.status !== "active" || !roleHasCapability(liveUser.role, capability)) {
    await recordAutomationsDenied(deps, principal, capability, "ACTOR_NOT_ACTIVE");
    throw forbidden("ACTOR_NOT_ACTIVE");
  }

  if (STEP_UP_CAPABILITIES.has(capability)) {
    const now = deps.clock.now();
    if (!isFreshStepUp(principal.stepUpAt, now)) {
      await recordAutomationsDenied(deps, principal, capability, "STEP_UP_REQUIRED");
      throwStepUpRequired(capability);
    }
  }
}

export interface LockedActorSummary {
  id: number;
  publicId: string;
  role: UserRole;
  status: UserStatus;
}

export async function assertAutomationsActorInTx(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  tx: Tx,
  capability: AutomationsCheckedCapability,
  extraLockUserIds: readonly number[] = [],
): Promise<Map<number, LockedActorSummary>> {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }

  const idsToLock = [...new Set([principal.userId, ...extraLockUserIds])].sort((a, b) => a - b);
  const lockedRows = await tx
    .select({
      id: users.id,
      publicId: users.publicId,
      role: users.role,
      status: users.status,
    })
    .from(users)
    .where(inArray(users.id, idsToLock))
    .orderBy(asc(users.id))
    .for("update");

  const lockedMap = new Map<number, LockedActorSummary>();
  for (const row of lockedRows) {
    lockedMap.set(row.id, row);
  }

  const actor = lockedMap.get(principal.userId);
  if (!actor || actor.status !== "active") {
    throw forbidden("ACTOR_NOT_ACTIVE");
  }
  if (!roleHasCapability(actor.role, capability)) {
    throw forbidden("ACTOR_CAPABILITY_REVOKED");
  }

  const now = deps.clock.now();
  let effectiveStepUpAt: Date | null = principal.stepUpAt;

  const identity = (deps.services.identity ?? {}) as unknown as IdentitySessionsPeer;
  if (identity.sessions?.assertCurrent) {
    const liveSession = await identity.sessions.assertCurrent(principal, tx);
    if (liveSession.pendingSteps.length > 0) {
      throw new DomainError(
        "REMEDIATION_REQUIRED",
        "ACCOUNT_STEP_PENDING",
        "Please finish securing your account to continue.",
      );
    }
    if (!roleHasCapability(liveSession.role, capability)) {
      throw forbidden("ACTOR_CAPABILITY_REVOKED");
    }
    effectiveStepUpAt = liveSession.stepUpAt;
  }

  if (STEP_UP_CAPABILITIES.has(capability) && !isFreshStepUp(effectiveStepUpAt, now)) {
    throwStepUpRequired(capability);
  }

  return lockedMap;
}

export type { DbOrTx };
