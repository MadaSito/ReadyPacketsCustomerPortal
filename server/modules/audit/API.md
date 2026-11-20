# Audit module — public API (v1)

Owner: audit_engineer. Paths: `server/observability/**`, `server/modules/audit/**`, `client/src/features/audit/**`.

## 1. AuditEmitter (`deps.audit`, `services.audit`) — `server/modules/audit/emitter.ts`

```ts
createAuditEmitter(deps: { config; db; clock; logger; crypto }): AuditEmitter
record(event: AuditEventInput, tx?: Tx): Promise<void>   // durable; throws AuditUnavailableError (fail closed)
note(event: AuditEventInput): void                       // best-effort, bounded queue (1000), never throws
```

Validation (strict; applied by both `record` and `note`):

| Field | Rule | On violation |
| --- | --- | --- |
| `eventName` | `^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,5}$`, ≤ 96 chars | throw `AuditUnavailableError` (programming error, fail closed) |
| `action` | `^[a-z][a-z0-9_]{0,31}$` | throw |
| `reasonCode` | `^[A-Z][A-Z0-9_]{0,63}$` | throw |
| `category`/`outcome`/`severity` | core enums | throw |
| `resource.type` | `^[a-z][a-z0-9_]{0,47}$` | throw |
| `resource.publicId` | ULID or `^[A-Za-z0-9_.:-]{1,64}$` | dropped |
| ids (`correlationId`, `jobId`, `packageId`, `importId`, `deliveryId`) | `^[A-Za-z0-9_.:-]{1,64}$` | dropped |
| `attributes` | ≤ 24 keys, key `^[a-z][a-z0-9_]{0,39}$` not sensitive-named; value primitive, string ≤ 128 chars, safe charset, no e-mail/JWT/bearer/key/URL-credential/long-token patterns. Secret- or personal-named keys keep booleans only. Exceptions: `*_public_id` keys accept an id-shaped value `^[A-Za-z0-9_-]{10,64}$` (even if the prefix is a personal-field word such as `note_`); `*_sha256` / `*_hash` keys accept 64-char lower-case SHA-256 hex unless the key is secret- or personal-named (`email_hash` is dropped) | key dropped, `dropped_attributes` count stored |
| `safeCounts` | ≤ 16 keys, finite integers 0..2^53 | key dropped |

Request context fills `actor` (userId, role, session), request/trace/span/correlation ids, origin and source
address when not supplied. Actor is stored as numeric user id (local) + HMAC pseudonym `actor_ref`;
the source IP is stored only encrypted (`audit_events.source_address:<event_id>`) plus a class
(`loopback|private|public|unknown`) and pseudonym.

## 2. Canonical envelope (`AuditEnvelope`, `server/modules/audit/envelope.ts`)

`schema_version: "rp.audit/1"`, `event_id` (ULID), `occurred_at`, `observed_at` (ISO UTC), `severity_text`,
`severity_number` (OTel: TRACE 1, DEBUG 5, INFO 9, WARN 13, ERROR 17, FATAL 21), `category`, `event_name`,
`action`, `outcome`, `reason_code`, `durability` (`durable|best_effort`), `actor_ref`, `actor_role`,
`actor_user_id` (local only), `session_ref`, `resource_type`, `resource_public_id`, `resource_ref`,
`request_id`, `trace_id`, `span_id`, `correlation_id`, `parent_correlation_id`, `job_id`, `package_id`,
`import_id`, `delivery_id`, `provider`, `duration_ms`, `origin`, `service`, `installation_ref`, `release_ref`,
`deployment_profile`, `source_address_class`, `source_address_ref`, `safe_counts`, `attributes`,
`dropped_attributes`, `chain_seq` (null until sealed).

## 3. Audit module (`services.auditCenter`) — `server/modules/audit/index.ts`

For other modules (SIEM, backup, portable):

```ts
/**
 * Commit-safe order: events in hash-chain sequence order (only committed+sealed events). cursor = opaque string or null.
 * Seqs whose event is gone are skipped and counted: `pruned` = tombstone whose keyed receipt authenticates
 * (same check as verifyChain); `missing` = unexplained loss (no/invalid tombstone, chain-row gap, or head ahead of
 * the chain rows) — alert and run verifyChain. Removed-only windows are read through for ≤ 20 pages per call:
 * `events: []` with an advanced nextCursor = call again; unchanged nextCursor = caught up to `headSeq`.
 */
readEventsAfter(cursor: string | null, limit: number /* 1..1000 */): Promise<{ events: AuditEnvelope[]; nextCursor: string | null; headSeq: number; pruned: number; missing: number }>
/**
 * Privacy-safe projection for external forwarding: no actor_user_id, resource_public_id, session/source refs.
 * Attributes: booleans always; string/number values only for keys in EXTERNAL_ATTRIBUTE_KEYS (fixed vocabularies:
 * statuses, roles, formats, modes, versions, ports). Identifiers, references, slugs, hashes and amounts are withheld
 * and counted in `dropped_attributes`. "local" exports keep all stored attributes.
 */
projectForExternal(event: AuditEnvelope): ExternalAuditEvent
/** Chains committed-but-unsealed events (also scheduled every 10 s as job `audit.chain.seal`). */
sealPending(): Promise<{ sealed: number; headSeq: number }>
verifyChain(options?: { fromSeq?: number; maxEvents?: number }): Promise<ChainVerification>
```

`ExternalAuditEvent` = envelope minus `actor_user_id`, `resource_public_id`, `session_ref`,
`source_address_ref`, `durability`, plus `chain_seq`. Shape is stable under `schema_version`.

