# 0042 — Workflow export and import between portals as an integrity-checked JSON package; imports are drafts only

Status: Accepted (2026-11-22; owner confirmation requested)

## Context
The owner asks to export workflows individually, as a selection or all at once, and to import them into another ReadyPackets Portal (increment 05, decision D1). ADR 0028 makes the designer edit drafts and publishing create a version. ADR 0029 defines phases and requirements, and ADR 0039 and 0040 add acceptance gates and storage folder templates to a definition.

## Decision
- **Package.** A single JSON document named `readypackets-workflows-<yyyymmdd-hhmm>.json` with the fields `format: "readypackets.workflows"`, `formatVersion: 1`, `exportedAt`, `source {release, label}`, `workflows`, `references` and `integrity {algorithm: "sha256", digest}`.
  - The digest covers the canonical JSON (sorted keys, UTF-8) of `workflows` and `references`. It detects damage and accidental edits only. It is not a signature and is never treated as proof of origin.
- **Each workflow** carries its key, name, description, current published definition (states, transitions, phases, requirements, acceptance gates and storage folder template) and the designer layout. A workflow that has never been published exports its latest draft, flagged `unpublished: true`.
- **What is never exported:** order data, customer data, user ids, numeric database ids and secrets.
- **References to local objects** are exported with portable identifiers. For example, an acceptance gate's policy is exported by slug, title and audience. Automations bound to workflow steps are not included (a documented limit).
- **Export** works on one workflow, a selection, or all. It needs `workflows.export` and writes the audit event `workflow.exported` with the keys, the count and the digest.
- **Import** has two steps. Both are stateless on the server, which validates everything again when the package is sent with the decisions.
  1. **Preview.** The package must be at most 2 MB and hold at most 50 workflows. It is checked against the strict schema and the designer validator (the same rules as publishing), and the digest and format version are checked. The server returns a plan for each workflow: valid or invalid with field-level findings, whether the key already exists, and how each reference resolves.
  2. **Apply.** For each workflow the administrator chooses **Create as new workflow** (the key is made unique), **Add as a draft of the existing workflow**, or **Skip**. Every unresolved reference must be mapped to a local policy or its gate removed explicitly. Apply needs an idempotency key.
- **Imports are always drafts.** Nothing is published, no default is changed and no existing order is touched. The administrator reviews and publishes in the designer.
- **Guards.** Import needs `workflows.import` (administrators) and step-up. It writes the audit events `workflow.import_previewed` and `workflow.imported`, the latter with the outcome for each key. A wrong digest blocks the import, and "import anyway" is not offered.
- **Untrusted input.** The package is parsed with depth and size guards. Unknown keys are rejected, and `__proto__` / `constructor` keys are never used as object keys. Nothing is `eval`'d, and imported text is never rendered as HTML.

## Assumptions to confirm with the owner
- Imported workflows are always created as drafts and must be published by hand.
- Automations bound to steps are not transferred.

## Consequences
- Moving a workflow takes two steps: import, then review and publish. In exchange, an import cannot change live orders.
- Because the digest is not a signature, administrators should import only packages from a source they trust.
