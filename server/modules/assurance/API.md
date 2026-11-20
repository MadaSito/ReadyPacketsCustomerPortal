# Assurance module API

This module owns enrolled factors, pending authenticator setup, WebAuthn ceremonies and recovery-code state. Identity remains authoritative for sessions, credential hashes, password policy and transition ordering. Browser secrets are returned only by the mutation that creates them, never by a read query. All operations derive their account from the session except explicitly scoped credential administration.

## Service contracts

- `getAssuranceState(userId: number, tx?: DbOrTx): Promise<AssuranceState>`, where `AssuranceState` has `mfaEnrolled`, `recoveryCodesAcknowledged`, `passkeyCount` and `totpEnrolled`.
- `verifySecondFactor(userId: number, input: SecondFactorInput, options?: { sessionId?: string; purpose?: "challenge" | "step_up" | "recovery_reissue" }): Promise<boolean>`. TOTP and recovery code proof are consumed atomically. A passkey proof must match the session and ceremony purpose.
- `resetSecondFactors(userId: number, tx: Tx): Promise<void>` removes all factors, codes and pending ceremonies. The identity caller owns revocation and audit for its enclosing operation.

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
| `stepUp` | `{ password, factor: SecondFactorInput }` → `{ ok: true }` | full; password and factor; records fresh assurance |
| `regenerateRecoveryCodes` | none → `{ recoveryCodes: string[], recoverySetId: string }` | full + fresh step-up |
| `disableTotp` | none → `{ ok: true }` | full + fresh step-up and at least one passkey remains |
| `listPasskeys` | none → `{ publicId, name, createdAt, lastUsedAt }[]` | full |
| `beginPasskeyRegistration` | none → `{ challengeId, options }` | full + fresh step-up |
| `finishPasskeyRegistration` | `{ challengeId, response, name }` → `{ ok: true }` | full + fresh step-up |
| `renamePasskey` | `{ publicId, name }` → `{ ok: true }` | full + fresh step-up, own credential only |
| `removePasskey` | `{ publicId }` → `{ ok: true }` | full + fresh step-up, own credential only and at least one other enrolled factor remains |
| `admin.setCredential` | `{ customerId, mode: "email_link" \| "generate_temporary" }` or `{ customerId, mode: "enter_temporary", password }` → `{ ok: true, temporaryPassword?: string }` | full + `customers.credentials.administer` + fresh step-up |
| `admin.resetMfa` | `{ customerId }` → `{ ok: true }` | same administration gate |

`SecondFactorInput` is `{ method: "totp" | "recovery_code", code }` or `{ method: "passkey", challengeId, response: AuthenticationResponseJSON }`. Passkey options are SimpleWebAuthn JSON for `optionsJSON`. Passwordless sign-in is not on this API. No raw HTTP routes, feature flags, or administrator settings keys.

## Audit, jobs and notifications

Security events: `auth.totp.{enrollment_started,enrollment_denied,enrolled,replaced,disabled,replay_denied}`, `auth.recovery_code.redeemed`, `auth.recovery_codes.{acknowledged,regenerated,reissued,reissue_denied}`, `auth.mfa.{verified,challenge_denied}`, `auth.step_up.{verified,denied}`, `auth.passkey.{registered,registration_denied,manage_denied,renamed,removed,counter_regression}` and `admin.credentials.denied`. Admin-category events: `admin.credentials.{set_link_queued,temporary_generated,temporary_set,mfa_reset}`. Notifications contain fixed, secret-free text. Identity owns the `auth.admin_set_password` mail template and token redemption.

`assurance.prune_challenges` is a bounded expiry cleanup job scheduled every 15 minutes. Expiration is enforced synchronously regardless of job availability.
