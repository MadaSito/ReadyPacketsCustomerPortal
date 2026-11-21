/**
 * Knowledge Base module — public DTOs and structured rich-text AST types (Increment 04, Package F).
 * Rendered on the client via pure React elements (`<KnowledgeRichRenderer />`) with zero `dangerouslySetInnerHTML`.
 */
import type { KnowledgeArticleState, KnowledgeAudience } from "./schema.js";

export type { KnowledgeArticleState, KnowledgeAudience } from "./schema.js";

/* ------------------------------------------------------------------ Rich-text AST & TOC */

export type KnowledgeInlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: KnowledgeInlineNode[] }
  | { kind: "em"; children: KnowledgeInlineNode[] }
  | { kind: "code"; text: string }
  | { kind: "br" }
  | { kind: "link"; href: string; external: boolean; children: KnowledgeInlineNode[] };

export type KnowledgeListItemNode = {
  inlines: KnowledgeInlineNode[];
  sublists?: Array<{ ordered: boolean; items: KnowledgeListItemNode[] }>;
};

export type KnowledgeRichBlock =
  | { kind: "heading"; level: 2 | 3 | 4; id: string; text: string; children: KnowledgeInlineNode[] }
  | { kind: "paragraph"; children: KnowledgeInlineNode[] }
  | { kind: "list"; ordered: boolean; items: KnowledgeListItemNode[] }
  | { kind: "blockquote"; children: KnowledgeInlineNode[] }
  | { kind: "code_block"; code: string }
  | { kind: "hr" }
  | { kind: "image"; src: string; alt: string }
  | {
      kind: "table";
      headers: KnowledgeInlineNode[][];
      rows: KnowledgeInlineNode[][][];
    };

export interface KnowledgeTocEntry {
  id: string;
  level: 2 | 3 | 4;
  text: string;
}

/* ------------------------------------------------------------------ Views & DTOs */

export interface KnowledgeStatusView {
  enabled: boolean;
  canManage: boolean;
  canConfigure: boolean;
}

export interface KnowledgeSettingsView {
  enabled: boolean;
  searchLogRetentionDays: number;
  allowFeedbackComments: boolean;
}

export interface KnowledgeCategoryView {
  publicId: string;
  parentPublicId: string | null;
  slug: string;
  title: string;
  description: string | null;
  sortOrder: number;
  archivedAt: Date | null;
  version: number;
  publishedArticleCount: number;
  totalArticleCount?: number;
  children: KnowledgeCategoryView[];
}

export interface KnowledgeArticleSummaryView {
  publicId: string;
  slug: string;
  title: string;
  summary: string;
  tags: readonly string[];
  audience: KnowledgeAudience;
  state: KnowledgeArticleState;
  categoryPublicId: string | null;
  categorySlug: string | null;
  categoryTitle: string | null;
  reviewedOn: string | null;
  publishedAt: Date | null;
  viewCount: number;
  helpfulYesCount: number;
  helpfulNoCount: number;
  currentVersionNumber: number;
  version: number;
  sortOrder: number;
  updatedAt: Date;
}

export interface KnowledgeAttachmentView {
  publicId: string;
  displayName: string;
  size: number;
  contentType: string;
  extension: string;
  createdAt: Date;
}

export interface KnowledgeRelatedArticleView {
  publicId: string;
  slug: string;
  title: string;
  summary: string;
  categoryTitle: string | null;
}

export interface KnowledgeArticleDetailView extends KnowledgeArticleSummaryView {
  bodyBlocks: readonly KnowledgeRichBlock[];
  toc: readonly KnowledgeTocEntry[];
  attachments: readonly KnowledgeAttachmentView[];
  relatedArticles: readonly KnowledgeRelatedArticleView[];
  myFeedback: { helpful: boolean; hasComment: boolean } | null;
  allowFeedbackComments: boolean;
}

export interface KnowledgeAdminArticleDetailView extends KnowledgeArticleDetailView {
  /** Sanitised canonical HTML for `<RichTextEditor />` editing. */
  bodyHtml: string;
  uploadPolicy: {
    extensions: readonly string[];
    maxFileBytes: number;
    maxRequestBytes: number;
    maxFiles: number;
  };
}

export interface KnowledgeArticleVersionView {
  publicId: string;
  versionNumber: number;
  slug: string;
  title: string;
  summary: string;
  tags: readonly string[];
  audience: KnowledgeAudience;
  reviewedOn: string | null;
  changeNote: string | null;
  createdAt: Date;
}

export interface KnowledgeSnippetSegment {
  text: string;
  highlight: boolean;
}

export interface KnowledgeSearchHitView {
  publicId: string;
  slug: string;
  title: string;
  summary: string;
  tags: readonly string[];
  audience: KnowledgeAudience;
  categorySlug: string | null;
  categoryTitle: string | null;
  reviewedOn: string | null;
  updatedAt: Date;
  titleSegments: readonly KnowledgeSnippetSegment[];
  snippetSegments: readonly KnowledgeSnippetSegment[];
}

export interface KnowledgeSearchResponse {
  query: string;
  items: readonly KnowledgeSearchHitView[];
  nextCursor: string | null;
  suggestions: {
    popularArticles: readonly KnowledgeRelatedArticleView[];
    categories: readonly { publicId: string; slug: string; title: string; publishedArticleCount: number }[];
    suggestedTags: readonly string[];
  } | null;
}

export interface KnowledgeInsightsView {
  stats: {
    publishedCustomerArticles: number;
    publishedStaffArticles: number;
    draftArticles: number;
    archivedArticles: number;
    totalViews: number;
    helpfulYesTotal: number;
    helpfulNoTotal: number;
  };
  topSearches: readonly {
    term: string;
    searchCount: number;
    zeroResultCount: number;
    lastResultCount: number;
    lastSearchedAt: Date;
  }[];
  zeroResultSearches: readonly {
    term: string;
    zeroResultCount: number;
    searchCount: number;
    lastSearchedAt: Date;
  }[];
  recentFeedback: readonly {
    publicId: string;
    articlePublicId: string;
    articleSlug: string;
    articleTitle: string;
    helpful: boolean;
    comment: string | null;
    createdAt: Date;
  }[];
}
