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

## Increment 03 — audit tap and trigger catalogue (package J)

Consumers: the automations module (engagement engineer). Source: `tap.ts`, `triggerCatalogue.ts`.

```ts
import { type AuditTap, type AuditTapEvent, TRIGGER_CATALOGUE, automationCorrelationId, isAutomationOrigin } from "../audit/index.js";
// in your module's init():
const detach = deps.services.auditCenter.registerTap(tap);   // up to MAX_TAPS (4) taps, each in its own savepoint; idempotent per tap; throws on a non-durable emitter
deps.services.auditCenter.triggerCatalogue();                // readonly TriggerCatalogueEntry[]
deps.services.auditCenter.tapStats();                        // { offered, suppressedAutomationOrigin, failures, lastFailureAt }
```

`AuditTap = { listens(eventName): boolean; onRecorded(event: AuditTapEvent, tx: Tx | undefined): Promise<void> }`.
Helpers from `triggerCatalogue.ts` (re-exported later if you need them): `CATALOGUE_EVENT_NAMES`, `entriesForEvent(event)`
(applies event name + outcome + resource type + fixed matches), `eventFieldValue(event, key)`, `catalogueEntry(key)`.

Guarantees:
- Called after every successful DURABLE `record()` (never for `note()`), inside the caller's transaction when there is one.
- Nothing listens → exactly one synchronous `listens()` call; no event object, no await, no database work. Keep `listens`
  a `Set.has` over the event names of ENABLED automations (refresh it on save / enable and on a short timer for other
  processes); a throwing `listens` counts as "not listening".
- `AuditTapEvent` holds only validated envelope data: ids, name, category, action, outcome, reason code, actor role / user
  id, resource type / public id, correlation and job ids, the validated attributes and safe counts. Frozen. No source
  address, session reference or dropped attributes.
- **Automation-origin marker (gate 4.1 J):** run every automation with correlation id `automationCorrelationId(runPublicId)`
  (`automation:<runPublicId>`). Jobs and mail rows persist the correlation id and the worker restores it, so every
  descendant (jobs, mails, webhooks, `job.mail.failed`, …) carries it; events whose correlation id OR parent correlation
  id has the marker are never offered (counted as `suppressedAutomationOrigin`). Action providers must not pass an
  explicit `correlationId` that replaces the marker.
- Errors from `onRecorded` are logged and counted and do NOT fail the business transaction — except MySQL 1213 / 1205
  (InnoDB has rolled back or may have rolled back the transaction): then `AuditUnavailableError` is thrown, because
  continuing would commit the rest outside the transaction. So make `onRecorded` a single INSERT (statement-level
  rollback leaves the transaction intact). Do all reads / preflights from the in-memory listener set, not the pool.

