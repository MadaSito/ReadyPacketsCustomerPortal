/**
 * Assurance module — tRPC router (mounted at `trpc.assurance.*`). Owner: assurance module engineer.
 * Nest customer/staff/admin sub-routers as needed. Use only the guards from server/trpc/trpc.ts.
 */
import { z } from "zod";
import { protectedProcedure, requireCapability, router, sessionProcedure, staffProcedure } from "../../trpc/trpc.js";
import { adminCredentialInput, factorInput, passkeyName, passwordInput, publicId, registrationResponse, reissueFactor, totpCode } from "./input.js";

const proofProcedure = sessionProcedure.meta({ rateLimit: "auth_high_risk" });
const highRisk = protectedProcedure.meta({ rateLimit: "auth_high_risk" });
const administer = staffProcedure.meta({ rateLimit: "auth_high_risk" }).use(requireCapability("customers.credentials.administer"));
const ok = { ok: true } as const;

export const assuranceRouter = router({
  getState: sessionProcedure.query(({ ctx }) => ctx.services.assurance.getSecurityState(ctx.session)),
  beginTotpEnrollment: proofProcedure.mutation(({ ctx }) => ctx.services.assurance.beginTotpEnrollment(ctx.session)),
  confirmTotpEnrollment: proofProcedure.input(z.strictObject({ code: totpCode })).mutation(async ({ ctx, input }) => {
    const result = await ctx.services.assurance.confirmTotpEnrollment(ctx.session, input.code);
    if (result.issued) ctx.transport.issue(result.issued);
    return result.data;
  }),
  acknowledgeRecoveryCodes: sessionProcedure.input(z.strictObject({ recoverySetId: publicId }))
    .mutation(({ ctx, input }) => ctx.services.assurance.acknowledgeRecoveryCodes(ctx.session, input.recoverySetId)),
  recoverUnacknowledgedCodes: proofProcedure.input(z.strictObject({ factor: reissueFactor }))
    .mutation(({ ctx, input }) => ctx.services.assurance.recoverUnacknowledgedCodes(ctx.session, input.factor)),
  regenerateRecoveryCodes: highRisk.mutation(({ ctx }) => ctx.services.assurance.regenerateRecoveryCodes(ctx.session)),
  challenge: proofProcedure.input(factorInput).mutation(async ({ ctx, input }) => {
    ctx.transport.issue(await ctx.services.assurance.challenge(ctx.session, input));
    return ok;
  }),
  stepUp: highRisk.input(z.strictObject({ password: passwordInput, factor: factorInput })).mutation(async ({ ctx, input }) => {
    ctx.transport.issue(await ctx.services.assurance.stepUp(ctx.session, input.password, input.factor));
    return ok;
  }),
  disableTotp: highRisk.mutation(({ ctx }) => ctx.services.assurance.disableTotp(ctx.session)),
  listPasskeys: protectedProcedure.query(({ ctx }) => ctx.services.assurance.listPasskeys(ctx.session)),
  beginPasskeyAuthentication: proofProcedure.input(z.strictObject({ purpose: z.enum(["challenge", "step_up", "recovery_reissue"]) }))
    .mutation(({ ctx, input }) => ctx.services.assurance.beginPasskeyAuthentication(ctx.session, input.purpose)),
  beginPasskeyRegistration: highRisk.mutation(({ ctx }) => ctx.services.assurance.beginPasskeyRegistration(ctx.session)),
  finishPasskeyRegistration: highRisk.input(z.strictObject({ challengeId: publicId, response: registrationResponse, name: passkeyName }))
    .mutation(({ ctx, input }) => ctx.services.assurance.finishPasskeyRegistration(ctx.session, input.challengeId, input.response, input.name)),
  renamePasskey: highRisk.input(z.strictObject({ publicId, name: passkeyName }))
    .mutation(({ ctx, input }) => ctx.services.assurance.renamePasskey(ctx.session, input.publicId, input.name)),
  removePasskey: highRisk.input(z.strictObject({ publicId }))
    .mutation(({ ctx, input }) => ctx.services.assurance.removePasskey(ctx.session, input.publicId)),
  admin: router({
    setCredential: administer.input(adminCredentialInput)
      .mutation(({ ctx, input }) => ctx.services.assurance.administerCredential(ctx.session, input)),
    resetMfa: administer.input(z.strictObject({ customerId: publicId }))
      .mutation(({ ctx, input }) => ctx.services.assurance.resetMfa(ctx.session, input.customerId)),
  }),
});
