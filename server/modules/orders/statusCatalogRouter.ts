/**
 * Increment 07 (D2) — Order status catalogue tRPC sub-router (`trpc.orders.statusCatalog.*`).
 *
 * Owner: recovery_ops_engineer (Package C).
 * Authz:
 *  - `list` & `attentionCounts`: `staffProcedure.use(requireCapability("orders.read_all"))` before `.input(...)`
 *  - `create`, `update`, `reorder`, `retire`, `restore`: `adminProcedure.use(requireCapability("orders.statuses.manage"))`
 *    before `.input(...)` (step-up capability; also re-validated inside the write transaction via `actorCheck`).
 */
import { z } from "zod";
import {
  ORDER_STATUS_ATTENTIONS,
  ORDER_STATUS_CATEGORIES,
  ORDER_STATUS_TONES,
  statusKeySchema,
  validateStatusCancelCategoryRule,
} from "../../../shared/orderStatusCatalog.js";
import { adminProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";

const expectedVersionSchema = z.number().int().min(1).max(2_147_483_647);

const safeLabelSchema = z
  .string()
  // eslint-disable-next-line no-control-regex -- strip control characters cleanly
  .transform((value) => value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim())
  .pipe(
    z
      .string()
      .min(1, "Enter a label.")
      .max(80, "Use 80 characters or fewer.")
      .refine((value) => !/<\s*[a-z!/?]/i.test(value), "Use plain text without markup."),
  );

const listInputSchema = z
  .strictObject({
    includeRetired: z.boolean().optional(),
    includeUsage: z.boolean().optional(),
  })
  .optional();

const createInputSchema = z
  .strictObject({
    key: statusKeySchema,
    staffLabel: safeLabelSchema,
    customerLabel: safeLabelSchema,
    tone: z.enum(ORDER_STATUS_TONES),
    category: z.enum(ORDER_STATUS_CATEGORIES),
    attention: z.enum(ORDER_STATUS_ATTENTIONS),
  })
  .superRefine((val, ctx) => {
    const err = validateStatusCancelCategoryRule(val.key, val.category);
    if (err) {
      ctx.addIssue({ code: "custom", path: ["category"], message: err });
    }
  });

const updateInputSchema = z
  .strictObject({
    key: statusKeySchema,
    expectedVersion: expectedVersionSchema,
    staffLabel: safeLabelSchema,
    customerLabel: safeLabelSchema,
    tone: z.enum(ORDER_STATUS_TONES),
    category: z.enum(ORDER_STATUS_CATEGORIES),
    attention: z.enum(ORDER_STATUS_ATTENTIONS),
  })
  .superRefine((val, ctx) => {
    const err = validateStatusCancelCategoryRule(val.key, val.category);
    if (err) {
      ctx.addIssue({ code: "custom", path: ["category"], message: err });
    }
  });

const reorderInputSchema = z.strictObject({
  orderedKeys: z.array(statusKeySchema).min(1).max(200),
});

const versionedKeyInputSchema = z.strictObject({
  key: statusKeySchema,
  expectedVersion: expectedVersionSchema,
});

export const statusCatalogRouter = router({
  list: staffProcedure
    .use(requireCapability("orders.read_all"))
    .input(listInputSchema)
    .query(({ ctx, input }) => ctx.services.orders.statusCatalog.list(input)),

  attentionCounts: staffProcedure
    .use(requireCapability("orders.read_all"))
    .query(({ ctx }) => ctx.services.orders.statusCatalog.attentionCounts()),

  create: adminProcedure
    .use(requireCapability("orders.statuses.manage"))
    .input(createInputSchema)
    .mutation(({ ctx, input }) => ctx.services.orders.statusCatalog.create(ctx.session, input)),

  update: adminProcedure
    .use(requireCapability("orders.statuses.manage"))
    .input(updateInputSchema)
    .mutation(({ ctx, input }) => ctx.services.orders.statusCatalog.update(ctx.session, input)),

  reorder: adminProcedure
    .use(requireCapability("orders.statuses.manage"))
    .input(reorderInputSchema)
    .mutation(({ ctx, input }) => ctx.services.orders.statusCatalog.reorder(ctx.session, input)),

  retire: adminProcedure
    .use(requireCapability("orders.statuses.manage"))
    .input(versionedKeyInputSchema)
    .mutation(({ ctx, input }) => ctx.services.orders.statusCatalog.retire(ctx.session, input)),

  restore: adminProcedure
    .use(requireCapability("orders.statuses.manage"))
    .input(versionedKeyInputSchema)
    .mutation(({ ctx, input }) => ctx.services.orders.statusCatalog.restore(ctx.session, input)),
});
