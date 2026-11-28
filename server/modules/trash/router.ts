/**
 * Trash centre tRPC router (Increment 09, Decision D2 & D2.8). Owner: recovery_ops_engineer.
 *
 * Capability gates (each re-verified inside mutating DB transactions via `guardActorInTx`):
 *   - `trash.read`: `list`, `counts`, `movedByOptions`, `summarize`, `settings.get`, `settings.preview`
 *   - `trash.manage`: `moveToTrash`, `restore`
 *   - `trash.purge` [step-up]: `purge`, `finishLeavingExternalCopies`
 *   - `trash.retention.manage` [step-up]: `settings.update`
 */
import { z } from "zod";
import { DomainError } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { protectedProcedure, requireCapability, router } from "../../trpc/trpc.js";
import type { TrashModule } from "./index.js";
import { TRASH_RETENTION_MAX_DAYS, TRASH_RETENTION_MIN_DAYS } from "./settings.js";
import type { TrashService } from "./types.js";

function requireCoordinator(mod: TrashModule): TrashService {
  if (typeof mod.list !== "function") {
    throw new DomainError("UNAVAILABLE", "TRASH_UNAVAILABLE", "Trash service is temporarily unavailable.");
  }
  return mod as TrashService;
}

const trashReadProcedure = protectedProcedure.use(requireCapability("trash.read"));
const trashManageProcedure = protectedProcedure.use(requireCapability("trash.manage"));
const trashPurgeProcedure = protectedProcedure.use(requireCapability("trash.purge"));
const trashRetentionProcedure = protectedProcedure.use(requireCapability("trash.retention.manage"));

const trashKindSchema = z.enum(["order", "customer"]);

const publicIdSchema = z.string().trim().regex(ULID_PATTERN, "Use a valid identifier.");

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, "Include an idempotency key.")
  .max(120, "Idempotency key is too long.");

const trashItemRefSchema = z
  .object({
    kind: trashKindSchema,
    publicId: publicIdSchema,
    batchId: publicIdSchema.optional(),
  })
  .strict();

const retentionValuesSchema = z
  .object({
    autoPurgeEnabled: z.boolean(),
    orderDays: z
      .number()
      .int()
      .min(TRASH_RETENTION_MIN_DAYS, "Use a whole number between 7 and 3,650 days.")
      .max(TRASH_RETENTION_MAX_DAYS, "Use a whole number between 7 and 3,650 days."),
    customerDays: z
      .number()
      .int()
      .min(TRASH_RETENTION_MIN_DAYS, "Use a whole number between 7 and 3,650 days.")
      .max(TRASH_RETENTION_MAX_DAYS, "Use a whole number between 7 and 3,650 days."),
  })
  .strict();

export const trashRouter = router({
  list: trashReadProcedure
    .input(
      z
        .object({
          kind: trashKindSchema,
          q: z.string().max(160).optional(),
          movedFrom: z.string().max(64).optional(),
          movedTo: z.string().max(64).optional(),
          movedByPublicId: publicIdSchema.optional(),
          dueWithinDays: z.number().int().min(1).max(3650).optional(),
          sort: z.enum(["movedAt", "dueAt"]),
          dir: z.enum(["asc", "desc"]),
          cursor: z.string().max(512).nullable().optional(),
          limit: z.number().int().min(1).max(100),
        })
        .strict(),
    )
    .query(({ ctx, input }) => requireCoordinator(ctx.services.trash).list(ctx.session, input)),

  counts: trashReadProcedure.query(({ ctx }) => requireCoordinator(ctx.services.trash).counts(ctx.session)),

  movedByOptions: trashReadProcedure.query(({ ctx }) =>
    requireCoordinator(ctx.services.trash).movedByOptions(ctx.session),
  ),

  summarize: trashReadProcedure
    .input(trashItemRefSchema)
    .query(({ ctx, input }) => requireCoordinator(ctx.services.trash).summarize(ctx.session, input)),

  moveToTrash: trashManageProcedure
    .input(
      z
        .object({
          kind: trashKindSchema,
          publicId: publicIdSchema,
          batchId: publicIdSchema.optional(),
          reason: z.string().max(240).optional(),
          idempotencyKey: idempotencyKeySchema,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) => requireCoordinator(ctx.services.trash).moveToTrash(ctx.session, input)),

  restore: trashManageProcedure
    .input(
      z
        .object({
          items: z.array(trashItemRefSchema).min(1).max(100),
          idempotencyKey: idempotencyKeySchema,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) => requireCoordinator(ctx.services.trash).restore(ctx.session, input)),

  purge: trashPurgeProcedure
    .input(
      z
        .object({
          items: z.array(trashItemRefSchema).min(1).max(100),
          confirmation: z.string().max(160),
          idempotencyKey: idempotencyKeySchema,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) => requireCoordinator(ctx.services.trash).purge(ctx.session, input)),

  finishLeavingExternalCopies: trashPurgeProcedure
    .input(
      z
        .object({
          kind: trashKindSchema,
          publicId: publicIdSchema,
          batchId: publicIdSchema.optional(),
          runId: publicIdSchema,
          confirmation: z.string().max(160),
          idempotencyKey: idempotencyKeySchema,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      requireCoordinator(ctx.services.trash).finishLeavingExternalCopies(ctx.session, input),
    ),

  settings: router({
    get: trashReadProcedure.query(({ ctx }) => requireCoordinator(ctx.services.trash).getSettings(ctx.session)),

    preview: trashReadProcedure
      .input(retentionValuesSchema)
      .query(({ ctx, input }) => requireCoordinator(ctx.services.trash).previewSettings(ctx.session, input)),

    update: trashRetentionProcedure
      .input(
        retentionValuesSchema
          .extend({
            expectedVersion: z.number().int().min(1),
            reviewedDueCount: z.number().int().min(0).optional(),
            confirmation: z.string().max(160).optional(),
            idempotencyKey: idempotencyKeySchema,
          })
          .strict(),
      )
      .mutation(({ ctx, input }) => requireCoordinator(ctx.services.trash).updateSettings(ctx.session, input)),
  }),
});

export type TrashRouter = typeof trashRouter;
