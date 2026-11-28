/**
 * Referrals trash participant (Increment 09, D2.2 / D2.5 / D2.6 / D2.8). Owner: siem_engineer.
 *
 * Contract invariants:
 * - Referral links (`referral_codes`) and email invite rate-limit rows (`referral_email_invites`)
 *   of a permanently deleted customer are erased so the old referral link/code can never resolve
 *   or re-attach to any account.
 * - Numeric referral attribution/redemption rows (`referrals`) and reward ledger figures
 *   (`referral_reward_ledger`) stay as numbers with free-text notes/references scrubbed.
 * - When `referrals` rows reference `referral_codes.id` (`NOT NULL` FK), the code column (`CHAR(10)`)
 *   is overwritten with a unique non-alphabet tombstone placeholder (`~000000001`, `active = false`)
 *   rejected by `REFERRAL_CODE_REGEX`, and `referrals.code_snapshot` is overwritten with `~ERASED~~~`;
 *   when zero `referrals` rows reference it, the `referral_codes` row is deleted outright.
 */
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import type { TrashEntityRef, TrashParticipant, TrashPurgeResult } from "../trash/ports.js";
import {
  referralCodes,
  referralEmailInvites,
  referralRewardLedger,
  referrals,
} from "./schema.js";

const ERASED_SNAPSHOT = "~ERASED~~~";

function erasedCodeForId(codeRowId: number): string {
  return `~${String(codeRowId).padStart(9, "0").slice(-9)}`;
}

function affectedCount(res: unknown): number {
  const header = Array.isArray(res) ? res[0] : res;
  if (header && typeof header === "object" && "affectedRows" in header) {
    return Number((header as { affectedRows?: number }).affectedRows ?? 0);
  }
  return 0;
}

export function createReferralsTrashParticipant(deps: ModuleDeps): TrashParticipant {
  return {
    module: "referrals",

    async summarize(entity: TrashEntityRef): Promise<Record<string, number>> {
      if (entity.kind !== "customer") return {};
      const [codeRow] = await deps.db
        .select({ code: referralCodes.code })
        .from(referralCodes)
        .where(eq(referralCodes.userId, entity.id))
        .limit(1);
      if (!codeRow || codeRow.code.startsWith("~")) return {};
      return { referralLinks: 1 };
    },

    async purge(entity: TrashEntityRef): Promise<TrashPurgeResult> {
      const deleted: Record<string, number> = {};
      const kept: Record<string, number> = {};
      const now = deps.clock.now();

      if (entity.kind === "order") {
        const scrubOrderRes = await deps.db
          .update(referrals)
          .set({
            reviewReason: null,
            payoutReference: null,
            payoutNote: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(referrals.qualifyingOrderPublicId, entity.publicId),
              or(
                isNotNull(referrals.reviewReason),
                isNotNull(referrals.payoutReference),
                isNotNull(referrals.payoutNote),
              ),
            ),
          );
        const scrubbed = affectedCount(scrubOrderRes);
        if (scrubbed > 0) deleted.referralNotes = scrubbed;
        return { deleted };
      }

      const [codeRow] = await deps.db
        .select({
          id: referralCodes.id,
          code: referralCodes.code,
          active: referralCodes.active,
        })
        .from(referralCodes)
        .where(eq(referralCodes.userId, entity.id))
        .limit(1);

      const inviteRes = await deps.db
        .delete(referralEmailInvites)
        .where(
          codeRow
            ? or(
                eq(referralEmailInvites.senderUserId, entity.id),
                eq(referralEmailInvites.referralCodeId, codeRow.id),
              )
            : eq(referralEmailInvites.senderUserId, entity.id),
        );
      const invitesDeleted = affectedCount(inviteRes);
      if (invitesDeleted > 0) deleted.referralEmailInvites = invitesDeleted;

      const custReferralRows = await deps.db
        .select({ id: referrals.id })
        .from(referrals)
        .where(or(eq(referrals.referrerUserId, entity.id), eq(referrals.referredUserId, entity.id)));
      const custReferralIds = custReferralRows.map((r) => r.id);

      if (custReferralIds.length > 0) {
        const scrubRefRes = await deps.db
          .update(referrals)
          .set({
            reviewReason: null,
            payoutReference: null,
            payoutNote: null,
            updatedAt: now,
          })
          .where(
            and(
              inArray(referrals.id, custReferralIds),
              or(
                isNotNull(referrals.reviewReason),
                isNotNull(referrals.payoutReference),
                isNotNull(referrals.payoutNote),
              ),
            ),
          );
        const scrubbedRefs = affectedCount(scrubRefRes);
        if (scrubbedRefs > 0) deleted.referralNotes = scrubbedRefs;

        const scrubLedgerRes = await deps.db
          .update(referralRewardLedger)
          .set({ reference: null, note: null })
          .where(
            and(
              inArray(referralRewardLedger.referralId, custReferralIds),
              or(isNotNull(referralRewardLedger.reference), isNotNull(referralRewardLedger.note)),
            ),
          );
        const scrubbedLedger = affectedCount(scrubLedgerRes);
        if (scrubbedLedger > 0) deleted.referralLedgerNotes = scrubbedLedger;

        kept.referralAttributions = custReferralIds.length;
      }

      if (codeRow) {
        const [refCountRow] = await deps.db
          .select({ count: sql<number>`count(*)` })
          .from(referrals)
          .where(eq(referrals.referralCodeId, codeRow.id));
        const refCount = Number(refCountRow?.count ?? 0);

        if (refCount === 0) {
          const delCodeRes = await deps.db
            .delete(referralCodes)
            .where(eq(referralCodes.id, codeRow.id));
          if (affectedCount(delCodeRes) > 0) {
            deleted.referralLinks = 1;
          }
        } else {
          await deps.db
            .update(referrals)
            .set({ codeSnapshot: ERASED_SNAPSHOT, updatedAt: now })
            .where(
              and(
                eq(referrals.referralCodeId, codeRow.id),
                ne(referrals.codeSnapshot, ERASED_SNAPSHOT),
              ),
            );

          const placeholder = erasedCodeForId(codeRow.id);
          if (codeRow.code !== placeholder || codeRow.active) {
            await deps.db
              .update(referralCodes)
              .set({
                code: placeholder,
                active: false,
                updatedAt: now,
              })
              .where(eq(referralCodes.id, codeRow.id));
            deleted.referralLinks = 1;
          }
        }
      }

      return Object.keys(kept).length > 0 ? { deleted, kept } : { deleted };
    },
  };
}
