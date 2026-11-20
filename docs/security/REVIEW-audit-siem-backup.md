# ReadyPackets audit, SIEM, and recovery review

This is a read-only review of peer-owned implementation. Findings state consequences verified from source; race conditions and failure modes were traced through the code, not reproduced. File and line references for the initial audit review are from `48732b0` and its ancestors. Owner notifications are not evidence of a fix.

## Audit

### High severity

- **Unauthenticated pruning marker**: `server/modules/audit/chain.ts:253–274` accepts a missing event as pruned if its tombstone matches the public event ID and digest already in the chain; `server/modules/audit/schema.ts:158–172` holds no authentication tag. A database-only writer can make unauthorized deletion indistinguishable from legitimate pruning without knowing the chain key. Authenticate each tombstone or batch receipt with a dedicated key and verify its installation, chain sequence and digest binding; write the receipt in the same transaction as the deletion.
- **Deletion precedes durable retention evidence**: `server/modules/audit/retention.ts:160–177,180–228` commits deletion per batch but records the durable outcome separately once the run finishes. An interruption or failed audit insert can leave irreversible deletion with no durable run outcome. Persist intent before starting; record receipt, progress and mandatory audit in each deletion transaction, then finalize the run independently. Coordinate hold and open-case attachment/status changes with deletion: the locking read at `retention.ts:151–169` does not lock related rows in the nested hold/case predicates; `retention.ts:105–133` and `cases.ts:188–239` do not take a common retention guard. Recompute eligibility or policy under a documented shared lock.
- **Export worker writes are not fenced**: `server/modules/audit/exports.ts:165–172,189–224,246–260` updates running/error states without a fence and checks ownership outside the publication transaction. A stale worker can mutate export state after losing its lease. Use `job.assertStillOwned(tx)` in the same transaction as each state write, couple publication to lease ownership, and clean up a losing worker's private object. Generation also uses a stored requester ID with a hard-coded admin actor rather than rechecking current eligibility; reauthorize at execution and publication, not only admission and download.

### Medium severity

- **Verification can misreport concurrent sealing or partial coverage**: `server/modules/audit/chain.ts:215–241,278–330` reads the head before paging and does not bound pages to that head. A concurrent append can change the result compared with the earlier head; suffix or truncated scans can also overwrite the full-chain status. Verify in a consistent read snapshot against a fixed head, report coverage explicitly, and do not let a partial success clear a previous full-chain failure. The normal health count excludes events below the scan watermark (`chain.ts:367–375`); separately surface older unsealed events instead of treating an empty fast-path backlog as proof of completeness.
- **Signing with an unexpected key does not fail closed**: `server/modules/audit/chain.ts:54–70,126–190,284–296,335–349` derives separate HMAC and Ed25519 material and pins verification to the local public key, but append and checkpoint paths do not validate the expected key identity before writing. A wrong replacement key can add rows incompatible with earlier history. Bind key versions to persisted chain state, reject changes before appending, and define an explicit authenticated rotation and verifier trust policy.
- **Manual signing uses a read capability**: `server/modules/audit/integrity.ts:88–100` allows manual checkpoint writes under `audit.read` and writes the audit event after the checkpoint. Use a write capability with fresh step-up, and lock the head and insert the checkpoint and its audit event atomically.
- **Attribute policy is not an allow-list**: `server/modules/audit/envelope.ts:122–135,188–207` accepts arbitrary attribute keys and scalar values that pass pattern checks, and `envelope.ts:330–333` copies all retained attributes to the external export projection. For example, `server/modules/orders/orderService.ts:716` passes prior and new order references as attributes; they are not projected using the envelope's pseudonymous resource-reference field. Use an event-specific registry with enumerated fields and types, distinguish local-only and external fields, and avoid blanket name-based exceptions for digest values.
- **Query limits do not bound all parser and DB work**: `server/modules/audit/query.ts:84–89,99–125,133–157,171–181` applies global node and nesting limits after recursive parsing and exposes JSON attribute matching. `server/modules/audit/search.ts:200–231` aggregates within a bounded date window but limits result groups rather than rows scanned. Validate depth and total nodes before recursive traversal, restrict filtering to enumerated indexed fields, and apply a database execution budget to search and aggregation. SQL values in the reviewed query builder are parameterized; this is a cost/availability finding, not a verified SQL injection.
- **Evidence export has no read snapshot or original head**: `server/modules/audit/exports.ts:135–162,190–208` pages over live records before reading the chain head for the manifest. Writes and pruning during export can make the evidence set differ from the manifest's chain state. Freeze the read boundary and keep the selection consistent; alternatively explicitly label a live export, its coverage and its limitations rather than implying a point-in-time archive.
- **Download success is premature**: `server/modules/audit/exports.ts:278–287` records the download and increments the count before opening the object; `server/modules/audit/http.ts:13–25` can subsequently fail while transferring it. Record attempted access before opening, and separately record failed, interrupted/unknown, or completed server transfer; never imply the client obtained or verified the complete object.

### Low severity

- **Different step-up semantics at the service boundary**: `server/modules/audit/access.ts:19–29` accepts a slightly future timestamp and does not reject a non-finite timestamp, unlike the common guard. Reuse the central helper to avoid divergent direct-call policy. The HTTP and tRPC layers already apply their own authentication/capability gates; no direct untrusted timestamp path was verified.

### Verified controls

- **Emitter**: `server/modules/audit/emitter.ts:139–162` awaits the insert and propagates failure from `record`, using the caller's transaction when supplied. Buffered `note` is separate and best effort, not transactional evidence. Retention and checkpoint findings concern callers not using the transaction contract.
- **Seal serialization and read authorization**: `server/modules/audit/chain.ts:137–190` locks the singleton head row before allocating chain sequence; the reviewed verifier issue is separate from sequence allocation. `server/modules/audit/router.ts` declares capability gates, and `server/modules/audit/http.ts:13–18` requires export capability before handing off to the requester-scoped download service. No customer route to the audit center or arbitrary raw SQL filter was identified in the reviewed paths.

## SIEM

Pending owner handoff. No finding or runtime assurance is recorded for this module yet.

## Backup and deployment

Pending owner handoff. No finding or runtime assurance is recorded for these paths yet.
