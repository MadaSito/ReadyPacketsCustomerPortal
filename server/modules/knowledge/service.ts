/**
 * Knowledge Base module — service, Public API v1 provider, attachment tickets,
 * ranked search, version history, and retention job (Increment 04, Package F).
 */
import {
  and,
  asc,
   count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import type { Readable } from "node:stream";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import {
  conflict,
  DomainError,
  forbidden as coreForbidden,
  notFound as coreNotFound,
  validation,
} from "../../core/errors.js";
import { randomToken, ULID_PATTERN, ulid } from "../../core/ids.js";
import type {
  DbOrTx,
  ModuleHealth,
  ModuleLifecycle,
  SessionPrincipal,
  Tx,
} from "../../core/types.js";
import type { StagedUpload } from "../files/index.js";
import { fileRulesSetting, type FileRules } from "../files/settings.js";
import { isFlagEnabled, readSetting, writeSetting } from "../platform/settingsRegistry.js";
import { liveUserPredicate } from "../identity/live.js";
import { users } from "../identity/schema.js";
import type {
  ApiCaller,
  ApiListQuery,
  ApiPage,
  KnowledgeArticleDto,
  PublicApiProviders,
} from "../publicApi/ports.js";
import {
  assertKnowledgeActorInTx,
  assertKnowledgeCapabilityPreflight,
  assertKnowledgeFullSession,
} from "./authz.js";
import {
  projectKnowledgeHtmlToBlocks,
  sanitizeKnowledgeHtmlOnWrite,
} from "./sanitizer.js";
import {
  knowledgeArticleAttachments,
  knowledgeArticleFeedback,
  knowledgeArticleRelations,
  knowledgeArticles,
  knowledgeArticleTags,
  knowledgeArticleVersions,
  knowledgeArticleViewDedup,
  knowledgeAttachmentTickets,
  knowledgeCategories,
  knowledgeSearchLogs,
  type KnowledgeArticleState,
  type KnowledgeAudience,
} from "./schema.js";
import {
  buildArticleSnippetSegments,
  buildHighlightSegments,
  normalizeAnonymousSearchTerm,
  scoreArticleMatch,
  tokenizeSearchQuery,
} from "./search.js";
import { KNOWLEDGE_CONFIG, KNOWLEDGE_FLAG } from "./settings.js";
import { createKnowledgeTrashParticipant } from "./trash.js";
import type {
  KnowledgeAdminArticleDetailView,
  KnowledgeArticleDetailView,
  KnowledgeArticleSummaryView,
  KnowledgeArticleVersionView,
  KnowledgeAttachmentView,
  KnowledgeCategoryView,
  KnowledgeInsightsView,
  KnowledgeRelatedArticleView,
  KnowledgeRichBlock,
  KnowledgeSearchHitView,
  KnowledgeSearchResponse,
  KnowledgeSettingsView,
  KnowledgeStatusView,
  KnowledgeTocEntry,
} from "./types.js";

export const KNOWLEDGE_RETENTION_JOB = "knowledge.retention";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TICKET_TOKEN_RE = /^[a-zA-Z0-9_-]{43}$/;
// eslint-disable-next-line no-control-regex
const SINGLE_LINE_CONTROL_RE = /[\u0000-\u001F\u007F]/;
// eslint-disable-next-line no-control-regex
const MULTI_LINE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const TICKET_TTL_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_TAGS_PER_ARTICLE = 20;
const MAX_RELATED_ARTICLES = 10;

const notFound = (reason: string, _msg?: string) => coreNotFound(reason);
const forbidden = (reason: string, _msg?: string) => coreForbidden(reason);
const unavailable = (reason: string, safeMessage: string) =>
  new DomainError("UNAVAILABLE", reason, safeMessage);
const rateLimited = (retryAfterSeconds: number) =>
  new DomainError(
    "RATE_LIMITED",
    "RATE_LIMITED",
    "Too many requests. Please wait before trying again.",
    { retryAfterSeconds },
  );

type ArticleRow = typeof knowledgeArticles.$inferSelect;
type CategoryRow = typeof knowledgeCategories.$inferSelect;

function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { code?: string; errno?: number; cause?: { code?: string; errno?: number } };
  return (
    anyErr.code === "ER_DUP_ENTRY" ||
    anyErr.errno === 1062 ||
    anyErr.cause?.code === "ER_DUP_ENTRY" ||
    anyErr.cause?.errno === 1062
  );
}

function parseTagsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string" && TAG_RE.test(t));
  } catch {
    return [];
  }
}

function normalizeAndValidateSlug(rawSlug: string, fieldLabel = "Slug"): string {
  const slug = rawSlug.normalize("NFC").trim().toLowerCase();
  if (slug.length < 2 || slug.length > 120 || !SLUG_RE.test(slug)) {
    throw validation(
      "INVALID_SLUG",
      `${fieldLabel} must be 2–120 lowercase letters, numbers, and single hyphens.`,
    );
  }
  return slug;
}

function normalizeAndValidateTitle(rawTitle: string, maxLen: number, label = "Title"): string {
  const title = rawTitle.normalize("NFC").trim();
  if (title.length < 2 || title.length > maxLen || SINGLE_LINE_CONTROL_RE.test(title)) {
    throw validation("INVALID_TITLE", `${label} must be 2–${maxLen} characters without control characters.`);
  }
  return title;
}

function normalizeAndValidateSummary(rawSummary: string): string {
  const summary = rawSummary.normalize("NFC").replace(/\s+/g, " ").trim();
  if (summary.length < 5 || summary.length > 500 || SINGLE_LINE_CONTROL_RE.test(summary)) {
    throw validation("INVALID_SUMMARY", "Summary must be 5–500 characters.");
  }
  return summary;
}

