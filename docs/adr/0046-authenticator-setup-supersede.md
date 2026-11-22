# 0046 — Authenticator setup: a newer sign-in replaces an abandoned setup

Status: Accepted (2026-11-22; requested by the owner as a defect fix)

## Context
Authenticator (TOTP) setup stages a secret for ten minutes and binds it to the session that started it. Until this change, a second session of the same account that tried to start setup while a staged secret was still live was refused with "An authenticator setup is already in progress". A person who closed the browser, lost the tab or signed in again on another device was locked out of setup for up to ten minutes, and the message did not say for how long. The owner reported this as "the authenticator setup screen locks".

The refusal was a deliberate control: it stopped a second holder of the password from displacing a setup in progress. In practice it protected little. Before any second factor exists the password is the only proof, so the second holder could start setup as soon as the ten minutes ran out, and the refusal favoured whoever arrived first, not the rightful owner.

## Decision
- **Same session resumes.** The session that started a live setup gets the same secret and QR code again.
- **A different session replaces.** Any other session of the same account that starts setup gets a new secret. The earlier staged secret is discarded and is never shown to the new session. The replacement is recorded as `auth.totp.enrollment_superseded` (WARN, reason `TOTP_SETUP_SUPERSEDED`) together with the usual `auth.totp.enrollment_started`.
- **A stale setup says so.** Confirming a setup that has expired (including one already removed by the clean-up job) or was replaced is refused before the code is examined, with `CONFLICT` and reason `TOTP_SETUP_EXPIRED` or `TOTP_SETUP_REPLACED`, and is recorded as `auth.totp.enrollment_denied`. These reasons are only reachable by a signed-in session of the account that holds a staged setup, so they reveal nothing about other accounts.
- **The setup page recovers by itself.** On either reason it requests a new setup, shows the new QR code, clears the code field, moves focus to an announced message that says what happened and what to do (remove the earlier entry from the authenticator app, scan the new code), and states under the setup key that the QR code works for ten minutes.
- Unchanged: the ten-minute lifetime, the session binding of the staged secret, per-account throttling of wrong codes, the rule that an account with an authenticator can only replace it after step-up, and the generic refusal when there is no staged setup at all.

## Consequences
- Nobody has to wait to restart setup.
- Two people who both hold the password of an account without a second factor can displace each other's setup. Only the last one to start can finish, each replacement is audited at WARN, and the account owner sees the "replaced" message. The real defence against a stolen password before enrolment remains the activation and password-reset controls, not the setup lock.
- A person who scanned the first QR code keeps a dead entry in the authenticator app; the message tells them to remove it.

## Verification
Unit tests in `server/modules/assurance/assurance.test.ts` (replacement issues a different secret and audits it; stale confirmation reasons; the old secret cannot be confirmed by either session) and `client/src/features/auth/auth.test.tsx` (new QR code, message, focus, no accessibility violations).
