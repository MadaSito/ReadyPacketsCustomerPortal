# Assurance module API

This module owns enrolled factors, pending authenticator setup, WebAuthn ceremonies and recovery-code state. Identity remains authoritative for sessions, credential hashes, password policy and transition ordering. Browser secrets are returned only by the mutation that creates them, never by a read query. All operations derive their account from the session except explicitly scoped credential administration.

## Service contracts

- `getAssuranceState(userId: number, tx?: Tx): Promise<AssuranceState>`, where `AssuranceState` has `mfaEnrolled`, `recoveryCodesAcknowledged`, `passkeyCount` and `totpEnrolled`.
- `verifySecondFactor(userId: number, input: SecondFactorInput, options?: { sessionId?: string; purpose?: "challenge" | "step_up" }): Promise<boolean>`. TOTP and recovery code proof are consumed atomically. A passkey proof must match the session and ceremony purpose.
- `resetSecondFactors(userId: number, tx: Tx): Promise<void>` removes all factors, codes and pending ceremonies. The identity caller owns revocation and audit for its enclosing operation.

## tRPC procedures

| Procedure | Input and output | Guard |
| --- | --- | --- |
| `getState` | none → `AssuranceState & { recoveryCodesRemaining: number }` | session, own state only |
| `beginTotpEnrollment` | none → `{ secret, otpauthUri, qrDataUrl }` | remediation `enroll_mfa`, or full + fresh step-up |
| `confirmTotpEnrollment` | `{ code }` → `{ recoveryCodes: string[] \| null }` | same as beginning; same session, unexpired |
| `acknowledgeRecoveryCodes` | none → `{ ok: true }` | remediation `acknowledge_recovery_codes`, or full; durable explicit action |
| `recoverUnacknowledgedCodes` | `{ factor: { method: "totp", code } }` → `{ recoveryCodes: string[] }` | remediation `acknowledge_recovery_codes` with valid new TOTP |
| `beginPasskeyAuthentication` | `{ purpose: "challenge" \| "step_up" }` → `{ challengeId, options }` | corresponding challenge remediation or full |
| `challenge` | `SecondFactorInput` → `{ ok: true }` | remediation `mfa_challenge`; marks MFA and rotates |
| `stepUp` | `{ password, factor: SecondFactorInput }` → `{ ok: true }` | full; password and factor; records fresh assurance |
| `regenerateRecoveryCodes` | none → `{ recoveryCodes: string[] }` | full + fresh step-up |
| `disableTotp` | none → `{ ok: true }` | full + fresh step-up and at least one passkey remains |
| `listPasskeys` | none → `{ publicId, name, createdAt, lastUsedAt }[]` | full |
| `beginPasskeyRegistration` | none → `{ challengeId, options }` | full + fresh step-up |
| `finishPasskeyRegistration` | `{ challengeId, response, name }` → `{ ok: true }` | full + fresh step-up |
| `renamePasskey` | `{ publicId, name }` → `{ ok: true }` | full + fresh step-up, own credential only |
| `removePasskey` | `{ publicId }` → `{ ok: true }` | full + fresh step-up, own credential only and at least one other enrolled factor remains |
| `admin.setCredential` | `{ customerId, mode: "email_link" \| "generate_temporary" }` or `{ customerId, mode: "enter_temporary", password }` → `{ ok: true, temporaryPassword?: string }` | full + `customers.credentials.administer` + fresh step-up |
| `admin.resetMfa` | `{ customerId }` → `{ ok: true }` | same administration gate |

`SecondFactorInput` is `{ method: "totp" | "recovery_code", code }` or `{ method: "passkey", challengeId, response: AuthenticationResponseJSON }`. Passkey options are SimpleWebAuthn JSON for `optionsJSON`. Passwordless sign-in is not on this API. No raw HTTP routes, feature flags, or administrator settings keys.
