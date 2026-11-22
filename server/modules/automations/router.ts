/**
 * Automations module — tRPC router (`trpc.automations.*`).
 * Matches `server/modules/automations/API.md` §3 and `client/src/features/automations/api.ts`.
 */
import { z } from "zod";
import { ULID_PATTERN } from "../../core/ids.js";
import { adminProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import { conditionTreeSchema } from "./conditions.js";
import {
  AUTOMATION_MAX_ACTIONS,
  AUTOMATION_MAX_SCHEDULE_MINUTES,
  AUTOMATION_MIN_SCHEDULE_MINUTES,
  AUTOMATION_RUN_STATES,
  AUTOMATION_TRIGGER_MODES,
  type AutomationActionStepInput,
  type AutomationCanvasLayout,
  type AutomationTriggerConfig,
} from "./contracts.js";

const readProc = adminProcedure.use(requireCapability("automations.read"));
const manageProc = adminProcedure.use(requireCapability("automations.manage"));
const stageActionsProc = staffProcedure.use(requireCapability("orders.automations.run"));

const stageStepKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,47}$/, "Invalid workflow step key.");

const stageIdempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9:_-]{8,64}$/, "Invalid idempotency key.");

const ulidSchema = z
  .string()
  .trim()
  .regex(ULID_PATTERN, "Expected a valid resource identifier.");

const cursorSchema = z.string().trim().min(1).max(64).nullish();

const triggerSchema: z.ZodType<AutomationTriggerConfig> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("event"),
    triggerKey: z.string().trim().min(1).max(80),
  }),
  z.strictObject({
    kind: z.literal("schedule"),
    everyMinutes: z
      .number()
      .int()
      .min(AUTOMATION_MIN_SCHEDULE_MINUTES)
      .max(AUTOMATION_MAX_SCHEDULE_MINUTES),
  }),
  z.strictObject({
    kind: z.literal("manual"),
    requireOrderPublicId: z.boolean().optional(),
  }),
]);

const actionInputSchema: z.ZodType<AutomationActionStepInput> = z.strictObject({
  stepKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,32}$/, "Invalid step key."),
  actionKey: z.string().trim().min(3).max(80),
  label: z.string().trim().max(80).optional(),
  config: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.string().max(512).nullable()).optional(),
});

const canvasLayoutSchema: z.ZodType<AutomationCanvasLayout> = z.strictObject({
  positions: z.record(
    z.string().max(40),
    z.strictObject({
      x: z.number().min(-10_000).max(10_000),
      y: z.number().min(-10_000).max(10_000),
    }),
  ),
});

const saveBaseFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullish(),
  maxRunsPerHour: z.number().int().min(1).max(1_200).optional(),
  trigger: triggerSchema,
  conditions: conditionTreeSchema.optional(),
  actions: z.array(actionInputSchema).min(1).max(AUTOMATION_MAX_ACTIONS),
  canvasLayout: canvasLayoutSchema.nullish(),
};

