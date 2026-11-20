# 0005 — Public identifiers and module data ownership

Status: Accepted (2026-11-20)

## Decision
- Every record exposed through an API carries a ULID `publicId`; numeric primary keys never leave the server.
- Each module owns its tables. The only cross-module foreign key permitted is to `users.id`. Other references
  are stored as identifiers and validated through the owning module's service.
- Object-level authorisation is evaluated in the service that owns the record on every access, using the
  session's current role and relationship to the record; the client's view of permissions is never trusted.
  Records the caller may not see are reported as not found.

## Consequences
- Enumeration of sequential identifiers is not possible, and a missing authorisation check in one router cannot
  be bypassed through another module because the owning service re-checks.
