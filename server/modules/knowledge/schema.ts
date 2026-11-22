/**
 * Knowledge Base module — additive Drizzle MySQL schema (Increment 04, Package F).
 * Owner: engagement_engineer (`server/modules/knowledge/**`).
 *
 * Every foreign key and index name is explicitly named (`<= 36` chars, well within
 * MySQL's 64-character identifier limit).
 * Migrations are generated centrally by `/root` (`migrations/0003_*.sql`).
 */
import {
  bigint,
  boolean,
  char,
  foreignKey,
  index,
  int,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  text,
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

export const KNOWLEDGE_AUDIENCES = ["customers", "staff"] as const;
export type KnowledgeAudience = (typeof KNOWLEDGE_AUDIENCES)[number];

export const KNOWLEDGE_ARTICLE_STATES = ["draft", "published", "archived"] as const;
export type KnowledgeArticleState = (typeof KNOWLEDGE_ARTICLE_STATES)[number];

export const knowledgeCategories = mysqlTable(
  "knowledge_categories",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    /** Optional parent category (`null` = top-level; service enforces max nesting depth = 1). */
    parentCategoryId: refColumn("parent_category_id"),
    slug: varchar("slug", { length: 120 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    description: varchar("description", { length: 500 }),
    sortOrder: int("sort_order", { unsigned: true }).notNull().default(0),
    archivedAt: utcDateTime("archived_at"),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("uq_kb_cat_slug").on(t.slug),
    index("idx_kb_cat_parent_sort").on(t.parentCategoryId, t.sortOrder, t.id),
  ],
);

export const knowledgeArticles = mysqlTable(
  "knowledge_articles",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    categoryId: refColumn("category_id"),
    slug: varchar("slug", { length: 120 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    summary: varchar("summary", { length: 500 }).notNull(),
    /** Canonical HTML sanitised via `mailTemplates/sanitizer.ts` allow-list on write. */
    bodyHtml: mediumtext("body_html").notNull(),
    /** Normalized plain text derived from the sanitised AST for ranked search and safe snippet highlighting. */
    bodyText: mediumtext("body_text").notNull(),
    /** JSON array of normalized lowercase tag strings (`string[]`). */
    tagsJson: text("tags_json").notNull(),
    audience: mysqlEnum("audience", KNOWLEDGE_AUDIENCES).notNull().default("customers"),
    state: mysqlEnum("state", KNOWLEDGE_ARTICLE_STATES).notNull().default("draft"),
    publishedAt: utcDateTime("published_at"),
    /** Optional ISO calendar date (`YYYY-MM-DD`) when the article was last reviewed for accuracy. */
    reviewedOn: varchar("reviewed_on", { length: 10 }),
    authorUserId: refColumn("author_user_id").notNull(),
    updatedByUserId: refColumn("updated_by_user_id").notNull(),
    sortOrder: int("sort_order", { unsigned: true }).notNull().default(0),
    viewCount: bigint("view_count", { mode: "number", unsigned: true }).notNull().default(0),
    helpfulYesCount: int("helpful_yes_count", { unsigned: true }).notNull().default(0),
    helpfulNoCount: int("helpful_no_count", { unsigned: true }).notNull().default(0),
    currentVersionNumber: int("current_version_number", { unsigned: true }).notNull().default(1),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("uq_kb_art_slug").on(t.slug),
    index("idx_kb_art_pub_list").on(t.state, t.audience, t.sortOrder, t.id),
    index("idx_kb_art_cat_sort").on(t.categoryId, t.state, t.sortOrder, t.id),
    index("idx_kb_art_updated").on(t.updatedAt, t.id),
    foreignKey({
      name: "kb_art_cat_fk",
      columns: [t.categoryId],
      foreignColumns: [knowledgeCategories.id],
    }),
    foreignKey({
      name: "kb_art_author_fk",
      columns: [t.authorUserId],
      foreignColumns: [users.id],
    }),
    foreignKey({
      name: "kb_art_updater_fk",
      columns: [t.updatedByUserId],
      foreignColumns: [users.id],
    }),
  ],
);

export const knowledgeArticleVersions = mysqlTable(
  "knowledge_article_versions",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    articleId: refColumn("article_id").notNull(),
    versionNumber: int("version_number", { unsigned: true }).notNull(),
    categoryId: refColumn("category_id"),
    slug: varchar("slug", { length: 120 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    summary: varchar("summary", { length: 500 }).notNull(),
    bodyHtml: mediumtext("body_html").notNull(),
    bodyText: mediumtext("body_text").notNull(),
    tagsJson: text("tags_json").notNull(),
    audience: mysqlEnum("audience", KNOWLEDGE_AUDIENCES).notNull(),
    reviewedOn: varchar("reviewed_on", { length: 10 }),
    changeNote: varchar("change_note", { length: 255 }),
    authorUserId: refColumn("author_user_id").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("uq_kb_ver_num").on(t.articleId, t.versionNumber),
    index("idx_kb_ver_created").on(t.articleId, t.createdAt),
    foreignKey({
      name: "kb_ver_art_fk",
      columns: [t.articleId],
      foreignColumns: [knowledgeArticles.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "kb_ver_author_fk",
      columns: [t.authorUserId],
      foreignColumns: [users.id],
    }),
  ],
);

export const knowledgeArticleTags = mysqlTable(
  "knowledge_article_tags",
  {
    id: idColumn(),
    articleId: refColumn("article_id").notNull(),
    tag: varchar("tag", { length: 64 }).notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("uq_kb_tags_pair").on(t.articleId, t.tag),
    index("idx_kb_tags_lookup").on(t.tag, t.articleId),
    foreignKey({
      name: "kb_tags_art_fk",
      columns: [t.articleId],
      foreignColumns: [knowledgeArticles.id],
    }).onDelete("cascade"),
  ],
);

export const knowledgeArticleRelations = mysqlTable(
  "knowledge_article_relations",
  {
    id: idColumn(),
    articleId: refColumn("article_id").notNull(),
    relatedArticleId: refColumn("related_article_id").notNull(),
    sortOrder: int("sort_order", { unsigned: true }).notNull().default(0),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("uq_kb_rel_pair").on(t.articleId, t.relatedArticleId),
    index("idx_kb_rel_target").on(t.relatedArticleId),
    foreignKey({
      name: "kb_rel_src_art_fk",
      columns: [t.articleId],
      foreignColumns: [knowledgeArticles.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "kb_rel_dst_art_fk",
      columns: [t.relatedArticleId],
      foreignColumns: [knowledgeArticles.id],
    }).onDelete("cascade"),
  ],
);

export const knowledgeArticleAttachments = mysqlTable(
  "knowledge_article_attachments",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    articleId: refColumn("article_id").notNull(),
    uploadedByUserId: refColumn("uploaded_by_user_id").notNull(),
    /** Immutable object storage key allocated via `deps.storage.newKey("files")` (`files/<32hex>`). */
    storageKey: varchar("storage_key", { length: 48 }).notNull(),
    /** AES-256-GCM encrypted filename (`knowledge_article_attachments.display_name:${publicId}`). */
    displayNameEnc: text("display_name_enc").notNull(),
    byteSize: bigint("byte_size", { mode: "number", unsigned: true }).notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    contentType: varchar("content_type", { length: 80 }).notNull(),
    extension: varchar("extension", { length: 16 }).notNull(),
    deletedAt: utcDateTime("deleted_at"),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("uq_kb_att_storage_key").on(t.storageKey),
    index("idx_kb_att_article").on(t.articleId, t.deletedAt, t.id),
    foreignKey({
      name: "kb_att_art_fk",
      columns: [t.articleId],
      foreignColumns: [knowledgeArticles.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "kb_att_uploader_fk",
      columns: [t.uploadedByUserId],
      foreignColumns: [users.id],
    }),
  ],
);

export const knowledgeAttachmentTickets = mysqlTable(
  "knowledge_attachment_tickets",
  {
    id: idColumn(),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    attachmentId: refColumn("attachment_id").notNull(),
    userId: refColumn("user_id").notNull(),
    sessionId: varchar("session_id", { length: 80 }).notNull(),
    issuedAt: utcDateTime("issued_at").notNull(),
    expiresAt: utcDateTime("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_kb_tkt_hash").on(t.tokenHash),
    index("idx_kb_tkt_exp").on(t.expiresAt),
    foreignKey({
      name: "kb_tkt_att_fk",
      columns: [t.attachmentId],
      foreignColumns: [knowledgeArticleAttachments.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "kb_tkt_user_fk",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  ],
);

export const knowledgeArticleFeedback = mysqlTable(
  "knowledge_article_feedback",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    articleId: refColumn("article_id").notNull(),
    userId: refColumn("user_id").notNull(),
    helpful: boolean("helpful").notNull(),
    /** Optional user comment encrypted at rest (`knowledge_article_feedback.comment_enc:${publicId}`). */
    commentEnc: text("comment_enc"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("uq_kb_fb_art_user").on(t.articleId, t.userId),
    index("idx_kb_fb_art_created").on(t.articleId, t.createdAt),
    foreignKey({
      name: "kb_fb_art_fk",
      columns: [t.articleId],
      foreignColumns: [knowledgeArticles.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "kb_fb_user_fk",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  ],
);

export const knowledgeArticleViewDedup = mysqlTable(
  "knowledge_article_view_dedup",
  {
    id: idColumn(),
    articleId: refColumn("article_id").notNull(),
    /** Keyed HMAC digest over `(articleId, hourBucket, sessionId)` — expires and is purged hourly/daily. */
    viewerSlotHash: char("viewer_slot_hash", { length: 64 }).notNull(),
    expiresAt: utcDateTime("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_kb_view_dedup_slot").on(t.articleId, t.viewerSlotHash),
    index("idx_kb_view_dedup_exp").on(t.expiresAt),
    foreignKey({
      name: "kb_vdedup_art_fk",
      columns: [t.articleId],
      foreignColumns: [knowledgeArticles.id],
    }).onDelete("cascade"),
  ],
);

/**
 * Aggregated search-term insights WITHOUT user identity (`userId`, `sessionId`, IP, or request correlation
 * are deliberately absent by schema design per Contract §2.F).
 */
export const knowledgeSearchLogs = mysqlTable(
  "knowledge_search_logs",
  {
    id: idColumn(),
    audienceScope: mysqlEnum("audience_scope", KNOWLEDGE_AUDIENCES).notNull().default("customers"),
    /** Lowercased, whitespace-normalized, PII-scrubbed query string (`<= 120` chars). */
    normalizedTerm: varchar("normalized_term", { length: 120 }).notNull(),
    searchCount: int("search_count", { unsigned: true }).notNull().default(1),
    zeroResultCount: int("zero_result_count", { unsigned: true }).notNull().default(0),
    lastResultCount: int("last_result_count", { unsigned: true }).notNull().default(0),
    firstSearchedAt: utcDateTime("first_searched_at").notNull(),
    lastSearchedAt: utcDateTime("last_searched_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_kb_search_term_scope").on(t.audienceScope, t.normalizedTerm),
    index("idx_kb_search_top").on(t.audienceScope, t.searchCount, t.lastSearchedAt),
    index("idx_kb_search_zero").on(t.audienceScope, t.zeroResultCount, t.lastSearchedAt),
    index("idx_kb_search_ret").on(t.lastSearchedAt),
  ],
);
