/**
 * Increment 09 (D2.5 & D2.8): Knowledge Base TrashParticipant (`module: "knowledge"`).
 *
 * - `summarize`: returns `{}` (knowledge holds no order rows and only optional per-customer article feedback/tickets).
 * - `purge`: fail-closed verification that the customer account is marked for purge (`trashed_at && purge_started_at`,
 *   or already tombstoned), deletes short-lived attachment download tickets and article feedback comments/ratings for
 *   the customer, and refreshes denormalised helpful counts on affected articles.
 */
import { and, count, eq, inArray } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { conflict, notFound } from "../../core/errors.js";
import type { Tx } from "../../core/types.js";
import { liveUserPredicate } from "../identity/live.js";
import { users } from "../identity/schema.js";
import type { TrashEntityRef, TrashParticipant, TrashPurgeResult } from "../trash/ports.js";
import {
  knowledgeArticleFeedback,
  knowledgeArticles,
  knowledgeAttachmentTickets,
} from "./schema.js";

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

export function createKnowledgeTrashParticipant(deps: ModuleDeps): TrashParticipant {
  const { db } = deps;

  return {
    module: "knowledge",

    async summarize(): Promise<Record<string, number>> {
      return {};
    },

    async purge(entity: TrashEntityRef): Promise<TrashPurgeResult> {
      if (entity.kind !== "customer") {
        return { deleted: {} };
      }

      return db.transaction(async (tx) => {
        await assertCustomerPurgeAuthorizedInTx(tx, entity);

        const ticketRes = await tx
          .delete(knowledgeAttachmentTickets)
          .where(eq(knowledgeAttachmentTickets.userId, entity.id));

        const fbRows = await tx
          .select({ id: knowledgeArticleFeedback.id, articleId: knowledgeArticleFeedback.articleId })
          .from(knowledgeArticleFeedback)
          .where(eq(knowledgeArticleFeedback.userId, entity.id));

        const affectedArticleIds = [...new Set(fbRows.map((r) => r.articleId))];
        let deletedFeedback = 0;
        if (fbRows.length > 0) {
          const fbRes = await tx
            .delete(knowledgeArticleFeedback)
            .where(inArray(knowledgeArticleFeedback.id, fbRows.map((r) => r.id)));
          deletedFeedback = affectedCount(fbRes);
        }

        for (const articleId of affectedArticleIds) {
          const [[yesRow], [noRow]] = await Promise.all([
            tx
              .select({ total: count(knowledgeArticleFeedback.id) })
              .from(knowledgeArticleFeedback)
              .innerJoin(users, and(eq(users.id, knowledgeArticleFeedback.userId), liveUserPredicate(users)))
              .where(
                and(
                  eq(knowledgeArticleFeedback.articleId, articleId),
                  eq(knowledgeArticleFeedback.helpful, true),
                ),
              ),
            tx
              .select({ total: count(knowledgeArticleFeedback.id) })
              .from(knowledgeArticleFeedback)
              .innerJoin(users, and(eq(users.id, knowledgeArticleFeedback.userId), liveUserPredicate(users)))
              .where(
                and(
                  eq(knowledgeArticleFeedback.articleId, articleId),
                  eq(knowledgeArticleFeedback.helpful, false),
                ),
              ),
          ]);
          await tx
            .update(knowledgeArticles)
            .set({
              helpfulYesCount: Number(yesRow?.total ?? 0),
              helpfulNoCount: Number(noRow?.total ?? 0),
            })
            .where(eq(knowledgeArticles.id, articleId));
        }

        const deletedTickets = affectedCount(ticketRes);
        const deleted: Record<string, number> = {};
        if (deletedFeedback > 0) deleted.articleFeedback = deletedFeedback;
        if (deletedTickets > 0) deleted.attachmentTickets = deletedTickets;
        return { deleted };
      });
    },
  };
}
