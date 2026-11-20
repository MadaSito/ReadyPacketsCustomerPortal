/**
 * Platform module — Drizzle MySQL tables. Owner: platform module engineer.
 */
import { bigint, char, index, int, json, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime, versionColumn } from "../../db/columns.js";

/**
 * One row per declared setting that has ever been written. Value settings use `value_json`; secrets use
 * `secret_enc` (FieldCrypto envelope, AAD `platform_settings.secret:<key>`). `version` gives optimistic
 * concurrency; a cleared secret keeps its row (secret_enc NULL) so the version keeps increasing.
 */
export const platformSettings = mysqlTable(
  "platform_settings",
  {
    id: idColumn(),
    settingKey: varchar("setting_key", { length: 96 }).notNull(),
    kind: varchar("kind", { length: 8, enum: ["value", "secret", "flag"] }).notNull(),
    valueJson: json("value_json"),
    secretEnc: text("secret_enc"),
    version: versionColumn(),
    updatedByUserId: refColumn("updated_by_user_id"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex("platform_settings_key_uq").on(t.settingKey)],
);

/** Sign-in slideshow images uploaded through the validated image path (bytes live in private storage). */
export const platformPresentationImages = mysqlTable(
  "platform_presentation_images",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    storageKey: varchar("storage_key", { length: 128 }).notNull(),
    mimeType: varchar("mime_type", { length: 16, enum: ["image/png", "image/jpeg", "image/webp"] }).notNull(),
    byteSize: int("byte_size", { unsigned: true }).notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    width: int("width", { unsigned: true }).notNull(),
    height: int("height", { unsigned: true }).notNull(),
    uploadedByUserId: refColumn("uploaded_by_user_id"),
    createdAt: createdAtColumn(),
    deletedAt: utcDateTime("deleted_at"),
    /** Set once the stored bytes of a soft-deleted image were removed (GC success marker). */
    objectPurgedAt: utcDateTime("object_purged_at"),
  },
  (t) => [
    index("platform_presentation_images_sha_idx").on(t.sha256),
    uniqueIndex("platform_presentation_images_storage_key_uq").on(t.storageKey),
    index("platform_presentation_images_gc_idx").on(t.deletedAt, t.objectPurgedAt),
  ],
);

/** Resumable re-encryption progress per (target, run). Checkpoint = last processed numeric id. */
export const platformReencryptCheckpoints = mysqlTable(
  "platform_reencrypt_checkpoints",
  {
    id: idColumn(),
    target: varchar("target", { length: 96 }).notNull(),
    targetKeyId: varchar("target_key_id", { length: 32 }).notNull(),
    lastId: bigint("last_id", { mode: "number", unsigned: true }).notNull().default(0),
    rewritten: int("rewritten", { unsigned: true }).notNull().default(0),
    skipped: int("skipped", { unsigned: true }).notNull().default(0),
    failed: int("failed", { unsigned: true }).notNull().default(0),
    completedAt: utcDateTime("completed_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex("platform_reencrypt_target_uq").on(t.target, t.targetKeyId)],
);
