# 0002 — Opaque server-side sessions; preview-only header transport

Status: Accepted (2026-11-20)

## Context
Sessions must be revocable immediately, bound to assurance state, and unreadable to scripts. The hosted design
preview runs inside a sandboxed frame that has no cookies or browser storage, so the production cookie
transport cannot be exercised there.

## Decision
- Production and self-hosted profiles use an opaque random session identifier in a `__Host-` cookie
  (`Secure`, `HttpOnly`, `SameSite=Lax`, path `/`). Only a keyed hash of the identifier is stored.
  State-changing requests also require a CSRF token bound to the session and an allowed `Origin`.
- A second transport — the session identifier held in JavaScript memory and sent in a request header — exists
  solely for the preview profile. The server accepts it only when `RP_DEPLOYMENT_PROFILE=preview`; configuration
  loading refuses that profile for any `readypackets.com` origin and for `NODE_ENV=production` without an explicit
  preview origin. Negative tests cover both refusals.
- In the preview profile only, e-mail links (verification, reset, invitation) are returned to the caller because
  no mail server exists there. The same tests assert that they are never returned in other profiles.

## Consequences
- The preview is a faithful demonstration of behaviour, not of the production transport. Cookie and CSRF
  behaviour is verified by automated tests rather than in the preview.
- JWTs and browser storage of credentials are not used anywhere.