function normalizeAndValidateTags(rawTags: readonly string[] | undefined): string[] {
  if (!rawTags || rawTags.length === 0) return [];
  if (rawTags.length > MAX_TAGS_PER_ARTICLE) {
    throw validation("TOO_MANY_TAGS", `Choose at most ${MAX_TAGS_PER_ARTICLE} tags.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawTags) {
    const tag = raw.normalize("NFC").trim().toLowerCase();
    if (!tag) continue;
    if (!TAG_RE.test(tag)) {
      throw validation(
        "INVALID_TAG",
        `Tag '${tag.slice(0, 40)}' may contain lowercase letters, numbers, hyphens, and underscores (1–40 chars).`,
      );
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

function normalizeReviewedOn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!ISO_DATE_RE.test(trimmed)) {
    throw validation("INVALID_REVIEWED_DATE", "Reviewed-on date must use YYYY-MM-DD format.");
  }
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw validation("INVALID_REVIEWED_DATE", "Reviewed-on date is not a valid calendar date.");
  }
  return trimmed;
}

function encodeIdCursor(id: number): string {
  return Buffer.from(`kb:${id}`, "utf8").toString("base64url");
}

function decodeIdCursor(cursor: string | null | undefined): number | undefined {
  if (!cursor) return undefined;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    if (!raw.startsWith("kb:")) return undefined;
    const id = Number.parseInt(raw.slice(3), 10);
    if (!Number.isSafeInteger(id) || id <= 0) return undefined;
    return id;
  } catch {
    return undefined;
  }
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`kbo:${offset}`, "utf8").toString("base64url");
}

function decodeOffsetCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    if (!raw.startsWith("kbo:")) return 0;
    const n = Number.parseInt(raw.slice(4), 10);
    if (!Number.isSafeInteger(n) || n < 0 || n > 10_000) return 0;
    return n;
  } catch {
    return 0;
  }
}

export interface KnowledgeAttachmentUploadAuth {
  articleId: number;
  articlePublicId: string;
  rules: FileRules;
}

export interface KnowledgeAttachmentDownload {
  attachment: KnowledgeAttachmentView & { articlePublicId: string };
  stream: Readable;
}

export interface KnowledgeModule extends ModuleLifecycle {
  /** Fast feature-flag check used by peer modules and shells. */
  enabled(tx?: Tx): Promise<boolean>;

  status(principal: SessionPrincipal): Promise<KnowledgeStatusView>;

  /* ---- Customer / Help Centre ---- */
  helpHome(principal: SessionPrincipal): Promise<{
    categories: KnowledgeCategoryView[];
    featuredArticles: KnowledgeArticleSummaryView[];
  }>;
  helpCategory(
    principal: SessionPrincipal,
    input: { slug: string },
  ): Promise<{
    category: KnowledgeCategoryView;
    parentCategory: { publicId: string; slug: string; title: string } | null;
    articles: KnowledgeArticleSummaryView[];
  }>;
  helpArticle(
    principal: SessionPrincipal,
    input: { slug: string; recordView?: boolean },
  ): Promise<KnowledgeArticleDetailView>;
  helpSearch(
    principal: SessionPrincipal,
    input: {
      q?: string;
      categorySlug?: string;
      tag?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<KnowledgeSearchResponse>;
  helpRelatedForTicket(
    principal: SessionPrincipal,
    input: { query: string; category?: string },
  ): Promise<{ items: KnowledgeRelatedArticleView[] }>;
  submitFeedback(
    principal: SessionPrincipal,
    input: { articlePublicId: string; helpful: boolean; comment?: string | null },
  ): Promise<{ recorded: true; helpfulYesCount: number; helpfulNoCount: number }>;

  /* ---- Attachments (shared HTTP + tRPC) ---- */
  beginAttachmentUpload(
    principal: SessionPrincipal,
    articlePublicId: string,
  ): Promise<KnowledgeAttachmentUploadAuth>;
  commitAttachmentUpload(
    principal: SessionPrincipal,
    auth: KnowledgeAttachmentUploadAuth,
    staged: StagedUpload,
  ): Promise<KnowledgeAttachmentView>;
  removeAttachment(
    principal: SessionPrincipal,
    input: { attachmentPublicId: string },
  ): Promise<{ deleted: true }>;
  issueAttachmentDownloadTicket(
    principal: SessionPrincipal,
    input: { attachmentPublicId: string },
  ): Promise<{ ticket: string; expiresAt: Date }>;
  redeemAttachmentDownloadTicket(
    principal: SessionPrincipal,
    ticket: string,
  ): Promise<KnowledgeAttachmentDownload>;

  /* ---- Console / Admin (`knowledge.manage` / `platform.settings.manage`) ---- */
  getSettings(principal: SessionPrincipal): Promise<KnowledgeSettingsView>;
  updateSettings(
    principal: SessionPrincipal,
    input: {
      enabled?: boolean;
      searchLogRetentionDays?: number;
      allowFeedbackComments?: boolean;
    },
  ): Promise<KnowledgeSettingsView>;

  listAdminCategories(
    principal: SessionPrincipal,
    input?: { includeArchived?: boolean },
  ): Promise<{ items: KnowledgeCategoryView[] }>;
  createCategory(
    principal: SessionPrincipal,
    input: {
      parentPublicId?: string | null;
      slug: string;
      title: string;
      description?: string | null;
    },
  ): Promise<KnowledgeCategoryView>;
  updateCategory(
    principal: SessionPrincipal,
    input: {
      publicId: string;
      expectedVersion: number;
      parentPublicId?: string | null;
      slug?: string;
      title?: string;
      description?: string | null;
    },
  ): Promise<KnowledgeCategoryView>;
  archiveCategory(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number; archived: boolean },
  ): Promise<KnowledgeCategoryView>;
  reorderCategories(
    principal: SessionPrincipal,
    input: { parentPublicId: string | null; orderedPublicIds: readonly string[] },
  ): Promise<{ updated: number }>;

  listAdminArticles(
    principal: SessionPrincipal,
    input: {
      state?: KnowledgeArticleState;
      audience?: KnowledgeAudience;
      categoryPublicId?: string;
      tag?: string;
      query?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ items: KnowledgeArticleSummaryView[]; nextCursor: string | null }>;
  getAdminArticle(
    principal: SessionPrincipal,
    input: { publicId: string },
  ): Promise<KnowledgeAdminArticleDetailView>;
  previewArticle(
    principal: SessionPrincipal,
    input: { title: string; summary: string; bodyHtml: string },
  ): Promise<{
    sanitizedHtml: string;
    bodyBlocks: KnowledgeRichBlock[];
    toc: KnowledgeTocEntry[];
  }>;
  createArticle(
    principal: SessionPrincipal,
    input: {
      categoryPublicId?: string | null;
      slug: string;
      title: string;
      summary: string;
      bodyHtml: string;
      tags?: readonly string[];
      audience?: KnowledgeAudience;
      state?: "draft" | "published";
      reviewedOn?: string | null;
      relatedArticlePublicIds?: readonly string[];
      changeNote?: string | null;
    },
  ): Promise<KnowledgeAdminArticleDetailView>;
  updateArticle(
    principal: SessionPrincipal,
    input: {
      publicId: string;
      expectedVersion: number;
      categoryPublicId?: string | null;
      slug?: string;
      title?: string;
      summary?: string;
      bodyHtml?: string;
      tags?: readonly string[];
      audience?: KnowledgeAudience;
      reviewedOn?: string | null;
      relatedArticlePublicIds?: readonly string[];
      changeNote?: string | null;
    },
  ): Promise<KnowledgeAdminArticleDetailView>;
  setArticleState(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number; state: KnowledgeArticleState },
  ): Promise<KnowledgeAdminArticleDetailView>;
  reorderArticles(
    principal: SessionPrincipal,
    input: { categoryPublicId: string | null; orderedPublicIds: readonly string[] },
  ): Promise<{ updated: number }>;
  listArticleVersions(
    principal: SessionPrincipal,
    input: { publicId: string },
  ): Promise<{ items: KnowledgeArticleVersionView[] }>;
  restoreArticleVersion(
    principal: SessionPrincipal,
    input: {
      publicId: string;
      expectedVersion: number;
      versionNumber: number;
      changeNote?: string | null;
    },
  ): Promise<KnowledgeAdminArticleDetailView>;
  getInsights(principal: SessionPrincipal): Promise<KnowledgeInsightsView>;

  /** Public API v1 (`publicApi` Package H) provider implementation. */
  readonly publicApiProvider: PublicApiProviders["knowledge"];
}

export function createKnowledgeService(deps: ModuleDeps): KnowledgeModule {
  const { db, clock, crypto, audit, jobs, settings, storage, rateLimiter, logger } = deps;

  async function enabled(tx?: Tx): Promise<boolean> {
    return isFlagEnabled(settings, KNOWLEDGE_FLAG, tx);
  }

  async function assertHelpEnabled(tx?: Tx): Promise<void> {
    if (!(await enabled(tx))) {
      throw notFound("KNOWLEDGE_DISABLED", "The help centre is currently unavailable.");
    }
  }

  function allowedAudiencesForViewer(principal: SessionPrincipal): readonly KnowledgeAudience[] {
    if (principal.role === "admin" || principal.role === "staff") {
      return ["customers", "staff"];
    }
    return ["customers"];
  }

  async function loadCategoriesMap(handle: DbOrTx): Promise<Map<number, CategoryRow>> {
    const rows = await handle.select().from(knowledgeCategories);
    return new Map(rows.map((r) => [r.id, r]));
  }

  function toSummaryView(
    row: ArticleRow,
    catMap: ReadonlyMap<number, CategoryRow>,
  ): KnowledgeArticleSummaryView {
    const cat = row.categoryId ? catMap.get(row.categoryId) : undefined;
    return {
      publicId: row.publicId,
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      tags: parseTagsJson(row.tagsJson),
      audience: row.audience,
      state: row.state,
      categoryPublicId: cat?.publicId ?? null,
      categorySlug: cat?.slug ?? null,
      categoryTitle: cat?.title ?? null,
      reviewedOn: row.reviewedOn ?? null,
      publishedAt: row.publishedAt ?? null,
      viewCount: Number(row.viewCount ?? 0),
      helpfulYesCount: row.helpfulYesCount,
      helpfulNoCount: row.helpfulNoCount,
      currentVersionNumber: row.currentVersionNumber,
      version: row.version,
      sortOrder: row.sortOrder,
      updatedAt: row.updatedAt,
    };
  }

  async function buildCategoryTree(
    handle: DbOrTx,
    options: {
      includeArchived: boolean;
      audiences: readonly KnowledgeAudience[];
      includeTotalCounts?: boolean;
    },
  ): Promise<KnowledgeCategoryView[]> {
    const cats = await handle
      .select()
      .from(knowledgeCategories)
      .where(options.includeArchived ? undefined : isNull(knowledgeCategories.archivedAt))
      .orderBy(asc(knowledgeCategories.sortOrder), asc(knowledgeCategories.id));

    const pubCountsRows = await handle
      .select({
        categoryId: knowledgeArticles.categoryId,
        c: count(),
      })
      .from(knowledgeArticles)
      .where(
        and(
          eq(knowledgeArticles.state, "published"),
          inArray(knowledgeArticles.audience, [...options.audiences]),
        ),
      )
      .groupBy(knowledgeArticles.categoryId);

    const pubCountMap = new Map<number, number>();
    for (const r of pubCountsRows) {
      if (r.categoryId !== null) pubCountMap.set(r.categoryId, Number(r.c));
    }

    const totalCountMap = new Map<number, number>();
    if (options.includeTotalCounts) {
      const totalRows = await handle
        .select({
          categoryId: knowledgeArticles.categoryId,
          c: count(),
        })
        .from(knowledgeArticles)
        .groupBy(knowledgeArticles.categoryId);
      for (const r of totalRows) {
        if (r.categoryId !== null) totalCountMap.set(r.categoryId, Number(r.c));
      }
    }

    const catById = new Map(cats.map((c) => [c.id, c]));
    const viewById = new Map<number, KnowledgeCategoryView>();

    for (const c of cats) {
      const parent = c.parentCategoryId ? catById.get(c.parentCategoryId) : undefined;
      viewById.set(c.id, {
        publicId: c.publicId,
        parentPublicId: parent?.publicId ?? null,
        slug: c.slug,
        title: c.title,
        description: c.description ?? null,
        sortOrder: c.sortOrder,
        archivedAt: c.archivedAt ?? null,
        version: c.version,
        publishedArticleCount: pubCountMap.get(c.id) ?? 0,
        ...(options.includeTotalCounts ? { totalArticleCount: totalCountMap.get(c.id) ?? 0 } : {}),
        children: [],
      });
    }

    const roots: KnowledgeCategoryView[] = [];
    for (const c of cats) {
      const view = viewById.get(c.id)!;
      if (c.parentCategoryId && viewById.has(c.parentCategoryId)) {
        viewById.get(c.parentCategoryId)!.children.push(view);
      } else {
        roots.push(view);
      }
    }
    return roots;
  }

  async function loadArticleAttachments(
    handle: DbOrTx,
    articleId: number,
  ): Promise<KnowledgeAttachmentView[]> {
    const rows = await handle
      .select()
      .from(knowledgeArticleAttachments)
      .where(
        and(
          eq(knowledgeArticleAttachments.articleId, articleId),
          isNull(knowledgeArticleAttachments.deletedAt),
        ),
      )
      .orderBy(asc(knowledgeArticleAttachments.id));

    return rows.map((r) => {
      let displayName = `attachment.${r.extension}`;
      try {
        displayName = crypto.decrypt(
          r.displayNameEnc,
          `knowledge_article_attachments.display_name:${r.publicId}`,
        );
      } catch {
        // Fallback if corrupt
      }
      return {
        publicId: r.publicId,
        displayName,
        size: Number(r.byteSize),
        contentType: r.contentType,
        extension: r.extension,
        createdAt: r.createdAt,
      };
    });
  }

  async function loadRelatedArticles(
    handle: DbOrTx,
    articleId: number,
    catMap: ReadonlyMap<number, CategoryRow>,
    options: { publishedOnly: boolean; audiences: readonly KnowledgeAudience[] },
  ): Promise<KnowledgeRelatedArticleView[]> {
    const rels = await handle
      .select({
        relatedArticleId: knowledgeArticleRelations.relatedArticleId,
        sortOrder: knowledgeArticleRelations.sortOrder,
      })
      .from(knowledgeArticleRelations)
      .where(eq(knowledgeArticleRelations.articleId, articleId))
      .orderBy(asc(knowledgeArticleRelations.sortOrder), asc(knowledgeArticleRelations.id));

    if (rels.length === 0) return [];
    const targetIds = rels.map((r) => r.relatedArticleId);
    const targetRows = await handle
      .select()
      .from(knowledgeArticles)
      .where(
        and(
          inArray(knowledgeArticles.id, targetIds),
          options.publishedOnly ? eq(knowledgeArticles.state, "published") : ne(knowledgeArticles.state, "archived"),
          inArray(knowledgeArticles.audience, [...options.audiences]),
        ),
      );

    const byId = new Map(targetRows.map((r) => [r.id, r]));
    const out: KnowledgeRelatedArticleView[] = [];
    for (const rel of rels) {
      const target = byId.get(rel.relatedArticleId);
      if (!target) continue;
      const cat = target.categoryId ? catMap.get(target.categoryId) : undefined;
      out.push({
        publicId: target.publicId,
        slug: target.slug,
        title: target.title,
        summary: target.summary,
        categoryTitle: cat?.title ?? null,
      });
    }
    return out;
  }

  async function hydrateArticleDetail(
    handle: DbOrTx,
    row: ArticleRow,
    principal: SessionPrincipal,
    options: { publishedRelatedOnly: boolean },
  ): Promise<KnowledgeArticleDetailView> {
    const catMap = await loadCategoriesMap(handle);
    const summary = toSummaryView(row, catMap);
    const { blocks, toc } = projectKnowledgeHtmlToBlocks(row.bodyHtml);
    const attachments = await loadArticleAttachments(handle, row.id);
    const relatedArticles = await loadRelatedArticles(handle, row.id, catMap, {
      publishedOnly: options.publishedRelatedOnly,
      audiences: options.publishedRelatedOnly
        ? allowedAudiencesForViewer(principal)
        : ["customers", "staff"],
    });
    const [fbRow] = await handle
      .select({
        helpful: knowledgeArticleFeedback.helpful,
        commentEnc: knowledgeArticleFeedback.commentEnc,
      })
      .from(knowledgeArticleFeedback)
      .where(
        and(
          eq(knowledgeArticleFeedback.articleId, row.id),
          eq(knowledgeArticleFeedback.userId, principal.userId),
        ),
      )
      .limit(1);

    const cfg = await readSetting(settings, KNOWLEDGE_CONFIG);

    return {
      ...summary,
      bodyBlocks: blocks,
      toc,
      attachments,
      relatedArticles,
      myFeedback: fbRow ? { helpful: fbRow.helpful, hasComment: Boolean(fbRow.commentEnc) } : null,
      allowFeedbackComments: cfg.allowFeedbackComments,
    };
  }

  async function syncArticleTagsAndRelations(
    tx: Tx,
    articleId: number,
    tags: readonly string[],
    relatedArticlePublicIds: readonly string[] | undefined,
    now: Date,
  ): Promise<void> {
    await tx.delete(knowledgeArticleTags).where(eq(knowledgeArticleTags.articleId, articleId));
    if (tags.length > 0) {
      await tx.insert(knowledgeArticleTags).values(
        tags.map((tag) => ({
          articleId,
          tag,
          createdAt: now,
        })),
      );
    }

    if (relatedArticlePublicIds !== undefined) {
      if (relatedArticlePublicIds.length > MAX_RELATED_ARTICLES) {
        throw validation(
          "TOO_MANY_RELATED_ARTICLES",
          `Select at most ${MAX_RELATED_ARTICLES} related articles.`,
        );
      }
      const uniquePubIds = [...new Set(relatedArticlePublicIds)];
      for (const pid of uniquePubIds) {
        if (!ULID_PATTERN.test(pid)) {
          throw validation("INVALID_RELATED_ARTICLE", "Invalid related article identifier.");
        }
      }

      await tx
        .delete(knowledgeArticleRelations)
        .where(eq(knowledgeArticleRelations.articleId, articleId));

      if (uniquePubIds.length > 0) {
        const relRows = await tx
          .select({ id: knowledgeArticles.id, publicId: knowledgeArticles.publicId })
          .from(knowledgeArticles)
          .where(inArray(knowledgeArticles.publicId, uniquePubIds));

        const idByPub = new Map(relRows.map((r) => [r.publicId, r.id]));
        const toInsert: Array<{ articleId: number; relatedArticleId: number; sortOrder: number; createdAt: Date }> = [];
        for (let i = 0; i < uniquePubIds.length; i += 1) {
          const targetId = idByPub.get(uniquePubIds[i]!);
          if (!targetId) {
            throw validation("RELATED_ARTICLE_NOT_FOUND", "One or more related articles do not exist.");
          }
          if (targetId === articleId) {
            throw validation("SELF_RELATION_FORBIDDEN", "An article cannot link to itself as related.");
          }
          toInsert.push({
            articleId,
            relatedArticleId: targetId,
            sortOrder: i,
            createdAt: now,
          });
        }
        if (toInsert.length > 0) {
          await tx.insert(knowledgeArticleRelations).values(toInsert);
        }
      }
    }
  }

  /* --------------------------------------------------- Status & Help Centre */

  async function status(principal: SessionPrincipal): Promise<KnowledgeStatusView> {
    await assertKnowledgeFullSession(deps, principal);
    const isEnabled = await enabled();
    return {
      enabled: isEnabled,
      canManage: roleHasCapability(principal.role, "knowledge.manage"),
      canConfigure: roleHasCapability(principal.role, "platform.settings.manage"),
    };
  }

  async function helpHome(principal: SessionPrincipal): Promise<{
    categories: KnowledgeCategoryView[];
    featuredArticles: KnowledgeArticleSummaryView[];
  }> {
    await assertKnowledgeFullSession(deps, principal);
    await assertHelpEnabled();

    const audiences = allowedAudiencesForViewer(principal);
    const categories = await buildCategoryTree(db, {
      includeArchived: false,
      audiences,
    });
    const catMap = await loadCategoriesMap(db);

    const featuredRows = await db
      .select()
      .from(knowledgeArticles)
      .where(
        and(
          eq(knowledgeArticles.state, "published"),
          inArray(knowledgeArticles.audience, [...audiences]),
        ),
      )
      .orderBy(
        desc(knowledgeArticles.helpfulYesCount),
        desc(knowledgeArticles.viewCount),
        asc(knowledgeArticles.sortOrder),
        desc(knowledgeArticles.id),
      )
      .limit(8);

    // Filter out articles belonging to archived categories
    const visibleFeatured = featuredRows.filter((r) => {
      if (!r.categoryId) return true;
      const cat = catMap.get(r.categoryId);
      if (!cat || cat.archivedAt) return false;
      if (cat.parentCategoryId) {
        const parent = catMap.get(cat.parentCategoryId);
        if (!parent || parent.archivedAt) return false;
      }
      return true;
    });

    return {
      categories,
      featuredArticles: visibleFeatured.map((r) => toSummaryView(r, catMap)),
    };
  }

  async function helpCategory(
    principal: SessionPrincipal,
    input: { slug: string },
  ): Promise<{
    category: KnowledgeCategoryView;
    parentCategory: { publicId: string; slug: string; title: string } | null;
    articles: KnowledgeArticleSummaryView[];
  }> {
    await assertKnowledgeFullSession(deps, principal);
    await assertHelpEnabled();

    const slug = normalizeAndValidateSlug(input.slug, "Category slug");
    const audiences = allowedAudiencesForViewer(principal);
    const tree = await buildCategoryTree(db, { includeArchived: false, audiences });

    let found: KnowledgeCategoryView | null = null;
    let parentSummary: { publicId: string; slug: string; title: string } | null = null;
    for (const root of tree) {
      if (root.slug === slug) {
        found = root;
        break;
      }
      for (const child of root.children) {
        if (child.slug === slug) {
          found = child;
          parentSummary = { publicId: root.publicId, slug: root.slug, title: root.title };
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      throw notFound("CATEGORY_NOT_FOUND", "Category not found.");
    }

    const catMap = await loadCategoriesMap(db);
    const [catRow] = await db
      .select({ id: knowledgeCategories.id })
      .from(knowledgeCategories)
      .where(eq(knowledgeCategories.publicId, found.publicId))
      .limit(1);

    const rows = catRow
      ? await db
          .select()
          .from(knowledgeArticles)
          .where(
            and(
              eq(knowledgeArticles.categoryId, catRow.id),
              eq(knowledgeArticles.state, "published"),
              inArray(knowledgeArticles.audience, [...audiences]),
            ),
          )
          .orderBy(asc(knowledgeArticles.sortOrder), desc(knowledgeArticles.updatedAt))
          .limit(100)
      : [];

    return {
      category: found,
      parentCategory: parentSummary,
      articles: rows.map((r) => toSummaryView(r, catMap)),
    };
  }

  async function helpArticle(
    principal: SessionPrincipal,
    input: { slug: string; recordView?: boolean },
  ): Promise<KnowledgeArticleDetailView> {
    await assertKnowledgeFullSession(deps, principal);
    await assertHelpEnabled();

    const slug = normalizeAndValidateSlug(input.slug, "Article slug");
    const audiences = allowedAudiencesForViewer(principal);

    const [row] = await db
      .select()
      .from(knowledgeArticles)
      .where(
        and(
          eq(knowledgeArticles.slug, slug),
          eq(knowledgeArticles.state, "published"),
          inArray(knowledgeArticles.audience, [...audiences]),
        ),
      )
      .limit(1);

    if (!row) {
      throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
    }

    // Refuse if category (or its parent) is archived
    if (row.categoryId) {
      const catMap = await loadCategoriesMap(db);
      const cat = catMap.get(row.categoryId);
      if (!cat || cat.archivedAt) {
        throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
      }
      if (cat.parentCategoryId) {
        const parent = catMap.get(cat.parentCategoryId);
        if (!parent || parent.archivedAt) {
          throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
        }
      }
    }

    let currentRow = row;
    if (input.recordView !== false) {
      const now = clock.now();
      const hourBucket = Math.floor(now.getTime() / HOUR_MS);
      const slotHash = crypto.blindIndex(
        `${row.id}:${hourBucket}:${principal.sessionId}`,
        "knowledge.view_dedup",
      );
      try {
        await db.insert(knowledgeArticleViewDedup).values({
          articleId: row.id,
          viewerSlotHash: slotHash,
          expiresAt: new Date(now.getTime() + 2 * HOUR_MS),
        });
        await db
          .update(knowledgeArticles)
          .set({ viewCount: sql`${knowledgeArticles.viewCount} + 1` })
          .where(eq(knowledgeArticles.id, row.id));
        currentRow = { ...row, viewCount: Number(row.viewCount) + 1 };
      } catch (err) {
        if (!isDuplicateKeyError(err)) {
          logger.warn("knowledge view count dedup failed", { articlePublicId: row.publicId });
        }
      }
    }

    return hydrateArticleDetail(db, currentRow, principal, { publishedRelatedOnly: true });
  }

  async function recordAnonymousSearchTerm(
    rawQuery: string,
    audienceScope: KnowledgeAudience,
    resultCount: number,
    sessionKey: string,
  ): Promise<void> {
    const normalized = normalizeAnonymousSearchTerm(rawQuery);
    if (!normalized) return;

    // Rate-limit analytics writes per session so automated probes cannot flood or skew top-search metrics
    const rl = await rateLimiter.consume("standard_browsing", `kb_search_log:${sessionKey}`);
    if (!rl.allowed) return;

    const now = clock.now();
    const zeroInc = resultCount === 0 ? 1 : 0;
    try {
      await db.execute(sql`
        INSERT INTO knowledge_search_logs (
          audience_scope,
          normalized_term,
          search_count,
          zero_result_count,
          last_result_count,
          first_searched_at,
          last_searched_at
        ) VALUES (
          ${audienceScope},
          ${normalized},
          1,
          ${zeroInc},
          ${resultCount},
          ${now},
          ${now}
        )
        ON DUPLICATE KEY UPDATE
          search_count = search_count + 1,
          zero_result_count = zero_result_count + ${zeroInc},
          last_result_count = ${resultCount},
          last_searched_at = ${now}
      `);
    } catch {
      // Best-effort analytics write — never fail user search
    }
  }

  async function helpSearch(
    principal: SessionPrincipal,
    input: {
      q?: string;
      categorySlug?: string;
      tag?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<KnowledgeSearchResponse> {
    await assertKnowledgeFullSession(deps, principal);
    await assertHelpEnabled();

    const rawQ = (input.q ?? "").normalize("NFC").trim().slice(0, 120);
    const tokens = tokenizeSearchQuery(rawQ);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const offset = decodeOffsetCursor(input.cursor);
    const audiences = allowedAudiencesForViewer(principal);
    const catMap = await loadCategoriesMap(db);

    let allowedCategoryIds: Set<number> | null = null;
    if (input.categorySlug) {
      const slug = normalizeAndValidateSlug(input.categorySlug, "Category slug");
      let matchedCat: CategoryRow | undefined;
      for (const c of catMap.values()) {
        if (!c.archivedAt && c.slug === slug) {
          matchedCat = c;
          break;
        }
      }
      if (!matchedCat) {
        return {
          query: rawQ,
          items: [],
          nextCursor: null,
          suggestions: await buildZeroResultSuggestions(audiences, catMap, tokens),
        };
      }
      allowedCategoryIds = new Set<number>([matchedCat.id]);
      for (const c of catMap.values()) {
        if (!c.archivedAt && c.parentCategoryId === matchedCat.id) {
          allowedCategoryIds.add(c.id);
        }
      }
    }

    const normalizedTag = input.tag ? input.tag.normalize("NFC").trim().toLowerCase() : "";
    let tagArticleIds: Set<number> | null = null;
    if (normalizedTag) {
      if (!TAG_RE.test(normalizedTag)) {
        throw validation("INVALID_TAG", "Invalid tag filter.");
      }
      const tagRows = await db
        .select({ articleId: knowledgeArticleTags.articleId })
        .from(knowledgeArticleTags)
        .where(eq(knowledgeArticleTags.tag, normalizedTag));
      tagArticleIds = new Set(tagRows.map((r) => r.articleId));
    }

    const candidates = await db
      .select()
      .from(knowledgeArticles)
      .where(
        and(
          eq(knowledgeArticles.state, "published"),
          inArray(knowledgeArticles.audience, [...audiences]),
        ),
      )
      .orderBy(asc(knowledgeArticles.sortOrder), desc(knowledgeArticles.updatedAt))
      .limit(500);

    const scored: Array<{ row: ArticleRow; score: number; tags: string[] }> = [];
    for (const row of candidates) {
      if (row.categoryId) {
        const cat = catMap.get(row.categoryId);
        if (!cat || cat.archivedAt) continue;
        if (cat.parentCategoryId) {
          const parent = catMap.get(cat.parentCategoryId);
          if (!parent || parent.archivedAt) continue;
        }
      }
      if (allowedCategoryIds && (!row.categoryId || !allowedCategoryIds.has(row.categoryId))) {
        continue;
      }
      if (tagArticleIds && !tagArticleIds.has(row.id)) {
        continue;
      }
      const tags = parseTagsJson(row.tagsJson);
      const score = scoreArticleMatch(
        {
          title: row.title,
          summary: row.summary,
          bodyText: row.bodyText,
          tags,
          helpfulYesCount: row.helpfulYesCount,
          viewCount: Number(row.viewCount),
        },
        rawQ,
        tokens,
      );
      if (score > 0) {
        scored.push({ row, score, tags });
      }
    }

    if (tokens.length > 0) {
      scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.row.id - a.row.id));
    }

    // Log anonymous scrubbed search term only on the first page of an explicit text query
    if (rawQ.length >= 2 && offset === 0) {
      const scope: KnowledgeAudience = principal.role === "customer" ? "customers" : "staff";
      await recordAnonymousSearchTerm(rawQ, scope, scored.length, principal.sessionId);
    }

    const pageSlice = scored.slice(offset, offset + limit);
    const nextCursor = scored.length > offset + limit ? encodeOffsetCursor(offset + limit) : null;

    const hits: KnowledgeSearchHitView[] = pageSlice.map(({ row, tags }) => {
      const cat = row.categoryId ? catMap.get(row.categoryId) : undefined;
      return {
        publicId: row.publicId,
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        tags,
        audience: row.audience,
        categorySlug: cat?.slug ?? null,
        categoryTitle: cat?.title ?? null,
        reviewedOn: row.reviewedOn ?? null,
        updatedAt: row.updatedAt,
        titleSegments: buildHighlightSegments(row.title, tokens),
        snippetSegments: buildArticleSnippetSegments(row.summary, row.bodyText, tokens),
      };
    });

    const suggestions =
      scored.length === 0 ? await buildZeroResultSuggestions(audiences, catMap, tokens) : null;

    return {
      query: rawQ,
      items: hits,
      nextCursor,
      suggestions,
    };
  }

  async function buildZeroResultSuggestions(
    audiences: readonly KnowledgeAudience[],
    catMap: ReadonlyMap<number, CategoryRow>,
    tokens: readonly string[],
  ): Promise<NonNullable<KnowledgeSearchResponse["suggestions"]>> {
    const popularRows = await db
      .select()
      .from(knowledgeArticles)
      .where(
        and(
          eq(knowledgeArticles.state, "published"),
          inArray(knowledgeArticles.audience, [...audiences]),
        ),
      )
      .orderBy(desc(knowledgeArticles.helpfulYesCount), desc(knowledgeArticles.viewCount))
      .limit(5);

    const popularArticles: KnowledgeRelatedArticleView[] = popularRows
      .filter((r) => !r.categoryId || !catMap.get(r.categoryId)?.archivedAt)
      .map((r) => ({
        publicId: r.publicId,
        slug: r.slug,
        title: r.title,
        summary: r.summary,
        categoryTitle: r.categoryId ? (catMap.get(r.categoryId)?.title ?? null) : null,
      }));

    const tree = await buildCategoryTree(db, { includeArchived: false, audiences });
    const categories = tree
      .filter((c) => c.publishedArticleCount > 0 || c.children.some((ch) => ch.publishedArticleCount > 0))
      .slice(0, 6)
      .map((c) => ({
        publicId: c.publicId,
        slug: c.slug,
        title: c.title,
        publishedArticleCount:
          c.publishedArticleCount +
          c.children.reduce((sum, ch) => sum + ch.publishedArticleCount, 0),
      }));

    const tagRows = await db
      .select({ tag: knowledgeArticleTags.tag, c: count() })
      .from(knowledgeArticleTags)
      .innerJoin(knowledgeArticles, eq(knowledgeArticleTags.articleId, knowledgeArticles.id))
      .where(
        and(
          eq(knowledgeArticles.state, "published"),
          inArray(knowledgeArticles.audience, [...audiences]),
        ),
      )
      .groupBy(knowledgeArticleTags.tag)
      .orderBy(desc(count()))
      .limit(12);

    const suggestedTags = tagRows
      .map((r) => r.tag)
      .sort((a, b) => {
        const aMatch = tokens.some((t) => a.startsWith(t.slice(0, 3))) ? 1 : 0;
        const bMatch = tokens.some((t) => b.startsWith(t.slice(0, 3))) ? 1 : 0;
        return bMatch - aMatch;
      })
      .slice(0, 8);

    return {
      popularArticles,
      categories,
      suggestedTags,
    };
  }

  async function helpRelatedForTicket(
    principal: SessionPrincipal,
    input: { query: string; category?: string },
  ): Promise<{ items: KnowledgeRelatedArticleView[] }> {
    await assertKnowledgeFullSession(deps, principal);
    if (!(await enabled())) {
      return { items: [] };
    }

    const combined = `${input.query ?? ""} ${input.category ?? ""}`.trim().slice(0, 160);
    const tokens = tokenizeSearchQuery(combined);
    if (tokens.length === 0) {
      return { items: [] };
    }

    const catMap = await loadCategoriesMap(db);
    const rows = await db
      .select()
      .from(knowledgeArticles)
      .where(
        and(
          eq(knowledgeArticles.state, "published"),
          eq(knowledgeArticles.audience, "customers"),
        ),
      )
      .limit(200);

    const scored: Array<{ row: ArticleRow; score: number }> = [];
    for (const row of rows) {
      if (row.categoryId) {
        const cat = catMap.get(row.categoryId);
        if (!cat || cat.archivedAt) continue;
        if (cat.parentCategoryId && catMap.get(cat.parentCategoryId)?.archivedAt) continue;
      }
      const tags = parseTagsJson(row.tagsJson);
      const score = scoreArticleMatch(
        {
          title: row.title,
          summary: row.summary,
          bodyText: row.bodyText,
          tags,
          helpfulYesCount: row.helpfulYesCount,
          viewCount: Number(row.viewCount),
        },
        input.query,
        tokens,
        { matchAnyToken: true },
      );
      if (score > 0) scored.push({ row, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return {
      items: scored.slice(0, 5).map(({ row }) => ({
        publicId: row.publicId,
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        categoryTitle: row.categoryId ? (catMap.get(row.categoryId)?.title ?? null) : null,
      })),
    };
  }

  async function submitFeedback(
    principal: SessionPrincipal,
    input: { articlePublicId: string; helpful: boolean; comment?: string | null },
  ): Promise<{ recorded: true; helpfulYesCount: number; helpfulNoCount: number }> {
    await assertKnowledgeFullSession(deps, principal);
    await assertHelpEnabled();

    if (!ULID_PATTERN.test(input.articlePublicId)) {
      throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
    }

    const rl = await rateLimiter.consume("form_submission", `kb_feedback:${principal.userId}`);
    if (!rl.allowed) {
      throw rateLimited(rl.retryAfterSeconds);
    }

    const cfg = await readSetting(settings, KNOWLEDGE_CONFIG);
    const cleanedComment = input.comment
      ? input.comment.normalize("NFC").replace(/\r\n?/g, "\n").replace(MULTI_LINE_CONTROL_RE, "").trim()
      : "";
    if (cleanedComment.length > 1_000) {
      throw validation("FEEDBACK_COMMENT_TOO_LONG", "Feedback comment must be 1,000 characters or fewer.");
    }
    if (cleanedComment.length > 0 && !cfg.allowFeedbackComments) {
      throw validation("FEEDBACK_COMMENTS_DISABLED", "Feedback comments are currently turned off.");
    }

    const audiences = allowedAudiencesForViewer(principal);
    const now = clock.now();

    return db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx);
      await assertHelpEnabled(tx);

      const [article] = await tx
        .select()
        .from(knowledgeArticles)
        .where(
          and(
            eq(knowledgeArticles.publicId, input.articlePublicId),
            eq(knowledgeArticles.state, "published"),
            inArray(knowledgeArticles.audience, [...audiences]),
          ),
        )
        .limit(1);

      if (!article) {
        throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
      }

      const [existing] = await tx
        .select()
        .from(knowledgeArticleFeedback)
        .where(
          and(
            eq(knowledgeArticleFeedback.articleId, article.id),
            eq(knowledgeArticleFeedback.userId, principal.userId),
          ),
        )
        .limit(1);

      if (existing) {
        const commentEnc = cleanedComment
          ? crypto.encrypt(
              cleanedComment,
              `knowledge_article_feedback.comment_enc:${existing.publicId}`,
            )
          : null;
        await tx
          .update(knowledgeArticleFeedback)
          .set({
            helpful: input.helpful,
            commentEnc,
            updatedAt: now,
          })
          .where(eq(knowledgeArticleFeedback.id, existing.id));
      } else {
        const fbPubId = ulid(now.getTime());
        const commentEnc = cleanedComment
          ? crypto.encrypt(cleanedComment, `knowledge_article_feedback.comment_enc:${fbPubId}`)
          : null;
        await tx.insert(knowledgeArticleFeedback).values({
          publicId: fbPubId,
          articleId: article.id,
          userId: principal.userId,
          helpful: input.helpful,
          commentEnc,
          createdAt: now,
          updatedAt: now,
        });
      }

      const [yesAgg] = await tx
        .select({ c: count() })
        .from(knowledgeArticleFeedback)
        .innerJoin(users, and(eq(users.id, knowledgeArticleFeedback.userId), liveUserPredicate(users)))
        .where(
          and(
            eq(knowledgeArticleFeedback.articleId, article.id),
            eq(knowledgeArticleFeedback.helpful, true),
          ),
        );
      const [noAgg] = await tx
        .select({ c: count() })
        .from(knowledgeArticleFeedback)
        .innerJoin(users, and(eq(users.id, knowledgeArticleFeedback.userId), liveUserPredicate(users)))
        .where(
          and(
            eq(knowledgeArticleFeedback.articleId, article.id),
            eq(knowledgeArticleFeedback.helpful, false),
          ),
        );

      const helpfulYesCount = Number(yesAgg?.c ?? 0);
      const helpfulNoCount = Number(noAgg?.c ?? 0);

      await tx
        .update(knowledgeArticles)
        .set({ helpfulYesCount, helpfulNoCount })
        .where(eq(knowledgeArticles.id, article.id));

      await audit.record(
        {
          category: "business",
          eventName: "knowledge.article.feedback_submitted",
          action: "submit_feedback",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_article", publicId: article.publicId },
          attributes: {
            helpful: input.helpful,
            has_comment: cleanedComment.length > 0,
          },
        },
        tx,
      );

      return { recorded: true, helpfulYesCount, helpfulNoCount };
    });
  }

  /* --------------------------------------------------- Attachments (`files` + `storage`) */

  async function beginAttachmentUpload(
    principal: SessionPrincipal,
    articlePublicId: string,
  ): Promise<KnowledgeAttachmentUploadAuth> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    if (!ULID_PATTERN.test(articlePublicId)) {
      throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
    }
    const [article] = await db
      .select({ id: knowledgeArticles.id, publicId: knowledgeArticles.publicId })
      .from(knowledgeArticles)
      .where(eq(knowledgeArticles.publicId, articlePublicId))
      .limit(1);
    if (!article) {
      throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
    }
    const rules = await readSetting(settings, fileRulesSetting);
    return {
      articleId: article.id,
      articlePublicId: article.publicId,
      rules,
    };
  }

  async function commitAttachmentUpload(
    principal: SessionPrincipal,
    auth: KnowledgeAttachmentUploadAuth,
    staged: StagedUpload,
  ): Promise<KnowledgeAttachmentView> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    const destKey = storage.newKey("files");
    await storage.move(staged.info.key, destKey);
    const now = clock.now();
    const attPublicId = ulid(now.getTime());

    try {
      await db.transaction(async (tx) => {
        await assertKnowledgeActorInTx(deps, principal, tx, "knowledge.manage");
        const [article] = await tx
          .select({ id: knowledgeArticles.id, publicId: knowledgeArticles.publicId })
          .from(knowledgeArticles)
          .where(eq(knowledgeArticles.id, auth.articleId))
          .limit(1);
        if (!article) {
          throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
        }

        const displayNameEnc = crypto.encrypt(
          staged.displayName,
          `knowledge_article_attachments.display_name:${attPublicId}`,
        );

        await tx.insert(knowledgeArticleAttachments).values({
          publicId: attPublicId,
          articleId: article.id,
          uploadedByUserId: principal.userId,
          storageKey: destKey,
          displayNameEnc,
          byteSize: staged.info.size,
          sha256: staged.info.sha256,
          contentType: staged.classification.mime,
          extension: staged.classification.extension,
          deletedAt: null,
          createdAt: now,
        });

        await audit.record(
          {
            category: "admin",
            eventName: "knowledge.attachment.uploaded",
            action: "upload",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "knowledge_attachment", publicId: attPublicId },
            attributes: {
              article_public_id: article.publicId,
              extension: staged.classification.extension,
            },
            safeCounts: { byte_size: staged.info.size },
          },
          tx,
        );
      });
    } catch (err) {
      await storage.delete(destKey).catch(() => {});
      throw err;
    }

    return {
      publicId: attPublicId,
      displayName: staged.displayName,
      size: staged.info.size,
      contentType: staged.classification.mime,
      extension: staged.classification.extension,
      createdAt: now,
    };
  }

  async function removeAttachment(
    principal: SessionPrincipal,
    input: { attachmentPublicId: string },
  ): Promise<{ deleted: true }> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    if (!ULID_PATTERN.test(input.attachmentPublicId)) {
      throw notFound("ATTACHMENT_NOT_FOUND", "Attachment not found.");
    }
    const now = clock.now();

    return db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx, "knowledge.manage");
      const [att] = await tx
        .select()
        .from(knowledgeArticleAttachments)
        .where(
          and(
            eq(knowledgeArticleAttachments.publicId, input.attachmentPublicId),
            isNull(knowledgeArticleAttachments.deletedAt),
          ),
        )
        .limit(1);
      if (!att) {
        throw notFound("ATTACHMENT_NOT_FOUND", "Attachment not found.");
      }

      await tx
        .update(knowledgeArticleAttachments)
        .set({ deletedAt: now })
        .where(eq(knowledgeArticleAttachments.id, att.id));
      await tx
        .delete(knowledgeAttachmentTickets)
        .where(eq(knowledgeAttachmentTickets.attachmentId, att.id));

      await audit.record(
        {
          category: "admin",
          eventName: "knowledge.attachment.removed",
          action: "delete",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_attachment", publicId: att.publicId },
        },
        tx,
      );

      return { deleted: true };
    });
  }

  async function assertCanAccessAttachment(
    handle: DbOrTx,
    principal: SessionPrincipal,
    attachmentPublicId: string,
    txForFlag?: Tx,
  ): Promise<{
    attachment: typeof knowledgeArticleAttachments.$inferSelect;
    article: ArticleRow;
  }> {
    const [att] = await handle
      .select()
      .from(knowledgeArticleAttachments)
      .where(
        and(
          eq(knowledgeArticleAttachments.publicId, attachmentPublicId),
          isNull(knowledgeArticleAttachments.deletedAt),
        ),
      )
      .limit(1);
    if (!att) {
      throw notFound("ATTACHMENT_NOT_FOUND", "Attachment not found.");
    }

    const [article] = await handle
      .select()
      .from(knowledgeArticles)
      .where(eq(knowledgeArticles.id, att.articleId))
      .limit(1);
    if (!article) {
      throw notFound("ATTACHMENT_NOT_FOUND", "Attachment not found.");
    }

    const canManage = roleHasCapability(principal.role, "knowledge.manage");
    if (!canManage) {
      await assertHelpEnabled(txForFlag);
      const audiences = allowedAudiencesForViewer(principal);
      if (article.state !== "published" || !audiences.includes(article.audience)) {
        throw notFound("ATTACHMENT_NOT_FOUND", "Attachment not found.");
      }
      if (article.categoryId) {
        const catMap = await loadCategoriesMap(handle);
        const cat = catMap.get(article.categoryId);
        if (!cat || cat.archivedAt) throw notFound("ATTACHMENT_NOT_FOUND", "Attachment not found.");
        if (cat.parentCategoryId && catMap.get(cat.parentCategoryId)?.archivedAt) {
          throw notFound("ATTACHMENT_NOT_FOUND", "Attachment not found.");
        }
      }
    }

    return { attachment: att, article };
  }

  async function issueAttachmentDownloadTicket(
    principal: SessionPrincipal,
    input: { attachmentPublicId: string },
  ): Promise<{ ticket: string; expiresAt: Date }> {
    await assertKnowledgeFullSession(deps, principal);
    if (!ULID_PATTERN.test(input.attachmentPublicId)) {
      throw notFound("ATTACHMENT_NOT_FOUND", "Attachment not found.");
    }

    const now = clock.now();
    const expiresAt = new Date(now.getTime() + TICKET_TTL_MS);
    const rawTicket = randomToken(32);
    const tokenHash = crypto.hashToken(rawTicket);

    await db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx);
      const { attachment, article } = await assertCanAccessAttachment(
        tx,
        principal,
        input.attachmentPublicId,
        tx,
      );

      await tx.insert(knowledgeAttachmentTickets).values({
        tokenHash,
        attachmentId: attachment.id,
        userId: principal.userId,
        sessionId: principal.sessionId,
        issuedAt: now,
        expiresAt,
      });

      await audit.record(
        {
          category: "file",
          eventName: "knowledge.attachment.ticket_issued",
          action: "issue_ticket",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_attachment", publicId: attachment.publicId },
          attributes: { article_public_id: article.publicId },
        },
        tx,
      );
    });

    return { ticket: rawTicket, expiresAt };
  }

  async function redeemAttachmentDownloadTicket(
    principal: SessionPrincipal,
    ticket: string,
  ): Promise<KnowledgeAttachmentDownload> {
    await assertKnowledgeFullSession(deps, principal);
    if (!TICKET_TOKEN_RE.test(ticket)) {
      throw forbidden("INVALID_DOWNLOAD_TICKET", "Invalid or expired download ticket.");
    }

    const now = clock.now();
    const tokenHash = crypto.hashToken(ticket);

    const verified = await db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx);

      const [tkt] = await tx
        .select()
        .from(knowledgeAttachmentTickets)
        .where(
          and(
            eq(knowledgeAttachmentTickets.tokenHash, tokenHash),
            eq(knowledgeAttachmentTickets.userId, principal.userId),
            eq(knowledgeAttachmentTickets.sessionId, principal.sessionId),
            gt(knowledgeAttachmentTickets.expiresAt, now),
          ),
        )
        .limit(1);

      if (!tkt) {
        throw forbidden("INVALID_DOWNLOAD_TICKET", "Invalid or expired download ticket.");
      }

      const [delRes] = await tx
        .delete(knowledgeAttachmentTickets)
        .where(eq(knowledgeAttachmentTickets.id, tkt.id));
      if (Number((delRes as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
        throw forbidden("INVALID_DOWNLOAD_TICKET", "Download ticket was already used.");
      }

      const [attRow] = await tx
        .select({ publicId: knowledgeArticleAttachments.publicId })
        .from(knowledgeArticleAttachments)
        .where(eq(knowledgeArticleAttachments.id, tkt.attachmentId))
        .limit(1);
      if (!attRow) {
        throw notFound("ATTACHMENT_NOT_FOUND", "Attachment not found.");
      }

      const { attachment, article } = await assertCanAccessAttachment(
        tx,
        principal,
        attRow.publicId,
        tx,
      );

      let displayName = `attachment.${attachment.extension}`;
      try {
        displayName = crypto.decrypt(
          attachment.displayNameEnc,
          `knowledge_article_attachments.display_name:${attachment.publicId}`,
        );
      } catch {
        // Fallback
      }

      await audit.record(
        {
          category: "file",
          eventName: "knowledge.attachment.downloaded",
          action: "download",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_attachment", publicId: attachment.publicId },
          attributes: { article_public_id: article.publicId },
        },
        tx,
      );

      return {
        storageKey: attachment.storageKey,
        view: {
          publicId: attachment.publicId,
          articlePublicId: article.publicId,
          displayName,
          size: Number(attachment.byteSize),
          contentType: attachment.contentType,
          extension: attachment.extension,
          createdAt: attachment.createdAt,
        },
      };
    });

    const stream = await storage.get(verified.storageKey);
    return {
      attachment: verified.view,
      stream,
    };
  }

  /* --------------------------------------------------- Console Settings */

  async function getSettings(principal: SessionPrincipal): Promise<KnowledgeSettingsView> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    const [isEnabled, cfg] = await Promise.all([
      enabled(),
      readSetting(settings, KNOWLEDGE_CONFIG),
    ]);
    return {
      enabled: isEnabled,
      searchLogRetentionDays: cfg.searchLogRetentionDays,
      allowFeedbackComments: cfg.allowFeedbackComments,
    };
  }

  async function updateSettings(
    principal: SessionPrincipal,
    input: {
      enabled?: boolean;
      searchLogRetentionDays?: number;
      allowFeedbackComments?: boolean;
    },
  ): Promise<KnowledgeSettingsView> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "platform.settings.manage");

    return db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx, "platform.settings.manage");
      const prevEnabled = await enabled(tx);
      const prevCfg = await readSetting(settings, KNOWLEDGE_CONFIG, tx);

      const nextEnabled = input.enabled ?? prevEnabled;
      const nextCfg = {
        searchLogRetentionDays: input.searchLogRetentionDays ?? prevCfg.searchLogRetentionDays,
        allowFeedbackComments: input.allowFeedbackComments ?? prevCfg.allowFeedbackComments,
      };

      if (nextEnabled !== prevEnabled) {
        await settings.set(KNOWLEDGE_FLAG.key, nextEnabled, tx);
      }
      await writeSetting(settings, KNOWLEDGE_CONFIG, nextCfg, tx);

      await audit.record(
        {
          category: "admin",
          eventName: "knowledge.settings.updated",
          action: "update",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_settings", publicId: "global" },
          attributes: {
            enabled: nextEnabled,
            previous_enabled: prevEnabled,
            allow_feedback_comments: nextCfg.allowFeedbackComments,
          },
          safeCounts: {
            search_log_retention_days: nextCfg.searchLogRetentionDays,
          },
        },
        tx,
      );

      return {
        enabled: nextEnabled,
        ...nextCfg,
      };
    });
  }

  /* --------------------------------------------------- Console Categories */

  async function listAdminCategories(
    principal: SessionPrincipal,
    input?: { includeArchived?: boolean },
  ): Promise<{ items: KnowledgeCategoryView[] }> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    const items = await buildCategoryTree(db, {
      includeArchived: Boolean(input?.includeArchived),
      audiences: ["customers", "staff"],
      includeTotalCounts: true,
    });
    return { items };
  }

  async function resolveValidParentCategoryId(
    tx: Tx,
    parentPublicId: string | null | undefined,
    selfCategoryId?: number,
  ): Promise<number | null> {
    if (!parentPublicId) return null;
    if (!ULID_PATTERN.test(parentPublicId)) {
      throw validation("INVALID_PARENT_CATEGORY", "Invalid parent category identifier.");
    }
    const [parent] = await tx
      .select()
      .from(knowledgeCategories)
      .where(eq(knowledgeCategories.publicId, parentPublicId))
      .limit(1);
    if (!parent || parent.archivedAt) {
      throw validation("INVALID_PARENT_CATEGORY", "Parent category does not exist or is archived.");
    }
    if (selfCategoryId && parent.id === selfCategoryId) {
      throw validation("INVALID_PARENT_CATEGORY", "A category cannot be its own parent.");
    }
    if (parent.parentCategoryId !== null) {
      throw validation(
        "CATEGORY_DEPTH_EXCEEDED",
        "Categories can be nested at most one level deep.",
      );
    }
    if (selfCategoryId) {
      const [existingChild] = await tx
        .select({ id: knowledgeCategories.id })
        .from(knowledgeCategories)
        .where(eq(knowledgeCategories.parentCategoryId, selfCategoryId))
        .limit(1);
      if (existingChild) {
        throw validation(
          "CATEGORY_DEPTH_EXCEEDED",
          "A category that already contains subcategories cannot become a subcategory.",
        );
      }
    }
    return parent.id;
  }

  async function findCategoryViewInTree(
    handle: DbOrTx,
    publicId: string,
  ): Promise<KnowledgeCategoryView> {
    const tree = await buildCategoryTree(handle, {
      includeArchived: true,
      audiences: ["customers", "staff"],
      includeTotalCounts: true,
    });
    for (const root of tree) {
      if (root.publicId === publicId) return root;
      for (const ch of root.children) {
        if (ch.publicId === publicId) return ch;
      }
    }
    throw notFound("CATEGORY_NOT_FOUND", "Category not found.");
  }

  async function createCategory(
    principal: SessionPrincipal,
    input: {
      parentPublicId?: string | null;
      slug: string;
      title: string;
      description?: string | null;
    },
  ): Promise<KnowledgeCategoryView> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    const slug = normalizeAndValidateSlug(input.slug, "Category slug");
    const title = normalizeAndValidateTitle(input.title, 160, "Category title");
    const description = input.description
      ? input.description.normalize("NFC").replace(SINGLE_LINE_CONTROL_RE, " ").trim().slice(0, 500) || null
      : null;

    const now = clock.now();
    const catPublicId = ulid(now.getTime());

    await db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx, "knowledge.manage");
      const parentCategoryId = await resolveValidParentCategoryId(tx, input.parentPublicId);

      const [countSib] = await tx
        .select({ c: count() })
        .from(knowledgeCategories)
        .where(
          parentCategoryId === null
            ? isNull(knowledgeCategories.parentCategoryId)
            : eq(knowledgeCategories.parentCategoryId, parentCategoryId),
        );
      const sortOrder = Number(countSib?.c ?? 0);

      try {
        await tx.insert(knowledgeCategories).values({
          publicId: catPublicId,
          parentCategoryId,
          slug,
          title,
          description,
          sortOrder,
          archivedAt: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw conflict("DUPLICATE_CATEGORY_SLUG", `Category slug '${slug}' is already in use.`);
        }
        throw err;
      }

      await audit.record(
        {
          category: "admin",
          eventName: "knowledge.category.created",
          action: "create",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_category", publicId: catPublicId },
          attributes: { slug },
        },
        tx,
      );
    });

    return findCategoryViewInTree(db, catPublicId);
  }

  async function updateCategory(
    principal: SessionPrincipal,
    input: {
      publicId: string;
      expectedVersion: number;
      parentPublicId?: string | null;
      slug?: string;
      title?: string;
      description?: string | null;
    },
  ): Promise<KnowledgeCategoryView> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("CATEGORY_NOT_FOUND", "Category not found.");
    }

    const now = clock.now();
    await db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx, "knowledge.manage");
      const [existing] = await tx
        .select()
        .from(knowledgeCategories)
        .where(eq(knowledgeCategories.publicId, input.publicId))
        .limit(1);
      if (!existing) throw notFound("CATEGORY_NOT_FOUND", "Category not found.");
      if (existing.version !== input.expectedVersion) {
        throw conflict("VERSION_CONFLICT", "Category was modified by another session. Reload and retry.");
      }

      const nextSlug =
        input.slug !== undefined
          ? normalizeAndValidateSlug(input.slug, "Category slug")
          : existing.slug;
      const nextTitle =
        input.title !== undefined
          ? normalizeAndValidateTitle(input.title, 160, "Category title")
          : existing.title;
      const nextDesc =
        input.description !== undefined
          ? input.description
            ? input.description.normalize("NFC").replace(SINGLE_LINE_CONTROL_RE, " ").trim().slice(0, 500) || null
            : null
          : existing.description;
      const nextParentId =
        input.parentPublicId !== undefined
          ? await resolveValidParentCategoryId(tx, input.parentPublicId, existing.id)
          : existing.parentCategoryId;

      try {
        const [upd] = await tx
          .update(knowledgeCategories)
          .set({
            slug: nextSlug,
            title: nextTitle,
            description: nextDesc,
            parentCategoryId: nextParentId,
            version: existing.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(knowledgeCategories.id, existing.id),
              eq(knowledgeCategories.version, input.expectedVersion),
            ),
          );
        if (Number((upd as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
          throw conflict("VERSION_CONFLICT", "Category was modified concurrently.");
        }
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw conflict("DUPLICATE_CATEGORY_SLUG", `Category slug '${nextSlug}' is already in use.`);
        }
        throw err;
      }

      await audit.record(
        {
          category: "admin",
          eventName: "knowledge.category.updated",
          action: "update",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_category", publicId: existing.publicId },
          attributes: { slug: nextSlug },
        },
        tx,
      );
    });

    return findCategoryViewInTree(db, input.publicId);
  }

  async function archiveCategory(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number; archived: boolean },
  ): Promise<KnowledgeCategoryView> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("CATEGORY_NOT_FOUND", "Category not found.");
    }
    const now = clock.now();

    await db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx, "knowledge.manage");
      const [existing] = await tx
        .select()
        .from(knowledgeCategories)
        .where(eq(knowledgeCategories.publicId, input.publicId))
        .limit(1);
      if (!existing) throw notFound("CATEGORY_NOT_FOUND", "Category not found.");
      if (existing.version !== input.expectedVersion) {
        throw conflict("VERSION_CONFLICT", "Category was modified concurrently.");
      }

      const [upd] = await tx
        .update(knowledgeCategories)
        .set({
          archivedAt: input.archived ? now : null,
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(knowledgeCategories.id, existing.id),
            eq(knowledgeCategories.version, input.expectedVersion),
          ),
        );
      if (Number((upd as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
        throw conflict("VERSION_CONFLICT", "Category was modified concurrently.");
      }

      await audit.record(
        {
          category: "admin",
          eventName: input.archived
            ? "knowledge.category.archived"
            : "knowledge.category.restored",
          action: input.archived ? "archive" : "restore",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_category", publicId: existing.publicId },
        },
        tx,
      );
    });

    return findCategoryViewInTree(db, input.publicId);
  }

  async function reorderCategories(
    principal: SessionPrincipal,
    input: { parentPublicId: string | null; orderedPublicIds: readonly string[] },
  ): Promise<{ updated: number }> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    const uniqueIds = [...new Set(input.orderedPublicIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > 200) {
      throw validation("INVALID_REORDER_LIST", "Provide between 1 and 200 category IDs.");
    }
    for (const id of uniqueIds) {
      if (!ULID_PATTERN.test(id)) throw validation("INVALID_REORDER_LIST", "Invalid category ID.");
    }

    const now = clock.now();
    return db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx, "knowledge.manage");
      const parentId = await resolveValidParentCategoryId(tx, input.parentPublicId);

      const siblings = await tx
        .select({ id: knowledgeCategories.id, publicId: knowledgeCategories.publicId })
        .from(knowledgeCategories)
        .where(
          parentId === null
            ? isNull(knowledgeCategories.parentCategoryId)
            : eq(knowledgeCategories.parentCategoryId, parentId),
        )
        .orderBy(asc(knowledgeCategories.sortOrder), asc(knowledgeCategories.id));

      const sibByPub = new Map(siblings.map((s) => [s.publicId, s.id]));
      for (const pid of uniqueIds) {
        if (!sibByPub.has(pid)) {
          throw validation("INVALID_REORDER_LIST", "All categories must belong to the same level.");
        }
      }

      const finalOrder = [
        ...uniqueIds.map((pid) => sibByPub.get(pid)!),
        ...siblings.filter((s) => !uniqueIds.includes(s.publicId)).map((s) => s.id),
      ];

      for (let idx = 0; idx < finalOrder.length; idx += 1) {
        await tx
          .update(knowledgeCategories)
          .set({ sortOrder: idx, updatedAt: now })
          .where(eq(knowledgeCategories.id, finalOrder[idx]!));
      }

      await audit.record(
        {
          category: "admin",
          eventName: "knowledge.category.reordered",
          action: "reorder",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_category", publicId: input.parentPublicId ?? "root" },
          safeCounts: { reordered_count: finalOrder.length },
        },
        tx,
      );

      return { updated: finalOrder.length };
    });
  }

  /* --------------------------------------------------- Console Articles & Versions */

  async function buildAdminArticleDetail(
    handle: DbOrTx,
    row: ArticleRow,
    principal: SessionPrincipal,
  ): Promise<KnowledgeAdminArticleDetailView> {
    const base = await hydrateArticleDetail(handle, row, principal, { publishedRelatedOnly: false });
    const rules = await readSetting(settings, fileRulesSetting);
    return {
      ...base,
      bodyHtml: row.bodyHtml,
      uploadPolicy: {
        extensions: rules.extensions,
        maxFileBytes: rules.maxFileBytes,
        maxRequestBytes: rules.maxRequestBytes,
        maxFiles: rules.maxFiles,
      },
    };
  }

  async function listAdminArticles(
    principal: SessionPrincipal,
    input: {
      state?: KnowledgeArticleState;
      audience?: KnowledgeAudience;
      categoryPublicId?: string;
      tag?: string;
      query?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{ items: KnowledgeArticleSummaryView[]; nextCursor: string | null }> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const beforeId = decodeIdCursor(input.cursor);
    const catMap = await loadCategoriesMap(db);

    let categoryIdFilter: number | undefined;
    if (input.categoryPublicId) {
      if (!ULID_PATTERN.test(input.categoryPublicId)) {
        return { items: [], nextCursor: null };
      }
      for (const c of catMap.values()) {
        if (c.publicId === input.categoryPublicId) {
          categoryIdFilter = c.id;
          break;
        }
      }
      if (categoryIdFilter === undefined) {
        return { items: [], nextCursor: null };
      }
    }

    let tagArticleIdSet: Set<number> | null = null;
    if (input.tag) {
      const tagNorm = input.tag.trim().toLowerCase();
      const tagRows = await db
        .select({ articleId: knowledgeArticleTags.articleId })
        .from(knowledgeArticleTags)
        .where(eq(knowledgeArticleTags.tag, tagNorm));
      tagArticleIdSet = new Set(tagRows.map((r) => r.articleId));
    }

    const q = input.query?.normalize("NFC").trim().toLowerCase() ?? "";

    const rows = await db
      .select()
      .from(knowledgeArticles)
      .where(
        and(
          input.state ? eq(knowledgeArticles.state, input.state) : undefined,
          input.audience ? eq(knowledgeArticles.audience, input.audience) : undefined,
          categoryIdFilter !== undefined ? eq(knowledgeArticles.categoryId, categoryIdFilter) : undefined,
          beforeId !== undefined ? lt(knowledgeArticles.id, beforeId) : undefined,
        ),
      )
      .orderBy(desc(knowledgeArticles.id))
      .limit(q || tagArticleIdSet ? 300 : limit + 1);

    const filtered = rows.filter((r) => {
      if (tagArticleIdSet && !tagArticleIdSet.has(r.id)) return false;
      if (q) {
        return (
          r.title.toLowerCase().includes(q) ||
          r.slug.toLowerCase().includes(q) ||
          r.summary.toLowerCase().includes(q) ||
          r.bodyText.toLowerCase().includes(q)
        );
      }
      return true;
    });

    const slice = filtered.slice(0, limit);
    const nextCursor = filtered.length > limit ? encodeIdCursor(slice[slice.length - 1]!.id) : null;

    return {
      items: slice.map((r) => toSummaryView(r, catMap)),
      nextCursor,
    };
  }

  async function getAdminArticle(
    principal: SessionPrincipal,
    input: { publicId: string },
  ): Promise<KnowledgeAdminArticleDetailView> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
    }
    const [row] = await db
      .select()
      .from(knowledgeArticles)
      .where(eq(knowledgeArticles.publicId, input.publicId))
      .limit(1);
    if (!row) {
      throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
    }
    return buildAdminArticleDetail(db, row, principal);
  }

  async function previewArticle(
    principal: SessionPrincipal,
    input: { title: string; summary: string; bodyHtml: string },
  ): Promise<{
    sanitizedHtml: string;
    bodyBlocks: KnowledgeRichBlock[];
    toc: KnowledgeTocEntry[];
  }> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    normalizeAndValidateTitle(input.title, 200, "Article title");
    normalizeAndValidateSummary(input.summary);
    const sanitized = sanitizeKnowledgeHtmlOnWrite(input.bodyHtml);
    return {
      sanitizedHtml: sanitized.html,
      bodyBlocks: sanitized.blocks,
      toc: sanitized.toc,
    };
  }

  async function resolveCategoryIdOrNull(
    tx: Tx,
    categoryPublicId: string | null | undefined,
  ): Promise<number | null> {
    if (!categoryPublicId) return null;
    if (!ULID_PATTERN.test(categoryPublicId)) {
      throw validation("INVALID_CATEGORY", "Invalid category identifier.");
    }
    const [cat] = await tx
      .select({ id: knowledgeCategories.id, archivedAt: knowledgeCategories.archivedAt })
      .from(knowledgeCategories)
      .where(eq(knowledgeCategories.publicId, categoryPublicId))
      .limit(1);
    if (!cat || cat.archivedAt) {
      throw validation("INVALID_CATEGORY", "Selected category does not exist or is archived.");
    }
    return cat.id;
  }

  async function createArticle(
    principal: SessionPrincipal,
    input: {
      categoryPublicId?: string | null;
      slug: string;
      title: string;
      summary: string;
      bodyHtml: string;
      tags?: readonly string[];
      audience?: KnowledgeAudience;
      state?: "draft" | "published";
      reviewedOn?: string | null;
      relatedArticlePublicIds?: readonly string[];
      changeNote?: string | null;
    },
  ): Promise<KnowledgeAdminArticleDetailView> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");

    const slug = normalizeAndValidateSlug(input.slug, "Article slug");
    const title = normalizeAndValidateTitle(input.title, 200, "Article title");
    const summary = normalizeAndValidateSummary(input.summary);
    const sanitized = sanitizeKnowledgeHtmlOnWrite(input.bodyHtml);
    const tags = normalizeAndValidateTags(input.tags);
    const audience: KnowledgeAudience = input.audience ?? "customers";
    const state: KnowledgeArticleState = input.state ?? "draft";
    const reviewedOn = normalizeReviewedOn(input.reviewedOn);
    const changeNote = input.changeNote
      ? input.changeNote.normalize("NFC").replace(SINGLE_LINE_CONTROL_RE, " ").trim().slice(0, 255) || null
      : "Initial version";

    const now = clock.now();
    const articlePublicId = ulid(now.getTime());
    const versionPublicId = ulid(now.getTime() + 1);
    const tagsJson = JSON.stringify(tags);

    await db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx, "knowledge.manage");
      const categoryId = await resolveCategoryIdOrNull(tx, input.categoryPublicId);

      let articleId: number;
      try {
        const [ins] = await tx.insert(knowledgeArticles).values({
          publicId: articlePublicId,
          categoryId,
          slug,
          title,
          summary,
          bodyHtml: sanitized.html,
          bodyText: sanitized.plainText,
          tagsJson,
          audience,
          state,
          publishedAt: state === "published" ? now : null,
          reviewedOn,
          authorUserId: principal.userId,
          updatedByUserId: principal.userId,
          sortOrder: 0,
          viewCount: 0,
          helpfulYesCount: 0,
          helpfulNoCount: 0,
          currentVersionNumber: 1,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        articleId = Number(ins.insertId);
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw conflict("DUPLICATE_ARTICLE_SLUG", `Article slug '${slug}' is already in use.`);
        }
        throw err;
      }

      await syncArticleTagsAndRelations(
        tx,
        articleId,
        tags,
        input.relatedArticlePublicIds ?? [],
        now,
      );

      await tx.insert(knowledgeArticleVersions).values({
        publicId: versionPublicId,
        articleId,
        versionNumber: 1,
        categoryId,
        slug,
        title,
        summary,
        bodyHtml: sanitized.html,
        bodyText: sanitized.plainText,
        tagsJson,
        audience,
        reviewedOn,
        changeNote,
        authorUserId: principal.userId,
        createdAt: now,
      });

      await audit.record(
        {
          category: "admin",
          eventName: "knowledge.article.created",
          action: "create",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_article", publicId: articlePublicId },
          attributes: { slug, audience, state },
          safeCounts: { tags: tags.length },
        },
        tx,
      );
    });

    return getAdminArticle(principal, { publicId: articlePublicId });
  }

  async function updateArticle(
    principal: SessionPrincipal,
    input: {
      publicId: string;
      expectedVersion: number;
      categoryPublicId?: string | null;
      slug?: string;
      title?: string;
      summary?: string;
      bodyHtml?: string;
      tags?: readonly string[];
      audience?: KnowledgeAudience;
      reviewedOn?: string | null;
      relatedArticlePublicIds?: readonly string[];
      changeNote?: string | null;
    },
  ): Promise<KnowledgeAdminArticleDetailView> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
    }

    const now = clock.now();
    await db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx, "knowledge.manage");
      const [existing] = await tx
        .select()
        .from(knowledgeArticles)
        .where(eq(knowledgeArticles.publicId, input.publicId))
        .limit(1);
      if (!existing) throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
      if (existing.version !== input.expectedVersion) {
        throw conflict("VERSION_CONFLICT", "Article was modified by another session. Reload and retry.");
      }

      const nextSlug =
        input.slug !== undefined
          ? normalizeAndValidateSlug(input.slug, "Article slug")
          : existing.slug;
      const nextTitle =
        input.title !== undefined
          ? normalizeAndValidateTitle(input.title, 200, "Article title")
          : existing.title;
      const nextSummary =
        input.summary !== undefined ? normalizeAndValidateSummary(input.summary) : existing.summary;
      const sanitized =
        input.bodyHtml !== undefined
          ? sanitizeKnowledgeHtmlOnWrite(input.bodyHtml)
          : { html: existing.bodyHtml, plainText: existing.bodyText };
      const nextTags =
        input.tags !== undefined ? normalizeAndValidateTags(input.tags) : parseTagsJson(existing.tagsJson);
      const nextTagsJson = JSON.stringify(nextTags);
      const nextAudience = input.audience ?? existing.audience;
      const nextReviewedOn =
        input.reviewedOn !== undefined ? normalizeReviewedOn(input.reviewedOn) : existing.reviewedOn;
      const nextCategoryId =
        input.categoryPublicId !== undefined
          ? await resolveCategoryIdOrNull(tx, input.categoryPublicId)
          : existing.categoryId;

      const nextVersionNum = existing.currentVersionNumber + 1;
      const changeNote = input.changeNote
        ? input.changeNote.normalize("NFC").replace(SINGLE_LINE_CONTROL_RE, " ").trim().slice(0, 255) || null
        : null;

      try {
        const [upd] = await tx
          .update(knowledgeArticles)
          .set({
            categoryId: nextCategoryId,
            slug: nextSlug,
            title: nextTitle,
            summary: nextSummary,
            bodyHtml: sanitized.html,
            bodyText: sanitized.plainText,
            tagsJson: nextTagsJson,
            audience: nextAudience,
            reviewedOn: nextReviewedOn,
            updatedByUserId: principal.userId,
            currentVersionNumber: nextVersionNum,
            version: existing.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(knowledgeArticles.id, existing.id),
              eq(knowledgeArticles.version, input.expectedVersion),
            ),
          );
        if (Number((upd as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
          throw conflict("VERSION_CONFLICT", "Article was modified concurrently.");
        }
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw conflict("DUPLICATE_ARTICLE_SLUG", `Article slug '${nextSlug}' is already in use.`);
        }
        throw err;
      }

      await syncArticleTagsAndRelations(
        tx,
        existing.id,
        nextTags,
        input.relatedArticlePublicIds,
        now,
      );

      await tx.insert(knowledgeArticleVersions).values({
        publicId: ulid(now.getTime() + 1),
        articleId: existing.id,
        versionNumber: nextVersionNum,
        categoryId: nextCategoryId,
        slug: nextSlug,
        title: nextTitle,
        summary: nextSummary,
        bodyHtml: sanitized.html,
        bodyText: sanitized.plainText,
        tagsJson: nextTagsJson,
        audience: nextAudience,
        reviewedOn: nextReviewedOn,
        changeNote,
        authorUserId: principal.userId,
        createdAt: now,
      });

      await audit.record(
        {
          category: "admin",
          eventName: "knowledge.article.updated",
          action: "update",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_article", publicId: existing.publicId },
          attributes: { slug: nextSlug, audience: nextAudience, state: existing.state },
          safeCounts: { version_number: nextVersionNum },
        },
        tx,
      );
    });

    return getAdminArticle(principal, { publicId: input.publicId });
  }

  async function setArticleState(
    principal: SessionPrincipal,
    input: { publicId: string; expectedVersion: number; state: KnowledgeArticleState },
  ): Promise<KnowledgeAdminArticleDetailView> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
    }
    const now = clock.now();

    await db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx, "knowledge.manage");
      const [existing] = await tx
        .select()
        .from(knowledgeArticles)
        .where(eq(knowledgeArticles.publicId, input.publicId))
        .limit(1);
      if (!existing) throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
      if (existing.version !== input.expectedVersion) {
        throw conflict("VERSION_CONFLICT", "Article was modified concurrently.");
      }

      const publishedAt =
        input.state === "published" ? (existing.publishedAt ?? now) : existing.publishedAt;

      const [upd] = await tx
        .update(knowledgeArticles)
        .set({
          state: input.state,
          publishedAt,
          updatedByUserId: principal.userId,
          version: existing.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(knowledgeArticles.id, existing.id),
            eq(knowledgeArticles.version, input.expectedVersion),
          ),
        );
      if (Number((upd as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
        throw conflict("VERSION_CONFLICT", "Article was modified concurrently.");
      }

      const eventName =
        input.state === "published"
          ? "knowledge.article.published"
          : input.state === "archived"
            ? "knowledge.article.archived"
            : "knowledge.article.unpublished";

      await audit.record(
        {
          category: "admin",
          eventName,
          action: input.state,
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_article", publicId: existing.publicId },
          attributes: {
            from_state: existing.state,
            to_state: input.state,
            audience: existing.audience,
          },
        },
        tx,
      );
    });

    return getAdminArticle(principal, { publicId: input.publicId });
  }

  async function reorderArticles(
    principal: SessionPrincipal,
    input: { categoryPublicId: string | null; orderedPublicIds: readonly string[] },
  ): Promise<{ updated: number }> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    const uniqueIds = [...new Set(input.orderedPublicIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > 200) {
      throw validation("INVALID_REORDER_LIST", "Provide between 1 and 200 article IDs.");
    }
    for (const id of uniqueIds) {
      if (!ULID_PATTERN.test(id)) throw validation("INVALID_REORDER_LIST", "Invalid article ID.");
    }

    const now = clock.now();
    return db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx, "knowledge.manage");
      const categoryId = await resolveCategoryIdOrNull(tx, input.categoryPublicId);

      const siblings = await tx
        .select({ id: knowledgeArticles.id, publicId: knowledgeArticles.publicId })
        .from(knowledgeArticles)
        .where(
          categoryId === null
            ? isNull(knowledgeArticles.categoryId)
            : eq(knowledgeArticles.categoryId, categoryId),
        )
        .orderBy(asc(knowledgeArticles.sortOrder), asc(knowledgeArticles.id));

      const sibByPub = new Map(siblings.map((s) => [s.publicId, s.id]));
      for (const pid of uniqueIds) {
        if (!sibByPub.has(pid)) {
          throw validation("INVALID_REORDER_LIST", "All articles must belong to the selected category.");
        }
      }

      const finalOrder = [
        ...uniqueIds.map((pid) => sibByPub.get(pid)!),
        ...siblings.filter((s) => !uniqueIds.includes(s.publicId)).map((s) => s.id),
      ];

      for (let idx = 0; idx < finalOrder.length; idx += 1) {
        await tx
          .update(knowledgeArticles)
          .set({ sortOrder: idx, updatedAt: now })
          .where(eq(knowledgeArticles.id, finalOrder[idx]!));
      }

      await audit.record(
        {
          category: "admin",
          eventName: "knowledge.article.reordered",
          action: "reorder",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_category", publicId: input.categoryPublicId ?? "uncategorized" },
          safeCounts: { reordered_count: finalOrder.length },
        },
        tx,
      );

      return { updated: finalOrder.length };
    });
  }

  async function listArticleVersions(
    principal: SessionPrincipal,
    input: { publicId: string },
  ): Promise<{ items: KnowledgeArticleVersionView[] }> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
    }
    const [article] = await db
      .select({ id: knowledgeArticles.id })
      .from(knowledgeArticles)
      .where(eq(knowledgeArticles.publicId, input.publicId))
      .limit(1);
    if (!article) throw notFound("ARTICLE_NOT_FOUND", "Article not found.");

    const rows = await db
      .select()
      .from(knowledgeArticleVersions)
      .where(eq(knowledgeArticleVersions.articleId, article.id))
      .orderBy(desc(knowledgeArticleVersions.versionNumber))
      .limit(100);

    return {
      items: rows.map((r) => ({
        publicId: r.publicId,
        versionNumber: r.versionNumber,
        slug: r.slug,
        title: r.title,
        summary: r.summary,
        tags: parseTagsJson(r.tagsJson),
        audience: r.audience,
        reviewedOn: r.reviewedOn ?? null,
        changeNote: r.changeNote ?? null,
        createdAt: r.createdAt,
      })),
    };
  }

  async function restoreArticleVersion(
    principal: SessionPrincipal,
    input: {
      publicId: string;
      expectedVersion: number;
      versionNumber: number;
      changeNote?: string | null;
    },
  ): Promise<KnowledgeAdminArticleDetailView> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");
    if (!ULID_PATTERN.test(input.publicId)) {
      throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
    }
    const now = clock.now();

    await db.transaction(async (tx) => {
      await assertKnowledgeActorInTx(deps, principal, tx, "knowledge.manage");
      const [article] = await tx
        .select()
        .from(knowledgeArticles)
        .where(eq(knowledgeArticles.publicId, input.publicId))
        .limit(1);
      if (!article) throw notFound("ARTICLE_NOT_FOUND", "Article not found.");
      if (article.version !== input.expectedVersion) {
        throw conflict("VERSION_CONFLICT", "Article was modified concurrently.");
      }

      const [targetVer] = await tx
        .select()
        .from(knowledgeArticleVersions)
        .where(
          and(
            eq(knowledgeArticleVersions.articleId, article.id),
            eq(knowledgeArticleVersions.versionNumber, input.versionNumber),
          ),
        )
        .limit(1);
      if (!targetVer) {
        throw notFound("VERSION_NOT_FOUND", `Version ${input.versionNumber} does not exist.`);
      }

      // Re-sanitise restored HTML on write for defense in depth
      const resanitized = sanitizeKnowledgeHtmlOnWrite(targetVer.bodyHtml);
      const restoredTags = parseTagsJson(targetVer.tagsJson);
      const nextVersionNum = article.currentVersionNumber + 1;
      const note = input.changeNote
        ? input.changeNote.normalize("NFC").replace(SINGLE_LINE_CONTROL_RE, " ").trim().slice(0, 255) ||
          `Restored from version ${targetVer.versionNumber}`
        : `Restored from version ${targetVer.versionNumber}`;

      // Verify targetVer.categoryId still exists & isn't archived; otherwise keep current categoryId
      let nextCategoryId = article.categoryId;
      if (targetVer.categoryId !== null) {
        const [cat] = await tx
          .select({ id: knowledgeCategories.id, archivedAt: knowledgeCategories.archivedAt })
          .from(knowledgeCategories)
          .where(eq(knowledgeCategories.id, targetVer.categoryId))
          .limit(1);
        if (cat && !cat.archivedAt) nextCategoryId = cat.id;
      } else {
        nextCategoryId = null;
      }

      try {
        const [upd] = await tx
          .update(knowledgeArticles)
          .set({
            categoryId: nextCategoryId,
            slug: targetVer.slug,
            title: targetVer.title,
            summary: targetVer.summary,
            bodyHtml: resanitized.html,
            bodyText: resanitized.plainText,
            tagsJson: JSON.stringify(restoredTags),
            audience: targetVer.audience,
            reviewedOn: targetVer.reviewedOn,
            updatedByUserId: principal.userId,
            currentVersionNumber: nextVersionNum,
            version: article.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(knowledgeArticles.id, article.id),
              eq(knowledgeArticles.version, input.expectedVersion),
            ),
          );
        if (Number((upd as { affectedRows?: number }).affectedRows ?? 0) !== 1) {
          throw conflict("VERSION_CONFLICT", "Article was modified concurrently.");
        }
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw conflict(
            "DUPLICATE_ARTICLE_SLUG",
            `Slug '${targetVer.slug}' from version ${targetVer.versionNumber} is now used by another article.`,
          );
        }
        throw err;
      }

      await syncArticleTagsAndRelations(tx, article.id, restoredTags, undefined, now);

      await tx.insert(knowledgeArticleVersions).values({
        publicId: ulid(now.getTime() + 1),
        articleId: article.id,
        versionNumber: nextVersionNum,
        categoryId: nextCategoryId,
        slug: targetVer.slug,
        title: targetVer.title,
        summary: targetVer.summary,
        bodyHtml: resanitized.html,
        bodyText: resanitized.plainText,
        tagsJson: JSON.stringify(restoredTags),
        audience: targetVer.audience,
        reviewedOn: targetVer.reviewedOn,
        changeNote: note,
        authorUserId: principal.userId,
        createdAt: now,
      });

      await audit.record(
        {
          category: "admin",
          eventName: "knowledge.article.version_restored",
          action: "restore_version",
          outcome: "completed",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "knowledge_article", publicId: article.publicId },
          safeCounts: {
            restored_from_version: targetVer.versionNumber,
            new_version_number: nextVersionNum,
          },
        },
        tx,
      );
    });

    return getAdminArticle(principal, { publicId: input.publicId });
  }

  async function getInsights(principal: SessionPrincipal): Promise<KnowledgeInsightsView> {
    await assertKnowledgeCapabilityPreflight(deps, principal, "knowledge.manage");

    const allArticles = await db
      .select({
        state: knowledgeArticles.state,
        audience: knowledgeArticles.audience,
        viewCount: knowledgeArticles.viewCount,
        helpfulYesCount: knowledgeArticles.helpfulYesCount,
        helpfulNoCount: knowledgeArticles.helpfulNoCount,
      })
      .from(knowledgeArticles);

    let publishedCustomerArticles = 0;
    let publishedStaffArticles = 0;
    let draftArticles = 0;
    let archivedArticles = 0;
    let totalViews = 0;
    let helpfulYesTotal = 0;
    let helpfulNoTotal = 0;

    for (const a of allArticles) {
      if (a.state === "published" && a.audience === "customers") publishedCustomerArticles += 1;
      else if (a.state === "published" && a.audience === "staff") publishedStaffArticles += 1;
      else if (a.state === "draft") draftArticles += 1;
      else if (a.state === "archived") archivedArticles += 1;
      totalViews += Number(a.viewCount ?? 0);
      helpfulYesTotal += a.helpfulYesCount;
      helpfulNoTotal += a.helpfulNoCount;
    }

    const topRows = await db
      .select()
      .from(knowledgeSearchLogs)
      .where(eq(knowledgeSearchLogs.audienceScope, "customers"))
      .orderBy(desc(knowledgeSearchLogs.searchCount), desc(knowledgeSearchLogs.lastSearchedAt))
      .limit(25);

    const zeroRows = await db
      .select()
      .from(knowledgeSearchLogs)
      .where(
        and(
          eq(knowledgeSearchLogs.audienceScope, "customers"),
          gt(knowledgeSearchLogs.zeroResultCount, 0),
        ),
      )
      .orderBy(desc(knowledgeSearchLogs.zeroResultCount), desc(knowledgeSearchLogs.lastSearchedAt))
      .limit(25);

    const fbRows = await db
      .select({
        publicId: knowledgeArticleFeedback.publicId,
        helpful: knowledgeArticleFeedback.helpful,
        commentEnc: knowledgeArticleFeedback.commentEnc,
        createdAt: knowledgeArticleFeedback.createdAt,
        articlePublicId: knowledgeArticles.publicId,
        articleSlug: knowledgeArticles.slug,
        articleTitle: knowledgeArticles.title,
      })
      .from(knowledgeArticleFeedback)
      .innerJoin(knowledgeArticles, eq(knowledgeArticleFeedback.articleId, knowledgeArticles.id))
      .innerJoin(users, and(eq(users.id, knowledgeArticleFeedback.userId), liveUserPredicate(users)))
      .orderBy(desc(knowledgeArticleFeedback.updatedAt))
      .limit(30);

    return {
      stats: {
        publishedCustomerArticles,
        publishedStaffArticles,
        draftArticles,
        archivedArticles,
        totalViews,
        helpfulYesTotal,
        helpfulNoTotal,
      },
      topSearches: topRows.map((r) => ({
        term: r.normalizedTerm,
        searchCount: r.searchCount,
        zeroResultCount: r.zeroResultCount,
        lastResultCount: r.lastResultCount,
        lastSearchedAt: r.lastSearchedAt,
      })),
      zeroResultSearches: zeroRows.map((r) => ({
        term: r.normalizedTerm,
        zeroResultCount: r.zeroResultCount,
        searchCount: r.searchCount,
        lastSearchedAt: r.lastSearchedAt,
      })),
      recentFeedback: fbRows.map((r) => {
        let comment: string | null = null;
        if (r.commentEnc) {
          try {
            comment = crypto.decrypt(
              r.commentEnc,
              `knowledge_article_feedback.comment_enc:${r.publicId}`,
            );
          } catch {
            comment = null;
          }
        }
        return {
          publicId: r.publicId,
          articlePublicId: r.articlePublicId,
          articleSlug: r.articleSlug,
          articleTitle: r.articleTitle,
          helpful: r.helpful,
          comment,
          createdAt: r.createdAt,
        };
      }),
    };
  }

  /* --------------------------------------------------- Public API v1 Provider (`knowledge`) */

  const publicApiProvider: PublicApiProviders["knowledge"] = {
    async list(query: ApiListQuery, _caller: ApiCaller): Promise<ApiPage<KnowledgeArticleDto>> {
      if (!(await enabled())) {
        throw unavailable("KNOWLEDGE_DISABLED", "Knowledge base is currently disabled.");
      }
      const limit = Math.min(Math.max(query.limit, 1), 100);
      const beforeId = decodeIdCursor(query.cursor);
      const catMap = await loadCategoriesMap(db);

      const filterTag = query.filter.tag?.trim().toLowerCase() ?? "";
      let tagIds: Set<number> | null = null;
      if (filterTag) {
        const tagRows = await db
          .select({ articleId: knowledgeArticleTags.articleId })
          .from(knowledgeArticleTags)
          .where(eq(knowledgeArticleTags.tag, filterTag));
        tagIds = new Set(tagRows.map((r) => r.articleId));
      }

      const rawSearch = query.filter.search?.trim() ?? "";
      const searchTokens = tokenizeSearchQuery(rawSearch);

      const rows = await db
        .select()
        .from(knowledgeArticles)
        .where(
          and(
            eq(knowledgeArticles.state, "published"),
            eq(knowledgeArticles.audience, "customers"),
            beforeId !== undefined ? lt(knowledgeArticles.id, beforeId) : undefined,
            query.updatedSince ? gt(knowledgeArticles.updatedAt, query.updatedSince) : undefined,
          ),
        )
        .orderBy(desc(knowledgeArticles.id))
        .limit(tagIds || searchTokens.length > 0 ? 300 : limit + 1);

      const visible = rows.filter((r) => {
        if (r.categoryId) {
          const cat = catMap.get(r.categoryId);
          if (!cat || cat.archivedAt) return false;
          if (cat.parentCategoryId && catMap.get(cat.parentCategoryId)?.archivedAt) return false;
        }
        if (tagIds && !tagIds.has(r.id)) return false;
        if (searchTokens.length > 0) {
          const score = scoreArticleMatch(
            {
              title: r.title,
              summary: r.summary,
              bodyText: r.bodyText,
              tags: parseTagsJson(r.tagsJson),
              helpfulYesCount: r.helpfulYesCount,
              viewCount: Number(r.viewCount),
            },
            rawSearch,
            searchTokens,
          );
          if (score <= 0) return false;
        }
        return true;
      });

      const slice = visible.slice(0, limit);
      const nextCursor = visible.length > limit ? encodeIdCursor(slice[slice.length - 1]!.id) : null;

      return {
        items: slice.map((r) => ({
          id: r.publicId,
          slug: r.slug,
          title: r.title,
          summary: r.summary,
          bodyHtml: r.bodyHtml,
          tags: parseTagsJson(r.tagsJson),
          categoryId: r.categoryId ? (catMap.get(r.categoryId)?.publicId ?? null) : null,
          updatedAt: r.updatedAt.toISOString(),
        })),
        nextCursor,
      };
    },

    async get(publicId: string, _caller: ApiCaller): Promise<KnowledgeArticleDto | null> {
      if (!(await enabled())) {
        throw unavailable("KNOWLEDGE_DISABLED", "Knowledge base is currently disabled.");
      }
      if (!ULID_PATTERN.test(publicId)) return null;
      const [r] = await db
        .select()
        .from(knowledgeArticles)
        .where(
          and(
            eq(knowledgeArticles.publicId, publicId),
            eq(knowledgeArticles.state, "published"),
            eq(knowledgeArticles.audience, "customers"),
          ),
        )
        .limit(1);
      if (!r) return null;

      const catMap = await loadCategoriesMap(db);
      if (r.categoryId) {
        const cat = catMap.get(r.categoryId);
        if (!cat || cat.archivedAt) return null;
        if (cat.parentCategoryId && catMap.get(cat.parentCategoryId)?.archivedAt) return null;
      }

      return {
        id: r.publicId,
        slug: r.slug,
        title: r.title,
        summary: r.summary,
        bodyHtml: r.bodyHtml,
        tags: parseTagsJson(r.tagsJson),
        categoryId: r.categoryId ? (catMap.get(r.categoryId)?.publicId ?? null) : null,
        updatedAt: r.updatedAt.toISOString(),
      };
    },
  };

  /* --------------------------------------------------- Retention Job & Lifecycle */

  jobs.register(
    KNOWLEDGE_RETENTION_JOB,
    async () => {
      const now = clock.now();
      const cfg = await readSetting(settings, KNOWLEDGE_CONFIG);
      const searchCutoff = new Date(now.getTime() - cfg.searchLogRetentionDays * DAY_MS);

      await db
        .delete(knowledgeAttachmentTickets)
        .where(lte(knowledgeAttachmentTickets.expiresAt, now));
      await db
        .delete(knowledgeArticleViewDedup)
        .where(lte(knowledgeArticleViewDedup.expiresAt, now));
      await db
        .delete(knowledgeSearchLogs)
        .where(lte(knowledgeSearchLogs.lastSearchedAt, searchCutoff));
      return { outcome: "completed" };
    },
    { retrySafe: true },
  );

  jobs.registerSchedule({
    name: "knowledge.retention.daily",
    type: KNOWLEDGE_RETENTION_JOB,
    everyMs: DAY_MS,
    payload: {},
  });

  const trashParticipant = createKnowledgeTrashParticipant(deps);
  let providerRegistered = false;
  let trashRegistered = false;

  return {
    enabled,
    status,
    helpHome,
    helpCategory,
    helpArticle,
    helpSearch,
    helpRelatedForTicket,
    submitFeedback,
    beginAttachmentUpload,
    commitAttachmentUpload,
    removeAttachment,
    issueAttachmentDownloadTicket,
    redeemAttachmentDownloadTicket,
    getSettings,
    updateSettings,
    listAdminCategories,
    createCategory,
    updateCategory,
    archiveCategory,
    reorderCategories,
    listAdminArticles,
    getAdminArticle,
    previewArticle,
    createArticle,
    updateArticle,
    setArticleState,
    reorderArticles,
    listArticleVersions,
    restoreArticleVersion,
    getInsights,
    publicApiProvider,

    init() {
      if (!providerRegistered) {
        const pubApi = (
          deps.services as unknown as {
            publicApi?: {
              registerProvider?: <K extends keyof PublicApiProviders>(
                key: K,
                provider: PublicApiProviders[K],
              ) => void;
            };
          }
        ).publicApi;
        if (pubApi?.registerProvider) {
          pubApi.registerProvider("knowledge", publicApiProvider);
          providerRegistered = true;
        }
      }
      if (!trashRegistered && deps.services.trash?.register) {
        deps.services.trash.register(trashParticipant);
        trashRegistered = true;
      }
    },

    async health(): Promise<ModuleHealth[]> {
      const checkedAt = clock.now();
      try {
        const isOn = await enabled();
        return [
          {
            component: "knowledge",
            state: "ok",
            summary: isOn ? "Knowledge base enabled." : "Knowledge base disabled.",
            metrics: { enabled: isOn ? 1 : 0 },
            checkedAt,
          },
        ];
      } catch {
        return [
          {
            component: "knowledge",
            state: "degraded",
            summary: "Knowledge base settings could not be read.",
            checkedAt,
          },
        ];
      }
    },
  };
}
