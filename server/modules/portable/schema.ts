import { char, index, int, json, mediumtext, mysqlEnum, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, utcDateTime, versionColumn } from "../../db/columns.js";
import { OPERATION_STATES } from "../../../shared/domain.js";

export const IMPORT_PHASES = [
  "received",
  "quarantined",
  "verified",
  "planned",
  "approved",
  "objects-prepared",
  "records-committed",
  "finalized",
  "reconciled",
  "accepted",
  "held-unknown",
  "failed",
  "canceled",
] as const;
export type ImportPhase = typeof IMPORT_PHASES[number];
export type PortableCounts = Record<string, number>;

export interface PlanSummary {
  counts: { creates: number; links: number; conflicts: number; heldUnknown: number };
  samples: { portableId: string; disposition: "create" | "link" | "conflict" | "hold"; reason?: string }[];
}

export interface ReconciliationReport {
  inventory: number;
  imported: number;
  linked: number;
  heldUnknown: number;
  objects: number;
  verifiedObjects: number;
  discrepancies: number;
}

export const portableExports = mysqlTable("portable_exports", {
  id: idColumn(),
  publicId: publicIdColumn(),
  requestedBy: refColumn("requested_by").notNull(),
  requesterPublicId: char("requester_public_id", { length: 26 }).notNull(),
  state: mysqlEnum("state", OPERATION_STATES).notNull().default("running"),
  selection: mysqlEnum("selection", ["all", "customers", "orders"]).notNull(),
  storageKey: varchar("storage_key", { length: 100 }).notNull(),
  packageId: varchar("package_id", { length: 128 }),
  sha256: char("sha256", { length: 64 }),
  size: refColumn("size"),
  counts: json("counts").$type<PortableCounts>(),
  reasonCode: varchar("reason_code", { length: 64 }),
  createdAt: createdAtColumn(),
  expiresAt: utcDateTime("expires_at").notNull(),
  deletedAt: utcDateTime("deleted_at"),
}, (t) => [index("portable_exports_expiry_idx").on(t.deletedAt, t.expiresAt)]);

export const portableImports = mysqlTable("portable_imports", {
  id: idColumn(),
  publicId: publicIdColumn(),
  submittedBy: refColumn("submitted_by").notNull(),
  phase: mysqlEnum("phase", IMPORT_PHASES).notNull().default("received"),
  state: mysqlEnum("state", OPERATION_STATES).notNull().default("running"),
  version: versionColumn(),
  storageKey: varchar("storage_key", { length: 100 }).notNull(),
  inputSha256: char("input_sha256", { length: 64 }),
  inputSize: refColumn("input_size"),
  packageId: varchar("package_id", { length: 128 }),
  installationId: varchar("installation_id", { length: 63 }).notNull(),
  planDigest: char("plan_digest", { length: 64 }),
  plan: json("plan").$type<PlanSummary>(),
  reconciliation: json("reconciliation").$type<ReconciliationReport>(),
  reasonCode: varchar("reason_code", { length: 64 }),
  approvedBy: refColumn("approved_by"),
  approverSessionId: varchar("approver_session_id", { length: 128 }),
  approverPublicId: char("approver_public_id", { length: 26 }),
  approvalStepUpAt: utcDateTime("approval_step_up_at"),
  planExpiresAt: utcDateTime("plan_expires_at"),
  createdAt: createdAtColumn(),
  updatedAt: utcDateTime("updated_at").notNull(),
}, (t) => [index("portable_import_package_idx").on(t.packageId, t.publicId)]);

/** Immutable transition and approval receipts. Internal storage references never appear here. */
export const portableImportSteps = mysqlTable("portable_import_steps", {
  id: idColumn(),
  publicId: publicIdColumn(),
  importId: refColumn("import_id").notNull(),
  fromPhase: mysqlEnum("from_phase", IMPORT_PHASES),
  toPhase: mysqlEnum("to_phase", IMPORT_PHASES).notNull(),
  inputSha256: char("input_sha256", { length: 64 }),
  planDigest: char("plan_digest", { length: 64 }),
  installationId: varchar("installation_id", { length: 63 }).notNull(),
  actorUserId: refColumn("actor_user_id"),
  stepUpAt: utcDateTime("step_up_at"),
  jobId: varchar("job_id", { length: 128 }),
  fence: refColumn("fence"),
  createdAt: createdAtColumn(),
}, (t) => [uniqueIndex("portable_steps_import_phase_uq").on(t.importId, t.toPhase)]);

/** Encrypted verified input and exact disposition; unknown fields remain inert. */
export const portableImportRecords = mysqlTable("portable_import_records", {
  id: idColumn(),
  importId: refColumn("import_id").notNull(),
  portableId: varchar("portable_id", { length: 128 }).notNull(),
  recordType: varchar("record_type", { length: 80 }).notNull(),
  position: int("position", { unsigned: true }).notNull(),
  disposition: mysqlEnum("disposition", ["create", "link", "conflict", "hold"]).notNull(),
  reasonCode: varchar("reason_code", { length: 64 }),
  digest: char("digest", { length: 64 }).notNull(),
  encryptedPayload: mediumtext("encrypted_payload").notNull(),
  receiptAt: utcDateTime("receipt_at"),
}, (t) => [
  uniqueIndex("portable_import_record_ref_uq").on(t.importId, t.recordType, t.portableId),
  uniqueIndex("portable_import_record_position_uq").on(t.importId, t.position),
  index("portable_import_record_remaining_idx").on(t.importId, t.receiptAt, t.position),
]);

/** Durable staging references; an orphan cannot be inferred from an interrupted external call. */
export const portableImportObjects = mysqlTable("portable_import_objects", {
  id: idColumn(),
  importId: refColumn("import_id").notNull(),
  sha256: char("sha256", { length: 64 }).notNull(),
  size: refColumn("size").notNull(),
  escrowKey: varchar("escrow_key", { length: 100 }).notNull(),
  escrowCipherDigest: char("escrow_cipher_digest", { length: 64 }),
  preparedKey: varchar("prepared_key", { length: 100 }).notNull(),
  preparedAt: utcDateTime("prepared_at"),
  reconciledAt: utcDateTime("reconciled_at"),
}, (t) => [uniqueIndex("portable_import_object_digest_uq").on(t.importId, t.sha256)]);

/** Serializes execution for an exact package without making a passphrase a durable dependency. */
export const portablePackageReservations = mysqlTable("portable_package_reservations", {
  packageId: varchar("package_id", { length: 128 }).primaryKey(),
  importId: refColumn("import_id"),
});

export const portableMappings = mysqlTable("portable_mappings", {
  id: idColumn(),
  packageId: varchar("package_id", { length: 128 }).notNull(),
  sourcePortableId: varchar("source_portable_id", { length: 128 }).notNull(),
  recordType: varchar("record_type", { length: 80 }).notNull(),
  sourceDigest: char("source_digest", { length: 64 }).notNull(),
  localId: refColumn("local_id"),
  localPublicId: char("local_public_id", { length: 26 }),
  originalImportId: refColumn("original_import_id").notNull(),
  createdAt: createdAtColumn(),
}, (t) => [uniqueIndex("portable_mapping_source_uq").on(t.packageId, t.recordType, t.sourcePortableId)]);
