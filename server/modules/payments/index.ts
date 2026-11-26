/**
 * Payments module — Increment 04, Package K (`server/modules/payments`).
 * Owner: compliance_engineer (core service, Stripe adapter, raw HTTP, router, schema);
 *        files_engineer (Square adapter & `/admin/payments` UI).
 */
import "./settings.js";
import type { ModuleDeps } from "../../container.js";
import type { ModuleHealth, ModuleLifecycle } from "../../core/types.js";
import { registerRefundReconciliation } from "../jobs/refundSupport.js";
import { createPaymentReturnHttpRouter, createPaymentWebhooksHttpRouter } from "./http.js";
import { createSquareProviderAdapter } from "./providers/square.js";
import { createSquareRefundAdapter } from "./providers/square-refund.js";
import {
  buildSignedStripeSelfTestWebhook,
  createStripeProvider,
  createStripeProviderAdapter,
  createStripeRefundAdapter,
  createStripeRefundProvider,
  extractSafeStripeErrorDiagnostics,
  isAllowedStripeHostedUrl,
  STRIPE_REQUIRED_WEBHOOK_EVENTS,
} from "./providers/stripe.js";
import type {
  CreateProviderRefundInput,
  LookupProviderRefundInput,
  PaymentProviderAdapter,
  PaymentProviderAdapterDeps,
  PaymentRefundAdapter,
  ProviderCreateCheckoutInput,
  ProviderCreateCheckoutOutput,
  ProviderCredentials,
  ProviderFetchedPayment,
  ProviderFetchPaymentInput,
  ProviderListedRefundItem,
  ProviderListPaymentRefundsInput,
  ProviderListPaymentRefundsResult,
  ProviderRefundExecutionOutcome,
  ProviderRefundLookupResult,
  ProviderTestConnectionInput,
  ProviderTestConnectionResult,
  ProviderVerifyCheckoutSessionInput,
  ProviderVerifyCheckoutSessionResult,
  ProviderVerifyWebhookInput,
  ProviderVerifyWebhookOutput,
} from "./providers/types.js";
import {
  createOrderRefundInputSchema,
  paymentsRouter,
  type PaymentsRouter,
  updatePaymentsSettingsInputSchema,
} from "./router.js";
import {
  ACTIVE_PAYMENT_PROVIDERS,
  type ActivePaymentProvider,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_ENVIRONMENT_MODES,
  PAYMENT_PROVIDER_CHOICES,
  PAYMENT_REFUND_STATUSES,
  PAYMENT_WEBHOOK_ENV_HINTS,
  PAYMENT_WEBHOOK_STATUSES,
  type PaymentAttemptRow,
  paymentAttempts,
  type PaymentAttemptStatus,
  type PaymentEnvironmentMode,
  type PaymentProviderChoice,
  type PaymentRefundRow,
  paymentRefunds,
  type PaymentRefundStatus,
  type PaymentWebhookEnvHint,
  type PaymentWebhookEventRow,
  paymentWebhookEvents,
  type PaymentWebhookRejectionRow,
  paymentWebhookRejections,
  type PaymentWebhookStatus,
} from "./schema.js";
import {
  type AdminPaymentAttemptDetail,
  type AdminPaymentAttemptSummary,
  type AdminPaymentWebhookSummary,
  type CancelAttemptResult,
  type CheckoutAmountEvaluation,
  type CheckoutReturnPaths,
  type CheckoutStatusView,
  type CreateOrderRefundInput,
  type CreateOrderRefundResultView,
  createPaymentsService,
  type ListWebhookRejectionsInput,
  type OnlinePaymentUnavailableReason,
  type OrderPaymentProviderKind,
  type OrderPaymentRefundItemView,
  type OrderRefundablePaymentView,
  type OrderRefundWorkspaceView,
  type PaymentsAdminSettingsView,
  type PaymentsPublicConfigView,
  type PaymentsReadinessChecklistItem,
  type PaymentsReadinessView,
  type PaymentsService,
  type PaymentsServiceOptions,
  type PaymentWebhookRejectionSummary,
  type PaymentWebhookResult,
  type ReconcilePaymentsResult,
  REFUND_CONFIRMATION_PHRASE,
  type RefundExecutionKind,
  type RefundExecutionLabel,
  type SendStripeSelfTestWebhookResult,
  type StartCheckoutOptions,
  type StartCheckoutResult,
  type StripeMissingGateKey,
  type TestStripeConnectionResult,
  type UpdatePaymentsSettingsInput,
  type VerifyStripeCheckoutSessionResult,
} from "./service.js";
import {
  CHECKOUT_FAILURE_CLASSES,
  type CheckoutFailureClass,
  classifyCheckoutFailureReason,
  CREDENTIAL_FIELD_KEYS,
  type CredentialFieldKey,
  type CredentialValidationReason,
  type CredentialValidationResult,
  customerMessageForCheckoutFailure,
  DEFAULT_PAYMENTS_DIAGNOSTICS,
  DEFAULT_PAYMENTS_RECEIPTS,
  DEFAULT_PAYMENTS_SMALL_TOTALS,
  DEFAULT_PROVIDER_MINIMUMS_MINOR,
  describeCheckoutFailureForAdmin,
  isSafePortalReturnPath,
  type LastCheckoutFailureDiagnostic,
  type LastStripeCheckoutProbeDiagnostic,
  maskLast4,
  normalizeCredentialInput,
  parsePaymentsConfigSetting,
  parsePaymentsDiagnosticsSetting,
  parsePaymentsReceiptsSetting,
  parsePaymentsSmallTotals,
  PAYMENTS_CONFIG_SETTING,
  type PaymentsConfigValue,
  PAYMENTS_DIAGNOSTICS_SETTING,
  type PaymentsDiagnosticsValue,
  PAYMENTS_RECEIPTS_SETTING,
  type PaymentsReceiptsValue,
  PAYMENTS_SMALL_TOTALS_SETTING,
  type PaymentsSmallTotalsValue,
  PAYMENTS_SQUARE_ACCESS_TOKEN,
  PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY,
  PAYMENTS_STRIPE_SECRET_KEY,
  PAYMENTS_STRIPE_WEBHOOK_SECRET,
  PAYMENTS_STRIPE_WEBHOOK_SECRET_SECONDARY,
  resolveProviderMinimumMinor,
  sanitizeStripeDiagnosticToken,
  SMALL_TOTAL_BEHAVIORS,
  type SmallTotalBehavior,
  validateSquareSecretInput,
  validateStripeSecretKeyInput,
  validateStripeWebhookSecretInput,
} from "./settings.js";

