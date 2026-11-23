/**
 * Audit module — Drizzle MySQL tables. Owner: audit engineer.
 *
 * APPEND-ONLY by application policy: `audit_events`, `audit_chain`, `audit_checkpoints`, `audit_tombstones`
 * and `audit_case_notes` have NO update/delete code paths, except the retention job which deletes
 * `audit_events` rows only after writing a tombstone that preserves the chain digest (see chain.ts).
 * Operators should additionally restrict the application DB role (docs: VERIFICATION.md §DB grants).
 *
 * Index design (query workload = time-bounded filters, newest first, cursor on (occurred_at, event_id)):
 *  - ix_audit_time          (occurred_at, event_id)           — base scan + cursor pagination
 *  - ix_audit_cat_sev_time  (category, severity_number, occurred_at)
 *  - ix_audit_name_time     (event_name, occurred_at)         — exact + prefix (LIKE 'x%') on event name
 *  - ix_audit_outcome_time  (outcome, occurred_at)
 *  - ix_audit_actor_time    (actor_ref, occurred_at)          — "same actor" pivot
 *  - ix_audit_res_time      (resource_type, resource_ref, occurred_at) — "same resource" pivot
 *  - ix_audit_req           (request_id)  ix_audit_trace (trace_id)  ix_audit_corr_time (correlation_id, occurred_at)
 *  - ix_audit_job / ix_audit_pkg                              — provenance pivots
 *  - ix_audit_reason_time   (reason_code, occurred_at)
 * Attribute filters (JSON_EXTRACT) are NOT indexed; they are only allowed combined with the mandatory
 * time window and the global row-examination budget (query.ts).
 */
import {
  bigint,
  boolean,
  char,
  index,
  int,
  json,
  mysqlTable,
  smallint,
  text,
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime } from "../../db/columns.js";

export const auditEvents = mysqlTable(
  "audit_events",
  {
    id: idColumn(),
    eventId: char("event_id", { length: 26 }).notNull(),
    schemaVersion: varchar("schema_version", { length: 16 }).notNull(),
    occurredAt: utcDateTime("occurred_at").notNull(),
    observedAt: utcDateTime("observed_at").notNull(),
    severityText: varchar("severity_text", { length: 8 }).notNull(),
    severityNumber: tinyint("severity_number", { unsigned: true }).notNull(),
    category: varchar("category", { length: 24 }).notNull(),
    eventName: varchar("event_name", { length: 96 }).notNull(),
    action: varchar("action", { length: 32 }).notNull(),
    outcome: varchar("outcome", { length: 12 }).notNull(),
    reasonCode: varchar("reason_code", { length: 64 }),
    durability: varchar("durability", { length: 12 }).notNull(),
    actorUserId: refColumn("actor_user_id"),
    actorRef: char("actor_ref", { length: 32 }),
    actorRole: varchar("actor_role", { length: 12 }).notNull(),
    sessionRef: char("session_ref", { length: 32 }),
    resourceType: varchar("resource_type", { length: 48 }),
    resourcePublicId: varchar("resource_public_id", { length: 64 }),
    resourceRef: char("resource_ref", { length: 32 }),
    /** Increment 04 part B (0004): order the event belongs to; hashed only when non-null (see canonicalBytes). */
    orderPublicId: varchar("order_public_id", { length: 64 }),
    requestId: varchar("request_id", { length: 64 }),
    traceId: char("trace_id", { length: 32 }),
    spanId: char("span_id", { length: 16 }),
    correlationId: varchar("correlation_id", { length: 64 }),
    parentCorrelationId: varchar("parent_correlation_id", { length: 64 }),
    jobId: varchar("job_id", { length: 64 }),
    packageId: varchar("package_id", { length: 64 }),
    importId: varchar("import_id", { length: 64 }),
    deliveryId: varchar("delivery_id", { length: 64 }),
    provider: varchar("provider", { length: 32 }),
    durationMs: int("duration_ms", { unsigned: true }),
    origin: varchar("origin", { length: 12 }).notNull(),
    service: varchar("service", { length: 40 }).notNull(),
    installationRef: varchar("installation_ref", { length: 64 }).notNull(),
    releaseRef: varchar("release_ref", { length: 80 }).notNull(),
    deploymentProfile: varchar("deployment_profile", { length: 16 }).notNull(),
    sourceAddressClass: varchar("source_address_class", { length: 12 }).notNull(),
    sourceAddressRef: char("source_address_ref", { length: 32 }),
    /** Raw client address, AES-GCM encrypted (sensitive-local), AAD `audit_events.source_address:<event_id>`. */
    sourceAddressEnc: varchar("source_address_enc", { length: 255 }),
    safeCounts: json("safe_counts").$type<Record<string, number>>().notNull(),
    attributes: json("attributes").$type<Record<string, string | number | boolean | null>>().notNull(),
    droppedAttributes: smallint("dropped_attributes", { unsigned: true }).notNull().default(0),
  },
  (t) => [
    uniqueIndex("ux_audit_event_id").on(t.eventId),
    index("ix_audit_time").on(t.occurredAt, t.eventId),
    index("ix_audit_cat_sev_time").on(t.category, t.severityNumber, t.occurredAt),
    index("ix_audit_name_time").on(t.eventName, t.occurredAt),
    index("ix_audit_outcome_time").on(t.outcome, t.occurredAt),
    index("ix_audit_actor_time").on(t.actorRef, t.occurredAt),
    index("ix_audit_res_time").on(t.resourceType, t.resourceRef, t.occurredAt),
    index("ix_audit_order_time").on(t.orderPublicId, t.occurredAt, t.eventId),
    index("ix_audit_req").on(t.requestId),
    index("ix_audit_trace").on(t.traceId),
    index("ix_audit_corr_time").on(t.correlationId, t.occurredAt),
    index("ix_audit_job").on(t.jobId),
    index("ix_audit_pkg").on(t.packageId),
    index("ix_audit_reason_time").on(t.reasonCode, t.occurredAt),
  ],
);

