# Engagement module — API (v1)

Owner: `engagement_engineer`  
Paths: `server/modules/engagement/**`, `client/src/features/engagement/**`  
Instance: `deps.services.engagement` (dereference inside methods or `init()`, never during factory construction).  
Types: import from `server/modules/engagement/index.js`.

---

## 1. Public Service Interface (`EngagementModule`)

### 1.1 In-app & templated notifications (`notify`)

Used by all business and security modules (`identity`, `assurance`, `orders`, `files`, `compliance`, `portable`, `backup`, etc.).

```ts
export interface NotifyInput {
  /** Internal numeric recipient user ID (`users.id`). */
  userId: number;
  /**
   * Dotted lowercase notification kind, e.g.:
   *   `security.credential_changed`, `security.mfa_reset`, `security.recovery_code_used`,
   *   `order.status_changed`, `order.share_invited`,
   *   `message.received`, `ticket.created`, `ticket.updated`,
   *   `file.uploaded`, `invoice.issued`, `compliance.policy_updated`
   * Must match `/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/` (max 64 chars).
   */
  kind: string;
  /** Fixed-template safe plain-text title (NFC normalized, 1..160 chars). Never pass secrets or raw user bodies. */
  title: string;
  /** Fixed-template safe plain-text summary (NFC normalized, 1..500 chars). Never pass secrets or raw user bodies. */
  body: string;
  /** Optional relative in-app path starting with `/` (never `//` or scheme URLs, max 255 chars), e.g. `/orders/01J...`. */
  link?: string | null;
  /** Optional idempotency key (max 128 chars); duplicate keys per user return the existing notification. */
  idempotencyKey?: string;
  /**
   * When true, suppresses generic notification email enqueue even if the user enabled email for this kind
   * (use when the calling module already enqueues a dedicated domain mail template).
   */
  skipEmail?: boolean;
}

export interface NotifyResult {
  publicId: string;
  deliveredInApp: boolean;
  enqueuedEmail: boolean;
}
```

```ts
export interface EngagementModule extends ModuleLifecycle {
  /**
   * Persists an in-app notification (respecting per-category user preferences, except `security.*`
   * which is always delivered in-app) and optionally enqueues the secret-free `engagement.notification`
   * email template inside `tx` when provided.
   */
  notify(input: NotifyInput, tx?: Tx): Promise<NotifyResult>;

  /** Portable export collector for customer-visible order messages (internal staff notes are never exported). */
  portableOrderMessages(
    tx: DbOrTx,
    input: { orderPublicIds: readonly string[]; afterPublicId?: string | null; limit: number },
  ): Promise<{ items: PortableOrderMessageItem[]; nextAfter: string | null }>;

  /** Convenience alias matching portable_ops_engineer's narrow evidence signature. */
  portableEvidence(
    tx: DbOrTx,
    orderIds: readonly string[],
    after: string | null,
    limit: number,
  ): Promise<{ items: PortableOrderMessageItem[]; nextAfter: string | null }>;

  /** Portable export collector for support tickets and customer-visible replies/history (internal notes excluded). */
  portableTickets(
    tx: DbOrTx,
    input: {
      customerUserIds?: readonly number[];
      orderPublicIds?: readonly string[];
      afterPublicId?: string | null;
      limit: number;
    },
  ): Promise<{ items: PortableTicketItem[]; nextAfter: string | null }>;

  /** Idempotent portable import for historical order messages (no mail/notification replay; audited in tx). */
  importOrderMessage(input: ImportOrderMessageInput, tx: Tx): Promise<{ publicId: string; created: boolean }>;

