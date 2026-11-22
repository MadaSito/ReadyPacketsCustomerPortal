# Package F (`knowledge`) & Public API `tickets` — Verification Evidence

## Automated Suites Executed

1. **Server & Public API v1 integration (`server/modules/knowledge/knowledge.test.ts`)** — **8/8 passed** against isolated MySQL (`createTestDb` + `createSettingsStore`):
   - Ships disabled by default (`feature.knowledge = false`); refuses customer `/help` procedures (`NOT_FOUND`) and Public API v1 `knowledge` (`UNAVAILABLE`), while allowing staff authoring and graceful empty `relatedForTicket`.
   - Role, capability (`knowledge.manage` vs `platform.settings.manage`), remediation-session, and fresh MFA step-up enforcement.
   - Category 1-level nesting cap (`CATEGORY_DEPTH_EXCEEDED`) and deterministic non-drag `reorderCategories`.
   - Fail-closed HTML sanitiser abuse cases (`<script>`, `<iframe>`, `onclick`, `onerror`, `javascript:` rejected with `UNSAFE_ARTICLE_HTML`), AST + TOC projection, immutable `knowledge_article_versions`, `restoreVersion`, and strict `audience = "staff"` / `state = "draft"` customer isolation.
   - Ranked search (`title/tags` ahead of `body`), highlighted segments, zero-result suggestions, and PII-scrubbed anonymous `knowledge_search_logs`.
   - Single-use 60-second attachment download tickets bound to `(userId, sessionId)` and article visibility.
   - AES-256-GCM encrypted feedback comments (`commentEnc`) and `knowledge.retention` purge job.
   - Public API v1 providers: `knowledge` (published customer articles only) and `tickets` (`engagement` list/get/create + idempotency replay + `actor.role = "system"` correlation audit).
2. **Customer Help Centre UI & accessibility (`client/src/features/knowledge/help.test.tsx`)** — **10/10 passed**:
   - `pageA11y` (axe-core WCAG 2.x A/AA + WCAG 2.2 AA ruleset in **light** and **dark** themes):
     - `/help` (ready state with categories & featured guides): light PASS, dark PASS.
     - `/help?q=exhibits` (ranked search results & highlighted snippets): light PASS, dark PASS.
     - `/help/categories/getting-started` (category detail & breadcrumbs): light PASS, dark PASS.
     - `/help/articles/preparing-exhibits` (AST renderer, TOC, attachments, feedback form): light PASS, dark PASS.
   - Disabled feature empty state and zero-result suggestions + feedback comment flow verified.
3. **Admin Knowledge Console UI & accessibility (`client/src/features/knowledge/admin/adminKnowledge.test.tsx`, co-built with `platform_engineer`)**:
   - `/admin/knowledge` and `/admin/knowledge/articles/:publicId` `pageA11y` light & dark PASS, keyboard reorder controls, version history restore, and step-up feature toggle verified.
4. **Engagement regression (`server/modules/engagement/engagement.test.ts`)**: existing engagement test suite updated for Increment 04 `FileRecord` fields and passing.

## WCAG 2.2 AA Scope Note

All `/help*` and `/admin/knowledge*` routes are designed and tested against WCAG 2.2 AA using semantic tokens (`tokens.test.ts` contrast gates), single `<h1>` via `PageHeader`, `Breadcrumbs`, labelled form controls, non-drag keyboard reorder buttons (WCAG 2.5.7), `min-w-0`/`break-words` responsive wrapping, print rules (`rp-print-avoid-break`), and `pageA11y` in light and dark themes. Live assistive-technology screen-reader walkthroughs (NVDA/VoiceOver) were not checked in this automated sandbox.
