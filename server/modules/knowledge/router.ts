/**
 * Knowledge Base tRPC router (`appRouter.knowledge`).
 * Strict Zod 4 input schemas (`z.strictObject`), capability gates, and per-row service authorization.
 */
import { z } from "zod";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import {
  protectedProcedure,
  requireCapability,
  router,
} from "../../trpc/trpc.js";
import {
  KNOWLEDGE_ARTICLE_STATES,
  KNOWLEDGE_AUDIENCES,
} from "./schema.js";
import type { KnowledgeModule } from "./service.js";

const ulidSchema = z
  .string()
  .trim()
  .regex(ULID_PATTERN, "Expected a valid resource identifier.");

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and single hyphens.");

const tagSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/i, "Use letters, numbers, hyphens, or underscores.");

const cursorSchema = z.string().trim().min(1).max(64);

const manageProcedure = protectedProcedure.use(requireCapability("knowledge.manage"));
const configureProcedure = protectedProcedure.use(requireCapability("platform.settings.manage"));

function kb(services: Services): KnowledgeModule {
  const svc = (services as unknown as { knowledge?: KnowledgeModule }).knowledge;
  if (!svc) {
    throw new DomainError(
      "UNAVAILABLE",
      "KNOWLEDGE_UNAVAILABLE",
      "Knowledge base service is not mounted.",
    );
  }
  return svc;
}

