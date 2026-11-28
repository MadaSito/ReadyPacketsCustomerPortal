import { z } from "zod";
import { adminProcedure, requireCapability, router } from "../../trpc/trpc.js";
import { MAX_SUBJECT_LENGTH, MAX_TEMPLATE_VARS, MAX_TEXT_BODY_LENGTH, VAR_NAME_RE } from "./sanitizer.js";
import { MAIL_TEMPLATE_CATEGORIES, MAIL_TEMPLATE_FORMATS, MAIL_TEMPLATE_KINDS } from "./schema.js";

const mailManage = adminProcedure.use(requireCapability("mail.manage"));
const mailManageExpensive = mailManage.meta({ rateLimit: "expensive" });
const automationsRead = adminProcedure.use(requireCapability("automations.read"));

const templateKeySchema = z
  .string()
  .min(3)
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

const variableSpecSchema = z.strictObject({
  name: z.string().regex(VAR_NAME_RE),
  label: z.string().min(1).max(120),
  required: z.boolean(),
  sensitive: z.boolean().optional(),
  sampleValue: z.string().min(1).max(500),
});

const sampleVarsMapSchema = z
  .record(z.string().regex(VAR_NAME_RE), z.string().max(2_048))
  .optional();

export const mailTemplatesRouter = router({
  list: mailManage
    .input(
      z
        .strictObject({
          kind: z.enum(MAIL_TEMPLATE_KINDS).optional(),
          category: z.enum(MAIL_TEMPLATE_CATEGORIES).optional(),
          query: z.string().max(120).optional(),
        })
        .default({}),
    )
    .query(({ ctx, input }) => ctx.services.mailTemplates.list(ctx.session, input)),

  listForAutomations: automationsRead.query(({ ctx }) =>
    ctx.services.mailTemplates.listForAutomations(ctx.session),
  ),
  listForPhaseActions: adminProcedure.use(requireCapability("workflows.manage"))
    .query(({ ctx }) => ctx.services.mailTemplates.listForPhaseActions(ctx.session)),

  get: mailManage
    .input(z.strictObject({ templateKey: templateKeySchema }))
    .query(({ ctx, input }) => ctx.services.mailTemplates.get(ctx.session, input)),

  createCustom: mailManage
    .input(
      z.strictObject({
        templateKey: z
          .string()
          .min(9)
          .max(72)
          .regex(/^custom\.[a-z][a-z0-9_]{1,63}$/),
        name: z.string().min(2).max(160),
        description: z.string().max(500).optional(),
        category: z.enum(MAIL_TEMPLATE_CATEGORIES).optional(),
        declaredVars: z.array(variableSpecSchema).max(MAX_TEMPLATE_VARS),
        format: z.enum(MAIL_TEMPLATE_FORMATS),
        subject: z.string().min(1).max(MAX_SUBJECT_LENGTH),
        bodyHtml: z.string().max(131_072).nullish(),
        bodyText: z.string().max(MAX_TEXT_BODY_LENGTH).nullish(),
        deriveTextFromHtml: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.mailTemplates.createCustom(ctx.session, input)),

  saveDraft: mailManage
    .input(
      z.strictObject({
        templateKey: templateKeySchema,
        expectedVersion: z.number().int().min(1),
        name: z.string().min(2).max(160).optional(),
        description: z.string().max(500).optional(),
        declaredVars: z.array(variableSpecSchema).max(MAX_TEMPLATE_VARS).optional(),
        format: z.enum(MAIL_TEMPLATE_FORMATS),
        subject: z.string().min(1).max(MAX_SUBJECT_LENGTH),
        bodyHtml: z.string().max(131_072).nullish(),
        bodyText: z.string().max(MAX_TEXT_BODY_LENGTH).nullish(),
        deriveTextFromHtml: z.boolean().optional(),
        changeNote: z.string().max(500).optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.mailTemplates.saveDraft(ctx.session, input)),

  publish: mailManage
    .input(
      z.strictObject({
        templateKey: templateKeySchema,
        expectedVersion: z.number().int().min(1),
        changeNote: z.string().max(500).optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.mailTemplates.publish(ctx.session, input)),

  resetToDefault: mailManage
    .input(
      z.strictObject({
        templateKey: templateKeySchema,
        expectedVersion: z.number().int().min(1),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.mailTemplates.resetToDefault(ctx.session, input)),

  restoreVersion: mailManage
    .input(
      z.strictObject({
        templateKey: templateKeySchema,
        expectedVersion: z.number().int().min(1),
        versionNumber: z.number().int().min(1),
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.mailTemplates.restoreVersion(ctx.session, input)),

  preview: mailManage
    .input(
      z.strictObject({
        templateKey: templateKeySchema.optional(),
        format: z.enum(MAIL_TEMPLATE_FORMATS),
        subject: z.string().min(1).max(MAX_SUBJECT_LENGTH),
        bodyHtml: z.string().max(131_072).nullish(),
        bodyText: z.string().max(MAX_TEXT_BODY_LENGTH).nullish(),
        deriveTextFromHtml: z.boolean().optional(),
        declaredVars: z.array(variableSpecSchema).max(MAX_TEMPLATE_VARS),
        sampleVars: sampleVarsMapSchema,
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.mailTemplates.preview(ctx.session, input)),

  sendTestToMe: mailManageExpensive
    .input(
      z.strictObject({
        templateKey: templateKeySchema,
        source: z.enum(["working_draft", "published", "system_default"]).optional(),
        sampleVars: sampleVarsMapSchema,
      }),
    )
    .mutation(({ ctx, input }) => ctx.services.mailTemplates.sendTestToMe(ctx.session, input)),
});