Admin service methods (first arg = verified `SessionPrincipal`; capability + step-up re-checked in the
service; privileged mutations re-validate the actor's current role/status inside their transaction; all audited):
`search`, `getEvent`, `revealSourceAddress`, `pivot`, `stats`; saved queries `listSavedQueries/saveQuery/deleteSavedQuery`;
cases `listCases/getCase/createCase/updateCaseStatus/attachEvents/addCaseNote`; exports
`requestExport/listExports/openExportDownload/recordDownloadResult`; integrity
`integrityStatus/verifyIntegrity/listCheckpoints/createCheckpoint`; retention
`getRetention/setRetentionPolicy/createLegalHold/releaseLegalHold/runRetention(principal, dryRun)`.

## 4. tRPC (`trpc.audit.*`) — all `adminProcedure`, strict Zod inputs

| Procedure | Capability | Notes |
| --- | --- | --- |
| `search`, `event`, `pivot`, `stats`, `revealSourceAddress` | `audit.read` | each audited (`audit.search.executed`, `audit.event.viewed`, `audit.stats.viewed`, WARN `audit.source_address.revealed`) |
| `savedQueries.list/save/remove` | `audit.read` | delete is owner-only (others get NOT_FOUND) |
| `cases.list/get` | `audit.read` | |
| `cases.create/setStatus/attachEvents/addNote` | `audit.cases.manage` | attach/reopen take the retention gate (shared) |
| `exports.list/request` | `audit.export` (step-up) | ≤ 3 active per user |
| `integrity.status/checkpoints/verify` | `audit.read` | verify audited `audit.integrity.verified` / ERROR `audit.integrity.break_detected` |
| `integrity.createCheckpoint` | `audit.retention.manage` (step-up) | signed + audited in one tx |
| `retention.get` | `audit.read` | |
| `retention.setPolicy/createHold/releaseHold/run` | `audit.retention.manage` (step-up) | `run({dryRun:true})` previews |

Raw HTTP: `GET /api/audit/exports/:exportId/download` — `audit.export` + step-up, requester only, streamed via
`sendPrivateDownload`. Durable `audit.export.download_attempted` BEFORE bytes; truthful
`audit.export.downloaded` (`completed|failed|unknown`) after the stream ends.

## 5. Query AST (`server/modules/audit/query.ts`)

```ts
type Term = { field: QueryField; op: "eq" | "in" | "prefix" | "gte" | "lte"; value: string | number | string[] }
          | { field: "attribute"; key: string; op: "eq"; value: string | number | boolean };
type Group = { kind: "group"; op: "and" | "or"; terms: (Term | Group)[] };
interface AuditQuery { from: string; to: string; where?: Group }   // ISO; window ≤ 400 days
```

Limits: depth ≤ 3, ≤ 30 terms, `in` ≤ 25 values, ≤ 400 JSON nodes in `where` (checked iteratively before
schema parsing; the schema itself is depth-specific, not recursive). Fields: `QUERY_FIELDS` in query.ts
(per-field value grammar). Compiled to parameterised Drizzle SQL only. Pagination: newest first, cursor on
`(occurred_at, event_id)`.

## 6. Audit event names emitted by this module

`audit.search.executed`, `audit.event.viewed`, `audit.stats.viewed`, `audit.source_address.revealed`,
`audit.export.requested|completed|failed|download_attempted|downloaded`, `audit.saved_query.created|deleted`,
`audit.case.created|status_changed|events_attached|note_added|viewed`, `audit.integrity.verified|break_detected`,
`audit.checkpoint.created`, `audit.retention.policy_changed`, `audit.legal_hold.created|released`,
`audit.retention.started|preview_started|batch_removed|run|previewed`, `audit.note.dropped`.

## 7. Jobs and schedules

`audit.chain.seal` (every 10 s), `audit.chain.sweep` (daily full-scan seal), `audit.checkpoint.create` (hourly),
`audit.export.generate` (on request), `audit.retention.run` (daily; a REAL run, but it only applies policies an
admin explicitly set — no policy ⇒ keep forever).

## 8. Health components

`audit.store` (recent durable-write failures), `audit.chain` (unsealed backlog, oldest unsealed age vs 15 min
horizon, last verify result), `audit.notes` (best-effort queue depth, dropped count).

## 9. Client pages (`client/src/features/audit`)

All lazy, `access: "admin"`; capability shown per route (server re-checks every call).

| Route | Capability | Purpose |
| --- | --- | --- |
| `/admin/audit` | `audit.read` | Event search (ID search, quick filters, AND/OR builder), detail drawer, pivots, reveal source address, add to case, save search, export (step-up). Deep links: `?correlationId=<id>` (30-day window) and `?saved=<savedQueryId>`; both are read from the query string or from the hash route. |
| `/admin/audit/saved` | `audit.read` | Saved searches; open via `?saved=`; owner delete. |
| `/admin/audit/cases` | `audit.read` (mutations `audit.cases.manage`) | Cases list/filter, create, status, encrypted notes. |
| `/admin/audit/exports` | `audit.export` | Exports with manifest/SHA-256; download via `GET /api/audit/exports/:id/download` (retries once after step-up; size must equal manifest). |
| `/admin/audit/integrity` | `audit.read` (checkpoint `audit.retention.manage`) | Chain status, verify, signed checkpoints. |
| `/admin/audit/retention` | `audit.retention.manage` | Policies, legal holds, preview and real run (typed `REMOVE`), all under step-up. |

Other features may link to `/admin/audit?correlationId=<workflow correlation id>`.
