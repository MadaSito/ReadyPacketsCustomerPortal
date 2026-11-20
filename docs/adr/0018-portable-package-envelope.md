# 0018 — Portable package envelope and import custody

Status: Accepted (2026-11-20)

## Decision
- An export is one versioned, passphrase-encrypted package with a manifest of record and object digests. It
  is verified by an independent reader that shares no code path with the writer.
- Import is staged: quarantine, verify, dry run with conflict report, approval, apply, acceptance. Approval
  and acceptance require two different administrators.
- No account is linked by e-mail match and nothing is overwritten. Imported orders are read-only and keep
  their source provenance. Unknown optional extensions are retained inert.
- Engagement, support, billing and compliance evidence are not exported in this release.

## Consequences
A passphrase protects custody; it does not prove who produced a package. Staging areas need encrypted,
size-limited volumes and a reviewed clean-up policy before unattended use. See
`server/modules/portable/VERIFICATION.md`.
