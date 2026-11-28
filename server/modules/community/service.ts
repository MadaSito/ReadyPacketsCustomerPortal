/**
 * Community forum — service. Owner: audit_engineer (package M).
 *
 * Zero-trust rules applied on every call:
 *  - the feature flag is read inside the transaction; when off, member procedures fail as NOT_FOUND;
 *  - the actor is re-validated in-transaction (`identity.sessions.assertCurrent`) and the role returned by
 *    identity (not the cached principal) decides moderation rights;
 *  - all lookups are by public id; topics/posts the caller may not see are indistinguishable from missing ones;
 *  - every state change writes an audit record in the same transaction (fail closed) without bodies or names.
 */
import { and, asc, count, desc, eq, gte, inArray, like, lt, or, sql, type SQL } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { UserRole } from "../../../shared/domain.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import type { AuditEventInput, SessionPrincipal, Tx } from "../../core/types.js";
import { isLiveUserRow, liveUserPredicate } from "../identity/live.js";
import { users } from "../identity/schema.js";
import { isFlagEnabled, readSetting, writeSetting } from "../platform/index.js";
import { DELETED_ACCOUNT_LABEL, DELETED_TOPIC_TITLE } from "./trash.js";
import {
  communityCategories,
  communityModerationLog,
  communityPosts,
  communityProfiles,
  communityReactions,
  communityReports,
  communitySubscriptions,
  communityTopics,
  type CommunityCategoryRow,
  type CommunityPostRow,
  type CommunityProfileRow,
  type CommunityTopicRow,
  type ModerationAction,
  type PostState,
  type ReportReason,
} from "./schema.js";
import { COMMUNITY_CONFIG, COMMUNITY_FLAG, communityConfigSchema, type CommunityConfig } from "./settings.js";
import { bodyHash, cleanLine, countLinks, matchWordList, normaliseBody, normaliseTitle, validateDisplayName } from "./text.js";

export const PAGE_LIMIT = 50;
export const MAX_OFFSET = 5_000;
export const NOTIFY_CAP = 100;
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
export const NEW_MEMBER_MAX_LINKS = 3;
const FORMER_MEMBER = "Former member";

/* ------------------------------------------------------------------ views */

export interface CommunityStatusView {
  enabled: boolean;
  profile: { publicId: string; displayName: string } | null;
  suspended: boolean;
  suspendedUntil: string | null;
  canModerate: boolean;
  canManage: boolean;
}
export interface CategoryView {
  publicId: string;
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
  staffOnlyPosting: boolean;
  archived: boolean;
  topicCount: number;
  version: number;
}
export interface AuthorView {
  publicId: string | null;
  displayName: string;
  staff: boolean;
}
export interface TopicSummaryView {
  publicId: string;
  categoryPublicId: string;
  title: string;
  author: AuthorView;
  pinned: boolean;
  locked: boolean;
  state: CommunityTopicRow["state"];
  visible: boolean;
  replyCount: number;
  lastPostAt: string;
  createdAt: string;
}
export interface PostView {
  publicId: string;
  author: AuthorView;
  isOpening: boolean;
  /** Null when the caller may not read it (hidden/removed/deleted for non-moderators). */
  body: string | null;
  state: PostState;
  quote: { publicId: string; author: string; excerpt: string | null } | null;
  createdAt: string;
  editedAt: string | null;
  helpfulCount: number;
  reactedByMe: boolean;
  mine: boolean;
  canEdit: boolean;
  version: number;
}
export interface TopicDetailView {
  topic: TopicSummaryView;
  category: { publicId: string; slug: string; name: string };
  subscribed: boolean;
  posts: PostView[];
  nextCursor: string | null;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface ReportView {
  publicId: string;
  postPublicId: string;
  topicPublicId: string;
  reason: ReportReason;
  note: string | null;
  createdAt: string;
  openReportsOnPost: number;
}
export interface QueueView {
  pending: (PostView & { topicPublicId: string; topicTitle: string; heldReason: string | null })[];
  reports: ReportView[];
}
export interface ModerationLogView {
  publicId: string;
  action: ModerationAction;
  targetType: "post" | "topic" | "member" | "report";
  targetPublicId: string;
  reason: string | null;
  actor: string;
  createdAt: string;
}
export interface PostResult {
  postPublicId: string;
  topicPublicId: string;
  state: PostState;
}

type AuditAttrs = NonNullable<AuditEventInput["attributes"]>;

interface Actor {
  principal: SessionPrincipal;
  userId: number;
  role: UserRole;
  canModerate: boolean;
  canManage: boolean;
}

function iso(d: Date): string {
  return d.toISOString();
}

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d{1,5}$/u.test(cursor)) throw validation("COMMUNITY_BAD_CURSOR", "The page link is no longer valid.");
  const n = Number(cursor);
  if (n > MAX_OFFSET) throw validation("COMMUNITY_BAD_CURSOR", "The page link is no longer valid.");
  return n;
}

function rateLimited(reason: string, message: string): DomainError {
  return new DomainError("RATE_LIMITED", reason, message);
}

