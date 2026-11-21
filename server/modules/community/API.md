# Community forum — API (package M, increment 04)

Owner: audit_engineer. Status: ports published first; the implementation follows in this folder.

Decision 7 applies: the forum is **off by default**. Members post under a display name they choose, never an
e-mail address or legal name. Posts are rate-limited, can be reported and are moderated (hide, lock, pin,
remove), with an audit trail. Community pages are `noindex`.

## Exports (for /root to mount)

| Where | Export |
|---|---|
| `server/modules/community/index.ts` | `createCommunityModule(deps): CommunityModule`, `type CommunityModule` → `services.community` |
| `server/modules/community/router.ts` | `communityRouter` → `appRouter.community` |
| `server/modules/community/schema.ts` | `communityProfiles`, `communityCategories`, `communityTopics`, `communityPosts`, `communityReactions`, `communitySubscriptions`, `communityReports`, `communityModerationLog` |
| `client/src/features/community/index.ts` | `communityFeature` (registry) |

## Enable switch

- `COMMUNITY_FLAG = defineFeatureFlag({ flag: "community", owner: "community", clientVisible: true })`, stored as `feature.community`, default `false`.
  - On the client, `features.enabled("community")` hides the navigation. Nav entries: customer "Community" `/community` (group "Support", order 110); console "Community moderation" `/admin/community` and "Community settings" `/admin/community/settings`. All have `enabledBy: "community"`.
- `COMMUNITY_CONFIG = defineSetting({ key: "community.config", managedBy: { href: "/admin/community" } })`. Defaults:
  `{ editWindowMinutes: 30, newMemberDays: 7, newMemberDailyPosts: 5, newMemberReviewPosts: 2, maxPostsPerHour: 20, autoHideReportCount: 3, blockedWords: [], heldWords: [] }`.
  - Word lists hold at most 200 entries of at most 40 characters each.
  - Matching is whole-word, case-folded and linear-time. No user-supplied regular expressions.
- When the flag is off, every `community.*` procedure except `community.status` and `community.admin.*` returns `NOT_FOUND`. The client routes render the not-found page.

## Server port (`services.community`)

```ts
interface CommunityModule {
  /** Cheap read used by the shell and other modules. */
  enabled(tx?: Tx): Promise<boolean>;
  /** For identity's account-deletion / anonymisation flow: detaches the display name and keeps the posts as "Former member". */
  anonymiseMember(userId: number, tx: Tx): Promise<void>;
}
```

No other module writes community tables.

## Content format

Post bodies use a constrained plain-text format. They are not HTML.

- Supported: paragraphs (blank line), `> ` quotes, `- ` lists, inline `` `code` ``, and auto-linked `https://` URLs.
- On write, the body is normalised: NFC, control characters stripped except `\n`, CRLF converted to LF, 1–10 000 characters.
- The client parses the stored text into a block/inline tree and renders React elements. There is no `dangerouslySetInnerHTML`.
- Links render with `rel="noopener noreferrer nofollow ugc"`. Only `https:` URLs without credentials become links; everything else stays text.
- The text is stored verbatim after normalisation, so escaping happens at render time.
- This is a deliberate deviation from "mail-template sanitiser": it is stricter (no markup at all), so there is no HTML attack surface.
- The server normalises and validates in `server/modules/community/text.ts`. The client parses and renders in `client/src/features/community/text.ts`.

## Procedures (`trpc.community.*`)

- All ids are public ids (ULID). Lists are cursor-paginated (limit ≤ 50). All inputs are Zod-validated with length limits.
- Roles: M = any signed-in user with a community profile (customer, staff, admin); S = `community.moderate`; A = `community.manage` (+ step-up for `setEnabled`).

