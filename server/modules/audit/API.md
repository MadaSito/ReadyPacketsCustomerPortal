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
| `attributes` | ≤ 24 keys, key `^[a-z][a-z0-9_]{0,39}$` not sensitive-named; value primitive, string ≤ 128 chars, safe charset, no e-mail/JWT/bearer/key/URL-credential/long-token patterns | key dropped, `dropped_attributes` count stored |
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
/** Commit-safe order: events in hash-chain sequence order (only committed+sealed events). cursor = opaque string or null. */
readEventsAfter(cursor: string | null, limit: number /* 1..1000 */): Promise<{ events: AuditEnvelope[]; nextCursor: string | null; headSeq: number }>
/** Privacy-safe projection for external forwarding: no actor_user_id, resource_public_id, session/source refs; pseudonymous refs only. */
projectForExternal(event: AuditEnvelope): ExternalAuditEvent
/** Chains committed-but-unsealed events (also scheduled every 10 s as job `audit.chain.seal`). */
sealPending(): Promise<{ sealed: number; headSeq: number }>
verifyChain(options?: { fromSeq?: number; maxEvents?: number }): Promise<ChainVerification>
```

`ExternalAuditEvent` = envelope minus `actor_user_id`, `resource_public_id`, `session_ref`,
`source_address_ref`, `durability`, plus `chain_seq`. Shape is stable under `schema_version`.

Admin service methods (called by the router with the verified principal; all audited):
`search`, `getEvent`, `pivot`, `stats`, saved queries (`listSavedQueries/saveQuery/deleteSavedQuery`),
cases (`listCases/getCase/createCase/updateCaseStatus/attachEvents/addCaseNote`), exports
(`requestExport/listExports/openExportDownload`), integrity (`verifyChain`, `listCheckpoints`, `createCheckpoint`),
retention (`getRetention/setRetentionPolicy/listLegalHolds/createLegalHold/releaseLegalHold/runRetention`).

## 4. tRPC (`trpc.audit.*`) — all `adminProcedure`

| Procedure | Capability | Notes |
| --- | --- | --- |
| `search`, `event`, `pivot`, `stats`, `savedQueries.*`, `integrity.status/checkpoints` | `audit.read` | |
| `integrity.verify` | `audit.read` | audited `audit.integrity.verified` |
| `cases.*` mutations | `audit.cases.manage` | |
| `exports.request`, `exports.list` | `audit.export` (step-up) | |
| `retention.*` mutations | `audit.retention.manage` (step-up) | |

Raw HTTP: `GET /api/audit/exports/:exportId/download` — `audit.export` + step-up, owner-or-admin scope,
streamed via `sendPrivateDownload`.

## 5. Query AST (`server/modules/audit/query.ts`)

```ts
type Term = { field: QueryField; op: "eq" | "in" | "prefix" | "gte" | "lte"; value: string | number | string[] }
          | { field: "attribute"; key: string; op: "eq"; value: string | number | boolean };
type Group = { kind: "group"; op: "and" | "or"; terms: (Term | Group)[] };
interface AuditQuery { from: string; to: string; where?: Group }   // ISO; window ≤ 400 days
```

Limits: depth ≤ 3, ≤ 30 terms, `in` ≤ 25 values. Fields: `category, event_name, action, outcome,
severity (gte/lte on number), actor_ref, actor_role, resource_type, resource_public_id, reason_code,
request_id, trace_id, correlation_id, job_id, package_id, import_id, delivery_id, provider,
source_address_ref, origin, release_ref`. Compiled to parameterised Drizzle SQL only.
Pagination: newest first, cursor on `(occurred_at, event_id)`.

## 6. Audit event names emitted by this module

`audit.search.executed`, `audit.event.viewed`, `audit.export.requested|completed|failed|downloaded`,
`audit.saved_query.created|deleted`, `audit.case.created|status_changed|events_attached|note_added`,
`audit.integrity.verified|break_detected`, `audit.checkpoint.created`, `audit.retention.policy_changed`,
`audit.legal_hold.created|released`, `audit.retention.run`, `audit.note.dropped` (count of best-effort drops).

## 7. Jobs and schedules

`audit.chain.seal` (every 10 s), `audit.checkpoint.create` (hourly), `audit.export.generate`,
`audit.retention.run` (daily; dry-run by default unless invoked by an admin with `dryRun: false`).

## 8. Health components

`audit.store` (write probe/last failure), `audit.chain` (unsealed backlog, oldest unsealed age, last verify),
`audit.notes` (best-effort queue depth, dropped count).
