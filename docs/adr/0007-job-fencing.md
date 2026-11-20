# 0007 — Job fencing and the `unknown` outcome

Status: Accepted (2026-11-20)

## Decision
- Background work is claimed with a lease and a monotonically increasing fencing token. A handler confirms it
  still owns the claim (`assertStillOwned`, optionally inside its transaction) before any irreversible effect.
- When a worker stops or loses its lease mid-run, the job is marked `unknown` and surfaced to an operator unless
  its handler declared `retrySafe`. The system never guesses whether an external effect happened.
- Outbound mail is written to an outbox in the same transaction as the event that causes it. Mail capture mode
  (for diagnosis) requires a dedicated capability with step-up and is refused in production.
- Shutdown is fail-closed: if a component cannot confirm that it stopped, the process exits non-zero.

## Consequences
- Some jobs need a human decision after a crash. This is deliberate: duplicate payments, e-mails or exports are
  worse than a visible pause.
