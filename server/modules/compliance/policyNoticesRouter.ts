import { z } from "zod";
import { protectedProcedure, requireCapability, router } from "../../trpc/trpc.js";
import { publicIdSchema } from "./domain.js";
import { POLICY_NOTICE_MAX_DELAY } from "./policyNotices.js";

const manager = protectedProcedure.use(requireCapability("policies.manage"));
const sender = protectedProcedure.use(requireCapability("policies.notices.send"));
const document = { documentPublicId: publicIdSchema };
const notice = { noticePublicId: publicIdSchema, revision: z.number().int().positive().max(0xfffffffe) };
const audience = { ...notice, confirmedCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) };

export const policyNoticesRouter = router({
  status: manager.meta({ rateLimit: "api" }).input(z.strictObject(document))
    .query(({ ctx, input }) => ctx.services.compliance.policyNotices.status(input.documentPublicId)),
  setDelay: manager.meta({ rateLimit: "form_submission" }).input(z.strictObject({
    ...document, delayHours: z.number().int().min(0).max(POLICY_NOTICE_MAX_DELAY),
  })).mutation(({ ctx, input }) => ctx.services.compliance.policyNotices.setDelay(ctx.session, input)),
  reschedule: manager.meta({ rateLimit: "form_submission" }).input(z.strictObject({ ...notice, scheduledAt: z.date() }))
    .mutation(({ ctx, input }) => ctx.services.compliance.policyNotices.change(ctx.session, { ...input, kind: "reschedule" })),
  cancel: manager.meta({ rateLimit: "form_submission" }).input(z.strictObject(notice))
    .mutation(({ ctx, input }) => ctx.services.compliance.policyNotices.change(ctx.session, { ...input, kind: "cancel" })),
  sendNow: sender.meta({ rateLimit: "form_submission" }).input(z.strictObject(audience))
    .mutation(({ ctx, input }) => ctx.services.compliance.policyNotices.change(ctx.session, { ...input, kind: "send" })),
  remind: sender.meta({ rateLimit: "form_submission" }).input(z.strictObject(audience))
    .mutation(({ ctx, input }) => ctx.services.compliance.policyNotices.change(ctx.session, { ...input, kind: "remind" })),
});
