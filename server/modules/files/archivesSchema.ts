/**
 * File archives (increment 07, package J, D8): phase ZIP and administrator whole-order ZIP. Additive tables only.
 * An archive is built by a job from a FIXED manifest captured at request time (public ids, version, size,
 * sha256, entry name); members are re-authorised at build and the whole archive again at download. The ZIP
 * object lives in private storage under an encrypted key and expires after 30 minutes.
 */
import { bigint, char, index, int, json, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, utcDateTime, versionColumn } from "../../db/columns.js";

export const FILE_ARCHIVE_SCOPES = ["stage", "order"] as const;
export const FILE_ARCHIVE_STATES = ["queued", "building", "ready", "failed", "expired", "revoked"] as const;
export type FileArchiveScope = (typeof FILE_ARCHIVE_SCOPES)[number];
export type FileArchiveState = (typeof FILE_ARCHIVE_STATES)[number];

/** One manifest entry. No path or name from the client: `entryName` is derived and sanitised on the server. */
export interface FileArchiveManifestEntry {
  filePublicId: string;
  version: number;
  size: number;
  sha256: string | null;
  entryName: string;
}

export const fileArchives = mysqlTable(
  "file_archives",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    orderId: refColumn("order_id").notNull(),
    orderPublicId: char("order_public_id", { length: 26 }).notNull(),
    scope: mysqlEnum("scope", FILE_ARCHIVE_SCOPES).notNull(),
    /** Set for `stage` scope; null for a whole-order archive. */
    stageKey: varchar("stage_key", { length: 64 }),
    requestedByUserId: refColumn("requested_by_user_id").notNull(),
    /**
     * Public, non-secret session id of the request (as in `file_download_tickets`). The build job re-authorises
     * as this live session and the archive is downloadable only from it.
     */
    sessionId: varchar("session_id", { length: 80 }).notNull(),
    /** Set while queued/building/ready; its unique index gives one active archive per account across processes. */
    activeUserId: refColumn("active_user_id"),
    state: mysqlEnum("state", FILE_ARCHIVE_STATES).notNull().default("queued"),
    reasonCode: varchar("reason_code", { length: 64 }),
    manifest: json("manifest").$type<FileArchiveManifestEntry[]>().notNull(),
    fileCount: int("file_count", { unsigned: true }).notNull(),
    /** Sum of member sizes (uncompressed), capped at 500 MiB. */
    totalBytes: bigint("total_bytes", { mode: "number", unsigned: true }).notNull(),
    zipBytes: bigint("zip_bytes", { mode: "number", unsigned: true }),
    zipSha256: char("zip_sha256", { length: 64 }),
    /** Private storage key of the built ZIP, field-encrypted (AAD `file_archives.object_key:<publicId>`). */
    objectKeyEnc: text("object_key_enc"),
    jobId: varchar("job_id", { length: 64 }),
    expiresAt: utcDateTime("expires_at").notNull(),
    builtAt: utcDateTime("built_at"),
    downloadCount: int("download_count", { unsigned: true }).notNull().default(0),
    lastDownloadedAt: utcDateTime("last_downloaded_at"),
    /** Storage object deleted (expiry, revocation or failure clean-up). */
    purgedAt: utcDateTime("purged_at"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("file_archives_active_user_uq").on(t.activeUserId),
    index("file_archives_order_idx").on(t.orderId, t.createdAt),
    index("file_archives_user_idx").on(t.requestedByUserId, t.createdAt),
    index("file_archives_expiry_idx").on(t.state, t.expiresAt),
  ],
);

/** Single-use download tickets for archives (same shape and rules as `file_download_tickets`, 60 seconds). */
export const fileArchiveTickets = mysqlTable(
  "file_archive_tickets",
  {
    id: idColumn(),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    archiveId: refColumn("archive_id").notNull(),
    userId: refColumn("user_id").notNull(),
    sessionId: varchar("session_id", { length: 80 }).notNull(),
    issuedAt: utcDateTime("issued_at").notNull(),
    expiresAt: utcDateTime("expires_at").notNull(),
    usedAt: utcDateTime("used_at"),
  },
  (t) => [
    uniqueIndex("file_archive_tickets_hash_uq").on(t.tokenHash),
    index("file_archive_tickets_archive_idx").on(t.archiveId),
    index("file_archive_tickets_exp_idx").on(t.expiresAt),
  ],
);