Trigger catalogue rules (`TriggerCatalogueEntry`): `eventName` + `outcomes` (+ optional `match` on safe attributes or
`reason_code`, + `resourceType`) define when an entry fires — a refused registration for an existing address never fires.
`fields[].from = "event"` come from the tap event; `"context"` fields are resolved in the worker by the owning module's
context resolver; `personal: true` fields are template-only (never conditions, run records, logs or audit).
`recipients` are resolved to user ids by the owning module; never take an address from the event.
`staffOnly: true` (internal order note): actions may address staff / administrators only — no customer, fixed external
address or webhook; enforce on save and at run time. A tap with several writes runs in a savepoint (`tx` you receive is it).
Initial entries: account registered / activated / password reset requested / password changed, order created / status
changed / reassigned, file uploaded, order message posted (customer-visible only) / internal order note (staff only), ticket opened / replied (public) / closed, invoice issued / paid,
maintenance switched on (`job.maintenance.changed` + `MAINTENANCE_ENABLED`; there is no separate "maintenance window
announced" event yet), backup completed / failed / verification failed / off-host copy completed / failed, e-mail delivery failed.
Tests: `tap.test.ts` (real MySQL).

## Increment 04 Part B — S2 Order history (B3)

**Envelope.** `audit_events.order_public_id` (nullable, index `ix_audit_order_time`, migration 0004). It is derived from the explicit `orderPublicId` input, then an `order` resource, then the attribute `order_public_id`. It enters the hash chain only when non-null, so older hashes are unchanged.

**`trpc.audit.orderActivity({ orderPublicId, category?, cursor?, limit≤50 })`** (`protectedProcedure`, orders read policy via `services.orders.assertCanReadOrder`).
- It returns `{ view: "customer" | "staff", items, nextCursor }`, made of events whose `order_public_id` (or legacy order resource) is the order.
- Categories: details, status, access, phases, acceptance, files, storage, production, automation, payments, other (catalogue `ORDER_ACTIVITY_CATALOGUE`).
- Customer projection:
  - Only catalogue entries marked customer, and only successful outcomes.
  - File events only when `file_visibility = customer_visible`.
  - Actor is one of "You", "ReadyPackets staff", "Someone with access to this order" or "ReadyPackets".
  - details are limited to from_status, to_status, phase, phase_key and lock_state.
  - The key is an HMAC pseudonym. There are no event ids, staff identities, IP addresses or internal ids.
- Staff projection: event name, outcome, reason code, actor name and role, correlation id, and details without `*_ref`, `*_hash` or address keys.

**`trpc.audit.orderStatusHistory({ orderPublicId, cursor?, limit≤50 })`** (same policy).
- It merges `services.orders.listStatusTransitions` and `services.orders.listNameHistory` with a two-lane keyset merge, so there is no fixed window. Ties are deterministic: at equal timestamps, transitions come before renames, and within a lane the port's id order applies.
- Items: `{ key, kind: "transition" | "rename", at, actor, from?, fromLabel?, to?, toLabel?, note?, oldName?, newName? }`.
- Customers get rename items without `oldName`/`newName` (lead decision: the client shows "Order renamed"), no staff identity, and no internal notes. Staff see "Renamed: old → new" and names.

**Cursors.** Both are opaque: AES-GCM via `deps.crypto.encrypt`, base64url, with AAD bound to the order, the reader, the view (and the category for activity). A cursor replayed by another user or view, or a tampered one, fails with `CURSOR_INVALID`.

**Client.**
- `client/src/features/audit/OrderHistoryTab.tsx` is registered as `orderTabs` key `history`, order 90, access customer. Its label is "History" in the customer area and "Order history" in the console. It has a left status lane and a right activity feed with a category filter; customers see customer categories only.
- `client/src/features/automations/OrderWorkflowStageActionsPanel.tsx` is the T2 panel for the T1 Automation tab slot (server: `trpc.automations.orderStageActions.*`).

## Increment 06 — D7 event correlation and security incidents (package G)

Everything lives in `auditCenter` (no new module). Files: `correlation/rules.ts` (pure engine), `correlation/incidents.ts` (runner, service), schema tables `security_incidents`, `security_incident_events`, `security_incident_timeline`, `security_correlation_state` (migration 0006).

- **Setting** `security.correlation` (owner audit, group security, write capability `security.firewall.manage`, managed at `/admin/audit/incidents`). Stored values are read with `parseCorrelationConfig` (every field optional, invalid fields fall back to defaults, never throws); writes are strict (`correlationConfigSchema`). Defaults: on, merge window 60 min.
- **Rules** (severity / threshold / window min): brute_force_account high 10/15 · password_spraying high 5 accounts/10 · credential_stuffing critical 30/5 (≥5 accounts and ≥5 addresses) · distributed_account high 5 addresses/30 · success_after_failures critical 5/30 · mfa_fatigue high 5/10 · rate_limit_repeated medium 5/15 · ban_evasion high 1/30 · privilege_then_export high 1/60. Bounds: threshold 1–10000, window 1–1440, distinct 1–1000, merge 5–1440. Escalation: one severity level at ≥ 3× threshold.
- **Inputs**: audit events only (auth.login.failed/succeeded, identity.sso.*_refused, auth.token.rejected{purpose=password_reset}, auth.mfa.challenge_denied, auth.totp.replay_denied/locked, auth.step_up.denied, http.rate_limited, auth.rate_limited, security.ban.created, admin.staff.role_changed, export events). Account key: `account_ref` attribute → `signInSignals.accountRefForUser` → user public id. Addresses are compared by `source_address_ref` only; no raw address or identifier is stored in incident tables.
- **Job** `security.correlation.run`, schedule `security.correlation.minute` (60 s). Bounded: 20 000 events per run (newest first; `lastRunTruncated`), 500 linked events per incident. Idempotent: the run holds the state row `FOR UPDATE`; evidence at or before a closed incident's close time never re-opens it.
- **Audit events** (category security, actor system or the admin, resource `security_incident`, correlationId = incident public id): `security.incident.opened`, `.updated`, `.acknowledged`, `.closed`, `.action` — attributes `incident_public_id, rule_key, severity, status, event_count, account_count, address_count` (+ `escalated`, `close_reason`, `action_kind`, `ban_public_id`, `permanent`). SIEM catalogue: siem_engineer.
- **tRPC** `audit.incidents.{list, get, acknowledge, close, banAddress, endSessions, rules, updateRules}` and `audit.banEventAddress` — admins with `security.incidents.read`; `banAddress`/`banEventAddress` add `security.firewall.manage` (step-up) and call `services.protection.manualSignInBan` outside any transaction with the address decrypted server-side; `endSessions` adds `sessions.revoke_any` (step-up) and calls `services.identity.centre.endForUser(…, "SECURITY_INCIDENT")`; `updateRules` adds `security.firewall.manage` + step-up. Acknowledge/close use `expectedVersion` (`INCIDENT_CHANGED`). Close reasons: resolved, false_positive, duplicate, accepted_risk. Ban durations 15/60/1440/10080 min or null (permanent); reason 3–240 characters without control characters. Bans refuse with `CLIENT_ADDRESS_UNDETERMINABLE` when `protection.clientAddressTrust().determinable` is false.
- **Client** (`auditFeature`): `/admin/audit/incidents` (counts, filters, last run, address warning, rules card), `/admin/audit/incidents/:publicId` (summary, actions, correlated events, timeline). `/admin/audit?incident=<id>` opens the incident's ready-made search; `/admin/audit?event=<id>` opens one event.
- **Tests**: `correlation/rules.test.ts` (22), `correlation/incidents.test.ts` (9, real MySQL), `client/src/features/audit/incidents.test.tsx` (14, axe in both themes).
