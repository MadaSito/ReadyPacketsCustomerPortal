/**
 * Community forum — Drizzle MySQL tables. Owner: audit_engineer (package M).
 * Cross-module references other than `users.id` avoid foreign keys so module tests run on schema subsets.
 * Bodies are stored as normalised constrained plain text (see text.ts); they are rendered, never interpreted as HTML.
 */
import { boolean, char, index, int, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { USER_ROLES } from "../../../shared/domain.js";
import { createdAtColumn, idColumn, publicIdColumn, refColumn, updatedAtColumn, utcDateTime, versionColumn } from "../../db/columns.js";
import { users } from "../identity/schema.js";

export const TOPIC_STATES = ["open", "hidden", "removed"] as const;
export type TopicState = (typeof TOPIC_STATES)[number];
export const POST_STATES = ["published", "pending", "hidden", "removed", "deleted"] as const;
export type PostState = (typeof POST_STATES)[number];
export const REPORT_REASONS = ["spam", "abuse", "off_topic", "personal_info", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_STATES = ["open", "actioned", "dismissed"] as const;
export type ReportState = (typeof REPORT_STATES)[number];
export const MODERATION_ACTIONS = [
  "approve", "hide", "unhide", "remove", "lock", "unlock", "pin", "unpin", "move",
  "suspend", "unsuspend", "report_dismissed", "report_actioned", "auto_hide",
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export const communityProfiles = mysqlTable(
  "community_profiles",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    userId: refColumn("user_id").notNull().references(() => users.id),
    displayName: varchar("display_name", { length: 32 }).notNull(),
    /** Case-folded, NFKC, whitespace-collapsed key for uniqueness. */
    displayNameKey: varchar("display_name_key", { length: 64 }).notNull(),
    anonymised: boolean("anonymised").notNull().default(false),
    suspendedUntil: utcDateTime("suspended_until"),
    suspendedIndefinitely: boolean("suspended_indefinitely").notNull().default(false),
    suspensionReason: varchar("suspension_reason", { length: 200 }),
    suspendedByUserId: refColumn("suspended_by_user_id"),
    postCount: int("post_count", { unsigned: true }).notNull().default(0),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex("community_profiles_user_uq").on(t.userId), uniqueIndex("community_profiles_name_uq").on(t.displayNameKey)],
);

export const communityCategories = mysqlTable(
  "community_categories",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    slug: varchar("slug", { length: 48 }).notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    description: varchar("description", { length: 300 }).notNull().default(""),
    sortOrder: int("sort_order", { unsigned: true }).notNull().default(0),
    staffOnlyPosting: boolean("staff_only_posting").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    topicCount: int("topic_count", { unsigned: true }).notNull().default(0),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex("community_categories_slug_uq").on(t.slug), index("community_categories_sort_idx").on(t.archived, t.sortOrder)],
);

export const communityTopics = mysqlTable(
  "community_topics",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    categoryId: refColumn("category_id").notNull(),
    authorUserId: refColumn("author_user_id").notNull().references(() => users.id),
    title: varchar("title", { length: 140 }).notNull(),
    state: mysqlEnum("state", TOPIC_STATES).notNull().default("open"),
    /** False until the opening post is published (new-member review). */
    visible: boolean("visible").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    locked: boolean("locked").notNull().default(false),
    replyCount: int("reply_count", { unsigned: true }).notNull().default(0),
    lastPostAt: utcDateTime("last_post_at").notNull(),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    index("community_topics_list_idx").on(t.categoryId, t.pinned, t.lastPostAt),
    index("community_topics_recent_idx").on(t.visible, t.lastPostAt),
  ],
);

export const communityPosts = mysqlTable(
  "community_posts",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    topicId: refColumn("topic_id").notNull(),
    authorUserId: refColumn("author_user_id").notNull().references(() => users.id),
    authorRole: mysqlEnum("author_role", USER_ROLES).notNull(),
    isOpening: boolean("is_opening").notNull().default(false),
    bodyText: text("body_text").notNull(),
    /** sha256 of the case-folded body; duplicate-post detection only. */
    bodyHash: char("body_hash", { length: 64 }).notNull(),
    linkCount: int("link_count", { unsigned: true }).notNull().default(0),
    quotePostId: refColumn("quote_post_id"),
    state: mysqlEnum("state", POST_STATES).notNull().default("published"),
    heldReason: varchar("held_reason", { length: 40 }),
    editedAt: utcDateTime("edited_at"),
    editCount: int("edit_count", { unsigned: true }).notNull().default(0),
    helpfulCount: int("helpful_count", { unsigned: true }).notNull().default(0),
    openReportCount: int("open_report_count", { unsigned: true }).notNull().default(0),
    idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    index("community_posts_topic_idx").on(t.topicId, t.id),
    index("community_posts_author_idx").on(t.authorUserId, t.createdAt),
    index("community_posts_state_idx").on(t.state, t.id),
    uniqueIndex("community_posts_idem_uq").on(t.authorUserId, t.idempotencyKey),
  ],
);

export const communityReactions = mysqlTable(
  "community_reactions",
  {
    id: idColumn(),
    postId: refColumn("post_id").notNull(),
    userId: refColumn("user_id").notNull().references(() => users.id),
    createdAt: createdAtColumn(),
  },
  (t) => [uniqueIndex("community_reactions_uq").on(t.postId, t.userId)],
);

export const communitySubscriptions = mysqlTable(
  "community_subscriptions",
  {
    id: idColumn(),
    topicId: refColumn("topic_id").notNull(),
    userId: refColumn("user_id").notNull().references(() => users.id),
    createdAt: createdAtColumn(),
  },
  (t) => [uniqueIndex("community_subscriptions_uq").on(t.topicId, t.userId), index("community_subscriptions_user_idx").on(t.userId)],
);

export const communityReports = mysqlTable(
  "community_reports",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    postId: refColumn("post_id").notNull(),
    reporterUserId: refColumn("reporter_user_id").notNull().references(() => users.id),
    reason: mysqlEnum("reason", REPORT_REASONS).notNull(),
    note: varchar("note", { length: 500 }),
    state: mysqlEnum("state", REPORT_STATES).notNull().default("open"),
    /** Equals reporter_user_id while open, NULL once resolved: one open report per reporter per post. */
    openReporterUserId: refColumn("open_reporter_user_id"),
    resolvedByUserId: refColumn("resolved_by_user_id"),
    resolvedAt: utcDateTime("resolved_at"),
    resolutionNote: varchar("resolution_note", { length: 500 }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("community_reports_open_uq").on(t.postId, t.openReporterUserId),
    index("community_reports_state_idx").on(t.state, t.id),
  ],
);

export const communityModerationLog = mysqlTable(
  "community_moderation_log",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    actorUserId: refColumn("actor_user_id"),
    action: mysqlEnum("action", MODERATION_ACTIONS).notNull(),
    targetType: mysqlEnum("target_type", ["post", "topic", "member", "report"]).notNull(),
    targetPublicId: char("target_public_id", { length: 26 }).notNull(),
    reason: varchar("reason", { length: 200 }),
    createdAt: createdAtColumn(),
  },
  (t) => [index("community_modlog_created_idx").on(t.createdAt, t.id), index("community_modlog_target_idx").on(t.targetType, t.targetPublicId)],
);

export type CommunityProfileRow = typeof communityProfiles.$inferSelect;
export type CommunityCategoryRow = typeof communityCategories.$inferSelect;
export type CommunityTopicRow = typeof communityTopics.$inferSelect;
export type CommunityPostRow = typeof communityPosts.$inferSelect;
export type CommunityReportRow = typeof communityReports.$inferSelect;
