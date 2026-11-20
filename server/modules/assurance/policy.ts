import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden } from "../../core/errors.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import type { TransitionStep } from "../../../shared/domain.js";

export function isFull(principal: SessionPrincipal): boolean {
  return principal.state === "full" && principal.pendingSteps.length === 0;
}

export function requireTransition(principal: SessionPrincipal, step: TransitionStep): void {
  if (principal.state !== "remediation" || principal.pendingSteps[0] !== step)
    throw forbidden("TRANSITION_NOT_PERMITTED");
}

export function requireFull(principal: SessionPrincipal): void {
  if (!isFull(principal)) throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Finish securing your account to continue.");
}

export function requireFresh(principal: SessionPrincipal, now: Date): void {
  requireFull(principal);
  const age = principal.stepUpAt ? +now - +principal.stepUpAt : Number.NaN;
  if (!(age >= 0 && age <= STEP_UP_MAX_AGE_MS)) {
    throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Confirm your password and second factor to continue.");
  }
}

export async function assertCurrent(deps: ModuleDeps, principal: SessionPrincipal, tx: Tx): Promise<void> {
  const { pendingSteps } = await deps.services.identity.sessions.assertCurrent(principal, tx);
  if (pendingSteps.length !== principal.pendingSteps.length
    || pendingSteps.some((step, i) => principal.pendingSteps[i] !== step))
    throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_CHANGED", "Your account security state changed. Refresh to continue.");
}

export function badProof(): DomainError {
  return new DomainError("UNAUTHENTICATED", "AUTHENTICATION_PROOF_INVALID", "The authentication information was invalid or already used.");
}

/** A stable per-account budget prevents bypass by distributing requests across different sessions. */
export async function throttle(deps: ModuleDeps, userId: number): Promise<void> {
  const key = deps.crypto.blindIndex(String(userId), "assurance-rate-limit");
  const rate = await deps.rateLimiter.consume("auth_high_risk", `a:${key}`);
  if (!rate.allowed)
    throw new DomainError("RATE_LIMITED", "RATE_LIMITED", "Too many attempts. Wait and try again.", { retryAfterSeconds: rate.retryAfterSeconds });
}
