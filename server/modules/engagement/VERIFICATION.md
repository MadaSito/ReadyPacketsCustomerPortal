# Engagement Module — Verification & Evidence Report (`v1.0.0`)

Owner paths: `server/modules/engagement/**`, `client/src/features/engagement/**`

---

## 1. Implemented Scope

### 1.1 Server (`server/modules/engagement/**`)
- **Schema (`schema.ts`)**: 9 MySQL 8 / Drizzle tables — `engagement_order_messages`, `engagement_order_message_attachments`, `engagement_order_message_reads`, `engagement_support_tickets`, `engagement_support_ticket_messages`, `engagement_support_ticket_history`, `engagement_notifications`, `engagement_notification_preferences`, `engagement_search_tokens` (including composite `(domain, customer_visible, token_hash, record_id)` index).
- **Order Messages (`messagesService.ts`)**:
  - One thread per order; enforces `orders.assertCanReadOrder` / `orders.assertCanWriteOrder` (both pre-tx preflight and in-tx `{ tx }`), contributor write vs. viewer read-only (`GRANT_READ_ONLY`), lock states (`archived`, `cancelled`, `legal_hold` → `ORDER_LOCKED_FOR_MESSAGING`), attachment ownership + non-`staff_only` check via `files.assertCanReadFile`, per-user read receipts (`engagement_order_message_reads`), staff internal notes (`visibility = "internal"`), AES-256-GCM envelope encryption (`body_enc`) with row-bound AAD, HMAC-SHA256 blind-index search tokens, idempotency (`(order_id, author_user_id, idempotency_key)`), and content-free notification mail (`engagement.message_received`).
- **Support Tickets (`ticketsService.ts`)**:
  - Full lifecycle (`open`, `pending_customer`, `pending_staff`, `resolved`, `closed`), optional related-order binding (`orders.assertCanReadOrder`), human-readable `TKT-YYYYMMDD-XXXXXX` reference + opaque ULID `publicId`, customer reply/close/reopen (with `engagement.tickets.reopen_window_days` enforcement and `closed` finality), staff triage (`admin.queue`, `admin.get`, `admin.reply` with `internalOnly`, `admin.setStatus`, `admin.assign`, `admin.setPriority`), paginated replies (`replyCursor`, `replyLimit` default 50 / max 100, `repliesNextCursor`), bounded `statusHistory` (latest 100 transitions + `statusHistoryHasMore`), customer metadata isolation on `internalOnly` notes and `admin.assign` (`updatedAt` / `lastMessageAt` unchanged), and content-free mail (`engagement.ticket_updated`).
- **Notifications & Preferences (`notificationsService.ts`)**:
  - Cross-module `services.engagement.notifications.notify(event, tx?)` contract with safe link sanitization, ULID + idempotency deduplication, AES-256-GCM encrypted title/body, per-category `(inApp, email)` preferences (`orders`, `messages`, `tickets`, `files`, `account`, `security`), non-suppressible `security` category (`PREFERENCE_LOCKED`), `markRead`, and `markAllRead`.
- **Bounded Global Search (`searchService.ts`)**:
  - Single `engagement.search.query` endpoint returning `{ orders, tickets, messages, files, partial, budgetMs }` under `engagement.search.timeout_ms`.
  - Scoped anti-starvation SQL: `engagement_search_tokens` is `INNER JOIN`ed directly against principal-scoped `engagement_support_tickets` / `engagement_order_messages` before `ORDER BY` and `LIMIT`, so high-volume cross-tenant token hits cannot starve an authorized caller's results.
  - Sargable uppercase-normalized prefix `LIKE ... ESCAPE '!'` (no `UPPER(...)` or `COALESCE(...)` column wrapping), bucketed literal MySQL 8 `/*+ MAX_EXECUTION_TIME(...) */` hints, and `runWithinBudget` soft-deadline wrapper setting `partial: true` on budget exhaustion.
