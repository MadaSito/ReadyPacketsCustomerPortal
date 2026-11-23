/**
 * Reports (increment 06, package H, D6). Additive tables only. A definition is data (a strict spec validated by
 * `spec.ts`), never SQL; the run log carries no filter values, only the definition hash and counts.
 */
import { char, index, int, json, mysqlEnum, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime, versionColumn } from "../../db/columns.js";

export const REPORT_VISIBILITIES = ["private", "shared"] as const;

export const reportDefinitions = mysqlTable(
  "report_definitions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }).notNull().default(""),
    dataset: varchar("dataset", { length: 64 }).notNull(),
    /** The validated ReportSpec (see spec.ts). Re-validated on every read; an invalid stored spec cannot run. */
    spec: json("spec").$type<unknown>().notNull(),
    /** SHA-256 of the canonical spec JSON; recorded in report.run / report.exported. */
    specHash: char("spec_hash", { length: 64 }).notNull(),
    visibility: mysqlEnum("visibility", REPORT_VISIBILITIES).notNull().default("private"),
    ownerUserId: refColumn("owner_user_id").notNull(),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    index("report_definitions_owner_idx").on(t.ownerUserId, t.id),
    index("report_definitions_visibility_idx").on(t.visibility, t.id),
  ],
);

export const REPORT_RUN_KINDS = ["builtin", "custom", "export"] as const;
export const REPORT_RUN_STATES = ["running", "completed", "failed", "timed_out"] as const;

/**
 * One row per run. `activeUserId` is set only while the run holds the user's single slot; its unique index makes
 * "one running report per user" hold across processes (MySQL allows many NULLs). Rows are purged after 90 days.
 */
export const reportRuns = mysqlTable(
  "report_runs",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    userId: refColumn("user_id").notNull(),
    activeUserId: refColumn("active_user_id"),
    kind: mysqlEnum("kind", REPORT_RUN_KINDS).notNull(),
    /** Built-in report key or custom dataset key. */
    reportKey: varchar("report_key", { length: 64 }).notNull(),
    definitionId: refColumn("definition_id"),
    specHash: char("spec_hash", { length: 64 }).notNull(),
    state: mysqlEnum("state", REPORT_RUN_STATES).notNull().default("running"),
    rowCount: int("row_count", { unsigned: true }),
    leaseUntil: utcDateTime("lease_until").notNull(),
    startedAt: utcDateTime("started_at").notNull(),
    finishedAt: utcDateTime("finished_at"),
  },
  (t) => [
    uniqueIndex("report_runs_active_user_uq").on(t.activeUserId),
    index("report_runs_user_started_idx").on(t.userId, t.startedAt),
    index("report_runs_started_idx").on(t.startedAt),
  ],
);