/**
 * Hash chain. One row per sealed event, seq strictly increasing without gaps.
 * link_hash = HMAC-SHA256(chainKey, "rp.audit.chain/1|" + seq + "|" + prev_hash + "|" + event_digest)
 * event_digest = SHA-256(canonicalBytes(envelope)).
 */
export const auditChain = mysqlTable(
  "audit_chain",
  {
    seq: bigint("seq", { mode: "number", unsigned: true }).primaryKey(),
    eventRowId: refColumn("event_row_id").notNull(),
    eventId: char("event_id", { length: 26 }).notNull(),
    eventDigest: char("event_digest", { length: 64 }).notNull(),
    prevHash: char("prev_hash", { length: 64 }).notNull(),
    linkHash: char("link_hash", { length: 64 }).notNull(),
    keyRef: char("key_ref", { length: 16 }).notNull(),
    sealedAt: utcDateTime("sealed_at").notNull(),
  },
  (t) => [uniqueIndex("ux_audit_chain_event_row").on(t.eventRowId), uniqueIndex("ux_audit_chain_event_id").on(t.eventId)],
);

/** Singleton per installation: serialises sealing (SELECT … FOR UPDATE) and stores the scan watermark. */
export const auditChainHead = mysqlTable("audit_chain_head", {
  id: tinyint("id", { unsigned: true }).primaryKey(),
  headSeq: bigint("head_seq", { mode: "number", unsigned: true }).notNull().default(0),
  headHash: char("head_hash", { length: 64 }).notNull(),
  /** Identity of the HMAC key that built this chain. Appends/checkpoints refuse to run under a different key. */
  keyRef: char("key_ref", { length: 16 }),
  /** All event rows with id <= watermark are sealed (or were rolled back). Advanced conservatively. */
  scanWatermark: bigint("scan_watermark", { mode: "number", unsigned: true }).notNull().default(0),
  /** Max event row id observed at `watermark_candidate_at`; promoted to the watermark once older than the horizon. */
  watermarkCandidateId: bigint("watermark_candidate_id", { mode: "number", unsigned: true }).notNull().default(0),
  watermarkCandidateAt: utcDateTime("watermark_candidate_at"),
  lastSealedAt: utcDateTime("last_sealed_at"),
  lastVerifiedAt: utcDateTime("last_verified_at"),
  lastVerifyOk: boolean("last_verify_ok"),
  lastVerifyBreakSeq: bigint("last_verify_break_seq", { mode: "number", unsigned: true }),
});

/** Ed25519-signed checkpoints of the chain head. */
export const auditCheckpoints = mysqlTable(
  "audit_checkpoints",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    seq: bigint("seq", { mode: "number", unsigned: true }).notNull(),
    headHash: char("head_hash", { length: 64 }).notNull(),
    installationRef: varchar("installation_ref", { length: 64 }).notNull(),
    createdAt: createdAtColumn(),
    signedAt: utcDateTime("signed_at").notNull(),
    algorithm: varchar("algorithm", { length: 16 }).notNull(),
    keyRef: char("key_ref", { length: 16 }).notNull(),
    publicKey: varchar("public_key", { length: 128 }).notNull(),
    signature: varchar("signature", { length: 128 }).notNull(),
    reason: varchar("reason", { length: 24 }).notNull(),
  },
  (t) => [index("ix_audit_checkpoint_seq").on(t.seq)],
);