- **Portability, DSAR & Retention (`portableService.ts`)**:
  - `exportForSubject` (decrypted user-authored messages, tickets + non-internal replies, notifications, preferences), `eraseForSubject` (pseudonymizes closed-ticket content + clears search tokens while skipping active/legal-hold records), `purgeExpired` (acquires `FOR UPDATE` row locks, re-checks `compliance.hasActiveHold` inside the transaction, records durable `engagement.retention.purged` audit event *before* deleting expired closed tickets), and workspace `exportBundle` / `importBundle` with dry-run plan and deterministic ULID idempotency.

### 1.2 Client (`client/src/features/engagement/**`)
- **Shell Exports (`shell.tsx`)**: `NotificationBellPopover` (accessible `Drawer` trigger button with unread count badge, mark-read / mark-all-read actions) and `GlobalSearchBox` (navigates to `/search?q=...` without `window.location`).
- **Order Detail Embed (`OrderMessagesTab.tsx`)**: Embedded order thread with plain-text JSX rendering, lock banner, attachment chips, read-receipt indicators, staff internal-note toggle, and keyboard shortcut (`Ctrl/Cmd+Enter`).
- **Customer Pages (`pages/`)**: `CustomerMessagesPage` (`/messages`), `SupportTicketsPage` (`/support`), `NewSupportTicketPage` (`/support/new`), `SupportTicketDetailPage` (`/support/:ticketId` with `"Load newer replies"` pagination, close confirmation `Modal`, and reopen form), `NotificationsPage` (`/notifications` with feed + per-category preference switches and locked `security` row), `SearchPage` (`/search` with grouped domain cards and partial-timeout `Banner`).
- **Staff / Admin Console Pages (`pages/` & `widgets/`)**: `AdminTicketsPage` (`/admin/tickets`), `AdminTicketDetailPage` (`/admin/tickets/:ticketId`), `AdminMessagesPage` (`/admin/messages`), `CustomerEngagementWidget`, `ConsoleQueueWidget`, and `routes.tsx` (`engagementCustomerRoutes`, `engagementConsoleRoutes`).

---

## 2. Automated Verification Evidence

Executed via sandbox scripts (`source scripts/dev/env.sh`):

1. **Typecheck**:
   - Command: `scripts/dev/tc.sh 'server/modules/engagement|client/src/features/engagement'`
   - Result: `typecheck: no diagnostics matching 'server/modules/engagement|client/src/features/engagement'` (0 errors across server + client).
2. **Lint & Design-System Token Audit**:
   - Command: `scripts/dev/lint.sh server/modules/engagement client/src/features/engagement`
   - Result: 0 errors, 0 warnings (verified no `sql.raw`, no browser storage APIs, no raw hex/palette classes, no `dangerouslySetInnerHTML`, React 19 hooks rules clean).
