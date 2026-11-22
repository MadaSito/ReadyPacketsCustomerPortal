# Knowledge Base & Help Centre — API (Package F, Increment 04)

Owner: `engagement_engineer` (`server/modules/knowledge/**`, `client/src/features/knowledge/**`).

Decision 7 & §2.F apply:
- **Ships disabled** (`feature.knowledge = false` by default). Enabling or disabling requires `platform.settings.manage` (administrator + fresh MFA step-up + in-transaction actor guard) and is durably audited (`knowledge.settings.updated`).
- **Sanitised rich text as data**: article bodies are sanitised on save through `mailTemplates/sanitizer.ts`'s strict HTML allow-list (zero scripts, styles, SVG, frames, forms, event attributes, or placeholders) and projected to a typed `KnowledgeRichBlock[]` + `KnowledgeTocEntry[]` tree so the client renders semantic React elements with **zero `dangerouslySetInnerHTML`**.
- **Strict audience & state boundaries**: customers (`knowledge.help.*`) and Public API v1 (`/api/v1/knowledge/articles`) only ever see `state === "published"` and `audience === "customers"` when `feature.knowledge` is enabled. Staff/admin (`knowledge.manage`) author drafts, staff-internal articles, categories, attachments, versions, and review search/feedback insights.
- **Privacy-preserving search analytics**: search terms are scrubbed (e-mail addresses and digit runs ≥ 6 redacted, NFC lower-cased, ≤ 80 chars), rate-limited per session, and aggregated in `knowledge_search_logs` **without `userId`, `sessionId`, IP address, or actor correlation**.

---

## 1. Exports (for `/root` to mount)

| Where | Export | Mount Target |
| --- | --- | --- |
| `server/modules/knowledge/index.ts` | `createKnowledgeModule(deps): KnowledgeModule`, `type KnowledgeModule` | `services.knowledge` in `server/container.ts` |
| `server/modules/knowledge/router.ts` | `knowledgeRouter` | `appRouter.knowledge` in `server/trpc/root.ts` |
| `server/modules/knowledge/http.ts` | `registerKnowledgeHttpRoutes(router, services)` | `/api/knowledge` in `server/http/moduleRoutes.ts` |
| `server/modules/knowledge/schema.ts` | `knowledgeCategories`, `knowledgeArticles`, `knowledgeArticleVersions`, `knowledgeArticleTags`, `knowledgeArticleRelations`, `knowledgeArticleAttachments`, `knowledgeAttachmentTickets`, `knowledgeArticleFeedback`, `knowledgeArticleViewDedup`, `knowledgeSearchLogs` | `server/db/schema/index.ts` |
| `client/src/features/knowledge/routes.tsx` | `knowledgeFeature` | `FEATURES` in `client/src/app/registry.ts` |

---

## 2. Cross-Module Ports

### 2.1 Feature Switch (`platform`)
- `KNOWLEDGE_FLAG = defineFeatureFlag({ flag: "knowledge", owner: "knowledge", group: "features", clientVisible: true })` (stored as `feature.knowledge`, default `false`).
- Client navigation entry: `/help` ("Knowledge base", `area: "customer"`, `group: "Support"`, `order: 120`, `enabledBy: "knowledge"`).
- Console navigation entry: `/admin/knowledge` ("Knowledge base", `area: "console"`, `group: "Operations"`, `order: 24`, `capability: "knowledge.manage"`).

### 2.2 Public API v1 Providers (`publicApi` — Package H)
- `knowledge.init()` calls `deps.services.publicApi?.registerProvider("knowledge", provider)`:
  - `list(query, caller)` & `get(publicId, caller)` returning `KnowledgeArticleDto` (`{ id, slug, title, summary, bodyHtml, tags, categoryId, updatedAt }`).
  - Enforces `feature.knowledge === true` (throws `unavailable("KNOWLEDGE_DISABLED")` when off) and strictly filters `state === "published"` and `audience === "customers"` (supports `filter.tag`, `filter.search`, `updatedSince`, cursor pagination).
- `engagement.init()` (`server/modules/engagement/publicApiProvider.ts`) calls `deps.services.publicApi?.registerProvider("tickets", provider)`:
  - `list(query, caller)` (`filter.customerId`, `filter.status`, `updatedSince`, cursor), `get(publicId, caller)`, and `create(input, caller)` returning `TicketDto` (`{ id, number, customerId, orderId, subject, status, priority, createdAt, updatedAt }`), auditing writes with `actor: { role: "system" }` and `correlationId: caller.requestId`.

