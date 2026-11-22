# 0029 — Workflow phases lock on exit; uploads and acknowledgements are requirements on a status

Status: Accepted (2026-11-21; owner confirmation requested)

## Context
The owner asked for phase locking, required file and audio uploads and administrator-defined acknowledgements in the order workflow. Locks existed only for a whole order.

## Decision
- A workflow definition may group statuses into ordered phases. Leaving a phase locks it; staff with `orders.phase.unlock` may unlock with a reason. Order-level locks still win.
- Each status may declare upload slots and acknowledgements. A transition out of the status is refused while one is unmet.
- An acknowledgement record stores the hash of the exact text shown, the definition version, user, session and time, and is immutable.
- Requirements are part of a published version; orders keep the version they started with (ADR 0028).

## Consequences
Changing requirements for orders already in progress is not possible in this release.