3. **Integration & Accessibility Tests**:
   - Command: `scripts/dev/test.sh server/modules/engagement/engagement.test.ts` and `scripts/dev/test.sh client/src/features/engagement/engagement.test.tsx`
   - Result: **2 test files passed, 17/17 tests passed**:
     - `server/modules/engagement/engagement.test.ts` (**12 tests against real MySQL 8**):
       1. Order messages: owner, contributor write, viewer read-only (`GRANT_READ_ONLY`), grant revocation, staff internal notes invisible to customers, unread counts & read receipts, idempotency.
       2. Negative authz & lock enforcement: cross-tenant `NOT_FOUND` + `authz.engagement.denied` audit, customer internal-note rejection, `staff_only` attachment rejection, `archived`/`cancelled`/`legal_hold` lock enforcement (`ORDER_LOCKED_FOR_MESSAGING`).
       3. XSS & content-free mail: `<script>`/`<img onerror>` round-trip verbatim without HTML mutation; notification mail omits body/subject content.
       4. Support ticket lifecycle: create with order binding, cross-tenant `get`/`reply`/`close`/`reopen` `NOT_FOUND` + `authz.engagement.denied` (`>= 4` durable security audit events), staff assign (verifying ascending `users.id` lock order), priority, internal note isolation, customer/staff status transitions, reopen window expiration (`TICKET_REOPEN_EXPIRED`), and `closed` finality (`TICKET_CLOSED`).
       5. Notifications & preferences: `notify()` persistence, preference suppression for non-security categories, non-suppressible `security` alerts (`PREFERENCE_LOCKED`), `markRead` & `markAllRead`.
       6. Bounded search: multi-domain HMAC blind-index matching, internal-note invisibility to customers, cross-tenant isolation, slow peer timeout → `partial: true`.
       7. Portability, DSAR & retention: `exportForSubject` excludes staff internal notes, `purgeExpired` respects `compliance.hasActiveHold` under `FOR UPDATE` lock and records pre-delete audit event when hold lifts, `eraseForSubject` pseudonymizes closed tickets while preserving open tickets, `exportBundle`/`importBundle` dry-run + idempotent apply.
       8. Unverified MFA step-up session rejection (`MFA_STEP_UP_REQUIRED`) and in-transaction revoked/suspended actor rejection.
       9. Cross-tenant search anti-starvation: 120 matching tokens from another tenant do not starve an authorized user's single matching ticket/message; lowercase reference prefix query matches uppercase-normalized references.
       10. Ticket detail pagination & internal-note metadata isolation: 65 replies paginate cleanly (`50` + `15` via `repliesNextCursor`), `internalOnly` notes do not leak to customer pages, and `internalOnly` replies + `admin.assign` leave customer-visible `updatedAt` and `lastMessageAt` unchanged.
     - `client/src/features/engagement/engagement.test.tsx` (**5 client test suites with `axe-core` WCAG checks**):
       1. Shell `NotificationBellPopover` + `GlobalSearchBox`: unread count badge, accessible `Drawer` open/mark-read/mark-all-read, `/search?q=...` navigation, zero `axe` violations.
       2. `OrderMessagesTab`: renders `<script>alert("xss")</script>` strictly as inert text (`container.querySelector("script") === null`), sends message with idempotency key, zero `axe` violations.
       3. All 6 customer pages (`/messages`, `/support`, `/support/new`, `/support/:ticketId` including `"Load newer replies"` cursor pagination + close modal, `/notifications`, `/search` with `partial: true` banner) — interactive flows + zero `axe` violations on every page.
       4. All 3 staff/admin pages (`/admin/tickets`, `/admin/tickets/:ticketId` internal notes + triage controls, `/admin/messages`) + both dashboard widgets (`CustomerEngagementWidget`, `ConsoleQueueWidget`) — interactive flows + zero `axe` violations on every surface.
       5. Honest loading/error/empty states across list/detail pages & widgets (`SupportTicketsPage`, `CustomerMessagesPage`, `NotificationsPage`, `AdminTicketsPage`, `SupportTicketDetailPage`, `CustomerEngagementWidget`): verifies `EmptyState` never renders during pending or failed queries, failed queries render `@/ui` `ErrorState` (`safeMessage`, `Reference: <requestId>`, and `Try again` retry button) with zero `axe` violations, and `EmptyState` renders only after a successful empty response.

---

## 3. What Is Not Verified

- **Live browser / multi-viewport visual rendering**: Per `docs/engineering/BUILD_CONTRACT.md` (shared 2-core / 7 GB sandbox rules), neither Vite dev servers nor headless browsers were launched. Responsive behavior (`320px–1920px`) relies on `@/ui` primitives (`DataTable` mobile card fallback, `PageHeader`, `SplitPane`, `Drawer`, `Modal`) and semantic Tailwind 4 layout classes rather than live Chromium screenshot inspection.
- **Full end-to-end app router mount**: Route descriptors (`engagementCustomerRoutes`, `engagementConsoleRoutes`), shell components (`NotificationBellPopover`, `GlobalSearchBox`), and `OrderMessagesTab` are exported and verified in isolated `Router` + `UiProvider` + mocked `trpc` tests; final top-level `App.tsx` composition is owned by `/root/ui_foundation_engineer` and `/root/orders_engineer`.
