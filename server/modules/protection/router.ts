import { z } from "zod";
import { RATE_LIMIT_CATEGORIES } from "../../core/types.js";
import { adminProcedure, requireCapability, router } from "../../trpc/trpc.js";
import { policySchema } from "./policy.js";
import { rateLimitBackoffSchema } from "../../security/rateLimiter.js";
import { signInBanPolicySchema } from "./signInBans.js";

const read = adminProcedure.use(requireCapability("security.firewall.read"));
const manage = adminProcedure.use(requireCapability("security.firewall.manage"));
const publicId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const category = z.enum(RATE_LIMIT_CATEGORIES);
const eventFilterFields = {
  action: z.enum(["detect", "block"]).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  rule: z.string().trim().min(1).max(80).regex(/^[a-z0-9.-]+$/).optional(),
  method: z.enum(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE", "OTHER"]).optional(),
  since: z.date().optional(),
  until: z.date().optional(),
};
const eventFilter = z.strictObject(eventFilterFields).refine((v) => !v.since || !v.until || v.since <= v.until, { path: ["until"], message: "Enter an end date on or after the start date." });
const eventPage = z.strictObject({ ...eventFilterFields, limit: z.number().int().min(1).max(100).optional(), cursor: publicId.optional() })
  .refine((v) => !v.since || !v.until || v.since <= v.until, { path: ["until"], message: "Enter an end date on or after the start date." });

export const protectionRouter = router({
  overview: read.query(({ ctx }) => ctx.services.protection.overview(ctx.session)),
  getPolicy: read.query(({ ctx }) => ctx.services.protection.getPolicy(ctx.session)),
  setPolicy: manage.input(z.strictObject({ version: z.number().int().min(1).max(2_147_483_646), policy: policySchema }))
    .mutation(({ ctx, input }) => ctx.services.protection.setPolicy(ctx.session, input)),
  getRateLimits: read.query(({ ctx }) => ctx.services.protection.getRateLimits(ctx.session)),
  setRateLimit: manage.input(z.strictObject({ category, maxRequests: z.number().int().min(1).max(1200), windowSeconds: z.number().int().min(1).max(600), backoff: rateLimitBackoffSchema.optional() }))
    .mutation(({ ctx, input }) => ctx.services.protection.setRateLimit(ctx.session, input.category, input)),
  resetRateLimit: manage.input(z.strictObject({ category }))
    .mutation(({ ctx, input }) => ctx.services.protection.setRateLimit(ctx.session, input.category)),
  listSignInBans: read.query(({ ctx }) => ctx.services.protection.listSignInBans(ctx.session)),
  setSignInBanPolicy: manage.input(signInBanPolicySchema)
    .mutation(({ ctx, input }) => ctx.services.protection.setSignInBanPolicy(ctx.session, input)),
  manualSignInBan: manage.input(z.strictObject({
    address: z.string().trim().min(1).max(48), durationMinutes: z.number().int().min(1).max(10_080).nullable(),
    reason: z.string().trim().min(3).max(240),
  })).mutation(({ ctx, input }) => ctx.services.protection.manualSignInBan(ctx.session, input)),
  releaseSignInBan: manage.input(z.strictObject({ publicId }))
    .mutation(({ ctx, input }) => ctx.services.protection.releaseSignInBan(ctx.session, input)),
  listBlocks: read.query(({ ctx }) => ctx.services.protection.listBlocks(ctx.session)),
  releaseBlock: manage.input(z.strictObject({ source: z.enum(["automatic", "rate"]), publicId }))
    .mutation(({ ctx, input }) => ctx.services.protection.releaseBlock(ctx.session, input)),
  listEvents: read.input(eventPage).query(({ ctx, input }) => ctx.services.protection.listEvents(ctx.session, input)),
  exportEvents: read.input(eventFilter).mutation(({ ctx, input }) => ctx.services.protection.exportEvents(ctx.session, input)),
});
