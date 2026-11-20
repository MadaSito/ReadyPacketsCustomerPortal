/**
 * Compliance tRPC router — mounted at `compliance` on `appRouter`.
 * Every input uses bounded `z.strictObject` schemas and `publicId` ULIDs (never internal numeric IDs).
 */
import { z } from "zod";
import {
  protectedProcedure,
  publicProcedure,
  requireCapability,
  router,
  staffProcedure,
} from "../../trpc/trpc.js";
import {
  acceptPolicySchema,
  createInvoiceDraftSchema,
  createPolicyDocumentSchema,
  createPolicyDraftSchema,
  createQuestionnaireSchema,
  intakeAnswersRecordSchema,
  invoiceStatusSchema,
  publicIdSchema,
  recordManualPaymentSchema,
  recordRefundSchema,
  saveQuestionnaireDraftSchema,
  slugSchema,
  updateInvoiceDraftSchema,
  updatePolicyDocumentSchema,
  updatePolicyDraftSchema,
  updateQuestionnaireSchema,
} from "./domain.js";

const policiesManageProc = protectedProcedure.use(requireCapability("policies.manage"));
const intakeManageProc = protectedProcedure.use(requireCapability("intake.manage"));
const intakeReviewProc = staffProcedure.use(requireCapability("intake.review"));
const invoicesManageProc = staffProcedure.use(requireCapability("invoices.manage"));

