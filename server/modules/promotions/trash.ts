/**
 * Promotions trash participant (Increment 09, D2.2 / D2.5 / D2.6 / D2.8). Owner: siem_engineer.
 *
 * Contract invariants:
 * - Redemption counts (`promo_batches.redemption_count`, `promo_codes.redemption_count`) and numeric
 *   `promo_redemptions` ledger rows stay as numbers on permanent deletion.
 * - Free-text `release_note` on kept `promo_redemptions` rows is scrubbed, per-account `promo_check_attempts`
 *   rows are erased, and the purged customer's `publicId` is removed from `promo_batches.allow_customer_public_ids`.
 * - Every operation is idempotent and resumable across retries.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import type { TrashEntityRef, TrashParticipant, TrashPurgeResult } from "../trash/ports.js";
import { promoBatches, promoCheckAttempts, promoRedemptions } from "./schema.js";

function affectedCount(res: unknown): number {
  const header = Array.isArray(res) ? res[0] : res;
  if (header && typeof header === "object" && "affectedRows" in header) {
    return Number((header as { affectedRows?: number }).affectedRows ?? 0);
  }
  return 0;
}

export function createPromotionsTrashParticipant(deps: ModuleDeps): TrashParticipant {
  return {
    module: "promotions",

    async summarize(entity: TrashEntityRef): Promise<Record<string, number>> {
      if (entity.kind === "order") {
        const [row] = await deps.db
          .select({ count: sql<number>`count(*)` })
          .from(promoRedemptions)
          .where(eq(promoRedemptions.orderPublicId, entity.publicId));
        const count = Number(row?.count ?? 0);
        return count > 0 ? { promoRedemptions: count } : {};
      }
      return {};
    },

    async purge(entity: TrashEntityRef): Promise<TrashPurgeResult> {
      const deleted: Record<string, number> = {};
      const kept: Record<string, number> = {};

      if (entity.kind === "order") {
        const scrubRes = await deps.db
          .update(promoRedemptions)
          .set({ releaseNote: null, updatedAt: deps.clock.now() })
          .where(
            and(
              eq(promoRedemptions.orderPublicId, entity.publicId),
              isNotNull(promoRedemptions.releaseNote),
            ),
          );
        const scrubbed = affectedCount(scrubRes);
        if (scrubbed > 0) deleted.promoReleaseNotes = scrubbed;

        const [keptRow] = await deps.db
          .select({ count: sql<number>`count(*)` })
          .from(promoRedemptions)
          .where(eq(promoRedemptions.orderPublicId, entity.publicId));
        const keptCount = Number(keptRow?.count ?? 0);
        if (keptCount > 0) kept.promoRedemptions = keptCount;

        return Object.keys(kept).length > 0 ? { deleted, kept } : { deleted };
      }

      // Customer purge: erase per-account check-attempt state, scrub free-text release notes,
      // remove customer publicId from allow-lists, and retain numeric redemption counts.
      const attemptsRes = await deps.db
        .delete(promoCheckAttempts)
        .where(eq(promoCheckAttempts.userId, entity.id));
      const erasedAttempts = affectedCount(attemptsRes);
      if (erasedAttempts > 0) deleted.promoCheckAttempts = erasedAttempts;

      const scrubCustRes = await deps.db
        .update(promoRedemptions)
        .set({ releaseNote: null, updatedAt: deps.clock.now() })
        .where(
          and(
            eq(promoRedemptions.customerUserId, entity.id),
            isNotNull(promoRedemptions.releaseNote),
          ),
        );
      const scrubbedCustNotes = affectedCount(scrubCustRes);
      if (scrubbedCustNotes > 0) deleted.promoReleaseNotes = scrubbedCustNotes;

      const candidateBatches = await deps.db
        .select({
          id: promoBatches.id,
          allowCustomerPublicIds: promoBatches.allowCustomerPublicIds,
        })
        .from(promoBatches)
        .where(sql`JSON_CONTAINS(${promoBatches.allowCustomerPublicIds}, JSON_QUOTE(${entity.publicId}))`);

      let allowListScrubbed = 0;
      for (const batch of candidateBatches) {
        const current = Array.isArray(batch.allowCustomerPublicIds) ? batch.allowCustomerPublicIds : [];
        const next = current.filter((id) => id !== entity.publicId);
        if (next.length !== current.length) {
          await deps.db
            .update(promoBatches)
            .set({ allowCustomerPublicIds: next, updatedAt: deps.clock.now() })
            .where(eq(promoBatches.id, batch.id));
          allowListScrubbed += 1;
        }
      }
      if (allowListScrubbed > 0) deleted.promoAllowListEntries = allowListScrubbed;

      const [keptCustRow] = await deps.db
        .select({ count: sql<number>`count(*)` })
        .from(promoRedemptions)
        .where(eq(promoRedemptions.customerUserId, entity.id));
      const keptCustCount = Number(keptCustRow?.count ?? 0);
      if (keptCustCount > 0) kept.promoRedemptions = keptCustCount;

      return Object.keys(kept).length > 0 ? { deleted, kept } : { deleted };
    },
  };
}
