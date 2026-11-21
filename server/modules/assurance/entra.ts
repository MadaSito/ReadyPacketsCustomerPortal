import type { ModuleDeps } from "../../container.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { assertCurrent, badProof, requireFull } from "./policy.js";

export const ENTRA_REAUTH_MAX_AGE_MS = 5 * 60_000;

/** Called only after Identity has validated the ID token and current provider configuration. */
export function assessEntraSignIn(amr: readonly string[] | undefined, trustEntraMfa: boolean): { mfaVerified: boolean } {
  return { mfaVerified: trustEntraMfa === true && amr?.includes("mfa") === true };
}

export interface EntraStepUpProof {
  readonly amr: readonly string[] | undefined;
  readonly trustEntraMfa: boolean;
  /** OIDC NumericDate (seconds), from the verified token, not its issuance time. */
  readonly authTime: number;
  /** Server-held creation time of the one-time `max_age=0` request. */
  readonly requestedAt: Date;
}

export function isFreshEntraAuthentication(authTime: number, requestedAt: Date, now: Date): boolean {
  const requestMs = requestedAt.getTime();
  const nowMs = now.getTime();
  // NumericDate has second resolution. A token issued in the request's second is admissible;
  // do not allow any additional pre-request skew or substitute iat for auth_time.
  return Number.isSafeInteger(authTime) && authTime > 0 && nowMs >= requestMs
    && nowMs - requestMs <= ENTRA_REAUTH_MAX_AGE_MS
    && authTime >= Math.floor(requestMs / 1000) && authTime <= Math.floor(nowMs / 1000);
}

export function createEntraAssurance(deps: ModuleDeps) {
  return {
    assessEntraSignIn,
    /**
     * Internal callback only. Identity must first validate signature, issuer, tenant, audience and nonce,
     * atomically consume state, and match the linked identity and original full portal session/user.
     */
    async completeEntraStepUp(principal: SessionPrincipal, proof: EntraStepUpProof, tx: Tx) {
      requireFull(principal);
      if (principal.authMethod !== "entra" ||
          !assessEntraSignIn(proof.amr, proof.trustEntraMfa).mfaVerified ||
          !isFreshEntraAuthentication(proof.authTime, proof.requestedAt, deps.clock.now())) throw badProof();
      await assertCurrent(deps, principal, tx);
      // Read the deadline again after taking the session lock.
      if (!isFreshEntraAuthentication(proof.authTime, proof.requestedAt, deps.clock.now())) throw badProof();
      await deps.audit.record({
        category: "security", eventName: "auth.step_up.verified", action: "authenticate", outcome: "completed",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "user", publicId: principal.userPublicId },
        provider: "entra", attributes: { auth_method: "entra" },
      }, tx);
      return deps.services.identity.sessions.markStepUp(principal.sessionId, { tx });
    },
  };
}
