# Assurance module API

This module owns enrolled factors, pending authenticator setup, WebAuthn ceremonies and recovery-code state. Identity remains authoritative for sessions, credential hashes, password policy and transition ordering. Browser secrets are returned only by the mutation that creates them, never by a read query. All operations derive their account from the session except explicitly scoped credential administration.

## Service contracts

- `getAssuranceState(userId: number, tx?: DbOrTx): Promise<AssuranceState>`, where `AssuranceState` has `mfaEnrolled`, `recoveryCodesAcknowledged`, `passkeyCount` and `totpEnrolled`.
- `verifySecondFactor(userId: number, input: SecondFactorInput, options?: { sessionId?: string; purpose?: "challenge" | "step_up" | "recovery_reissue" }): Promise<boolean>`. TOTP and recovery code proof are consumed atomically. A passkey proof must match the session and ceremony purpose.
- `assessEntraSignIn(amr: readonly string[] | undefined, trustEntraMfa: boolean): { mfaVerified: boolean }` accepts only claims from a validated ID token. Exact `mfa` membership and explicit trust are both required; otherwise Identity derives the local enrollment or challenge.
- `completeEntraStepUp(principal, { amr, trustEntraMfa, authTime, requestedAt }, tx)` is internal to the verified OIDC callback. Before calling, Identity must bind purpose, browser, current portal session and exact linked tenant/object, and consume state once. Assurance requires a full Entra session, trusted `mfa`, and OIDC `auth_time` between the request second and the current second within five minutes of initiation. It revalidates the current session under lock, records durable audit, and rotates the session. An ordinary SSO sign-in never marks a session stepped up.
- `lockLocalAdministratorPolicy(tx)` serializes all changes that may reduce local administrator coverage. Call it before any user, session or factor row locks in those transactions. Identity supplies locking reads of active, email-verified local administrators with a password; Assurance counts an enrolled TOTP below the permanent cap or a registered passkey as a locally usable factor. `assertLocalAdministratorRemains(tx, excludingUserId?)` is the strict SSO-enable gate; `assertLocalAdministratorMayLoseAccess(tx, userId)` blocks any reduction that would remove the last eligible account.
- `breakGlassHealth()` is read-only and exposes `{ localMfaAdministrators, soleLocalMfaAdministratorHasPasskey }` without operator identities. The latter is `null` unless exactly one eligible administrator exists.
- `resetSecondFactors(userId: number, tx: Tx): Promise<void>` removes all factors, codes and pending ceremonies. The caller must already hold the policy lock and owns revocation and audit. A reset that would remove the last locally usable administrator is refused.

## tRPC procedures

| Procedure | Input and output | Guard |
| --- | --- | --- |
| `getState` | none → `AssuranceState & { recoveryCodesRemaining: number }` | session, own state only |
| `beginTotpEnrollment` | none → `{ secret, otpauthUri, qrDataUrl }` | remediation `enroll_mfa`, or full + fresh step-up |
| `confirmTotpEnrollment` | `{ code }` → `{ recoveryCodes: string[] \| null, recoverySetId: string \| null }` | same as beginning; same session, unexpired; initial confirmation marks MFA and rotates |
| `acknowledgeRecoveryCodes` | `{ recoverySetId }` → `{ ok: true }` | remediation `acknowledge_recovery_codes`, or full; durable explicit action tied to the displayed set |
| `recoverUnacknowledgedCodes` | `{ factor: TotpFactor \| PasskeyFactor }` → `{ recoveryCodes: string[], recoverySetId: string }` | remediation `acknowledge_recovery_codes` with valid new authenticator-app or passkey proof |
| `beginPasskeyAuthentication` | `{ purpose: "challenge" \| "step_up" \| "recovery_reissue" }` → `{ challengeId, options }` | corresponding challenge/acknowledgment remediation or full session step-up |
| `challenge` | `SecondFactorInput` → `{ ok: true }` | remediation `mfa_challenge`; marks MFA and rotates |
| `stepUp` | `{ password?, factor: SecondFactorInput }` → `{ ok: true }` | full; local sessions require the password and an allowed factor; Entra sessions may provide a fresh local passkey or TOTP without a password, but not a recovery code |
| `regenerateRecoveryCodes` | none → `{ recoveryCodes: string[], recoverySetId: string }` | full + fresh step-up |
| `disableTotp` | none → `{ ok: true }` | full + fresh step-up and at least one passkey remains |
| `listPasskeys` | none → `{ publicId, name, createdAt, lastUsedAt }[]` | full |
| `beginPasskeyRegistration` | none → `{ challengeId, options }` | full + fresh step-up |
| `finishPasskeyRegistration` | `{ challengeId, response, name }` → `{ ok: true }` | full + fresh step-up |
| `renamePasskey` | `{ publicId, name }` → `{ ok: true }` | full + fresh step-up, own credential only |
| `removePasskey` | `{ publicId }` → `{ ok: true }` | full + fresh step-up, own credential only and at least one other enrolled factor remains |
| `admin.setCredential` | `{ customerId, mode: "email_link" \| "generate_temporary" }` or `{ customerId, mode: "enter_temporary", password }` → `{ ok: true, temporaryPassword?: string }` | full + `customers.credentials.administer` + fresh step-up |
| `admin.resetMfa` | `{ customerId }` → `{ ok: true }` | same administration gate |