export const complianceRouter = router({
  /* ---------------------------------------------------------------- policies */
  policies: router({
    /** Public read of currently published policies (used by `/register` and `/legal`). */
    listPublished: publicProcedure
      .meta({ rateLimit: "standard_browsing" })
      .input(z.strictObject({ slug: slugSchema.optional() }).optional())
      .query(async ({ ctx, input }) => {
        const all = await ctx.services.compliance.policies.listPublished();
        if (input?.slug) {
          return all.filter((p) => p.slug === input.slug);
        }
        return all;
      }),

    /** Current customer/staff user's policy status: published docs, pending required re-acceptances, and history. */
    myStatus: protectedProcedure
      .meta({ rateLimit: "api" })
      .query(async ({ ctx }) => {
        return ctx.services.compliance.policies.myStatus(ctx.session);
      }),

    /** Records cryptographic SHA-256-bound acceptance evidence for a published policy version. */
    accept: protectedProcedure
      .meta({ rateLimit: "form_submission" })
      .input(acceptPolicySchema)
      .mutation(async ({ ctx, input }) => {
        return ctx.services.compliance.policies.accept(ctx.session, input);
      }),

    admin: router({
      listDocuments: policiesManageProc
        .meta({ rateLimit: "api" })
        .query(async ({ ctx }) => {
          return ctx.services.compliance.policies.admin.listDocuments(ctx.session);
        }),

      getDocument: policiesManageProc
        .meta({ rateLimit: "api" })
        .input(z.strictObject({ documentPublicId: publicIdSchema }))
        .query(async ({ ctx, input }) => {
          return ctx.services.compliance.policies.admin.getDocument(ctx.session, input.documentPublicId);
        }),

      createDocument: policiesManageProc
        .meta({ rateLimit: "form_submission" })
        .input(createPolicyDocumentSchema)
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.policies.admin.createDocument(ctx.session, input);
        }),

      updateDocument: policiesManageProc
        .meta({ rateLimit: "form_submission" })
        .input(updatePolicyDocumentSchema)
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.policies.admin.updateDocument(ctx.session, input);
        }),

      createDraftVersion: policiesManageProc
        .meta({ rateLimit: "form_submission" })
        .input(createPolicyDraftSchema)
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.policies.admin.createDraftVersion(ctx.session, input);
        }),

      updateDraftVersion: policiesManageProc
        .meta({ rateLimit: "form_submission" })
        .input(updatePolicyDraftSchema)
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.policies.admin.updateDraftVersion(ctx.session, input);
        }),

      deleteDraftVersion: policiesManageProc
        .meta({ rateLimit: "form_submission" })
        .input(z.strictObject({ versionPublicId: publicIdSchema }))
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.policies.admin.deleteDraftVersion(ctx.session, input.versionPublicId);
        }),

      publishVersion: policiesManageProc
        .meta({ rateLimit: "form_submission" })
        .input(
          z.strictObject({
            versionPublicId: publicIdSchema,
            effectiveAt: z.coerce.date().optional(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.policies.admin.publishVersion(ctx.session, input);
        }),

      listAcceptances: policiesManageProc
        .meta({ rateLimit: "api" })
        .input(
          z
            .strictObject({
              documentPublicId: publicIdSchema.optional(),
              versionPublicId: publicIdSchema.optional(),
              userPublicId: publicIdSchema.optional(),
              cursor: z.string().max(128).optional(),
              limit: z.number().int().min(1).max(100).default(50),
            })
            .optional(),
        )
        .query(async ({ ctx, input }) => {
          return ctx.services.compliance.policies.admin.listAcceptances(ctx.session, input ?? {});
        }),
    }),
  }),

  /* ------------------------------------------------------------------ intake */
  intake: router({
    listForOrder: protectedProcedure
      .meta({ rateLimit: "api" })
      .input(z.strictObject({ orderPublicId: publicIdSchema }))
      .query(async ({ ctx, input }) => {
        return ctx.services.compliance.intake.listForOrder(ctx.session, input.orderPublicId);
      }),

    getSubmission: protectedProcedure
      .meta({ rateLimit: "api" })
      .input(
        z.strictObject({
          orderPublicId: publicIdSchema,
          questionnairePublicId: publicIdSchema,
          cursor: z.string().max(128).optional(),
          limit: z.number().int().min(1).max(25).default(10),
        }),
      )
      .query(async ({ ctx, input }) => {
        return ctx.services.compliance.intake.getSubmission(ctx.session, input);
      }),

    saveDraft: protectedProcedure
      .meta({ rateLimit: "form_submission" })
      .input(
        z.strictObject({
          orderPublicId: publicIdSchema,
          questionnairePublicId: publicIdSchema,
          answers: intakeAnswersRecordSchema,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return ctx.services.compliance.intake.saveDraft(ctx.session, input);
      }),

    submit: protectedProcedure
      .meta({ rateLimit: "form_submission" })
      .input(
        z.strictObject({
          orderPublicId: publicIdSchema,
          questionnairePublicId: publicIdSchema,
          answers: intakeAnswersRecordSchema,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return ctx.services.compliance.intake.submit(ctx.session, input);
      }),

    review: intakeReviewProc
      .meta({ rateLimit: "form_submission" })
      .input(
        z.strictObject({
          submissionPublicId: publicIdSchema,
          decision: z.enum(["accepted", "returned_for_changes"]),
          reviewNote: z.string().max(2000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return ctx.services.compliance.intake.review(ctx.session, input);
      }),

    admin: router({
      listQuestionnaires: intakeManageProc
        .meta({ rateLimit: "api" })
        .query(async ({ ctx }) => {
          return ctx.services.compliance.intake.admin.listQuestionnaires(ctx.session);
        }),

      getQuestionnaire: intakeManageProc
        .meta({ rateLimit: "api" })
        .input(z.strictObject({ questionnairePublicId: publicIdSchema }))
        .query(async ({ ctx, input }) => {
          return ctx.services.compliance.intake.admin.getQuestionnaire(
            ctx.session,
            input.questionnairePublicId,
          );
        }),

      createQuestionnaire: intakeManageProc
        .meta({ rateLimit: "form_submission" })
        .input(createQuestionnaireSchema)
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.intake.admin.createQuestionnaire(ctx.session, input);
        }),

      updateQuestionnaire: intakeManageProc
        .meta({ rateLimit: "form_submission" })
        .input(updateQuestionnaireSchema)
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.intake.admin.updateQuestionnaire(ctx.session, input);
        }),

      saveDraftVersion: intakeManageProc
        .meta({ rateLimit: "form_submission" })
        .input(saveQuestionnaireDraftSchema)
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.intake.admin.saveDraftVersion(ctx.session, input);
        }),

      publishVersion: intakeManageProc
        .meta({ rateLimit: "form_submission" })
        .input(z.strictObject({ versionPublicId: publicIdSchema }))
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.intake.admin.publishVersion(ctx.session, input.versionPublicId);
        }),
    }),
  }),

  /* ---------------------------------------------------------------- invoices */
  invoices: router({
    listMine: protectedProcedure
      .meta({ rateLimit: "api" })
      .input(
        z
          .strictObject({
            status: invoiceStatusSchema.optional(),
            cursor: z.string().max(128).optional(),
            limit: z.number().int().min(1).max(100).default(25),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        return ctx.services.compliance.invoices.listMine(ctx.session, input ?? {});
      }),

    listForOrder: protectedProcedure
      .meta({ rateLimit: "api" })
      .input(z.strictObject({ orderPublicId: publicIdSchema }))
      .query(async ({ ctx, input }) => {
        return ctx.services.compliance.invoices.listForOrder(ctx.session, input.orderPublicId);
      }),

    get: protectedProcedure
      .meta({ rateLimit: "api" })
      .input(z.strictObject({ invoicePublicId: publicIdSchema }))
      .query(async ({ ctx, input }) => {
        return ctx.services.compliance.invoices.get(ctx.session, input.invoicePublicId);
      }),

    admin: router({
      list: staffProcedure
        .meta({ rateLimit: "api" })
        .input(
          z
            .strictObject({
              status: invoiceStatusSchema.optional(),
              orderPublicId: publicIdSchema.optional(),
              cursor: z.string().max(128).optional(),
              limit: z.number().int().min(1).max(100).default(50),
            })
            .optional(),
        )
        .query(async ({ ctx, input }) => {
          return ctx.services.compliance.invoices.admin.list(ctx.session, input ?? {});
        }),

      createDraft: invoicesManageProc
        .meta({ rateLimit: "form_submission" })
        .input(createInvoiceDraftSchema)
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.invoices.admin.createDraft(ctx.session, input);
        }),

      updateDraft: invoicesManageProc
        .meta({ rateLimit: "form_submission" })
        .input(updateInvoiceDraftSchema)
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.invoices.admin.updateDraft(ctx.session, input);
        }),

      issue: invoicesManageProc
        .meta({ rateLimit: "form_submission" })
        .input(
          z.strictObject({
            invoicePublicId: publicIdSchema,
            dueAt: z.coerce.date().optional().nullable(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.invoices.admin.issue(ctx.session, input);
        }),

      void: invoicesManageProc
        .meta({ rateLimit: "form_submission" })
        .input(
          z.strictObject({
            invoicePublicId: publicIdSchema,
            reason: z.string().trim().min(3).max(500),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.invoices.admin.void(ctx.session, input);
        }),

      recordManualPayment: invoicesManageProc
        .meta({ rateLimit: "form_submission" })
        .input(recordManualPaymentSchema)
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.invoices.admin.recordManualPayment(ctx.session, input);
        }),

      recordRefund: invoicesManageProc
        .meta({ rateLimit: "form_submission" })
        .input(recordRefundSchema)
        .mutation(async ({ ctx, input }) => {
          return ctx.services.compliance.invoices.admin.recordRefund(ctx.session, input);
        }),
    }),
  }),
});

export type ComplianceRouter = typeof complianceRouter;
