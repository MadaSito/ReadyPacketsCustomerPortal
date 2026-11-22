/**
 * Payments tRPC router — mounted at `payments` on `appRouter` (Increment 04, Package K).
 * Owner: compliance_engineer.
 * Every input uses bounded `z.strictObject` schemas and `publicId` ULIDs (never internal numeric IDs).
 */
import { z } from "zod";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import {
  adminProcedure,
  protectedProcedure,
  requireCapability,
  router,
} from "../../trpc/trpc.js";
import type { PaymentsModule } from "./index.js";
import {
  ACTIVE_PAYMENT_PROVIDERS,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_ENVIRONMENT_MODES,
  PAYMENT_PROVIDER_CHOICES,
  PAYMENT_WEBHOOK_STATUSES,
} from "./schema.js";
import { isSafePortalReturnPath } from "./settings.js";

const publicIdSchema = z.string().length(26).regex(ULID_PATTERN, "Invalid identifier.");
const cursorSchema = z.string().trim().min(1).max(64);
const safeReturnPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(isSafePortalReturnPath, "Return path must be an allowlisted internal portal path.");

function requirePaymentsModule(services: Services): PaymentsModule {
  const mod = (services as Services & { payments?: PaymentsModule }).payments;
  if (!mod) {
    throw new DomainError("UNAVAILABLE", "PAYMENTS_UNAVAILABLE", "Payments module is not mounted.");
  }
  return mod;
}

const paymentsManageProc = adminProcedure.use(requireCapability("payments.manage"));

export const updatePaymentsSettingsInputSchema = z.strictObject({
  provider: z.enum(PAYMENT_PROVIDER_CHOICES),
  mode: z.enum(PAYMENT_ENVIRONMENT_MODES),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/u, "Currency must be a 3-letter ISO code."),
  successPath: safeReturnPathSchema.optional(),
  cancelPath: safeReturnPathSchema.optional(),
  webhookToleranceSeconds: z.number().int().min(30).max(300).optional(),
  stripeSecretKey: z.string().trim().min(1).max(256).optional(),
  clearStripeSecretKey: z.boolean().optional(),
  stripeWebhookSecret: z.string().trim().min(1).max(256).optional(),
  clearStripeWebhookSecret: z.boolean().optional(),
  squareLocationId: z
    .union([z.string().trim().regex(/^[A-Za-z0-9_-]{4,64}$/u), z.literal(""), z.null()])
    .optional(),
  squareAccessToken: z.string().trim().min(1).max(256).optional(),
  clearSquareAccessToken: z.boolean().optional(),
  squareWebhookSignatureKey: z.string().trim().min(1).max(256).optional(),
  clearSquareWebhookSignatureKey: z.boolean().optional(),
});

export const paymentsRouter = router({
  /** Non-secret active checkout configuration for customer invoice & checkout views. */
  publicConfig: protectedProcedure
    .meta({ rateLimit: "standard_browsing" })
    .query(({ ctx }) => requirePaymentsModule(ctx.services).getPublicCheckoutConfig()),

  /** Starts hosted checkout for an issued unpaid customer invoice (or returns `{ mode: "invoice" }`). */
  startInvoiceCheckout: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(
      z.strictObject({
        invoicePublicId: publicIdSchema,
        successPath: safeReturnPathSchema.optional(),
        cancelPath: safeReturnPathSchema.optional(),
        idempotencyKey: z.string().trim().min(4).max(128).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      requirePaymentsModule(ctx.services).startCheckout(
        input.invoicePublicId,
        {
          ...(input.successPath ? { successPath: input.successPath } : {}),
          ...(input.cancelPath ? { cancelPath: input.cancelPath } : {}),
        },
        {
          principal: ctx.session,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        },
      ),
    ),

  /** Read-only checkout status check (never marks an attempt or invoice paid). */
  checkoutStatus: protectedProcedure
    .meta({ rateLimit: "standard_browsing" })
    .input(
      z.strictObject({
        invoicePublicId: publicIdSchema.optional(),
        attemptPublicId: publicIdSchema.optional(),
      }),
    )
    .query(({ ctx, input }) =>
      requirePaymentsModule(ctx.services).getCheckoutStatus(ctx.session, input),
    ),

  /** POST-only customer cancellation of an unpaid attempt. */
  cancelAttempt: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(
      z.strictObject({
        invoicePublicId: publicIdSchema.optional(),
        attemptPublicId: publicIdSchema.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      requirePaymentsModule(ctx.services).cancelAttemptIfUnpaid(ctx.session, input),
    ),

  admin: router({
    getSettings: adminProcedure
      .meta({ rateLimit: "standard_browsing" })
      .query(({ ctx }) => requirePaymentsModule(ctx.services).admin.getSettings(ctx.session)),

    updateSettings: paymentsManageProc
      .meta({ rateLimit: "auth_high_risk" })
      .input(updatePaymentsSettingsInputSchema)
      .mutation(({ ctx, input }) =>
        requirePaymentsModule(ctx.services).admin.updateSettings(ctx.session, input),
      ),

    listAttempts: adminProcedure
      .meta({ rateLimit: "standard_browsing" })
      .input(
        z
          .strictObject({
            provider: z.enum(ACTIVE_PAYMENT_PROVIDERS).optional(),
            status: z.enum(PAYMENT_ATTEMPT_STATUSES).optional(),
            invoicePublicId: publicIdSchema.optional(),
            cursor: cursorSchema.optional(),
            limit: z.number().int().min(1).max(100).optional(),
          })
          .optional(),
      )
      .query(({ ctx, input }) =>
        requirePaymentsModule(ctx.services).admin.listAttempts(ctx.session, input ?? {}),
      ),

    getAttempt: adminProcedure
      .meta({ rateLimit: "standard_browsing" })
      .input(z.strictObject({ attemptPublicId: publicIdSchema }))
      .query(({ ctx, input }) =>
        requirePaymentsModule(ctx.services).admin.getAttempt(ctx.session, input.attemptPublicId),
      ),

    listWebhooks: adminProcedure
      .meta({ rateLimit: "standard_browsing" })
      .input(
        z
          .strictObject({
            provider: z.enum(ACTIVE_PAYMENT_PROVIDERS).optional(),
            status: z.enum(PAYMENT_WEBHOOK_STATUSES).optional(),
            cursor: cursorSchema.optional(),
            limit: z.number().int().min(1).max(100).optional(),
          })
          .optional(),
      )
      .query(({ ctx, input }) =>
        requirePaymentsModule(ctx.services).admin.listWebhooks(ctx.session, input ?? {}),
      ),

    reconcileNow: paymentsManageProc
      .meta({ rateLimit: "expensive" })
      .input(
        z
          .strictObject({
            limit: z.number().int().min(1).max(100).optional(),
          })
          .optional(),
      )
      .mutation(({ ctx, input }) =>
        requirePaymentsModule(ctx.services).admin.reconcileNow(ctx.session, input),
      ),
  }),
});

export type PaymentsRouter = typeof paymentsRouter;
