/**
 * Increment 09 (D2.5 & D2.8): Community TrashParticipant (`module: "community"`).
 *
 * Thread-integrity deletion model (aligned with existing `POST_STATES` moderation placeholders):
 *  - Customer `summarize`: counts `communityPosts` authored by the customer (`{ communityPosts }`).
 *  - Customer `purge` (fail-closed unless `trashed_at && purge_started_at`, or already tombstoned):
 *      1. Detaches & anonymises `community_profiles` to `"Deleted account"` (`anonymised = true`, suspension cleared).
 *      2. Removes `community_subscriptions`, `community_reactions` (decrementing `helpful_count`), and
 *         `community_reports` by the customer (decrementing `open_report_count` on open reports).
 *      3. Erases `body_text` (`""`), `body_hash`, `link_count`, and `held_reason` on all customer-authored posts and
 *         sets `state = "deleted"`:
 *           - Standalone opening topics with no live replies from other members (`otherLiveReplies === 0`) are marked
 *             `state = "removed"`, `visible = false`, `title = "Deleted topic"` (decrementing `category.topic_count`
 *             when previously visible).
 *           - Multi-reply threads opened by the customer keep `state = "open"`, `visible = true` so other members'
 *             replies stay reachable, with `title` overwritten to `"Deleted topic"` and the opening post body erased.
 *  - Orders hold no community rows (`summarize` -> `{}`, `purge` -> `{ deleted: {} }`).
 */
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { conflict, notFound } from "../../core/errors.js";
import type { Tx } from "../../core/types.js";
import { liveUserPredicate } from "../identity/live.js";
import { users } from "../identity/schema.js";
import type { TrashEntityRef, TrashParticipant, TrashPurgeResult, TrashPurgeRun } from "../trash/ports.js";
import {
  communityCategories,
  communityPosts,
  communityProfiles,
  communityReactions,
  communityReports,
  communitySubscriptions,
  communityTopics,
} from "./schema.js";
import { bodyHash } from "./text.js";

export const DELETED_ACCOUNT_LABEL = "Deleted account";
export const DELETED_TOPIC_TITLE = "Deleted topic";

function affectedCount(res: unknown): number {
  if (Array.isArray(res) && res[0] && typeof res[0] === "object" && "affectedRows" in res[0]) {
    return Number((res[0] as { affectedRows?: number }).affectedRows ?? 0);
  }
  if (res && typeof res === "object" && "affectedRows" in res) {
    return Number((res as { affectedRows?: number }).affectedRows ?? 0);
  }
  return 0;
}

async function assertCustomerPurgeAuthorizedInTx(tx: Tx, entity: TrashEntityRef): Promise<void> {
  const [usr] = await tx
    .select({
      id: users.id,
      publicId: users.publicId,
      trashedAt: users.trashedAt,
      purgeStartedAt: users.purgeStartedAt,
      purgedAt: users.purgedAt,
    })
    .from(users)
    .where(eq(users.id, entity.id))
    .limit(1)
    .for("update");
  if (!usr || usr.publicId !== entity.publicId) {
    throw notFound("USER_NOT_FOUND");
  }
  const authorized = Boolean(usr.purgedAt) || (Boolean(usr.trashedAt) && Boolean(usr.purgeStartedAt));
  if (!authorized) {
    throw conflict("PURGE_NOT_STARTED", "Account purge has not been initiated by the Trash coordinator.");
  }
}

