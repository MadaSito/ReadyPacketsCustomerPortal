# 0028 — Order workflow designer edits drafts; publishing creates a version

Status: Accepted (2026-11-21)

## Context
The workflow was installed implicitly with the first order and could not be configured in the console.

## Decision
- Administrators can install the standard workflow explicitly, create drafts (from the standard workflow,
  from a copy or blank) and edit them in a wizard or on a canvas; both edit the same draft document.
- A draft is validated on the server (one initial status, reachable statuses, at least one terminal
  status, unique keys, valid actors) and published as a new version. Existing orders keep the version they
  were created with.
- The wizard is the fully keyboard- and screen-reader-operable path; the canvas offers the same operations
  without requiring drag.

## Consequences
Changing the path of orders already in progress is not possible in this release.
