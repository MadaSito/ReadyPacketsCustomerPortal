# 0015 — Restore is an operator procedure, never a web action

Status: Accepted (2026-11-20)

## Context
A restore replaces the database that holds accounts, sessions, grants and the audit chain. A web-initiated
restore would let one compromised administrator session rewrite that history, and it would run with the web
process's database privileges.

## Decision
- The portal creates, lists, verifies and expires backups. It does not restore.
- Restore is run from the host with `dist/ops/restore-isolated.js` into an isolated target database that is not
  the live one. The operator verifies the result and promotes it by procedure
  (`docs/operations/BACKUP_AND_RESTORE.md`).
- After promotion every session is revoked and the event is recorded in the audit trail of the restored system.
- The Backups screen shows the restore procedure as read-only guidance.

## Consequences
Recovery needs host access and a second person by procedure. Restore has been exercised against local MySQL
test databases only, not on a production host.