`SecondFactorInput` is `{ method: "totp" | "recovery_code", code }` or `{ method: "passkey", challengeId, response: AuthenticationResponseJSON }`. Passkey options are SimpleWebAuthn JSON for `optionsJSON`. A recovery-code batch is not retrievable through a read procedure. The browser may hand it off to the acknowledgment screen in memory only, outside of durable storage and the query cache.

Enrolled TOTP verification counts consecutive failed or replayed proofs across sessions under the account row lock. From the tenth failure, delays double from 30 seconds to a maximum of one hour. After 50 failures, the existing authenticator app remains blocked until it is replaced after fresh step-up with an available alternate factor, or through the authorized MFA reset flow. The one exception is when a permanent block would strand the last usable local administrator: keep one attempt per hour instead and record `auth.totp.locked` at `ERROR` with reason `LOCAL_MFA_ADMIN_COOLDOWN`. Proofs refused during a cooldown do not extend it; a valid TOTP proof clears the failure count. TOTP lockout does not itself block passkey or recovery-code use where already permitted. Initial setup confirmation is separate: it checks a short-lived setup secret displayed only to the authorized initiating session.

Admin email mode requires a verified address and a ready selected sender and mail route via `services.jobAdmin.getMailReadiness()`. `admin.mailReadiness` exposes only `{ ready: boolean }` to staff with credential-administration capability; this preflight does not confirm connectivity or delivery. Email mode queues the set-password email, clears the previous password hash, revokes sessions, and marks the account for a password change in one transaction. Link redemption sets the user’s chosen password and clears the flag. The two temporary-password modes revoke sessions and require the user to choose their own password after satisfying MFA at the next sign-in. The administrator receives plaintext only in the generated-password response, never in an email-link response.

## Audit, jobs and notifications

Security events: `auth.totp.{enrollment_started,enrollment_denied,enrolled,replaced,disabled,replay_denied,locked}`, `auth.recovery_code.redeemed`, `auth.recovery_codes.{acknowledged,regenerated,reissued,reissue_denied}`, `auth.mfa.{verified,challenge_denied}`, `auth.step_up.{verified,denied}`, `auth.passkey.{registered,registration_denied,manage_denied,renamed,removed,counter_regression}`, `admin.credentials.denied`, and sampled `auth.rate_limited`. Admin-category events: `admin.credentials.{set_link_queued,temporary_generated,temporary_set,mfa_reset}`. The first TOTP cooldown and the final lock commit with the corresponding audit event and a fixed, secret-free in-app notification. Identity owns the `auth.admin_set_password` mail template and token redemption.

`assurance.prune_ceremonies` removes expired WebAuthn challenges and clears expired staged TOTP secrets in bounded batches every 15 minutes. Expiration is enforced synchronously regardless of job availability.