### 2.3 Contextual Support-Ticket Slot (`engagement` ↔ `knowledge`)
- `client/src/features/knowledge/RelatedArticlesSlot.tsx` exports `RelatedArticlesSlot({ query, category })` and is loaded via `import.meta.glob` inside `client/src/features/engagement/pages/NewSupportTicketPage.tsx` (zero cross-feature static import; renders nothing when `feature.knowledge` is disabled).

### 2.4 Attachments via `files` (`server/modules/knowledge/http.ts`)
- `POST /api/knowledge/articles/:articlePublicId/attachments` (full session + CSRF + `knowledge.manage`): streams multipart `files` through `services.files.stageUpload` (magic-byte classification, AV scan, `FileRules` limits) and commits immutable objects under `files/<32hex>`.
- `POST /api/knowledge/attachments/download` (full session + CSRF): redeems a single-use 60-second SHA-256 hashed ticket issued by `trpc.knowledge.attachments.issueDownloadTicket` via `sendPrivateDownload`.

---

## 3. tRPC Procedures (`trpc.knowledge.*`)

Roles:
- **C** = any full session (`customer`, `staff`, `admin`) when `feature.knowledge` is enabled (`staff`/`admin` may also read `audience: "staff"` published articles).
- **M** = `staff` or `admin` with `knowledge.manage` (re-validated inside write transactions).
- **A** = `admin` with `platform.settings.manage` + fresh MFA step-up (re-validated inside write transactions).

| Procedure | Type | Guard | Summary |
| --- | --- | --- | --- |
| `status` | `query` | full session | `{ enabled, canManage, canConfigure }` |
| `help.home` | `query` | C | Categories tree (1-level nested) with article counts + featured/popular published articles |
| `help.category` | `query` | C | `{ slug }` → category detail, child categories, and ordered published articles |
| `help.article` | `query` | C | `{ slug, recordView? }` → full article (`bodyBlocks`, `toc`, `attachments`, `relatedArticles`, caller's `myFeedback`), deduplicated view count |
| `help.search` | `query` | C | `{ q?, categorySlug?, tag?, cursor?, limit? }` → ranked articles with `snippetSegments` (`{ text, highlight }[]`), `suggestions` when empty, privacy-safe search log |
| `help.relatedForTicket` | `query` | C | `{ query, category? }` → up to 5 contextual published customer articles for `NewSupportTicketPage` |
| `help.submitFeedback` | `mutation` | C | `{ articlePublicId, helpful: boolean, comment? }` → rate-limited (`10 / 10 min`), encrypted optional comment, atomic helpful counters |
| `attachments.issueDownloadTicket` | `mutation` | C / M | `{ attachmentPublicId }` → `{ ticket, expiresAt }` after verifying live article scope & feature state |
| `admin.settings.get` | `query` | M | `{ enabled, searchLogRetentionDays, allowFeedbackComments }` |
| `admin.settings.update` | `mutation` | A (step-up) | `{ enabled?, searchLogRetentionDays?, allowFeedbackComments? }`, audited |
| `admin.categories.list` | `query` | M | All categories (nested 1 level, including archived when requested) |
| `admin.categories.create` / `update` / `archive` | `mutation` | M | Manage categories (`expectedVersion` on update/archive; max depth = 1) |
| `admin.categories.reorder` | `mutation` | M | `{ parentPublicId: string \| null, orderedPublicIds: string[] }` (non-drag keyboard-friendly reorder) |
| `admin.articles.list` | `query` | M | `{ state?, audience?, categoryPublicId?, tag?, query?, cursor?, limit? }` |
| `admin.articles.get` | `query` | M | `{ publicId }` → full article including raw sanitised `bodyHtml`, `bodyBlocks`, `toc`, versions summary, attachments, related articles |
| `admin.articles.preview` | `mutation` | M | `{ title, summary, bodyHtml }` → `{ sanitizedHtml, bodyBlocks, toc }` for live editor preview |
| `admin.articles.create` / `update` | `mutation` | M | Sanitises HTML, derives `bodyText`, validates slug/tags/relations/reviewedOn, records immutable `knowledge_article_versions` snapshot |
| `admin.articles.setState` | `mutation` | M | `{ publicId, expectedVersion, state: "draft" \| "published" \| "archived" }`, audited |
| `admin.articles.reorder` | `mutation` | M | `{ categoryPublicId: string \| null, orderedPublicIds: string[] }` |
| `admin.articles.versions` | `query` | M | `{ publicId }` → version history |
| `admin.articles.restoreVersion` | `mutation` | M | `{ publicId, expectedVersion, versionNumber, changeNote? }` → restores historical content into a new version |
| `admin.attachments.remove` | `mutation` | M | `{ attachmentPublicId }` → soft-deletes attachment, audited |
| `admin.insights` | `query` | M | `{ stats, topSearches, zeroResultSearches, recentFeedback }` (decrypts feedback comments for authorized staff) |