export const knowledgeRouter = router({
  status: protectedProcedure.query(({ ctx }) => kb(ctx.services).status(ctx.session)),

  help: router({
    home: protectedProcedure.query(({ ctx }) => kb(ctx.services).helpHome(ctx.session)),

    category: protectedProcedure
      .input(z.strictObject({ slug: slugSchema }))
      .query(({ ctx, input }) => kb(ctx.services).helpCategory(ctx.session, input)),

    article: protectedProcedure
      .input(
        z.strictObject({
          slug: slugSchema,
          recordView: z.boolean().optional(),
        }),
      )
      .query(({ ctx, input }) => kb(ctx.services).helpArticle(ctx.session, input)),

    search: protectedProcedure
      .input(
        z.strictObject({
          q: z.string().trim().max(120).optional(),
          categorySlug: slugSchema.optional(),
          tag: tagSchema.optional(),
          cursor: cursorSchema.optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }),
      )
      .query(({ ctx, input }) => kb(ctx.services).helpSearch(ctx.session, input)),

    relatedForTicket: protectedProcedure
      .input(
        z.strictObject({
          query: z.string().trim().max(160),
          category: z.string().trim().max(64).optional(),
        }),
      )
      .query(({ ctx, input }) => kb(ctx.services).helpRelatedForTicket(ctx.session, input)),

    submitFeedback: protectedProcedure
      .input(
        z.strictObject({
          articlePublicId: ulidSchema,
          helpful: z.boolean(),
          comment: z.string().trim().max(1_000).nullable().optional(),
        }),
      )
      .mutation(({ ctx, input }) => kb(ctx.services).submitFeedback(ctx.session, input)),
  }),

  attachments: router({
    issueDownloadTicket: protectedProcedure
      .input(z.strictObject({ attachmentPublicId: ulidSchema }))
      .mutation(({ ctx, input }) =>
        kb(ctx.services).issueAttachmentDownloadTicket(ctx.session, input),
      ),

    remove: manageProcedure
      .input(z.strictObject({ attachmentPublicId: ulidSchema }))
      .mutation(({ ctx, input }) => kb(ctx.services).removeAttachment(ctx.session, input)),
  }),

  admin: router({
    settings: router({
      get: manageProcedure.query(({ ctx }) => kb(ctx.services).getSettings(ctx.session)),

      update: configureProcedure
        .input(
          z.strictObject({
            enabled: z.boolean().optional(),
            searchLogRetentionDays: z.number().int().min(7).max(365).optional(),
            allowFeedbackComments: z.boolean().optional(),
          }),
        )
        .mutation(({ ctx, input }) => kb(ctx.services).updateSettings(ctx.session, input)),
    }),

    categories: router({
      list: manageProcedure
        .input(
          z
            .strictObject({
              includeArchived: z.boolean().optional(),
            })
            .optional(),
        )
        .query(({ ctx, input }) => kb(ctx.services).listAdminCategories(ctx.session, input)),

      create: manageProcedure
        .input(
          z.strictObject({
            parentPublicId: ulidSchema.nullable().optional(),
            slug: slugSchema,
            title: z.string().trim().min(2).max(160),
            description: z.string().trim().max(500).nullable().optional(),
          }),
        )
        .mutation(({ ctx, input }) => kb(ctx.services).createCategory(ctx.session, input)),

      update: manageProcedure
        .input(
          z.strictObject({
            publicId: ulidSchema,
            expectedVersion: z.number().int().min(1),
            parentPublicId: ulidSchema.nullable().optional(),
            slug: slugSchema.optional(),
            title: z.string().trim().min(2).max(160).optional(),
            description: z.string().trim().max(500).nullable().optional(),
          }),
        )
        .mutation(({ ctx, input }) => kb(ctx.services).updateCategory(ctx.session, input)),

      archive: manageProcedure
        .input(
          z.strictObject({
            publicId: ulidSchema,
            expectedVersion: z.number().int().min(1),
            archived: z.boolean(),
          }),
        )
        .mutation(({ ctx, input }) => kb(ctx.services).archiveCategory(ctx.session, input)),

      reorder: manageProcedure
        .input(
          z.strictObject({
            parentPublicId: ulidSchema.nullable(),
            orderedPublicIds: z.array(ulidSchema).min(1).max(200),
          }),
        )
        .mutation(({ ctx, input }) => kb(ctx.services).reorderCategories(ctx.session, input)),
    }),

    articles: router({
      list: manageProcedure
        .input(
          z.strictObject({
            state: z.enum(KNOWLEDGE_ARTICLE_STATES).optional(),
            audience: z.enum(KNOWLEDGE_AUDIENCES).optional(),
            categoryPublicId: ulidSchema.optional(),
            tag: tagSchema.optional(),
            query: z.string().trim().max(120).optional(),
            cursor: cursorSchema.optional(),
            limit: z.number().int().min(1).max(100).optional(),
          }),
        )
        .query(({ ctx, input }) => kb(ctx.services).listAdminArticles(ctx.session, input)),

      get: manageProcedure
        .input(z.strictObject({ publicId: ulidSchema }))
        .query(({ ctx, input }) => kb(ctx.services).getAdminArticle(ctx.session, input)),

      preview: manageProcedure
        .input(
          z.strictObject({
            title: z.string().trim().min(2).max(200),
            summary: z.string().trim().min(5).max(500),
            bodyHtml: z.string().min(1).max(200_000),
          }),
        )
        .mutation(({ ctx, input }) => kb(ctx.services).previewArticle(ctx.session, input)),

      create: manageProcedure
        .input(
          z.strictObject({
            categoryPublicId: ulidSchema.nullable().optional(),
            slug: slugSchema,
            title: z.string().trim().min(2).max(200),
            summary: z.string().trim().min(5).max(500),
            bodyHtml: z.string().min(1).max(200_000),
            tags: z.array(tagSchema).max(20).optional(),
            audience: z.enum(KNOWLEDGE_AUDIENCES).optional(),
            state: z.enum(["draft", "published"]).optional(),
            reviewedOn: z.string().trim().max(10).nullable().optional(),
            relatedArticlePublicIds: z.array(ulidSchema).max(10).optional(),
            changeNote: z.string().trim().max(255).nullable().optional(),
          }),
        )
        .mutation(({ ctx, input }) => kb(ctx.services).createArticle(ctx.session, input)),

      update: manageProcedure
        .input(
          z.strictObject({
            publicId: ulidSchema,
            expectedVersion: z.number().int().min(1),
            categoryPublicId: ulidSchema.nullable().optional(),
            slug: slugSchema.optional(),
            title: z.string().trim().min(2).max(200).optional(),
            summary: z.string().trim().min(5).max(500).optional(),
            bodyHtml: z.string().min(1).max(200_000).optional(),
            tags: z.array(tagSchema).max(20).optional(),
            audience: z.enum(KNOWLEDGE_AUDIENCES).optional(),
            reviewedOn: z.string().trim().max(10).nullable().optional(),
            relatedArticlePublicIds: z.array(ulidSchema).max(10).optional(),
            changeNote: z.string().trim().max(255).nullable().optional(),
          }),
        )
        .mutation(({ ctx, input }) => kb(ctx.services).updateArticle(ctx.session, input)),

      setState: manageProcedure
        .input(
          z.strictObject({
            publicId: ulidSchema,
            expectedVersion: z.number().int().min(1),
            state: z.enum(KNOWLEDGE_ARTICLE_STATES),
          }),
        )
        .mutation(({ ctx, input }) => kb(ctx.services).setArticleState(ctx.session, input)),

      reorder: manageProcedure
        .input(
          z.strictObject({
            categoryPublicId: ulidSchema.nullable(),
            orderedPublicIds: z.array(ulidSchema).min(1).max(200),
          }),
        )
        .mutation(({ ctx, input }) => kb(ctx.services).reorderArticles(ctx.session, input)),

      versions: manageProcedure
        .input(z.strictObject({ publicId: ulidSchema }))
        .query(({ ctx, input }) => kb(ctx.services).listArticleVersions(ctx.session, input)),

      restoreVersion: manageProcedure
        .input(
          z.strictObject({
            publicId: ulidSchema,
            expectedVersion: z.number().int().min(1),
            versionNumber: z.number().int().min(1),
            changeNote: z.string().trim().max(255).nullable().optional(),
          }),
        )
        .mutation(({ ctx, input }) => kb(ctx.services).restoreArticleVersion(ctx.session, input)),
    }),

    insights: manageProcedure.query(({ ctx }) => kb(ctx.services).getInsights(ctx.session)),
  }),
});

export type KnowledgeRouter = typeof knowledgeRouter;
