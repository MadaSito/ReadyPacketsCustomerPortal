/**
 * Knowledge Base — zero-trust authorization helpers (preflight + in-transaction actor lock).
 * Re-validates live user status, role, capability, session validity, and MFA step-up inside write transactions.
 */
import { sql } from "drizzle-orm";
import {
  roleHasCapability,
  STEP_UP_CAPABILITIES,
  type Capability,
} from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";

const unauthenticatedErr = () =>
  new DomainError("UNAUTHENTICATED", "UNAUTHENTICATED", "Authentication required.");
const remediationErr = () =>
  new DomainError(
    "REMEDIATION_REQUIRED",
    "REMEDIATION_REQUIRED",
    "Complete account security steps first.",
  );
const stepUpErr = () =>
  new DomainError(
    "STEP_UP_REQUIRED",
    "STEP_UP_REQUIRED",
    "Please complete step-up verification to continue.",
  );

function extractMysqlRows<T>(res: unknown): T[] {
  if (Array.isArray(res)) {
    return (Array.isArray(res[0]) ? res[0] : res) as T[];
  }
  if (res && typeof res === "object" && "rows" in res) {
    return (res as { rows: T[] }).rows;
  }
  return [];
}

async function recordDenied(
  deps: Pick<ModuleDeps, "audit">,
  principal: SessionPrincipal | null | undefined,
  reasonCode: string,
  capability: string,
): Promise<void> {
  await deps.audit.record({
    category: "security",
    eventName: "authz.knowledge.denied",
    action: capability,
    outcome: "denied",
    actor: principal ? { userId: principal.userId, role: principal.role } : { role: "anonymous" },
    reasonCode,
  });
}

export async function assertKnowledgeFullSession(
  deps: Pick<ModuleDeps, "audit">,
  principal: SessionPrincipal | null | undefined,
): Promise<SessionPrincipal> {
  if (!principal) {
    await recordDenied(deps, null, "UNAUTHENTICATED", "knowledge.read");
    throw unauthenticatedErr();
  }
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    await recordDenied(deps, principal, "SESSION_REMEDIATION_REQUIRED", "knowledge.read");
    throw remediationErr();
  }
  return principal;
}

export async function assertKnowledgeCapabilityPreflight(
  deps: Pick<ModuleDeps, "audit" | "clock">,
  principal: SessionPrincipal | null | undefined,
  capability: Capability,
): Promise<SessionPrincipal> {
  if (!principal) {
    await recordDenied(deps, null, "UNAUTHENTICATED", capability);
    throw unauthenticatedErr();
  }
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    await recordDenied(deps, principal, "SESSION_REMEDIATION_REQUIRED", capability);
    throw remediationErr();
  }
  if (principal.role !== "admin" && principal.role !== "staff") {
    await recordDenied(deps, principal, "STAFF_ROLE_REQUIRED", capability);
    throw forbidden("STAFF_ROLE_REQUIRED");
  }
  if (!roleHasCapability(principal.role, capability)) {
    await recordDenied(deps, principal, "MISSING_CAPABILITY", capability);
    throw forbidden("MISSING_CAPABILITY");
  }
  if (STEP_UP_CAPABILITIES.has(capability)) {
    const nowMs = deps.clock.now().getTime();
    if (!principal.stepUpAt || nowMs - principal.stepUpAt.getTime() > STEP_UP_MAX_AGE_MS) {
      await recordDenied(deps, principal, "STEP_UP_REQUIRED", capability);
      throw stepUpErr();
    }
  }
  return principal;
}

export async function assertKnowledgeActorInTx(
  deps: Pick<ModuleDeps, "clock" | "services">,
  principal: SessionPrincipal,
  tx: Tx,
  capability?: Capability,
): Promise<void> {
  const raw = await tx.execute(
    sql`SELECT id, role, status FROM users WHERE id = ${principal.userId} FOR UPDATE`,
  );
  const rows = extractMysqlRows<{ id: number; role: string; status: string }>(raw);
  const actorRow = rows[0];
  if (!actorRow || actorRow.status !== "active") {
    throw forbidden("ACTOR_INACTIVE");
  }

  if (capability) {
    if (actorRow.role !== "admin" && actorRow.role !== "staff") {
      throw forbidden("STAFF_ROLE_REQUIRED");
    }
    if (!roleHasCapability(actorRow.role as SessionPrincipal["role"], capability)) {
      throw forbidden("MISSING_CAPABILITY");
    }
  }

  let verifiedStepUpAt: Date | null = principal.stepUpAt;
  const sessionsSvc = (
    deps.services as unknown as {
      identity?: {
        sessions?: {
          assertCurrent?: (
            p: SessionPrincipal,
            t: Tx,
          ) => Promise<{ stepUpAt: Date | null; pendingSteps: readonly string[] }>;
        };
      };
    }
  ).identity?.sessions;

  if (sessionsSvc?.assertCurrent) {
    const live = await sessionsSvc.assertCurrent(principal, tx);
    if (live.pendingSteps.length > 0) {
      throw remediationErr();
    }
    verifiedStepUpAt = live.stepUpAt;
  }

  if (capability && STEP_UP_CAPABILITIES.has(capability)) {
    const nowMs = deps.clock.now().getTime();
    if (!verifiedStepUpAt || nowMs - verifiedStepUpAt.getTime() > STEP_UP_MAX_AGE_MS) {
      throw stepUpErr();
    }
  }
}
