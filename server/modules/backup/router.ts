/**
 * Backup module — tRPC router (`trpc.backup.*`). Owner: recovery_ops_engineer.
 *
 * Security surface note:
 *  Per integrator security decision (`REVIEW-audit-siem-backup.md`), web-initiated restore is NOT exposed.
 *  Restore is strictly an offline/operator CLI procedure (`scripts/ops/restore/restore-isolated.ts`) into an
 *  isolated target database and isolated storage directory using dedicated operator credentials.
 */
import { z } from "zod";
import { OPERATION_STATES } from "../../../shared/domain.js";
import { adminProcedure, requireCapability, router } from "../../trpc/trpc.js";

const publicIdSchema = z.string().regex(/^[A-Za-z0-9_-]{10,64}$/);
const reasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);

export const backupRouter = router({
  admin: router({
    list: adminProcedure
      .use(requireCapability("backup.read"))
      .input(
        z
          .object({
            cursor: z.string().max(128).optional(),
            limit: z.number().int().min(1).max(100).optional(),
            state: z.enum(OPERATION_STATES).optional(),
          })
          .optional(),
      )
      .query(({ ctx, input }) => ctx.services.backup.listBackups(ctx.session, input)),

    detail: adminProcedure
      .use(requireCapability("backup.read"))
      .input(z.object({ backupPublicId: publicIdSchema }))
      .query(({ ctx, input }) => ctx.services.backup.getBackup(ctx.session, input.backupPublicId)),

    runNow: adminProcedure
      .meta({ rateLimit: "expensive" })
      .use(requireCapability("backup.run"))
      .input(
        z
          .strictObject({
            trigger: z.enum(["manual", "pre_upgrade"]).optional(),
          })
          .optional(),
      )
      .mutation(({ ctx, input }) => ctx.services.backup.enqueueBackup(ctx.session, input)),

    verify: adminProcedure
      .meta({ rateLimit: "expensive" })
      .use(requireCapability("backup.verify"))
      .input(z.strictObject({ backupPublicId: publicIdSchema }))
      .mutation(({ ctx, input }) => ctx.services.backup.verifyBackup(ctx.session, input.backupPublicId)),

    retentionPolicy: adminProcedure
      .use(requireCapability("backup.read"))
      .query(({ ctx }) => ctx.services.backup.getRetentionPolicy(ctx.session)),

    updateRetentionPolicy: adminProcedure
      .use(requireCapability("backup.retention.manage"))
      .input(
        z.strictObject({
          keepLastCount: z.number().int().min(1).max(365),
          maxAgeDays: z.number().int().min(1).max(3650),
          scheduleEnabled: z.boolean(),
          autoPruneEnabled: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await ctx.services.backup.updateRetentionPolicy(ctx.session, input);
        return { ok: true as const };
      }),

    previewRetention: adminProcedure
      .use(requireCapability("backup.read"))
      .query(({ ctx }) => ctx.services.backup.previewRetention(ctx.session)),

    runRetention: adminProcedure
      .use(requireCapability("backup.retention.manage"))
      .input(z.strictObject({ dryRun: z.boolean() }))
      .mutation(({ ctx, input }) => ctx.services.backup.runRetention(ctx.session, input)),

    createHold: adminProcedure
      .use(requireCapability("backup.retention.manage"))
      .input(
        z.strictObject({
          backupPublicId: publicIdSchema,
          reasonCode: reasonCodeSchema,
          note: z.string().min(3).max(500),
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.backup.createLegalHold(ctx.session, input)),

    releaseHold: adminProcedure
      .use(requireCapability("backup.retention.manage"))
      .input(
        z.strictObject({
          holdPublicId: publicIdSchema,
          releaseReasonCode: reasonCodeSchema,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await ctx.services.backup.releaseLegalHold(ctx.session, input);
        return { ok: true as const };
      }),

    offsiteConfig: adminProcedure
      .use(requireCapability("backup.read"))
      .query(({ ctx }) => ctx.services.backup.getOffsiteConfig(ctx.session)),

    updateOffsiteConfig: adminProcedure
      .use(requireCapability("backup.retention.manage"))
      .use(requireCapability("storage.manage"))
      .input(
        z.strictObject({
          autoCopyAfterVerify: z.boolean(),
          windowDays: z.number().int().min(1).max(90),
          destinations: z
            .array(
              z.strictObject({
                connectionPublicId: publicIdSchema,
                assigned: z.boolean(),
                enabled: z.boolean(),
                retentionNote: z.string().max(240).optional(),
              }),
            )
            .max(50),
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.backup.updateOffsiteConfig(ctx.session, input)),

    copyOffsiteNow: adminProcedure
      .meta({ rateLimit: "expensive" })
      .use(requireCapability("backup.run"))
      .input(
        z.strictObject({
          backupPublicId: publicIdSchema,
          connectionPublicId: publicIdSchema.optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.services.backup.copyOffsiteNow(ctx.session, input)),
  }),
});
