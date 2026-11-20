# Architecture decision records

Each record states the context, the decision, the alternatives that were rejected and the consequences.
Records are immutable once accepted; a later decision supersedes an earlier one by number.

| No. | Decision | Status |
| --- | --- | --- |
| 0001 | Clean rebuild as a modular monolith on the specified stack | Accepted |
| 0002 | Opaque server-side sessions; preview-only header transport | Accepted |
| 0003 | Local accounts with mandatory TOTP; passkeys as an additional factor | Accepted |
| 0004 | Administrator credential administration modes | Accepted |
| 0005 | Public identifiers and module data ownership | Accepted |
| 0006 | Durable, hash-chained audit trail separate from operational logs | Accepted |
| 0007 | Job fencing and the `unknown` outcome | Accepted |
| 0008 | TLS termination, trusted proxy and host authority | Accepted |
| 0009 | Layered rate limiting | Accepted |
| 0010 | Search-engine indexing boundary between public site and portal | Accepted |
| 0011 | Consent-gated analytics (Microsoft Clarity, PostHog) | Accepted |
| 0012 | Toolchain: TypeScript 7 for type checking, TypeScript 6 for lint | Accepted |