export const RECONCILE_PAYMENTS_JOB_TYPE = "payments.reconcile_redirected";
export const RECONCILE_PAYMENTS_SCHEDULE_NAME = "payments.reconcile.every_5m";
export const RECONCILE_PAYMENTS_EVERY_MS = 5 * 60 * 1000;

export type PaymentsModule = ModuleLifecycle & PaymentsService;

export function createPaymentsModule(
  deps: ModuleDeps,
  options?: PaymentsServiceOptions,
): PaymentsModule {
  const serviceRef: { current?: PaymentsService } = {};
  const enqueueRefundReconciliation = registerRefundReconciliation(
    deps.jobs,
    (refundPublicId, context) => {
      if (!serviceRef.current) {
        return Promise.resolve("pending");
      }
      return serviceRef.current.reconcileProviderRefund(refundPublicId, context);
    },
  );
  const service = createPaymentsService(deps, {
    ...options,
    enqueueRefundReconciliation:
      options?.enqueueRefundReconciliation ?? enqueueRefundReconciliation,
  });
  serviceRef.current = service;

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
  buildSignedStripeSelfTestWebhook,
  CHECKOUT_FAILURE_CLASSES,
  classifyCheckoutFailureReason,
  createOrderRefundInputSchema,
  createPaymentReturnHttpRouter,
  createPaymentsService,
  createPaymentWebhooksHttpRouter,
  createSquareProviderAdapter,
  createSquareRefundAdapter,
  createStripeProvider,
  createStripeProviderAdapter,
  createStripeRefundAdapter,
  createStripeRefundProvider,
  CREDENTIAL_FIELD_KEYS,
  customerMessageForCheckoutFailure,
  DEFAULT_PAYMENTS_DIAGNOSTICS,
  DEFAULT_PAYMENTS_RECEIPTS,
  DEFAULT_PAYMENTS_SMALL_TOTALS,
  DEFAULT_PROVIDER_MINIMUMS_MINOR,
  describeCheckoutFailureForAdmin,
  extractSafeStripeErrorDiagnostics,
  isAllowedStripeHostedUrl,
  isSafePortalReturnPath,
  maskLast4,
  normalizeCredentialInput,
  parsePaymentsConfigSetting,
  parsePaymentsDiagnosticsSetting,
  parsePaymentsReceiptsSetting,
  parsePaymentsSmallTotals,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_ENVIRONMENT_MODES,
  PAYMENT_PROVIDER_CHOICES,
  PAYMENT_REFUND_STATUSES,
  PAYMENT_WEBHOOK_ENV_HINTS,
  PAYMENT_WEBHOOK_STATUSES,
  paymentAttempts,
  paymentRefunds,
  PAYMENTS_CONFIG_SETTING,
  PAYMENTS_DIAGNOSTICS_SETTING,
  PAYMENTS_RECEIPTS_SETTING,
  PAYMENTS_SMALL_TOTALS_SETTING,
  PAYMENTS_SQUARE_ACCESS_TOKEN,
  PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY,
  PAYMENTS_STRIPE_SECRET_KEY,
  PAYMENTS_STRIPE_WEBHOOK_SECRET,
  PAYMENTS_STRIPE_WEBHOOK_SECRET_SECONDARY,
  paymentsRouter,
  paymentWebhookEvents,
  paymentWebhookRejections,
  REFUND_CONFIRMATION_PHRASE,
  resolveProviderMinimumMinor,
  sanitizeStripeDiagnosticToken,
  SMALL_TOTAL_BEHAVIORS,
  STRIPE_REQUIRED_WEBHOOK_EVENTS,
  updatePaymentsSettingsInputSchema,
  validateSquareSecretInput,
  validateStripeSecretKeyInput,
  validateStripeWebhookSecretInput,
};

