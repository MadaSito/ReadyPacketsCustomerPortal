# 0019 — Audit chain keys and off-host checkpoints

Status: Accepted (2026-11-20). Extends 0006.

## Decision
- The audit chain is sealed with a key separate from field encryption and token hashing keys. Keys are
  generated and checked with `dist/ops/generate-keys.js` and `dist/ops/keys-doctor.js`, supplied as files
  readable only by the service account, and never stored in the database or the repository.
- Signed checkpoints are created hourly and on demand (step-up). Each checkpoint emits an audit event carrying
  its sequence and head link, so a SIEM that receives the stream holds an off-host copy of the chain head.
- An attacker with both database write access and the chain key can rewrite history that has not yet been
  checkpointed off-host. Detecting that depends on the operator keeping checkpoints outside the host.

## Consequences
Key rotation is a documented operator procedure (`scripts/ops/keys/RUNBOOK.md`). Integrity verification
reports a break; it cannot repair one.
