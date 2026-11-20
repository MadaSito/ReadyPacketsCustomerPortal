# 0003 — Local accounts with mandatory TOTP; passkeys as an additional factor

Status: Accepted (2026-11-20)

## Context
Project instructions require local authentication with multi-factor authentication until other identity
providers are configured, and prohibit vendor OAuth. NIST SP 800-63B-4 guidance is the reference for
authenticator handling.

## Decision
- Passwords are hashed with Argon2id; length-based policy with a breached/common-password screen; no
  composition rules; no periodic rotation.
- A session is not fully authenticated until a second factor is verified. First enrolment is TOTP (RFC 6238)
  with single-use recovery codes. Passkeys (WebAuthn) may be added afterwards. TOTP may be removed only from a
  fully authenticated session with a fresh step-up while another strong factor remains.
- Sensitive actions require a fresh step-up (re-verification within ten minutes); timestamps in the future or
  unparsable are rejected.
- SAML single sign-on exists only as a disabled scaffold that reports "not configured".

## Consequences
- An account without an authenticator app cannot complete enrolment. Recovery is by recovery code or by an
  administrator-initiated reset (ADR 0004).
