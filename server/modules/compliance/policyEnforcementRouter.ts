import { z } from "zod";
import { forbidden } from "../../core/errors.js";
import { protectedProcedure, requireCapability, router, sessionProcedure } from "../../trpc/trpc.js";
import { acceptPolicySchema, publicIdSchema } from "./domain.js";
import { warningTextSchema } from "./policyEnforcement.js";
import { POLICY_ENFORCEMENT_MODES } from "./policyEnforcementSchema.js";

const manager = protectedProcedure.use(requireCapability("policies.manage"));
const readTarget = protectedProcedure.use(requireCapability("policies.acceptances.read"));
const revoke = protectedProcedure.use(requireCapability("sessions.revoke_any"));
const document = { documentPublicId: publicIdSchema };
const version = { versionPublicId: publicIdSchema };
const target = z.strictObject({ userPublicId: publicIdSchema, versionPublicId: publicIdSchema.optional() });

export const policyEnforcementRouter = router({
  status: manager.meta({ rateLimit: "api" }).input(z.strictObject(document))
    .query(({ ctx, input }) => ctx.services.compliance.policyEnforcement.adminStatus(input.documentPublicId)),
  defaultStatus: manager.meta({ rateLimit: "api" })
    .query(({ ctx }) => ctx.services.compliance.policyEnforcement.defaultStatus()),
  setDefaultWarning: manager.meta({ rateLimit: "form_submission" }).input(z.strictObject({ warningText: warningTextSchema }))
    .mutation(({ ctx, input }) => ctx.services.compliance.policyEnforcement.setWarning(ctx.session, input.warningText)),
  configure: manager.meta({ rateLimit: "form_submission" }).input(z.strictObject({
    ...document, expectedVersion: z.number().int().nonnegative().max(0xfffffffe),
    mode: z.enum(POLICY_ENFORCEMENT_MODES), graceHours: z.number().int().min(0).max(720),
    warningText: warningTextSchema.nullable(), confirmedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })).mutation(({ ctx, input }) => ctx.services.compliance.policyEnforcement.setConfig(ctx.session, input)),
  forTarget: readTarget.meta({ rateLimit: "api" }).input(target)
    .query(({ ctx, input }) => ctx.services.compliance.policyEnforcement.targetStatus(input)),
  endNow: revoke.meta({ rateLimit: "form_submission" }).input(target)
    .mutation(({ ctx, input }) => ctx.services.compliance.policyEnforcement.endNow(ctx.session, input)),
  pending: sessionProcedure.meta({ rateLimit: "api" })
    .query(({ ctx }) => ctx.services.compliance.policyEnforcement.pendingForUser(ctx.session)),
  decline: sessionProcedure.meta({ rateLimit: "form_submission" }).input(z.strictObject(version))
    .mutation(({ ctx, input }) => ctx.services.compliance.policyEnforcement.decline(ctx.session, input.versionPublicId)),
  accept: sessionProcedure.meta({ rateLimit: "form_submission" }).input(acceptPolicySchema.omit({ orderPublicId: true }))
    .mutation(({ ctx, input }) => {
      if (ctx.session.state === "full") return ctx.services.compliance.policies.accept(ctx.session, input);
      if (ctx.session.pendingSteps[0] !== "accept_policy") throw forbidden("POLICY_ENFORCEMENT_STEP_NOT_AVAILABLE");
      return ctx.services.compliance.policies.acceptRemediation(ctx.session, input);
    }),
});