| Procedure | Who | Notes |
|---|---|---|
| `status` (query) | signed-in | `{ enabled, profile: { displayName, publicId } \| null, suspendedUntil, canModerate }` |
| `profile.save` (mutation) | signed-in | `{ displayName }`: 3–32 chars, letters/digits/space/`._-`, not e-mail-like, not reserved, unique case-insensitive |
| `categories.list` | M | ordered; archived categories are included with `archived: true` (read-only) |
| `topics.list` | M | `{ categoryPublicId?, cursor?, limit? }`, pinned first |
| `topics.get` | M | topic + paged posts; hidden/removed posts show a placeholder (moderators see the body) |
| `topics.create` | M | `{ categoryPublicId, title (5–140), body, idempotencyKey }` |
| `posts.reply` | M | `{ topicPublicId, body, quotePostPublicId?, idempotencyKey }`; refused when locked or archived |
| `posts.edit` | M (author) | `{ postPublicId, body, title?, expectedVersion }`; within the edit window; re-moderated (held words, new-member link threshold) |
| `posts.delete` | M (author) | soft delete |
| `posts.react` | M | `{ postId, helpful: boolean }`; not your own post |
| `posts.report` | M | `{ postId, reason: spam\|abuse\|off_topic\|personal_info\|other, note? (≤500) }`; one open report per member per post |
| `subscriptions.set` | M | `{ topicId, subscribed }` |
| `search` | M | `{ q (2–100), cursor? }`; LIKE with escaped wildcards, published posts only |
| `mod.queue` | S | pending posts + open reports |
| `mod.reports.resolve` | S | `{ reportPublicId, outcome: dismissed\|actioned, note? }` |
| `mod.post` | S | `{ postId, action: approve\|hide\|unhide\|remove, reason? }` |
| `mod.topic` | S | `{ topicId, action: lock\|unlock\|pin\|unpin\|move, categoryId? }` |
| `mod.suspend` / `mod.unsuspend` | S | `{ memberPublicId, days 1–365 \| null (indefinite), reason }`; staff cannot suspend staff/admin |
| `mod.log` | S | moderation log, paginated |
| `admin.settings.get` / `admin.settings.update` | A | `COMMUNITY_CONFIG` (whole object; last writer wins, audited with changed field names) |
| `admin.setEnabled` | A + step-up | audited |
| `admin.categories.create` / `update` / `reorder` | A | archive through `update { archived }`; `reorder` takes the full ordered public-id list (non-drag alternative) |

## Archived categories

Archived means read-only. Archived categories still appear in `categories.list` (flagged), in topic lists, in search and through direct links. `topics.create`, `posts.reply` and `posts.edit` are refused with `CONFLICT COMMUNITY_CATEGORY_ARCHIVED`, and no topic can be moved into an archived category. Moderators can still hide or remove content.

## Abuse controls

- New members (account younger than `newMemberDays`) are limited to `newMemberDailyPosts` per day. Their first `newMemberReviewPosts` posts are held for review.
- `maxPostsPerHour` applies to everyone. Exceeding a limit returns `RATE_LIMITED`.
- Blocked words refuse the post with a validation error. Held words send it to the queue.
- Posts containing more than 3 links from new members are held.
- Identical body re-posted within 10 minutes is refused (duplicate hash).
- `autoHideReportCount` distinct reporters hide a post pending review.

## Audit events

- Events: `community.enabled.changed`, `community.settings.updated`, `community.category.changed`, `community.topic.created`, `community.post.created`, `community.post.edited`, `community.post.deleted`, `community.post.reported`, `community.moderation.action`, `community.member.suspended`, `community.member.unsuspended`, `community.profile.saved`.
- Attributes carry ids, states, reasons and counts only. They never include bodies, titles, display names or report notes.

## Automation trigger catalogue

- `community.post_reported` (`community.post.reported`), recipients STAFF.
- `community.topic_created` (`community.topic.created`), recipients STAFF.

## Notifications

- Replies notify topic subscribers through `services.engagement.notify`: kind `community.reply`, link `/community/t/<topicPublicId>`, title/body generic (no post text).
- Capped at 100 subscribers per reply. Not sent to the author.
