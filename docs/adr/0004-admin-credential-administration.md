# 0004 — Administrator credential administration modes

Status: Accepted (2026-11-20)

## Context
The master prompt requires: "Every method enforces the same policy, correct local/SSO boundary, step-up, forced
next-login change, session revocation, and secret-free audit."

## Decision
Three modes are offered to authorised staff: generate a temporary password, set a temporary password, or send a
reset link. In every mode, at initiation: the actor must hold the capability and a fresh step-up; the target's
sessions are revoked; `mustChangePassword` is set; the audit record contains no secret. Temporary-password modes
keep the flag until the user chooses a new password. Redeeming an e-mailed link is itself the user-chosen change
and clears the flag. Accounts governed by an external identity provider are refused.

## Consequences
- An administrator never learns a user's lasting password.
- A generated temporary password is shown once and is not retrievable afterwards.
