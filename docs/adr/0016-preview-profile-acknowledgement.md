# 0016 — The preview profile requires an explicit synthetic-data acknowledgement

Status: Accepted (2026-11-20). Extends 0002.

## Context
The hosted preview runs inside a frame without cookies, so it uses an in-memory header session and relaxed
host, framing and CORS rules (ADR 0002). Those relaxations must never reach a system holding customer data.

## Decision
- `RP_DEPLOYMENT_PROFILE=preview` starts only when `RP_PREVIEW_ACKNOWLEDGED` equals the exact string
  `synthetic-data-only`, and never when the canonical origin is under `readypackets.com`.
- The presentation payload carries a `preview` flag; the client shows a permanent, non-dismissible banner.
- Mail capture exists only in development and test. Preview may return a one-time link in a response only in
  three cases: the registration response's own verification link, an authenticated user's own resend, and an
  administrator-initiated link returned to that administrator. A password-reset link is never returned in a
  public response in any profile.

## Consequences
A preview deployment is a demonstration with seeded synthetic accounts. It is not evidence of production
behaviour for cookies, CSRF, host validation or TLS.
