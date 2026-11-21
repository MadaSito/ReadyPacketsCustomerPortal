import { z } from "zod";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import {
  adminProcedure,
  protectedProcedure,
  publicProcedure,
  requireCapability,
  router,
  staffProcedure,
} from "../../trpc/trpc.js";
import type { ReferralsModule } from "./index.js";
import {
  REFERRAL_LEDGER_ENTRY_TYPES,
  REFERRAL_PAYOUT_METHODS,
  REFERRAL_STATUSES,
} from "./schema.js";
import { referralProgramConfigSchema } from "./settings.js";

function referralsSvc(services: Services): ReferralsModule {
  const svc = (services as Services & { referrals?: ReferralsModule }).referrals;
  if (!svc) {
    throw new DomainError(
      "UNAVAILABLE",
      "REFERRALS_NOT_MOUNTED",
      "Referrals module is not mounted.",
    );
  }
  return svc;
}

const publicIdField = z
  .string()
  .length(26)
  .regex(ULID_PATTERN, "Invalid identifier.");

const cursorInputFields = {
  cursor: z.string().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

export const referralsRouter = router({
  publicStatus: publicProcedure
    .meta({ rateLimit: "standard_browsing" })
    .input(
      z
        .strictObject({
          code: z.string().max(32).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => referralsSvc(ctx.services).publicStatus(input)),

  me: router({
    overview: protectedProcedure.query(({ ctx }) =>
      referralsSvc(ctx.services).customerOverview(ctx.session),
    ),

    history: protectedProcedure
      .input(z.strictObject(cursorInputFields).optional())
      .query(({ ctx, input }) =>
        referralsSvc(ctx.services).customerHistory(ctx.session, input ?? {}),
      ),

    sendInviteEmail: protectedProcedure
      .meta({ rateLimit: "form_submission" })
      .input(
        z.strictObject({
          recipientEmail: z.string().trim().min(5).max(254),
        }),
      )
      .mutation(({ ctx, input }) =>
        referralsSvc(ctx.services).sendInviteEmail(ctx.session, input),
      ),
  }),

  admin: router({
    getSettings: staffProcedure
      .use(requireCapability("referrals.read_all"))
      .query(({ ctx }) => referralsSvc(ctx.services).adminGetSettings(ctx.session)),

    updateSettings: adminProcedure
      .use(requireCapability("referrals.manage"))
      .input(
        z.strictObject({
          enabled: z.boolean(),
          config: referralProgramConfigSchema,
        }),
      )
      .mutation(({ ctx, input }) =>
        referralsSvc(ctx.services).adminUpdateSettings(ctx.session, input),
      ),

    list: staffProcedure
      .use(requireCapability("referrals.read_all"))
      .input(
        z
          .strictObject({
            status: z.enum(REFERRAL_STATUSES).optional(),
            query: z.string().max(64).optional(),
            from: z.coerce.date().optional(),
            to: z.coerce.date().optional(),
            ...cursorInputFields,
          })
          .optional(),
      )
      .query(({ ctx, input }) =>
        referralsSvc(ctx.services).adminList(ctx.session, input ?? {}),
      ),

    ledger: staffProcedure
      .use(requireCapability("referrals.read_all"))
      .input(
        z
          .strictObject({
            entryType: z.enum(REFERRAL_LEDGER_ENTRY_TYPES).optional(),
            ...cursorInputFields,
          })
          .optional(),
      )
      .query(({ ctx, input }) =>
        referralsSvc(ctx.services).adminLedger(ctx.session, input ?? {}),
      ),

    approve: adminProcedure
      .use(requireCapability("referrals.manage"))
      .input(
        z.strictObject({
          referralPublicId: publicIdField,
          expectedVersion: z.number().int().min(1),
          overrideAmountMinor: z.number().int().min(1).max(100_000_000).optional(),
          note: z.string().max(500).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        referralsSvc(ctx.services).adminApprove(ctx.session, input),
      ),

    reject: adminProcedure
      .use(requireCapability("referrals.manage"))
      .input(
        z.strictObject({
          referralPublicId: publicIdField,
          expectedVersion: z.number().int().min(1),
          reason: z.string().trim().min(3).max(500),
        }),
      )
      .mutation(({ ctx, input }) =>
        referralsSvc(ctx.services).adminReject(ctx.session, input),
      ),

    markCredited: adminProcedure
      .use(requireCapability("referrals.manage"))
      .input(
        z.strictObject({
          referralPublicId: publicIdField,
          expectedVersion: z.number().int().min(1),
          payoutMethod: z.enum(REFERRAL_PAYOUT_METHODS),
          reference: z.string().trim().min(2).max(160),
          note: z.string().max(500).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        referralsSvc(ctx.services).adminMarkCredited(ctx.session, input),
      ),

    export: adminProcedure
      .use(requireCapability("referrals.manage"))
      .meta({ rateLimit: "expensive" })
      .input(
        z.strictObject({
          format: z.enum(["csv", "json"]),
          status: z.enum(REFERRAL_STATUSES).optional(),
          query: z.string().max(64).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        referralsSvc(ctx.services).adminExport(ctx.session, input),
      ),
  }),
});

export type ReferralsRouter = typeof referralsRouter;
