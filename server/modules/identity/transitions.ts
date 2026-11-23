/**
 * THE single account-transition service (architecture §4.3, master prompt §5).
 *
 * Derives the ordered list of incomplete prerequisites from AUTHORITATIVE state only (the users row and
 * assurance.getAssuranceState). Nothing in the browser, the URL or a previous response can advance a
 * step. The client renders `nextStep` (= pendingSteps[0]); completing a step simply re-derives.
 *
 * MFA is mandatory for every role in this rebuild (local TOTP via assurance).
 */
import type { ModuleDeps, Services } from "../../container.js";
import type { DbOrTx } from "../../core/types.js";
import { TRANSITION_STEPS, type AuthMethod, type TransitionStep, type UserRole } from "../../../shared/domain.js";

/** Increment 06 D13 port (owner assurance_engineer, `server/modules/compliance/policyEnforcement*.ts`). */
export interface PolicyEnforcementPort {
  /** One cheap indexed query. false for unpublished / mode none / break-glass. Throws on DB failure (fail closed). */
  requiresRemediation(userId: number, role: UserRole, tx?: DbOrTx): Promise<boolean>;
}

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
  /** Increment 06 D13: the compliance enforcement port says a required policy must be accepted to continue. */
  policyAcceptanceRequired?: boolean;
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
  if (facts.policyAcceptanceRequired === true) pending.add("accept_policy");
  return TRANSITION_STEPS.filter((step) => pending.has(step));
}

export function createTransitionService(deps: ModuleDeps) {
  async function requiresPolicyAcceptance(user: { id: number; role?: UserRole }, tx?: DbOrTx): Promise<boolean> {
    const compliance = deps.services.compliance as (Services["compliance"] & { policyEnforcement?: PolicyEnforcementPort }) | undefined;
    if (!compliance) return false;
    const enforcement = compliance.policyEnforcement;
    if (!enforcement) throw new Error("identity.transitions: compliance.policyEnforcement is not mounted");
    if (!user.role) throw new Error("identity.transitions: role required for the policy enforcement check");
    return enforcement.requiresRemediation(user.id, user.role, tx);
  }
  return {
    async facts(
      user: { id: number; emailVerifiedAt: Date | null; mustChangePassword: boolean; role: UserRole },
      session: { mfaVerifiedAt: Date | null; authMethod?: AuthMethod } | undefined,
      tx?: DbOrTx,
    ): Promise<TransitionFacts> {
      // Fail closed: if assurance state cannot be read, this throws and the caller refuses the session/action.
      const assurance = await deps.services.assurance.getAssuranceState(user.id, tx);
      // D13: fail closed. A mounted compliance module WITHOUT the enforcement port (mount/wiring regression), a
      // missing role, or a failing port all throw ⇒ the caller refuses the session/action. Only a container with no
      // compliance module at all (isolated unit harnesses; the real container always mounts it) skips the step.
      const policyAcceptanceRequired = await requiresPolicyAcceptance(user, tx);
      return {
        policyAcceptanceRequired,
        emailVerified: user.emailVerifiedAt !== null,
        mustChangePassword: user.mustChangePassword,
        mfaEnrolled: assurance.mfaEnrolled === true,
        recoveryCodesAcknowledged: assurance.recoveryCodesAcknowledged === true,
        sessionMfaVerified: session?.mfaVerifiedAt !== null && session?.mfaVerifiedAt !== undefined,
        entraMfaSession: session?.authMethod === "entra",
      };
    },
    async derive(
      user: { id: number; emailVerifiedAt: Date | null; mustChangePassword: boolean; role: UserRole },
      session: { mfaVerifiedAt: Date | null; authMethod?: AuthMethod } | undefined,
      tx?: DbOrTx,
    ): Promise<TransitionStep[]> {
      return deriveSteps(await this.facts(user, session, tx));
    },
  };
}
export type TransitionService = ReturnType<typeof createTransitionService>;