  /** Idempotent portable import for historical support tickets (no mail/notification replay; audited in tx). */
  importTicket(input: ImportTicketInput, tx: Tx): Promise<{ publicId: string; ticketNumber: string; created: boolean }>;
}
```

### 1.2 Cross-module dependencies consumed by `engagement`

- `services.orders.assertCanReadOrder(principal, orderPublicId, options?)` — checked on every order message list, thread read, mark-read, attachment check, ticket order link, and search result row.
- `services.orders.assertCanWriteOrder(principal, orderPublicId, { kind: "message", tx })` — checked on every order message post (enforces owner/contributor/staff capability and lock states `review`, `finalized`, `legal_hold`, `imported_read_only`).
- `services.orders.listAccessibleOrderIds(principal, options?)` and `services.orders.getOrderSummary(principal, orderPublicId)` / `getOrderRefById(orderId, tx?)` — thread listing & order references.
- `services.orders.searchOrders(principal, query, limit)` — narrow order search provider for bounded search.
- `services.files.assertCanReadFile(principal, filePublicId, orderPublicId)` — validates every attachment reference bound to the target order when posting or reading order messages.
- `services.identity.getUser(userId)` / `getUserByPublicId(publicId)` — resolves recipient status and safe author display labels.
- `services.identity.searchCustomers(principal, { query, limit })` — narrow customer search provider when caller holds `search.global` + `customers.read_all`.

---

## 2. tRPC Procedures (`trpc.engagement.*`)

All inputs use `z.strictObject` with explicit bounds and NFC normalization. All resource IDs in inputs/outputs are ULID `publicId` strings (never numeric IDs). Plain text only — never HTML.

### 2.1 Order Messages (`trpc.engagement.messages.*`)

| Procedure | Guard | Description |
| --- | --- | --- |
| `messages.listByOrder` | `protectedProcedure` | `{ orderId, cursor?, limit? }` → paginated messages on an order (`assertCanReadOrder`). Customers receive only `visibility: "customer"`; staff/admin with `messages.read_all` also see `visibility: "internal"`. |
| `messages.threads` | `protectedProcedure` | `{ unreadOnly?, cursor?, limit? }` → customer's accessible order threads with latest message metadata + unread count. |
| `messages.unreadSummary` | `protectedProcedure` | `{ orderId? }` → `{ totalUnread, byOrder?: Record<string, number> }` re-authorized against current order access. |
| `messages.send` | `protectedProcedure` (`form_submission`) | `{ orderId, body (1..4000 NFC), visibility?: "customer" \| "internal", attachmentFileIds?: string[] (0..10), idempotencyKey }` → checks `assertCanWriteOrder(kind: "message")`; `"internal"` allowed for staff/admin only; attachments verified via `files.assertCanReadFile(principal, fileId, orderId)`; enqueues content-free email `engagement.order_message_received`. |
| `messages.markOrderRead` | `protectedProcedure` | `{ orderId, upToMessageId? }` → marks visible messages on `orderId` read for caller after `assertCanReadOrder`. |
| `messages.markAllRead` | `protectedProcedure` | `{}` → marks unread messages across currently accessible orders read for caller. |
| `messages.adminInbox` | `staffProcedure` + `messages.read_all` | `{ unreadOnly?, orderId?, visibility?, cursor?, limit? }` → staff/admin message inbox across orders. |

### 2.2 Support Tickets (`trpc.engagement.tickets.*`)

Statuses: `"open" | "pending_customer" | "pending_staff" | "resolved" | "closed"`  
Priorities: `"low" | "normal" | "high" | "urgent"`  
Categories: `"general" | "order" | "billing" | "technical" | "deliverable" | "account"`

| Procedure | Guard | Description |
| --- | --- | --- |
| `tickets.list` | `protectedProcedure` | `{ status?, cursor?, limit? }` → caller's own tickets only (`requesterUserId === session.userId`). |
| `tickets.get` | `protectedProcedure` | `{ ticketId, replyCursor?, replyLimit? (1..100, default 50) }` → ticket detail, paginated customer-visible replies (`internalOnly: false`, `repliesNextCursor`), and bounded status history (latest 100 entries, `statusHistoryHasMore`). Other customers' tickets → `NOT_FOUND`. |
| `tickets.openSummary` | `protectedProcedure` | `{}` → `{ openCount, awaitingCustomerCount }` for dashboard widget. |
| `tickets.create` | `protectedProcedure` (`form_submission`) | `{ subject (5..190), category, body (10..8000), relatedOrderId?, idempotencyKey }` → validates `assertCanReadOrder` if `relatedOrderId` supplied; creates ticket + initial message + history + audit `ticket.created`. |
| `tickets.reply` | `protectedProcedure` (`form_submission`) | `{ ticketId, body (1..8000), idempotencyKey }` → customer reply on own ticket; transitions `pending_customer` / `resolved` (within reopen window) → `pending_staff`; `closed` refuses (`CONFLICT / TICKET_CLOSED`). |
| `tickets.close` | `protectedProcedure` | `{ ticketId }` → customer closes own ticket; records status history + audit `ticket.status.changed`. |
| `tickets.reopen` | `protectedProcedure` | `{ ticketId, reason (3..500) }` → customer reopens `resolved` ticket within configured reopen window (`engagement.tickets.reopen_window_days`, default 14 days); `closed` tickets cannot be reopened by customer (`CONFLICT / TICKET_REOPEN_DENIED`). |
| `tickets.admin.list` | `staffProcedure` + `tickets.read_all` | `{ status?, priority?, category?, assignedToMe?, unassignedOnly?, customerId?, cursor?, limit? }` → console queue. |
| `tickets.admin.get` | `staffProcedure` + `tickets.read_all` | `{ ticketId, replyCursor?, replyLimit? (1..100, default 50) }` → full detail including paginated `internalOnly` notes (`repliesNextCursor`), assignment, and bounded status history (`statusHistoryHasMore`). |
| `tickets.admin.reply` | `staffProcedure` + `tickets.manage` | `{ ticketId, body (1..8000), internalOnly?: boolean, nextStatus?, idempotencyKey }` → staff reply or internal note (`internalOnly: true` never notifies customer, never changes status unless specified, and never advances customer-visible `updatedAt` / `lastMessageAt`). |
| `tickets.admin.setStatus` | `staffProcedure` + `tickets.manage` | `{ ticketId, toStatus, reasonCode? }` → controlled transition + history + audit `ticket.status.changed`. |
| `tickets.admin.assign` | `staffProcedure` + `tickets.manage` | `{ ticketId, assigneeUserId: string \| null }` → assigns to active staff/admin user + audit `ticket.assigned`. |
| `tickets.admin.setPriority` | `staffProcedure` + `tickets.manage` | `{ ticketId, priority }` → updates priority + audit `ticket.priority.changed`. |

### 2.3 Notifications (`trpc.engagement.notifications.*`)

| Procedure | Guard | Description |
| --- | --- | --- |
| `notifications.list` | `protectedProcedure` | `{ unreadOnly?, cursor?, limit? }` → caller's notifications (newest first, bounded cursor). |
| `notifications.unreadCount` | `protectedProcedure` | `{}` → `{ unreadCount: number }` for shell notification bell. |
| `notifications.markRead` | `protectedProcedure` | `{ notificationId }` → marks caller's notification read (`NOT_FOUND` if other user's). |
| `notifications.markAllRead` | `protectedProcedure` | `{}` → marks all unread notifications for caller read. |
| `notifications.preferences.get` | `protectedProcedure` | `{}` → per-category preferences (`security`, `order`, `message`, `ticket`, `file`, `invoice`, `compliance`, `system`) with `{ inApp, email, inAppLocked }`. |
| `notifications.preferences.update` | `protectedProcedure` | `{ category, inApp, email }` → updates caller's preference (`security` keeps `inApp: true`); audited `notification.preferences.updated`. |

### 2.4 Bounded Search (`trpc.engagement.search.*`)

| Procedure | Guard | Description |
| --- | --- | --- |
| `search.query` | `protectedProcedure` (`expensive`) | `{ query (2..64 NFC), domains?: ("orders" \| "tickets" \| "messages" \| "customers")[], limitPerDomain? (1..10, default 5) }` → searches sargable reference prefixes + tenant-scoped HMAC token blind-indexes within a configured budget (MySQL 8 `MAX_EXECUTION_TIME` hints + soft JS deadline for peer calls), re-authorizes every candidate row before returning, never acts as an existence oracle, and audits staff/admin global searches (`engagement.search.executed`). `"customers"` domain is returned only when caller holds `search.global` + `customers.read_all`. |

---

## 3. UI Exports for Shell Coordination (`client/src/features/engagement/shell.ts`)

For `ui_foundation_engineer` (shell header bell & global search input) without cross-feature coupling:
- `useNotificationBellData()` → `{ unreadCount, items, isLoading, markRead, markAllRead }`
- `NotificationBellPopover` → accessible bell button + popover panel + link to `/notifications`
- `useBoundedSearch(query, options?)` → debounced bounded search hook calling `trpc.engagement.search.query`

Routes registered in `engagementFeature`:
- Customer: `/messages`, `/support`, `/support/new`, `/support/:ticketId`, `/notifications`, `/search`
- Console: `/admin/messages` (`messages.read_all`), `/admin/tickets` (`tickets.read_all`), `/admin/tickets/:ticketId` (`tickets.read_all`)
- `orderTabs`: `{ key: "messages", label: "Messages", badge: OrderMessagesUnreadBadge }`
- `widgets`: Customer (`engagement.customer_overview`: unread messages + open tickets), Console (`engagement.console_queue`: unassigned/open tickets + unread customer messages)

---

## 4. Raw HTTP Routes

None (`registerEngagementHttpRoutes` is a no-op; attachments use `files` module upload/download endpoints).

---

## 5. Mail Templates, Jobs, Settings, Audit Events, Health

### Mail Templates (never include message/ticket bodies or sensitive content)
- `engagement.order_message_received` — vars: `["orderReference", "link"]`
- `engagement.ticket_updated` — vars: `["ticketNumber", "eventLabel", "link"]`
- `engagement.notification` — vars: `["title", "link"]`

### Scheduled Jobs
- `engagement.notifications.retention` (daily) — purges notifications older than `engagement.notifications.retention_days` (default 90 days, range 7..365).

### Declared Settings (`group: "engagement"`)
- `engagement.notifications.retention_days` — int `7..365`, default `90`, `internal`
- `engagement.notifications.email_enabled` — boolean, default `false`, `internal` (master switch for engagement notification emails; off until SMTP configured & enabled)
- `engagement.tickets.reopen_window_days` — int `1..90`, default `14`, `internal`
- `engagement.search.time_budget_ms` — int `100..5000`, default `1500`, `internal`

### Audit Events
- `engagement.message.sent` (`business`) — attributes: `{ orderPublicId, visibility, attachmentCount }`
- `engagement.message.imported` (`portable_transfer`)
- `engagement.ticket.created` (`business`) — attributes: `{ ticketNumber, category, hasRelatedOrder }`
- `engagement.ticket.replied` (`business`) — attributes: `{ ticketNumber, internalOnly, actorRole }`
- `engagement.ticket.status.changed` (`business`) — attributes: `{ ticketNumber, fromStatus, toStatus }`
- `engagement.ticket.assigned` (`admin`) — attributes: `{ ticketNumber, assigneePublicId }`
- `engagement.ticket.priority.changed` (`admin`) — attributes: `{ ticketNumber, fromPriority, toPriority }`
- `engagement.ticket.imported` (`portable_transfer`)
- `engagement.notification.preferences.updated` (`business`) — attributes: `{ category, inApp, email }`
- `engagement.notifications.retention.purged` (`job`) — `safeCounts: { deleted }`
- `engagement.search.executed` (`admin` / `security`) — recorded for staff/admin global searches (`safeCounts: { orders, tickets, messages, customers }`, `durationMs`, never logs query text!)
- `authz.engagement.denied` (`security`, outcome `denied`) — cross-tenant / unauthorized attempts

### Health
- `engagement.notifications` — `ok` with metrics `{ unreadTotal }`
