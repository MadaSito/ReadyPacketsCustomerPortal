/**
 * Mail Templates module — Drizzle MySQL tables. Owner: compliance_engineer (Package D).
 *
 * Additive schema for Increment 03:
 *  - `mail_templates`: system templates mirroring built-in `mailer.registerTemplate` keys and
 *    administrator-authored custom templates for automations.
 *  - `mail_template_versions`: append-only published version history plus at most one active
 *    working draft per template.
 *
 * All foreign-key and index names are <= 32 characters (MySQL identifier cap = 64).
 */
import {
  char,
  foreignKey,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import {
  createdAtColumn,
  idColumn,
  publicIdColumn,
  refColumn,
  updatedAtColumn,
  utcDateTime,
  versionColumn,
} from "../../db/columns.js";
import { users } from "../identity/schema.js";

export const MAIL_TEMPLATE_KINDS = ["system", "custom"] as const;
export type MailTemplateKind = (typeof MAIL_TEMPLATE_KINDS)[number];

export const MAIL_TEMPLATE_CATEGORIES = [
  "auth",
  "orders",
  "compliance",
  "engagement",
  "operations",
  "automation",
] as const;
export type MailTemplateCategory = (typeof MAIL_TEMPLATE_CATEGORIES)[number];

export const MAIL_TEMPLATE_VERSION_STATES = ["draft", "published"] as const;
export type MailTemplateVersionState = (typeof MAIL_TEMPLATE_VERSION_STATES)[number];

export const MAIL_TEMPLATE_FORMATS = ["html", "text"] as const;
export type MailTemplateFormat = (typeof MAIL_TEMPLATE_FORMATS)[number];

export interface MailTemplateVariableSpec {
  name: string;
  label: string;
  required: boolean;
  sensitive?: boolean;
  sampleValue: string;
}

export const mailTemplates = mysqlTable(
  "mail_templates",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    templateKey: varchar("template_key", { length: 100 }).notNull(),
    kind: mysqlEnum("kind", MAIL_TEMPLATE_KINDS).notNull(),
    category: mysqlEnum("category", MAIL_TEMPLATE_CATEGORIES).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    description: varchar("description", { length: 500 }).notNull().default(""),
    declaredVarsJson: json("declared_vars_json").$type<MailTemplateVariableSpec[]>().notNull(),
    /**
     * Pointer to `mail_template_versions.id` currently live for outbound delivery.
     * For `system` templates, `null` means the built-in default template is active.
     * For `custom` templates, `null` means unpublished (not yet resolvable for delivery).
     */
    activePublishedVersionId: refColumn("active_published_version_id"),
    /** Pointer to the single editable `draft` row in `mail_template_versions`, if any. */
    workingDraftVersionId: refColumn("working_draft_version_id"),
    latestVersionNumber: int("latest_version_number", { unsigned: true }).notNull().default(0),
    version: versionColumn(),
    createdByUserId: refColumn("created_by_user_id"),
    updatedByUserId: refColumn("updated_by_user_id"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "mt_templates_created_by_fk",
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: "mt_templates_updated_by_fk",
      columns: [t.updatedByUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("mt_templates_key_uq").on(t.templateKey),
    index("mt_templates_kind_cat_idx").on(t.kind, t.category),
  ],
);

export const mailTemplateVersions = mysqlTable(
  "mail_template_versions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    templateId: refColumn("template_id").notNull(),
    versionNumber: int("version_number", { unsigned: true }).notNull(),
    state: mysqlEnum("state", MAIL_TEMPLATE_VERSION_STATES).notNull().default("draft"),
    format: mysqlEnum("format", MAIL_TEMPLATE_FORMATS).notNull().default("html"),
    subject: varchar("subject", { length: 255 }).notNull(),
    /** Canonical server-sanitized HTML when `format === "html"`, otherwise `null`. */
    bodyHtml: mediumtext("body_html"),
    /** Plain-text alternative (always required and non-empty for both `html` and `text` formats). */
    bodyText: mediumtext("body_text").notNull(),
    /** SHA-256 hex digest over normalized `(format, subject, bodyHtml, bodyText)`. */
    contentHash: char("content_hash", { length: 64 }).notNull(),
    changeNote: varchar("change_note", { length: 500 }).notNull().default(""),
    restoredFromVersionNumber: int("restored_from_version_number", { unsigned: true }),
    createdByUserId: refColumn("created_by_user_id"),
    publishedAt: utcDateTime("published_at"),
    publishedByUserId: refColumn("published_by_user_id"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    foreignKey({
      name: "mt_versions_tpl_fk",
      columns: [t.templateId],
      foreignColumns: [mailTemplates.id],
    }),
    foreignKey({
      name: "mt_versions_created_by_fk",
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: "mt_versions_published_by_fk",
      columns: [t.publishedByUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("mt_versions_tpl_num_uq").on(t.templateId, t.versionNumber),
    index("mt_versions_tpl_state_idx").on(t.templateId, t.state),
  ],
);
