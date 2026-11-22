import { z } from "zod";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import {
  adminProcedure,
  requireCapability,
  router,
  staffProcedure,
} from "../../trpc/trpc.js";
import type { PromotionsModule } from "./index.js";
import {
  PROMO_DERIVED_STATUSES,
  PROMO_DISCOUNT_TYPES,
  PROMO_REDEMPTION_STATUSES,
  PROMO_STATUSES,
} from "./schema.js";

function promotionsSvc(services: Services): PromotionsModule {
  const svc = (services as Services & { promotions?: PromotionsModule }).promotions;
  if (!svc) {
    throw new DomainError(
      "UNAVAILABLE",
      "PROMOTIONS_NOT_MOUNTED",
      "Promotions module is not mounted.",
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

const tierKeyField = z.enum(["Basic", "Standard", "Premium"]);

const promotionScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("all"),
  }),
  z.strictObject({
    kind: z.literal("products"),
    productPublicIds: z.array(publicIdField).min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal("tiers"),
    tierKeys: z.array(tierKeyField).min(1).max(10),
  }),
  z.strictObject({
    kind: z.literal("packets"),
    packetNumbers: z.array(z.number().int().min(1).max(255)).min(1).max(100),
  }),
]);

const readGuard = staffProcedure.use(requireCapability("promotions.read"));
const manageGuard = adminProcedure.use(requireCapability("promotions.manage"));

const revealInputSchema = z.strictObject({
  publicId: publicIdField,
  codePublicId: publicIdField.optional(),
});

const statsInputSchema = z
  .strictObject({
    promotionPublicId: publicIdField.optional(),
  })
  .optional();

