/**
 * Billing profile tRPC router (Increment 08, Decision D4).
 * Owner: compliance_engineer.
 */
import { DomainError } from "../../core/errors.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import {
  clearBillingProfileInputSchema,
  saveBillingProfileInputSchema,
  type BillingProfileModule,
} from "./types.js";

function requireBillingProfileModule(services: unknown): BillingProfileModule {
  const mod = (services as { billingProfile?: BillingProfileModule } | null | undefined)?.billingProfile;
  if (!mod) {
    throw new DomainError(
      "UNAVAILABLE",
      "BILLING_PROFILE_UNAVAILABLE",
      "Billing settings are temporarily unavailable.",
    );
  }
  return mod;
}

export const billingProfileRouter = router({
  get: protectedProcedure.query(({ ctx }) =>
    requireBillingProfileModule(ctx.services).get(ctx.session),
  ),

  save: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(saveBillingProfileInputSchema)
    .mutation(({ ctx, input }) =>
      requireBillingProfileModule(ctx.services).save(ctx.session, input),
    ),

  clear: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(clearBillingProfileInputSchema)
    .mutation(({ ctx, input }) =>
      requireBillingProfileModule(ctx.services).clear(ctx.session, input),
    ),
});

export type BillingProfileRouter = typeof billingProfileRouter;
