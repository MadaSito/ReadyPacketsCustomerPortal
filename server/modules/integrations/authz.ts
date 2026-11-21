/**
 * Zero-trust authorization helper for privileged `integrations` mutations.
 *
 * Enforces BOTH:
 *  1. Immediate pre-check on the verified `SessionPrincipal` (full session, capability, fresh step-up).
 *  2. Fail-closed authoritative in-transaction re-validation via `services.identity.sessions.assertCurrent(principal, tx)`
 *     — locking the actor's user + session rows FOR UPDATE so a revoked session, suspended actor, demoted role,
 *     or expired step-up cannot complete a write. Refuses with `ACTOR_UNVERIFIABLE` if the Identity API is absent,
 *     and computes persisted step-up freshness AFTER `assertCurrent` resolves its locks (PW-06).
 *
 * Lock-order note (PW-05 / BUILD_CONTRACT):
 *  Mutations on an existing order MUST acquire the order-only lock FIRST (`orders.assertCanReadOrder(..., { tx, forUpdate: true })`)
 *  before calling `assertProductionTriggerInTx` / `assertProductionResendInTx`.
 */
import { roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { STEP_UP_MAX_AGE_MS, hasFreshStepUp } from "../../trpc/trpc.js";

function requireAssertCurrent(deps: ModuleDeps) {
  const sessions = deps.services.identity?.sessions;
  const assertCurrent = sessions?.assertCurrent;
  if (typeof assertCurrent !== "function") {
    throw forbidden("ACTOR_UNVERIFIABLE");
  }
  return { sessions: sessions!, assertCurrent };
}

export function assertAdminStepUpAnyPreflight(
  principal: SessionPrincipal,
  now: Date,
  capabilities: readonly Capability[],
): void {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
  if (principal.role !== "admin" || !capabilities.some((cap) => roleHasCapability(principal.role, cap))) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
  if (!hasFreshStepUp(principal, now)) {
    throw new DomainError(
      "STEP_UP_REQUIRED",
      "STEP_UP_REQUIRED",
      "Please confirm your password and authentication code to continue.",
      { capability: capabilities[0] ?? "integrations.manage" },
    );
  }
}

export async function assertAdminStepUpAnyInTx(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  tx: Tx,
  capabilities: readonly Capability[],
): Promise<void> {
  assertAdminStepUpAnyPreflight(principal, deps.clock.now(), capabilities);

  const { sessions, assertCurrent } = requireAssertCurrent(deps);
  const current = await assertCurrent.call(sessions, principal, tx);
  const postLockNow = deps.clock.now();

  if (current.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
  if (
    current.role !== principal.role ||
    current.role !== "admin" ||
    !capabilities.some((cap) => roleHasCapability(current.role, cap))
  ) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
  const stepUpAge = current.stepUpAt ? postLockNow.getTime() - current.stepUpAt.getTime() : -1;
  if (!(stepUpAge >= 0 && stepUpAge <= STEP_UP_MAX_AGE_MS)) {
    throw new DomainError(
      "STEP_UP_REQUIRED",
      "STEP_UP_REQUIRED",
      "Please confirm your password and authentication code to continue.",
      { capability: capabilities[0] ?? "integrations.manage" },
    );
  }
}

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
  assertIntegrationsManagePreflight(principal, deps.clock.now());

  const { sessions, assertCurrent } = requireAssertCurrent(deps);
  const current = await assertCurrent.call(sessions, principal, tx);
  const postLockNow = deps.clock.now();

  if (current.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
  if (current.role !== principal.role || !roleHasCapability(current.role, "integrations.manage")) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
  const stepUpAge = current.stepUpAt ? postLockNow.getTime() - current.stepUpAt.getTime() : -1;
  if (!(stepUpAge >= 0 && stepUpAge <= STEP_UP_MAX_AGE_MS)) {
    throw new DomainError(
      "STEP_UP_REQUIRED",
      "STEP_UP_REQUIRED",
      "Please confirm your password and authentication code to continue.",
      { capability: "integrations.manage" },
    );
  }
}

export function assertProductionTriggerPreflight(principal: SessionPrincipal): void {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
  if (!roleHasCapability(principal.role, "orders.production.trigger")) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
}

export async function assertProductionTriggerInTx(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  tx: Tx,
): Promise<void> {
  assertProductionTriggerPreflight(principal);

  const { sessions, assertCurrent } = requireAssertCurrent(deps);
  const current = await assertCurrent.call(sessions, principal, tx);
  if (current.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
  if (current.role !== principal.role || !roleHasCapability(current.role, "orders.production.trigger")) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
}

export function assertProductionResendPreflight(principal: SessionPrincipal, now: Date): void {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
  if (principal.role !== "admin" || !roleHasCapability(principal.role, "orders.production.trigger")) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
  if (!hasFreshStepUp(principal, now)) {
    throw new DomainError(
      "STEP_UP_REQUIRED",
      "STEP_UP_REQUIRED",
      "Please confirm your password and authentication code to re-send a production webhook.",
      { capability: "orders.production.trigger" },
    );
  }
}

export async function assertProductionResendInTx(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  tx: Tx,
): Promise<void> {
  assertProductionResendPreflight(principal, deps.clock.now());

  const { sessions, assertCurrent } = requireAssertCurrent(deps);
  const current = await assertCurrent.call(sessions, principal, tx);
  const postLockNow = deps.clock.now();

  if (current.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
  if (
    current.role !== principal.role ||
    current.role !== "admin" ||
    !roleHasCapability(current.role, "orders.production.trigger")
  ) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
  const stepUpAge = current.stepUpAt ? postLockNow.getTime() - current.stepUpAt.getTime() : -1;
  if (!(stepUpAge >= 0 && stepUpAge <= STEP_UP_MAX_AGE_MS)) {
    throw new DomainError(
      "STEP_UP_REQUIRED",
      "STEP_UP_REQUIRED",
      "Please confirm your password and authentication code to re-send a production webhook.",
      { capability: "orders.production.trigger" },
    );
  }
}