export const promotionsRouter = router({
  admin: router({
    list: readGuard
      .input(
        z
          .strictObject({
            status: z.enum(PROMO_DERIVED_STATUSES).optional(),
            type: z.enum(PROMO_DISCOUNT_TYPES).optional(),
            endingWithinDays: z.number().int().min(1).max(365).optional(),
            query: z.string().max(120).optional(),
            ...cursorInputFields,
          })
          .optional(),
      )
      .query(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.list(ctx.session, input ?? {}),
      ),

    get: readGuard
      .input(z.strictObject({ publicId: publicIdField }))
      .query(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.get(ctx.session, input.publicId),
      ),

    create: manageGuard
      .input(
        z.strictObject({
          name: z.string().min(1).max(120),
          label: z.string().min(1).max(120),
          type: z.enum(PROMO_DISCOUNT_TYPES),
          percentBps: z.number().int().min(1).max(10_000).nullable().optional(),
          maxDiscountMinor: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
          amountMinor: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
          currency: z.string().length(3).nullable().optional(),
          scope: promotionScopeSchema,
          minSubtotalMinor: z.number().int().min(0).max(1_000_000_000).optional(),
          startsAt: z.string().max(64).nullable().optional(),
          endsAt: z.string().max(64).nullable().optional(),
          maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
          maxPerCustomer: z.number().int().min(1).max(1_000).optional(),
          firstOrderOnly: z.boolean().optional(),
          allowCustomerPublicIds: z.array(publicIdField).max(500).optional(),
          allowEmailDomains: z.array(z.string().min(3).max(120)).max(200).optional(),
          combineWithBundle: z.boolean().optional(),
          note: z.string().max(500).nullable().optional(),
          isBatch: z.boolean().optional(),
          code: z.string().min(1).max(64).optional(),
          codePrefix: z.string().max(16).nullable().optional(),
          initialBatchCount: z.number().int().min(1).max(5_000).optional(),
          idempotencyKey: z.string().min(1).max(80).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.create(ctx.session, input),
      ),

    update: manageGuard
      .input(
        z.strictObject({
          publicId: publicIdField,
          expectedVersion: z.number().int().min(1),
          name: z.string().min(1).max(120).optional(),
          label: z.string().min(1).max(120).optional(),
          maxDiscountMinor: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
          scope: promotionScopeSchema.optional(),
          minSubtotalMinor: z.number().int().min(0).max(1_000_000_000).optional(),
          startsAt: z.string().max(64).nullable().optional(),
          endsAt: z.string().max(64).nullable().optional(),
          maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
          maxPerCustomer: z.number().int().min(1).max(1_000).optional(),
          firstOrderOnly: z.boolean().optional(),
          allowCustomerPublicIds: z.array(publicIdField).max(500).optional(),
          allowEmailDomains: z.array(z.string().min(3).max(120)).max(200).optional(),
          combineWithBundle: z.boolean().optional(),
          note: z.string().max(500).nullable().optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.update(ctx.session, input),
      ),

    pause: manageGuard
      .input(
        z.strictObject({
          publicId: publicIdField,
          expectedVersion: z.number().int().min(1),
        }),
      )
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.pause(ctx.session, input),
      ),

    resume: manageGuard
      .input(
        z.strictObject({
          publicId: publicIdField,
          expectedVersion: z.number().int().min(1),
        }),
      )
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.resume(ctx.session, input),
      ),

    revoke: manageGuard
      .input(
        z.strictObject({
          publicId: publicIdField,
          expectedVersion: z.number().int().min(1),
        }),
      )
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.revoke(ctx.session, input),
      ),

    setStatus: manageGuard
      .input(
        z.strictObject({
          publicId: publicIdField,
          expectedVersion: z.number().int().min(1),
          status: z.enum(PROMO_STATUSES),
        }),
      )
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.setStatus(ctx.session, input),
      ),

    generateBatch: manageGuard
      .meta({ rateLimit: "expensive" })
      .input(
        z.strictObject({
          publicId: publicIdField,
          count: z.number().int().min(1).max(5_000),
          prefix: z.string().max(16).nullable().optional(),
          idempotencyKey: z.string().min(1).max(80),
        }),
      )
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.generateBatch(ctx.session, input),
      ),

    reveal: manageGuard
      .input(revealInputSchema)
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.reveal(ctx.session, input),
      ),

    revealCode: manageGuard
      .input(revealInputSchema)
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.reveal(ctx.session, input),
      ),

    redemptions: readGuard
      .input(
        z
          .strictObject({
            promotionPublicId: publicIdField.optional(),
            status: z.enum(PROMO_REDEMPTION_STATUSES).optional(),
            ...cursorInputFields,
          })
          .optional(),
      )
      .query(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.redemptions(ctx.session, input ?? {}),
      ),

    releaseRedemption: manageGuard
      .input(
        z.strictObject({
          redemptionPublicId: publicIdField,
          reason: z.string().min(3).max(240),
        }),
      )
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.releaseRedemption(ctx.session, input),
      ),

    stats: readGuard
      .input(statsInputSchema)
      .query(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.stats(ctx.session, input ?? {}),
      ),

    totals: readGuard
      .input(statsInputSchema)
      .query(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.stats(ctx.session, input ?? {}),
      ),

    exportCodes: manageGuard
      .meta({ rateLimit: "expensive" })
      .input(z.strictObject({ publicId: publicIdField }))
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.exportCodes(ctx.session, input),
      ),

    exportRedemptions: manageGuard
      .meta({ rateLimit: "expensive" })
      .input(
        z
          .strictObject({
            promotionPublicId: publicIdField.optional(),
            status: z.enum(PROMO_REDEMPTION_STATUSES).optional(),
          })
          .optional(),
      )
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.exportRedemptions(ctx.session, input ?? {}),
      ),

    getSettings: readGuard.query(({ ctx }) =>
      promotionsSvc(ctx.services).admin.getSettings(ctx.session),
    ),

    updateSettings: manageGuard
      .input(
        z.strictObject({
          enabled: z.boolean().optional(),
          maxDiscountPercent: z.number().int().min(1).max(100).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        promotionsSvc(ctx.services).admin.updateSettings(ctx.session, input),
      ),
  }),
});