/** Escapes LIKE wildcards; the value is bound as a parameter. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
}

export function createCommunityService(deps: ModuleDeps) {
  const { db } = deps;
  const now = () => deps.clock.now();

  /* ---------------------------------------------------------------- guards */

  async function isEnabled(tx?: Tx): Promise<boolean> {
    return isFlagEnabled(deps.settings, COMMUNITY_FLAG, tx);
  }

  async function config(tx?: Tx): Promise<CommunityConfig> {
    return readSetting(deps.settings, COMMUNITY_CONFIG, tx);
  }

  function liveAuthorSql(userIdCol: typeof communityTopics.authorUserId | typeof communityPosts.authorUserId | typeof communityReports.reporterUserId) {
    return sql`exists (select 1 from ${users} where ${users.id} = ${userIdCol} and ${users.trashedAt} is null and ${users.purgedAt} is null)`;
  }

  /** A topic opened by a trashed/purged author stays visible ONLY when live replies from other members exist. */
  function liveTopicIntegritySql() {
    return sql`(${liveAuthorSql(communityTopics.authorUserId)} or exists (
      select 1 from ${communityPosts} cp
      inner join ${users} u on u.id = cp.author_user_id
      where cp.topic_id = ${communityTopics.id}
        and cp.is_opening = false
        and cp.state = 'published'
        and u.trashed_at is null
        and u.purged_at is null
    ))`;
  }

  async function isLiveUserId(tx: Tx, userId: number): Promise<boolean> {
    const [u] = await tx
      .select({ trashedAt: users.trashedAt, purgedAt: users.purgedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return u ? isLiveUserRow(u) : false;
  }

  async function actorInTx(principal: SessionPrincipal, tx: Tx): Promise<Actor> {
    const sessions = deps.services.identity?.sessions;
    if (!sessions?.assertCurrent) throw forbidden("IDENTITY_UNAVAILABLE");
    const current = await sessions.assertCurrent(principal, tx);
    if (current.pendingSteps.length > 0) throw forbidden("SESSION_NOT_FULL");
    if (!(await isLiveUserId(tx, principal.userId))) {
      throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Sign in again.");
    }
    const role = current.role;
    return {
      principal,
      userId: principal.userId,
      role,
      canModerate: roleHasCapability(role, "community.moderate"),
      canManage: roleHasCapability(role, "community.manage"),
    };
  }

  /** Member procedures: flag on + current session. */
  async function memberTx<T>(principal: SessionPrincipal, fn: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      if (!(await isEnabled(tx))) throw notFound("COMMUNITY_DISABLED");
      const actor = await actorInTx(principal, tx);
      return fn(tx, actor);
    });
  }

  async function moderatorTx<T>(principal: SessionPrincipal, fn: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> {
    return memberTx(principal, async (tx, actor) => {
      if (!actor.canModerate) throw forbidden("CAPABILITY_NOT_GRANTED");
      return fn(tx, actor);
    });
  }

  /** Admin procedures work while the forum is off (to prepare and switch it on). */
  async function adminTx<T>(principal: SessionPrincipal, fn: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      const actor = await actorInTx(principal, tx);
      if (!actor.canManage) throw forbidden("CAPABILITY_NOT_GRANTED");
      return fn(tx, actor);
    });
  }

  async function audit(tx: Tx, actor: Actor | null, event: Omit<AuditEventInput, "actor" | "category"> & { category?: AuditEventInput["category"] }): Promise<void> {
    await deps.audit.record(
      {
        category: event.category ?? "business",
        ...event,
        actor: actor ? { userId: actor.userId, role: actor.role } : { role: "system" },
      },
      tx,
    );
  }

  async function profileOf(userId: number, tx: Tx, lock = false): Promise<CommunityProfileRow | null> {
    const q = tx.select().from(communityProfiles).where(eq(communityProfiles.userId, userId)).limit(1);
    const rows = lock ? await q.for("update") : await q;
    return rows[0] ?? null;
  }

  function isSuspended(p: CommunityProfileRow): boolean {
    if (p.suspendedIndefinitely) return true;
    return p.suspendedUntil !== null && p.suspendedUntil.getTime() > now().getTime();
  }

  /** Posting requires a profile and no active suspension. Locks the profile row (serialises per-author limits). */
  async function postingProfile(actor: Actor, tx: Tx): Promise<CommunityProfileRow> {
    const p = await profileOf(actor.userId, tx, true);
    if (!p) throw validation("COMMUNITY_PROFILE_REQUIRED", "Choose a display name before posting.");
    if (isSuspended(p)) throw forbidden("COMMUNITY_SUSPENDED");
    return p;
  }

  async function loadCategory(publicId: string, tx: Tx, actor: Actor): Promise<CommunityCategoryRow> {
    const [row] = await tx.select().from(communityCategories).where(eq(communityCategories.publicId, publicId)).limit(1);
    // Archived = read-only: still readable (lists, search, direct links); createTopic/reply refuse new posts.
    void actor;
    if (!row) throw notFound();
    return row;
  }

  function topicVisibleTo(t: CommunityTopicRow, actor: Actor): boolean {
    if (actor.canModerate) return true;
    if (t.state !== "open") return false;
    return t.visible || t.authorUserId === actor.userId;
  }

  async function loadTopic(publicId: string, tx: Tx, actor: Actor, lock = false): Promise<CommunityTopicRow> {
    const q = tx
      .select()
      .from(communityTopics)
      .where(and(eq(communityTopics.publicId, publicId), liveTopicIntegritySql()))
      .limit(1);
    const [row] = lock ? await q.for("update") : await q;
    if (!row || !topicVisibleTo(row, actor)) throw notFound();
    return row;
  }

  function postVisibleTo(p: CommunityPostRow, actor: Actor): boolean {
    if (actor.canModerate) return true;
    if (p.state === "published") return true;
    return p.state === "pending" && p.authorUserId === actor.userId;
  }

  async function loadPost(publicId: string, tx: Tx, actor: Actor, lock = false): Promise<{ post: CommunityPostRow; topic: CommunityTopicRow }> {
    const q = tx.select().from(communityPosts).where(eq(communityPosts.publicId, publicId)).limit(1);
    const [post] = lock ? await q.for("update") : await q;
    if (!post) throw notFound();
    const [topic] = await tx
      .select()
      .from(communityTopics)
      .where(and(eq(communityTopics.id, post.topicId), liveTopicIntegritySql()))
      .limit(1);
    if (!topic || !topicVisibleTo(topic, actor) || !postVisibleTo(post, actor)) throw notFound();
    return { post, topic };
  }

  interface ResolvedAuthorInfo {
    view: AuthorView;
    live: boolean;
  }

  async function authorsInfo(userIds: number[], tx: Tx): Promise<Map<number, ResolvedAuthorInfo>> {
    const map = new Map<number, ResolvedAuthorInfo>();
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return map;
    const userRows = await tx
      .select({
        id: users.id,
        role: users.role,
        trashedAt: users.trashedAt,
        purgedAt: users.purgedAt,
      })
      .from(users)
      .where(inArray(users.id, unique));
    const profileRows = await tx
      .select({
        userId: communityProfiles.userId,
        publicId: communityProfiles.publicId,
        displayName: communityProfiles.displayName,
        anonymised: communityProfiles.anonymised,
      })
      .from(communityProfiles)
      .where(inArray(communityProfiles.userId, unique));
    const profileByUser = new Map(profileRows.map((p) => [p.userId, p]));

    for (const u of userRows) {
      const live = isLiveUserRow(u);
      const p = profileByUser.get(u.id);
      if (!live || p?.displayName === DELETED_ACCOUNT_LABEL) {
        map.set(u.id, {
          view: { publicId: null, displayName: DELETED_ACCOUNT_LABEL, staff: false },
          live: false,
        });
      } else if (!p || p.anonymised) {
        map.set(u.id, {
          view: { publicId: null, displayName: FORMER_MEMBER, staff: false },
          live: true,
        });
      } else {
        map.set(u.id, {
          view: { publicId: p.publicId, displayName: p.displayName, staff: u.role !== "customer" },
          live: true,
        });
      }
    }
    return map;
  }

  async function authors(userIds: number[], tx: Tx): Promise<Map<number, AuthorView>> {
    const info = await authorsInfo(userIds, tx);
    const out = new Map<number, AuthorView>();
    for (const [id, entry] of info) {
      out.set(id, entry.view);
    }
    return out;
  }

  function authorOf(map: Map<number, AuthorView>, userId: number): AuthorView {
    return map.get(userId) ?? { publicId: null, displayName: FORMER_MEMBER, staff: false };
  }

  async function logModeration(tx: Tx, actor: Actor | null, action: ModerationAction, targetType: "post" | "topic" | "member" | "report", targetPublicId: string, reason: string | null): Promise<void> {
    await tx.insert(communityModerationLog).values({
      actorUserId: actor?.userId ?? null,
      action,
      targetType,
      targetPublicId,
      reason,
      createdAt: now(),
    });
    await audit(tx, actor, {
      category: "admin",
      eventName: "community.moderation.action",
      action: "moderate",
      outcome: "completed",
      resource: { type: `community_${targetType}`, publicId: targetPublicId },
      attributes: { moderation_action: action, target_type: targetType, has_reason: reason !== null && reason.length > 0 },
    });
  }

  /* --------------------------------------------------------------- views */

  function categoryView(c: CommunityCategoryRow): CategoryView {
    return { publicId: c.publicId, slug: c.slug, name: c.name, description: c.description, sortOrder: c.sortOrder, staffOnlyPosting: c.staffOnlyPosting, archived: c.archived, topicCount: c.topicCount, version: c.version };
  }

  async function topicViews(rows: CommunityTopicRow[], tx: Tx): Promise<TopicSummaryView[]> {
    const infoMap = await authorsInfo(rows.map((r) => r.authorUserId), tx);
    const catIds = [...new Set(rows.map((r) => r.categoryId))];
    const cats = catIds.length ? await tx.select({ id: communityCategories.id, publicId: communityCategories.publicId }).from(communityCategories).where(inArray(communityCategories.id, catIds)) : [];
    const catMap = new Map(cats.map((c) => [c.id, c.publicId]));
    return rows.map((t) => {
      const info = infoMap.get(t.authorUserId);
      const authorLive = info?.live ?? false;
      return {
        publicId: t.publicId,
        categoryPublicId: catMap.get(t.categoryId) ?? "",
        title: authorLive ? t.title : DELETED_TOPIC_TITLE,
        author: info?.view ?? { publicId: null, displayName: DELETED_ACCOUNT_LABEL, staff: false },
        pinned: t.pinned,
        locked: t.locked,
        state: t.state,
        visible: t.visible,
        replyCount: t.replyCount,
        lastPostAt: iso(t.lastPostAt),
        createdAt: iso(t.createdAt),
      };
    });
  }

  async function postViews(rows: CommunityPostRow[], tx: Tx, actor: Actor, cfg: CommunityConfig): Promise<PostView[]> {
    const quoteIds = rows.map((r) => r.quotePostId).filter((id): id is number => id !== null);
    const quotes = quoteIds.length ? await tx.select().from(communityPosts).where(inArray(communityPosts.id, quoteIds)) : [];
    const infoMap = await authorsInfo([...rows.map((r) => r.authorUserId), ...quotes.map((q) => q.authorUserId)], tx);
    const quoteMap = new Map(quotes.map((q) => [q.id, q]));
    const ids = rows.map((r) => r.id);
    const mine = ids.length
      ? new Set((await tx.select({ postId: communityReactions.postId }).from(communityReactions).where(and(eq(communityReactions.userId, actor.userId), inArray(communityReactions.postId, ids)))).map((r) => r.postId))
      : new Set<number>();
    const windowMs = cfg.editWindowMinutes * 60_000;
    return rows.map((p) => {
      const authorInfo = infoMap.get(p.authorUserId);
      const authorLive = authorInfo?.live ?? false;
      const effectiveState: PostState = !authorLive ? (p.state === "removed" ? "removed" : "deleted") : p.state;
      const purgedBody = effectiveState === "deleted" && p.bodyText === "";
      const readable =
        authorLive &&
        !purgedBody &&
        (effectiveState === "published" || actor.canModerate || (effectiveState === "pending" && p.authorUserId === actor.userId));
      const q = p.quotePostId !== null ? quoteMap.get(p.quotePostId) : undefined;
      const qInfo = q ? infoMap.get(q.authorUserId) : undefined;
      const qAuthorLive = qInfo?.live ?? false;
      const isMine = authorLive && p.authorUserId === actor.userId;
      return {
        publicId: p.publicId,
        author: authorInfo?.view ?? { publicId: null, displayName: DELETED_ACCOUNT_LABEL, staff: false },
        isOpening: p.isOpening,
        body: readable ? p.bodyText : null,
        state: effectiveState,
        quote: q
          ? {
              publicId: q.publicId,
              author: (qInfo?.view ?? { publicId: null, displayName: DELETED_ACCOUNT_LABEL, staff: false }).displayName,
              excerpt: qAuthorLive && q.state === "published" ? q.bodyText.slice(0, 280) : null,
            }
          : null,
        createdAt: iso(p.createdAt),
        editedAt: p.editedAt ? iso(p.editedAt) : null,
        helpfulCount: p.helpfulCount,
        reactedByMe: mine.has(p.id),
        mine: isMine,
        canEdit: isMine && (effectiveState === "published" || effectiveState === "pending") && now().getTime() - p.createdAt.getTime() <= windowMs,
        version: p.version,
      };
    });
  }

  /* ---------------------------------------------------------- posting core */

  interface Placement {
    state: PostState;
    heldReason: string | null;
  }

  async function checkLimitsAndFilters(tx: Tx, actor: Actor, profile: CommunityProfileRow, cfg: CommunityConfig, text: string, links: number, hash: string): Promise<Placement> {
    const t = now().getTime();
    const blocked = matchWordList(text, cfg.blockedWords);
    if (blocked !== null) throw validation("COMMUNITY_BLOCKED_WORD", "This post contains words that are not allowed in the community.");
    const staff = actor.role !== "customer";
    if (!staff) {
      const [hour] = await tx.select({ n: count() }).from(communityPosts).where(and(eq(communityPosts.authorUserId, actor.userId), gte(communityPosts.createdAt, new Date(t - 3_600_000))));
      if ((hour?.n ?? 0) >= cfg.maxPostsPerHour) throw rateLimited("COMMUNITY_HOURLY_LIMIT", "You are posting too quickly. Please wait a while and try again.");
    }
    const [dup] = await tx
      .select({ n: count() })
      .from(communityPosts)
      .where(and(eq(communityPosts.authorUserId, actor.userId), eq(communityPosts.bodyHash, hash), gte(communityPosts.createdAt, new Date(t - DUPLICATE_WINDOW_MS))));
    if ((dup?.n ?? 0) > 0) throw conflict("COMMUNITY_DUPLICATE_POST", "You have just posted the same text.");
    if (staff) return { state: "published", heldReason: null };

    const isNew = await isNewMember(tx, actor, cfg);
    if (isNew) {
      const [day] = await tx.select({ n: count() }).from(communityPosts).where(and(eq(communityPosts.authorUserId, actor.userId), gte(communityPosts.createdAt, new Date(t - 86_400_000))));
      if ((day?.n ?? 0) >= cfg.newMemberDailyPosts) throw rateLimited("COMMUNITY_NEW_MEMBER_LIMIT", "New members can post a limited number of times per day. Please try again tomorrow.");
    }
    if (matchWordList(text, cfg.heldWords) !== null) return { state: "pending", heldReason: "held_word" };
    if (isNew && links > NEW_MEMBER_MAX_LINKS) return { state: "pending", heldReason: "links" };
    if (isNew && profile.postCount < cfg.newMemberReviewPosts) return { state: "pending", heldReason: "new_member" };
    return { state: "published", heldReason: null };
  }

  async function isNewMember(tx: Tx, actor: Actor, cfg: CommunityConfig): Promise<boolean> {
    if (actor.role !== "customer") return false;
    const [user] = await tx.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, actor.userId)).limit(1);
    return !user || now().getTime() - user.createdAt.getTime() < cfg.newMemberDays * 86_400_000;
  }

  async function notifySubscribers(tx: Tx, topic: CommunityTopicRow, post: { id: number; publicId: string; authorUserId: number }): Promise<number> {
    const engagement = deps.services.engagement;
    if (!engagement?.notify) return 0;
    const subs = await tx
      .select({ userId: communitySubscriptions.userId })
      .from(communitySubscriptions)
      .innerJoin(users, and(eq(users.id, communitySubscriptions.userId), liveUserPredicate(users)))
      .where(and(eq(communitySubscriptions.topicId, topic.id), sql`${communitySubscriptions.userId} <> ${post.authorUserId}`))
      .orderBy(asc(communitySubscriptions.id))
      .limit(NOTIFY_CAP);
    for (const s of subs) {
      await engagement.notify(
        {
          userId: s.userId,
          kind: "community.reply",
          title: "New reply in a topic you follow",
          body: "Someone replied in a community topic you follow.",
          link: `/community/t/${topic.publicId}`,
          idempotencyKey: `community.reply:${post.publicId}:${s.userId}`,
        },
        tx,
      );
    }
    return subs.length;
  }

  async function subscribe(tx: Tx, topicId: number, userId: number): Promise<void> {
    await tx.insert(communitySubscriptions).values({ topicId, userId, createdAt: now() }).onDuplicateKeyUpdate({ set: { topicId: sql`topic_id` } });
  }

  /** Applies the published side effects (counters, visibility, notifications). */
  async function onPublished(tx: Tx, topic: CommunityTopicRow, post: CommunityPostRow | { id: number; publicId: string; authorUserId: number; isOpening: boolean; createdAt: Date }): Promise<number> {
    await tx.update(communityProfiles).set({ postCount: sql`${communityProfiles.postCount} + 1` }).where(eq(communityProfiles.userId, post.authorUserId));
    if (post.isOpening) {
      await tx.update(communityTopics).set({ visible: true, lastPostAt: post.createdAt, version: sql`${communityTopics.version} + 1` }).where(eq(communityTopics.id, topic.id));
      await tx.update(communityCategories).set({ topicCount: sql`${communityCategories.topicCount} + 1` }).where(eq(communityCategories.id, topic.categoryId));
      return 0;
    }
    await tx
      .update(communityTopics)
      .set({ replyCount: sql`${communityTopics.replyCount} + 1`, lastPostAt: post.createdAt, version: sql`${communityTopics.version} + 1` })
      .where(eq(communityTopics.id, topic.id));
    return notifySubscribers(tx, topic, post);
  }

  /** Reverses counters when a published post leaves the published state. */
  async function onUnpublished(tx: Tx, topic: CommunityTopicRow, post: CommunityPostRow): Promise<void> {
    if (post.isOpening) {
      if (topic.visible) await tx.update(communityCategories).set({ topicCount: sql`GREATEST(${communityCategories.topicCount}, 1) - 1` }).where(eq(communityCategories.id, topic.categoryId));
      await tx.update(communityTopics).set({ visible: false, version: sql`${communityTopics.version} + 1` }).where(eq(communityTopics.id, topic.id));
      return;
    }
    await tx.update(communityTopics).set({ replyCount: sql`GREATEST(${communityTopics.replyCount}, 1) - 1`, version: sql`${communityTopics.version} + 1` }).where(eq(communityTopics.id, topic.id));
  }

  async function existingByKey(tx: Tx, userId: number, key: string): Promise<CommunityPostRow | null> {
    const [row] = await tx.select().from(communityPosts).where(and(eq(communityPosts.authorUserId, userId), eq(communityPosts.idempotencyKey, key))).limit(1);
    return row ?? null;
  }

  async function postResult(tx: Tx, post: CommunityPostRow): Promise<PostResult> {
    const [topic] = await tx.select({ publicId: communityTopics.publicId }).from(communityTopics).where(eq(communityTopics.id, post.topicId)).limit(1);
    return { postPublicId: post.publicId, topicPublicId: topic?.publicId ?? "", state: post.state };
  }

  /* ================================================================ API */

  return {
    enabled: (tx?: Tx) => isEnabled(tx),

    async status(principal: SessionPrincipal): Promise<CommunityStatusView> {
      return db.transaction(async (tx) => {
        const enabled = await isEnabled(tx);
        const canModerate = roleHasCapability(principal.role, "community.moderate");
        const canManage = roleHasCapability(principal.role, "community.manage");
        if (!(await isLiveUserId(tx, principal.userId))) {
          throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Sign in again.");
        }
        if (!enabled) {
          return { enabled, profile: null, suspended: false, suspendedUntil: null, canModerate, canManage };
        }
        const p = await profileOf(principal.userId, tx);
        return {
          enabled,
          profile: p && !p.anonymised ? { publicId: p.publicId, displayName: p.displayName } : null,
          suspended: p ? isSuspended(p) : false,
          suspendedUntil: p?.suspendedUntil && isSuspended(p) ? iso(p.suspendedUntil) : null,
          canModerate,
          canManage,
        };
      });
    },

    async saveProfile(principal: SessionPrincipal, input: { displayName: string }): Promise<{ publicId: string; displayName: string }> {
      const { displayName, key } = validateDisplayName(input.displayName);
      return memberTx(principal, async (tx, actor) => {
        const existing = await profileOf(actor.userId, tx, true);
        if (existing?.anonymised) throw forbidden("COMMUNITY_PROFILE_ANONYMISED");
        const [taken] = await tx.select({ userId: communityProfiles.userId }).from(communityProfiles).where(eq(communityProfiles.displayNameKey, key)).limit(1);
        if (taken && taken.userId !== actor.userId) throw conflict("COMMUNITY_NAME_TAKEN", "That display name is already in use.");
        let publicId: string;
        if (existing) {
          await tx.update(communityProfiles).set({ displayName, displayNameKey: key, version: sql`${communityProfiles.version} + 1`, updatedAt: now() }).where(eq(communityProfiles.id, existing.id));
          publicId = existing.publicId;
        } else {
          await tx.insert(communityProfiles).values({ userId: actor.userId, displayName, displayNameKey: key, createdAt: now(), updatedAt: now() });
          publicId = (await profileOf(actor.userId, tx))!.publicId;
        }
        await audit(tx, actor, { eventName: "community.profile.saved", action: existing ? "update" : "create", outcome: "completed", resource: { type: "community_profile", publicId } });
        return { publicId, displayName };
      });
    },

    async listCategories(principal: SessionPrincipal): Promise<CategoryView[]> {
      return memberTx(principal, async (tx) => {
        // Archived categories are listed (flagged) because archive means read-only, not hidden.
        const rows = await tx.select().from(communityCategories).orderBy(asc(communityCategories.sortOrder), asc(communityCategories.id)).limit(200);
        return rows.map(categoryView);
      });
    },

    async listTopics(principal: SessionPrincipal, input: { categoryPublicId?: string; cursor?: string; limit?: number }): Promise<Page<TopicSummaryView>> {
      const offset = decodeOffset(input.cursor);
      const limit = Math.min(input.limit ?? 20, PAGE_LIMIT);
      return memberTx(principal, async (tx, actor) => {
        const conds: (SQL | undefined)[] = [liveTopicIntegritySql()];
        if (input.categoryPublicId) conds.push(eq(communityTopics.categoryId, (await loadCategory(input.categoryPublicId, tx, actor)).id));
        if (!actor.canModerate) conds.push(eq(communityTopics.state, "open"), or(eq(communityTopics.visible, true), eq(communityTopics.authorUserId, actor.userId)));
        const rows = await tx
          .select()
          .from(communityTopics)
          .where(conds.length ? and(...conds) : undefined)
          .orderBy(desc(communityTopics.pinned), desc(communityTopics.lastPostAt), desc(communityTopics.id))
          .limit(limit + 1)
          .offset(offset);
        const items = await topicViews(rows.slice(0, limit), tx);
        return { items, nextCursor: rows.length > limit && offset + limit <= MAX_OFFSET ? String(offset + limit) : null };
      });
    },

    async getTopic(principal: SessionPrincipal, input: { topicPublicId: string; cursor?: string }): Promise<TopicDetailView> {
      const offset = decodeOffset(input.cursor);
      return memberTx(principal, async (tx, actor) => {
        const topic = await loadTopic(input.topicPublicId, tx, actor);
        const [cat] = await tx.select().from(communityCategories).where(eq(communityCategories.id, topic.categoryId)).limit(1);
        const visibility = actor.canModerate
          ? eq(communityPosts.topicId, topic.id)
          : and(
              eq(communityPosts.topicId, topic.id),
              or(
                inArray(communityPosts.state, ["published", "hidden", "removed", "deleted"]),
                and(eq(communityPosts.state, "pending"), eq(communityPosts.authorUserId, actor.userId)),
              ),
            );
        const rows = await tx.select().from(communityPosts).where(visibility).orderBy(asc(communityPosts.id)).limit(PAGE_LIMIT + 1).offset(offset);
        const cfg = await config(tx);
        const [sub] = await tx.select({ id: communitySubscriptions.id }).from(communitySubscriptions).where(and(eq(communitySubscriptions.topicId, topic.id), eq(communitySubscriptions.userId, actor.userId))).limit(1);
        const [summary] = await topicViews([topic], tx);
        return {
          topic: summary!,
          category: { publicId: cat?.publicId ?? "", slug: cat?.slug ?? "", name: cat?.name ?? "" },
          subscribed: sub !== undefined,
          posts: await postViews(rows.slice(0, PAGE_LIMIT), tx, actor, cfg),
          nextCursor: rows.length > PAGE_LIMIT && offset + PAGE_LIMIT <= MAX_OFFSET ? String(offset + PAGE_LIMIT) : null,
        };
      });
    },

    async createTopic(principal: SessionPrincipal, input: { categoryPublicId: string; title: string; body: string; idempotencyKey: string }): Promise<PostResult> {
      const title = normaliseTitle(input.title);
      const body = normaliseBody(input.body);
      return memberTx(principal, async (tx, actor) => {
        const prior = await existingByKey(tx, actor.userId, input.idempotencyKey);
        if (prior) return postResult(tx, prior);
        const profile = await postingProfile(actor, tx);
        const category = await loadCategory(input.categoryPublicId, tx, actor);
        if (category.archived) throw conflict("COMMUNITY_CATEGORY_ARCHIVED", "This category is archived and no longer accepts new topics.");
        if (category.staffOnlyPosting && actor.role === "customer") throw forbidden("COMMUNITY_STAFF_ONLY_CATEGORY");
        const cfg = await config(tx);
        const hash = bodyHash(body);
        const links = countLinks(body);
        const placement = await checkLimitsAndFilters(tx, actor, profile, cfg, `${title}\n${body}`, links, hash);
        const at = now();
        await tx.insert(communityTopics).values({ categoryId: category.id, authorUserId: actor.userId, title, lastPostAt: at, createdAt: at, updatedAt: at });
        const [topic] = await tx.select().from(communityTopics).where(eq(communityTopics.authorUserId, actor.userId)).orderBy(desc(communityTopics.id)).limit(1);
        await tx.insert(communityPosts).values({
          topicId: topic!.id, authorUserId: actor.userId, authorRole: actor.role, isOpening: true, bodyText: body, bodyHash: hash, linkCount: links,
          state: placement.state, heldReason: placement.heldReason, idempotencyKey: input.idempotencyKey, createdAt: at, updatedAt: at,
        });
        const post = (await existingByKey(tx, actor.userId, input.idempotencyKey))!;
        if (placement.state === "published") await onPublished(tx, topic!, post);
        await subscribe(tx, topic!.id, actor.userId);
        await audit(tx, actor, {
          eventName: "community.topic.created",
          action: "create",
          outcome: "completed",
          resource: { type: "community_topic", publicId: topic!.publicId },
          attributes: { category_public_id: category.publicId, post_state: placement.state, held_reason: placement.heldReason, link_count: links },
        });
        return { postPublicId: post.publicId, topicPublicId: topic!.publicId, state: post.state };
      });
    },

    async reply(principal: SessionPrincipal, input: { topicPublicId: string; body: string; quotePostPublicId?: string; idempotencyKey: string }): Promise<PostResult & { notified: number }> {
      const body = normaliseBody(input.body);
      return memberTx(principal, async (tx, actor) => {
        const prior = await existingByKey(tx, actor.userId, input.idempotencyKey);
        if (prior) return { ...(await postResult(tx, prior)), notified: 0 };
        const profile = await postingProfile(actor, tx);
        const topic = await loadTopic(input.topicPublicId, tx, actor, true);
        const [cat] = await tx.select({ archived: communityCategories.archived }).from(communityCategories).where(eq(communityCategories.id, topic.categoryId)).limit(1);
        if (!cat || cat.archived) throw conflict("COMMUNITY_CATEGORY_ARCHIVED", "This category is archived and no longer accepts replies.");
        if (topic.locked && !actor.canModerate) throw conflict("COMMUNITY_TOPIC_LOCKED", "This topic is locked and no longer accepts replies.");
        if (!topic.visible && !actor.canModerate) throw conflict("COMMUNITY_TOPIC_PENDING", "This topic is waiting for review.");
        let quoteId: number | null = null;
        if (input.quotePostPublicId) {
          const { post: quoted } = await loadPost(input.quotePostPublicId, tx, actor);
          if (quoted.topicId !== topic.id || quoted.state !== "published" || !(await isLiveUserId(tx, quoted.authorUserId))) {
            throw validation("COMMUNITY_BAD_QUOTE", "That post cannot be quoted.");
          }
          quoteId = quoted.id;
        }
        const cfg = await config(tx);
        const hash = bodyHash(body);
        const links = countLinks(body);
        const placement = await checkLimitsAndFilters(tx, actor, profile, cfg, body, links, hash);
        const at = now();
        await tx.insert(communityPosts).values({
          topicId: topic.id, authorUserId: actor.userId, authorRole: actor.role, isOpening: false, bodyText: body, bodyHash: hash, linkCount: links,
          quotePostId: quoteId, state: placement.state, heldReason: placement.heldReason, idempotencyKey: input.idempotencyKey, createdAt: at, updatedAt: at,
        });
        const post = (await existingByKey(tx, actor.userId, input.idempotencyKey))!;
        const notified = placement.state === "published" ? await onPublished(tx, topic, post) : 0;
        await subscribe(tx, topic.id, actor.userId);
        await audit(tx, actor, {
          eventName: "community.post.created",
          action: "create",
          outcome: "completed",
          resource: { type: "community_post", publicId: post.publicId },
          attributes: { topic_public_id: topic.publicId, post_state: placement.state, held_reason: placement.heldReason, link_count: links, quoted: quoteId !== null },
          safeCounts: { notified },
        });
        return { postPublicId: post.publicId, topicPublicId: topic.publicId, state: post.state, notified };
      });
    },

    async editPost(principal: SessionPrincipal, input: { postPublicId: string; body: string; expectedVersion: number; title?: string }): Promise<PostResult> {
      const body = normaliseBody(input.body);
      const title = input.title !== undefined ? normaliseTitle(input.title) : undefined;
      return memberTx(principal, async (tx, actor) => {
        const { post, topic } = await loadPost(input.postPublicId, tx, actor, true);
        if (post.authorUserId !== actor.userId) throw forbidden("COMMUNITY_NOT_AUTHOR");
        const profile = await postingProfile(actor, tx);
        const [cat] = await tx.select({ archived: communityCategories.archived }).from(communityCategories).where(eq(communityCategories.id, topic.categoryId)).limit(1);
        if (!cat || cat.archived) throw conflict("COMMUNITY_CATEGORY_ARCHIVED", "This category is archived and its posts can no longer be edited.");
        if (post.state !== "published" && post.state !== "pending") throw conflict("COMMUNITY_POST_NOT_EDITABLE", "This post can no longer be edited.");
        if (post.version !== input.expectedVersion) throw conflict("STALE_VERSION", "This post changed since you opened it. Reload and try again.");
        const cfg = await config(tx);
        if (now().getTime() - post.createdAt.getTime() > cfg.editWindowMinutes * 60_000) throw conflict("COMMUNITY_EDIT_WINDOW_CLOSED", "The time to edit this post has passed.");
        if (title !== undefined && !post.isOpening) throw validation("COMMUNITY_TITLE_ONLY_OPENING", "Only the opening post has a title.");
        const text = title !== undefined ? `${title}\n${body}` : body;
        if (matchWordList(text, cfg.blockedWords) !== null) throw validation("COMMUNITY_BLOCKED_WORD", "This post contains words that are not allowed in the community.");
        // Edit-time moderation subset (no creation quota): held words, and the new-member link threshold.
        const links = countLinks(body);
        const heldReason = actor.role !== "customer"
          ? null
          : matchWordList(text, cfg.heldWords) !== null
            ? "held_word"
            : links > NEW_MEMBER_MAX_LINKS && (await isNewMember(tx, actor, cfg))
              ? "links"
              : null;
        const held = heldReason !== null;
        let state: PostState = post.state;
        if (held && post.state === "published") {
          state = "pending";
          await onUnpublished(tx, topic, post);
          await tx.update(communityProfiles).set({ postCount: sql`GREATEST(${communityProfiles.postCount}, 1) - 1` }).where(eq(communityProfiles.id, profile.id));
        }
        await tx
          .update(communityPosts)
          .set({ bodyText: body, bodyHash: bodyHash(body), linkCount: links, state, heldReason: heldReason ?? post.heldReason, editedAt: now(), editCount: sql`${communityPosts.editCount} + 1`, version: sql`${communityPosts.version} + 1`, updatedAt: now() })
          .where(and(eq(communityPosts.id, post.id), eq(communityPosts.version, post.version)));
        if (title !== undefined) await tx.update(communityTopics).set({ title, version: sql`${communityTopics.version} + 1` }).where(eq(communityTopics.id, topic.id));
        await audit(tx, actor, {
          eventName: "community.post.edited",
          action: "update",
          outcome: "completed",
          resource: { type: "community_post", publicId: post.publicId },
          attributes: { post_state: state, title_changed: title !== undefined },
        });
        return { postPublicId: post.publicId, topicPublicId: topic.publicId, state };
      });
    },

    async deletePost(principal: SessionPrincipal, input: { postPublicId: string }): Promise<PostResult> {
      return memberTx(principal, async (tx, actor) => {
        const { post, topic } = await loadPost(input.postPublicId, tx, actor, true);
        if (post.authorUserId !== actor.userId) throw forbidden("COMMUNITY_NOT_AUTHOR");
        if (post.state === "deleted" || post.state === "removed") throw conflict("COMMUNITY_POST_GONE", "This post has already been removed.");
        if (post.state === "published") await onUnpublished(tx, topic, post);
        await tx.update(communityPosts).set({ state: "deleted", version: sql`${communityPosts.version} + 1`, updatedAt: now() }).where(eq(communityPosts.id, post.id));
        if (post.isOpening) await tx.update(communityTopics).set({ state: "removed", version: sql`${communityTopics.version} + 1` }).where(eq(communityTopics.id, topic.id));
        await audit(tx, actor, { eventName: "community.post.deleted", action: "delete", outcome: "completed", resource: { type: "community_post", publicId: post.publicId }, attributes: { opening: post.isOpening, previous_state: post.state } });
        return { postPublicId: post.publicId, topicPublicId: topic.publicId, state: "deleted" };
      });
    },

    async react(principal: SessionPrincipal, input: { postPublicId: string; helpful: boolean }): Promise<{ helpfulCount: number; reactedByMe: boolean }> {
      return memberTx(principal, async (tx, actor) => {
        await postingProfile(actor, tx);
        const { post } = await loadPost(input.postPublicId, tx, actor, true);
        if (post.state !== "published" || !(await isLiveUserId(tx, post.authorUserId))) throw notFound();
        if (post.authorUserId === actor.userId) throw validation("COMMUNITY_OWN_POST", "You cannot mark your own post as helpful.");
        const [existing] = await tx.select({ id: communityReactions.id }).from(communityReactions).where(and(eq(communityReactions.postId, post.id), eq(communityReactions.userId, actor.userId))).limit(1);
        if (input.helpful && !existing) {
          await tx.insert(communityReactions).values({ postId: post.id, userId: actor.userId, createdAt: now() });
          await tx.update(communityPosts).set({ helpfulCount: sql`${communityPosts.helpfulCount} + 1` }).where(eq(communityPosts.id, post.id));
        } else if (!input.helpful && existing) {
          await tx.delete(communityReactions).where(eq(communityReactions.id, existing.id));
          await tx.update(communityPosts).set({ helpfulCount: sql`GREATEST(${communityPosts.helpfulCount}, 1) - 1` }).where(eq(communityPosts.id, post.id));
        }
        const [after] = await tx.select({ n: communityPosts.helpfulCount }).from(communityPosts).where(eq(communityPosts.id, post.id)).limit(1);
        return { helpfulCount: after?.n ?? 0, reactedByMe: input.helpful };
      });
    },

    async report(principal: SessionPrincipal, input: { postPublicId: string; reason: ReportReason; note?: string }): Promise<{ reportPublicId: string; postHidden: boolean }> {
      const note = input.note ? cleanLine(input.note, 500) : null;
      return memberTx(principal, async (tx, actor) => {
        await postingProfile(actor, tx);
        const { post, topic } = await loadPost(input.postPublicId, tx, actor, true);
        if (post.state !== "published" || !(await isLiveUserId(tx, post.authorUserId))) throw notFound();
        if (post.authorUserId === actor.userId) throw validation("COMMUNITY_OWN_POST", "You cannot report your own post.");
        const [open] = await tx.select({ id: communityReports.id }).from(communityReports).where(and(eq(communityReports.postId, post.id), eq(communityReports.openReporterUserId, actor.userId))).limit(1);
        if (open) throw conflict("COMMUNITY_ALREADY_REPORTED", "You have already reported this post. A moderator will review it.");
        const [recent] = await tx.select({ n: count() }).from(communityReports).where(and(eq(communityReports.reporterUserId, actor.userId), gte(communityReports.createdAt, new Date(now().getTime() - 3_600_000))));
        if ((recent?.n ?? 0) >= 20) throw rateLimited("COMMUNITY_REPORT_LIMIT", "You have sent many reports recently. Please try again later.");
        await tx.insert(communityReports).values({ postId: post.id, reporterUserId: actor.userId, openReporterUserId: actor.userId, reason: input.reason, note: note && note.length > 0 ? note : null, createdAt: now() });
        const [rep] = await tx.select({ publicId: communityReports.publicId }).from(communityReports).where(and(eq(communityReports.postId, post.id), eq(communityReports.openReporterUserId, actor.userId))).limit(1);
        await tx.update(communityPosts).set({ openReportCount: sql`${communityPosts.openReportCount} + 1` }).where(eq(communityPosts.id, post.id));
        const cfg = await config(tx);
        const hide = post.openReportCount + 1 >= cfg.autoHideReportCount && post.authorRole === "customer";
        if (hide) {
          await onUnpublished(tx, topic, post);
          await tx.update(communityPosts).set({ state: "hidden", heldReason: "reports", version: sql`${communityPosts.version} + 1` }).where(eq(communityPosts.id, post.id));
          await logModeration(tx, null, "auto_hide", "post", post.publicId, "report threshold");
        }
        await audit(tx, actor, {
          eventName: "community.post.reported",
          action: "report",
          outcome: "completed",
          resource: { type: "community_post", publicId: post.publicId },
          attributes: { report_reason: input.reason, auto_hidden: hide, has_note: note !== null && note.length > 0 },
          safeCounts: { open_reports: post.openReportCount + 1 },
        });
        return { reportPublicId: rep!.publicId, postHidden: hide };
      });
    },

    async setSubscription(principal: SessionPrincipal, input: { topicPublicId: string; subscribed: boolean }): Promise<{ subscribed: boolean }> {
      return memberTx(principal, async (tx, actor) => {
        const topic = await loadTopic(input.topicPublicId, tx, actor);
        if (input.subscribed) {
          const [n] = await tx.select({ n: count() }).from(communitySubscriptions).where(eq(communitySubscriptions.userId, actor.userId));
          if ((n?.n ?? 0) >= 500) throw validation("COMMUNITY_SUBSCRIPTION_LIMIT", "You follow the maximum number of topics. Unfollow some first.");
          await subscribe(tx, topic.id, actor.userId);
        } else {
          await tx.delete(communitySubscriptions).where(and(eq(communitySubscriptions.topicId, topic.id), eq(communitySubscriptions.userId, actor.userId)));
        }
        return { subscribed: input.subscribed };
      });
    },

    async search(principal: SessionPrincipal, input: { q: string; cursor?: string }): Promise<Page<TopicSummaryView & { matchedPostPublicId: string | null }>> {
      const q = input.q.normalize("NFC").replace(/\s+/gu, " ").trim();
      if (q.length < 2 || q.length > 100) throw validation("COMMUNITY_SEARCH_LENGTH", "Search for 2 to 100 characters.");
      const offset = decodeOffset(input.cursor);
      const limit = 20;
      return memberTx(principal, async (tx) => {
        const pattern = likePattern(q);
        const rows = await tx
          .selectDistinct({ topic: communityTopics })
          .from(communityTopics)
          .innerJoin(communityPosts, eq(communityPosts.topicId, communityTopics.id))
          .where(
            and(
              eq(communityTopics.state, "open"),
              eq(communityTopics.visible, true),
              liveTopicIntegritySql(),
              eq(communityPosts.state, "published"),
              or(
                and(liveAuthorSql(communityTopics.authorUserId), like(communityTopics.title, pattern)),
                and(liveAuthorSql(communityPosts.authorUserId), like(communityPosts.bodyText, pattern)),
              ),
            ),
          )
          .orderBy(desc(communityTopics.lastPostAt), desc(communityTopics.id))
          .limit(limit + 1)
          .offset(offset);
        const topics = rows.slice(0, limit).map((r) => r.topic);
        const views = await topicViews(topics, tx);
        return { items: views.map((v) => ({ ...v, matchedPostPublicId: null })), nextCursor: rows.length > limit && offset + limit <= MAX_OFFSET ? String(offset + limit) : null };
      });
    },

    /* ------------------------------------------------------------ moderation */

    async queue(principal: SessionPrincipal): Promise<QueueView> {
      return moderatorTx(principal, async (tx, actor) => {
        const pendingRows = await tx
          .select()
          .from(communityPosts)
          .where(and(inArray(communityPosts.state, ["pending", "hidden"]), liveAuthorSql(communityPosts.authorUserId)))
          .orderBy(asc(communityPosts.id))
          .limit(PAGE_LIMIT);
        const topicIds = [...new Set(pendingRows.map((p) => p.topicId))];
        const topics = topicIds.length ? await tx.select().from(communityTopics).where(inArray(communityTopics.id, topicIds)) : [];
        const tmap = new Map(topics.map((t) => [t.id, t]));
        const cfg = await config(tx);
        const views = await postViews(pendingRows, tx, actor, cfg);
        const reports = await tx
          .select({ r: communityReports, postPublicId: communityPosts.publicId, topicId: communityPosts.topicId, openReports: communityPosts.openReportCount })
          .from(communityReports)
          .innerJoin(communityPosts, eq(communityPosts.id, communityReports.postId))
          .where(
            and(
              eq(communityReports.state, "open"),
              liveAuthorSql(communityReports.reporterUserId),
              liveAuthorSql(communityPosts.authorUserId),
            ),
          )
          .orderBy(asc(communityReports.id))
          .limit(PAGE_LIMIT);
        const rTopicIds = [...new Set(reports.map((r) => r.topicId).filter((id) => !tmap.has(id)))];
        if (rTopicIds.length) for (const t of await tx.select().from(communityTopics).where(inArray(communityTopics.id, rTopicIds))) tmap.set(t.id, t);
        return {
          pending: views.map((v, i) => {
            const t = tmap.get(pendingRows[i]!.topicId);
            return { ...v, topicPublicId: t?.publicId ?? "", topicTitle: t?.title ?? "", heldReason: pendingRows[i]!.heldReason };
          }),
          reports: reports.map((r) => ({
            publicId: r.r.publicId,
            postPublicId: r.postPublicId,
            topicPublicId: tmap.get(r.topicId)?.publicId ?? "",
            reason: r.r.reason,
            note: r.r.note,
            createdAt: iso(r.r.createdAt),
            openReportsOnPost: r.openReports,
          })),
        };
      });
    },

    async resolveReport(principal: SessionPrincipal, input: { reportPublicId: string; outcome: "dismissed" | "actioned"; note?: string }): Promise<{ state: "dismissed" | "actioned" }> {
      return moderatorTx(principal, async (tx, actor) => {
        const [rep] = await tx.select().from(communityReports).where(eq(communityReports.publicId, input.reportPublicId)).limit(1).for("update");
        if (!rep || !(await isLiveUserId(tx, rep.reporterUserId))) throw notFound();
        if (rep.state !== "open") throw conflict("COMMUNITY_REPORT_RESOLVED", "This report has already been resolved.");
        await tx
          .update(communityReports)
          .set({ state: input.outcome, openReporterUserId: null, resolvedByUserId: actor.userId, resolvedAt: now(), resolutionNote: input.note?.trim().slice(0, 500) || null })
          .where(and(eq(communityReports.id, rep.id), eq(communityReports.state, "open")));
        await tx.update(communityPosts).set({ openReportCount: sql`GREATEST(${communityPosts.openReportCount}, 1) - 1` }).where(eq(communityPosts.id, rep.postId));
        await logModeration(tx, actor, input.outcome === "dismissed" ? "report_dismissed" : "report_actioned", "report", rep.publicId, null);
        return { state: input.outcome };
      });
    },

    async moderatePost(principal: SessionPrincipal, input: { postPublicId: string; action: "approve" | "hide" | "unhide" | "remove"; reason?: string }): Promise<{ state: PostState; notified: number }> {
      return moderatorTx(principal, async (tx, actor) => {
        const { post, topic } = await loadPost(input.postPublicId, tx, actor, true);
        if (!(await isLiveUserId(tx, post.authorUserId))) throw notFound();
        const from = post.state;
        let to: PostState;
        switch (input.action) {
          case "approve":
            if (from !== "pending") throw conflict("COMMUNITY_BAD_TRANSITION", "Only posts waiting for review can be approved.");
            to = "published";
            break;
          case "hide":
            if (from !== "published" && from !== "pending") throw conflict("COMMUNITY_BAD_TRANSITION", "This post cannot be hidden.");
            to = "hidden";
            break;
          case "unhide":
            if (from !== "hidden") throw conflict("COMMUNITY_BAD_TRANSITION", "This post is not hidden.");
            to = "published";
            break;
          case "remove":
            if (from === "removed" || from === "deleted") throw conflict("COMMUNITY_BAD_TRANSITION", "This post has already been removed.");
            to = "removed";
            break;
        }
        await tx.update(communityPosts).set({ state: to, version: sql`${communityPosts.version} + 1`, updatedAt: now() }).where(and(eq(communityPosts.id, post.id), eq(communityPosts.version, post.version)));
        let notified = 0;
        if (from === "published" && to !== "published") await onUnpublished(tx, topic, post);
        if (from !== "published" && to === "published") notified = await onPublished(tx, topic, post);
        if (post.isOpening && to === "removed") await tx.update(communityTopics).set({ state: "removed", version: sql`${communityTopics.version} + 1` }).where(eq(communityTopics.id, topic.id));
        await logModeration(tx, actor, input.action, "post", post.publicId, input.reason?.trim().slice(0, 200) || null);
        return { state: to, notified };
      });
    },

    async moderateTopic(principal: SessionPrincipal, input: { topicPublicId: string; action: "lock" | "unlock" | "pin" | "unpin" | "move"; categoryPublicId?: string; reason?: string }): Promise<TopicSummaryView> {
      return moderatorTx(principal, async (tx, actor) => {
        const topic = await loadTopic(input.topicPublicId, tx, actor, true);
        const set: Partial<typeof communityTopics.$inferInsert> = {};
        if (input.action === "lock") set.locked = true;
        if (input.action === "unlock") set.locked = false;
        if (input.action === "pin") set.pinned = true;
        if (input.action === "unpin") set.pinned = false;
        if (input.action === "move") {
          if (!input.categoryPublicId) throw validation("COMMUNITY_CATEGORY_REQUIRED", "Choose the category to move the topic to.");
          const target = await loadCategory(input.categoryPublicId, tx, actor);
          if (target.archived) throw validation("COMMUNITY_CATEGORY_ARCHIVED", "That category is archived.");
          set.categoryId = target.id;
          if (topic.visible && target.id !== topic.categoryId) {
            await tx.update(communityCategories).set({ topicCount: sql`GREATEST(${communityCategories.topicCount}, 1) - 1` }).where(eq(communityCategories.id, topic.categoryId));
            await tx.update(communityCategories).set({ topicCount: sql`${communityCategories.topicCount} + 1` }).where(eq(communityCategories.id, target.id));
          }
        }
        await tx.update(communityTopics).set({ ...set, version: sql`${communityTopics.version} + 1` }).where(eq(communityTopics.id, topic.id));
        await logModeration(tx, actor, input.action, "topic", topic.publicId, input.reason?.trim().slice(0, 200) || null);
        const [after] = await tx.select().from(communityTopics).where(eq(communityTopics.id, topic.id)).limit(1);
        return (await topicViews([after!], tx))[0]!;
      });
    },

    async suspend(principal: SessionPrincipal, input: { memberPublicId: string; days: number | null; reason: string }): Promise<{ suspendedUntil: string | null; indefinite: boolean }> {
      const reason = input.reason.normalize("NFC").replace(/\s+/gu, " ").trim();
      if (reason.length < 3 || reason.length > 200) throw validation("COMMUNITY_REASON_LENGTH", "Give a reason of 3 to 200 characters.");
      return moderatorTx(principal, async (tx, actor) => {
        const [target] = await tx
          .select({ p: communityProfiles, role: users.role })
          .from(communityProfiles)
          .innerJoin(users, and(eq(users.id, communityProfiles.userId), liveUserPredicate(users)))
          .where(eq(communityProfiles.publicId, input.memberPublicId))
          .limit(1)
          .for("update");
        if (!target) throw notFound();
        if (target.p.userId === actor.userId) throw validation("COMMUNITY_SELF_SUSPEND", "You cannot suspend yourself.");
        if (target.role !== "customer" && actor.role !== "admin") throw forbidden("COMMUNITY_CANNOT_SUSPEND_STAFF");
        const until = input.days === null ? null : new Date(now().getTime() + input.days * 86_400_000);
        await tx.update(communityProfiles).set({ suspendedUntil: until, suspendedIndefinitely: until === null, suspensionReason: reason, suspendedByUserId: actor.userId, version: sql`${communityProfiles.version} + 1` }).where(eq(communityProfiles.id, target.p.id));
        await logModeration(tx, actor, "suspend", "member", target.p.publicId, reason);
        await audit(tx, actor, { category: "admin", eventName: "community.member.suspended", action: "suspend", outcome: "completed", resource: { type: "community_profile", publicId: target.p.publicId }, attributes: { indefinite: until === null, days: input.days } });
        return { suspendedUntil: until ? iso(until) : null, indefinite: until === null };
      });
    },

    async unsuspend(principal: SessionPrincipal, input: { memberPublicId: string; reason?: string }): Promise<{ suspended: false }> {
      return moderatorTx(principal, async (tx, actor) => {
        const [targetRow] = await tx
          .select({ p: communityProfiles })
          .from(communityProfiles)
          .innerJoin(users, and(eq(users.id, communityProfiles.userId), liveUserPredicate(users)))
          .where(eq(communityProfiles.publicId, input.memberPublicId))
          .limit(1)
          .for("update");
        if (!targetRow) throw notFound();
        const target = targetRow.p;
        await tx.update(communityProfiles).set({ suspendedUntil: null, suspendedIndefinitely: false, suspensionReason: null, suspendedByUserId: null, version: sql`${communityProfiles.version} + 1` }).where(eq(communityProfiles.id, target.id));
        await logModeration(tx, actor, "unsuspend", "member", target.publicId, input.reason?.trim().slice(0, 200) || null);
        await audit(tx, actor, { category: "admin", eventName: "community.member.unsuspended", action: "unsuspend", outcome: "completed", resource: { type: "community_profile", publicId: target.publicId } });
        return { suspended: false };
      });
    },

    async moderationLog(principal: SessionPrincipal, input: { cursor?: string }): Promise<Page<ModerationLogView>> {
      const before = input.cursor !== undefined ? Number(input.cursor) : undefined;
      if (input.cursor !== undefined && !/^\d{1,18}$/u.test(input.cursor)) throw validation("COMMUNITY_BAD_CURSOR", "The page link is no longer valid.");
      return moderatorTx(principal, async (tx) => {
        const rows = await tx.select().from(communityModerationLog).where(before !== undefined ? lt(communityModerationLog.id, before) : undefined).orderBy(desc(communityModerationLog.id)).limit(PAGE_LIMIT + 1);
        const page = rows.slice(0, PAGE_LIMIT);
        const map = await authors(page.map((r) => r.actorUserId).filter((id): id is number => id !== null), tx);
        return {
          items: page.map((r) => ({
            publicId: r.publicId,
            action: r.action,
            targetType: r.targetType,
            targetPublicId: r.targetPublicId,
            reason: r.reason,
            actor: r.actorUserId === null ? "Automatic" : authorOf(map, r.actorUserId).displayName,
            createdAt: iso(r.createdAt),
          })),
          nextCursor: rows.length > PAGE_LIMIT ? String(page[page.length - 1]!.id) : null,
        };
      });
    },

    /* ----------------------------------------------------------------- admin */

    async getSettings(principal: SessionPrincipal): Promise<{ enabled: boolean; config: CommunityConfig; categories: CategoryView[] }> {
      return adminTx(principal, async (tx) => {
        const cats = await tx.select().from(communityCategories).orderBy(asc(communityCategories.sortOrder), asc(communityCategories.id)).limit(200);
        return { enabled: await isEnabled(tx), config: await config(tx), categories: cats.map(categoryView) };
      });
    },

    async updateSettings(principal: SessionPrincipal, input: CommunityConfig): Promise<CommunityConfig> {
      const parsed = communityConfigSchema.parse(input);
      const dedupe = (list: string[]) => [...new Map(list.map((w) => [w.toLowerCase(), w])).values()];
      const next: CommunityConfig = { ...parsed, blockedWords: dedupe(parsed.blockedWords), heldWords: dedupe(parsed.heldWords) };
      return adminTx(principal, async (tx, actor) => {
        const before = await config(tx);
        await writeSetting(deps.settings, COMMUNITY_CONFIG, next, tx);
        const changed = (Object.keys(next) as (keyof CommunityConfig)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
        await audit(tx, actor, {
          category: "admin",
          eventName: "community.settings.updated",
          action: "update",
          outcome: "completed",
          resource: { type: "setting", id: COMMUNITY_CONFIG.key },
          attributes: { changed_fields: changed.join(",").slice(0, 200) } as AuditAttrs,
          safeCounts: { blocked_words: next.blockedWords.length, held_words: next.heldWords.length },
        });
        return next;
      });
    },

    async setEnabled(principal: SessionPrincipal, input: { enabled: boolean }): Promise<{ enabled: boolean }> {
      return adminTx(principal, async (tx, actor) => {
        const before = await isEnabled(tx);
        if (before === input.enabled) return { enabled: before };
        await deps.settings.set(COMMUNITY_FLAG.key, input.enabled, tx);
        await audit(tx, actor, {
          category: "admin",
          eventName: "community.enabled.changed",
          action: "update",
          outcome: "completed",
          severity: "WARN",
          resource: { type: "setting", id: COMMUNITY_FLAG.key },
          attributes: { enabled: input.enabled, previous: before },
        });
        return { enabled: input.enabled };
      });
    },

    async createCategory(principal: SessionPrincipal, input: { slug: string; name: string; description?: string; staffOnlyPosting?: boolean }): Promise<CategoryView> {
      return adminTx(principal, async (tx, actor) => {
        const slug = input.slug.toLowerCase();
        const [dup] = await tx.select({ id: communityCategories.id }).from(communityCategories).where(eq(communityCategories.slug, slug)).limit(1);
        if (dup) throw conflict("COMMUNITY_SLUG_TAKEN", "A category with that address already exists.");
        const [max] = await tx.select({ n: sql<number>`COALESCE(MAX(${communityCategories.sortOrder}), 0)` }).from(communityCategories);
        const [{ n: total } = { n: 0 }] = await tx.select({ n: count() }).from(communityCategories);
        if (total >= 100) throw validation("COMMUNITY_CATEGORY_LIMIT", "There can be at most 100 categories.");
        await tx.insert(communityCategories).values({ slug, name: input.name.trim(), description: (input.description ?? "").trim(), staffOnlyPosting: input.staffOnlyPosting ?? false, sortOrder: Number(max?.n ?? 0) + 10, createdAt: now(), updatedAt: now() });
        const [row] = await tx.select().from(communityCategories).where(eq(communityCategories.slug, slug)).limit(1);
        await audit(tx, actor, { category: "admin", eventName: "community.category.changed", action: "create", outcome: "completed", resource: { type: "community_category", publicId: row!.publicId }, attributes: { staff_only_posting: row!.staffOnlyPosting } });
        return categoryView(row!);
      });
    },

    async updateCategory(principal: SessionPrincipal, input: { categoryPublicId: string; expectedVersion: number; name?: string; description?: string; staffOnlyPosting?: boolean; archived?: boolean }): Promise<CategoryView> {
      return adminTx(principal, async (tx, actor) => {
        const [row] = await tx.select().from(communityCategories).where(eq(communityCategories.publicId, input.categoryPublicId)).limit(1).for("update");
        if (!row) throw notFound();
        if (row.version !== input.expectedVersion) throw conflict("STALE_VERSION", "This category changed since you opened it. Reload and try again.");
        await tx
          .update(communityCategories)
          .set({
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.description !== undefined ? { description: input.description.trim() } : {}),
            ...(input.staffOnlyPosting !== undefined ? { staffOnlyPosting: input.staffOnlyPosting } : {}),
            ...(input.archived !== undefined ? { archived: input.archived } : {}),
            version: sql`${communityCategories.version} + 1`,
            updatedAt: now(),
          })
          .where(eq(communityCategories.id, row.id));
        const [after] = await tx.select().from(communityCategories).where(eq(communityCategories.id, row.id)).limit(1);
        await audit(tx, actor, {
          category: "admin",
          eventName: "community.category.changed",
          action: input.archived === true ? "archive" : "update",
          outcome: "completed",
          resource: { type: "community_category", publicId: row.publicId },
          attributes: { archived: after!.archived, staff_only_posting: after!.staffOnlyPosting },
        });
        return categoryView(after!);
      });
    },

    async reorderCategories(principal: SessionPrincipal, input: { orderedPublicIds: string[] }): Promise<CategoryView[]> {
      if (new Set(input.orderedPublicIds).size !== input.orderedPublicIds.length) throw validation("COMMUNITY_DUPLICATE_IDS", "Each category may appear only once.");
      return adminTx(principal, async (tx, actor) => {
        const rows = await tx.select().from(communityCategories).for("update");
        const byPublic = new Map(rows.map((r) => [r.publicId, r]));
        if (input.orderedPublicIds.length !== rows.length || input.orderedPublicIds.some((id) => !byPublic.has(id))) {
          throw conflict("COMMUNITY_REORDER_MISMATCH", "The category list changed. Reload and try again.");
        }
        let order = 10;
        for (const id of input.orderedPublicIds) {
          await tx.update(communityCategories).set({ sortOrder: order, version: sql`${communityCategories.version} + 1` }).where(eq(communityCategories.id, byPublic.get(id)!.id));
          order += 10;
        }
        await audit(tx, actor, { category: "admin", eventName: "community.category.changed", action: "reorder", outcome: "completed", resource: { type: "community_category" }, safeCounts: { categories: rows.length } });
        const after = await tx.select().from(communityCategories).orderBy(asc(communityCategories.sortOrder));
        return after.map(categoryView);
      });
    },

    /* ------------------------------------------------------------- ports */

    async anonymiseMember(userId: number, tx: Tx): Promise<void> {
      const [p] = await tx.select().from(communityProfiles).where(eq(communityProfiles.userId, userId)).limit(1).for("update");
      if (!p || p.anonymised) return;
      await tx.update(communityProfiles).set({ displayName: FORMER_MEMBER, displayNameKey: `former ${p.publicId.toLowerCase()}`, anonymised: true, version: sql`${communityProfiles.version} + 1` }).where(eq(communityProfiles.id, p.id));
      await tx.delete(communitySubscriptions).where(eq(communitySubscriptions.userId, userId));
      await audit(tx, null, { category: "admin", eventName: "community.profile.saved", action: "anonymise", outcome: "completed", resource: { type: "community_profile", publicId: p.publicId } });
    },
  };
}

export type CommunityService = ReturnType<typeof createCommunityService>;
