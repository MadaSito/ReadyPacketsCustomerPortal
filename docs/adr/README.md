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
| 0013 | Transaction and lock discipline | Accepted |
| 0014 | Payments recorded manually; Stripe adapter disabled | Partially superseded by 0035 |
| 0015 | Restore is an operator procedure, never a web action | Accepted |
| 0016 | Preview profile requires a synthetic-data acknowledgement | Accepted |
| 0017 | SIEM delivery states what was actually confirmed | Accepted |
| 0018 | Portable package envelope and import custody | Accepted |
| 0019 | Audit chain keys and off-host checkpoints | Accepted |
| 0020 | Release scope: installable web app first; optional integrations disabled | Accepted |
| 0021 | Analytics on the portal origin: quarantine and accepted residual | Accepted |
| 0022 | Offerings matrix is catalog data; Packet 7 is a bundle rule; Packet 8 not loaded | Accepted (owner confirmation requested) |
| 0023 | Production pipeline webhooks P101 / P201: manual, validated, outbox-delivered, off by default | Accepted |
| 0024 | Microsoft Entra ID sign-in uses OpenID Connect with explicit account linking | Accepted; owner confirmed 2026-11-21 |
| 0025 | Mail delivery: two transports, audit copy, stored content, template centre | Accepted; owner confirmed 2026-11-21 |
| 0026 | Automations: curated triggers, registered actions, recorded runs | Accepted; owner confirmed 2026-11-21 |
| 0027 | Cloud storage connections are copy destinations; local storage stays the system of record | Accepted; owner confirmed 2026-11-21 |
| 0028 | Order workflow designer edits drafts; publishing creates a version | Accepted |
| 0029 | Workflow phases lock on exit; uploads and acknowledgements are requirements on a status | Accepted (owner confirmation requested) |
| 0030 | Audio is recorded in the browser and converted to WebM by a sandboxed worker job | Accepted (owner confirmation requested) |
| 0031 | Application-level protection layer: managed rules, IP lists, country rules, tunable rate limits | Accepted (owner confirmation requested) |
| 0032 | Session centre, restrictions, forced ends and a customer maintenance mode | Accepted (owner confirmation requested) |
| 0033 | Knowledge base, optional community forum and referral programme | Accepted (owner confirmation requested) |
| 0034 | Inbound API v1 with scoped keys, signed webhooks, searchable logs and audited re-run | Accepted (owner confirmation requested) |
| 0035 | Card payments through hosted Stripe or Square checkout (partially supersedes 0014) | Accepted (owner confirmation requested) |
| 0036 | Consent before any non-essential storage, with a server-side ledger (extends 0011) | Accepted (owner confirmation requested) |
| 0037 | Accessibility target WCAG 2.2 AA; customer sidebar navigation and visible theme control | Accepted (owner confirmation requested) |
