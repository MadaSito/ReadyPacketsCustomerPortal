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
  staffProcedure,
} from "../../trpc/trpc.js";
import type { PaymentsModule } from "./index.js";
import {
  ACTIVE_PAYMENT_PROVIDERS,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_ENVIRONMENT_MODES,
  PAYMENT_PROVIDER_CHOICES,
  PAYMENT_WEBHOOK_STATUSES,
} from "./schema.js";
import {
  isSafePortalReturnPath,
  paymentsReceiptsSchema,
  paymentsSmallTotalsSchema,
} from "./settings.js";

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
const paymentsRefundProc = adminProcedure.use(requireCapability("payments.refund"));

export const createOrderRefundInputSchema = z.strictObject({
  orderPublicId: publicIdSchema,
  paymentPublicId: publicIdSchema,
  amountMinor: z.number().int().positive().max(1_000_000_000),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/u, "Currency must be a 3-letter ISO code."),
  reason: z.string().min(1).max(1000),
  reasonCode: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/u, "Invalid refund reason code.")
    .optional(),
  sendCustomerNotice: z.boolean().default(false),
  confirmationPhrase: z.string().max(64),
  idempotencyKey: z.string().trim().min(8).max(128),
});

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
  stripeSecretKey: z.string().max(1024).optional(),
  clearStripeSecretKey: z.boolean().optional(),
  stripeWebhookSecret: z.string().max(1024).optional(),
  clearStripeWebhookSecret: z.boolean().optional(),
  stripeWebhookSecretSecondary: z.string().max(1024).optional(),
  clearStripeWebhookSecretSecondary: z.boolean().optional(),
  squareLocationId: z
    .union([z.string().trim().regex(/^[A-Za-z0-9_-]{4,64}$/u), z.literal(""), z.null()])
    .optional(),
  squareAccessToken: z.string().max(1024).optional(),
  clearSquareAccessToken: z.boolean().optional(),
  squareWebhookSignatureKey: z.string().max(1024).optional(),
  clearSquareWebhookSignatureKey: z.boolean().optional(),
  smallTotals: paymentsSmallTotalsSchema.optional(),
  receipts: paymentsReceiptsSchema.optional(),
});

export const paymentsRouter = router({
  /** Non-secret active checkout configuration for customer invoice & checkout views. */
  publicConfig: protectedProcedure
    .meta({ rateLimit: "standard_browsing" })
    .query(({ ctx }) => requirePaymentsModule(ctx.services).getPublicCheckoutConfig()),

  /** Starts hosted checkout for an issued unpaid customer invoice (throws customer-safe error when online payment cannot start). */
  startInvoiceCheckout: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(
      z.strictObject({
        invoicePublicId: publicIdSchema,
        cartPublicId: publicIdSchema.optional(),
        successPath: safeReturnPathSchema.optional(),
        cancelPath: safeReturnPathSchema.optional(),
        idempotencyKey: z.string().trim().min(4).max(128).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      requirePaymentsModule(ctx.services).startInvoiceCheckout(
        input.invoicePublicId,
        {
          ...(input.successPath ? { successPath: input.successPath } : {}),
          ...(input.cancelPath ? { cancelPath: input.cancelPath } : {}),
        },
        {
          principal: ctx.session,
          ...(input.cartPublicId ? { cartPublicId: input.cartPublicId } : {}),
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

  /**
   * Increment 08 D5 authoritative customer payment confirmation (`payments.confirmCheckoutPayment`).
   * Queries Stripe Checkout session server-side over pinned TLS for an attempt owned by the customer,
   * enforces strict binding/amount/currency/livemode checks + per-attempt cooldown, and books idempotently.
   */
  confirmCheckoutPayment: protectedProcedure
    .meta({ rateLimit: "form_submission" })
    .input(
      z.strictObject({
        attemptPublicId: publicIdSchema,
      }),
    )
    .mutation(({ ctx, input }) =>
      requirePaymentsModule(ctx.services).confirmCheckoutPayment(ctx.session, input),
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

    readiness: adminProcedure
      .meta({ rateLimit: "standard_browsing" })
      .query(({ ctx }) => requirePaymentsModule(ctx.services).admin.readiness(ctx.session)),

    testConnection: paymentsManageProc
      .meta({ rateLimit: "auth_high_risk" })
      .input(
        z
          .strictObject({
            provider: z.literal("stripe").optional(),
          })
          .optional(),
      )
      .mutation(({ ctx }) => requirePaymentsModule(ctx.services).admin.testConnection(ctx.session)),

    verifyCheckoutSession: paymentsManageProc
      .meta({ rateLimit: "auth_high_risk" })
      .input(
        z
          .strictObject({
            provider: z.literal("stripe").optional(),
          })
          .optional(),
      )
      .mutation(({ ctx }) =>
        requirePaymentsModule(ctx.services).admin.verifyCheckoutSession(ctx.session),
      ),

    sendSelfTestWebhook: paymentsManageProc
      .meta({ rateLimit: "auth_high_risk" })
      .input(
        z
          .strictObject({
            provider: z.literal("stripe").optional(),
          })
          .optional(),
      )
      .mutation(({ ctx }) =>
        requirePaymentsModule(ctx.services).admin.sendSelfTestWebhook(ctx.session),
      ),

    listWebhookRejections: adminProcedure
      .meta({ rateLimit: "standard_browsing" })
      .input(
        z
          .strictObject({
            provider: z.enum(ACTIVE_PAYMENT_PROVIDERS).optional(),
            reasonCode: z.string().trim().min(1).max(64).optional(),
            cursor: cursorSchema.optional(),
            limit: z.number().int().min(1).max(100).optional(),
          })
          .optional(),
      )
      .query(({ ctx, input }) =>
        requirePaymentsModule(ctx.services).admin.listWebhookRejections(ctx.session, input ?? {}),
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

    /**
     * Increment 08 D5 step-up live Stripe check & pre-upgrade payment repair (`payments.admin.checkWithStripeNow`).
     * Requires `payments.manage` (which enforces fresh MFA step-up via `STEP_UP_CAPABILITIES`).
     */
    checkWithStripeNow: paymentsManageProc
      .meta({ rateLimit: "auth_high_risk" })
      .input(
        z
          .strictObject({
            attemptPublicId: publicIdSchema.optional(),
            invoicePublicId: publicIdSchema.optional(),
          })
          .refine(
            (v) => Boolean(v.attemptPublicId || v.invoicePublicId),
            "Provide attemptPublicId or invoicePublicId.",
          ),
      )
      .mutation(({ ctx, input }) =>
        requirePaymentsModule(ctx.services).admin.checkWithStripeNow(ctx.session, input),
      ),
  }),

  /** Console Order Workspace — Refunds tab (`payments.refunds.{forOrder,create}`). */
  refunds: router({
    forOrder: staffProcedure
      .meta({ rateLimit: "standard_browsing" })
      .input(z.strictObject({ orderPublicId: publicIdSchema }))
      .query(({ ctx, input }) =>
        requirePaymentsModule(ctx.services).refunds.forOrder(ctx.session, input),
      ),

    create: paymentsRefundProc
      .meta({ rateLimit: "auth_high_risk" })
      .input(createOrderRefundInputSchema)
      .mutation(({ ctx, input }) =>
        requirePaymentsModule(ctx.services).refunds.create(ctx.session, input),
      ),
  }),
});

export type PaymentsRouter = typeof paymentsRouter;
