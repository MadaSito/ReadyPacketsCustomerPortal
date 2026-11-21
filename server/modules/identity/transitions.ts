/**
 * THE single account-transition service (architecture §4.3, master prompt §5).
 *
 * Derives the ordered list of incomplete prerequisites from AUTHORITATIVE state only (the users row and
 * assurance.getAssuranceState). Nothing in the browser, the URL or a previous response can advance a
 * step. The client renders `nextStep` (= pendingSteps[0]); completing a step simply re-derives.
 *
 * MFA is mandatory for every role in this rebuild (local TOTP via assurance).
 */
import type { ModuleDeps } from "../../container.js";
import type { DbOrTx } from "../../core/types.js";
import { TRANSITION_STEPS, type AuthMethod, type TransitionStep } from "../../../shared/domain.js";

export interface TransitionFacts {
  emailVerified: boolean;
  mustChangePassword: boolean;
  mfaEnrolled: boolean;
  recoveryCodesAcknowledged: boolean;
  /** The current session has passed an MFA challenge (or proved possession during enrollment). */
  sessionMfaVerified: boolean;
  /**
   * The session was established through Entra ID and its multi-factor assertion was trusted at sign-in
   * (decision 4). Such a session does not need a LOCAL factor — unless a forced password change is pending
   * (host recovery), which always requires local enrolment.
   */
  entraMfaSession?: boolean;
}

/** Pure derivation — every ordering is unit tested. Output order always follows TRANSITION_STEPS. */
export function deriveSteps(facts: TransitionFacts): TransitionStep[] {
  const pending = new Set<TransitionStep>();
  if (!facts.emailVerified) pending.add("verify_email");
  if (facts.mfaEnrolled && !facts.sessionMfaVerified) pending.add("mfa_challenge");
  const entraWaiver = facts.entraMfaSession === true && facts.sessionMfaVerified && !facts.mustChangePassword;
  if (!facts.mfaEnrolled && !entraWaiver) pending.add("enroll_mfa");
  if (facts.mfaEnrolled && !facts.recoveryCodesAcknowledged && !entraWaiver) pending.add("acknowledge_recovery_codes");
  if (facts.mustChangePassword) pending.add("change_password");
  return TRANSITION_STEPS.filter((step) => pending.has(step));
}

export function createTransitionService(deps: ModuleDeps) {
  return {
    async facts(
      user: { id: number; emailVerifiedAt: Date | null; mustChangePassword: boolean },
      session: { mfaVerifiedAt: Date | null; authMethod?: AuthMethod } | undefined,
      tx?: DbOrTx,
    ): Promise<TransitionFacts> {
      // Fail closed: if assurance state cannot be read, this throws and the caller refuses the session/action.
      const assurance = await deps.services.assurance.getAssuranceState(user.id, tx);
      return {
        emailVerified: user.emailVerifiedAt !== null,
        mustChangePassword: user.mustChangePassword,
        mfaEnrolled: assurance.mfaEnrolled === true,
        recoveryCodesAcknowledged: assurance.recoveryCodesAcknowledged === true,
        sessionMfaVerified: session?.mfaVerifiedAt !== null && session?.mfaVerifiedAt !== undefined,
        entraMfaSession: session?.authMethod === "entra",
      };
    },
    async derive(
      user: { id: number; emailVerifiedAt: Date | null; mustChangePassword: boolean },
      session: { mfaVerifiedAt: Date | null; authMethod?: AuthMethod } | undefined,
      tx?: DbOrTx,
    ): Promise<TransitionStep[]> {
      return deriveSteps(await this.facts(user, session, tx));
    },
  };
}
export type TransitionService = ReturnType<typeof createTransitionService>;
