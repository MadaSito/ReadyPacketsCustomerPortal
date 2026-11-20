# 0009 — Layered rate limiting

Status: Accepted (2026-11-20)

## Decision
- Every request passes a per-address gate chosen by the strictest category that applies to its route
  (authentication, mutation, upload, standard), then a per-procedure bucket keyed by account or pseudonymous
  identifier where one exists.
- Counters are stored in MySQL so that limits hold across processes. Slot collisions in the bounded table are
  resolved conservatively (the stricter count wins).
- If the limiter's store is unavailable, authentication and state-changing categories fail closed; only
  ordinary read browsing fails open.
- Credential-guessing protections (per-account back-off) are separate and live in the identity module so that an
  attacker cannot lock out a victim by address rotation alone, nor evade limits by it.