/** Retention removal evidence: the event row is gone, its chain digest and identity remain attested. */
export const auditTombstones = mysqlTable(
  "audit_tombstones",
  {
    id: idColumn(),
    eventRowId: refColumn("event_row_id").notNull(),
    eventId: char("event_id", { length: 26 }).notNull(),
    seq: bigint("seq", { mode: "number", unsigned: true }).notNull(),
    eventDigest: char("event_digest", { length: 64 }).notNull(),
    category: varchar("category", { length: 24 }).notNull(),
    occurredAt: utcDateTime("occurred_at").notNull(),
    retentionRunId: char("retention_run_id", { length: 26 }).notNull(),
    removedAt: utcDateTime("removed_at").notNull(),
    /** HMAC (chain key, domain "rp.audit.tombstone/1") over seq|event_id|digest|run_id: a DB-only actor cannot mint one. */
    receipt: char("receipt", { length: 64 }).notNull(),
  },
  (t) => [uniqueIndex("ux_audit_tomb_event").on(t.eventId), uniqueIndex("ux_audit_tomb_seq").on(t.seq)],
);

export const auditSavedQueries = mysqlTable(
  "audit_saved_queries",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    ownerUserId: refColumn("owner_user_id").notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    shared: boolean("shared").notNull().default(false),
    query: json("query").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [index("ix_audit_sq_owner").on(t.ownerUserId), index("ix_audit_sq_shared").on(t.shared)],
);

export const auditCases = mysqlTable(
  "audit_cases",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    /** Investigator-supplied title, encrypted (may describe a person). AAD `audit_cases.title:<publicId>`. */
    titleEnc: text("title_enc").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    severity: varchar("severity", { length: 8 }).notNull().default("WARN"),
    createdBy: refColumn("created_by").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    closedAt: utcDateTime("closed_at"),
  },
  (t) => [index("ix_audit_cases_status").on(t.status, t.updatedAt)],
);

export const auditCaseEvents = mysqlTable(
  "audit_case_events",
  {
    id: idColumn(),
    caseId: refColumn("case_id").notNull(),
    eventId: char("event_id", { length: 26 }).notNull(),
    addedBy: refColumn("added_by").notNull(),
    addedAt: utcDateTime("added_at").notNull(),
  },
  (t) => [uniqueIndex("ux_audit_case_event").on(t.caseId, t.eventId), index("ix_audit_case_event_event").on(t.eventId)],
);

/** Append-only annotations. Body encrypted, AAD `audit_case_notes.body:<publicId>`. */
export const auditCaseNotes = mysqlTable(
  "audit_case_notes",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    caseId: refColumn("case_id").notNull(),
    authorUserId: refColumn("author_user_id").notNull(),
    bodyEnc: text("body_enc").notNull(),
    createdAt: utcDateTime("created_at").notNull(),
  },
  (t) => [index("ix_audit_case_notes_case").on(t.caseId, t.createdAt)],
);

export const auditExports = mysqlTable(
  "audit_exports",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    requestedBy: refColumn("requested_by").notNull(),
    format: varchar("format", { length: 8 }).notNull(),
    query: json("query").notNull(),
    status: varchar("status", { length: 12 }).notNull().default("queued"),
    reasonCode: varchar("reason_code", { length: 64 }),
    jobId: varchar("job_id", { length: 64 }),
    objectKey: varchar("object_key", { length: 200 }),
    rowCount: int("row_count", { unsigned: true }),
    byteSize: bigint("byte_size", { mode: "number", unsigned: true }),
    sha256: char("sha256", { length: 64 }),
    manifest: json("manifest"),
    truncated: boolean("truncated").notNull().default(false),
    createdAt: createdAtColumn(),
    completedAt: utcDateTime("completed_at"),
    expiresAt: utcDateTime("expires_at"),
    downloadCount: int("download_count", { unsigned: true }).notNull().default(0),
  },
  (t) => [index("ix_audit_exports_req").on(t.requestedBy, t.createdAt), index("ix_audit_exports_status").on(t.status)],
);

export const auditRetentionPolicies = mysqlTable("audit_retention_policies", {
  category: varchar("category", { length: 24 }).primaryKey(),
  retainDays: int("retain_days", { unsigned: true }).notNull(),
  updatedBy: refColumn("updated_by").notNull(),
  updatedAt: utcDateTime("updated_at").notNull(),
});

export const auditLegalHolds = mysqlTable(
  "audit_legal_holds",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    /** Encrypted label, AAD `audit_legal_holds.label:<publicId>`. */
    labelEnc: text("label_enc").notNull(),
    /** null = all categories. */
    categories: json("categories").$type<string[] | null>(),
    fromAt: utcDateTime("from_at").notNull(),
    toAt: utcDateTime("to_at").notNull(),
    createdBy: refColumn("created_by").notNull(),
    createdAt: createdAtColumn(),
    releasedAt: utcDateTime("released_at"),
    releasedBy: refColumn("released_by"),
  },
  (t) => [index("ix_audit_holds_active").on(t.releasedAt)],
);