export type {
  ActivePaymentProvider,
  AdminPaymentAttemptDetail,
  AdminPaymentAttemptSummary,
  AdminPaymentWebhookSummary,
  CancelAttemptResult,
  CheckoutAmountEvaluation,
  CheckoutFailureClass,
  CheckoutReturnPaths,
  CheckoutStatusView,
  CreateOrderRefundInput,
  CreateOrderRefundResultView,
  CreateProviderRefundInput,
  CredentialFieldKey,
  CredentialValidationReason,
  CredentialValidationResult,
  LastCheckoutFailureDiagnostic,
  LastStripeCheckoutProbeDiagnostic,
  ListWebhookRejectionsInput,
  LookupProviderRefundInput,
  OnlinePaymentUnavailableReason,
  OrderPaymentProviderKind,
  OrderPaymentRefundItemView,
  OrderRefundablePaymentView,
  OrderRefundWorkspaceView,
  PaymentAttemptRow,
  PaymentAttemptStatus,
  PaymentEnvironmentMode,
  PaymentProviderAdapter,
  PaymentProviderAdapterDeps,
  PaymentProviderChoice,
  PaymentRefundAdapter,
  PaymentRefundRow,
  PaymentRefundStatus,
  PaymentsAdminSettingsView,
  PaymentsConfigValue,
  PaymentsDiagnosticsValue,
  PaymentsPublicConfigView,
  PaymentsReadinessChecklistItem,
  PaymentsReadinessView,
  PaymentsReceiptsValue,
  PaymentsRouter,
  PaymentsService,
  PaymentsServiceOptions,
  PaymentsSmallTotalsValue,
  PaymentWebhookEnvHint,
  PaymentWebhookEventRow,
  PaymentWebhookRejectionRow,
  PaymentWebhookRejectionSummary,
  PaymentWebhookResult,
  PaymentWebhookStatus,
  ProviderCreateCheckoutInput,
  ProviderCreateCheckoutOutput,
  ProviderCredentials,
  ProviderFetchedPayment,
  ProviderFetchPaymentInput,
  ProviderListedRefundItem,
  ProviderListPaymentRefundsInput,
  ProviderListPaymentRefundsResult,
  ProviderRefundExecutionOutcome,
  ProviderRefundLookupResult,
  ProviderTestConnectionInput,
  ProviderTestConnectionResult,
  ProviderVerifyCheckoutSessionInput,
  ProviderVerifyCheckoutSessionResult,
  ProviderVerifyWebhookInput,
  ProviderVerifyWebhookOutput,
  ReconcilePaymentsResult,
  RefundExecutionKind,
  RefundExecutionLabel,
  SendStripeSelfTestWebhookResult,
  SmallTotalBehavior,
  StartCheckoutOptions,
  StartCheckoutResult,
  StripeMissingGateKey,
  TestStripeConnectionResult,
  UpdatePaymentsSettingsInput,
  VerifyStripeCheckoutSessionResult,
};