export const automationsRouter = router({
  catalogue: readProc.query(async ({ ctx }) => {
    return ctx.services.automations.getCatalogue(ctx.session);
  }),

  settings: router({
    get: readProc.query(async ({ ctx }) => {
      return ctx.services.automations.getSettings(ctx.session);
    }),
    update: manageProc
      .input(
        z.strictObject({
          enabled: z.boolean().optional(),
          globalRunsPerMinute: z.number().int().min(5).max(2_000).optional(),
          defaultPerAutomationRunsPerHour: z.number().int().min(1).max(600).optional(),
          maxPerAutomationRunsPerHour: z.number().int().min(5).max(1_200).optional(),
          runRetentionDays: z.number().int().min(7).max(365).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return ctx.services.automations.updateSettings(ctx.session, input);
      }),
  }),

  list: readProc
    .input(
      z
        .strictObject({
          cursor: cursorSchema,
          limit: z.number().int().min(1).max(100).optional(),
          enabled: z.boolean().optional(),
          triggerMode: z.enum(AUTOMATION_TRIGGER_MODES).optional(),
          query: z.string().max(120).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      return ctx.services.automations.list(ctx.session, {
        ...(input?.cursor ? { cursor: input.cursor } : {}),
        ...(input?.limit !== undefined ? { limit: input.limit } : {}),
        ...(input?.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input?.triggerMode !== undefined ? { triggerMode: input.triggerMode } : {}),
        ...(input?.query !== undefined ? { query: input.query } : {}),
      });
    }),

  get: readProc
    .input(z.strictObject({ publicId: ulidSchema }))
    .query(async ({ ctx, input }) => {
      return ctx.services.automations.get(ctx.session, input);
    }),

  versions: readProc
    .input(
      z.strictObject({
        publicId: ulidSchema,
        limit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.services.automations.listVersions(ctx.session, input);
    }),

  create: manageProc
    .input(
      z.strictObject({
        ...saveBaseFields,
        enabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.services.automations.create(ctx.session, input);
    }),

  update: manageProc
    .input(
      z.strictObject({
        publicId: ulidSchema,
        expectedVersion: z.number().int().min(1),
        name: saveBaseFields.name.optional(),
        description: saveBaseFields.description,
        enabled: z.boolean().optional(),
        maxRunsPerHour: saveBaseFields.maxRunsPerHour,
        trigger: triggerSchema.optional(),
        conditions: conditionTreeSchema.optional(),
        actions: z.array(actionInputSchema).min(1).max(AUTOMATION_MAX_ACTIONS).optional(),
        canvasLayout: canvasLayoutSchema.nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.services.automations.update(ctx.session, input);
    }),

  setEnabled: manageProc
    .input(
      z.strictObject({
        publicId: ulidSchema,
        expectedVersion: z.number().int().min(1),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.services.automations.setEnabled(ctx.session, input);
    }),

  duplicate: manageProc
    .input(
      z.strictObject({
        publicId: ulidSchema,
        name: z.string().trim().min(1).max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.services.automations.duplicate(ctx.session, input);
    }),

  delete: manageProc
    .input(
      z.strictObject({
        publicId: ulidSchema,
        expectedVersion: z.number().int().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.services.automations.remove(ctx.session, input);
    }),

  triggerManual: manageProc
    .input(
      z.strictObject({
        publicId: ulidSchema,
        orderPublicId: ulidSchema.nullish(),
        sampleFields: z
          .record(
            z.string().max(64),
            z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.services.automations.triggerManual(ctx.session, input);
    }),

  testRun: readProc
    .input(
      z.strictObject({
        publicId: ulidSchema.optional(),
        trigger: triggerSchema,
        conditions: conditionTreeSchema.optional(),
        actions: z.array(actionInputSchema).min(1).max(AUTOMATION_MAX_ACTIONS),
        sampleFields: z
          .record(
            z.string().max(64),
            z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
          )
          .optional(),
        orderPublicId: ulidSchema.nullish(),
        executeLive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.services.automations.testRun(ctx.session, input);
    }),

  runs: router({
    list: readProc
      .input(
        z
          .strictObject({
            automationPublicId: ulidSchema.optional(),
            orderPublicId: ulidSchema.optional(),
            state: z.enum(AUTOMATION_RUN_STATES).optional(),
            cursor: cursorSchema,
            limit: z.number().int().min(1).max(100).optional(),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        return ctx.services.automations.listRuns(ctx.session, {
          ...(input?.automationPublicId ? { automationPublicId: input.automationPublicId } : {}),
          ...(input?.orderPublicId ? { orderPublicId: input.orderPublicId } : {}),
          ...(input?.state ? { state: input.state } : {}),
          ...(input?.cursor ? { cursor: input.cursor } : {}),
          ...(input?.limit !== undefined ? { limit: input.limit } : {}),
        });
      }),

    get: readProc
      .input(z.strictObject({ runPublicId: ulidSchema }))
      .query(async ({ ctx, input }) => {
        return ctx.services.automations.getRun(ctx.session, input);
      }),
  }),

  orderStageActions: router({
    get: stageActionsProc
      .input(
        z.strictObject({
          orderPublicId: ulidSchema,
          runLimit: z.number().int().min(1).max(50).optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        return ctx.services.automations.getOrderStageActions(ctx.session, {
          orderPublicId: input.orderPublicId,
          ...(input.runLimit !== undefined ? { runLimit: input.runLimit } : {}),
        });
      }),

    listRuns: stageActionsProc
      .input(
        z.strictObject({
          orderPublicId: ulidSchema,
          cursor: cursorSchema,
          limit: z.number().int().min(1).max(50).optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        return ctx.services.automations.listOrderStageRuns(ctx.session, {
          orderPublicId: input.orderPublicId,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
      }),

    runForOrder: stageActionsProc
      .input(
        z.strictObject({
          orderPublicId: ulidSchema,
          stepKey: stageStepKeySchema,
          idempotencyKey: stageIdempotencyKeySchema,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return ctx.services.automations.runForOrder(ctx.session, input);
      }),
  }),
});