export function createCommunityTrashParticipant(deps: ModuleDeps): TrashParticipant {
  const { db, clock } = deps;

  return {
    module: "community",

    async summarize(entity: TrashEntityRef): Promise<Record<string, number>> {
      if (entity.kind !== "customer") {
        return {};
      }
      const [row] = await db
        .select({ total: count(communityPosts.id) })
        .from(communityPosts)
        .where(
          and(
            eq(communityPosts.authorUserId, entity.id),
            sql`not (${communityPosts.state} = 'deleted' and ${communityPosts.bodyText} = '')`,
          ),
        );
      const communityPostsCount = Number(row?.total ?? 0);
      return communityPostsCount > 0 ? { communityPosts: communityPostsCount } : {};
    },

    async purge(entity: TrashEntityRef, run: TrashPurgeRun): Promise<TrashPurgeResult> {
      if (entity.kind !== "customer") {
        return { deleted: {} };
      }

      return db.transaction(async (tx) => {
        await run.assertCurrentInTx(tx);
        await assertCustomerPurgeAuthorizedInTx(tx, entity);
        const at = clock.now();
        const emptyHash = bodyHash("");

        // 1.Subscriptions
        const subRes = await tx
          .delete(communitySubscriptions)
          .where(eq(communitySubscriptions.userId, entity.id));
        const deletedSubscriptions = affectedCount(subRes);

        // 2. Reactions (decrement helpfulCount on affected posts)
        const reactions = await tx
          .select({ id: communityReactions.id, postId: communityReactions.postId })
          .from(communityReactions)
          .where(eq(communityReactions.userId, entity.id));
        if (reactions.length > 0) {
          for (const r of reactions) {
            await tx
              .update(communityPosts)
              .set({ helpfulCount: sql`GREATEST(${communityPosts.helpfulCount}, 1) - 1` })
              .where(eq(communityPosts.id, r.postId));
          }
          await tx
            .delete(communityReactions)
            .where(inArray(communityReactions.id, reactions.map((r) => r.id)));
        }

        // 3. Reports filed by the customer (decrement openReportCount on open reports)
        const reports = await tx
          .select({
            id: communityReports.id,
            postId: communityReports.postId,
            state: communityReports.state,
          })
          .from(communityReports)
          .where(eq(communityReports.reporterUserId, entity.id));
        if (reports.length > 0) {
          for (const rep of reports) {
            if (rep.state === "open") {
              await tx
                .update(communityPosts)
                .set({ openReportCount: sql`GREATEST(${communityPosts.openReportCount}, 1) - 1` })
                .where(eq(communityPosts.id, rep.postId));
            }
          }
          await tx
            .delete(communityReports)
            .where(inArray(communityReports.id, reports.map((r) => r.id)));
        }

        // 4. Customer-authored posts & topics (thread-integrity erasure)
        const authoredPosts = await tx
          .select()
          .from(communityPosts)
          .where(eq(communityPosts.authorUserId, entity.id))
          .for("update");

        let erasedPosts = 0;
        const topicIds = [...new Set(authoredPosts.map((p) => p.topicId))];
        const topics =
          topicIds.length > 0
            ? await tx
                .select()
                .from(communityTopics)
                .where(inArray(communityTopics.id, topicIds))
                .for("update")
            : [];
        const topicById = new Map(topics.map((t) => [t.id, t]));

        // Also close any open reports targeting this customer's posts since bodies are erased.
        const authoredPostIds = authoredPosts.map((p) => p.id);
        if (authoredPostIds.length > 0) {
          await tx
            .update(communityReports)
            .set({
              state: "actioned",
              openReporterUserId: null,
              resolvedAt: at,
              resolutionNote: "Author account purged",
            })
            .where(
              and(
                inArray(communityReports.postId, authoredPostIds),
                eq(communityReports.state, "open"),
              ),
            );
        }

        for (const post of authoredPosts) {
          const alreadyErased = post.state === "deleted" && post.bodyText === "";
          const wasPublished = post.state === "published";
          const topic = topicById.get(post.topicId);

          if (!alreadyErased) {
            await tx
              .update(communityPosts)
              .set({
                bodyText: "",
                bodyHash: emptyHash,
                linkCount: 0,
                heldReason: null,
                openReportCount: 0,
                state: "deleted",
                version: sql`${communityPosts.version} + 1`,
                updatedAt: at,
              })
              .where(eq(communityPosts.id, post.id));
            erasedPosts += 1;
          }

          if (!topic) continue;

          if (post.isOpening) {
            // Check whether any live member has published replies in this thread.
            const [liveRepliesRow] = await tx
              .select({ total: count(communityPosts.id) })
              .from(communityPosts)
              .innerJoin(users, and(eq(users.id, communityPosts.authorUserId), liveUserPredicate(users)))
              .where(
                and(
                  eq(communityPosts.topicId, topic.id),
                  eq(communityPosts.isOpening, false),
                  eq(communityPosts.state, "published"),
                  ne(communityPosts.authorUserId, entity.id),
                ),
              );
            const liveReplies = Number(liveRepliesRow?.total ?? 0);

            if (liveReplies === 0) {
              if (topic.visible) {
                await tx
                  .update(communityCategories)
                  .set({ topicCount: sql`GREATEST(${communityCategories.topicCount}, 1) - 1` })
                  .where(eq(communityCategories.id, topic.categoryId));
              }
              await tx
                .update(communityTopics)
                .set({
                  title: DELETED_TOPIC_TITLE,
                  state: "removed",
                  visible: false,
                  replyCount: 0,
                  version: sql`${communityTopics.version} + 1`,
                  updatedAt: at,
                })
                .where(eq(communityTopics.id, topic.id));
              topic.visible = false;
              topic.state = "removed";
            } else {
              await tx
                .update(communityTopics)
                .set({
                  title: DELETED_TOPIC_TITLE,
                  replyCount: liveReplies,
                  version: sql`${communityTopics.version} + 1`,
                  updatedAt: at,
                })
                .where(eq(communityTopics.id, topic.id));
            }
          } else if (wasPublished) {
            await tx
              .update(communityTopics)
              .set({
                replyCount: sql`GREATEST(${communityTopics.replyCount}, 1) - 1`,
                version: sql`${communityTopics.version} + 1`,
                updatedAt: at,
              })
              .where(eq(communityTopics.id, topic.id));
          }
        }

        // 5. Community profile detachment -> "Deleted account"
        const [profile] = await tx
          .select()
          .from(communityProfiles)
          .where(eq(communityProfiles.userId, entity.id))
          .limit(1)
          .for("update");
        if (profile && (!profile.anonymised || profile.displayName !== DELETED_ACCOUNT_LABEL)) {
          await tx
            .update(communityProfiles)
            .set({
              displayName: DELETED_ACCOUNT_LABEL,
              displayNameKey: `deleted ${profile.publicId.toLowerCase()}`,
              anonymised: true,
              postCount: 0,
              suspendedUntil: null,
              suspendedIndefinitely: false,
              suspensionReason: null,
              suspendedByUserId: null,
              version: sql`${communityProfiles.version} + 1`,
              updatedAt: at,
            })
            .where(eq(communityProfiles.id, profile.id));
        }

        const deleted: Record<string, number> = {};
        if (erasedPosts > 0) deleted.communityPosts = erasedPosts;
        if (deletedSubscriptions > 0) deleted.communitySubscriptions = deletedSubscriptions;
        if (reactions.length > 0) deleted.communityReactions = reactions.length;
        if (reports.length > 0) deleted.communityReports = reports.length;
        return { deleted };
      });
    },
  };
}