export const auditRetentionRuns = mysqlTable("audit_retention_runs", {
  id: idColumn(),
  publicId: publicIdColumn(),
  dryRun: boolean("dry_run").notNull(),
  status: varchar("status", { length: 12 }).notNull(),
  requestedBy: refColumn("requested_by"),
  counts: json("counts").$type<Record<string, number>>().notNull(),
  startedAt: utcDateTime("started_at").notNull(),
  finishedAt: utcDateTime("finished_at"),
  checkpointPublicId: char("checkpoint_public_id", { length: 26 }),
});

/* ------------------------------------------------------------------ increment 06, D7: event correlation */

/**
 * Security incidents produced by the correlation rules (correlation/rules.ts). Mutable workflow rows (status,
 * counts) — the evidence stays in `audit_events`; every change here is itself recorded as `security.incident.*`.
 * No raw addresses or identifiers: `subject_ref` is a keyed pseudonym (source address / account blind index) or a
 * user public id; `address_event_id` names the correlated event whose encrypted address a ban action may resolve.
 */
export const securityIncidents = mysqlTable(
  "security_incidents",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    ruleKey: varchar("rule_key", { length: 40 }).notNull(),
    severity: varchar("severity", { length: 8 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    /** SHA-256 hex of rule_key|subject_kind|subject_ref: merges new evidence into the open incident. */
    dedupeKey: char("dedupe_key", { length: 64 }).notNull(),
    subjectKind: varchar("subject_kind", { length: 12 }).notNull(),
    subjectRef: varchar("subject_ref", { length: 64 }),
    userPublicId: varchar("user_public_id", { length: 64 }),
    addressEventId: char("address_event_id", { length: 26 }),
    firstEventAt: utcDateTime("first_event_at").notNull(),
    lastEventAt: utcDateTime("last_event_at").notNull(),
    eventCount: int("event_count", { unsigned: true }).notNull().default(0),
    accountCount: int("account_count", { unsigned: true }).notNull().default(0),
    addressCount: int("address_count", { unsigned: true }).notNull().default(0),
    version: int("version", { unsigned: true }).notNull().default(1),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    acknowledgedAt: utcDateTime("acknowledged_at"),
    acknowledgedBy: refColumn("acknowledged_by"),
    closedAt: utcDateTime("closed_at"),
    closedBy: refColumn("closed_by"),
    closeReason: varchar("close_reason", { length: 24 }),
  },
  (t) => [
    index("ix_sec_inc_status_last").on(t.status, t.lastEventAt),
    index("ix_sec_inc_dedupe").on(t.dedupeKey, t.status),
    index("ix_sec_inc_rule_last").on(t.ruleKey, t.lastEventAt),
    index("ix_sec_inc_last").on(t.lastEventAt, t.id),
  ],
);

/** Correlated audit events of an incident (capped per incident; `event_count` keeps counting past the cap). */
export const securityIncidentEvents = mysqlTable(
  "security_incident_events",
  {
    id: idColumn(),
    incidentId: refColumn("incident_id").notNull(),
    eventId: char("event_id", { length: 26 }).notNull(),
    eventName: varchar("event_name", { length: 96 }).notNull(),
    occurredAt: utcDateTime("occurred_at").notNull(),
    addedAt: utcDateTime("added_at").notNull(),
  },
  (t) => [uniqueIndex("ux_sec_inc_event").on(t.incidentId, t.eventId), index("ix_sec_inc_event_event").on(t.eventId), index("ix_sec_inc_event_time").on(t.incidentId, t.occurredAt)],
);

/** Append-only incident timeline (opened, events added, escalated, acknowledged, closed, actions). Safe values only. */
export const securityIncidentTimeline = mysqlTable(
  "security_incident_timeline",
  {
    id: idColumn(),
    incidentId: refColumn("incident_id").notNull(),
    at: utcDateTime("at").notNull(),
    kind: varchar("kind", { length: 24 }).notNull(),
    actorUserId: refColumn("actor_user_id"),
    detail: json("detail").$type<Record<string, string | number | boolean | null>>().notNull(),
  },
  (t) => [index("ix_sec_inc_timeline").on(t.incidentId, t.at, t.id)],
);

/** Singleton (id = 1): serialises correlation runs (SELECT … FOR UPDATE) and keeps the last run summary for health. */
export const securityCorrelationState = mysqlTable("security_correlation_state", {
  id: tinyint("id", { unsigned: true }).primaryKey(),
  lastRunAt: utcDateTime("last_run_at"),
  lastRunEvents: int("last_run_events", { unsigned: true }).notNull().default(0),
  lastRunFindings: int("last_run_findings", { unsigned: true }).notNull().default(0),
  lastRunTruncated: boolean("last_run_truncated").notNull().default(false),
  lastRunReason: varchar("last_run_reason", { length: 64 }),
});
