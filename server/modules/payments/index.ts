/**
 * Payments module — Increment 04, Package K (`server/modules/payments`).
 * Owner: compliance_engineer (core service, Stripe adapter, raw HTTP, router, schema);
 *        files_engineer (Square adapter & `/admin/payments` UI).
 */
import "./settings.js";
import type { ModuleDeps } from "../../container.js";
import type { ModuleHealth, ModuleLifecycle } from "../../core/types.js";
import { createPaymentReturnHttpRouter, createPaymentWebhooksHttpRouter } from "./http.js";
import { createSquareProviderAdapter } from "./providers/square.js";
import { createStripeProvider, createStripeProviderAdapter, isAllowedStripeHostedUrl } from "./providers/stripe.js";
import type {
  PaymentProviderAdapter,
  ProviderCreateCheckoutInput,
  ProviderCreateCheckoutOutput,
  ProviderCredentials,
  ProviderFetchedPayment,
  ProviderFetchPaymentInput,
  ProviderVerifyWebhookInput,
  ProviderVerifyWebhookOutput,
} from "./providers/types.js";
import { paymentsRouter, type PaymentsRouter, updatePaymentsSettingsInputSchema } from "./router.js";
import {
  ACTIVE_PAYMENT_PROVIDERS,
  type ActivePaymentProvider,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_ENVIRONMENT_MODES,
  PAYMENT_PROVIDER_CHOICES,
  PAYMENT_WEBHOOK_STATUSES,
  type PaymentAttemptRow,
  paymentAttempts,
  type PaymentAttemptStatus,
  type PaymentEnvironmentMode,
  type PaymentProviderChoice,
  type PaymentWebhookEventRow,
  paymentWebhookEvents,
  type PaymentWebhookStatus,
} from "./schema.js";
import {
  type AdminPaymentAttemptDetail,
  type AdminPaymentAttemptSummary,
  type AdminPaymentWebhookSummary,
  type CancelAttemptResult,
  type CheckoutReturnPaths,
  type CheckoutStatusView,
  createPaymentsService,
  type PaymentsAdminSettingsView,
  type PaymentsPublicConfigView,
  type PaymentsService,
  type PaymentsServiceOptions,
  type PaymentWebhookResult,
  type ReconcilePaymentsResult,
  type StartCheckoutOptions,
  type StartCheckoutResult,
  type UpdatePaymentsSettingsInput,
} from "./service.js";
import {
  isSafePortalReturnPath,
  maskLast4,
  PAYMENTS_CONFIG_SETTING,
  type PaymentsConfigValue,
  PAYMENTS_SQUARE_ACCESS_TOKEN,
  PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY,
  PAYMENTS_STRIPE_SECRET_KEY,
  PAYMENTS_STRIPE_WEBHOOK_SECRET,
} from "./settings.js";

export const RECONCILE_PAYMENTS_JOB_TYPE = "payments.reconcile_redirected";
export const RECONCILE_PAYMENTS_SCHEDULE_NAME = "payments.reconcile.every_5m";
export const RECONCILE_PAYMENTS_EVERY_MS = 5 * 60 * 1000;

export type PaymentsModule = ModuleLifecycle & PaymentsService;

export function createPaymentsModule(
  deps: ModuleDeps,
  options?: PaymentsServiceOptions,
): PaymentsModule {
  const service = createPaymentsService(deps, options);

  deps.jobs.register(
    RECONCILE_PAYMENTS_JOB_TYPE,
    async (job) => {
      await job.assertStillOwned();
      const counts = await service.reconcilePendingAttempts({
        limit: 25,
        signal: job.signal,
        beforeSend: () => job.assertStillOwned(),
      });
      return {
        outcome: "completed",
        safeCounts: {
          scanned: counts.scanned,
          booked: counts.booked,
          expired: counts.expired,
          failed: counts.failed,
          still_pending: counts.stillPending,
        },
      };
    },
    { retrySafe: true },
  );

  deps.jobs.registerSchedule({
    name: RECONCILE_PAYMENTS_SCHEDULE_NAME,
    type: RECONCILE_PAYMENTS_JOB_TYPE,
    everyMs: RECONCILE_PAYMENTS_EVERY_MS,
  });

  return {
    ...service,

    init(): void {},

    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      try {
        const counts = await service.healthCounts();
        return [
          {
            component: "payments",
            state: "ok",
            summary: counts.onlineEnabled
              ? `${counts.provider} hosted checkout active.`
              : "Pay-by-invoice default (online checkout disabled).",
            metrics: {
              redirectedAttempts: counts.redirectedAttempts,
              retryPendingWebhooks: counts.retryPendingWebhooks,
            },
            checkedAt,
          },
        ];
      } catch {
        return [
          {
            component: "payments",
            state: "failing",
            summary: "Payments database health query failed.",
            checkedAt,
          },
        ];
      }
    },
  };
}

export {
  ACTIVE_PAYMENT_PROVIDERS,
  createPaymentReturnHttpRouter,
  createPaymentsService,
  createPaymentWebhooksHttpRouter,
  createSquareProviderAdapter,
  createStripeProvider,
  createStripeProviderAdapter,
  isAllowedStripeHostedUrl,
  isSafePortalReturnPath,
  maskLast4,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_ENVIRONMENT_MODES,
  PAYMENT_PROVIDER_CHOICES,
  PAYMENT_WEBHOOK_STATUSES,
  paymentAttempts,
  PAYMENTS_CONFIG_SETTING,
  PAYMENTS_SQUARE_ACCESS_TOKEN,
  PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY,
  PAYMENTS_STRIPE_SECRET_KEY,
  PAYMENTS_STRIPE_WEBHOOK_SECRET,
  paymentsRouter,
  paymentWebhookEvents,
  updatePaymentsSettingsInputSchema,
};

export type {
  ActivePaymentProvider,
  AdminPaymentAttemptDetail,
  AdminPaymentAttemptSummary,
  AdminPaymentWebhookSummary,
  CancelAttemptResult,
  CheckoutReturnPaths,
  CheckoutStatusView,
  PaymentAttemptRow,
  PaymentAttemptStatus,
  PaymentEnvironmentMode,
  PaymentProviderAdapter,
  PaymentProviderChoice,
  PaymentsAdminSettingsView,
  PaymentsConfigValue,
  PaymentsPublicConfigView,
  PaymentsRouter,
  PaymentsService,
  PaymentsServiceOptions,
  PaymentWebhookEventRow,
  PaymentWebhookResult,
  PaymentWebhookStatus,
  ProviderCreateCheckoutInput,
  ProviderCreateCheckoutOutput,
  ProviderCredentials,
  ProviderFetchedPayment,
  ProviderFetchPaymentInput,
  ProviderVerifyWebhookInput,
  ProviderVerifyWebhookOutput,
  ReconcilePaymentsResult,
  StartCheckoutOptions,
  StartCheckoutResult,
  UpdatePaymentsSettingsInput,
};
