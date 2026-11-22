# Knowledge Base & Help Centre — Administrator Guide

## Overview

The Knowledge Base module (`knowledge`) provides a searchable customer Help Centre (`/help`) and an internal staff knowledge library managed from `/admin/knowledge`. It ships disabled by default behind feature flag `feature.knowledge = false` so staff can author, preview, organise, and review articles before exposing `/help` to customers.

All customer and console pages are designed and tested against WCAG 2.2 AA in both light and dark themes.

## Roles, Capabilities, and Step-Up Authentication

- **`knowledge.manage` (`staff` and `admin`)**: Create, edit, version, restore, publish, unpublish, archive, and reorder categories and articles; upload and remove attachments; view anonymised search analytics and decrypted feedback notes.
- **`platform.settings.manage` (`admin` with fresh MFA step-up)**: Enable or disable `feature.knowledge`, configure `knowledge.config.searchLogRetentionDays` (7–365 days, default 90), and toggle `knowledge.config.allowFeedbackComments`.

## Organising Categories

1. Open **Console → Knowledge Base** (`/admin/knowledge`).
2. Create top-level topics and optional subtopics. Categories support at most **one nesting level** (`parent` → `child`) to keep customer navigation clear on mobile and desktop viewports.
3. Reorder sibling categories using the **Move up** and **Move down** buttons (full keyboard support without drag-and-drop).

## Authoring, Sanitisation, and Version History

1. Select **New article** (`/admin/knowledge/new`) or open an existing article (`/admin/knowledge/articles/:publicId`).
2. Choose **Audience**:
   - **Customers (`customers`)**: Visible to signed-in customers and staff once published, and exposed via Public API v1 (`knowledge:read`) when `feature.knowledge` is enabled.
   - **Staff internal (`staff`)**: Visible only to signed-in `staff` and `admin` principals; never returned to customers or Public API v1 callers.
3. Author rich content using allow-listed semantic HTML (`h2`, `h3`, `h4`, `p`, `ul`, `ol`, `li`, `blockquote`, `pre`, `code`, `strong`, `em`, `a`, `hr`, `table`). Unsafe tags (`<script>`, `<iframe>`, `<object>`, `<form>`), inline event handlers, inline styles, and `javascript:`/`data:` URLs are rejected fail-closed on write. Customer and preview pages render a structured AST without `dangerouslySetInnerHTML`.
4. Every save records an immutable snapshot in `knowledge_article_versions` with an optional change note. Use **Version history → Restore** to create a new revision from any prior snapshot (audited as `knowledge.article.version_restored`).

## Attachments

- Upload supporting files from the article editor (`POST /api/knowledge/articles/:publicId/attachments`). Every upload passes through `files.stageUpload` (magic-byte sniffing, extension policy, size cap, and optional malware scanning).
- Downloads issue a 60-second, single-use ticket bound to the caller's user and session (`GET /api/knowledge/attachments/download/:ticket`) served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.

## Search Insights, Feedback, and Retention

- **Search insights**: Aggregated search counts and zero-result queries are stored in `knowledge_search_logs` after stripping e-mail addresses, ULIDs, and long digit sequences, with no user, session, or IP identifier attached.
- **Helpful feedback**: Customers can mark published articles helpful (`Yes` / `No`). Optional notes are encrypted at rest (`AES-256-GCM`) and decrypted only in `/admin/knowledge` insights.
- **Retention**: Background job `knowledge.retention` runs hourly to purge expired download tickets, aged view-deduplication buckets, and search logs older than `searchLogRetentionDays`.
