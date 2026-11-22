/**
 * Community forum — tRPC router (`trpc.community.*`). Owner: audit_engineer (package M).
 * Role/capability gates here; flag, in-transaction actor re-validation and resource scope in the service.
 */
import { z } from "zod";
import { adminProcedure, protectedProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import { notFound } from "../../core/errors.js";
import type { CommunityModule } from "./index.js";
import { REPORT_REASONS } from "./schema.js";
import { communityConfigSchema } from "./settings.js";
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from "./text.js";

const publicId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const cursor = z.string().max(24).optional();
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u);
const body = z.string().min(1).max(MAX_BODY_LENGTH * 2);
const title = z.string().min(1).max(MAX_TITLE_LENGTH * 2);
const reason = z.string().max(200).optional();
const version = z.number().int().min(1).max(0xffff_ffff);
const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u);

/** Until /root mounts `services.community` in container.ts the service is read through this narrow accessor. */
const svc = (ctx: { services: unknown }): CommunityModule => {
  const service = (ctx.services as { community?: CommunityModule }).community;
  if (!service) throw notFound("COMMUNITY_NOT_MOUNTED");
  return service;
};

const member = protectedProcedure;
const moderator = staffProcedure.use(requireCapability("community.moderate"));
const manager = adminProcedure.use(requireCapability("community.manage"));

export const communityRouter = router({
  status: protectedProcedure.query(({ ctx }) => svc(ctx).status(ctx.session!)),

  profile: router({
    save: member.input(z.strictObject({ displayName: z.string().min(1).max(64) })).mutation(({ ctx, input }) => svc(ctx).saveProfile(ctx.session!, input)),
  }),

  categories: router({
    list: member.query(({ ctx }) => svc(ctx).listCategories(ctx.session!)),
  }),

  topics: router({
    list: member
      .input(z.strictObject({ categoryPublicId: publicId.optional(), cursor, limit: z.number().int().min(1).max(50).optional() }).optional())
      .query(({ ctx, input }) => svc(ctx).listTopics(ctx.session!, input ?? {})),
    get: member.input(z.strictObject({ topicPublicId: publicId, cursor })).query(({ ctx, input }) => svc(ctx).getTopic(ctx.session!, input)),
    create: member
      .meta({ rateLimit: "form_submission" })
      .input(z.strictObject({ categoryPublicId: publicId, title, body, idempotencyKey }))
      .mutation(({ ctx, input }) => svc(ctx).createTopic(ctx.session!, input)),
  }),

  posts: router({
    reply: member
      .meta({ rateLimit: "form_submission" })
      .input(z.strictObject({ topicPublicId: publicId, body, quotePostPublicId: publicId.optional(), idempotencyKey }))
      .mutation(({ ctx, input }) => svc(ctx).reply(ctx.session!, input)),
    edit: member
      .meta({ rateLimit: "form_submission" })
      .input(z.strictObject({ postPublicId: publicId, body, title: title.optional(), expectedVersion: version }))
      .mutation(({ ctx, input }) => svc(ctx).editPost(ctx.session!, input)),
    delete: member.input(z.strictObject({ postPublicId: publicId })).mutation(({ ctx, input }) => svc(ctx).deletePost(ctx.session!, input)),
    react: member.input(z.strictObject({ postPublicId: publicId, helpful: z.boolean() })).mutation(({ ctx, input }) => svc(ctx).react(ctx.session!, input)),
    report: member
      .meta({ rateLimit: "form_submission" })
      .input(z.strictObject({ postPublicId: publicId, reason: z.enum(REPORT_REASONS), note: z.string().max(500).optional() }))
      .mutation(({ ctx, input }) => svc(ctx).report(ctx.session!, input)),
  }),

  subscriptions: router({
    set: member.input(z.strictObject({ topicPublicId: publicId, subscribed: z.boolean() })).mutation(({ ctx, input }) => svc(ctx).setSubscription(ctx.session!, input)),
  }),

  search: member.input(z.strictObject({ q: z.string().min(1).max(200), cursor })).query(({ ctx, input }) => svc(ctx).search(ctx.session!, input)),

  mod: router({
    queue: moderator.query(({ ctx }) => svc(ctx).queue(ctx.session!)),
    reports: router({
      resolve: moderator
        .input(z.strictObject({ reportPublicId: publicId, outcome: z.enum(["dismissed", "actioned"]), note: z.string().max(500).optional() }))
        .mutation(({ ctx, input }) => svc(ctx).resolveReport(ctx.session!, input)),
    }),
    post: moderator
      .input(z.strictObject({ postPublicId: publicId, action: z.enum(["approve", "hide", "unhide", "remove"]), reason }))
      .mutation(({ ctx, input }) => svc(ctx).moderatePost(ctx.session!, input)),
    topic: moderator
      .input(z.strictObject({ topicPublicId: publicId, action: z.enum(["lock", "unlock", "pin", "unpin", "move"]), categoryPublicId: publicId.optional(), reason }))
      .mutation(({ ctx, input }) => svc(ctx).moderateTopic(ctx.session!, input)),
    suspend: moderator
      .input(z.strictObject({ memberPublicId: publicId, days: z.number().int().min(1).max(365).nullable(), reason: z.string().min(1).max(200) }))
      .mutation(({ ctx, input }) => svc(ctx).suspend(ctx.session!, input)),
    unsuspend: moderator.input(z.strictObject({ memberPublicId: publicId, reason })).mutation(({ ctx, input }) => svc(ctx).unsuspend(ctx.session!, input)),
    log: moderator.input(z.strictObject({ cursor: z.string().max(20).optional() }).optional()).query(({ ctx, input }) => svc(ctx).moderationLog(ctx.session!, input ?? {})),
  }),

  admin: router({
    settings: router({
      get: manager.query(({ ctx }) => svc(ctx).getSettings(ctx.session!)),
      update: manager.input(communityConfigSchema).mutation(({ ctx, input }) => svc(ctx).updateSettings(ctx.session!, input)),
    }),
    setEnabled: manager.input(z.strictObject({ enabled: z.boolean() })).mutation(({ ctx, input }) => svc(ctx).setEnabled(ctx.session!, input)),
    categories: router({
      create: manager
        .input(z.strictObject({ slug, name: z.string().trim().min(2).max(80), description: z.string().max(300).optional(), staffOnlyPosting: z.boolean().optional() }))
        .mutation(({ ctx, input }) => svc(ctx).createCategory(ctx.session!, input)),
      update: manager
        .input(z.strictObject({ categoryPublicId: publicId, expectedVersion: version, name: z.string().trim().min(2).max(80).optional(), description: z.string().max(300).optional(), staffOnlyPosting: z.boolean().optional(), archived: z.boolean().optional() }))
        .mutation(({ ctx, input }) => svc(ctx).updateCategory(ctx.session!, input)),
      reorder: manager
        .input(z.strictObject({ orderedPublicIds: z.array(publicId).min(1).max(100) }))
        .mutation(({ ctx, input }) => svc(ctx).reorderCategories(ctx.session!, input)),
    }),
  }),
});
