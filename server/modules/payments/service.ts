/**
 * Payments module — Core domain service (Increment 04 Package K, updated Increment 08 Decision D5).
 * Owner: integrations_engineer.
 *
 * Enforces ADR 0035 & Increment 08 Decision D5:
 *  - Off by default (`provider = "none"` -> `{ mode: "invoice" }`, zero network activity).
 *  - Hosted Stripe Checkout & Square Payment Links over `integrations.egress.fetchPinned`.
 *  - Attempt state machine (`created -> redirected -> paid | failed | expired | cancelled`) guarded by CAS `version`.
 *  - Authoritative payment confirmation (D5, replacing Decision 12): a payment is booked through ONE idempotent
 *    booking function from EITHER a verified signed webhook OR an authoritative server-to-provider lookup over
 *    pinned TLS when ALL strict session/status/amount/currency/livemode/metadata checks hold.
 *  - Inert return route (`GET /api/payments/return/...`) performs zero DB reads/writes and redirects only to
 *    hardcoded reviewed same-origin paths; browser URL parameters are never trusted as proof of payment.
 */
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { getRequestContext } from "../../core/requestContext.js";
import { ULID_PATTERN, ulid } from "../../core/ids.js";
import type { DbOrTx, EnqueueOptions, SessionPrincipal, Tx } from "../../core/types.js";
import { assertLiveActorInTx, runComplianceTx } from "../compliance/actorAuth.js";
import { decodeIdCursor, encodeIdCursor, type InvoicePaymentState } from "../compliance/domain.js";
import {
  complianceInvoicePayments,
  complianceInvoiceRefunds,
  complianceInvoices,
} from "../compliance/schema.js";
import {
  REFUND_NOTICE_TEMPLATE_KEY,
  REFUND_RECONCILE_JOB,
  type RefundReconcileContext,
} from "../jobs/refundSupport.js";
import { stripeWebhookDeliveryMissingAlert } from "../opsAlerts/stripeWebhook.js";
import { isSecretConfigured, readSecret, readSetting, writeSetting } from "../platform/index.js";
import type { TrashEntityRef, TrashPurgeResult } from "../trash/ports.js";
import { createSquareProviderAdapter } from "./providers/square.js";
import { createSquareRefundAdapter } from "./providers/square-refund.js";
import {
  buildSignedStripeSelfTestWebhook,
  createStripeProviderAdapter,
  createStripeRefundAdapter,
  STRIPE_REQUIRED_WEBHOOK_EVENTS,
} from "./providers/stripe.js";
import type {
  PaymentProviderAdapter,
  PaymentRefundAdapter,
  ProviderCredentials,
  ProviderFetchedPayment,
  ProviderVerifyWebhookOutput,
} from "./providers/types.js";
import {
  type ActivePaymentProvider,
  paymentAttempts,
  type PaymentAttemptRow,
  type PaymentAttemptStatus,
  type PaymentBookingSource,
  type PaymentEnvironmentMode,
  type PaymentProviderChoice,
  paymentRefunds,
  type PaymentRefundRow,
  type PaymentRefundStatus,
  type PaymentWebhookEnvHint,
  paymentWebhookEvents,
  type PaymentWebhookEventRow,
  paymentWebhookRejections,
  type PaymentWebhookRejectionRow,
  type PaymentWebhookStatus,
} from "./schema.js";
import {
  type CheckoutFailureClass,
  classifyCheckoutFailureReason,
  type CredentialFieldKey,
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
  sanitizeCardBrand,
  sanitizeCardLast4,
  sanitizeStripeDiagnosticToken,
  validateSquareSecretInput,
  validateStripeSecretKeyInput,
  validateStripeWebhookSecretInput,
} from "./settings.js";

export interface CheckoutReturnPaths {
  successPath?: string | undefined;
  cancelPath?: string | undefined;
}

export interface StartCheckoutOptions {
  principal?: SessionPrincipal | undefined;
  cartPublicId?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface CheckoutAmountEvaluation {
  onlineEnabled: boolean;
  provider: PaymentProviderChoice;
  minimumMinor: number;
  belowMinimum: boolean;
  smallTotalAction: "none" | "zero_total" | "waive" | "block";
}

export type StartCheckoutResult =
  | {
      mode: "invoice";
      invoicePublicId: string;
    }
  | {
      mode: "settled";
      settlementKind: "zero_total" | "waived_small_total";
      invoicePublicId: string;
      waivedMinor?: number | undefined;
      receiptPublicId?: string | undefined;
    }
  | {
      mode: "redirect";
      attemptPublicId: string;
      invoicePublicId: string;
      provider: ActivePaymentProvider;
      environment: PaymentEnvironmentMode;
      redirectUrl: string;
      expiresAt: Date | null;
    };

export interface PaymentsPublicConfigView {
  provider: PaymentProviderChoice;
  mode: PaymentEnvironmentMode;
  currency: string;
  onlineEnabled: boolean;
}

export type OnlinePaymentUnavailableReason =
  | "provider_off"
  | "provider_not_ready"
  | "invoice_not_payable"
  | "order_cancelled"
  | "order_locked"
  | "currency_mismatch"
  | "below_minimum";

export type StripeMissingGateKey =
  | "secret_key"
  | "secret_key_mode"
  | "webhook_secret"
  | "egress_allowlist"
  | "api_verified"
  | "checkout_session_not_verified"
  | "checkout_session_failed"
  | "webhook_self_test"
  | "provider_activated";

export interface CheckoutStatusView {
  invoicePublicId: string;
  invoiceNumber: string | null;
  invoiceStatus: "draft" | "issued" | "paid" | "void";
  amountMinor: number;
  balanceDueMinor: number;
  waivedMinor: number;
  receiptPublicId: string | null;
  currency: string;
  providerConfigured: PaymentProviderChoice;
  environment: PaymentEnvironmentMode;
  onlinePaymentAvailable: boolean;
  onlinePaymentUnavailableReason: OnlinePaymentUnavailableReason | null;
  attemptInFlight: boolean;
  lastAttemptFailureClass: CheckoutFailureClass | null;
  attempt: {
    attemptPublicId: string;
    provider: ActivePaymentProvider;
    environment: PaymentEnvironmentMode;
    status: PaymentAttemptStatus;
    bookingSource: PaymentBookingSource | null;
    cartPublicId: string | null;
    amountMinor: number;
    currency: string;
    createdAt: Date;
    redirectedAt: Date | null;
    paidAt: Date | null;
    expiresAt: Date | null;
    reconciliationNote: string | null;
    failureReasonCode: string | null;
  } | null;
}

export type CustomerPaymentConfirmationState = "paid" | "processing" | "unpaid";

export interface ConfirmCheckoutPaymentResult {
  attemptPublicId: string;
  orderPublicId: string;
  orderReference: string | null;
  invoicePublicId: string;
  invoiceNumber: string | null;
  invoiceStatus: "draft" | "issued" | "paid" | "void";
  receiptPublicId: string | null;
  cartPublicId: string | null;
  provider: ActivePaymentProvider;
  environment: PaymentEnvironmentMode;
  attemptStatus: PaymentAttemptStatus;
  state: CustomerPaymentConfirmationState;
  bookedNow: boolean;
  bookingSource: PaymentBookingSource | null;
  paidAt: string | null;
  cooldownRemainingMs: number;
}

export interface AdminCheckWithStripeInput {
  attemptPublicId?: string | undefined;
  invoicePublicId?: string | undefined;
}

export interface AdminCheckWithStripeResult {
  checkedCount: number;
  booked: boolean;
  alreadyPaid: boolean;
  invoicePublicId: string;
  invoiceStatus: "draft" | "issued" | "paid" | "void";
  receiptPublicId: string | null;
  attemptPublicId: string | null;
  attemptStatus: PaymentAttemptStatus | null;
  bookingSource: PaymentBookingSource | null;
  reasonCode: string;
}

export interface StripeWebhookRejectionReasonSummary {
  reasonCode: string;
  reasonLabel: string;
  count: number;
  latestAt: string;
}

export interface StripeWebhookDeliveryDiagnosticsView {
  missingWebhookDetected: boolean;
  unwebhookedLookupPaidCount: number;
  oldestUnwebhookedPaidAt: string | null;
  graceSeconds: number;
  lastVerifiedWebhookAt: string | null;
  lastVerifiedWebhookEventType: string | null;
  recentRejectionCount: number;
  recentRejectionReasons: StripeWebhookRejectionReasonSummary[];
  endpointUrl: string;
  requiredEvents: readonly string[];
  usualCauses: readonly [string, string, string];
}

export interface CancelAttemptResult {
  cancelled: boolean;
  attemptPublicId: string | null;
  status: PaymentAttemptStatus | null;
}

export interface PaymentWebhookResult {
  httpStatus: 200 | 400 | 409 | 503;
  accepted: boolean;
  duplicate: boolean;
  booked: boolean;
  reasonCode: string;
}

export interface ReconcilePaymentsResult {
  scanned: number;
  booked: number;
  expired: number;
  failed: number;
  stillPending: number;
}

export interface PaymentsAdminSettingsView
  extends Pick<
    PaymentsConfigValue,
    "provider" | "mode" | "currency" | "successPath" | "cancelPath" | "webhookToleranceSeconds"
  > {
  onlineEnabled: boolean;
  stripe: {
    secretKeyConfigured: boolean;
    secretKeyLast4: string | null;
    secretKeyModeMatches: boolean;
    webhookSecretConfigured: boolean;
    webhookSecretLast4: string | null;
    webhookSecretSecondaryConfigured: boolean;
    webhookSecretSecondaryLast4: string | null;
    lastApiVerifiedAt: string | null;
    lastSelfTestAt: string | null;
    lastSelfTestWebhookAt: string | null;
    apiVerified: boolean;
    selfTestVerified: boolean;
    checkoutSessionVerified: boolean;
    lastCheckoutSessionVerifiedAt: string | null;
    lastVerifiedWebhookAt: string | null;
    lastVerifiedWebhookEventType: string | null;
    lastVerifiedWebhookStatus: PaymentWebhookStatus | null;
    inboundCountryAllowlistExempt: true;
    requiredEvents: readonly string[];
    ready: boolean;
    statusHeadline: string;
    customerExperienceSummary: string;
    reverificationNeeded: boolean;
    reverificationReasons: string[];
    missingGates: StripeMissingGateKey[];
    lastCheckoutFailure: LastCheckoutFailureDiagnostic | null;
    lastCheckoutProbe: LastStripeCheckoutProbeDiagnostic | null;
    webhookUrl: string;
    returnUrlPattern: string;
    egressHost: "api.stripe.com";
    egressAllowlisted: boolean;
    webhookDelivery: StripeWebhookDeliveryDiagnosticsView;
  };
  square: {
    locationId: string | null;
    accessTokenConfigured: boolean;
    accessTokenLast4: string | null;
    webhookSignatureKeyConfigured: boolean;
    webhookSignatureKeyLast4: string | null;
    webhookUrl: string;
    returnUrlPattern: string;
    egressHost: "connect.squareup.com" | "connect.squareupsandbox.com";
    egressAllowlisted: boolean;
  };
  diagnostics: {
    lastCheckoutFailure: LastCheckoutFailureDiagnostic | null;
  };
  smallTotals: PaymentsSmallTotalsValue;
  defaultProviderMinimumsMinor: Readonly<Record<ActivePaymentProvider, Readonly<Record<string, number>>>>;
  receipts: PaymentsReceiptsValue;
}

export interface UpdatePaymentsSettingsInput {
  provider: PaymentProviderChoice;
  mode: PaymentEnvironmentMode;
  currency: string;
  successPath?: string | undefined;
  cancelPath?: string | undefined;
  webhookToleranceSeconds?: number | undefined;
  stripeSecretKey?: string | undefined;
  clearStripeSecretKey?: boolean | undefined;
  stripeWebhookSecret?: string | undefined;
  clearStripeWebhookSecret?: boolean | undefined;
  stripeWebhookSecretSecondary?: string | undefined;
  clearStripeWebhookSecretSecondary?: boolean | undefined;
  squareLocationId?: string | null | undefined;
  squareAccessToken?: string | undefined;
  clearSquareAccessToken?: boolean | undefined;
  squareWebhookSignatureKey?: string | undefined;
  clearSquareWebhookSignatureKey?: boolean | undefined;
  smallTotals?: PaymentsSmallTotalsValue | undefined;
  receipts?: PaymentsReceiptsValue | undefined;
}

export interface PaymentsReadinessChecklistItem {
  key:
    | "egress_allowlist"
    | "webhook_route_protection"
    | "stripe_secret_key"
    | "stripe_webhook_secret"
    | "api_connection_verified"
    | "checkout_session_verified"
    | "self_test_webhook_verified"
    | "provider_activated";
  label: string;
  ready: boolean;
  detail: string;
}

export interface PaymentsReadinessView {
  provider: PaymentProviderChoice;
  mode: PaymentEnvironmentMode;
  currency: string;
  onlineEnabled: boolean;
  statusHeadline: string;
  customerExperienceSummary: string;
  reverificationNeeded: boolean;
  reverificationReasons: string[];
  missingGates: StripeMissingGateKey[];
  lastCheckoutFailure: LastCheckoutFailureDiagnostic | null;
  lastCheckoutProbe: LastStripeCheckoutProbeDiagnostic | null;
  webhookUrl: string;
  requiredWebhookEvents: string[];
  egress: {
    presetKey: "stripe";
    host: "api.stripe.com";
    allowlisted: boolean;
  };
  routeProtection: {
    webhookPath: "/api/payments/webhooks/stripe";
    countryAllowlistExempt: true;
    ipRulesEnforced: true;
    rateLimitEnforced: true;
    bodyCapBytes: 262144;
  };
  secrets: {
    secretKeyConfigured: boolean;
    secretKeyLast4: string | null;
    secretKeyModeMatches: boolean;
    webhookSecretConfigured: boolean;
    webhookSecretLast4: string | null;
    webhookSecretSecondaryConfigured: boolean;
    webhookSecretSecondaryLast4: string | null;
  };
  verification: {
    lastApiVerifiedAt: string | null;
    lastSelfTestAt: string | null;
    checkoutSessionVerified: boolean;
    lastCheckoutSessionVerifiedAt: string | null;
    lastVerifiedWebhookAt: string | null;
    lastVerifiedWebhookEventType: string | null;
    attentionRequiredWebhookCount: number;
    recentRejectionCount24h: number;
  };
  checklist: PaymentsReadinessChecklistItem[];
}

export interface TestStripeConnectionResult {
  ok: boolean;
  provider: "stripe";
  mode: PaymentEnvironmentMode;
  livemode: boolean | null;
  accountRef: string | null;
  verifiedAt: string | null;
  failureReasonCode: string | null;
  detail: string;
  message: string;
}

export interface VerifyStripeCheckoutSessionResult {
  ok: boolean;
  provider: "stripe";
  mode: PaymentEnvironmentMode;
  livemode: boolean | null;
  sessionId: string | null;
  expiredImmediately: boolean;
  verifiedAt: string | null;
  failureReasonCode: string | null;
  upstreamStatus: number | null;
  stripeErrorType: string | null;
  stripeErrorCode: string | null;
  stripeErrorParam: string | null;
  detail: string;
  message: string;
}

export interface SendStripeSelfTestWebhookResult {
  ok: boolean;
  externalEventId: string;
  httpStatus: number;
  reasonCode: string;
  verifiedAt: string | null;
}

export interface PaymentWebhookRejectionSummary {
  publicId: string;
  rejectionPublicId: string;
  provider: ActivePaymentProvider;
  environmentHint: PaymentWebhookEnvHint;
  reasonCode: string;
  reasonLabel: string;
  httpStatus: number;
  skewSeconds: number | null;
  detail: string;
  receivedAt: Date;
}

export interface ListWebhookRejectionsInput {
  provider?: ActivePaymentProvider | undefined;
  reasonCode?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface AdminPaymentAttemptSummary {
  publicId: string;
  attemptPublicId: string;
  invoicePublicId: string;
  orderPublicId: string;
  cartPublicId: string | null;
  provider: ActivePaymentProvider;
  environment: PaymentEnvironmentMode;
  status: PaymentAttemptStatus;
  amountMinor: number;
  currency: string;
  providerRef: string | null;
  providerOrderRef: string | null;
  providerPaymentRef: string | null;
  verifiedWebhookEventId: string | null;
  bookingSource: PaymentBookingSource | null;
  compliancePaymentPublicId: string | null;
  reconciliationNote: string | null;
  failureReasonCode: string | null;
  redirectedAt: Date | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  lastReconciledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminPaymentWebhookSummary {
  publicId: string;
  webhookPublicId: string;
  provider: ActivePaymentProvider;
  environment: PaymentEnvironmentMode;
  externalEventId: string;
  eventType: string;
  attemptPublicId: string | null;
  providerRef: string | null;
  providerOrderRef: string | null;
  providerPaymentRef: string | null;
  providerRefundRef: string | null;
  status: PaymentWebhookStatus;
  reasonCode: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  occurredAt: Date;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface AdminPaymentAttemptDetail {
  attempt: AdminPaymentAttemptSummary;
  webhooks: AdminPaymentWebhookSummary[];
}

export type OrderPaymentProviderKind = "stripe" | "square" | "manual";
export type RefundExecutionKind = "provider_refund" | "recorded_only";
export type RefundExecutionLabel =
  | "Stripe refund"
  | "Square refund"
  | "recorded only — no money is moved by the portal";
export const REFUND_CONFIRMATION_PHRASE = "REFUND ORDER" as const;

export interface OrderPaymentRefundItemView {
  refundPublicId: string;
  paymentPublicId: string;
  provider: OrderPaymentProviderKind;
  executionKind: RefundExecutionKind;
  executionLabel: RefundExecutionLabel;
  status: PaymentRefundStatus;
  amountMinor: number;
  currency: string;
  reasonCode: string;
  reason: string | null;
  providerRefundRef: string | null;
  sendCustomerNotice: boolean;
  customerNoticeSentAt: string | null;
  failureReasonCode: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface OrderRefundablePaymentView {
  paymentPublicId: string;
  invoicePublicId: string;
  invoiceNumber: string;
  invoiceStatus: "draft" | "issued" | "paid" | "void";
  invoicePaymentState: InvoicePaymentState;
  provider: OrderPaymentProviderKind;
  executionKind: RefundExecutionKind;
  executionLabel: RefundExecutionLabel;
  providerPaymentRef: string | null;
  capturedMinor: number;
  refundedMinor: number;
  reservedPendingOrUnknownMinor: number;
  refundableMinor: number;
  currency: string;
  paidAt: string;
  refunds: OrderPaymentRefundItemView[];
}

export interface OrderRefundWorkspaceView {
  orderPublicId: string;
  orderPaymentState: InvoicePaymentState | "none";
  confirmationPhrase: "REFUND ORDER";
  canIssueRefund: boolean;
  payments: OrderRefundablePaymentView[];
}

export interface CreateOrderRefundInput {
  orderPublicId: string;
  paymentPublicId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  reasonCode?: string | undefined;
  sendCustomerNotice: boolean;
  confirmationPhrase: string;
  idempotencyKey: string;
}

export interface CreateOrderRefundResultView {
  refundPublicId: string;
  executionKind: RefundExecutionKind;
  executionLabel: RefundExecutionLabel;
  status: PaymentRefundStatus;
  amountMinor: number;
  currency: string;
  provider: OrderPaymentProviderKind;
  providerRefundRef: string | null;
  failureReasonCode: string | null;
  invoicePaymentState: InvoicePaymentState;
  orderPaymentState: InvoicePaymentState | "none";
  replayed: boolean;
}

export type EnqueueRefundReconciliationFn = (
  refundPublicId: string,
  tx: Tx,
  options?: Pick<EnqueueOptions, "runAt" | "correlationId">,
) => Promise<{ jobId: string }>;

export interface PaymentsServiceOptions {
  stripeAdapter?: PaymentProviderAdapter;
  squareAdapter?: PaymentProviderAdapter;
  stripeRefundAdapter?: PaymentRefundAdapter<"stripe">;
  squareRefundAdapter?: PaymentRefundAdapter<"square">;
  enqueueRefundReconciliation?: EnqueueRefundReconciliationFn;
}

const DEFAULT_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;
const REFUND_RECONCILE_INITIAL_DELAY_MS = 2 * 60 * 1000;
export const CUSTOMER_CONFIRM_COOLDOWN_MS = 2_000;
export const MISSING_WEBHOOK_GRACE_MS = 2 * 60 * 1000;
export const CANCEL_ATTEMPT_PROVIDER_JOB_TYPE = "payments.attempt.cancel_provider";
export const STRIPE_WEBHOOK_USUAL_CAUSES: readonly [string, string, string] = [
  "The webhook endpoint URL is not registered in the Stripe Dashboard for this environment (Test mode and Live mode maintain separate webhook endpoint lists).",
  "One or more required events (such as checkout.session.completed or checkout.session.async_payment_succeeded) are not subscribed on the Stripe endpoint.",
  "The signing secret saved here belongs to a different Stripe endpoint or CLI session (the built-in self-test signs locally with the saved secret, so it verifies server route health rather than Stripe's Dashboard configuration).",
];
const CARD_PAN_LIKE_PATTERN = /\b(?:\d[ -]*?){13,19}\b/u;

function formatRefundNoticeAmount(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const decimals = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions()
      .maximumFractionDigits ?? 2;
    const major = amountMinor / 10 ** decimals;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "code",
    }).format(major);
  } catch {
    return `${code} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function executionMetaForProvider(provider: OrderPaymentProviderKind): {
  executionKind: RefundExecutionKind;
  executionLabel: RefundExecutionLabel;
} {
  if (provider === "stripe") {
    return { executionKind: "provider_refund", executionLabel: "Stripe refund" };
  }
  if (provider === "square") {
    return { executionKind: "provider_refund", executionLabel: "Square refund" };
  }
  return {
    executionKind: "recorded_only",
    executionLabel: "recorded only — no money is moved by the portal",
  };
}

function toAdminAttemptSummary(row: PaymentAttemptRow): AdminPaymentAttemptSummary {
  return {
    publicId: row.publicId,
    attemptPublicId: row.publicId,
    invoicePublicId: row.invoicePublicId,
    orderPublicId: row.orderPublicId,
    cartPublicId: row.cartPublicId,
    provider: row.provider,
    environment: row.environment,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    providerRef: row.providerRef,
    providerOrderRef: row.providerOrderRef,
    providerPaymentRef: row.providerPaymentRef,
    verifiedWebhookEventId: row.verifiedWebhookEventId,
    bookingSource: row.bookingSource,
    compliancePaymentPublicId: row.compliancePaymentPublicId,
    reconciliationNote: row.reconciliationNote,
    failureReasonCode: row.failureReasonCode,
    redirectedAt: row.redirectedAt,
    expiresAt: row.expiresAt,
    paidAt: row.paidAt,
    cancelledAt: row.cancelledAt,
    lastReconciledAt: row.lastReconciledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAdminWebhookSummary(row: PaymentWebhookEventRow): AdminPaymentWebhookSummary {
  return {
    publicId: row.publicId,
    webhookPublicId: row.publicId,
    provider: row.provider,
    environment: row.environment,
    externalEventId: row.externalEventId,
    eventType: row.eventType,
    attemptPublicId: row.attemptPublicId,
    providerRef: row.providerRef,
    providerOrderRef: row.providerOrderRef,
    providerPaymentRef: row.providerPaymentRef,
    providerRefundRef: row.providerRefundRef,
    status: row.status,
    reasonCode: row.reasonCode,
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
  };
}

function labelWebhookRejectionReason(reasonCode: string): string {
  switch (reasonCode) {
    case "INVALID_SIGNATURE":
    case "SQUARE_SIGNATURE_INVALID":
    case "WEBHOOK_SIGNATURE_INVALID":
      return "Invalid signature";
    case "MISSING_SIGNATURE":
    case "MALFORMED_SIGNATURE":
    case "WEBHOOK_SIGNATURE_MISSING":
      return "Missing signature";
    case "TIMESTAMP_OUT_OF_RANGE":
    case "SQUARE_EVENT_STALE":
    case "WEBHOOK_TIMESTAMP_EXPIRED":
      return "Stale timestamp";
    case "INVALID_JSON":
    case "INVALID_EVENT_PAYLOAD":
    case "INVALID_EVENT_ENVELOPE":
    case "SQUARE_EVENT_INVALID":
    case "WEBHOOK_PAYLOAD_INVALID":
      return "Malformed JSON";
    case "WEBHOOK_MODE_MISMATCH":
      return "Environment mismatch";
    case "WEBHOOK_NOT_CONFIGURED":
    case "WEBHOOK_SECRET_MISSING":
    case "WEBHOOK_PROVIDER_OFF":
      return "Provider not configured";
    case "PAYLOAD_TAMPER_CONFLICT":
      return "Conflicting duplicate payload";
    case "WEBHOOK_EMPTY_BODY":
      return "Empty request body";
    default:
      return "Rejected delivery";
  }
}

function expandWebhookRejectionReasonFilter(reasonCode: string): string[] {
  switch (reasonCode) {
    case "INVALID_SIGNATURE":
    case "WEBHOOK_SIGNATURE_INVALID":
      return ["INVALID_SIGNATURE", "SQUARE_SIGNATURE_INVALID", "WEBHOOK_SIGNATURE_INVALID"];
    case "MISSING_SIGNATURE":
    case "WEBHOOK_SIGNATURE_MISSING":
      return ["MISSING_SIGNATURE", "MALFORMED_SIGNATURE", "WEBHOOK_SIGNATURE_MISSING"];
    case "TIMESTAMP_OUT_OF_RANGE":
    case "WEBHOOK_TIMESTAMP_EXPIRED":
      return ["TIMESTAMP_OUT_OF_RANGE", "SQUARE_EVENT_STALE", "WEBHOOK_TIMESTAMP_EXPIRED"];
    case "INVALID_JSON":
    case "WEBHOOK_PAYLOAD_INVALID":
      return [
        "INVALID_JSON",
        "INVALID_EVENT_PAYLOAD",
        "INVALID_EVENT_ENVELOPE",
        "SQUARE_EVENT_INVALID",
        "WEBHOOK_PAYLOAD_INVALID",
      ];
    case "WEBHOOK_NOT_CONFIGURED":
    case "WEBHOOK_SECRET_MISSING":
    case "WEBHOOK_PROVIDER_OFF":
      return ["WEBHOOK_NOT_CONFIGURED", "WEBHOOK_SECRET_MISSING", "WEBHOOK_PROVIDER_OFF"];
    default:
      return [reasonCode];
  }
}

function describeWebhookRejection(row: PaymentWebhookRejectionRow): string {
  switch (row.reasonCode) {
    case "INVALID_SIGNATURE":
    case "SQUARE_SIGNATURE_INVALID":
    case "WEBHOOK_SIGNATURE_INVALID":
      return "HMAC signature did not match the configured signing secret(s).";
    case "MISSING_SIGNATURE":
    case "WEBHOOK_SIGNATURE_MISSING":
      return row.provider === "stripe"
        ? "Stripe-Signature header was missing."
        : "Webhook signature header was missing.";
    case "MALFORMED_SIGNATURE":
      return row.provider === "stripe"
        ? "Stripe-Signature header was malformed."
        : "Webhook signature header was malformed.";
    case "TIMESTAMP_OUT_OF_RANGE":
    case "SQUARE_EVENT_STALE":
    case "WEBHOOK_TIMESTAMP_EXPIRED":
      return row.skewSeconds !== null
        ? `Timestamp outside the allowed freshness window (skew ${row.skewSeconds}s).`
        : "Timestamp outside the allowed freshness window.";
    case "WEBHOOK_MODE_MISMATCH":
      return `Event livemode (${row.environmentHint}) did not match configured portal mode.`;
    case "WEBHOOK_NOT_CONFIGURED":
    case "WEBHOOK_SECRET_MISSING":
    case "WEBHOOK_PROVIDER_OFF":
      return "Provider signing credentials were not configured when this delivery arrived.";
    case "INVALID_JSON":
    case "WEBHOOK_PAYLOAD_INVALID":
      return "Request body was not valid JSON.";
    case "INVALID_EVENT_PAYLOAD":
    case "INVALID_EVENT_ENVELOPE":
    case "SQUARE_EVENT_INVALID":
      return "JSON payload missed required webhook event envelope fields.";
    case "PAYLOAD_TAMPER_CONFLICT":
      return "Duplicate event ID arrived with a different payload digest.";
    case "WEBHOOK_EMPTY_BODY":
      return "Webhook request body was empty.";
    default:
      return row.skewSeconds !== null
        ? `Rejected before verification (skew ${row.skewSeconds}s).`
        : "Rejected before webhook signature and envelope verification.";
  }
}

function toWebhookRejectionSummary(row: PaymentWebhookRejectionRow): PaymentWebhookRejectionSummary {
  return {
    publicId: row.publicId,
    rejectionPublicId: row.publicId,
    provider: row.provider,
    environmentHint: row.environmentHint,
    reasonCode: row.reasonCode,
    reasonLabel: labelWebhookRejectionReason(row.reasonCode),
    httpStatus: row.httpStatus,
    skewSeconds: row.skewSeconds,
    detail: describeWebhookRejection(row),
    receivedAt: row.receivedAt,
  };
}

const WEBHOOK_REJECTION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function isMysqlDeadlockError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === "object"; depth += 1) {
    const rec = cur as { code?: unknown; errno?: unknown; sqlState?: unknown; cause?: unknown };
    if (
      rec.code === "ER_LOCK_DEADLOCK" ||
      rec.errno === 1213 ||
      rec.sqlState === "40001"
    ) {
      return true;
    }
    cur = rec.cause;
  }
  return false;
}

async function runWithMysqlDeadlockRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isMysqlDeadlockError(err)) {
        throw err;
      }
      const backoffMs = 5 * attempt + Math.floor(Math.random() * 10);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, backoffMs);
      });
    }
  }
}

function sanitizeOpsAlertCode(raw: string, fallback = "PAYMENT_VERIFICATION_FAILED"): string {
  const upper = raw.trim().toUpperCase().replace(/[^A-Z0-9_]/gu, "_").slice(0, 64);
  return /^[A-Z][A-Z0-9_]{1,63}$/u.test(upper) ? upper : fallback;
}

export function createPaymentsService(deps: ModuleDeps, options?: PaymentsServiceOptions) {
  const adapters: Record<ActivePaymentProvider, PaymentProviderAdapter> = {
    stripe: options?.stripeAdapter ?? createStripeProviderAdapter(deps),
    square: options?.squareAdapter ?? createSquareProviderAdapter(deps),
  };

  const refundAdapters: Record<ActivePaymentProvider, PaymentRefundAdapter> = {
    stripe: options?.stripeRefundAdapter ?? createStripeRefundAdapter(deps),
    square:
      options?.squareRefundAdapter ??
      createSquareRefundAdapter({
        egress: {
          fetchPinned: (url, purpose, fetchOpts) =>
            deps.services.integrations.egress.fetchPinned(url, purpose, fetchOpts),
        },
        clock: deps.clock,
      }),
  };

  const enqueueRefundReconciliation: EnqueueRefundReconciliationFn =
    options?.enqueueRefundReconciliation ??
    ((refundPublicId, tx, enqueueOpts = {}) =>
      deps.jobs.enqueue(
        REFUND_RECONCILE_JOB,
        { refundPublicId },
        {
          runAt: enqueueOpts.runAt,
          correlationId: enqueueOpts.correlationId,
          idempotencyKey: `refund-reconcile:${refundPublicId}`,
          maxAttempts: 8,
        },
        tx,
      ));

  function requireComplianceService() {
    const complianceSvc = (deps.services as Partial<typeof deps.services>).compliance;
    if (!complianceSvc) {
      throw new DomainError("UNAVAILABLE", "COMPLIANCE_UNAVAILABLE", "Invoice service is temporarily unavailable.");
    }
    return complianceSvc;
  }

  function requireOrdersService() {
    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if (!ordersSvc) {
      throw new DomainError("UNAVAILABLE", "ORDERS_UNAVAILABLE", "Order service is temporarily unavailable.");
    }
    return ordersSvc;
  }

  async function assertAdminPaymentsRead(principal: SessionPrincipal): Promise<void> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      await deps.audit.record({
        category: "security",
        eventName: "authz.payments.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "REMEDIATION_SESSION",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "payments_settings" },
      });
      throw forbidden("REMEDIATION_SESSION");
    }
    if (!roleHasCapability(principal.role, "payments.manage")) {
      await deps.audit.record({
        category: "security",
        eventName: "authz.payments.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "CAPABILITY_NOT_GRANTED",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "payments_settings" },
      });
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
  }

  async function loadConfig(tx?: Tx): Promise<PaymentsConfigValue> {
    return readSetting(deps.settings, PAYMENTS_CONFIG_SETTING, tx);
  }

  async function loadSmallTotals(tx?: Tx): Promise<PaymentsSmallTotalsValue> {
    try {
      const raw = await deps.settings.get(
        PAYMENTS_SMALL_TOTALS_SETTING.key,
        parsePaymentsSmallTotals,
        DEFAULT_PAYMENTS_SMALL_TOTALS,
        tx,
      );
      return parsePaymentsSmallTotals(raw);
    } catch {
      return { ...DEFAULT_PAYMENTS_SMALL_TOTALS };
    }
  }

  async function loadReceiptsSetting(tx?: Tx): Promise<PaymentsReceiptsValue> {
    try {
      const raw = await deps.settings.get(
        PAYMENTS_RECEIPTS_SETTING.key,
        parsePaymentsReceiptsSetting,
        DEFAULT_PAYMENTS_RECEIPTS,
        tx,
      );
      return parsePaymentsReceiptsSetting(raw);
    } catch {
      return { ...DEFAULT_PAYMENTS_RECEIPTS };
    }
  }

  async function loadDiagnostics(tx?: Tx): Promise<PaymentsDiagnosticsValue> {
    try {
      const raw = await deps.settings.get(
        PAYMENTS_DIAGNOSTICS_SETTING.key,
        parsePaymentsDiagnosticsSetting,
        DEFAULT_PAYMENTS_DIAGNOSTICS,
        tx,
      );
      return parsePaymentsDiagnosticsSetting(raw);
    } catch {
      return { ...DEFAULT_PAYMENTS_DIAGNOSTICS };
    }
  }

  async function updateDiagnosticsBestEffort(
    mutator: (prev: PaymentsDiagnosticsValue) => PaymentsDiagnosticsValue,
    tx?: Tx,
  ): Promise<void> {
    try {
      const prev = await loadDiagnostics(tx);
      const next = mutator(prev);
      await writeSetting(deps.settings, PAYMENTS_DIAGNOSTICS_SETTING, next, tx);
    } catch {
      // Best-effort non-secret telemetry; never fail core ledger/audit persistence in minimal test harnesses.
    }
  }

  async function evaluateCheckoutAmount(
    amountMinor: number,
    currency: string,
    tx?: DbOrTx,
  ): Promise<CheckoutAmountEvaluation> {
    const config = await loadConfig(tx as Tx | undefined);
    const onlineEnabled = await isProviderCredentialsReady(config, tx as Tx | undefined);
    if (amountMinor <= 0) {
      return {
        onlineEnabled,
        provider: onlineEnabled ? config.provider : "none",
        minimumMinor: 0,
        belowMinimum: false,
        smallTotalAction: "zero_total",
      };
    }
    if (!onlineEnabled || config.provider === "none") {
      return {
        onlineEnabled: false,
        provider: "none",
        minimumMinor: 0,
        belowMinimum: false,
        smallTotalAction: "none",
      };
    }
    const smallTotals = await loadSmallTotals(tx as Tx | undefined);
    const minimumMinor = resolveProviderMinimumMinor(config.provider, currency, smallTotals);
    const belowMinimum = amountMinor > 0 && amountMinor < minimumMinor;
    return {
      onlineEnabled: true,
      provider: config.provider,
      minimumMinor,
      belowMinimum,
      smallTotalAction: belowMinimum ? smallTotals.belowProviderMinimum : "none",
    };
  }

  function computeStripeApiFingerprint(
    mode: PaymentEnvironmentMode,
    stripeSecretKey: string,
    stripeEgressStamp: string,
  ): string {
    return createHash("sha256")
      .update(`stripe-api-v1|${mode}|${stripeSecretKey}|${stripeEgressStamp}`)
      .digest("hex");
  }

  function computeStripeSelfTestFingerprint(
    mode: PaymentEnvironmentMode,
    stripeWebhookSecret: string,
  ): string {
    return createHash("sha256")
      .update(`stripe-wh-v1|${mode}|${stripeWebhookSecret}`)
      .digest("hex");
  }

  async function checkEgressPresets(mode: PaymentEnvironmentMode): Promise<{
    wired: boolean;
    stripeAllowlisted: boolean;
    squareAllowlisted: boolean;
    stripeEgressStamp: string;
  }> {
    const egressSvc = (deps.services as Partial<typeof deps.services>).integrations?.egress as
      | {
          isPresetEnabled?: (key: string) => Promise<boolean>;
          listPresets?: () => Promise<Array<{ key: string; enabled: boolean }>>;
          listAllowlist?: () => Promise<
            Array<{
              publicId: string;
              purpose: string;
              pattern: string;
              enabled: boolean;
              version: number;
            }>
          >;
        }
      | undefined;
    if (
      !egressSvc ||
      (typeof egressSvc.isPresetEnabled !== "function" && typeof egressSvc.listPresets !== "function")
    ) {
      return { wired: false, stripeAllowlisted: false, squareAllowlisted: false, stripeEgressStamp: "unwired" };
    }
    try {
      const sqPresetKey = mode === "live" ? "square" : "square_sandbox";
      const allowlistPromise =
        typeof egressSvc.listAllowlist === "function" ? egressSvc.listAllowlist() : Promise.resolve(null);
      let stripeAllowlisted = false;
      let squareAllowlisted = false;
      if (typeof egressSvc.isPresetEnabled === "function") {
        [stripeAllowlisted, squareAllowlisted] = await Promise.all([
          egressSvc.isPresetEnabled("stripe"),
          egressSvc.isPresetEnabled(sqPresetKey),
        ]);
      } else {
        const presets = await egressSvc.listPresets!();
        stripeAllowlisted = presets.some((p) => p.key === "stripe" && p.enabled);
        squareAllowlisted = presets.some((p) => p.key === sqPresetKey && p.enabled);
      }
      const rules = await allowlistPromise;
      const stripeRules = rules
        ? rules
            .filter((r) => r.purpose === "stripe")
            .map((r) => `${r.publicId}:${r.version}:${r.enabled ? 1 : 0}`)
            .sort()
        : null;
      const stripeEgressStamp = stripeRules
        ? stripeRules.length > 0
          ? stripeRules.join(",")
          : "none"
        : stripeAllowlisted
          ? "preset:1"
          : "preset:0";
      return { wired: true, stripeAllowlisted, squareAllowlisted, stripeEgressStamp };
    } catch {
      return { wired: true, stripeAllowlisted: false, squareAllowlisted: false, stripeEgressStamp: "error" };
    }
  }

  async function isOrderTrashedInTx(tx: DbOrTx, orderId: number): Promise<boolean> {
    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if (!ordersSvc || typeof ordersSvc.isTrashedInTx !== "function") {
      return false;
    }
    return ordersSvc.isTrashedInTx(tx, orderId);
  }

  async function notifyOrderPaymentEventInTx(
    tx: Tx,
    input: {
      orderPublicId: string;
      orderId?: number | undefined;
      kind: "pending_async" | "failed";
      eventRef: string;
    },
  ): Promise<void> {
    if (input.orderId !== undefined && (await isOrderTrashedInTx(tx, input.orderId))) {
      return;
    }
    const ordersPayments = (deps.services as Partial<typeof deps.services>).orders?.payments;
    if (ordersPayments && typeof ordersPayments.onPaymentEventInTx === "function") {
      await ordersPayments.onPaymentEventInTx(
        {
          orderPublicId: input.orderPublicId,
          kind: input.kind,
          eventRef: input.eventRef,
        },
        tx,
      );
    }
  }

  async function emitPaymentOpsAlert(
    input: {
      dedupKey: string;
      severity: "warning" | "error" | "critical";
      code: string;
      title: string;
      text?: string;
      orderPublicId?: string;
    },
    tx?: Tx,
  ): Promise<void> {
    const opsAlerts = (deps.services as Partial<typeof deps.services>).opsAlerts;
    if (!opsAlerts || typeof opsAlerts.emit !== "function") return;
    try {
      const ctx = getRequestContext();
      const correlationId = ctx?.correlationId ?? ctx?.requestId;
      await opsAlerts.emit(
        {
          source: "payment",
          dedupKey: input.dedupKey.slice(0, 200),
          severity: input.severity,
          code: sanitizeOpsAlertCode(input.code),
          title: input.title.slice(0, 120),
          ...(input.text ? { text: input.text.slice(0, 500) } : {}),
          ...(input.orderPublicId && ULID_PATTERN.test(input.orderPublicId)
            ? { orderPublicId: input.orderPublicId }
            : {}),
          ...(correlationId ? { correlationId } : {}),
        },
        tx,
      );
    } catch {
      // Never allow operational alert persistence failure to abort webhook or ledger work.
    }
  }

  async function resolvePaymentOpsAlert(dedupKey: string, tx?: Tx): Promise<void> {
    const opsAlerts = (deps.services as Partial<typeof deps.services>).opsAlerts;
    if (!opsAlerts || typeof opsAlerts.resolve !== "function") return;
    try {
      await opsAlerts.resolve({ source: "payment", dedupKey: dedupKey.slice(0, 200) }, tx);
    } catch {
      // Non-fatal.
    }
  }

  async function recordWebhookRejection(input: {
    provider: ActivePaymentProvider;
    environmentHint: PaymentWebhookEnvHint;
    reasonCode: string;
    httpStatus: number;
    skewSeconds?: number | null;
    receivedAt?: Date;
  }): Promise<void> {
    const receivedAt = input.receivedAt ?? deps.clock.now();
    try {
      await deps.db.insert(paymentWebhookRejections).values({
        publicId: ulid(receivedAt.getTime()),
        provider: input.provider,
        environmentHint: input.environmentHint,
        reasonCode: input.reasonCode.slice(0, 64),
        httpStatus: input.httpStatus,
        skewSeconds:
          typeof input.skewSeconds === "number" && Number.isFinite(input.skewSeconds)
            ? Math.trunc(input.skewSeconds)
            : null,
        receivedAt,
      });
    } catch {
      // Never allow diagnostic rejection telemetry to mask the webhook HTTP response.
    }
  }

  async function recordHttpRejection(input: {
    provider: ActivePaymentProvider;
    reasonCode: string;
    httpStatus: number;
  }): Promise<void> {
    await recordWebhookRejection({
      provider: input.provider,
      environmentHint: "unknown",
      reasonCode: input.reasonCode,
      httpStatus: input.httpStatus,
    });
  }

  async function pruneExpiredWebhookRejections(now: Date): Promise<void> {
    try {
      const cutoff = new Date(now.getTime() - WEBHOOK_REJECTION_RETENTION_MS);
      await deps.db
        .delete(paymentWebhookRejections)
        .where(lt(paymentWebhookRejections.receivedAt, cutoff));
    } catch {
      // Best-effort diagnostic table pruning.
    }
  }

  function resolveStripeVerificationState(
    config: PaymentsConfigValue,
    stripeKey: string | null,
    stripeWh: string | null,
    egress: { wired: boolean; stripeAllowlisted: boolean; stripeEgressStamp: string },
  ): {
    egressOk: boolean;
    secretKeyModeMatches: boolean;
    expectedApiFp: string | null;
    apiVerified: boolean;
    selfTestVerified: boolean;
    effectiveLastApiVerifiedAt: string | null;
    effectiveLastSelfTestAt: string | null;
    ready: boolean;
  } {
    const egressOk = !egress.wired || egress.stripeAllowlisted;
    const expectedPrefix = config.mode === "live" ? /^(?:sk|rk)_live_/u : /^(?:sk|rk)_test_/u;
    const secretKeyModeMatches = Boolean(stripeKey && expectedPrefix.test(stripeKey));
    const expectedApiFp =
      stripeKey && secretKeyModeMatches
        ? computeStripeApiFingerprint(config.mode, stripeKey, egress.stripeEgressStamp)
        : null;
    const apiVerified = Boolean(
      expectedApiFp &&
        egressOk &&
        config.stripeLastApiVerifiedAt &&
        config.stripeApiVerifiedFingerprint === expectedApiFp,
    );
    const selfTestVerified = Boolean(
      stripeWh &&
        config.stripeLastSelfTestAt &&
        config.stripeSelfTestedFingerprint === computeStripeSelfTestFingerprint(config.mode, stripeWh),
    );
    const ready = Boolean(
      stripeKey && secretKeyModeMatches && stripeWh && egressOk && apiVerified && selfTestVerified,
    );
    return {
      egressOk,
      secretKeyModeMatches,
      expectedApiFp,
      apiVerified,
      selfTestVerified,
      effectiveLastApiVerifiedAt: apiVerified ? config.stripeLastApiVerifiedAt : null,
      effectiveLastSelfTestAt: selfTestVerified ? config.stripeLastSelfTestAt : null,
      ready,
    };
  }

  function computeStripeGateSummary(input: {
    config: PaymentsConfigValue;
    stripeKeySet: boolean;
    stripeWhSet: boolean;
    stripeState: ReturnType<typeof resolveStripeVerificationState>;
    diagnostics: PaymentsDiagnosticsValue;
  }): {
    statusHeadline: string;
    customerExperienceSummary: string;
    missingGates: StripeMissingGateKey[];
    reverificationNeeded: boolean;
    reverificationReasons: string[];
  } {
    const { config, stripeKeySet, stripeWhSet, stripeState, diagnostics } = input;
    const missingGates: StripeMissingGateKey[] = [];
    if (!stripeKeySet) {
      missingGates.push("secret_key");
    } else if (!stripeState.secretKeyModeMatches) {
      missingGates.push("secret_key_mode");
    }
    if (!stripeWhSet) {
      missingGates.push("webhook_secret");
    }
    if (!stripeState.egressOk) {
      missingGates.push("egress_allowlist");
    }
    if (!stripeState.apiVerified) {
      missingGates.push("api_verified");
    }
    if (!stripeState.selfTestVerified) {
      missingGates.push("webhook_self_test");
    }
    if (config.provider !== "stripe") {
      missingGates.push("provider_activated");
    }

    const reverificationReasons: string[] = [];
    const hadPriorSetup =
      config.provider === "stripe" ||
      diagnostics.stripeEverApiVerified ||
      diagnostics.stripeEverSelfTested;

    if (hadPriorSetup) {
      if (!stripeState.egressOk) {
        reverificationReasons.push(
          "Stripe outbound HTTPS allowlist preset was disabled or changed after setup — re-enable api.stripe.com:443 and run Test Stripe API.",
        );
      } else if (stripeKeySet && !stripeState.secretKeyModeMatches) {
        reverificationReasons.push(
          `Saved Stripe API secret key does not match ${config.mode} mode — stage a matching key and run Test Stripe API.`,
        );
      } else if (
        stripeKeySet &&
        !stripeState.apiVerified &&
        (config.provider === "stripe" || diagnostics.stripeEverApiVerified)
      ) {
        reverificationReasons.push(
          config.provider === "stripe"
            ? "Stripe API secret key or outbound allowlist changed after verification — run Test Stripe API to resume checkout (and Verify Checkout session creation as a recommended permission check)."
            : "Stripe API secret key or outbound allowlist changed after verification — run Test Stripe API and Verify Checkout session creation again before activating Stripe Checkout.",
        );
      }
      if (
        stripeWhSet &&
        !stripeState.selfTestVerified &&
        (config.provider === "stripe" || diagnostics.stripeEverSelfTested)
      ) {
        reverificationReasons.push(
          "Primary Stripe webhook signing secret changed after verification — run Send self-test webhook again, then confirm real Stripe delivery from Stripe Workbench.",
        );
      }
    }

    const reverificationNeeded =
      (config.provider === "stripe" && !stripeState.ready) || reverificationReasons.length > 0;

    let statusHeadline: string;
    let customerExperienceSummary: string;
    if (config.provider === "stripe" && stripeState.ready) {
      statusHeadline = `Online card checkout: ACTIVE (${config.mode})`;
      customerExperienceSummary = `Customers are sent to Stripe Checkout (${config.mode}) when placing an order or clicking Pay now.`;
    } else if (config.provider === "stripe") {
      statusHeadline = `Online card checkout: NOT ACTIVE (paused pending verification)`;
      customerExperienceSummary =
        "Stripe is selected, but one or more verification gates below are incomplete or stale. New customer orders still place and issue an invoice, but card payment cannot open until re-verified.";
    } else if (config.provider === "square") {
      statusHeadline = `Online card checkout: Square (${config.mode}) selected`;
      customerExperienceSummary =
        "Square Payment Links is selected as the active provider. Stripe Checkout is not active.";
    } else {
      statusHeadline = "Online card checkout: NOT ACTIVE (Pay by invoice)";
      customerExperienceSummary =
        "Customers get pay-by-invoice; no card payment is collected online until you complete the Stripe checklist and activate Stripe Checkout.";
    }

    return {
      statusHeadline,
      customerExperienceSummary,
      missingGates,
      reverificationNeeded,
      reverificationReasons,
    };
  }

  async function isProviderCredentialsReady(
    config: PaymentsConfigValue,
    tx?: Tx,
  ): Promise<boolean> {
    if (config.provider === "none") return false;
    const egress = tx
      ? { wired: false, stripeAllowlisted: true, squareAllowlisted: true, stripeEgressStamp: "unwired" }
      : await checkEgressPresets(config.mode);
    if (config.provider === "stripe") {
      const [stripeKey, stripeWh, diagnostics] = await Promise.all([
        readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
        readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx),
        loadDiagnostics(tx),
      ]);
      const state = resolveStripeVerificationState(config, stripeKey, stripeWh, egress);
      const probe = diagnostics.lastStripeCheckoutProbe;
      const probeFailed = Boolean(
        probe &&
          state.expectedApiFp &&
          probe.apiFingerprint === state.expectedApiFp &&
          probe.mode === config.mode &&
          !probe.ok,
      );
      if (probeFailed) return false;
      if (
        !egress.wired &&
        config.stripeApiVerifiedFingerprint === null &&
        config.stripeSelfTestedFingerprint === null &&
        !diagnostics.stripeEverApiVerified &&
        !diagnostics.stripeEverSelfTested
      ) {
        // Legacy pre-Increment-07 raw settings seeded in isolated unit harnesses without wired egress.
        return Boolean(stripeKey && state.secretKeyModeMatches && stripeWh);
      }
      return state.ready;
    }
    const [hasToken, hasSig] = await Promise.all([
      isSecretConfigured(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx),
      isSecretConfigured(deps.settings, PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY, tx),
    ]);
    const egressOk = !egress.wired || egress.squareAllowlisted;
    return Boolean(config.squareLocationId && hasToken && hasSig && egressOk);
  }

  async function isOnlineCheckoutEnabled(tx?: DbOrTx): Promise<boolean> {
    const config = await loadConfig(tx as Tx | undefined);
    return isProviderCredentialsReady(config, tx as Tx | undefined);
  }

  async function getPublicCheckoutConfig(tx?: DbOrTx): Promise<PaymentsPublicConfigView> {
    const config = await loadConfig(tx as Tx | undefined);
    const onlineEnabled = await isProviderCredentialsReady(config, tx as Tx | undefined);
    return {
      provider: onlineEnabled ? config.provider : "none",
      mode: config.mode,
      currency: config.currency,
      onlineEnabled,
    };
  }

  async function loadProviderCredentials(
    provider: ActivePaymentProvider,
    config: PaymentsConfigValue,
    tx?: Tx,
  ): Promise<{ credentials: ProviderCredentials; webhookSecret: string }> {
    if (provider === "stripe") {
      const [secretKey, webhookSecret] = await Promise.all([
        readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
        readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx),
      ]);
      if (!secretKey || !webhookSecret) {
        throw new DomainError(
          "UNAVAILABLE",
          "PAYMENT_PROVIDER_NOT_CONFIGURED",
          "Stripe credentials are not configured.",
        );
      }
      return {
        credentials: { mode: config.mode, secretKey },
        webhookSecret,
      };
    }

    const [accessToken, webhookSignatureKey] = await Promise.all([
      readSecret(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx),
      readSecret(deps.settings, PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY, tx),
    ]);
    if (!accessToken || !webhookSignatureKey || !config.squareLocationId) {
      throw new DomainError(
        "UNAVAILABLE",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        "Square credentials or location ID are not configured.",
      );
    }
    return {
      credentials: {
        mode: config.mode,
        secretKey: accessToken,
        squareLocationId: config.squareLocationId,
      },
      webhookSecret: webhookSignatureKey,
    };
  }

  /**
   * Loads Stripe API credentials for authoritative server-to-Stripe lookup (`fetchPayment`) in the
   * attempt's environment, enforcing active provider & mode alignment and computing a key digest so
   * post-egress transactions can detect key rotation, provider disable, or mode changes in flight.
   */
  async function loadStripeLookupCredentials(
    environment: PaymentEnvironmentMode,
    opts?: {
      tx?: Tx | undefined;
      allowDisabledProvider?: boolean | undefined;
    },
  ): Promise<{ credentials: ProviderCredentials; keyDigest: string }> {
    const tx = opts?.tx;
    const [config, secretKey] = await Promise.all([
      loadConfig(tx),
      readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
    ]);
    if (!opts?.allowDisabledProvider && config.provider !== "stripe") {
      throw new DomainError(
        "UNAVAILABLE",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        "Stripe is not the active payment provider.",
      );
    }
    if (config.mode !== environment) {
      throw conflict(
        "STRIPE_KEY_MODE_MISMATCH",
        `Payment attempt was created in ${environment} mode while payments are currently configured in ${config.mode} mode.`,
      );
    }
    if (!secretKey) {
      throw new DomainError(
        "UNAVAILABLE",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        "Stripe API secret key is not configured.",
      );
    }
    const expectedPrefix = environment === "live" ? /^(?:sk|rk)_live_/u : /^(?:sk|rk)_test_/u;
    if (!expectedPrefix.test(secretKey)) {
      throw conflict(
        "STRIPE_KEY_MODE_MISMATCH",
        `Payment attempt was created in ${environment} mode, while the saved Stripe API key is for ${environment === "live" ? "test" : "live"} mode.`,
      );
    }
    const keyDigest = createHash("sha256")
      .update(`${config.provider}:${config.mode}:${secretKey}`)
      .digest("hex");
    return {
      credentials: { mode: environment, secretKey },
      keyDigest,
    };
  }

  function buildCanonicalReturnUrls(
    provider: ActivePaymentProvider,
    attemptPublicId: string,
    successPath: string,
  ): { returnUrl: string; cancelUrl: string } {
    const flow = successPath.startsWith("/checkout") ? "checkout" : "invoices";
    const base = new URL(
      `/api/payments/return/${provider}/${attemptPublicId}`,
      deps.config.canonicalOrigin,
    );
    const returnUrl = new URL(base.href);
    returnUrl.searchParams.set("flow", flow);

    const cancelUrl = new URL(base.href);
    cancelUrl.searchParams.set("flow", flow);
    cancelUrl.searchParams.set("outcome", "cancelled");

    return {
      returnUrl: returnUrl.href,
      cancelUrl: cancelUrl.href,
    };
  }

  async function startCheckout(
    invoicePublicId: string,
    returnPaths?: CheckoutReturnPaths,
    opts?: StartCheckoutOptions,
  ): Promise<StartCheckoutResult> {
    const complianceSvc = requireComplianceService();
    const config = await loadConfig();

    const invoice = await complianceSvc.getInvoiceForCheckout(invoicePublicId, {
      ...(opts?.principal ? { principal: opts.principal } : {}),
    });

    if (opts?.principal && opts.principal.role === "customer" && invoice.ownerUserId !== opts.principal.userId) {
      throw notFound("INVOICE_NOT_FOUND");
    }
    if (await isOrderTrashedInTx(deps.db, invoice.orderId)) {
      throw notFound("INVOICE_NOT_FOUND");
    }
    const preOrdersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if (
      opts?.principal &&
      opts.principal.role === "customer" &&
      preOrdersSvc &&
      typeof preOrdersSvc.getOrderRefById === "function"
    ) {
      const preOrder = await preOrdersSvc.getOrderRefById(invoice.orderId);
      if (!preOrder || preOrder.ownerUserId !== opts.principal.userId) {
        throw notFound("INVOICE_NOT_FOUND");
      }
    }
    if (invoice.origin !== "portal") {
      throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported historical invoices cannot be paid online.");
    }
    if (invoice.voidedAt !== null || invoice.status === "void") {
      throw conflict("INVOICE_VOIDED", "Voided invoices cannot be paid.");
    }
    if (invoice.issuedAt === null || invoice.status === "draft") {
      throw conflict("INVOICE_NOT_ISSUED", "Draft invoices must be issued before starting checkout.");
    }

    // Increment 06 D5 + D15: Zero-total invoices settle directly and issue a `zero_total` receipt
    // without touching any external payment processor.
    if (invoice.totalMinor === 0) {
      const settledZero = await runWithMysqlDeadlockRetry(() =>
        deps.db.transaction(async (tx) => {
          // Canonical lock order: `orders -> compliance_invoices -> users(actor)` so concurrent
          // `confirmCheckoutPayment` / `cancelAttemptIfUnpaid` on the same customer/order cannot deadlock.
          const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
          if (await isOrderTrashedInTx(tx, invoice.orderId)) {
            throw notFound("INVOICE_NOT_FOUND");
          }
          let lockedOrderOwnerUserId: number | null = null;
          if (ordersSvc && typeof ordersSvc.getOrderRefById === "function") {
            const lockedOrder = await ordersSvc.getOrderRefById(invoice.orderId, tx, { forUpdate: true });
            if (!lockedOrder) throw notFound("INVOICE_NOT_FOUND");
            lockedOrderOwnerUserId = lockedOrder.ownerUserId;
            if (opts?.principal && opts.principal.role === "customer" && lockedOrder.ownerUserId !== opts.principal.userId) {
              throw notFound("INVOICE_NOT_FOUND");
            }
            if (lockedOrder.lockState === "legal_hold" || lockedOrder.lockState === "imported_read_only") {
              throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked against checkout.", {
                lockState: lockedOrder.lockState,
              });
            }
          }
          const lockedZeroInvoice = await complianceSvc.getInvoiceForCheckout(invoice.invoicePublicId, {
            ...(opts?.principal ? { principal: opts.principal } : {}),
            tx,
            forUpdate: true,
          });
          if (opts?.principal) {
            const liveActor = await assertLiveActorInTx(deps, opts.principal, tx);
            if (
              liveActor.role === "customer" &&
              (lockedZeroInvoice.ownerUserId !== liveActor.userId ||
                (lockedOrderOwnerUserId !== null && lockedOrderOwnerUserId !== liveActor.userId))
            ) {
              throw notFound("INVOICE_NOT_FOUND");
            }
          }
          if (typeof complianceSvc.settleCheckoutInvoiceInTx === "function") {
            return complianceSvc.settleCheckoutInvoiceInTx(
              { settlementKind: "zero_total", invoicePublicId: lockedZeroInvoice.invoicePublicId },
              tx,
            );
          }
          return { receiptPublicId: null };
        }),
      );
      return {
        mode: "settled",
        settlementKind: "zero_total",
        invoicePublicId: invoice.invoicePublicId,
        ...(settledZero.receiptPublicId ? { receiptPublicId: settledZero.receiptPublicId } : {}),
      };
    }

    if (invoice.status === "paid" || invoice.balanceDueMinor <= 0) {
      // Idempotent replay check: if this invoice was settled via `waived_small_total`, validate live principal
      // and order lock inside `tx` before replaying/ensuring the settled receipt.
      const [existingWaived] = await deps.db
        .select({
          id: complianceInvoicePayments.id,
          amountMinor: complianceInvoicePayments.amountMinor,
          waivedMinor: complianceInvoicePayments.waivedMinor,
        })
        .from(complianceInvoicePayments)
        .where(
          and(
            eq(complianceInvoicePayments.invoiceId, invoice.invoiceId),
            eq(complianceInvoicePayments.idempotencyKey, `waive:${invoice.invoicePublicId}`),
          ),
        )
        .limit(1);
      if (existingWaived) {
        const replaySettled = await runWithMysqlDeadlockRetry(() =>
          deps.db.transaction(async (tx) => {
            // Canonical lock order: `orders -> compliance_invoices -> users(actor)`.
            const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
            let lockedOrderOwnerUserId: number | null = null;
            if (ordersSvc && typeof ordersSvc.getOrderRefById === "function") {
              const lockedOrder = await ordersSvc.getOrderRefById(invoice.orderId, tx, { forUpdate: true });
              if (!lockedOrder) throw notFound("INVOICE_NOT_FOUND");
              lockedOrderOwnerUserId = lockedOrder.ownerUserId;
              if (opts?.principal && opts.principal.role === "customer" && lockedOrder.ownerUserId !== opts.principal.userId) {
                throw notFound("INVOICE_NOT_FOUND");
              }
              if (lockedOrder.lockState === "legal_hold" || lockedOrder.lockState === "imported_read_only") {
                throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked against checkout.", {
                  lockState: lockedOrder.lockState,
                });
              }
            }
            const lockedWaivedInvoice = await complianceSvc.getInvoiceForCheckout(invoice.invoicePublicId, {
              ...(opts?.principal ? { principal: opts.principal } : {}),
              tx,
              forUpdate: true,
            });
            if (opts?.principal) {
              const liveActor = await assertLiveActorInTx(deps, opts.principal, tx);
              if (
                liveActor.role === "customer" &&
                (lockedWaivedInvoice.ownerUserId !== liveActor.userId ||
                  (lockedOrderOwnerUserId !== null && lockedOrderOwnerUserId !== liveActor.userId))
              ) {
                throw notFound("INVOICE_NOT_FOUND");
              }
            }
            if (typeof complianceSvc.settleCheckoutInvoiceInTx === "function") {
              return complianceSvc.settleCheckoutInvoiceInTx(
                {
                  settlementKind: "waived_small_total",
                  invoicePublicId: lockedWaivedInvoice.invoicePublicId,
                  providerMinimumMinor: 0,
                },
                tx,
              );
            }
            return null;
          }),
        );
        return {
          mode: "settled",
          settlementKind: "waived_small_total",
          invoicePublicId: invoice.invoicePublicId,
          waivedMinor: replaySettled?.waivedMinor ?? (existingWaived.waivedMinor || existingWaived.amountMinor),
          ...(replaySettled?.receiptPublicId ? { receiptPublicId: replaySettled.receiptPublicId } : {}),
        };
      }
      throw conflict("INVOICE_ALREADY_PAID", "This invoice is already paid in full.");
    }

    if (config.provider === "none") {
      return {
        mode: "invoice",
        invoicePublicId: invoice.invoicePublicId,
      };
    }

    const activeProvider: ActivePaymentProvider = config.provider;

    if (invoice.currency.toUpperCase() !== config.currency.toUpperCase()) {
      throw validation(
        "CURRENCY_MISMATCH",
        `Invoice currency (${invoice.currency}) does not match configured payment currency (${config.currency}).`,
      );
    }

    const successPath = returnPaths?.successPath ?? config.successPath;
    const cancelPath = returnPaths?.cancelPath ?? config.cancelPath;
    if (!isSafePortalReturnPath(successPath) || !isSafePortalReturnPath(cancelPath)) {
      throw validation("INVALID_RETURN_PATH", "Checkout return path must be an allowlisted internal portal path.");
    }

    const providerReadyBeforeTx = await isProviderCredentialsReady(config);

    const now = deps.clock.now();
    const rawIdem = opts?.idempotencyKey?.trim();
    const idempotencyKey =
      rawIdem && rawIdem.length >= 4 && rawIdem.length <= 128
        ? rawIdem
        : `att:${invoice.invoicePublicId}:${activeProvider}:${config.mode}:${invoice.balanceDueMinor}`;

    const preAttempt = await runWithMysqlDeadlockRetry(() =>
      deps.db.transaction(async (tx) => {
        // Canonical lock order: `orders -> compliance_invoices -> users(actor) -> payment_attempts`
        // (matching `confirmCheckoutPayment` and `cancelAttemptIfUnpaid`), plus fence against starting
        // a provider checkout after order cancellation, ownership transfer, or concurrent invoice void/payment.
        const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
        if (await isOrderTrashedInTx(tx, invoice.orderId)) {
          throw notFound("INVOICE_NOT_FOUND");
        }
        let lockedOrderOwnerUserId: number | null = null;
        if (ordersSvc && typeof ordersSvc.getOrderRefById === "function") {
          const lockedOrder = await ordersSvc.getOrderRefById(invoice.orderId, tx, { forUpdate: true });
          if (!lockedOrder) {
            throw notFound("INVOICE_NOT_FOUND");
          }
          lockedOrderOwnerUserId = lockedOrder.ownerUserId;
          if (opts?.principal && opts.principal.role === "customer" && lockedOrder.ownerUserId !== opts.principal.userId) {
            throw notFound("INVOICE_NOT_FOUND");
          }
          let orderCancelled = /cancel/.test(lockedOrder.statusKey);
          if (ordersSvc.workflows && typeof ordersSvc.workflows.byVersionId === "function") {
            const bound = await ordersSvc.workflows.byVersionId(tx, lockedOrder.workflowVersionId);
            const state = bound.definition.states.find((s) => s.key === lockedOrder.statusKey);
            orderCancelled = Boolean(state && state.kind === "terminal" && /cancel/.test(state.key));
          }
          if (orderCancelled) {
            throw conflict("ORDER_CANCELLED", "Cannot start payment for a cancelled order.");
          }
          if (lockedOrder.lockState === "legal_hold" || lockedOrder.lockState === "imported_read_only") {
            throw new DomainError("LOCKED", "ORDER_LOCKED", "Order is locked against online checkout.", {
              lockState: lockedOrder.lockState,
            });
          }
        }

        const lockedInvoice = await complianceSvc.getInvoiceForCheckout(invoicePublicId, {
          ...(opts?.principal ? { principal: opts.principal } : {}),
          tx,
          forUpdate: true,
        });
        if (opts?.principal) {
          const liveActor = await assertLiveActorInTx(deps, opts.principal, tx);
          if (
            liveActor.role === "customer" &&
            (lockedInvoice.ownerUserId !== liveActor.userId ||
              (lockedOrderOwnerUserId !== null && lockedOrderOwnerUserId !== liveActor.userId))
          ) {
            throw notFound("INVOICE_NOT_FOUND");
          }
        }
        if (lockedInvoice.origin !== "portal") {
        throw conflict("IMPORTED_INVOICE_READ_ONLY", "Imported historical invoices cannot be paid online.");
      }
      if (lockedInvoice.voidedAt !== null || lockedInvoice.status === "void") {
        throw conflict("INVOICE_VOIDED", "Voided invoices cannot be paid.");
      }
      if (lockedInvoice.issuedAt === null || lockedInvoice.status === "draft") {
        throw conflict("INVOICE_NOT_ISSUED", "Draft invoices must be issued before starting checkout.");
      }
      if (lockedInvoice.status === "paid" || lockedInvoice.balanceDueMinor <= 0) {
        throw conflict("INVOICE_ALREADY_PAID", "This invoice is already paid in full.");
      }

      // Increment 06 D5: Re-verify provider minimum under canonical row locks when provider is ready.
      if (providerReadyBeforeTx) {
        const smallTotals = await loadSmallTotals(tx);
        const minimumMinor = resolveProviderMinimumMinor(activeProvider, lockedInvoice.currency, smallTotals);
        if (lockedInvoice.balanceDueMinor > 0 && lockedInvoice.balanceDueMinor < minimumMinor) {
          if (smallTotals.belowProviderMinimum === "block") {
            const minFormatted = (minimumMinor / 100).toFixed(2);
            throw new DomainError(
              "CONFLICT",
              "AMOUNT_BELOW_PROVIDER_MINIMUM",
              `Online card payments require a minimum charge of ${lockedInvoice.currency.toUpperCase()} ${minFormatted}. Adjust your order or contact support.`,
              {
                minimumMinor,
                balanceDueMinor: lockedInvoice.balanceDueMinor,
                currency: lockedInvoice.currency.toUpperCase(),
              },
            );
          }

          // Fail closed: ANY previously committed `payment_attempts` row on this invoice (including
          // ref-less `failed` rows from ambiguous provider dispatches or locally expired rows) blocks
          // automatic small-balance waiver so we never issue a waiver receipt while external exposure may exist.
          const priorAttempts = await tx
            .select({
              publicId: paymentAttempts.publicId,
              status: paymentAttempts.status,
            })
            .from(paymentAttempts)
            .where(eq(paymentAttempts.invoiceId, lockedInvoice.invoiceId))
            .for("update");
          if (priorAttempts.length > 0) {
            const blockingAttempt = priorAttempts[0]!;
            throw new DomainError(
              "CONFLICT",
              "PAYMENT_ATTEMPT_OUTSTANDING",
              "Cannot waive small balance when a prior payment attempt has been recorded for this invoice.",
              {
                attemptPublicId: blockingAttempt.publicId,
                attemptStatus: blockingAttempt.status,
              },
            );
          }

          if (typeof complianceSvc.settleCheckoutInvoiceInTx === "function") {
            const settledWaive = await complianceSvc.settleCheckoutInvoiceInTx(
              {
                settlementKind: "waived_small_total",
                invoicePublicId: lockedInvoice.invoicePublicId,
                providerMinimumMinor: minimumMinor,
              },
              tx,
            );
            return {
              kind: "settled_waived" as const,
              waivedMinor: settledWaive.waivedMinor,
              receiptPublicId: settledWaive.receiptPublicId,
            };
          }
        }
      }

      const [existing] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.invoiceId, lockedInvoice.invoiceId),
            eq(paymentAttempts.idempotencyKey, idempotencyKey),
          ),
        )
        .for("update")
        .limit(1);

      if (existing) {
        const stillUnexpired = !existing.expiresAt || existing.expiresAt.getTime() > now.getTime();
        if (
          existing.status === "redirected" &&
          stillUnexpired &&
          existing.provider === activeProvider &&
          existing.environment === config.mode &&
          existing.amountMinor === lockedInvoice.balanceDueMinor &&
          existing.redirectUrlEnc
        ) {
          const redirectUrl = deps.crypto.decrypt(
            existing.redirectUrlEnc,
            `payment_attempts.redirect_url:${existing.publicId}`,
          );
          return {
            kind: "reused" as const,
            attemptPublicId: existing.publicId,
            redirectUrl,
            expiresAt: existing.expiresAt,
          };
        }
        if (existing.status === "paid") {
          throw conflict("INVOICE_ALREADY_PAID", "This payment attempt has already been completed.");
        }
      }

      let resolvedCartPublicId = opts?.cartPublicId ?? existing?.cartPublicId ?? null;
      if (!resolvedCartPublicId) {
        const [priorCartAttempt] = await tx
          .select({ cartPublicId: paymentAttempts.cartPublicId })
          .from(paymentAttempts)
          .where(eq(paymentAttempts.invoiceId, lockedInvoice.invoiceId))
          .orderBy(desc(paymentAttempts.id))
          .limit(5);
        if (priorCartAttempt?.cartPublicId) {
          resolvedCartPublicId = priorCartAttempt.cartPublicId;
        }
      }

      const effectiveIdem = existing ? `${idempotencyKey}:${ulid(now.getTime()).slice(-10)}`.slice(0, 128) : idempotencyKey;
      const attemptPublicId = ulid(now.getTime());
      const [ins] = await tx.insert(paymentAttempts).values({
        publicId: attemptPublicId,
        invoiceId: lockedInvoice.invoiceId,
        invoicePublicId: lockedInvoice.invoicePublicId,
        orderPublicId: lockedInvoice.orderPublicId,
        cartPublicId: resolvedCartPublicId,
        customerUserId: lockedInvoice.ownerUserId,
        provider: activeProvider,
        environment: config.mode,
        status: "created",
        amountMinor: lockedInvoice.balanceDueMinor,
        currency: lockedInvoice.currency.toUpperCase(),
        idempotencyKey: effectiveIdem,
        successPath,
        cancelPath,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      await deps.audit.record(
        {
          category: "business",
          eventName: "payments.attempt.created",
          action: "create",
          outcome: "attempted",
          actor: opts?.principal
            ? { userId: opts.principal.userId, role: opts.principal.role }
            : { role: "system" },
          resource: { type: "payment_attempt", publicId: attemptPublicId },
          attributes: {
            invoice_public_id: lockedInvoice.invoicePublicId,
            order_public_id: lockedInvoice.orderPublicId,
            provider: activeProvider,
            environment: config.mode,
            amount_minor: lockedInvoice.balanceDueMinor,
            currency: lockedInvoice.currency.toUpperCase(),
          },
        },
        tx,
      );

      return {
        kind: "created" as const,
        attemptId: ins.insertId,
        attemptPublicId,
        amountMinor: lockedInvoice.balanceDueMinor,
      };
    }),
    );

    if (preAttempt.kind === "settled_waived") {
      return {
        mode: "settled",
        settlementKind: "waived_small_total",
        invoicePublicId: invoice.invoicePublicId,
        waivedMinor: preAttempt.waivedMinor,
        ...(preAttempt.receiptPublicId ? { receiptPublicId: preAttempt.receiptPublicId } : {}),
      };
    }

    if (preAttempt.kind === "reused") {
      return {
        mode: "redirect",
        attemptPublicId: preAttempt.attemptPublicId,
        invoicePublicId: invoice.invoicePublicId,
        provider: activeProvider,
        environment: config.mode,
        redirectUrl: preAttempt.redirectUrl,
        expiresAt: preAttempt.expiresAt,
      };
    }

    const { returnUrl, cancelUrl } = buildCanonicalReturnUrls(
      activeProvider,
      preAttempt.attemptPublicId,
      successPath,
    );
    const adapter = adapters[activeProvider];

    try {
      let credentials: ProviderCredentials;
      if (activeProvider === "stripe") {
        const [stripeKey, stripeWh, egress, diagState] = await Promise.all([
          readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY),
          readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET),
          checkEgressPresets(config.mode),
          loadDiagnostics(),
        ]);
        if (!stripeKey || !stripeWh) {
          throw new DomainError(
            "UNAVAILABLE",
            "PROVIDER_NOT_CONFIGURED",
            "Stripe credentials are not configured.",
          );
        }
        const expectedPrefix = config.mode === "live" ? /^(?:sk|rk)_live_/u : /^(?:sk|rk)_test_/u;
        if (!expectedPrefix.test(stripeKey)) {
          throw new DomainError(
            "UNAVAILABLE",
            "STRIPE_KEY_MODE_MISMATCH",
            `Stripe API key prefix does not match configured ${config.mode} environment.`,
          );
        }
        if (egress.wired && !egress.stripeAllowlisted) {
          throw new DomainError(
            "FORBIDDEN",
            "EGRESS_HOST_NOT_ALLOWLISTED",
            "Stripe outbound HTTPS allowlist preset is disabled.",
          );
        }
        const stripeState = resolveStripeVerificationState(config, stripeKey, stripeWh, egress);
        const isLegacyUnwiredSeed =
          !egress.wired &&
          config.stripeApiVerifiedFingerprint === null &&
          config.stripeSelfTestedFingerprint === null &&
          !diagState.stripeEverApiVerified &&
          !diagState.stripeEverSelfTested;
        if (!isLegacyUnwiredSeed && (!stripeState.apiVerified || !stripeState.selfTestVerified)) {
          throw new DomainError(
            "UNAVAILABLE",
            "PROVIDER_VERIFICATION_STALE",
            "Stripe credentials or outbound allowlist changed after verification and must be re-verified.",
          );
        }
        credentials = { mode: config.mode, secretKey: stripeKey };
      } else {
        try {
          const loaded = await loadProviderCredentials(activeProvider, config);
          credentials = loaded.credentials;
        } catch (credErr) {
          if (credErr instanceof DomainError && credErr.reasonCode === "PAYMENT_PROVIDER_NOT_CONFIGURED") {
            throw new DomainError(
              "UNAVAILABLE",
              "PROVIDER_NOT_CONFIGURED",
              "Square credentials or location ID are not configured.",
            );
          }
          throw credErr;
        }
      }

      const createdSession = await adapter.createCheckout({
        attemptPublicId: preAttempt.attemptPublicId,
        invoicePublicId: invoice.invoicePublicId,
        invoiceNumber: invoice.invoiceNumber ?? invoice.invoicePublicId,
        orderPublicId: invoice.orderPublicId,
        orderReference: invoice.orderReference,
        amountMinor: preAttempt.amountMinor,
        currency: invoice.currency.toUpperCase(),
        idempotencyKey,
        returnUrl,
        cancelUrl,
        credentials,
      });

      const completedAt = deps.clock.now();
      const expiresAt = createdSession.expiresAt ?? new Date(completedAt.getTime() + DEFAULT_ATTEMPT_TTL_MS);
      const redirectUrlEnc = deps.crypto.encrypt(
        createdSession.redirectUrl,
        `payment_attempts.redirect_url:${preAttempt.attemptPublicId}`,
      );

      const postTxResult = await deps.db.transaction(async (tx) => {
        const [curAttempt] = await tx
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, preAttempt.attemptId))
          .for("update")
          .limit(1);
        const trashedDuringCreate =
          (await isOrderTrashedInTx(tx, invoice.orderId)) ||
          curAttempt?.status === "cancelled" ||
          curAttempt?.trashCancelledAt !== null;

        if (trashedDuringCreate) {
          await tx
            .update(paymentAttempts)
            .set({
              status: "cancelled",
              providerRef: createdSession.providerRef,
              providerOrderRef: createdSession.providerOrderRef ?? null,
              providerPaymentRef: createdSession.providerPaymentRef ?? null,
              cancelledAt: curAttempt?.cancelledAt ?? completedAt,
              trashCancelledAt: curAttempt?.trashCancelledAt ?? completedAt,
              failureReasonCode: "ORDER_TRASHED",
              redirectUrlEnc: null,
              version: (curAttempt?.version ?? 1) + 1,
              updatedAt: completedAt,
            })
            .where(eq(paymentAttempts.id, preAttempt.attemptId));

          await deps.jobs.enqueue(
            CANCEL_ATTEMPT_PROVIDER_JOB_TYPE,
            { attemptPublicId: preAttempt.attemptPublicId },
            { idempotencyKey: `pmt-trash-cancel:${preAttempt.attemptPublicId}` },
            tx,
          );
          return { trashedDuringCreate: true as const };
        }

        await tx
          .update(paymentAttempts)
          .set({
            status: "redirected",
            providerRef: createdSession.providerRef,
            providerOrderRef: createdSession.providerOrderRef ?? null,
            providerPaymentRef: createdSession.providerPaymentRef ?? null,
            redirectUrlEnc,
            redirectedAt: completedAt,
            expiresAt,
            version: 2,
            updatedAt: completedAt,
          })
          .where(and(eq(paymentAttempts.id, preAttempt.attemptId), eq(paymentAttempts.version, 1)));

        await deps.audit.record(
          {
            category: "business",
            eventName: "payments.attempt.redirected",
            action: "transition",
            outcome: "completed",
            actor: opts?.principal
              ? { userId: opts.principal.userId, role: opts.principal.role }
              : { role: "system" },
            resource: { type: "payment_attempt", publicId: preAttempt.attemptPublicId },
            attributes: {
              invoice_public_id: invoice.invoicePublicId,
              order_public_id: invoice.orderPublicId,
              provider: activeProvider,
              environment: config.mode,
              provider_ref: createdSession.providerRef,
              amount_minor: preAttempt.amountMinor,
              currency: invoice.currency.toUpperCase(),
            },
          },
          tx,
        );
        return { trashedDuringCreate: false as const };
      });

      if (postTxResult.trashedDuringCreate) {
        throw notFound("INVOICE_NOT_FOUND");
      }

      return {
        mode: "redirect",
        attemptPublicId: preAttempt.attemptPublicId,
        invoicePublicId: invoice.invoicePublicId,
        provider: activeProvider,
        environment: config.mode,
        redirectUrl: createdSession.redirectUrl,
        expiresAt,
      };
    } catch (err) {
      if (err instanceof DomainError && err.code === "NOT_FOUND" && err.reasonCode === "INVOICE_NOT_FOUND") {
        throw err;
      }
      const failedAt = deps.clock.now();
      const reasonCode = (err instanceof DomainError ? err.reasonCode : "PROVIDER_CREATE_ERROR").slice(0, 64);
      const errCode = err instanceof DomainError ? err.code : "UNAVAILABLE";
      const detailsRec =
        err instanceof DomainError && err.details && typeof err.details === "object"
          ? (err.details as Record<string, unknown>)
          : null;
      const upstreamStatus =
        typeof detailsRec?.upstreamStatus === "number" &&
        Number.isInteger(detailsRec.upstreamStatus) &&
        detailsRec.upstreamStatus >= 100 &&
        detailsRec.upstreamStatus <= 599
          ? detailsRec.upstreamStatus
          : null;
      const stripeErrorType = sanitizeStripeDiagnosticToken(detailsRec?.stripeErrorType);
      const stripeErrorCode = sanitizeStripeDiagnosticToken(detailsRec?.stripeErrorCode);
      const stripeErrorParam = sanitizeStripeDiagnosticToken(detailsRec?.stripeErrorParam, {
        allowBrackets: true,
      });
      const failureClass = classifyCheckoutFailureReason(reasonCode, "failed") ?? "provider_response";
      const alertDesc = describeCheckoutFailureForAdmin({
        provider: activeProvider,
        mode: config.mode,
        reasonCode,
        upstreamStatus,
        stripeErrorCode,
      });

      await deps.db.transaction(async (tx) => {
        await tx
          .update(paymentAttempts)
          .set({
            status: "failed",
            failureReasonCode: reasonCode,
            version: 2,
            updatedAt: failedAt,
          })
          .where(and(eq(paymentAttempts.id, preAttempt.attemptId), eq(paymentAttempts.status, "created")));

        await notifyOrderPaymentEventInTx(tx, {
          orderPublicId: invoice.orderPublicId,
          orderId: invoice.orderId,
          kind: "failed",
          eventRef: preAttempt.attemptPublicId,
        });

        await deps.audit.record(
          {
            category: "integration",
            eventName: "payments.attempt.failed",
            action: "create",
            outcome: "failed",
            severity: "WARN",
            reasonCode,
            actor: { role: "system" },
            resource: { type: "payment_attempt", publicId: preAttempt.attemptPublicId },
            orderPublicId: invoice.orderPublicId,
            attributes: {
              order_public_id: invoice.orderPublicId,
              invoice_public_id: invoice.invoicePublicId,
              provider: activeProvider,
              environment: config.mode,
              reason_code: reasonCode,
              failure_class: failureClass,
              payment_state: "failed",
              ...(upstreamStatus !== null ? { upstream_http_status: upstreamStatus } : {}),
              ...(stripeErrorType ? { stripe_error_type: stripeErrorType } : {}),
              ...(stripeErrorCode ? { stripe_error_code: stripeErrorCode } : {}),
              ...(stripeErrorParam ? { stripe_error_param: stripeErrorParam } : {}),
            },
          },
          tx,
        );

        await updateDiagnosticsBestEffort(
          (prev) => ({
            ...prev,
            lastCheckoutFailure: {
              occurredAt: failedAt.toISOString(),
              provider: activeProvider,
              mode: config.mode,
              reasonCode,
              failureClass,
              upstreamStatus,
              stripeErrorType,
              stripeErrorCode,
              stripeErrorParam,
              attemptPublicId: preAttempt.attemptPublicId,
              invoicePublicId: invoice.invoicePublicId,
              orderPublicId: invoice.orderPublicId,
            },
          }),
          tx,
        );

        await emitPaymentOpsAlert(
          {
            dedupKey: `checkout_start_failed:${activeProvider}:${config.mode}:${reasonCode}`,
            severity: alertDesc.severity,
            code: `CHECKOUT_${reasonCode}`.slice(0, 64),
            title: alertDesc.title,
            text: `${alertDesc.explanation} Next step: ${alertDesc.nextStep}`,
            orderPublicId: invoice.orderPublicId,
          },
          tx,
        );
      });

      const onlineReadyNow = await isProviderCredentialsReady(config);
      throw new DomainError(
        errCode,
        reasonCode,
        customerMessageForCheckoutFailure(failureClass),
        {
          ...(upstreamStatus !== null ? { upstreamStatus } : {}),
          attemptPublicId: preAttempt.attemptPublicId,
          invoicePublicId: invoice.invoicePublicId,
          failureClass,
          onlinePaymentAvailable: onlineReadyNow,
        },
      );
    }
  }

  async function startInvoiceCheckout(
    invoicePublicId: string,
    returnPaths?: CheckoutReturnPaths,
    opts?: StartCheckoutOptions,
  ): Promise<Exclude<StartCheckoutResult, { mode: "invoice" }>> {
    const res = await startCheckout(invoicePublicId, returnPaths, opts);
    if (res.mode === "invoice") {
      throw new DomainError(
        "UNAVAILABLE",
        "ONLINE_PAYMENT_DISABLED",
        "Online card payment is not currently enabled. Follow the payment instructions on your invoice.",
        {
          invoicePublicId: res.invoicePublicId,
          failureClass: "configuration" satisfies CheckoutFailureClass,
          onlinePaymentAvailable: false,
        },
      );
    }
    return res;
  }

  async function getCheckoutStatus(
    principal: SessionPrincipal,
    query: { invoicePublicId?: string | undefined; attemptPublicId?: string | undefined },
  ): Promise<CheckoutStatusView> {
    if (!query.invoicePublicId && !query.attemptPublicId) {
      throw validation("MISSING_CHECKOUT_QUERY", "Provide either invoicePublicId or attemptPublicId.");
    }

    const complianceSvc = requireComplianceService();
    const config = await loadConfig();

    let targetInvoicePublicId = query.invoicePublicId;
    if (!targetInvoicePublicId) {
      const [attRef] = await deps.db
        .select({ invoicePublicId: paymentAttempts.invoicePublicId })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.publicId, query.attemptPublicId!))
        .limit(1);
      if (!attRef) throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      targetInvoicePublicId = attRef.invoicePublicId;
    }

    // Enforces resource-level read authorization (throws NOT_FOUND for other customers; no existence oracle).
    let invoice: Awaited<ReturnType<typeof complianceSvc.getInvoiceForCheckout>>;
    try {
      invoice = await complianceSvc.getInvoiceForCheckout(targetInvoicePublicId, { principal });
      if (await isOrderTrashedInTx(deps.db, invoice.orderId)) {
        throw notFound("INVOICE_NOT_FOUND");
      }
    } catch (err) {
      if (query.attemptPublicId && !query.invoicePublicId && err instanceof DomainError && err.code === "NOT_FOUND") {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }
      throw err;
    }

    let attemptRow: PaymentAttemptRow | null;
    if (query.attemptPublicId) {
      const [found] = await deps.db
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.publicId, query.attemptPublicId),
            eq(paymentAttempts.invoiceId, invoice.invoiceId),
            eq(paymentAttempts.invoicePublicId, invoice.invoicePublicId),
            eq(paymentAttempts.customerUserId, invoice.ownerUserId),
          ),
        )
        .limit(1);
      if (!found) {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }
      attemptRow = found;
    } else {
      const [latest] = await deps.db
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.invoiceId, invoice.invoiceId),
            eq(paymentAttempts.invoicePublicId, invoice.invoicePublicId),
            eq(paymentAttempts.customerUserId, invoice.ownerUserId),
          ),
        )
        .orderBy(desc(paymentAttempts.id))
        .limit(1);
      attemptRow = latest ?? null;
    }

    const now = deps.clock.now();
    const onlineReady = await isProviderCredentialsReady(config);

    let orderCancelled = false;
    let orderLocked = false;
    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if (ordersSvc && typeof ordersSvc.getOrderRefById === "function") {
      try {
        const orderRef = await ordersSvc.getOrderRefById(invoice.orderId);
        if (orderRef) {
          orderCancelled = /cancel/.test(orderRef.statusKey);
          if (ordersSvc.workflows && typeof ordersSvc.workflows.byVersionId === "function") {
            const bound = await ordersSvc.workflows.byVersionId(
              deps.db as unknown as Tx,
              orderRef.workflowVersionId,
            );
            const state = bound.definition.states.find((s) => s.key === orderRef.statusKey);
            orderCancelled = Boolean(state && state.kind === "terminal" && /cancel/.test(state.key));
          }
          orderLocked =
            orderRef.lockState === "legal_hold" || orderRef.lockState === "imported_read_only";
        }
      } catch {
        // Non-fatal read-only order hint; startCheckout enforces authoritative row locks.
      }
    }

    let onlinePaymentUnavailableReason: OnlinePaymentUnavailableReason | null = null;
    if (
      invoice.origin !== "portal" ||
      invoice.voidedAt !== null ||
      invoice.status !== "issued" ||
      invoice.issuedAt === null ||
      invoice.balanceDueMinor <= 0
    ) {
      onlinePaymentUnavailableReason = "invoice_not_payable";
    } else if (orderCancelled) {
      onlinePaymentUnavailableReason = "order_cancelled";
    } else if (orderLocked) {
      onlinePaymentUnavailableReason = "order_locked";
    } else if (config.provider === "none") {
      onlinePaymentUnavailableReason = "provider_off";
    } else if (!onlineReady) {
      onlinePaymentUnavailableReason = "provider_not_ready";
    } else if (invoice.currency.toUpperCase() !== config.currency.toUpperCase()) {
      onlinePaymentUnavailableReason = "currency_mismatch";
    } else {
      const smallTotals = await loadSmallTotals();
      const minimumMinor = resolveProviderMinimumMinor(config.provider, invoice.currency, smallTotals);
      if (
        invoice.balanceDueMinor > 0 &&
        invoice.balanceDueMinor < minimumMinor &&
        smallTotals.belowProviderMinimum === "block"
      ) {
        onlinePaymentUnavailableReason = "below_minimum";
      }
    }

    const onlinePaymentAvailable = onlinePaymentUnavailableReason === null;

    const attemptExpiredByClock = Boolean(
      attemptRow &&
        (attemptRow.status === "created" || attemptRow.status === "redirected") &&
        attemptRow.expiresAt !== null &&
        attemptRow.expiresAt.getTime() <= now.getTime(),
    );
    const attemptInFlight = Boolean(
      attemptRow &&
        (attemptRow.status === "created" || attemptRow.status === "redirected") &&
        !attemptExpiredByClock,
    );
    const lastAttemptFailureClass: CheckoutFailureClass | null = !attemptRow
      ? null
      : attemptRow.status === "paid"
        ? null
        : attemptRow.status === "created" || attemptRow.status === "redirected"
          ? attemptExpiredByClock
            ? "expired"
            : null
          : classifyCheckoutFailureReason(attemptRow.failureReasonCode, attemptRow.status);

    return {
      invoicePublicId: invoice.invoicePublicId,
      invoiceNumber: invoice.invoiceNumber,
      invoiceStatus: invoice.status,
      amountMinor: invoice.totalMinor,
      balanceDueMinor: invoice.balanceDueMinor,
      waivedMinor: invoice.waivedMinor ?? 0,
      receiptPublicId: invoice.receiptPublicId ?? null,
      currency: invoice.currency,
      providerConfigured: onlineReady ? config.provider : "none",
      environment: config.mode,
      onlinePaymentAvailable,
      onlinePaymentUnavailableReason,
      attemptInFlight,
      lastAttemptFailureClass,
      attempt: attemptRow
        ? {
            attemptPublicId: attemptRow.publicId,
            provider: attemptRow.provider,
            environment: attemptRow.environment,
            status: attemptRow.status,
            bookingSource: attemptRow.bookingSource,
            cartPublicId: attemptRow.cartPublicId,
            amountMinor: attemptRow.amountMinor,
            currency: attemptRow.currency,
            createdAt: attemptRow.createdAt,
            redirectedAt: attemptRow.redirectedAt,
            paidAt: attemptRow.paidAt,
            expiresAt: attemptRow.expiresAt,
            reconciliationNote: attemptRow.reconciliationNote,
            failureReasonCode: attemptRow.failureReasonCode,
          }
        : null,
    };
  }

  async function cancelAttemptIfUnpaid(
    principal: SessionPrincipal,
    target: { invoicePublicId?: string | undefined; attemptPublicId?: string | undefined },
    callerTx?: Tx,
  ): Promise<CancelAttemptResult> {
    if (!target.invoicePublicId && !target.attemptPublicId) {
      throw validation("MISSING_CANCEL_TARGET", "Provide either invoicePublicId or attemptPublicId.");
    }

    const complianceSvc = requireComplianceService();
    // Non-locking owner staging before acquiring `orders FOR UPDATE` so foreign customer callers
    // never lock another customer's order/invoice row, while keeping canonical `orders -> compliance_invoices -> actor -> payment_attempts` lock order.
    const stagedReadDb = callerTx ?? deps.db;
    let stagedInvoicePublicId = target.invoicePublicId;
    if (!stagedInvoicePublicId) {
      const [attRef] = await stagedReadDb
        .select({
          invoicePublicId: paymentAttempts.invoicePublicId,
          customerUserId: paymentAttempts.customerUserId,
        })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.publicId, target.attemptPublicId!))
        .limit(1);
      if (!attRef) throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      if (principal.role === "customer" && attRef.customerUserId !== principal.userId) {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }
      stagedInvoicePublicId = attRef.invoicePublicId;
    }

    try {
      const preInvoice = await complianceSvc.getInvoiceForCheckout(stagedInvoicePublicId, {
        principal,
        ...(callerTx ? { tx: callerTx } : {}),
      });
      if (await isOrderTrashedInTx(stagedReadDb, preInvoice.orderId)) {
        throw notFound("INVOICE_NOT_FOUND");
      }
      if (principal.role === "customer" && preInvoice.ownerUserId !== principal.userId) {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }
    } catch (err) {
      if (target.attemptPublicId && !target.invoicePublicId && err instanceof DomainError && err.code === "NOT_FOUND") {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }
      throw err;
    }

    const run = async (tx: Tx): Promise<CancelAttemptResult> => {
      let invoice: Awaited<ReturnType<typeof complianceSvc.getInvoiceForCheckout>>;
      try {
        invoice = await complianceSvc.getInvoiceForCheckout(stagedInvoicePublicId, {
          principal,
          tx,
          forUpdate: true,
        });
        if (await isOrderTrashedInTx(tx, invoice.orderId)) {
          throw notFound("INVOICE_NOT_FOUND");
        }
      } catch (err) {
        if (target.attemptPublicId && !target.invoicePublicId && err instanceof DomainError && err.code === "NOT_FOUND") {
          throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
        }
        throw err;
      }

      const liveActor = await assertLiveActorInTx(deps, principal, tx);
      const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };
      if (livePrincipal.role === "customer" && invoice.ownerUserId !== liveActor.userId) {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }

      let attemptRow: PaymentAttemptRow | undefined;
      if (target.attemptPublicId) {
        const [found] = await tx
          .select()
          .from(paymentAttempts)
          .where(
            and(
              eq(paymentAttempts.publicId, target.attemptPublicId),
              eq(paymentAttempts.invoiceId, invoice.invoiceId),
              eq(paymentAttempts.invoicePublicId, invoice.invoicePublicId),
              eq(paymentAttempts.customerUserId, invoice.ownerUserId),
            ),
          )
          .for("update")
          .limit(1);
        if (!found) throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
        attemptRow = found;
      } else {
        const [found] = await tx
          .select()
          .from(paymentAttempts)
          .where(
            and(
              eq(paymentAttempts.invoiceId, invoice.invoiceId),
              eq(paymentAttempts.invoicePublicId, invoice.invoicePublicId),
              eq(paymentAttempts.customerUserId, invoice.ownerUserId),
            ),
          )
          .orderBy(desc(paymentAttempts.id))
          .for("update")
          .limit(1);
        attemptRow = found;
      }

      if (!attemptRow) {
        return { cancelled: false, attemptPublicId: null, status: null };
      }
      if (attemptRow.status === "paid" || invoice.status === "paid") {
        return { cancelled: false, attemptPublicId: attemptRow.publicId, status: "paid" };
      }
      if (attemptRow.status === "cancelled") {
        return { cancelled: true, attemptPublicId: attemptRow.publicId, status: "cancelled" };
      }
      if (attemptRow.status !== "created" && attemptRow.status !== "redirected") {
        return { cancelled: false, attemptPublicId: attemptRow.publicId, status: attemptRow.status };
      }

      const now = deps.clock.now();
      const [cas] = await tx
        .update(paymentAttempts)
        .set({
          status: "cancelled",
          cancelledAt: now,
          version: attemptRow.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentAttempts.id, attemptRow.id),
            eq(paymentAttempts.invoiceId, invoice.invoiceId),
            eq(paymentAttempts.customerUserId, invoice.ownerUserId),
            eq(paymentAttempts.version, attemptRow.version),
          ),
        );
      if (cas.affectedRows !== 1) {
        throw conflict("PAYMENT_ATTEMPT_STALE", "Payment attempt state changed concurrently; retry.");
      }

      await deps.audit.record(
        {
          category: "business",
          eventName: "payments.attempt.cancelled",
          action: "transition",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "payment_attempt", publicId: attemptRow.publicId },
          attributes: {
            invoice_public_id: attemptRow.invoicePublicId,
            provider: attemptRow.provider,
            environment: attemptRow.environment,
          },
        },
        tx,
      );

      return {
        cancelled: true,
        attemptPublicId: attemptRow.publicId,
        status: "cancelled",
      };
    };

    if (callerTx) return run(callerTx);
    return runWithMysqlDeadlockRetry(() =>
      runComplianceTx(deps, principal, { type: "payment_attempt" }, run),
    );
  }

  /**
   * Lock `orders -> compliance_invoices -> current ledger sums` under `FOR UPDATE` for system
   * webhook/worker paths, returning `null` only if the invoice row itself no longer exists while
   * propagating database/deadlock errors so `runWithMysqlDeadlockRetry` can retry cleanly.
   */
  async function loadLockedCurrentInvoiceOrNull(tx: Tx, invoicePublicId: string) {
    const complianceSvc = requireComplianceService();
    try {
      return await complianceSvc.getInvoiceForCheckout(invoicePublicId, {
        tx,
        forUpdate: true,
      });
    } catch (err) {
      if (err instanceof DomainError && err.code === "NOT_FOUND") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Common strict provider-binding matcher shared across ALL provider responses (paid, asyncPending,
   * open, expired, failed) so a malformed or wrong echoed Stripe session can NEVER mutate an attempt's
   * status/diagnostics without strict identity, mode, amount, currency, and metadata agreement.
   */
  function checkFetchedBindingMatchesAttempt(
    attempt: PaymentAttemptRow,
    fetched: ProviderFetchedPayment,
  ): { matches: true } | { matches: false; reasonCode: string } {
    if (!attempt.providerRef || !fetched.providerRef || fetched.providerRef !== attempt.providerRef) {
      return { matches: false, reasonCode: "PROVIDER_REF_MISMATCH" };
    }
    const expectedLive = attempt.environment === "live";
    if (
      (attempt.provider === "stripe" && fetched.livemodeValid !== true) ||
      fetched.livemodeValid === false ||
      fetched.livemode !== expectedLive
    ) {
      return { matches: false, reasonCode: "MODE_MISMATCH" };
    }
    if (
      (attempt.provider === "stripe" && fetched.amountValid !== true) ||
      fetched.amountValid === false ||
      !Number.isSafeInteger(fetched.amountMinor) ||
      fetched.amountMinor < 0 ||
      fetched.amountMinor !== attempt.amountMinor
    ) {
      return { matches: false, reasonCode: "AMOUNT_MISMATCH" };
    }
    const normalizedFetchedCurrency = fetched.currency.trim().toUpperCase();
    if (
      !/^[A-Z]{3}$/u.test(normalizedFetchedCurrency) ||
      normalizedFetchedCurrency !== attempt.currency.toUpperCase()
    ) {
      return { matches: false, reasonCode: "CURRENCY_MISMATCH" };
    }
    if (
      fetched.clientReferenceId !== undefined &&
      fetched.clientReferenceId !== null &&
      fetched.clientReferenceId !== attempt.publicId
    ) {
      return { matches: false, reasonCode: "CLIENT_REFERENCE_MISMATCH" };
    }
    if (
      !fetched.attemptPublicId ||
      fetched.attemptPublicId !== attempt.publicId ||
      fetched.hasReferenceConflict ||
      (fetched.paymentIntentAttemptPublicId && fetched.paymentIntentAttemptPublicId !== attempt.publicId)
    ) {
      return { matches: false, reasonCode: "ATTEMPT_METADATA_MISMATCH" };
    }
    if (
      !fetched.invoicePublicId ||
      fetched.invoicePublicId !== attempt.invoicePublicId ||
      (fetched.paymentIntentInvoicePublicId && fetched.paymentIntentInvoicePublicId !== attempt.invoicePublicId)
    ) {
      return { matches: false, reasonCode: "INVOICE_METADATA_MISMATCH" };
    }
    if (
      (attempt.provider === "stripe" && !fetched.orderPublicId) ||
      (fetched.orderPublicId && fetched.orderPublicId !== attempt.orderPublicId)
    ) {
      return { matches: false, reasonCode: "ORDER_METADATA_MISMATCH" };
    }
    return { matches: true };
  }

  /**
   * Strict Increment 08 D5 provider-fact matcher shared by BOTH verified webhooks and
   * authoritative server-to-Stripe lookups (`confirmCheckoutPayment`, reconciliation, admin repair).
   *
   * Enforces `checkFetchedBindingMatchesAttempt` PLUS strict paid-state completion invariants:
   * for Stripe, requires `sessionStatus === "complete"` and `paymentStatus === "paid"` (or
   * `no_payment_required` strictly when expected `amountMinor === 0 && fetched.amountMinor === 0`).
   */
  function checkFetchedMatchesAttempt(
    attempt: PaymentAttemptRow,
    fetched: ProviderFetchedPayment,
  ): { matches: true } | { matches: false; reasonCode: string } {
    const bindingCheck = checkFetchedBindingMatchesAttempt(attempt, fetched);
    if (!bindingCheck.matches) {
      return bindingCheck;
    }
    if (attempt.provider === "stripe") {
      if (fetched.sessionStatus !== "complete") {
        return { matches: false, reasonCode: "SESSION_NOT_COMPLETE" };
      }
      if (fetched.paymentStatus === "no_payment_required") {
        if (attempt.amountMinor !== 0 || fetched.amountMinor !== 0) {
          return { matches: false, reasonCode: "UNEXPECTED_NO_PAYMENT_REQUIRED" };
        }
      } else if (fetched.paymentStatus !== "paid") {
        return { matches: false, reasonCode: "PAYMENT_STATUS_NOT_PAID" };
      }
    } else if (fetched.status !== "paid") {
      return { matches: false, reasonCode: "PAYMENT_STATUS_NOT_PAID" };
    }
    return { matches: true };
  }

  async function recordLookupMismatchInTx(
    tx: Tx,
    locked: PaymentAttemptRow,
    fetched: ProviderFetchedPayment,
    reasonCode: string,
    actor: { userId?: number | undefined; role: SessionPrincipal["role"] | "system" },
  ): Promise<void> {
    const now = deps.clock.now();
    const auditActor = actor.userId ? { userId: actor.userId, role: actor.role } : { role: actor.role };
    await tx
      .update(paymentAttempts)
      .set({
        reconciliationNote: `lookup_mismatch:${reasonCode}`.slice(0, 120),
        failureReasonCode: reasonCode,
        lastReconciledAt: now,
        updatedAt: now,
      })
      .where(eq(paymentAttempts.id, locked.id));

    await deps.audit.record(
      {
        category: "security",
        eventName: "payments.verification.mismatch",
        action: "verify",
        outcome: "refused",
        severity: "ERROR",
        reasonCode,
        actor: auditActor,
        resource: { type: "payment_attempt", publicId: locked.publicId },
        orderPublicId: locked.orderPublicId,
        attributes: {
          order_public_id: locked.orderPublicId,
          invoice_public_id: locked.invoicePublicId,
          provider: locked.provider,
          booking_source: "provider_lookup",
          expected_amount_minor: locked.amountMinor,
          fetched_amount_minor: fetched.amountMinor,
          expected_currency: locked.currency,
          fetched_currency: fetched.currency,
        },
      },
      tx,
    );

    await emitPaymentOpsAlert(
      {
        dedupKey: `verification-mismatch:${locked.publicId}`,
        severity: "error",
        code: reasonCode,
        title: "Payment verification mismatch held booking",
        text: "Upstream payment details did not match the expected invoice amount, currency, mode, or metadata.",
        orderPublicId: locked.orderPublicId,
      },
      tx,
    );
  }

  async function emitPaidOnCancelledAttemptAlertInTx(
    tx: Tx,
    locked: PaymentAttemptRow,
    auditActor: { userId?: number | undefined; role: SessionPrincipal["role"] | "system" },
  ): Promise<void> {
    await emitPaymentOpsAlert(
      {
        dedupKey: `paid-cancelled-attempt:${locked.publicId}`,
        severity: "error",
        code: "PAID_ON_CANCELLED_ATTEMPT",
        title: "Cancelled checkout attempt was paid on Stripe",
        text: "Customer completed payment on Stripe after the checkout attempt was cancelled. Open the invoice and run Check with Stripe now to verify and book.",
        orderPublicId: locked.orderPublicId,
      },
      tx,
    );
    await deps.audit.record(
      {
        category: "security",
        eventName: "payments.attempt.paid_after_cancel_held",
        action: "verify",
        outcome: "refused",
        severity: "WARN",
        reasonCode: "PAID_ON_CANCELLED_ATTEMPT",
        actor: auditActor,
        resource: { type: "payment_attempt", publicId: locked.publicId },
        orderPublicId: locked.orderPublicId,
        attributes: {
          order_public_id: locked.orderPublicId,
          invoice_public_id: locked.invoicePublicId,
          provider: locked.provider,
          attempt_status: locked.status,
        },
      },
      tx,
    );
  }

  /**
   * Increment 08 D5 unified idempotent booking critical section:
   * Fed by EITHER a verified signed webhook (`source: "webhook"`) OR an authoritative server-to-provider
   * lookup (`source: "provider_lookup"`).
   *
   * Locks `payment_attempts` `FOR UPDATE`, validates all strict provider facts via
   * `checkFetchedMatchesAttempt`, books the invoice payment once (`pmt-attempt:<attemptPublicId>`),
   * records `bookingSource`, and guarantees that webhook-then-lookup, lookup-then-webhook, and
   * concurrent confirms are no-ops after the first booking.
   */
  async function bookAuthoritativeAttemptPaymentInTx(
    tx: Tx,
    input: {
      attemptId: number;
      source: PaymentBookingSource;
      webhookRowId?: number | undefined;
      fetched: ProviderFetchedPayment;
      actor?: { userId?: number | undefined; role: SessionPrincipal["role"] | "system" } | undefined;
      allowRepair?: boolean | undefined;
    },
  ): Promise<{
    booked: boolean;
    alreadyPaid: boolean;
    reasonCode: string;
    attempt: PaymentAttemptRow | null;
  }> {
    const complianceSvc = requireComplianceService();
    const now = deps.clock.now();
    const auditActor = input.actor?.userId
      ? { userId: input.actor.userId, role: input.actor.role }
      : { role: input.actor?.role ?? "system" };

    // Canonical lock hierarchy: lock parent `orders` -> `compliance_invoices` -> ledger sums FIRST
    // via `getInvoiceForCheckout(..., { tx, forUpdate: true })`, THEN lock `payment_attempts`.
    const [attemptMeta] = await tx
      .select({
        id: paymentAttempts.id,
        invoicePublicId: paymentAttempts.invoicePublicId,
      })
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, input.attemptId))
      .limit(1);

    if (!attemptMeta) {
      return { booked: false, alreadyPaid: false, reasonCode: "ATTEMPT_NOT_FOUND", attempt: null };
    }

    const currentInvoice = await complianceSvc.getInvoiceForCheckout(attemptMeta.invoicePublicId, {
      tx,
      forUpdate: true,
    });

    const [locked] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, input.attemptId))
      .for("update")
      .limit(1);

    if (!locked) {
      return { booked: false, alreadyPaid: false, reasonCode: "ATTEMPT_NOT_FOUND", attempt: null };
    }

    let whRow: PaymentWebhookEventRow | null = null;
    if (input.source === "webhook") {
      if (!input.webhookRowId) {
        return { booked: false, alreadyPaid: false, reasonCode: "WEBHOOK_VERIFICATION_REQUIRED", attempt: locked };
      }
      const [foundWh] = await tx
        .select()
        .from(paymentWebhookEvents)
        .where(eq(paymentWebhookEvents.id, input.webhookRowId))
        .for("update")
        .limit(1);

      if (
        !foundWh ||
        foundWh.attemptId !== locked.id ||
        foundWh.provider !== locked.provider ||
        foundWh.environment !== locked.environment ||
        (locked.status !== "paid" &&
          (!locked.verifiedWebhookEventId || foundWh.externalEventId !== locked.verifiedWebhookEventId)) ||
        (foundWh.providerPaymentRef &&
          input.fetched.providerPaymentRef &&
          foundWh.providerPaymentRef !== input.fetched.providerPaymentRef)
      ) {
        return { booked: false, alreadyPaid: false, reasonCode: "WEBHOOK_RECEIPT_MISMATCH", attempt: locked };
      }
      whRow = foundWh;
    }

    if (locked.status === "paid") {
      if (whRow) {
        await tx
          .update(paymentWebhookEvents)
          .set({ status: "processed", reasonCode: "ALREADY_PAID", processedAt: now })
          .where(eq(paymentWebhookEvents.id, whRow.id));
        if (!locked.verifiedWebhookEventId) {
          await tx
            .update(paymentAttempts)
            .set({
              verifiedWebhookEventId: whRow.externalEventId,
              updatedAt: now,
            })
            .where(eq(paymentAttempts.id, locked.id));
        }
      }
      return {
        booked: true,
        alreadyPaid: true,
        reasonCode: "ALREADY_PAID",
        attempt: whRow && !locked.verifiedWebhookEventId
          ? { ...locked, verifiedWebhookEventId: whRow.externalEventId }
          : locked,
      };
    }

    const orderIsTrashed = await isOrderTrashedInTx(tx, currentInvoice.orderId);
    const isTrashCancelledOrTrashedOrder = locked.trashCancelledAt !== null || orderIsTrashed;

    if (!input.allowRepair) {
      if (input.source === "provider_lookup") {
        const allowLateTrashBooking = locked.status === "cancelled" && isTrashCancelledOrTrashedOrder;
        if (locked.status !== "created" && locked.status !== "redirected" && !allowLateTrashBooking) {
          if (
            locked.status === "cancelled" &&
            currentInvoice.status === "issued" &&
            currentInvoice.voidedAt === null &&
            checkFetchedMatchesAttempt(locked, input.fetched).matches
          ) {
            await emitPaidOnCancelledAttemptAlertInTx(tx, locked, auditActor);
          }
          return { booked: false, alreadyPaid: false, reasonCode: "ATTEMPT_NOT_ACTIVE", attempt: locked };
        }
      } else if (locked.status === "failed") {
        if (whRow) {
          await tx
            .update(paymentWebhookEvents)
            .set({ status: "ignored", reasonCode: "ATTEMPT_FAILED", processedAt: now })
            .where(eq(paymentWebhookEvents.id, whRow.id));
        }
        return { booked: false, alreadyPaid: false, reasonCode: "ATTEMPT_NOT_ACTIVE", attempt: locked };
      }
    }

    if (currentInvoice.status === "paid") {
      if (whRow) {
        await tx
          .update(paymentWebhookEvents)
          .set({ status: "ignored", reasonCode: "INVOICE_ALREADY_PAID", processedAt: now })
          .where(eq(paymentWebhookEvents.id, whRow.id));
      }
      await emitPaymentOpsAlert(
        {
          dedupKey: `duplicate-paid-attempt:${locked.publicId}`,
          severity: "warning",
          code: "INVOICE_ALREADY_PAID",
          title: "Additional paid provider session detected on an already-paid invoice",
          text: "A second payment attempt settled after the invoice was already paid. Review for possible refund.",
          orderPublicId: locked.orderPublicId,
        },
        tx,
      );
      return { booked: false, alreadyPaid: false, reasonCode: "INVOICE_ALREADY_PAID", attempt: locked };
    }
    if (currentInvoice.status !== "issued" || currentInvoice.voidedAt !== null) {
      if (whRow) {
        await tx
          .update(paymentWebhookEvents)
          .set({ status: "ignored", reasonCode: "INVOICE_NOT_PAYABLE", processedAt: now })
          .where(eq(paymentWebhookEvents.id, whRow.id));
      }
      return { booked: false, alreadyPaid: false, reasonCode: "INVOICE_NOT_PAYABLE", attempt: locked };
    }

    const matchCheck = checkFetchedMatchesAttempt(locked, input.fetched);
    if (!matchCheck.matches) {
      if (input.source === "webhook" && whRow) {
        await tx
          .update(paymentAttempts)
          .set({
            status: "failed",
            failureReasonCode: matchCheck.reasonCode,
            lastReconciledAt: now,
            version: locked.version + 1,
            updatedAt: now,
          })
          .where(and(eq(paymentAttempts.id, locked.id), eq(paymentAttempts.version, locked.version)));

        await tx
          .update(paymentWebhookEvents)
          .set({
            status: "verification_mismatch",
            reasonCode: matchCheck.reasonCode,
            processedAt: now,
          })
          .where(eq(paymentWebhookEvents.id, whRow.id));

        await notifyOrderPaymentEventInTx(tx, {
          orderPublicId: locked.orderPublicId,
          orderId: currentInvoice.orderId,
          kind: "failed",
          eventRef: locked.publicId,
        });

        await deps.audit.record(
          {
            category: "business",
            eventName: "payments.attempt.failed",
            action: "verify",
            outcome: "failed",
            severity: "WARN",
            reasonCode: matchCheck.reasonCode,
            actor: { role: "system" },
            resource: { type: "payment_attempt", publicId: locked.publicId },
            orderPublicId: locked.orderPublicId,
            attributes: {
              order_public_id: locked.orderPublicId,
              invoice_public_id: locked.invoicePublicId,
              provider: locked.provider,
              reason_code: matchCheck.reasonCode,
              payment_state: "failed",
            },
          },
          tx,
        );
      } else {
        // Provider lookup mismatch: refuse to book, keep attempt pending (never mark invoice paid or destroy a valid session),
        // record clear diagnostic note, audit, and emit ops alert.
        await tx
          .update(paymentAttempts)
          .set({
            reconciliationNote: `lookup_mismatch:${matchCheck.reasonCode}`.slice(0, 120),
            failureReasonCode: matchCheck.reasonCode,
            lastReconciledAt: now,
            updatedAt: now,
          })
          .where(eq(paymentAttempts.id, locked.id));
      }

      await deps.audit.record(
        {
          category: "security",
          eventName: "payments.verification.mismatch",
          action: "verify",
          outcome: "refused",
          severity: "ERROR",
          reasonCode: matchCheck.reasonCode,
          actor: auditActor,
          resource: { type: "payment_attempt", publicId: locked.publicId },
          orderPublicId: locked.orderPublicId,
          attributes: {
            order_public_id: locked.orderPublicId,
            invoice_public_id: locked.invoicePublicId,
            provider: locked.provider,
            booking_source: input.source,
            expected_amount_minor: locked.amountMinor,
            fetched_amount_minor: input.fetched.amountMinor,
            expected_currency: locked.currency,
            fetched_currency: input.fetched.currency,
          },
        },
        tx,
      );

      await emitPaymentOpsAlert(
        {
          dedupKey: `verification-mismatch:${locked.publicId}`,
          severity: "error",
          code: matchCheck.reasonCode,
          title: "Payment verification mismatch held booking",
          text: "Upstream payment details did not match the expected invoice amount, currency, mode, or metadata.",
          orderPublicId: locked.orderPublicId,
        },
        tx,
      );
      return { booked: false, alreadyPaid: false, reasonCode: matchCheck.reasonCode, attempt: locked };
    }

    const paidAt = input.fetched.paidAt ?? now;
    const providerPaymentRef =
      input.fetched.providerPaymentRef ?? input.fetched.providerRef ?? locked.providerRef ?? locked.publicId;
    const cleanBrand = sanitizeCardBrand(input.fetched.paymentMethodBrand);
    const cleanLast4 = sanitizeCardLast4(input.fetched.paymentMethodLast4);

    let compliancePaymentPublicId: string | null = null;
    if (locked.amountMinor === 0 && typeof complianceSvc.settleCheckoutInvoiceInTx === "function") {
      await complianceSvc.settleCheckoutInvoiceInTx(
        { settlementKind: "zero_total", invoicePublicId: locked.invoicePublicId },
        tx,
      );
    } else {
      const booking = await complianceSvc.bookVerifiedProviderPayment(
        {
          invoicePublicId: locked.invoicePublicId,
          provider: locked.provider,
          environment: locked.environment,
          attemptPublicId: locked.publicId,
          providerPaymentRef,
          amountMinor: locked.amountMinor,
          currency: locked.currency,
          paidAt,
          idempotencyKey: `pmt-attempt:${locked.publicId}`,
          paymentMethodBrand: cleanBrand,
          paymentMethodLast4: cleanLast4,
        },
        tx,
      );
      compliancePaymentPublicId = booking.paymentPublicId;
    }

    const effectiveWebhookEventId =
      whRow ? (locked.verifiedWebhookEventId ?? whRow.externalEventId) : locked.verifiedWebhookEventId;

    await tx
      .update(paymentAttempts)
      .set({
        status: "paid",
        bookingSource: input.source,
        verifiedWebhookEventId: effectiveWebhookEventId,
        providerPaymentRef,
        compliancePaymentPublicId,
        paymentMethodBrand: cleanBrand,
        paymentMethodLast4: cleanLast4,
        reconciliationNote: null,
        failureReasonCode: null,
        paidAt,
        lastReconciledAt: now,
        version: locked.version + 1,
        updatedAt: now,
      })
      .where(and(eq(paymentAttempts.id, locked.id), eq(paymentAttempts.version, locked.version)));

    if (whRow) {
      await tx
        .update(paymentWebhookEvents)
        .set({
          status: "processed",
          providerPaymentRef,
          reasonCode: "BOOKED",
          processedAt: now,
        })
        .where(eq(paymentWebhookEvents.id, whRow.id));
    }

    await resolvePaymentOpsAlert(`webhook-verify:${locked.publicId}`, tx);
    await resolvePaymentOpsAlert(`verification-mismatch:${locked.publicId}`, tx);
    if (isTrashCancelledOrTrashedOrder) {
      await emitPaidOnCancelledAttemptAlertInTx(tx, locked, auditActor);
    } else {
      await resolvePaymentOpsAlert(`paid-cancelled-attempt:${locked.publicId}`, tx);
    }

    await deps.audit.record(
      {
        category: "business",
        eventName: "payments.attempt.paid",
        action: "transition",
        outcome: "completed",
        actor: auditActor,
        resource: { type: "payment_attempt", publicId: locked.publicId },
        orderPublicId: locked.orderPublicId,
        attributes: {
          invoice_public_id: locked.invoicePublicId,
          order_public_id: locked.orderPublicId,
          compliance_payment_public_id: compliancePaymentPublicId,
          provider: locked.provider,
          environment: locked.environment,
          amount_minor: locked.amountMinor,
          currency: locked.currency,
          booking_source: input.source,
          verified_webhook_event_id: effectiveWebhookEventId,
          payment_state: "paid",
        },
      },
      tx,
    );

    const updatedAttempt: PaymentAttemptRow = {
      ...locked,
      status: "paid",
      bookingSource: input.source,
      verifiedWebhookEventId: effectiveWebhookEventId,
      providerPaymentRef,
      compliancePaymentPublicId,
      paymentMethodBrand: cleanBrand,
      paymentMethodLast4: cleanLast4,
      reconciliationNote: null,
      failureReasonCode: null,
      paidAt,
      lastReconciledAt: now,
      version: locked.version + 1,
      updatedAt: now,
    };

    return { booked: true, alreadyPaid: false, reasonCode: "BOOKED", attempt: updatedAttempt };
  }

  async function finalizeVerifiedPaidAttemptInTx(
    tx: Tx,
    input: {
      attemptId: number;
      webhookRowId: number;
      fetched: ProviderFetchedPayment;
    },
  ): Promise<{ booked: boolean; reasonCode: string }> {
    const res = await bookAuthoritativeAttemptPaymentInTx(tx, {
      attemptId: input.attemptId,
      source: "webhook",
      webhookRowId: input.webhookRowId,
      fetched: input.fetched,
    });
    return { booked: res.booked, reasonCode: res.reasonCode };
  }

  async function readOrderReferenceSafe(orderId: number): Promise<string | null> {
    const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
    if (!ordersSvc || typeof ordersSvc.getOrderRefById !== "function") return null;
    try {
      const ref = await ordersSvc.getOrderRefById(orderId);
      return ref?.reference ?? null;
    } catch {
      return null;
    }
  }

  function buildConfirmViewFromInvoiceAndAttempt(
    invoice: {
      invoicePublicId: string;
      invoiceNumber: string | null;
      status: "draft" | "issued" | "paid" | "void";
      receiptPublicId?: string | null | undefined;
    },
    attempt: PaymentAttemptRow,
    opts?: {
      orderReference?: string | null | undefined;
      bookedNow?: boolean | undefined;
      cooldownRemainingMs?: number | undefined;
      forceState?: CustomerPaymentConfirmationState | undefined;
    },
  ): ConfirmCheckoutPaymentResult {
    const isPaid = invoice.status === "paid" || attempt.status === "paid";
    let state: CustomerPaymentConfirmationState;
    if (opts?.forceState && !isPaid) {
      state = opts.forceState;
    } else if (isPaid) {
      state = "paid";
    } else if (
      attempt.status === "cancelled" ||
      attempt.status === "expired" ||
      attempt.status === "failed" ||
      invoice.status === "void"
    ) {
      state = "unpaid";
    } else {
      state = "processing";
    }

    return {
      attemptPublicId: attempt.publicId,
      orderPublicId: attempt.orderPublicId,
      orderReference: opts?.orderReference ?? null,
      invoicePublicId: invoice.invoicePublicId,
      invoiceNumber: invoice.invoiceNumber ?? null,
      invoiceStatus: isPaid ? "paid" : invoice.status,
      receiptPublicId: invoice.receiptPublicId ?? null,
      cartPublicId: attempt.cartPublicId,
      provider: attempt.provider,
      environment: attempt.environment,
      attemptStatus: isPaid ? "paid" : attempt.status,
      state,
      bookedNow: opts?.bookedNow ?? false,
      bookingSource: attempt.bookingSource,
      paidAt: attempt.paidAt ? attempt.paidAt.toISOString() : null,
      cooldownRemainingMs: Math.max(0, opts?.cooldownRemainingMs ?? 0),
    };
  }

  /**
   * Increment 08 D5 customer payment confirmation (`payments.confirmCheckoutPayment`):
   * Accepts ONLY `{ attemptPublicId }` from an authenticated customer session, verifies live customer role
   * and resource ownership against both `payment_attempts` and `compliance.getInvoiceForCheckout`
   * (returning identical `PAYMENT_ATTEMPT_NOT_FOUND` for another customer's attempt), enforces a per-attempt
   * lookup cooldown, queries Stripe authoritatively by the stored `providerRef`, re-verifies live actor,
   * ownership, attempt identity, and Stripe config/key digest in the post-egress transaction, and books
   * via `bookAuthoritativeAttemptPaymentInTx` when paid & strictly matched.
   */
  const cancelledCustomerLookupCooldownMs = new Map<number, number>();

  async function confirmCheckoutPayment(
    principal: SessionPrincipal,
    input: { attemptPublicId: string },
    opts?: { signal?: AbortSignal | undefined; beforeSend?: (() => Promise<void>) | undefined },
  ): Promise<ConfirmCheckoutPaymentResult> {
    const complianceSvc = requireComplianceService();
    if (principal.role !== "customer") {
      throw forbidden("CUSTOMER_ONLY");
    }

    // Stage owner-scoped candidate BEFORE opening any locking transaction so another customer's
    // or a reassigned order's attempt never acquires a foreign row lock (`FOR UPDATE`).
    const [candidate] = await deps.db
      .select({
        id: paymentAttempts.id,
        publicId: paymentAttempts.publicId,
        invoiceId: paymentAttempts.invoiceId,
        invoicePublicId: paymentAttempts.invoicePublicId,
        orderPublicId: paymentAttempts.orderPublicId,
        customerUserId: paymentAttempts.customerUserId,
      })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.publicId, input.attemptPublicId),
          eq(paymentAttempts.customerUserId, principal.userId),
        ),
      )
      .limit(1);

    if (!candidate) {
      throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
    }

    const ordersSvc = deps.services.orders?.orders;
    if (ordersSvc && typeof ordersSvc.getOrderRefByPublicId === "function") {
      const preOrder = await ordersSvc.getOrderRefByPublicId(candidate.orderPublicId);
      if (!preOrder || preOrder.ownerUserId !== principal.userId) {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }
    }

    // Canonical lock hierarchy inside tx:
    // 1. `orders` FOR UPDATE -> `compliance_invoices` FOR UPDATE -> current ledger sums (`getInvoiceForCheckout(..., { forUpdate: true })`)
    // 2. `users` FOR UPDATE (`assertLiveActorInTx`) + verify current owner
    // 3. `payment_attempts` FOR UPDATE by primary key
    const loadOwnedCustomerAttemptInTx = async (tx: Tx) => {
      let invoice: Awaited<ReturnType<typeof complianceSvc.getInvoiceForCheckout>>;
      try {
        invoice = await complianceSvc.getInvoiceForCheckout(candidate.invoicePublicId, {
          principal,
          tx,
          forUpdate: true,
        });
        if (await isOrderTrashedInTx(tx, invoice.orderId)) {
          throw notFound("INVOICE_NOT_FOUND");
        }
      } catch (err) {
        if (err instanceof DomainError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) {
          throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
        }
        throw err;
      }

      if (invoice.ownerUserId !== principal.userId) {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }

      const liveActor = await assertLiveActorInTx(deps, principal, tx);
      if (liveActor.role !== "customer") {
        throw forbidden("CUSTOMER_ONLY");
      }
      if (invoice.ownerUserId !== liveActor.userId) {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }
      const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };

      const [attempt] = await tx
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, candidate.id))
        .for("update")
        .limit(1);

      if (
        !attempt ||
        attempt.publicId !== input.attemptPublicId ||
        attempt.customerUserId !== liveActor.userId ||
        attempt.invoiceId !== invoice.invoiceId ||
        attempt.orderPublicId !== invoice.orderPublicId
      ) {
        throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
      }

      return { liveActor, livePrincipal, attempt, invoice };
    };

    const staged = await runWithMysqlDeadlockRetry(() =>
      runComplianceTx(
        deps,
        principal,
        { type: "payment_attempt", publicId: input.attemptPublicId },
        async (tx) => {
          const { liveActor, livePrincipal, attempt, invoice } = await loadOwnedCustomerAttemptInTx(tx);

          if (
            invoice.status === "paid" ||
            attempt.status === "paid" ||
            attempt.status === "expired" ||
            attempt.status === "failed" ||
            invoice.status === "void" ||
            attempt.provider !== "stripe" ||
            !attempt.providerRef
          ) {
            return {
              kind: "immediate" as const,
              invoice,
              attempt,
              cooldownRemainingMs: 0,
            };
          }

          const now = deps.clock.now();
          if (attempt.status === "cancelled") {
            const lastCancelledCheckMs = cancelledCustomerLookupCooldownMs.get(attempt.id);
            if (lastCancelledCheckMs !== undefined) {
              const elapsedMs = now.getTime() - lastCancelledCheckMs;
              if (elapsedMs >= 0 && elapsedMs < CUSTOMER_CONFIRM_COOLDOWN_MS) {
                return {
                  kind: "immediate" as const,
                  invoice,
                  attempt,
                  cooldownRemainingMs: CUSTOMER_CONFIRM_COOLDOWN_MS - elapsedMs,
                };
              }
            }
          } else if (attempt.lastCustomerLookupAt) {
            const elapsedMs = now.getTime() - attempt.lastCustomerLookupAt.getTime();
            if (elapsedMs >= 0 && elapsedMs < CUSTOMER_CONFIRM_COOLDOWN_MS) {
              return {
                kind: "immediate" as const,
                invoice,
                attempt,
                cooldownRemainingMs: CUSTOMER_CONFIRM_COOLDOWN_MS - elapsedMs,
              };
            }
          }

          let loadedCreds: { credentials: ProviderCredentials; keyDigest: string };
          try {
            loadedCreds = await loadStripeLookupCredentials(attempt.environment, { tx });
          } catch {
            return {
              kind: "immediate" as const,
              invoice,
              attempt,
              cooldownRemainingMs: 0,
            };
          }

          if (attempt.status === "cancelled") {
            if (cancelledCustomerLookupCooldownMs.size > 2_000) {
              cancelledCustomerLookupCooldownMs.clear();
            }
            cancelledCustomerLookupCooldownMs.set(attempt.id, now.getTime());
            return {
              kind: "lookup" as const,
              attempt,
              invoice,
              credentials: loadedCreds.credentials,
              keyDigest: loadedCreds.keyDigest,
              liveActor,
              livePrincipal,
            };
          }

          await tx
            .update(paymentAttempts)
            .set({
              lastCustomerLookupAt: now,
              updatedAt: now,
            })
            .where(eq(paymentAttempts.id, attempt.id));

          return {
            kind: "lookup" as const,
            attempt: { ...attempt, lastCustomerLookupAt: now },
            invoice,
            credentials: loadedCreds.credentials,
            keyDigest: loadedCreds.keyDigest,
            liveActor,
            livePrincipal,
          };
        },
      ),
    );

    const orderReference = await readOrderReferenceSafe(staged.invoice.orderId);

    if (staged.kind === "immediate") {
      return buildConfirmViewFromInvoiceAndAttempt(staged.invoice, staged.attempt, {
        orderReference,
        bookedNow: false,
        cooldownRemainingMs: staged.cooldownRemainingMs,
      });
    }

    let fetched: ProviderFetchedPayment;
    try {
      fetched = await adapters.stripe.fetchPayment({
        providerRef: staged.attempt.providerRef!,
        providerOrderRef: staged.attempt.providerOrderRef,
        providerPaymentRef: staged.attempt.providerPaymentRef,
        credentials: staged.credentials,
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(opts?.beforeSend ? { beforeSend: opts.beforeSend } : {}),
      });
    } catch {
      return buildConfirmViewFromInvoiceAndAttempt(staged.invoice, staged.attempt, {
        orderReference,
        bookedNow: false,
        forceState: "processing",
      });
    }

    return runWithMysqlDeadlockRetry(() =>
      runComplianceTx(
        deps,
        principal,
        { type: "payment_attempt", publicId: staged.attempt.publicId },
        async (tx) => {
          const { liveActor, livePrincipal, attempt: locked, invoice } = await loadOwnedCustomerAttemptInTx(tx);

          if (
            locked.provider !== "stripe" ||
            locked.providerRef !== staged.attempt.providerRef ||
            locked.environment !== staged.attempt.environment
          ) {
            throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
          }

          if (invoice.status === "paid" || locked.status === "paid") {
            return buildConfirmViewFromInvoiceAndAttempt(invoice, locked, {
              orderReference,
              bookedNow: false,
            });
          }

          if (invoice.status === "void" || invoice.voidedAt !== null) {
            return buildConfirmViewFromInvoiceAndAttempt(invoice, locked, {
              orderReference,
              bookedNow: false,
            });
          }

          let postCreds: { credentials: ProviderCredentials; keyDigest: string };
          try {
            postCreds = await loadStripeLookupCredentials(locked.environment, { tx });
          } catch {
            return buildConfirmViewFromInvoiceAndAttempt(invoice, locked, {
              orderReference,
              bookedNow: false,
              ...(locked.status === "created" || locked.status === "redirected"
                ? { forceState: "processing" as const }
                : {}),
            });
          }
          if (postCreds.keyDigest !== staged.keyDigest) {
            return buildConfirmViewFromInvoiceAndAttempt(invoice, locked, {
              orderReference,
              bookedNow: false,
              ...(locked.status === "created" || locked.status === "redirected"
                ? { forceState: "processing" as const }
                : {}),
            });
          }

          // Terminal non-active attempt guard BEFORE mismatch/async/status mutation:
          // Never mutate `payment_attempts`, `compliance_invoices`, or `orders` on the customer path
          // when `locked.status` is not `created | redirected`. If a `cancelled` attempt was genuinely
          // paid on Stripe (e.g. customer cancelled in one tab and paid in another), surface a
          // deduplicated ops alert so an administrator can repair it via step-up "Check with Stripe now".
          if (locked.status !== "created" && locked.status !== "redirected") {
            if (
              locked.status === "cancelled" &&
              invoice.status === "issued" &&
              fetched.status === "paid" &&
              checkFetchedMatchesAttempt(locked, fetched).matches
            ) {
              await emitPaidOnCancelledAttemptAlertInTx(tx, locked, {
                userId: liveActor.userId,
                role: liveActor.role,
              });
            }
            return buildConfirmViewFromInvoiceAndAttempt(invoice, locked, {
              orderReference,
              bookedNow: false,
            });
          }

          if (fetched.status === "paid") {
            const booked = await bookAuthoritativeAttemptPaymentInTx(tx, {
              attemptId: locked.id,
              source: "provider_lookup",
              fetched,
              actor: { userId: liveActor.userId, role: liveActor.role },
            });
            const refreshedInvoice = await complianceSvc.getInvoiceForCheckout(locked.invoicePublicId, {
              principal: livePrincipal,
              tx,
              forUpdate: true,
            });
            const currentAttempt = booked.attempt ?? locked;
            return buildConfirmViewFromInvoiceAndAttempt(refreshedInvoice, currentAttempt, {
              orderReference,
              bookedNow: booked.booked && !booked.alreadyPaid,
              ...(booked.booked ? {} : { forceState: "processing" as const }),
            });
          }

        const bindingCheck = checkFetchedBindingMatchesAttempt(locked, fetched);
        if (!bindingCheck.matches) {
          await recordLookupMismatchInTx(tx, locked, fetched, bindingCheck.reasonCode, {
            userId: liveActor.userId,
            role: liveActor.role,
          });
          return buildConfirmViewFromInvoiceAndAttempt(invoice, locked, {
            orderReference,
            bookedNow: false,
            forceState: "processing",
          });
        }

        const now = deps.clock.now();
        if (fetched.asyncPending) {
          const wasAlreadyAsync = locked.reconciliationNote === "awaiting_async_settlement";
          await tx
            .update(paymentAttempts)
            .set({
              reconciliationNote: "awaiting_async_settlement",
              lastReconciledAt: now,
              updatedAt: now,
            })
            .where(eq(paymentAttempts.id, locked.id));

          if (!wasAlreadyAsync) {
            await notifyOrderPaymentEventInTx(tx, {
              orderPublicId: locked.orderPublicId,
              kind: "pending_async",
              eventRef: locked.publicId,
            });
            await deps.audit.record(
              {
                category: "business",
                eventName: "payments.attempt.pending_async",
                action: "transition",
                outcome: "completed",
                actor: { userId: liveActor.userId, role: liveActor.role },
                resource: { type: "payment_attempt", publicId: locked.publicId },
                orderPublicId: locked.orderPublicId,
                attributes: {
                  order_public_id: locked.orderPublicId,
                  invoice_public_id: locked.invoicePublicId,
                  provider: locked.provider,
                  payment_state: "pending_async",
                },
              },
              tx,
            );
          }

          return buildConfirmViewFromInvoiceAndAttempt(
            invoice,
            { ...locked, reconciliationNote: "awaiting_async_settlement", lastReconciledAt: now },
            { orderReference, bookedNow: false, forceState: "processing" },
          );
        }

        if (fetched.status === "expired") {
          if (locked.status === "redirected" || locked.status === "created") {
            await tx
              .update(paymentAttempts)
              .set({
                status: "expired",
                lastReconciledAt: now,
                version: locked.version + 1,
                updatedAt: now,
              })
              .where(and(eq(paymentAttempts.id, locked.id), eq(paymentAttempts.version, locked.version)));
            return buildConfirmViewFromInvoiceAndAttempt(
              invoice,
              { ...locked, status: "expired", lastReconciledAt: now, version: locked.version + 1 },
              { orderReference, bookedNow: false, forceState: "unpaid" },
            );
          }
          return buildConfirmViewFromInvoiceAndAttempt(invoice, locked, {
            orderReference,
            bookedNow: false,
            forceState: "unpaid",
          });
        }

        return buildConfirmViewFromInvoiceAndAttempt(invoice, locked, {
          orderReference,
          bookedNow: false,
          forceState: "processing",
        });
      },
    ),
    );
  }

  async function findAttemptForWebhookInTx(
    tx: Tx,
    provider: ActivePaymentProvider,
    environment: PaymentEnvironmentMode,
    refs: {
      attemptPublicId: string | null;
      providerRef: string | null;
      providerOrderRef: string | null;
      providerPaymentRef?: string | null;
    },
  ): Promise<PaymentAttemptRow | null> {
    if (refs.attemptPublicId) {
      const [byAttempt] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.publicId, refs.attemptPublicId),
            eq(paymentAttempts.provider, provider),
            eq(paymentAttempts.environment, environment),
          ),
        )
        .for("update")
        .limit(1);
      if (byAttempt) return byAttempt;
    }
    if (refs.providerRef) {
      const [byRef] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.provider, provider),
            eq(paymentAttempts.environment, environment),
            eq(paymentAttempts.providerRef, refs.providerRef),
          ),
        )
        .for("update")
        .limit(1);
      if (byRef) return byRef;
    }
    if (refs.providerOrderRef) {
      const [byOrder] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.provider, provider),
            eq(paymentAttempts.environment, environment),
            eq(paymentAttempts.providerOrderRef, refs.providerOrderRef),
          ),
        )
        .for("update")
        .limit(1);
      if (byOrder) return byOrder;
    }
    if (refs.providerPaymentRef) {
      const [byPayment] = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.provider, provider),
            eq(paymentAttempts.environment, environment),
            eq(paymentAttempts.providerPaymentRef, refs.providerPaymentRef),
          ),
        )
        .for("update")
        .limit(1);
      if (byPayment) return byPayment;
    }
    return null;
  }

  async function handleSignedWebhook(input: {
    provider: ActivePaymentProvider;
    rawBody: Buffer;
    headers: Readonly<Record<string, string | undefined>>;
    notificationUrl: string;
  }): Promise<PaymentWebhookResult> {
    const now = deps.clock.now();
    const config = await loadConfig();

    let credentials: ProviderCredentials;
    let webhookSecret: string;
    try {
      const loaded = await loadProviderCredentials(input.provider, config);
      credentials = loaded.credentials;
      webhookSecret = loaded.webhookSecret;
    } catch {
      await recordWebhookRejection({
        provider: input.provider,
        environmentHint: config.mode,
        reasonCode: "WEBHOOK_NOT_CONFIGURED",
        httpStatus: 503,
        receivedAt: now,
      });
      await deps.audit.record({
        category: "integration",
        eventName: "payments.webhook.rejected",
        action: "receive",
        outcome: "refused",
        severity: "WARN",
        reasonCode: "WEBHOOK_NOT_CONFIGURED",
        actor: { role: "system" },
        attributes: { provider: input.provider },
      });
      return {
        httpStatus: 503,
        accepted: false,
        duplicate: false,
        booked: false,
        reasonCode: "WEBHOOK_NOT_CONFIGURED",
      };
    }

    const secondaryWebhookSecret =
      input.provider === "stripe"
        ? await readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET_SECONDARY)
        : null;

    const adapter = adapters[input.provider];
    const verified = adapter.verifyWebhook({
      rawBody: input.rawBody,
      headers: input.headers,
      webhookSecret,
      secondaryWebhookSecret,
      notificationUrl: input.notificationUrl,
      now,
      toleranceSeconds: config.webhookToleranceSeconds,
    });

    if (!verified.ok) {
      await recordWebhookRejection({
        provider: input.provider,
        environmentHint: verified.environmentHint ?? "unknown",
        reasonCode: verified.reasonCode,
        httpStatus: 400,
        skewSeconds: verified.skewSeconds ?? null,
        receivedAt: now,
      });
      await deps.audit.record({
        category: "security",
        eventName: "payments.webhook.rejected",
        action: "verify",
        outcome: "denied",
        severity: "WARN",
        reasonCode: verified.reasonCode,
        actor: { role: "system" },
        attributes: { provider: input.provider },
      });
      return {
        httpStatus: 400,
        accepted: false,
        duplicate: false,
        booked: false,
        reasonCode: verified.reasonCode,
      };
    }

    const eventEnv: PaymentEnvironmentMode = verified.livemode ? "live" : "test";
    if (eventEnv !== config.mode) {
      await recordWebhookRejection({
        provider: input.provider,
        environmentHint: eventEnv,
        reasonCode: "WEBHOOK_MODE_MISMATCH",
        httpStatus: 400,
        skewSeconds: Math.round(Math.abs(now.getTime() - verified.occurredAt.getTime()) / 1000),
        receivedAt: now,
      });
      await deps.audit.record({
        category: "security",
        eventName: "payments.webhook.rejected",
        action: "verify",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "WEBHOOK_MODE_MISMATCH",
        actor: { role: "system" },
        attributes: {
          provider: input.provider,
          webhook_mode: eventEnv,
          configured_mode: config.mode,
        },
      });
      return {
        httpStatus: 400,
        accepted: false,
        duplicate: false,
        booked: false,
        reasonCode: "WEBHOOK_MODE_MISMATCH",
      };
    }

    const payloadSha256 = createHash("sha256").update(input.rawBody).digest("hex");

    const staged = await deps.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(paymentWebhookEvents)
        .where(
          and(
            eq(paymentWebhookEvents.provider, input.provider),
            eq(paymentWebhookEvents.externalEventId, verified.externalEventId),
          ),
        )
        .for("update")
        .limit(1);

      if (existing) {
        if (existing.payloadSha256 !== payloadSha256) {
          return { kind: "tamper_conflict" as const };
        }
        if (existing.status !== "retry_pending") {
          return {
            kind: "duplicate_done" as const,
            booked:
              existing.status === "processed" &&
              (existing.reasonCode === "BOOKED" || existing.reasonCode === "REFUND_SUCCEEDED"),
          };
        }
      }

      const webhookPublicId = existing?.publicId ?? ulid(now.getTime());

      if (verified.outcomeHint === "self_test") {
        if (existing) {
          await tx
            .update(paymentWebhookEvents)
            .set({
              status: "processed",
              reasonCode: "SELF_TEST_OK",
              processedAt: now,
            })
            .where(eq(paymentWebhookEvents.id, existing.id));
        } else {
          await tx.insert(paymentWebhookEvents).values({
            publicId: webhookPublicId,
            provider: input.provider,
            environment: eventEnv,
            externalEventId: verified.externalEventId,
            eventType: verified.eventType,
            payloadSha256,
            status: "processed",
            reasonCode: "SELF_TEST_OK",
            occurredAt: verified.occurredAt,
            receivedAt: now,
            processedAt: now,
          });
        }
        return { kind: "self_test_ok" as const, duplicate: Boolean(existing) };
      }

      if (verified.outcomeHint === "refund_updated") {
        const refundRow = await findRefundForWebhookInTx(tx, input.provider, eventEnv, verified);
        if (!refundRow) {
          const portalRefundRows = verified.providerPaymentRef
            ? await tx
                .select()
                .from(paymentRefunds)
                .where(
                  and(
                    eq(paymentRefunds.provider, input.provider),
                    eq(paymentRefunds.environment, eventEnv),
                    eq(paymentRefunds.providerPaymentRef, verified.providerPaymentRef),
                  ),
                )
            : [];
          const matchedAttempt = await findAttemptForWebhookInTx(tx, input.provider, eventEnv, {
            attemptPublicId: verified.attemptPublicId,
            providerRef: verified.providerRef,
            providerOrderRef: verified.providerOrderRef,
            providerPaymentRef: verified.providerPaymentRef,
          });

          if (
            !verified.providerRefundRef &&
            verified.providerPaymentRef &&
            (portalRefundRows.length > 0 || matchedAttempt) &&
            typeof refundAdapters[input.provider].listPaymentRefunds === "function"
          ) {
            let webhookRowId: number;
            if (existing) {
              webhookRowId = existing.id;
            } else {
              const [ins] = await tx.insert(paymentWebhookEvents).values({
                publicId: webhookPublicId,
                provider: input.provider,
                environment: eventEnv,
                externalEventId: verified.externalEventId,
                eventType: verified.eventType,
                payloadSha256,
                attemptId: matchedAttempt?.id ?? portalRefundRows[0]?.attemptId ?? null,
                attemptPublicId: matchedAttempt?.publicId ?? null,
                refundId: null,
                refundPublicId: verified.refundPublicIdHint ?? null,
                providerRef: verified.providerRef,
                providerOrderRef: verified.providerOrderRef,
                providerPaymentRef: verified.providerPaymentRef,
                providerRefundRef: verified.providerRefundRef ?? null,
                status: "retry_pending",
                reasonCode: "AWAITING_REFUND_LIST_VERIFICATION",
                occurredAt: verified.occurredAt,
                receivedAt: now,
              });
              webhookRowId = ins.insertId;
            }
            return {
              kind: "verify_refund_list" as const,
              webhookRowId,
              providerPaymentRef: verified.providerPaymentRef,
              matchedAttempt,
              fallbackOrderPublicId:
                matchedAttempt?.orderPublicId ?? portalRefundRows[0]?.orderPublicId ?? null,
              fallbackInvoicePublicId:
                matchedAttempt?.invoicePublicId ?? portalRefundRows[0]?.invoicePublicId ?? null,
              attemptCount: existing?.attemptCount ?? 0,
              duplicate: Boolean(existing),
            };
          }

          if (matchedAttempt && !verified.refundPublicIdHint) {
            const unlinkedRef = verified.providerRefundRef ?? verified.externalEventId;
            if (existing) {
              await tx
                .update(paymentWebhookEvents)
                .set({
                  status: "attention_required",
                  reasonCode: "UNLINKED_PROVIDER_REFUND",
                  lastErrorCode: "UNLINKED_PROVIDER_REFUND",
                  attemptId: matchedAttempt.id,
                  attemptPublicId: matchedAttempt.publicId,
                  providerRefundRef: verified.providerRefundRef ?? existing.providerRefundRef,
                  processedAt: now,
                })
                .where(eq(paymentWebhookEvents.id, existing.id));
            } else {
              await tx.insert(paymentWebhookEvents).values({
                publicId: webhookPublicId,
                provider: input.provider,
                environment: eventEnv,
                externalEventId: verified.externalEventId,
                eventType: verified.eventType,
                payloadSha256,
                attemptId: matchedAttempt.id,
                attemptPublicId: matchedAttempt.publicId,
                refundId: null,
                refundPublicId: null,
                providerRef: verified.providerRef,
                providerOrderRef: verified.providerOrderRef,
                providerPaymentRef: verified.providerPaymentRef,
                providerRefundRef: verified.providerRefundRef ?? null,
                status: "attention_required",
                reasonCode: "UNLINKED_PROVIDER_REFUND",
                lastErrorCode: "UNLINKED_PROVIDER_REFUND",
                occurredAt: verified.occurredAt,
                receivedAt: now,
                processedAt: now,
              });
            }

            await deps.audit.record(
              {
                category: "security",
                eventName: "payment.refund.flagged",
                action: "verify",
                outcome: "denied",
                severity: "WARN",
                reasonCode: "UNLINKED_PROVIDER_REFUND",
                actor: { role: "system" },
                resource: { type: "payment_attempt", publicId: matchedAttempt.publicId },
                orderPublicId: matchedAttempt.orderPublicId,
                attributes: {
                  order_public_id: matchedAttempt.orderPublicId,
                  invoice_public_id: matchedAttempt.invoicePublicId,
                  provider: input.provider,
                  external_event_id: verified.externalEventId,
                  reason_code: "UNLINKED_PROVIDER_REFUND",
                },
              },
              tx,
            );

            const refundHash = createHash("sha256")
              .update(`${input.provider}:${unlinkedRef}`)
              .digest("hex")
              .slice(0, 24);
            await emitPaymentOpsAlert(
              {
                dedupKey: `unlinked-refund:${input.provider}:${refundHash}`,
                severity: "warning",
                code: "UNLINKED_PROVIDER_REFUND",
                title: "Refund made outside portal requires review",
                text: "A provider refund without portal metadata was detected on a paid order and held from automatic ledger booking.",
                orderPublicId: matchedAttempt.orderPublicId,
              },
              tx,
            );
            return { kind: "unlinked_refund" as const, duplicate: Boolean(existing) };
          }

          if (existing) {
            await tx
              .update(paymentWebhookEvents)
              .set({
                status: "ignored",
                reasonCode: "REFUND_NOT_FOUND",
                providerRefundRef: verified.providerRefundRef ?? existing.providerRefundRef,
                processedAt: now,
              })
              .where(eq(paymentWebhookEvents.id, existing.id));
          } else {
            await tx.insert(paymentWebhookEvents).values({
              publicId: webhookPublicId,
              provider: input.provider,
              environment: eventEnv,
              externalEventId: verified.externalEventId,
              eventType: verified.eventType,
              payloadSha256,
              attemptId: null,
              attemptPublicId: verified.attemptPublicId,
              refundId: null,
              refundPublicId: verified.refundPublicIdHint ?? null,
              providerRef: verified.providerRef,
              providerOrderRef: verified.providerOrderRef,
              providerPaymentRef: verified.providerPaymentRef,
              providerRefundRef: verified.providerRefundRef ?? null,
              status: "ignored",
              reasonCode: "REFUND_NOT_FOUND",
              occurredAt: verified.occurredAt,
              receivedAt: now,
              processedAt: now,
            });
          }
          return { kind: "ignored" as const };
        }

        let webhookRowId: number;
        if (existing) {
          webhookRowId = existing.id;
        } else {
          const [ins] = await tx.insert(paymentWebhookEvents).values({
            publicId: webhookPublicId,
            provider: input.provider,
            environment: eventEnv,
            externalEventId: verified.externalEventId,
            eventType: verified.eventType,
            payloadSha256,
            attemptId: refundRow.attemptId,
            attemptPublicId: null,
            refundId: refundRow.id,
            refundPublicId: refundRow.publicId,
            providerRef: verified.providerRef,
            providerOrderRef: verified.providerOrderRef,
            providerPaymentRef: refundRow.providerPaymentRef,
            providerRefundRef: verified.providerRefundRef ?? refundRow.providerRefundRef,
            status: "retry_pending",
            reasonCode: "AWAITING_REFUND_VERIFICATION",
            occurredAt: verified.occurredAt,
            receivedAt: now,
          });
          webhookRowId = ins.insertId;
        }

        return {
          kind: "verify_refund" as const,
          webhookRowId,
          refundRow,
          duplicate: Boolean(existing),
        };
      }

      const attempt = await findAttemptForWebhookInTx(tx, input.provider, config.mode, {
        attemptPublicId: verified.attemptPublicId,
        providerRef: verified.providerRef,
        providerOrderRef: verified.providerOrderRef,
        providerPaymentRef: verified.providerPaymentRef,
      });

      if (!attempt || verified.outcomeHint === "ignored") {
        if (!attempt && verified.outcomeHint !== "ignored" && verified.hasPortalMetadata) {
          if (existing) {
            await tx
              .update(paymentWebhookEvents)
              .set({
                status: "attention_required",
                reasonCode: "UNMATCHED_PORTAL_PAYMENT",
                lastErrorCode: "UNMATCHED_PORTAL_PAYMENT",
                attemptPublicId: verified.attemptPublicId ?? existing.attemptPublicId,
                providerRef: verified.providerRef ?? existing.providerRef,
                providerOrderRef: verified.providerOrderRef ?? existing.providerOrderRef,
                providerPaymentRef: verified.providerPaymentRef ?? existing.providerPaymentRef,
                processedAt: now,
              })
              .where(eq(paymentWebhookEvents.id, existing.id));
          } else {
            await tx.insert(paymentWebhookEvents).values({
              publicId: webhookPublicId,
              provider: input.provider,
              environment: eventEnv,
              externalEventId: verified.externalEventId,
              eventType: verified.eventType,
              payloadSha256,
              attemptId: null,
              attemptPublicId: verified.attemptPublicId,
              providerRef: verified.providerRef,
              providerOrderRef: verified.providerOrderRef,
              providerPaymentRef: verified.providerPaymentRef,
              status: "attention_required",
              reasonCode: "UNMATCHED_PORTAL_PAYMENT",
              lastErrorCode: "UNMATCHED_PORTAL_PAYMENT",
              occurredAt: verified.occurredAt,
              receivedAt: now,
              processedAt: now,
            });
          }

          await deps.audit.record(
            {
              category: "security",
              eventName: "payments.webhook.unmatched_portal_session",
              action: "verify",
              outcome: "denied",
              severity: "WARN",
              reasonCode: "UNMATCHED_PORTAL_PAYMENT",
              actor: { role: "system" },
              resource: {
                type: "payment_webhook",
                publicId: webhookPublicId,
              },
              ...(verified.orderPublicId ? { orderPublicId: verified.orderPublicId } : {}),
              attributes: {
                provider: input.provider,
                external_event_id: verified.externalEventId,
                event_type: verified.eventType,
                attempt_public_id: verified.attemptPublicId,
                invoice_public_id: verified.invoicePublicId,
                order_public_id: verified.orderPublicId ?? null,
                reason_code: "UNMATCHED_PORTAL_PAYMENT",
              },
            },
            tx,
          );

          const sessionRef = verified.providerRef ?? verified.externalEventId;
          const sessionHash = createHash("sha256")
            .update(`${input.provider}:${sessionRef}`)
            .digest("hex")
            .slice(0, 24);
          await emitPaymentOpsAlert(
            {
              dedupKey: `unmatched-portal-payment:${input.provider}:${sessionHash}`,
              severity: "warning",
              code: "UNMATCHED_PORTAL_PAYMENT",
              title: "Signed payment event with portal metadata could not be matched",
              text: "A verified payment webhook carried ReadyPackets metadata (attempt, invoice, or order ID) that did not match any portal payment attempt or invoice. Review before settling manually.",
              ...(verified.orderPublicId ? { orderPublicId: verified.orderPublicId } : {}),
            },
            tx,
          );
          return { kind: "unmatched_portal_payment" as const, duplicate: Boolean(existing) };
        }

        if (existing) {
          await tx
            .update(paymentWebhookEvents)
            .set({
              status: "ignored",
              reasonCode: attempt ? "UNHANDLED_EVENT_TYPE" : "ATTEMPT_NOT_FOUND",
              processedAt: now,
            })
            .where(eq(paymentWebhookEvents.id, existing.id));
        } else {
          await tx.insert(paymentWebhookEvents).values({
            publicId: webhookPublicId,
            provider: input.provider,
            environment: eventEnv,
            externalEventId: verified.externalEventId,
            eventType: verified.eventType,
            payloadSha256,
            attemptId: attempt?.id ?? null,
            attemptPublicId: attempt?.publicId ?? verified.attemptPublicId,
            providerRef: verified.providerRef,
            providerOrderRef: verified.providerOrderRef,
            providerPaymentRef: verified.providerPaymentRef,
            status: "ignored",
            reasonCode: attempt ? "UNHANDLED_EVENT_TYPE" : "ATTEMPT_NOT_FOUND",
            occurredAt: verified.occurredAt,
            receivedAt: now,
            processedAt: now,
          });
        }
        return { kind: "ignored" as const };
      }

      if (verified.outcomeHint === "expired" || verified.outcomeHint === "failed") {
        const nextStatus: PaymentAttemptStatus = verified.outcomeHint === "expired" ? "expired" : "failed";
        const currentInvoice = await loadLockedCurrentInvoiceOrNull(tx, attempt.invoicePublicId);
        const [lockedAttempt] = await tx
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, attempt.id))
          .for("update")
          .limit(1);

        const invoicePaid = currentInvoice?.status === "paid" || lockedAttempt?.status === "paid";
        const invoiceVoided =
          !currentInvoice || currentInvoice.status === "void" || currentInvoice.voidedAt !== null;
        if (
          !lockedAttempt ||
          invoicePaid ||
          invoiceVoided ||
          (lockedAttempt.status !== "created" && lockedAttempt.status !== "redirected")
        ) {
          const whStatus = invoicePaid ? "processed" : "ignored";
          const whReason = invoicePaid
            ? "ALREADY_PAID"
            : !currentInvoice
              ? "INVOICE_NOT_FOUND"
              : invoiceVoided
                ? "INVOICE_VOIDED"
                : "ATTEMPT_NOT_ACTIVE";
          if (existing) {
            await tx
              .update(paymentWebhookEvents)
              .set({ status: whStatus, reasonCode: whReason, processedAt: now })
              .where(eq(paymentWebhookEvents.id, existing.id));
          } else {
            await tx.insert(paymentWebhookEvents).values({
              publicId: webhookPublicId,
              provider: input.provider,
              environment: eventEnv,
              externalEventId: verified.externalEventId,
              eventType: verified.eventType,
              payloadSha256,
              attemptId: attempt.id,
              attemptPublicId: attempt.publicId,
              providerRef: attempt.providerRef ?? verified.providerRef,
              providerOrderRef: attempt.providerOrderRef ?? verified.providerOrderRef,
              providerPaymentRef: verified.providerPaymentRef,
              status: whStatus,
              reasonCode: whReason,
              occurredAt: verified.occurredAt,
              receivedAt: now,
              processedAt: now,
            });
          }
          return { kind: "terminal_non_paid" as const, reasonCode: whReason };
        }

        await tx
          .update(paymentAttempts)
          .set({
            status: nextStatus,
            failureReasonCode: verified.eventType.slice(0, 64),
            version: lockedAttempt.version + 1,
            updatedAt: now,
          })
          .where(and(eq(paymentAttempts.id, lockedAttempt.id), eq(paymentAttempts.version, lockedAttempt.version)));

        if (nextStatus === "failed") {
          await notifyOrderPaymentEventInTx(tx, {
            orderPublicId: lockedAttempt.orderPublicId,
            kind: "failed",
            eventRef: verified.externalEventId,
          });
        }

        if (existing) {
          await tx
            .update(paymentWebhookEvents)
            .set({ status: "processed", reasonCode: nextStatus.toUpperCase(), processedAt: now })
            .where(eq(paymentWebhookEvents.id, existing.id));
        } else {
          await tx.insert(paymentWebhookEvents).values({
            publicId: webhookPublicId,
            provider: input.provider,
            environment: eventEnv,
            externalEventId: verified.externalEventId,
            eventType: verified.eventType,
            payloadSha256,
            attemptId: lockedAttempt.id,
            attemptPublicId: lockedAttempt.publicId,
            providerRef: lockedAttempt.providerRef ?? verified.providerRef,
            providerOrderRef: lockedAttempt.providerOrderRef ?? verified.providerOrderRef,
            providerPaymentRef: verified.providerPaymentRef,
            status: "processed",
            reasonCode: nextStatus.toUpperCase(),
            occurredAt: verified.occurredAt,
            receivedAt: now,
            processedAt: now,
          });
        }

        await deps.audit.record(
          {
            category: "business",
            eventName: `payments.attempt.${nextStatus}`,
            action: "transition",
            outcome: nextStatus === "failed" ? "failed" : "completed",
            ...(nextStatus === "failed"
              ? { severity: "WARN" as const, reasonCode: verified.eventType.slice(0, 64) }
              : {}),
            actor: { role: "system" },
            resource: { type: "payment_attempt", publicId: lockedAttempt.publicId },
            orderPublicId: lockedAttempt.orderPublicId,
            attributes: {
              order_public_id: lockedAttempt.orderPublicId,
              invoice_public_id: lockedAttempt.invoicePublicId,
              provider: input.provider,
              external_event_id: verified.externalEventId,
              reason_code: verified.eventType.slice(0, 64),
              payment_state: nextStatus === "failed" ? "failed" : "unpaid",
            },
          },
          tx,
        );
        return { kind: "terminal_non_paid" as const, reasonCode: nextStatus.toUpperCase() };
      }

      // outcomeHint === "paid": record verified webhook receipt BEFORE calling provider fetchPayment outside tx!
      // Preserve an existing `verifiedWebhookEventId` when the attempt is already paid so a second event never clobbers the original receipt.
      await tx
        .update(paymentAttempts)
        .set({
          verifiedWebhookEventId:
            attempt.status === "paid"
              ? (attempt.verifiedWebhookEventId ?? verified.externalEventId)
              : verified.externalEventId,
          providerPaymentRef: attempt.providerPaymentRef ?? verified.providerPaymentRef,
          updatedAt: now,
        })
        .where(eq(paymentAttempts.id, attempt.id));

      let webhookRowId: number;
      if (existing) {
        webhookRowId = existing.id;
      } else {
        const [ins] = await tx.insert(paymentWebhookEvents).values({
          publicId: webhookPublicId,
          provider: input.provider,
          environment: eventEnv,
          externalEventId: verified.externalEventId,
          eventType: verified.eventType,
          payloadSha256,
          attemptId: attempt.id,
          attemptPublicId: attempt.publicId,
          providerRef: attempt.providerRef ?? verified.providerRef,
          providerOrderRef: attempt.providerOrderRef ?? verified.providerOrderRef,
          providerPaymentRef: verified.providerPaymentRef,
          status: "retry_pending",
          reasonCode: "AWAITING_FETCH_VERIFICATION",
          occurredAt: verified.occurredAt,
          receivedAt: now,
        });
        webhookRowId = ins.insertId;
      }

      return {
        kind: "verify_paid" as const,
        webhookRowId,
        attempt,
        attemptCount: existing?.attemptCount ?? 0,
        duplicate: Boolean(existing),
      };
    });

    if (staged.kind === "tamper_conflict") {
      await recordWebhookRejection({
        provider: input.provider,
        environmentHint: eventEnv,
        reasonCode: "PAYLOAD_TAMPER_CONFLICT",
        httpStatus: 409,
        receivedAt: now,
      });
      await deps.audit.record({
        category: "security",
        eventName: "payments.webhook.rejected",
        action: "verify",
        outcome: "denied",
        severity: "ERROR",
        reasonCode: "PAYLOAD_TAMPER_CONFLICT",
        actor: { role: "system" },
        attributes: {
          provider: input.provider,
          external_event_id: verified.externalEventId,
        },
      });
      return {
        httpStatus: 409,
        accepted: false,
        duplicate: true,
        booked: false,
        reasonCode: "PAYLOAD_TAMPER_CONFLICT",
      };
    }

    if (staged.kind === "duplicate_done") {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: true,
        booked: staged.booked,
        reasonCode: "DUPLICATE_EVENT",
      };
    }

    if (staged.kind === "self_test_ok") {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: "SELF_TEST_OK",
      };
    }

    if (staged.kind === "unlinked_refund") {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: "UNLINKED_PROVIDER_REFUND",
      };
    }

    if (staged.kind === "unmatched_portal_payment") {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: "UNMATCHED_PORTAL_PAYMENT",
      };
    }

    if (staged.kind === "ignored") {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: false,
        booked: false,
        reasonCode: "IGNORED",
      };
    }

    if (staged.kind === "terminal_non_paid") {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: false,
        booked: false,
        reasonCode: staged.reasonCode,
      };
    }

    if (staged.kind === "verify_refund") {
      return verifyAndApplyRefundWebhook({
        provider: input.provider,
        credentials,
        refundRow: staged.refundRow,
        webhookRowId: staged.webhookRowId,
        externalEventId: verified.externalEventId,
        providerRefundRefHint: verified.providerRefundRef ?? null,
        duplicate: staged.duplicate,
        now,
      });
    }

    if (staged.kind === "verify_refund_list") {
      const listFn = refundAdapters[input.provider].listPaymentRefunds!;
      const listed = await listFn({
        credentials,
        providerPaymentRef: staged.providerPaymentRef,
      });

      if (!listed.ok) {
        const nextCount = staged.attemptCount + 1;
        const errCode = (listed.failureReasonCode ?? "STRIPE_REFUND_LIST_FAILED").slice(0, 64);
        await deps.db
          .update(paymentWebhookEvents)
          .set({
            status: "retry_pending",
            reasonCode: errCode,
            attemptCount: nextCount,
            lastErrorCode: errCode,
          })
          .where(eq(paymentWebhookEvents.id, staged.webhookRowId));
        return {
          httpStatus: 503,
          accepted: false,
          duplicate: staged.duplicate,
          booked: false,
          reasonCode: errCode,
        };
      }

      const portalRefundRows = await deps.db
        .select()
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.provider, input.provider),
            eq(paymentRefunds.environment, eventEnv),
            eq(paymentRefunds.providerPaymentRef, staged.providerPaymentRef),
          ),
        );

      let anyBooked = false;
      let lastSettledResult: PaymentWebhookResult | null = null;
      const unlinkedItems: Array<(typeof listed.items)[number]> = [];

      for (const item of listed.items) {
        const match = portalRefundRows.find(
          (r) =>
            (item.refundPublicIdHint && r.publicId === item.refundPublicIdHint) ||
            r.providerRefundRef === item.providerRefundRef,
        );
        if (match) {
          if (match.status !== "succeeded" && (item.status === "succeeded" || item.status === "failed")) {
            const res = await verifyAndApplyRefundWebhook({
              provider: input.provider,
              credentials,
              refundRow: match,
              webhookRowId: staged.webhookRowId,
              externalEventId: verified.externalEventId,
              providerRefundRefHint: item.providerRefundRef,
              duplicate: staged.duplicate,
              now,
            });
            lastSettledResult = res;
            if (res.booked) anyBooked = true;
          }
        } else if (item.status === "succeeded" || item.status === "pending") {
          unlinkedItems.push(item);
        }
      }

      if (unlinkedItems.length > 0) {
        const firstUnlinked = unlinkedItems[0]!;
        const orderPubId = staged.fallbackOrderPublicId;
        const invoicePubId = staged.fallbackInvoicePublicId;
        await deps.db.transaction(async (tx) => {
          await tx
            .update(paymentWebhookEvents)
            .set({
              status: "attention_required",
              reasonCode: "UNLINKED_PROVIDER_REFUND",
              lastErrorCode: "UNLINKED_PROVIDER_REFUND",
              providerRefundRef: firstUnlinked.providerRefundRef,
              processedAt: now,
            })
            .where(eq(paymentWebhookEvents.id, staged.webhookRowId));

          await deps.audit.record(
            {
              category: "security",
              eventName: "payment.refund.flagged",
              action: "verify",
              outcome: "denied",
              severity: "WARN",
              reasonCode: "UNLINKED_PROVIDER_REFUND",
              actor: { role: "system" },
              resource: staged.matchedAttempt
                ? { type: "payment_attempt", publicId: staged.matchedAttempt.publicId }
                : { type: "payment_webhook", publicId: verified.externalEventId },
              ...(orderPubId ? { orderPublicId: orderPubId } : {}),
              attributes: {
                ...(orderPubId ? { order_public_id: orderPubId } : {}),
                ...(invoicePubId ? { invoice_public_id: invoicePubId } : {}),
                provider: input.provider,
                external_event_id: verified.externalEventId,
                reason_code: "UNLINKED_PROVIDER_REFUND",
                unlinked_refund_count: unlinkedItems.length,
              },
            },
            tx,
          );

          const refundHash = createHash("sha256")
            .update(`${input.provider}:${firstUnlinked.providerRefundRef}`)
            .digest("hex")
            .slice(0, 24);
          await emitPaymentOpsAlert(
            {
              dedupKey: `unlinked-refund:${input.provider}:${refundHash}`,
              severity: "warning",
              code: "UNLINKED_PROVIDER_REFUND",
              title: "Refund made outside portal requires review",
              text: "A provider refund without portal metadata was detected on a paid order and held from automatic ledger booking.",
              ...(orderPubId ? { orderPublicId: orderPubId } : {}),
            },
            tx,
          );
        });

        return {
          httpStatus: 200,
          accepted: true,
          duplicate: staged.duplicate,
          booked: anyBooked,
          reasonCode: "UNLINKED_PROVIDER_REFUND",
        };
      }

      if (lastSettledResult) {
        return lastSettledResult;
      }

      await deps.db
        .update(paymentWebhookEvents)
        .set({
          status: "processed",
          reasonCode: portalRefundRows.length > 0 ? "REFUND_ALREADY_PROCESSED" : "REFUND_LIST_EMPTY",
          processedAt: now,
        })
        .where(eq(paymentWebhookEvents.id, staged.webhookRowId));
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: portalRefundRows.length > 0 ? "REFUND_ALREADY_PROCESSED" : "REFUND_LIST_EMPTY",
      };
    }

    const { attempt, webhookRowId } = staged;
    if (!attempt.providerRef) {
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: "MISSING_PROVIDER_REF",
      };
    }

    let fetched: ProviderFetchedPayment;
    try {
      fetched = await adapter.fetchPayment({
        providerRef: attempt.providerRef,
        providerOrderRef: attempt.providerOrderRef ?? verified.providerOrderRef,
        providerPaymentRef: verified.providerPaymentRef ?? attempt.providerPaymentRef,
        credentials,
      });
    } catch (err) {
      const reasonCode = err instanceof DomainError ? err.reasonCode : "PROVIDER_FETCH_FAILED";
      const nextAttemptCount = staged.attemptCount + 1;
      await deps.db
        .update(paymentWebhookEvents)
        .set({
          attemptCount: nextAttemptCount,
          lastErrorCode: reasonCode.slice(0, 64),
        })
        .where(eq(paymentWebhookEvents.id, webhookRowId));

      if (nextAttemptCount >= 3) {
        await emitPaymentOpsAlert({
          dedupKey: `webhook-verify:${attempt.publicId}`,
          severity: "warning",
          code: reasonCode,
          title: "Payment verification retrying",
          text: "Provider payment lookup failed repeatedly while verifying a signed webhook; scheduled reconciliation will continue retrying.",
          orderPublicId: attempt.orderPublicId,
        });
      }

      await deps.audit.record({
        category: "integration",
        eventName: "payments.verification.retry_scheduled",
        action: "verify",
        outcome: "failed",
        severity: "WARN",
        reasonCode,
        actor: { role: "system" },
        resource: { type: "payment_attempt", publicId: attempt.publicId },
        orderPublicId: attempt.orderPublicId,
        attributes: {
          order_public_id: attempt.orderPublicId,
          provider: input.provider,
          external_event_id: verified.externalEventId,
          attempt_count: nextAttemptCount,
        },
      });
      return {
        httpStatus: 503,
        accepted: true,
        duplicate: staged.duplicate,
        booked: false,
        reasonCode: "UPSTREAM_FETCH_RETRYABLE",
      };
    }

    if (fetched.status === "open") {
      const settledWaitAt = deps.clock.now();
      const openOutcome = await runWithMysqlDeadlockRetry(() =>
        deps.db.transaction(async (tx) => {
          const currentInvoice = await loadLockedCurrentInvoiceOrNull(tx, attempt.invoicePublicId);
          const [locked] = await tx
            .select()
            .from(paymentAttempts)
            .where(eq(paymentAttempts.id, attempt.id))
            .for("update")
            .limit(1);

          if (currentInvoice?.status === "paid" || locked?.status === "paid") {
            await tx
              .update(paymentWebhookEvents)
              .set({
                status: "processed",
                reasonCode: "ALREADY_PAID",
                processedAt: settledWaitAt,
              })
              .where(eq(paymentWebhookEvents.id, webhookRowId));
            return { alreadyPaid: true, ignoreReason: null as string | null, mismatchReason: null as string | null };
          }

          const invoiceVoided =
            !currentInvoice || currentInvoice.status === "void" || currentInvoice.voidedAt !== null;
          if (invoiceVoided || !locked || (locked.status !== "created" && locked.status !== "redirected")) {
            const ignoreReason = !currentInvoice
              ? "INVOICE_NOT_FOUND"
              : invoiceVoided
                ? "INVOICE_VOIDED"
                : "ATTEMPT_NOT_ACTIVE";
            await tx
              .update(paymentWebhookEvents)
              .set({
                status: "ignored",
                reasonCode: ignoreReason,
                processedAt: settledWaitAt,
              })
              .where(eq(paymentWebhookEvents.id, webhookRowId));
            return { alreadyPaid: false, ignoreReason, mismatchReason: null as string | null };
          }

          const bindingCheck = checkFetchedBindingMatchesAttempt(locked, fetched);
          if (!bindingCheck.matches) {
            await tx
              .update(paymentWebhookEvents)
              .set({
                status: "verification_mismatch",
                reasonCode: bindingCheck.reasonCode,
                processedAt: settledWaitAt,
              })
              .where(eq(paymentWebhookEvents.id, webhookRowId));
            await recordLookupMismatchInTx(tx, locked, fetched, bindingCheck.reasonCode, {
              role: "system",
            });
            return { alreadyPaid: false, ignoreReason: null as string | null, mismatchReason: bindingCheck.reasonCode };
          }
          await tx
            .update(paymentAttempts)
            .set({
              reconciliationNote: "awaiting_async_settlement",
              updatedAt: settledWaitAt,
            })
            .where(eq(paymentAttempts.id, locked.id));

          await tx
            .update(paymentWebhookEvents)
            .set({
              status: "awaiting_settlement",
              reasonCode: "AWAITING_ASYNC_SETTLEMENT",
              processedAt: settledWaitAt,
            })
            .where(eq(paymentWebhookEvents.id, webhookRowId));

          await notifyOrderPaymentEventInTx(tx, {
            orderPublicId: attempt.orderPublicId,
            kind: "pending_async",
            eventRef: verified.externalEventId,
          });

          await deps.audit.record(
            {
              category: "business",
              eventName: "payments.attempt.pending_async",
              action: "transition",
              outcome: "completed",
              actor: { role: "system" },
              resource: { type: "payment_attempt", publicId: attempt.publicId },
              orderPublicId: attempt.orderPublicId,
              attributes: {
                order_public_id: attempt.orderPublicId,
                invoice_public_id: attempt.invoicePublicId,
                provider: input.provider,
                external_event_id: verified.externalEventId,
                payment_state: "pending_async",
              },
            },
            tx,
          );
          return { alreadyPaid: false, ignoreReason: null as string | null, mismatchReason: null as string | null };
        }),
      );
      if (openOutcome.mismatchReason) {
        return {
          httpStatus: 200,
          accepted: true,
          duplicate: staged.duplicate,
          booked: false,
          reasonCode: openOutcome.mismatchReason,
        };
      }
      if (openOutcome.ignoreReason) {
        return {
          httpStatus: 200,
          accepted: true,
          duplicate: staged.duplicate,
          booked: false,
          reasonCode: openOutcome.ignoreReason,
        };
      }
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: staged.duplicate,
        booked: openOutcome.alreadyPaid,
        reasonCode: openOutcome.alreadyPaid ? "ALREADY_PAID" : "AWAITING_ASYNC_SETTLEMENT",
      };
    }

    if (fetched.status === "failed" || fetched.status === "expired") {
      const termStatus: PaymentAttemptStatus = fetched.status === "expired" ? "expired" : "failed";
      const termReason = `FETCH_${termStatus.toUpperCase()}`;
      const termAt = deps.clock.now();
      const termOutcome = await runWithMysqlDeadlockRetry(() =>
        deps.db.transaction(async (tx) => {
          const currentInvoice = await loadLockedCurrentInvoiceOrNull(tx, attempt.invoicePublicId);
          const [locked] = await tx
            .select()
            .from(paymentAttempts)
            .where(eq(paymentAttempts.id, attempt.id))
            .for("update")
            .limit(1);

          if (currentInvoice?.status === "paid" || locked?.status === "paid") {
            await tx
              .update(paymentWebhookEvents)
              .set({
                status: "processed",
                reasonCode: "ALREADY_PAID",
                processedAt: termAt,
              })
              .where(eq(paymentWebhookEvents.id, webhookRowId));
            return { alreadyPaid: true, ignoreReason: null as string | null, mismatchReason: null as string | null };
          }

          const invoiceVoided =
            !currentInvoice || currentInvoice.status === "void" || currentInvoice.voidedAt !== null;
          if (invoiceVoided || !locked || (locked.status !== "created" && locked.status !== "redirected")) {
            const ignoreReason = !currentInvoice
              ? "INVOICE_NOT_FOUND"
              : invoiceVoided
                ? "INVOICE_VOIDED"
                : "ATTEMPT_NOT_ACTIVE";
            await tx
              .update(paymentWebhookEvents)
              .set({
                status: "ignored",
                reasonCode: ignoreReason,
                processedAt: termAt,
              })
              .where(eq(paymentWebhookEvents.id, webhookRowId));
            return { alreadyPaid: false, ignoreReason, mismatchReason: null as string | null };
          }

          const bindingCheck = checkFetchedBindingMatchesAttempt(locked, fetched);
          if (!bindingCheck.matches) {
            await tx
              .update(paymentWebhookEvents)
              .set({
                status: "verification_mismatch",
                reasonCode: bindingCheck.reasonCode,
                processedAt: termAt,
              })
              .where(eq(paymentWebhookEvents.id, webhookRowId));
            await recordLookupMismatchInTx(tx, locked, fetched, bindingCheck.reasonCode, {
              role: "system",
            });
            return { alreadyPaid: false, ignoreReason: null as string | null, mismatchReason: bindingCheck.reasonCode };
          }

          await tx
            .update(paymentAttempts)
            .set({
              status: termStatus,
              failureReasonCode: termReason,
              lastReconciledAt: termAt,
              version: locked.version + 1,
              updatedAt: termAt,
            })
            .where(and(eq(paymentAttempts.id, locked.id), eq(paymentAttempts.version, locked.version)));

          await tx
            .update(paymentWebhookEvents)
            .set({
              status: "processed",
              reasonCode: termReason,
              processedAt: termAt,
            })
            .where(eq(paymentWebhookEvents.id, webhookRowId));

          if (termStatus === "failed") {
          await notifyOrderPaymentEventInTx(tx, {
            orderPublicId: attempt.orderPublicId,
            kind: "failed",
            eventRef: verified.externalEventId,
          });
          await deps.audit.record(
            {
              category: "business",
              eventName: "payments.attempt.failed",
              action: "transition",
              outcome: "failed",
              severity: "WARN",
              reasonCode: termReason,
              actor: { role: "system" },
              resource: { type: "payment_attempt", publicId: attempt.publicId },
              orderPublicId: attempt.orderPublicId,
              attributes: {
                order_public_id: attempt.orderPublicId,
                invoice_public_id: attempt.invoicePublicId,
                provider: input.provider,
                external_event_id: verified.externalEventId,
                reason_code: termReason,
                payment_state: "failed",
              },
            },
            tx,
          );
        }
        return { alreadyPaid: false, ignoreReason: null as string | null, mismatchReason: null as string | null };
      }),
      );
      if (termOutcome.mismatchReason) {
        return {
          httpStatus: 200,
          accepted: true,
          duplicate: staged.duplicate,
          booked: false,
          reasonCode: termOutcome.mismatchReason,
        };
      }
      if (termOutcome.ignoreReason) {
        return {
          httpStatus: 200,
          accepted: true,
          duplicate: staged.duplicate,
          booked: false,
          reasonCode: termOutcome.ignoreReason,
        };
      }
      return {
        httpStatus: 200,
        accepted: true,
        duplicate: staged.duplicate,
        booked: termOutcome.alreadyPaid,
        reasonCode: termOutcome.alreadyPaid ? "ALREADY_PAID" : termReason,
      };
    }

    const bookedResult = await runWithMysqlDeadlockRetry(() =>
      deps.db.transaction((tx) =>
        finalizeVerifiedPaidAttemptInTx(tx, {
          attemptId: attempt.id,
          webhookRowId,
          fetched,
        }),
      ),
    );

    return {
      httpStatus: 200,
      accepted: true,
      duplicate: staged.duplicate,
      booked: bookedResult.booked,
      reasonCode: bookedResult.reasonCode,
    };
  }

  /**
   * Evaluates whether any Stripe attempt was booked via `provider_lookup` more than `MISSING_WEBHOOK_GRACE_MS`
   * ago without a verified Stripe webhook ever arriving since `paidAt`, and emits a non-auto-resolving
   * ops alert (`stripeWebhookDeliveryMissingAlert(env)`) so operators notice silent webhook misconfiguration.
   */
  async function evaluateMissingStripeWebhookAlerts(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - MISSING_WEBHOOK_GRACE_MS);
    const overdue = await deps.db
      .select({
        id: paymentAttempts.id,
        environment: paymentAttempts.environment,
        paidAt: paymentAttempts.paidAt,
      })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, "stripe"),
          eq(paymentAttempts.status, "paid"),
          eq(paymentAttempts.bookingSource, "provider_lookup"),
          isNull(paymentAttempts.verifiedWebhookEventId),
          isNull(paymentAttempts.missingWebhookAlertedAt),
          isNotNull(paymentAttempts.paidAt),
          lte(paymentAttempts.paidAt, cutoff),
        ),
      )
      .orderBy(asc(paymentAttempts.paidAt), asc(paymentAttempts.id))
      .limit(50);

    if (overdue.length === 0) return;

    const byEnv = new Map<PaymentEnvironmentMode, number[]>();
    for (const row of overdue) {
      if (!row.paidAt) continue;
      const existing = byEnv.get(row.environment);
      if (existing) {
        existing.push(row.id);
      } else {
        byEnv.set(row.environment, [row.id]);
      }
    }

    for (const [env, candidateIds] of byEnv) {
      await runWithMysqlDeadlockRetry(() =>
        deps.db.transaction(async (tx) => {
          // Recheck qualifying unmatched rows under FOR UPDATE so a late webhook that just stamped
          // `verifiedWebhookEventId` cannot race a stale candidate into emitting a false alert, and
          // never suppress an unmatched attempt because an unrelated webhook arrived in the same mode.
          const lockedEligible = await tx
            .select({ id: paymentAttempts.id })
            .from(paymentAttempts)
            .where(
              and(
                inArray(paymentAttempts.id, candidateIds),
                eq(paymentAttempts.provider, "stripe"),
                eq(paymentAttempts.environment, env),
                eq(paymentAttempts.status, "paid"),
                eq(paymentAttempts.bookingSource, "provider_lookup"),
                isNull(paymentAttempts.verifiedWebhookEventId),
                isNull(paymentAttempts.missingWebhookAlertedAt),
                isNotNull(paymentAttempts.paidAt),
                lte(paymentAttempts.paidAt, cutoff),
              ),
            )
            .orderBy(asc(paymentAttempts.id))
            .for("update");

          if (lockedEligible.length === 0) return;

          const eligibleIds = lockedEligible.map((r) => r.id);
          await tx
            .update(paymentAttempts)
            .set({ missingWebhookAlertedAt: now, updatedAt: now })
            .where(inArray(paymentAttempts.id, eligibleIds));

          await emitPaymentOpsAlert(stripeWebhookDeliveryMissingAlert(env), tx);
          await deps.audit.record(
            {
              category: "security",
              eventName: "payments.webhook.delivery_missing_alert",
              action: "verify",
              outcome: "attempted",
              severity: "WARN",
              reasonCode: "STRIPE_WEBHOOK_DELIVERY_MISSING",
              actor: { role: "system" },
              resource: { type: "payments_settings" },
              attributes: {
                provider: "stripe",
                environment: env,
                unwebhooked_lookup_paid_count: eligibleIds.length,
              },
            },
            tx,
          );
        }),
      );
    }
  }

  async function reconcilePendingAttempts(opts?: {
    limit?: number | undefined;
    signal?: AbortSignal | undefined;
    beforeSend?: (() => Promise<void>) | undefined;
  }): Promise<ReconcilePaymentsResult> {
    await pruneExpiredWebhookRejections(deps.clock.now());
    const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 100);
    const config = await loadConfig();
    // Enforce zero outbound network activity when payments are off (`provider === "none"`).
    if (config.provider === "none") {
      return { scanned: 0, booked: 0, expired: 0, failed: 0, stillPending: 0 };
    }
    const activeProvider: ActivePaymentProvider = config.provider;
    // Starvation-free selection: filter in SQL to rows with non-null `providerRef` and either `redirected`,
    // (`cancelled` with `verifiedWebhookEventId`), or non-terminal trash-cancelled attempts (D2.8),
    // ordered oldest-reconciled first (`NULL` first in MySQL ASC).
    const candidates = await deps.db
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, activeProvider),
          eq(paymentAttempts.environment, config.mode),
          isNotNull(paymentAttempts.providerRef),
          or(
            eq(paymentAttempts.status, "redirected"),
            and(
              eq(paymentAttempts.status, "cancelled"),
              isNotNull(paymentAttempts.verifiedWebhookEventId),
            ),
            and(
              eq(paymentAttempts.status, "cancelled"),
              isNotNull(paymentAttempts.trashCancelledAt),
              or(
                isNull(paymentAttempts.reconciliationNote),
                ne(paymentAttempts.reconciliationNote, "trash_cancelled_terminal"),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(paymentAttempts.lastReconciledAt), asc(paymentAttempts.id))
      .limit(limit);

    let scanned = 0;
    let booked = 0;
    let expired = 0;
    let failed = 0;
    let stillPending = 0;

    for (const attempt of candidates) {
      if (opts?.signal?.aborted) break;
      if (!attempt.providerRef) {
        continue;
      }
      scanned += 1;
      const now = deps.clock.now();

      let credentials: ProviderCredentials;
      let stripeKeyDigest: string | null = null;
      try {
        if (attempt.provider === "stripe") {
          const loaded = await loadStripeLookupCredentials(attempt.environment);
          credentials = loaded.credentials;
          stripeKeyDigest = loaded.keyDigest;
        } else {
          const loaded = await loadProviderCredentials(attempt.provider, {
            ...config,
            mode: attempt.environment,
          });
          credentials = loaded.credentials;
        }
      } catch {
        stillPending += 1;
        continue;
      }

      let fetched: ProviderFetchedPayment;
      try {
        fetched = await adapters[attempt.provider].fetchPayment({
          providerRef: attempt.providerRef,
          providerOrderRef: attempt.providerOrderRef,
          providerPaymentRef: attempt.providerPaymentRef,
          credentials,
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(opts?.beforeSend ? { beforeSend: opts.beforeSend } : {}),
        });
      } catch {
        stillPending += 1;
        continue;
      }

      const verifyPostEgressStripeDigestInTx = async (tx: Tx): Promise<boolean> => {
        if (attempt.provider !== "stripe" || !stripeKeyDigest) return true;
        try {
          const post = await loadStripeLookupCredentials(attempt.environment, { tx });
          return post.keyDigest === stripeKeyDigest;
        } catch {
          return false;
        }
      };

      if (fetched.status === "paid") {
        if (attempt.verifiedWebhookEventId) {
          const [pendingWh] = await deps.db
            .select()
            .from(paymentWebhookEvents)
            .where(
              and(
                eq(paymentWebhookEvents.provider, attempt.provider),
                eq(paymentWebhookEvents.externalEventId, attempt.verifiedWebhookEventId),
              ),
            )
            .limit(1);

          if (pendingWh) {
            const res = await runWithMysqlDeadlockRetry(() =>
              deps.db.transaction(async (tx) => {
                if (!(await verifyPostEgressStripeDigestInTx(tx))) {
                  return { booked: false, alreadyPaid: false, drifted: true };
                }
                const bookedRes = await bookAuthoritativeAttemptPaymentInTx(tx, {
                  attemptId: attempt.id,
                  source: "webhook",
                  webhookRowId: pendingWh.id,
                  fetched,
                });
                return { ...bookedRes, drifted: false };
              }),
            );
            if (res.drifted) {
              stillPending += 1;
            } else if (res.booked) {
              if (!res.alreadyPaid) booked += 1;
            } else {
              failed += 1;
            }
            continue;
          }
        }

        if (attempt.provider === "stripe" || attempt.trashCancelledAt !== null) {
          const res = await runWithMysqlDeadlockRetry(() =>
            deps.db.transaction(async (tx) => {
              if (!(await verifyPostEgressStripeDigestInTx(tx))) {
                return { booked: false, alreadyPaid: false };
              }
              return bookAuthoritativeAttemptPaymentInTx(tx, {
                attemptId: attempt.id,
                source: "provider_lookup",
                fetched,
              });
            }),
          );
          if (res.booked) {
            if (!res.alreadyPaid) booked += 1;
          } else {
            stillPending += 1;
          }
        } else {
          await runWithMysqlDeadlockRetry(() =>
            deps.db.transaction(async (tx) => {
              const currentInvoice = await loadLockedCurrentInvoiceOrNull(tx, attempt.invoicePublicId);
              const [locked] = await tx
                .select()
                .from(paymentAttempts)
                .where(eq(paymentAttempts.id, attempt.id))
                .for("update")
                .limit(1);
              if (
                !locked ||
                locked.status === "paid" ||
                !currentInvoice ||
                currentInvoice.status === "paid" ||
                currentInvoice.status === "void" ||
                currentInvoice.voidedAt !== null ||
                (locked.status !== "created" && locked.status !== "redirected")
              ) {
                return;
              }
              await tx
                .update(paymentAttempts)
                .set({
                  reconciliationNote: "awaiting_webhook",
                  lastReconciledAt: now,
                  updatedAt: now,
                })
                .where(eq(paymentAttempts.id, locked.id));
            }),
          );
          stillPending += 1;
        }
        continue;
      }

      const nonPaidOutcome = await runWithMysqlDeadlockRetry(() =>
        deps.db.transaction(async (tx) => {
          if (!(await verifyPostEgressStripeDigestInTx(tx))) {
            return "pending" as const;
          }
          const currentInvoice = await loadLockedCurrentInvoiceOrNull(tx, attempt.invoicePublicId);
          const [locked] = await tx
            .select()
            .from(paymentAttempts)
            .where(eq(paymentAttempts.id, attempt.id))
            .for("update")
            .limit(1);
          if (!locked || locked.status === "paid" || currentInvoice?.status === "paid") {
            return "already_paid" as const;
          }
          if (locked.status === "cancelled" && locked.trashCancelledAt !== null) {
            if (
              !currentInvoice ||
              currentInvoice.status === "void" ||
              currentInvoice.voidedAt !== null ||
              fetched.status === "expired" ||
              fetched.status === "failed" ||
              (fetched.status === "open" &&
                locked.providerCancelledAt !== null &&
                !fetched.asyncPending &&
                !locked.verifiedWebhookEventId)
            ) {
              await tx
                .update(paymentAttempts)
                .set({
                  reconciliationNote: "trash_cancelled_terminal",
                  lastReconciledAt: now,
                  updatedAt: now,
                })
                .where(eq(paymentAttempts.id, locked.id));
              return "already_terminal" as const;
            }
            await tx
              .update(paymentAttempts)
              .set({
                lastReconciledAt: now,
                updatedAt: now,
              })
              .where(eq(paymentAttempts.id, locked.id));
            return "pending" as const;
          }
          // Never overwrite or mutate voided invoices or terminal attempts (`cancelled`, `failed`,
          // `expired`) on delayed worker outcomes (`expired`, `failed`, `asyncPending`, or lookup mismatch).
          if (
            !currentInvoice ||
            currentInvoice.status === "void" ||
            currentInvoice.voidedAt !== null ||
            (locked.status !== "created" && locked.status !== "redirected")
          ) {
            return "already_terminal" as const;
          }

          const bindingCheck = checkFetchedBindingMatchesAttempt(locked, fetched);
        if (!bindingCheck.matches) {
          await recordLookupMismatchInTx(tx, locked, fetched, bindingCheck.reasonCode, {
            role: "system",
          });
          return "pending" as const;
        }

        const isPastExpiry = Boolean(locked.expiresAt && locked.expiresAt.getTime() <= now.getTime());
        if (
          fetched.status === "expired" ||
          (fetched.status === "open" &&
            !fetched.asyncPending &&
            isPastExpiry &&
            !locked.verifiedWebhookEventId)
        ) {
          await tx
            .update(paymentAttempts)
            .set({
              status: "expired",
              lastReconciledAt: now,
              version: locked.version + 1,
              updatedAt: now,
            })
            .where(and(eq(paymentAttempts.id, locked.id), eq(paymentAttempts.version, locked.version)));
          return "expired" as const;
        }

        if (fetched.status === "failed") {
          await tx
            .update(paymentAttempts)
            .set({
              status: "failed",
              failureReasonCode: "RECONCILE_PROVIDER_FAILED",
              lastReconciledAt: now,
              version: locked.version + 1,
              updatedAt: now,
            })
            .where(and(eq(paymentAttempts.id, locked.id), eq(paymentAttempts.version, locked.version)));

          await notifyOrderPaymentEventInTx(tx, {
            orderPublicId: locked.orderPublicId,
            kind: "failed",
            eventRef: locked.publicId,
          });

          await deps.audit.record(
            {
              category: "business",
              eventName: "payments.attempt.failed",
              action: "transition",
              outcome: "failed",
              severity: "WARN",
              reasonCode: "RECONCILE_PROVIDER_FAILED",
              actor: { role: "system" },
              resource: { type: "payment_attempt", publicId: locked.publicId },
              orderPublicId: locked.orderPublicId,
              attributes: {
                order_public_id: locked.orderPublicId,
                invoice_public_id: locked.invoicePublicId,
                provider: locked.provider,
                reason_code: "RECONCILE_PROVIDER_FAILED",
                payment_state: "failed",
              },
            },
            tx,
          );
          return "failed" as const;
        }

        await tx
          .update(paymentAttempts)
          .set({
            ...(fetched.asyncPending ? { reconciliationNote: "awaiting_async_settlement" } : {}),
            lastReconciledAt: now,
            updatedAt: now,
          })
          .where(eq(paymentAttempts.id, locked.id));
        return "pending" as const;
      }),
      );

      if (nonPaidOutcome === "expired") {
        expired += 1;
      } else if (nonPaidOutcome === "failed") {
        failed += 1;
      } else if (nonPaidOutcome === "pending") {
        stillPending += 1;
      }
    }

    await evaluateMissingStripeWebhookAlerts(deps.clock.now());
    return { scanned, booked, expired, failed, stillPending };
  }

  /* ------------------------------------------------------------- admin console */

  async function buildAdminSettingsView(tx?: Tx): Promise<PaymentsAdminSettingsView> {
    const [config, smallTotals, receipts, diagnostics] = await Promise.all([
      loadConfig(tx),
      loadSmallTotals(tx),
      loadReceiptsSetting(tx),
      loadDiagnostics(tx),
    ]);
    const [stripeKey, stripeWh, stripeWhSecSet, squareTokenSet, squareSigSet] = await Promise.all([
      readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
      readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx),
      isSecretConfigured(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET_SECONDARY, tx),
      isSecretConfigured(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx),
      isSecretConfigured(deps.settings, PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY, tx),
    ]);
    const stripeKeySet = Boolean(stripeKey);
    const stripeWhSet = Boolean(stripeWh);

    const squareHost =
      config.mode === "live" ? ("connect.squareup.com" as const) : ("connect.squareupsandbox.com" as const);

    const egress = await checkEgressPresets(config.mode);
    const stripeState = resolveStripeVerificationState(config, stripeKey, stripeWh, egress);
    const gate = computeStripeGateSummary({
      config,
      stripeKeySet,
      stripeWhSet,
      stripeState,
      diagnostics,
    });

    const probe = diagnostics.lastStripeCheckoutProbe;
    const probeMatchesCurrent = Boolean(
      probe &&
        stripeState.expectedApiFp &&
        probe.apiFingerprint === stripeState.expectedApiFp &&
        probe.mode === config.mode,
    );
    const currentProbe = probeMatchesCurrent ? probe : null;
    const checkoutSessionProbeFailed = Boolean(currentProbe && !currentProbe.ok);
    const checkoutSessionVerified = Boolean(currentProbe && currentProbe.ok);

    const stripeReady = stripeState.ready && !checkoutSessionProbeFailed;
    const onlineEnabled =
      config.provider === "stripe"
        ? stripeReady
        : config.provider === "square"
          ? Boolean(
              config.squareLocationId &&
                squareTokenSet &&
                squareSigSet &&
                (!egress.wired || egress.squareAllowlisted),
            )
          : false;

    const dbOrTx = tx ?? deps.db;
    const now = deps.clock.now();
    const graceCutoff = new Date(now.getTime() - MISSING_WEBHOOK_GRACE_MS);
    const recentRejectionCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [latestStripeWebhook] = await dbOrTx
      .select({
        receivedAt: paymentWebhookEvents.receivedAt,
        eventType: paymentWebhookEvents.eventType,
        status: paymentWebhookEvents.status,
      })
      .from(paymentWebhookEvents)
      .where(
        and(
          eq(paymentWebhookEvents.provider, "stripe"),
          eq(paymentWebhookEvents.environment, config.mode),
          ne(paymentWebhookEvents.eventType, "readypackets.self_test"),
          inArray(paymentWebhookEvents.status, ["processed", "awaiting_settlement"]),
        ),
      )
      .orderBy(desc(paymentWebhookEvents.id))
      .limit(1);

    const [recentRejectionRows, unwebhookedLookupRows] = await Promise.all([
      dbOrTx
        .select({
          reasonCode: paymentWebhookRejections.reasonCode,
          receivedAt: paymentWebhookRejections.receivedAt,
        })
        .from(paymentWebhookRejections)
        .where(
          and(
            eq(paymentWebhookRejections.provider, "stripe"),
            gte(paymentWebhookRejections.receivedAt, recentRejectionCutoff),
            or(
              eq(paymentWebhookRejections.environmentHint, config.mode),
              eq(paymentWebhookRejections.environmentHint, "unknown"),
            ),
          ),
        )
        .orderBy(desc(paymentWebhookRejections.id))
        .limit(50),
      dbOrTx
        .select({
          paidAt: paymentAttempts.paidAt,
        })
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.provider, "stripe"),
            eq(paymentAttempts.environment, config.mode),
            eq(paymentAttempts.status, "paid"),
            eq(paymentAttempts.bookingSource, "provider_lookup"),
            isNull(paymentAttempts.verifiedWebhookEventId),
            isNotNull(paymentAttempts.paidAt),
            lte(paymentAttempts.paidAt, graceCutoff),
          ),
        )
        .orderBy(asc(paymentAttempts.paidAt), asc(paymentAttempts.id))
        .limit(50),
    ]);

    const reasonCounts = new Map<string, { count: number; latestAt: Date }>();
    for (const r of recentRejectionRows) {
      const prev = reasonCounts.get(r.reasonCode);
      if (prev) {
        prev.count += 1;
        if (r.receivedAt.getTime() > prev.latestAt.getTime()) {
          prev.latestAt = r.receivedAt;
        }
      } else {
        reasonCounts.set(r.reasonCode, { count: 1, latestAt: r.receivedAt });
      }
    }
    const recentRejectionReasons: StripeWebhookRejectionReasonSummary[] = [...reasonCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([reasonCode, info]) => ({
        reasonCode,
        reasonLabel: labelWebhookRejectionReason(reasonCode),
        count: info.count,
        latestAt: info.latestAt.toISOString(),
      }));

    const oldestUnwebhooked = unwebhookedLookupRows[0]?.paidAt ?? null;
    const missingWebhookDetected = oldestUnwebhooked !== null;

    const stripeWebhookUrl = new URL("/api/payments/webhooks/stripe", deps.config.canonicalOrigin).href;
    const squareWebhookUrl = new URL("/api/payments/webhooks/square", deps.config.canonicalOrigin).href;
    const stripeReturnPattern = new URL("/api/payments/return/stripe/<attemptId>", deps.config.canonicalOrigin).href;
    const squareReturnPattern = new URL("/api/payments/return/square/<attemptId>", deps.config.canonicalOrigin).href;

    const effectiveMissingGates: StripeMissingGateKey[] = checkoutSessionProbeFailed
      ? [...gate.missingGates, "checkout_session_failed"]
      : config.provider !== "stripe" && !checkoutSessionVerified
        ? [...gate.missingGates, "checkout_session_not_verified"]
        : gate.missingGates;
    const effectiveHeadline =
      config.provider === "stripe" && checkoutSessionProbeFailed
        ? `Online card checkout: NOT ACTIVE (Checkout session verification failed)`
        : gate.statusHeadline;
    const effectiveCustomerSummary =
      config.provider === "stripe" && checkoutSessionProbeFailed
        ? "Stripe Checkout session creation failed during verification. Customers cannot complete online card payment until the staged key or Stripe Checkout domain configuration is fixed."
        : gate.customerExperienceSummary;

    return {
      provider: config.provider,
      mode: config.mode,
      currency: config.currency,
      successPath: config.successPath,
      cancelPath: config.cancelPath,
      webhookToleranceSeconds: config.webhookToleranceSeconds,
      onlineEnabled,
      stripe: {
        secretKeyConfigured: stripeKeySet,
        secretKeyLast4: stripeKeySet ? config.stripeSecretKeyLast4 : null,
        secretKeyModeMatches: stripeState.secretKeyModeMatches,
        webhookSecretConfigured: stripeWhSet,
        webhookSecretLast4: stripeWhSet ? config.stripeWebhookSecretLast4 : null,
        webhookSecretSecondaryConfigured: stripeWhSecSet,
        webhookSecretSecondaryLast4: stripeWhSecSet ? config.stripeWebhookSecretSecondaryLast4 : null,
        lastApiVerifiedAt: stripeState.effectiveLastApiVerifiedAt,
        lastSelfTestAt: stripeState.effectiveLastSelfTestAt,
        lastSelfTestWebhookAt: stripeState.effectiveLastSelfTestAt,
        apiVerified: stripeState.apiVerified,
        selfTestVerified: stripeState.selfTestVerified,
        checkoutSessionVerified,
        lastCheckoutSessionVerifiedAt:
          checkoutSessionVerified && currentProbe ? currentProbe.checkedAt : null,
        lastVerifiedWebhookAt: latestStripeWebhook ? latestStripeWebhook.receivedAt.toISOString() : null,
        lastVerifiedWebhookEventType: latestStripeWebhook?.eventType ?? null,
        lastVerifiedWebhookStatus: latestStripeWebhook?.status ?? null,
        inboundCountryAllowlistExempt: true,
        requiredEvents: STRIPE_REQUIRED_WEBHOOK_EVENTS,
        ready: stripeReady,
        statusHeadline: effectiveHeadline,
        customerExperienceSummary: effectiveCustomerSummary,
        reverificationNeeded: gate.reverificationNeeded,
        reverificationReasons: gate.reverificationReasons,
        missingGates: effectiveMissingGates,
        lastCheckoutFailure: diagnostics.lastCheckoutFailure,
        lastCheckoutProbe: currentProbe,
        webhookUrl: stripeWebhookUrl,
        returnUrlPattern: stripeReturnPattern,
        egressHost: "api.stripe.com",
        egressAllowlisted: egress.stripeAllowlisted,
        webhookDelivery: {
          missingWebhookDetected,
          unwebhookedLookupPaidCount: unwebhookedLookupRows.length,
          oldestUnwebhookedPaidAt: oldestUnwebhooked ? oldestUnwebhooked.toISOString() : null,
          graceSeconds: Math.floor(MISSING_WEBHOOK_GRACE_MS / 1000),
          lastVerifiedWebhookAt: latestStripeWebhook ? latestStripeWebhook.receivedAt.toISOString() : null,
          lastVerifiedWebhookEventType: latestStripeWebhook?.eventType ?? null,
          recentRejectionCount: recentRejectionRows.length,
          recentRejectionReasons,
          endpointUrl: stripeWebhookUrl,
          requiredEvents: STRIPE_REQUIRED_WEBHOOK_EVENTS,
          usualCauses: STRIPE_WEBHOOK_USUAL_CAUSES,
        },
      },
      square: {
        locationId: config.squareLocationId,
        accessTokenConfigured: squareTokenSet,
        accessTokenLast4: squareTokenSet ? config.squareAccessTokenLast4 : null,
        webhookSignatureKeyConfigured: squareSigSet,
        webhookSignatureKeyLast4: squareSigSet ? config.squareWebhookSignatureKeyLast4 : null,
        webhookUrl: squareWebhookUrl,
        returnUrlPattern: squareReturnPattern,
        egressHost: squareHost,
        egressAllowlisted: egress.squareAllowlisted,
      },
      diagnostics: {
        lastCheckoutFailure: diagnostics.lastCheckoutFailure,
      },
      smallTotals,
      defaultProviderMinimumsMinor: DEFAULT_PROVIDER_MINIMUMS_MINOR,
      receipts,
    };
  }

  async function adminGetSettings(principal: SessionPrincipal): Promise<PaymentsAdminSettingsView> {
    await assertAdminPaymentsRead(principal);
    return buildAdminSettingsView();
  }

  async function adminUpdateSettings(
    principal: SessionPrincipal,
    input: UpdatePaymentsSettingsInput,
  ): Promise<PaymentsAdminSettingsView> {
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) {
      throw validation("INVALID_CURRENCY", "Currency must be a 3-letter uppercase ISO 4217 code.");
    }

    const egress = await checkEgressPresets(input.mode);

    await runComplianceTx(deps, principal, { type: "payments_settings" }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.manage");
      const prev = await loadConfig(tx);
      const diagnostics = await loadDiagnostics(tx);

      const modeChanged = prev.mode !== input.mode;
      const nextConfig: PaymentsConfigValue = {
        provider: input.provider,
        mode: input.mode,
        currency,
        successPath: input.successPath ?? prev.successPath,
        cancelPath: input.cancelPath ?? prev.cancelPath,
        webhookToleranceSeconds: input.webhookToleranceSeconds ?? prev.webhookToleranceSeconds,
        stripeSecretKeyLast4: prev.stripeSecretKeyLast4,
        stripeWebhookSecretLast4: prev.stripeWebhookSecretLast4,
        stripeWebhookSecretSecondaryLast4: prev.stripeWebhookSecretSecondaryLast4,
        stripeLastApiVerifiedAt: modeChanged ? null : prev.stripeLastApiVerifiedAt,
        stripeApiVerifiedFingerprint: modeChanged ? null : prev.stripeApiVerifiedFingerprint,
        stripeLastSelfTestAt: modeChanged ? null : prev.stripeLastSelfTestAt,
        stripeSelfTestedFingerprint: modeChanged ? null : prev.stripeSelfTestedFingerprint,
        squareLocationId:
          input.squareLocationId !== undefined
            ? input.squareLocationId && input.squareLocationId.trim() !== ""
              ? input.squareLocationId.trim()
              : null
            : prev.squareLocationId,
        squareAccessTokenLast4: prev.squareAccessTokenLast4,
        squareWebhookSignatureKeyLast4: prev.squareWebhookSignatureKeyLast4,
      };

      const rotatedSecrets: Array<{
        provider: "stripe" | "square";
        slot: string;
        operation: "rotated" | "cleared";
      }> = [];

      const hasNonBlankInput = (raw: string | undefined): raw is string =>
        raw !== undefined && raw.trim() !== "";

      if (input.clearStripeSecretKey) {
        await deps.settings.setSecret(PAYMENTS_STRIPE_SECRET_KEY.key, null, tx);
        nextConfig.stripeSecretKeyLast4 = null;
        nextConfig.stripeLastApiVerifiedAt = null;
        nextConfig.stripeApiVerifiedFingerprint = null;
        rotatedSecrets.push({ provider: "stripe", slot: "api_key", operation: "cleared" });
      } else if (hasNonBlankInput(input.stripeSecretKey)) {
        const check = validateStripeSecretKeyInput(input.stripeSecretKey, nextConfig.mode);
        if (!check.ok) {
          throw new DomainError("VALIDATION", check.reasonCode, check.safeMessage, {
            field: check.field,
            reason: check.reason,
          });
        }
        await deps.settings.setSecret(PAYMENTS_STRIPE_SECRET_KEY.key, check.normalized, tx);
        nextConfig.stripeSecretKeyLast4 = maskLast4(check.normalized);
        nextConfig.stripeLastApiVerifiedAt = null;
        nextConfig.stripeApiVerifiedFingerprint = null;
        rotatedSecrets.push({ provider: "stripe", slot: "api_key", operation: "rotated" });
      }

      if (input.clearStripeWebhookSecret) {
        await deps.settings.setSecret(PAYMENTS_STRIPE_WEBHOOK_SECRET.key, null, tx);
        nextConfig.stripeWebhookSecretLast4 = null;
        nextConfig.stripeLastSelfTestAt = null;
        nextConfig.stripeSelfTestedFingerprint = null;
        rotatedSecrets.push({ provider: "stripe", slot: "webhook_primary", operation: "cleared" });
      } else if (hasNonBlankInput(input.stripeWebhookSecret)) {
        const check = validateStripeWebhookSecretInput(
          input.stripeWebhookSecret,
          "stripeWebhookSecret",
        );
        if (!check.ok) {
          throw new DomainError("VALIDATION", check.reasonCode, check.safeMessage, {
            field: check.field,
            reason: check.reason,
          });
        }
        await deps.settings.setSecret(PAYMENTS_STRIPE_WEBHOOK_SECRET.key, check.normalized, tx);
        nextConfig.stripeWebhookSecretLast4 = maskLast4(check.normalized);
        nextConfig.stripeLastSelfTestAt = null;
        nextConfig.stripeSelfTestedFingerprint = null;
        rotatedSecrets.push({ provider: "stripe", slot: "webhook_primary", operation: "rotated" });
      }

      if (input.clearStripeWebhookSecretSecondary) {
        await deps.settings.setSecret(PAYMENTS_STRIPE_WEBHOOK_SECRET_SECONDARY.key, null, tx);
        nextConfig.stripeWebhookSecretSecondaryLast4 = null;
        rotatedSecrets.push({ provider: "stripe", slot: "webhook_secondary", operation: "cleared" });
      } else if (hasNonBlankInput(input.stripeWebhookSecretSecondary)) {
        const check = validateStripeWebhookSecretInput(
          input.stripeWebhookSecretSecondary,
          "stripeWebhookSecretSecondary",
        );
        if (!check.ok) {
          throw new DomainError("VALIDATION", check.reasonCode, check.safeMessage, {
            field: check.field,
            reason: check.reason,
          });
        }
        await deps.settings.setSecret(
          PAYMENTS_STRIPE_WEBHOOK_SECRET_SECONDARY.key,
          check.normalized,
          tx,
        );
        nextConfig.stripeWebhookSecretSecondaryLast4 = maskLast4(check.normalized);
        rotatedSecrets.push({ provider: "stripe", slot: "webhook_secondary", operation: "rotated" });
      }

      if (input.clearSquareAccessToken) {
        await deps.settings.setSecret(PAYMENTS_SQUARE_ACCESS_TOKEN.key, null, tx);
        nextConfig.squareAccessTokenLast4 = null;
        rotatedSecrets.push({ provider: "square", slot: "access_token", operation: "cleared" });
      } else if (hasNonBlankInput(input.squareAccessToken)) {
        const check = validateSquareSecretInput(input.squareAccessToken, "squareAccessToken");
        if (!check.ok) {
          throw new DomainError("VALIDATION", check.reasonCode, check.safeMessage, {
            field: check.field,
            reason: check.reason,
          });
        }
        await deps.settings.setSecret(PAYMENTS_SQUARE_ACCESS_TOKEN.key, check.normalized, tx);
        nextConfig.squareAccessTokenLast4 = maskLast4(check.normalized);
        rotatedSecrets.push({ provider: "square", slot: "access_token", operation: "rotated" });
      }

      if (input.clearSquareWebhookSignatureKey) {
        await deps.settings.setSecret(PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY.key, null, tx);
        nextConfig.squareWebhookSignatureKeyLast4 = null;
        rotatedSecrets.push({ provider: "square", slot: "webhook_signature_key", operation: "cleared" });
      } else if (hasNonBlankInput(input.squareWebhookSignatureKey)) {
        const check = validateSquareSecretInput(
          input.squareWebhookSignatureKey,
          "squareWebhookSignatureKey",
        );
        if (!check.ok) {
          throw new DomainError("VALIDATION", check.reasonCode, check.safeMessage, {
            field: check.field,
            reason: check.reason,
          });
        }
        await deps.settings.setSecret(
          PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY.key,
          check.normalized,
          tx,
        );
        nextConfig.squareWebhookSignatureKeyLast4 = maskLast4(check.normalized);
        rotatedSecrets.push({ provider: "square", slot: "webhook_signature_key", operation: "rotated" });
      }

      const requiresFreshPairStrict =
        nextConfig.provider !== "none" &&
        (prev.mode !== nextConfig.mode ||
          (prev.provider !== "none" && prev.provider !== nextConfig.provider));

      if (nextConfig.provider === "stripe") {
        if (
          requiresFreshPairStrict &&
          (!normalizeCredentialInput(input.stripeSecretKey ?? "") ||
            !normalizeCredentialInput(input.stripeWebhookSecret ?? ""))
        ) {
          const missingField: CredentialFieldKey = !normalizeCredentialInput(
            input.stripeSecretKey ?? "",
          )
            ? "stripeSecretKey"
            : "stripeWebhookSecret";
          throw new DomainError(
            "VALIDATION",
            "FRESH_CREDENTIALS_REQUIRED",
            "Enter both a fresh Stripe API secret key and primary Stripe webhook signing secret when switching provider or environment.",
            { field: missingField, reason: "fresh_pair_required" },
          );
        }
        const [stripeKey, stripeWh] = await Promise.all([
          readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx),
          readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx),
        ]);
        if (!stripeKey || !stripeWh) {
          const missingField: CredentialFieldKey = !stripeKey
            ? "stripeSecretKey"
            : "stripeWebhookSecret";
          if (prev.provider !== "stripe") {
            throw new DomainError(
              "VALIDATION",
              "FRESH_CREDENTIALS_REQUIRED",
              "Configure both the Stripe API secret key and primary Stripe webhook signing secret before enabling Stripe.",
              { field: missingField, reason: "required" },
            );
          }
          throw new DomainError(
            "VALIDATION",
            "STRIPE_CREDENTIALS_REQUIRED",
            "Configure both the Stripe API secret key and primary Stripe webhook signing secret before enabling Stripe.",
            { field: missingField, reason: "required" },
          );
        }
        const expectedPrefix = nextConfig.mode === "live" ? /^(?:sk|rk)_live_/u : /^(?:sk|rk)_test_/u;
        if (!expectedPrefix.test(stripeKey)) {
          throw new DomainError(
            "VALIDATION",
            "STRIPE_KEY_MODE_MISMATCH",
            `Stripe API secret key must match ${nextConfig.mode} mode.`,
            {
              field: "stripeSecretKey",
              reason:
                nextConfig.mode === "live" ? "wrong_mode_test_in_live" : "wrong_mode_live_in_test",
            },
          );
        }
        if (egress.wired && !egress.stripeAllowlisted) {
          throw validation(
            "STRIPE_EGRESS_NOT_ALLOWLISTED",
            "Enable the Stripe outbound HTTPS allowlist preset (api.stripe.com:443) before activating Stripe Checkout.",
          );
        }

        const isActivatingStripe = prev.provider !== "stripe" || prev.mode !== nextConfig.mode;
        const rotatedStripePrimarySecret = rotatedSecrets.some(
          (s) =>
            s.provider === "stripe" &&
            s.operation === "rotated" &&
            (s.slot === "api_key" || s.slot === "webhook_primary"),
        );

        // In-place secret rotation on an already-activated same-mode Stripe setup saves the new secret
        // and pauses online card checkout (`onlineEnabled = false`) until re-verification completes.
        // Initial activation or switching modes/providers strictly requires completed verification first.
        if (isActivatingStripe || !rotatedStripePrimarySecret) {
          const expectedApiFp = computeStripeApiFingerprint(
            nextConfig.mode,
            stripeKey,
            egress.stripeEgressStamp,
          );
          if (
            !nextConfig.stripeLastApiVerifiedAt ||
            nextConfig.stripeApiVerifiedFingerprint !== expectedApiFp
          ) {
            throw validation(
              "STRIPE_API_NOT_VERIFIED",
              "Verify outbound Stripe API connectivity for the current staged secret key, mode, and outbound allowlist before activating Stripe Checkout.",
            );
          }
          const probe = diagnostics.lastStripeCheckoutProbe;
          const probeMatchesExpected = Boolean(
            probe &&
              probe.apiFingerprint === expectedApiFp &&
              probe.mode === nextConfig.mode,
          );
          if (isActivatingStripe) {
            if (!probeMatchesExpected) {
              throw validation(
                "STRIPE_CHECKOUT_SESSION_NOT_VERIFIED",
                'Run "Verify Checkout session creation" for the current staged Stripe API key and mode before activating Stripe Checkout.',
              );
            }
            if (!probe!.ok) {
              throw validation(
                "STRIPE_CHECKOUT_SESSION_NOT_VERIFIED",
                probe!.message ||
                  'Stripe Checkout session verification failed for the current staged key. Resolve the error and re-run "Verify Checkout session creation" before activating.',
              );
            }
          } else if (probeMatchesExpected && !probe!.ok) {
            throw validation(
              "STRIPE_CHECKOUT_SESSION_NOT_VERIFIED",
              probe!.message ||
                'Stripe Checkout session verification failed for the current staged key. Resolve the error and re-run "Verify Checkout session creation".',
            );
          }
          const expectedWhFp = computeStripeSelfTestFingerprint(nextConfig.mode, stripeWh);
          if (
            !nextConfig.stripeLastSelfTestAt ||
            nextConfig.stripeSelfTestedFingerprint !== expectedWhFp
          ) {
            throw validation(
              "STRIPE_WEBHOOK_NOT_VERIFIED",
              "Run a passing signed webhook self-test for the current staged signing secret and mode before activating Stripe Checkout.",
            );
          }
        }
      } else if (nextConfig.provider === "square") {
        const requiresSquareFresh =
          prev.provider !== nextConfig.provider || prev.mode !== nextConfig.mode;
        if (
          requiresSquareFresh &&
          (!normalizeCredentialInput(input.squareAccessToken ?? "") ||
            !normalizeCredentialInput(input.squareWebhookSignatureKey ?? ""))
        ) {
          const missingField: CredentialFieldKey = !normalizeCredentialInput(
            input.squareAccessToken ?? "",
          )
            ? "squareAccessToken"
            : "squareWebhookSignatureKey";
          throw new DomainError(
            "VALIDATION",
            "FRESH_CREDENTIALS_REQUIRED",
            "Enter both a fresh Square access token and webhook signature key when switching provider or environment.",
            { field: missingField, reason: "fresh_pair_required" },
          );
        }
        const [sqToken, sqSig] = await Promise.all([
          readSecret(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx),
          readSecret(deps.settings, PAYMENTS_SQUARE_WEBHOOK_SIGNATURE_KEY, tx),
        ]);
        if (!nextConfig.squareLocationId || !sqToken || !sqSig) {
          throw validation(
            "SQUARE_CREDENTIALS_REQUIRED",
            "Configure the Square location ID, access token, and webhook signature key before enabling Square.",
          );
        }
      }

      await writeSetting(deps.settings, PAYMENTS_CONFIG_SETTING, nextConfig, tx);
      if (prev.stripeLastApiVerifiedAt || prev.stripeLastSelfTestAt) {
        await updateDiagnosticsBestEffort(
          (prevDiag) => ({
            ...prevDiag,
            stripeEverApiVerified:
              prevDiag.stripeEverApiVerified || Boolean(prev.stripeLastApiVerifiedAt),
            stripeEverSelfTested:
              prevDiag.stripeEverSelfTested || Boolean(prev.stripeLastSelfTestAt),
          }),
          tx,
        );
      }
      if (input.smallTotals !== undefined) {
        const cleanedSmallTotals = parsePaymentsSmallTotals(input.smallTotals);
        await writeSetting(deps.settings, PAYMENTS_SMALL_TOTALS_SETTING, cleanedSmallTotals, tx);
      }
      if (input.receipts !== undefined) {
        const cleanedReceipts = parsePaymentsReceiptsSetting(input.receipts);
        await writeSetting(deps.settings, PAYMENTS_RECEIPTS_SETTING, cleanedReceipts, tx);
      }

      for (const secretOp of rotatedSecrets) {
        await deps.audit.record(
          {
            category: "security",
            eventName: "payments.secret.rotated",
            action: "update",
            outcome: "completed",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: { type: "payments_settings" },
            attributes: {
              provider: secretOp.provider,
              slot: secretOp.slot,
              operation: secretOp.operation,
              mode: nextConfig.mode,
            },
          },
          tx,
        );
      }

      await deps.audit.record(
        {
          category: "admin",
          eventName: "payments.settings.updated",
          action: "update",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "payments_settings" },
          attributes: {
            previous_provider: prev.provider,
            provider: nextConfig.provider,
            previous_mode: prev.mode,
            mode: nextConfig.mode,
            currency: nextConfig.currency,
            webhook_tolerance_seconds: nextConfig.webhookToleranceSeconds,
            rotated_secret_count: rotatedSecrets.length,
          },
        },
        tx,
      );
    });

    return buildAdminSettingsView();
  }

  async function adminReadiness(principal: SessionPrincipal): Promise<PaymentsReadinessView> {
    await assertAdminPaymentsRead(principal);
    const now = deps.clock.now();
    await pruneExpiredWebhookRejections(now);

    const [config, diagnostics] = await Promise.all([loadConfig(), loadDiagnostics()]);
    const [stripeKey, stripeWh, stripeWhSecSet, egress] = await Promise.all([
      readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY),
      readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET),
      isSecretConfigured(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET_SECONDARY),
      checkEgressPresets(config.mode),
    ]);

    const stripeKeySet = Boolean(stripeKey);
    const stripeWhSet = Boolean(stripeWh);
    const stripeState = resolveStripeVerificationState(config, stripeKey, stripeWh, egress);
    const secretKeyModeMatches = stripeState.secretKeyModeMatches;
    const gate = computeStripeGateSummary({
      config,
      stripeKeySet,
      stripeWhSet,
      stripeState,
      diagnostics,
    });

    const probe = diagnostics.lastStripeCheckoutProbe;
    const currentProbe =
      probe &&
      stripeState.expectedApiFp &&
      probe.apiFingerprint === stripeState.expectedApiFp &&
      probe.mode === config.mode
        ? probe
        : null;
    const checkoutSessionProbeFailed = Boolean(currentProbe && !currentProbe.ok);
    const checkoutSessionVerified = Boolean(currentProbe && currentProbe.ok);

    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [[lastRealWebhook], [attentionRow], [rejRow]] = await Promise.all([
      deps.db
        .select({
          receivedAt: paymentWebhookEvents.receivedAt,
          eventType: paymentWebhookEvents.eventType,
        })
        .from(paymentWebhookEvents)
        .where(
          and(
            eq(paymentWebhookEvents.provider, "stripe"),
            ne(paymentWebhookEvents.eventType, "readypackets.self_test"),
          ),
        )
        .orderBy(desc(paymentWebhookEvents.id))
        .limit(1),
      deps.db
        .select({ total: count() })
        .from(paymentWebhookEvents)
        .where(
          and(
            eq(paymentWebhookEvents.provider, "stripe"),
            eq(paymentWebhookEvents.status, "attention_required"),
          ),
        ),
      deps.db
        .select({ total: count() })
        .from(paymentWebhookRejections)
        .where(
          and(
            eq(paymentWebhookRejections.provider, "stripe"),
            gte(paymentWebhookRejections.receivedAt, cutoff24h),
          ),
        ),
    ]);

    const egressReady = stripeState.egressOk;
    const onlineEnabled = config.provider === "stripe" && stripeState.ready && !checkoutSessionProbeFailed;

    const webhookUrl = new URL("/api/payments/webhooks/stripe", deps.config.canonicalOrigin).href;

    const checklist: PaymentsReadinessChecklistItem[] = [
      {
        key: "egress_allowlist",
        label: "Outbound allowlist for api.stripe.com",
        ready: egressReady,
        detail: egress.stripeAllowlisted
          ? "Outbound HTTPS to api.stripe.com:443 is enabled."
          : egress.wired
            ? "Enable the Stripe outbound allowlist preset before calling the Stripe API."
            : "Outbound allowlist service not attached in this environment.",
      },
      {
        key: "webhook_route_protection",
        label: "Inbound webhook route country-allowlist exemption",
        ready: true,
        detail:
          "POST /api/payments/webhooks/stripe bypasses country geo-blocking while preserving IP block rules, rate limiting, and the 256 KiB raw-body cap.",
      },
      {
        key: "stripe_secret_key",
        label: `Stripe ${config.mode} API secret key staged`,
        ready: stripeKeySet && secretKeyModeMatches,
        detail: !stripeKeySet
          ? `Stage a Stripe ${config.mode} secret key (${config.mode === "live" ? "sk_live_ / rk_live_" : "sk_test_ / rk_test_"}).`
          : secretKeyModeMatches
            ? `Secret key ending in ${config.stripeSecretKeyLast4 ?? "••••"} matches ${config.mode} mode.`
            : `Staged secret key does not match ${config.mode} mode.`,
      },
      {
        key: "stripe_webhook_secret",
        label: "Primary Stripe webhook signing secret staged",
        ready: stripeWhSet,
        detail: stripeWhSet
          ? `Primary signing secret ending in ${config.stripeWebhookSecretLast4 ?? "••••"} is configured.`
          : "Stage the whsec_ signing secret from your Stripe webhook endpoint.",
      },
      {
        key: "api_connection_verified",
        label: "Pinned Stripe API connection verified",
        ready: stripeState.apiVerified,
        detail: stripeState.effectiveLastApiVerifiedAt
          ? `Verified at ${stripeState.effectiveLastApiVerifiedAt} for the current staged key, mode, and outbound allowlist.`
          : "Run Test Stripe API to verify egress and key livemode for the current staged key.",
      },
      {
        key: "checkout_session_verified",
        label: "Checkout session creation verified",
        ready: checkoutSessionVerified || (config.provider === "stripe" && !checkoutSessionProbeFailed),
        detail: checkoutSessionProbeFailed
          ? currentProbe!.message
          : checkoutSessionVerified
            ? `Verified at ${currentProbe!.checkedAt} — probe Checkout Session created and immediately expired at zero cost.`
            : config.provider === "stripe"
              ? 'Recommended check (online card checkout remains active): run "Verify Checkout session creation" to confirm Checkout Sessions write permission and redirect domain.'
              : 'Required before activating Stripe Checkout: run "Verify Checkout session creation" to confirm Checkout Sessions write permission and redirect domain.',
      },
      {
        key: "self_test_webhook_verified",
        label: "Signed webhook receiver self-test passed",
        ready: stripeState.selfTestVerified,
        detail: stripeState.effectiveLastSelfTestAt
          ? `Verified at ${stripeState.effectiveLastSelfTestAt} for the current staged signing secret and mode.`
          : "Run Send self-test webhook to verify HMAC signature and timestamp handling.",
      },
      {
        key: "provider_activated",
        label: "Stripe online checkout activated",
        ready: onlineEnabled,
        detail: onlineEnabled
          ? `Online Stripe checkout is active in ${config.mode} mode.`
          : config.provider === "stripe"
            ? "Stripe is selected, but one or more prerequisites above are incomplete or unverified; card checkout is paused until resolved."
            : "Provider is currently set to off (invoice-only). Activate Stripe when ready.",
      },
    ];

    const effectiveMissingGates: StripeMissingGateKey[] = checkoutSessionProbeFailed
      ? [...gate.missingGates, "checkout_session_failed"]
      : config.provider !== "stripe" && !checkoutSessionVerified
        ? [...gate.missingGates, "checkout_session_not_verified"]
        : gate.missingGates;

    return {
      provider: config.provider,
      mode: config.mode,
      currency: config.currency,
      onlineEnabled,
      statusHeadline:
        config.provider === "stripe" && checkoutSessionProbeFailed
          ? "Online card checkout: NOT ACTIVE (Checkout session verification failed)"
          : gate.statusHeadline,
      customerExperienceSummary:
        config.provider === "stripe" && checkoutSessionProbeFailed
          ? "Stripe Checkout session creation failed during verification. Customers cannot complete online card payment until resolved."
          : gate.customerExperienceSummary,
      reverificationNeeded: gate.reverificationNeeded,
      reverificationReasons: gate.reverificationReasons,
      missingGates: effectiveMissingGates,
      lastCheckoutFailure: diagnostics.lastCheckoutFailure,
      lastCheckoutProbe: currentProbe,
      webhookUrl,
      requiredWebhookEvents: [...STRIPE_REQUIRED_WEBHOOK_EVENTS],
      egress: {
        presetKey: "stripe",
        host: "api.stripe.com",
        allowlisted: egressReady,
      },
      routeProtection: {
        webhookPath: "/api/payments/webhooks/stripe",
        countryAllowlistExempt: true,
        ipRulesEnforced: true,
        rateLimitEnforced: true,
        bodyCapBytes: 262144,
      },
      secrets: {
        secretKeyConfigured: stripeKeySet,
        secretKeyLast4: stripeKeySet ? config.stripeSecretKeyLast4 : null,
        secretKeyModeMatches,
        webhookSecretConfigured: stripeWhSet,
        webhookSecretLast4: stripeWhSet ? config.stripeWebhookSecretLast4 : null,
        webhookSecretSecondaryConfigured: stripeWhSecSet,
        webhookSecretSecondaryLast4: stripeWhSecSet ? config.stripeWebhookSecretSecondaryLast4 : null,
      },
      verification: {
        lastApiVerifiedAt: stripeState.effectiveLastApiVerifiedAt,
        lastSelfTestAt: stripeState.effectiveLastSelfTestAt,
        checkoutSessionVerified,
        lastCheckoutSessionVerifiedAt:
          checkoutSessionVerified && currentProbe ? currentProbe.checkedAt : null,
        lastVerifiedWebhookAt: lastRealWebhook?.receivedAt
          ? lastRealWebhook.receivedAt.toISOString()
          : null,
        lastVerifiedWebhookEventType: lastRealWebhook?.eventType ?? null,
        attentionRequiredWebhookCount: attentionRow?.total ?? 0,
        recentRejectionCount24h: rejRow?.total ?? 0,
      },
      checklist,
    };
  }

  async function adminTestConnection(principal: SessionPrincipal): Promise<TestStripeConnectionResult> {
    const stagedCheck = await runComplianceTx(
      deps,
      principal,
      { type: "payments_settings" },
      async (tx) => {
        const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.manage");
        const config = await loadConfig(tx);
        const stripeKey = await readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx);
        if (!stripeKey) {
          throw new DomainError(
            "VALIDATION",
            "STRIPE_CREDENTIALS_REQUIRED",
            "Stage a Stripe API secret key before testing the Stripe API connection.",
            { field: "stripeSecretKey", reason: "required" },
          );
        }
        const expectedPrefix = config.mode === "live" ? /^(?:sk|rk)_live_/u : /^(?:sk|rk)_test_/u;
        if (!expectedPrefix.test(stripeKey)) {
          throw new DomainError(
            "VALIDATION",
            "STRIPE_KEY_MODE_MISMATCH",
            `Stripe API secret key must match ${config.mode} mode.`,
            {
              field: "stripeSecretKey",
              reason: config.mode === "live" ? "wrong_mode_test_in_live" : "wrong_mode_live_in_test",
            },
          );
        }
        return { liveActor, config, stripeKey };
      },
    );

    if (typeof adapters.stripe.testConnection !== "function") {
      throw new DomainError(
        "UNAVAILABLE",
        "STRIPE_CONNECTION_TEST_UNAVAILABLE",
        "Stripe connection testing is not supported by the active adapter.",
      );
    }

    const now = deps.clock.now();
    const res = await adapters.stripe.testConnection({
      credentials: { mode: stagedCheck.config.mode, secretKey: stagedCheck.stripeKey },
      now,
    });

    const failureReasonCode = res.ok ? null : (res.reasonCode ?? "STRIPE_CONNECTION_FAILED");
    const livemode = res.ok ? stagedCheck.config.mode === "live" : null;
    const detail = res.ok
      ? `Connected to api.stripe.com in ${stagedCheck.config.mode} mode (${res.latencyMs}ms).`
      : failureReasonCode === "STRIPE_AUTH_INVALID_KEY"
        ? "Stripe rejected the staged secret key (HTTP 401)."
        : failureReasonCode === "STRIPE_KEY_MISSING_PERMISSION"
          ? "Staged restricted key lacks Checkout Sessions read permission (HTTP 403)."
          : failureReasonCode === "STRIPE_KEY_MODE_MISMATCH"
            ? `Staged secret key does not match ${stagedCheck.config.mode} mode.`
            : `Outbound connection to api.stripe.com failed (${failureReasonCode}). Enable the Stripe outbound allowlist preset and try again.`;

    const verifiedAt = res.ok ? (res.verifiedAt ?? now).toISOString() : null;
    const egress = await checkEgressPresets(stagedCheck.config.mode);
    await deps.db.transaction(async (tx) => {
      const latest = await loadConfig(tx);
      const currentKey = await readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx);
      const sameKeyAndMode =
        latest.mode === stagedCheck.config.mode && currentKey === stagedCheck.stripeKey;
      if (!sameKeyAndMode) return;
      await writeSetting(
        deps.settings,
        PAYMENTS_CONFIG_SETTING,
        res.ok && verifiedAt
          ? {
              ...latest,
              stripeLastApiVerifiedAt: verifiedAt,
              stripeApiVerifiedFingerprint: computeStripeApiFingerprint(
                latest.mode,
                stagedCheck.stripeKey,
                egress.stripeEgressStamp,
              ),
            }
          : {
              ...latest,
              stripeLastApiVerifiedAt: null,
              stripeApiVerifiedFingerprint: null,
            },
        tx,
      );
      if (res.ok && verifiedAt) {
        await updateDiagnosticsBestEffort(
          (prevDiag) => ({
            ...prevDiag,
            stripeEverApiVerified: true,
          }),
          tx,
        );
      }
    });

    await deps.audit.record({
      category: "integration",
      eventName: "payments.connection.tested",
      action: "verify",
      outcome: res.ok ? "completed" : "failed",
      ...(res.ok
        ? {}
        : {
            severity: "WARN" as const,
            reasonCode: failureReasonCode ?? "STRIPE_CONNECTION_FAILED",
          }),
      actor: { userId: stagedCheck.liveActor.userId, role: stagedCheck.liveActor.role },
      resource: { type: "payments_settings" },
      attributes: {
        provider: "stripe",
        mode: stagedCheck.config.mode,
        livemode,
        ...(failureReasonCode ? { failure_reason_code: failureReasonCode } : {}),
      },
    });

    return {
      ok: res.ok,
      provider: "stripe",
      mode: stagedCheck.config.mode,
      livemode,
      accountRef: null,
      verifiedAt,
      failureReasonCode,
      detail,
      message: detail,
    };
  }

  async function adminVerifyCheckoutSession(
    principal: SessionPrincipal,
  ): Promise<VerifyStripeCheckoutSessionResult> {
    const stagedCheck = await runComplianceTx(
      deps,
      principal,
      { type: "payments_settings" },
      async (tx) => {
        const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.manage");
        const config = await loadConfig(tx);
        const stripeKey = await readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx);
        if (!stripeKey) {
          throw new DomainError(
            "VALIDATION",
            "STRIPE_CREDENTIALS_REQUIRED",
            "Stage a Stripe API secret key before verifying Checkout session creation.",
            { field: "stripeSecretKey", reason: "required" },
          );
        }
        const expectedPrefix = config.mode === "live" ? /^(?:sk|rk)_live_/u : /^(?:sk|rk)_test_/u;
        if (!expectedPrefix.test(stripeKey)) {
          throw new DomainError(
            "VALIDATION",
            "STRIPE_KEY_MODE_MISMATCH",
            `Stripe API secret key must match ${config.mode} mode.`,
            {
              field: "stripeSecretKey",
              reason: config.mode === "live" ? "wrong_mode_test_in_live" : "wrong_mode_live_in_test",
            },
          );
        }
        return { liveActor, config, stripeKey };
      },
    );

    if (typeof adapters.stripe.verifyCheckoutSession !== "function") {
      throw new DomainError(
        "UNAVAILABLE",
        "STRIPE_CHECKOUT_VERIFY_UNAVAILABLE",
        "Stripe Checkout session verification is not supported by the active adapter.",
      );
    }

    const now = deps.clock.now();
    const res = await adapters.stripe.verifyCheckoutSession({
      credentials: { mode: stagedCheck.config.mode, secretKey: stagedCheck.stripeKey },
      currency: stagedCheck.config.currency,
      canonicalOrigin: deps.config.canonicalOrigin,
      now,
    });

    const failureReasonCode = res.ok ? null : (res.reasonCode ?? "STRIPE_CHECKOUT_VERIFY_FAILED");
    const upstreamStatus = res.upstreamStatus ?? null;
    const stripeErrorType = sanitizeStripeDiagnosticToken(res.stripeErrorType);
    const stripeErrorCode = sanitizeStripeDiagnosticToken(res.stripeErrorCode);
    const stripeErrorParam = sanitizeStripeDiagnosticToken(res.stripeErrorParam, {
      allowBrackets: true,
    });
    const verifiedAt = res.ok ? (res.verifiedAt ?? now).toISOString() : null;
    const checkedAtIso = (res.verifiedAt ?? now).toISOString();
    const livemode = res.ok ? stagedCheck.config.mode === "live" : null;

    const detail = res.ok
      ? res.expiredImmediately
        ? `Created and immediately expired an unpaid Stripe Checkout session on checkout.stripe.com in ${stagedCheck.config.mode} mode (${res.latencyMs}ms). No charge was made.`
        : `Created an unpaid Stripe Checkout session on checkout.stripe.com in ${stagedCheck.config.mode} mode (${res.latencyMs}ms); immediate expire call did not complete and the session will expire automatically.`
      : failureReasonCode === "STRIPE_AUTH_INVALID_KEY"
        ? "Stripe rejected the staged secret key (HTTP 401). Confirm the key in Stripe Dashboard > Developers > API keys."
        : failureReasonCode === "STRIPE_KEY_MISSING_PERMISSION"
          ? "Staged restricted key cannot create Checkout Sessions (HTTP 403). Grant Checkout Sessions: Write permission on this restricted key in Stripe."
          : failureReasonCode === "STRIPE_UNTRUSTED_REDIRECT_URL"
            ? "Stripe returned a Checkout URL outside checkout.stripe.com (such as a custom Checkout domain). ReadyPackets enforces checkout.stripe.com redirects; disable custom Checkout domains on this Stripe account before activating."
            : failureReasonCode === "STRIPE_KEY_MODE_MISMATCH" || failureReasonCode === "STRIPE_MODE_MISMATCH"
              ? `Stripe Checkout session livemode did not match configured ${stagedCheck.config.mode} mode.`
              : failureReasonCode === "STRIPE_INVALID_REQUEST"
                ? `Stripe rejected the Checkout session request (HTTP ${upstreamStatus ?? 400}${stripeErrorCode ? `, code: ${stripeErrorCode}` : ""}). Confirm your Stripe account is enabled for ${stagedCheck.config.currency} card payments.`
                : failureReasonCode && failureReasonCode.startsWith("EGRESS_")
                  ? `Outbound connection to api.stripe.com was blocked by egress policy (${failureReasonCode}). Enable the Stripe outbound allowlist preset and try again.`
                  : `Checkout session verification failed (${failureReasonCode}${upstreamStatus ? `, HTTP ${upstreamStatus}` : ""}).`;

    const egress = await checkEgressPresets(stagedCheck.config.mode);
    const fingerprint = computeStripeApiFingerprint(
      stagedCheck.config.mode,
      stagedCheck.stripeKey,
      egress.stripeEgressStamp,
    );

    await deps.db.transaction(async (tx) => {
      const latest = await loadConfig(tx);
      const currentKey = await readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx);
      const sameKeyAndMode =
        latest.mode === stagedCheck.config.mode && currentKey === stagedCheck.stripeKey;
      if (!sameKeyAndMode) return;

      if (res.ok && verifiedAt) {
        await writeSetting(
          deps.settings,
          PAYMENTS_CONFIG_SETTING,
          {
            ...latest,
            stripeLastApiVerifiedAt: latest.stripeLastApiVerifiedAt ?? verifiedAt,
            stripeApiVerifiedFingerprint: fingerprint,
          },
          tx,
        );
      }

      await updateDiagnosticsBestEffort(
        (prevDiag) => ({
          ...prevDiag,
          stripeEverApiVerified: prevDiag.stripeEverApiVerified || Boolean(res.ok && verifiedAt),
          lastStripeCheckoutProbe: {
            checkedAt: checkedAtIso,
            mode: stagedCheck.config.mode,
            apiFingerprint: fingerprint,
            ok: res.ok,
            reasonCode: failureReasonCode ?? "CHECKOUT_SESSION_OK",
            upstreamStatus,
            stripeErrorType,
            stripeErrorCode,
            message: detail.slice(0, 300),
          },
        }),
        tx,
      );
    });

    await deps.audit.record({
      category: "integration",
      eventName: "payments.checkout_session.verified",
      action: "verify",
      outcome: res.ok ? "completed" : "failed",
      ...(res.ok
        ? {}
        : {
            severity: "WARN" as const,
            reasonCode: failureReasonCode ?? "STRIPE_CHECKOUT_VERIFY_FAILED",
          }),
      actor: { userId: stagedCheck.liveActor.userId, role: stagedCheck.liveActor.role },
      resource: { type: "payments_settings" },
      attributes: {
        provider: "stripe",
        mode: stagedCheck.config.mode,
        currency: stagedCheck.config.currency,
        expired_immediately: res.expiredImmediately,
        ...(upstreamStatus !== null ? { upstream_http_status: upstreamStatus } : {}),
        ...(stripeErrorType ? { stripe_error_type: stripeErrorType } : {}),
        ...(stripeErrorCode ? { stripe_error_code: stripeErrorCode } : {}),
        ...(stripeErrorParam ? { stripe_error_param: stripeErrorParam } : {}),
        ...(failureReasonCode ? { failure_reason_code: failureReasonCode } : {}),
      },
    });

    return {
      ok: res.ok,
      provider: "stripe",
      mode: stagedCheck.config.mode,
      livemode,
      sessionId: res.sessionId,
      expiredImmediately: res.expiredImmediately,
      verifiedAt,
      failureReasonCode,
      upstreamStatus,
      stripeErrorType,
      stripeErrorCode,
      stripeErrorParam,
      detail,
      message: detail,
    };
  }

  async function adminSendSelfTestWebhook(
    principal: SessionPrincipal,
  ): Promise<SendStripeSelfTestWebhookResult> {
    const stagedCheck = await runComplianceTx(
      deps,
      principal,
      { type: "payments_settings" },
      async (tx) => {
        const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.manage");
        const config = await loadConfig(tx);
        const stripeWh = await readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx);
        if (!stripeWh) {
          throw new DomainError(
            "VALIDATION",
            "STRIPE_CREDENTIALS_REQUIRED",
            "Stage the primary Stripe webhook signing secret before running a self-test webhook.",
            { field: "stripeWebhookSecret", reason: "required" },
          );
        }
        return { liveActor, config, stripeWh };
      },
    );

    const now = deps.clock.now();
    const built = buildSignedStripeSelfTestWebhook({
      webhookSecret: stagedCheck.stripeWh,
      mode: stagedCheck.config.mode,
      now,
    });
    const notificationUrl = new URL("/api/payments/webhooks/stripe", deps.config.canonicalOrigin).href;
    const dispatched = await handleSignedWebhook({
      provider: "stripe",
      rawBody: built.rawBody,
      headers: built.headers,
      notificationUrl,
    });

    const ok = dispatched.accepted && dispatched.reasonCode === "SELF_TEST_OK";
    const verifiedAt = ok ? deps.clock.now().toISOString() : null;

    await deps.db.transaction(async (tx) => {
      const latest = await loadConfig(tx);
      const currentWh = await readSecret(deps.settings, PAYMENTS_STRIPE_WEBHOOK_SECRET, tx);
      const sameWhAndMode =
        latest.mode === stagedCheck.config.mode && currentWh === stagedCheck.stripeWh;
      if (!sameWhAndMode) return;
      await writeSetting(
        deps.settings,
        PAYMENTS_CONFIG_SETTING,
        ok && verifiedAt
          ? {
              ...latest,
              stripeLastSelfTestAt: verifiedAt,
              stripeSelfTestedFingerprint: computeStripeSelfTestFingerprint(
                latest.mode,
                stagedCheck.stripeWh,
              ),
            }
          : {
              ...latest,
              stripeLastSelfTestAt: null,
              stripeSelfTestedFingerprint: null,
            },
        tx,
      );
      if (ok && verifiedAt) {
        await updateDiagnosticsBestEffort(
          (prevDiag) => ({
            ...prevDiag,
            stripeEverSelfTested: true,
          }),
          tx,
        );
      }
    });

    await deps.audit.record({
      category: "integration",
      eventName: "payments.webhook.self_tested",
      action: "verify",
      outcome: ok ? "completed" : "failed",
      ...(ok ? {} : { severity: "WARN" as const, reasonCode: dispatched.reasonCode }),
      actor: { userId: stagedCheck.liveActor.userId, role: stagedCheck.liveActor.role },
      resource: { type: "payments_settings" },
      attributes: {
        provider: "stripe",
        mode: stagedCheck.config.mode,
        external_event_id: built.eventId,
        http_status: dispatched.httpStatus,
        reason_code: dispatched.reasonCode,
      },
    });

    return {
      ok,
      externalEventId: built.eventId,
      httpStatus: dispatched.httpStatus,
      reasonCode: dispatched.reasonCode,
      verifiedAt,
    };
  }

  async function adminListWebhookRejections(
    principal: SessionPrincipal,
    input: ListWebhookRejectionsInput = {},
  ): Promise<{ items: PaymentWebhookRejectionSummary[]; nextCursor: string | null }> {
    await assertAdminPaymentsRead(principal);
    const now = deps.clock.now();
    await pruneExpiredWebhookRejections(now);

    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const afterId = decodeIdCursor(input.cursor);
    const cutoff = new Date(now.getTime() - WEBHOOK_REJECTION_RETENTION_MS);

    const conds = [gte(paymentWebhookRejections.receivedAt, cutoff)];
    if (afterId !== null) conds.push(lt(paymentWebhookRejections.id, afterId));
    if (input.provider) conds.push(eq(paymentWebhookRejections.provider, input.provider));
    if (input.reasonCode) {
      conds.push(
        inArray(paymentWebhookRejections.reasonCode, expandWebhookRejectionReasonFilter(input.reasonCode)),
      );
    }

    const rows = await deps.db
      .select()
      .from(paymentWebhookRejections)
      .where(and(...conds))
      .orderBy(desc(paymentWebhookRejections.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: slice.map(toWebhookRejectionSummary),
      nextCursor: hasMore && slice.length > 0 ? encodeIdCursor(slice[slice.length - 1]!.id) : null,
    };
  }

  async function adminListAttempts(
    principal: SessionPrincipal,
    input: {
      status?: PaymentAttemptStatus | undefined;
      provider?: ActivePaymentProvider | undefined;
      invoicePublicId?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<{ items: AdminPaymentAttemptSummary[]; nextCursor: string | null }> {
    await assertAdminPaymentsRead(principal);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const afterId = decodeIdCursor(input.cursor);

    const conds = [];
    if (afterId !== null) conds.push(lt(paymentAttempts.id, afterId));
    if (input.status) conds.push(eq(paymentAttempts.status, input.status));
    if (input.provider) conds.push(eq(paymentAttempts.provider, input.provider));
    if (input.invoicePublicId) conds.push(eq(paymentAttempts.invoicePublicId, input.invoicePublicId));

    const rows = await deps.db
      .select()
      .from(paymentAttempts)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(paymentAttempts.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: slice.map(toAdminAttemptSummary),
      nextCursor: hasMore && slice.length > 0 ? encodeIdCursor(slice[slice.length - 1]!.id) : null,
    };
  }

  async function adminGetAttempt(
    principal: SessionPrincipal,
    attemptPublicId: string,
  ): Promise<AdminPaymentAttemptDetail> {
    await assertAdminPaymentsRead(principal);
    const [attempt] = await deps.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, attemptPublicId))
      .limit(1);
    if (!attempt) throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");

    const webhooks = await deps.db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.attemptId, attempt.id))
      .orderBy(desc(paymentWebhookEvents.id))
      .limit(50);

    return {
      attempt: toAdminAttemptSummary(attempt),
      webhooks: webhooks.map(toAdminWebhookSummary),
    };
  }

  async function adminListWebhooks(
    principal: SessionPrincipal,
    input: {
      provider?: ActivePaymentProvider | undefined;
      status?: PaymentWebhookStatus | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<{ items: AdminPaymentWebhookSummary[]; nextCursor: string | null }> {
    await assertAdminPaymentsRead(principal);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const afterId = decodeIdCursor(input.cursor);

    const conds = [];
    if (afterId !== null) conds.push(lt(paymentWebhookEvents.id, afterId));
    if (input.provider) conds.push(eq(paymentWebhookEvents.provider, input.provider));
    if (input.status) conds.push(eq(paymentWebhookEvents.status, input.status));

    const rows = await deps.db
      .select()
      .from(paymentWebhookEvents)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(paymentWebhookEvents.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: slice.map(toAdminWebhookSummary),
      nextCursor: hasMore && slice.length > 0 ? encodeIdCursor(slice[slice.length - 1]!.id) : null,
    };
  }

  async function adminReconcileNow(
    principal: SessionPrincipal,
    input?: { limit?: number | undefined },
  ): Promise<ReconcilePaymentsResult> {
    await runComplianceTx(deps, principal, { type: "payment_attempt" }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.manage");
      await deps.audit.record(
        {
          category: "admin",
          eventName: "payments.reconcile.triggered",
          action: "execute",
          outcome: "attempted",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "payment_attempt" },
        },
        tx,
      );
    });

    const result = await reconcilePendingAttempts({ limit: input?.limit ?? 25 });

    await deps.audit.record({
      category: "admin",
      eventName: "payments.reconcile.completed",
      action: "execute",
      outcome: "completed",
      actor: { userId: principal.userId, role: principal.role },
      resource: { type: "payment_attempt" },
      safeCounts: {
        scanned: result.scanned,
        booked: result.booked,
        expired: result.expired,
        failed: result.failed,
        still_pending: result.stillPending,
      },
    });

    return result;
  }

  /**
   * Increment 08 D5 step-up admin repair & live status check (`payments.admin.checkWithStripeNow`):
   * Accepts `{ attemptPublicId }` or `{ invoicePublicId }`, requires `payments.manage` + fresh step-up,
   * inspects Stripe Checkout session(s) over pinned TLS (including attempts left in `redirected`,
   * `expired`, `cancelled`, or `failed` before the upgrade), and books any verified paid session
   * idempotently via `bookAuthoritativeAttemptPaymentInTx` (`allowRepair: true`).
   */
  async function adminCheckWithStripeNow(
    principal: SessionPrincipal,
    input: AdminCheckWithStripeInput,
    opts?: { signal?: AbortSignal | undefined; beforeSend?: (() => Promise<void>) | undefined },
  ): Promise<AdminCheckWithStripeResult> {
    if (!input.attemptPublicId && !input.invoicePublicId) {
      throw validation("MISSING_STRIPE_CHECK_TARGET", "Provide attemptPublicId or invoicePublicId.");
    }
    requireComplianceService();

    const staged = await runComplianceTx(
      deps,
      principal,
      { type: "payment_attempt", publicId: input.attemptPublicId ?? input.invoicePublicId },
      async (tx) => {
        const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.manage");
        const complianceSvc = requireComplianceService();

        let candidates: PaymentAttemptRow[];
        let targetInvoicePublicId: string;
        if (input.attemptPublicId) {
          const [found] = await tx
            .select()
            .from(paymentAttempts)
            .where(eq(paymentAttempts.publicId, input.attemptPublicId))
            .limit(1);
          if (!found) {
            throw notFound("PAYMENT_ATTEMPT_NOT_FOUND");
          }
          if (found.provider !== "stripe") {
            throw validation("NOT_STRIPE_ATTEMPT", "Selected payment attempt was not created with Stripe.");
          }
          targetInvoicePublicId = found.invoicePublicId;
          candidates = [found];
        } else {
          targetInvoicePublicId = input.invoicePublicId!;
          candidates = await tx
            .select()
            .from(paymentAttempts)
            .where(
              and(
                eq(paymentAttempts.invoicePublicId, targetInvoicePublicId),
                eq(paymentAttempts.provider, "stripe"),
              ),
            )
            .orderBy(desc(paymentAttempts.id))
            .limit(10);
        }

        const invoice = await complianceSvc.getInvoiceForCheckout(targetInvoicePublicId, { tx });

        await deps.audit.record(
          {
            category: "admin",
            eventName: "payments.admin.stripe_check_triggered",
            action: "execute",
            outcome: "attempted",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: {
              type: "payment_attempt",
              publicId: input.attemptPublicId ?? targetInvoicePublicId,
            },
            orderPublicId: invoice.orderPublicId,
            attributes: {
              invoice_public_id: targetInvoicePublicId,
              attempt_public_id: input.attemptPublicId ?? null,
              candidate_count: candidates.length,
            },
          },
          tx,
        );

        const credentialsByEnv = new Map<
          PaymentEnvironmentMode,
          { credentials: ProviderCredentials; keyDigest: string }
        >();
        for (const cand of candidates) {
          if (!cand.providerRef || cand.status === "paid" || credentialsByEnv.has(cand.environment)) {
            continue;
          }
          const loaded = await loadStripeLookupCredentials(cand.environment, {
            tx,
            allowDisabledProvider: true,
          });
          credentialsByEnv.set(cand.environment, loaded);
        }

        return {
          liveActor,
          invoice,
          targetInvoicePublicId,
          candidates,
          credentialsByEnv,
        };
      },
    );

    if (staged.candidates.length === 0) {
      return {
        checkedCount: 0,
        booked: false,
        alreadyPaid: staged.invoice.status === "paid",
        invoicePublicId: staged.invoice.invoicePublicId,
        invoiceStatus: staged.invoice.status,
        receiptPublicId: staged.invoice.receiptPublicId ?? null,
        attemptPublicId: null,
        attemptStatus: null,
        bookingSource: null,
        reasonCode: "NO_STRIPE_ATTEMPTS",
      };
    }

    const paidExisting = staged.candidates.find((c) => c.status === "paid");
    if (staged.invoice.status === "paid" || paidExisting) {
      const ref = paidExisting ?? staged.candidates[0]!;
      return {
        checkedCount: 0,
        booked: false,
        alreadyPaid: true,
        invoicePublicId: staged.invoice.invoicePublicId,
        invoiceStatus: "paid",
        receiptPublicId: staged.invoice.receiptPublicId ?? null,
        attemptPublicId: ref.publicId,
        attemptStatus: ref.status,
        bookingSource: ref.bookingSource,
        reasonCode: "ALREADY_PAID",
      };
    }

    const fetchedEntries: Array<{
      candidate: PaymentAttemptRow;
      fetched: ProviderFetchedPayment;
      keyDigest: string;
    }> = [];
    for (const cand of staged.candidates) {
      if (!cand.providerRef) continue;
      const envCreds = staged.credentialsByEnv.get(cand.environment);
      if (!envCreds) continue;
      const fetched = await adapters.stripe.fetchPayment({
        providerRef: cand.providerRef,
        providerOrderRef: cand.providerOrderRef,
        providerPaymentRef: cand.providerPaymentRef,
        credentials: envCreds.credentials,
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(opts?.beforeSend ? { beforeSend: opts.beforeSend } : {}),
      });
      fetchedEntries.push({ candidate: cand, fetched, keyDigest: envCreds.keyDigest });
      if (fetched.status === "paid") {
        break;
      }
    }

    return runWithMysqlDeadlockRetry(() =>
      runComplianceTx(
        deps,
        principal,
        { type: "payment_attempt", publicId: input.attemptPublicId ?? staged.targetInvoicePublicId },
        async (tx) => {
        const complianceSvc = requireComplianceService();
        // Lock parent `orders -> compliance_invoices` FIRST before actor/attempt locks so lock order
        // is deadlock-free and post-wait reads see current committed state under MySQL RR.
        const lockedInvoice = await complianceSvc.getInvoiceForCheckout(staged.targetInvoicePublicId, {
          tx,
          forUpdate: true,
        });
        const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.manage");
        let lastReasonCode = "STILL_UNPAID";
        let primaryAttempt: PaymentAttemptRow = staged.candidates[0]!;
        let didBook = false;
        let wasAlreadyPaid = false;

        for (const entry of fetchedEntries) {
          const postCreds = await loadStripeLookupCredentials(entry.candidate.environment, {
            tx,
            allowDisabledProvider: true,
          });
          if (postCreds.keyDigest !== entry.keyDigest) {
            throw conflict("STRIPE_CREDENTIALS_CHANGED", "Stripe credentials changed during verification; retry.");
          }

          if (entry.fetched.status === "paid") {
            const booked = await bookAuthoritativeAttemptPaymentInTx(tx, {
              attemptId: entry.candidate.id,
              source: "provider_lookup",
              fetched: entry.fetched,
              actor: { userId: liveActor.userId, role: liveActor.role },
              allowRepair: true,
            });
            primaryAttempt = booked.attempt ?? entry.candidate;
            lastReasonCode = booked.reasonCode;
            if (booked.booked) {
              didBook = !booked.alreadyPaid;
              wasAlreadyPaid = booked.alreadyPaid;
              break;
            }
            continue;
          }

          const [locked] = await tx
            .select()
            .from(paymentAttempts)
            .where(eq(paymentAttempts.id, entry.candidate.id))
            .for("update")
            .limit(1);
          if (!locked) continue;
          primaryAttempt = locked;
          if (lockedInvoice.status === "paid" || locked.status === "paid") {
            wasAlreadyPaid = true;
            lastReasonCode = "ALREADY_PAID";
            break;
          }
          if (lockedInvoice.status === "void" || lockedInvoice.voidedAt !== null) {
            lastReasonCode = "INVOICE_VOIDED";
            continue;
          }
          if (locked.status !== "created" && locked.status !== "redirected") {
            lastReasonCode = locked.status === "expired" || entry.fetched.status === "expired" ? "SESSION_EXPIRED" : "STILL_UNPAID";
            continue;
          }

          const bindingCheck = checkFetchedBindingMatchesAttempt(locked, entry.fetched);
          if (!bindingCheck.matches) {
            await recordLookupMismatchInTx(tx, locked, entry.fetched, bindingCheck.reasonCode, {
              userId: liveActor.userId,
              role: liveActor.role,
            });
            lastReasonCode = bindingCheck.reasonCode;
            continue;
          }

          const now = deps.clock.now();
          if (entry.fetched.asyncPending) {
            await tx
              .update(paymentAttempts)
              .set({
                reconciliationNote: "awaiting_async_settlement",
                lastReconciledAt: now,
                updatedAt: now,
              })
              .where(eq(paymentAttempts.id, locked.id));
            primaryAttempt = { ...locked, reconciliationNote: "awaiting_async_settlement", lastReconciledAt: now };
            lastReasonCode = "AWAITING_ASYNC_SETTLEMENT";
          } else if (entry.fetched.status === "expired" && (locked.status === "redirected" || locked.status === "created")) {
            await tx
              .update(paymentAttempts)
              .set({
                status: "expired",
                lastReconciledAt: now,
                version: locked.version + 1,
                updatedAt: now,
              })
              .where(and(eq(paymentAttempts.id, locked.id), eq(paymentAttempts.version, locked.version)));
            primaryAttempt = { ...locked, status: "expired", lastReconciledAt: now, version: locked.version + 1 };
            lastReasonCode = "SESSION_EXPIRED";
          } else {
            await tx
              .update(paymentAttempts)
              .set({ lastReconciledAt: now, updatedAt: now })
              .where(eq(paymentAttempts.id, locked.id));
            lastReasonCode = entry.fetched.status === "expired" ? "SESSION_EXPIRED" : "STILL_UNPAID";
          }
        }

        const refreshedInvoice = await complianceSvc.getInvoiceForCheckout(staged.targetInvoicePublicId, {
          tx,
          forUpdate: true,
        });

        await deps.audit.record(
          {
            category: "admin",
            eventName: "payments.admin.stripe_checked",
            action: "execute",
            outcome: "completed",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: { type: "payment_attempt", publicId: primaryAttempt.publicId },
            orderPublicId: refreshedInvoice.orderPublicId,
            attributes: {
              invoice_public_id: refreshedInvoice.invoicePublicId,
              attempt_public_id: primaryAttempt.publicId,
              checked_count: fetchedEntries.length,
              booked: didBook,
              already_paid: wasAlreadyPaid,
              reason_code: lastReasonCode,
            },
          },
          tx,
        );

        return {
          checkedCount: fetchedEntries.length,
          booked: didBook,
          alreadyPaid: !didBook && (wasAlreadyPaid || refreshedInvoice.status === "paid"),
          invoicePublicId: refreshedInvoice.invoicePublicId,
          invoiceStatus: refreshedInvoice.status,
          receiptPublicId: refreshedInvoice.receiptPublicId ?? null,
          attemptPublicId: primaryAttempt.publicId,
          attemptStatus: primaryAttempt.status,
          bookingSource: primaryAttempt.bookingSource,
          reasonCode: lastReasonCode,
        };
      },
    ),
    );
  }

  async function loadProviderRefundCredentials(
    provider: ActivePaymentProvider,
    environment: PaymentEnvironmentMode,
    tx?: Tx,
  ): Promise<ProviderCredentials> {
    const config = await loadConfig(tx);
    if (config.mode !== environment) {
      throw conflict(
        "REFUND_ENVIRONMENT_MISMATCH",
        `Payment was captured in ${environment} mode while payments are currently configured in ${config.mode} mode.`,
      );
    }
    if (provider === "stripe") {
      const secretKey = await readSecret(deps.settings, PAYMENTS_STRIPE_SECRET_KEY, tx);
      if (!secretKey) {
        throw new DomainError(
          "UNAVAILABLE",
          "PAYMENT_PROVIDER_NOT_CONFIGURED",
          "Stripe credentials are not configured.",
        );
      }
      return { mode: environment, secretKey };
    }
    const accessToken = await readSecret(deps.settings, PAYMENTS_SQUARE_ACCESS_TOKEN, tx);
    if (!accessToken) {
      throw new DomainError(
        "UNAVAILABLE",
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        "Square credentials are not configured.",
      );
    }
    return {
      mode: environment,
      secretKey: accessToken,
      ...(config.squareLocationId ? { squareLocationId: config.squareLocationId } : {}),
    };
  }

  async function findRefundForWebhookInTx(
    tx: Tx,
    provider: ActivePaymentProvider,
    environment: PaymentEnvironmentMode,
    verified: Extract<ProviderVerifyWebhookOutput, { ok: true }>,
  ): Promise<PaymentRefundRow | null> {
    if (verified.refundPublicIdHint) {
      const [byHint] = await tx
        .select()
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.provider, provider),
            eq(paymentRefunds.environment, environment),
            eq(paymentRefunds.publicId, verified.refundPublicIdHint),
          ),
        )
        .limit(1);
      if (byHint) return byHint;
    }

    if (verified.providerRefundRef) {
      const [byRef] = await tx
        .select()
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.provider, provider),
            eq(paymentRefunds.environment, environment),
            eq(paymentRefunds.providerRefundRef, verified.providerRefundRef),
          ),
        )
        .limit(1);
      if (byRef) return byRef;
    }

    return null;
  }

  async function settleProviderRefundSucceededInTx(
    tx: Tx,
    row: PaymentRefundRow,
    providerRefundRef: string,
    settledAt: Date,
    verifiedWebhookEventId: string | null,
  ): Promise<{
    complianceRefundPublicId: string;
    invoicePaymentState: InvoicePaymentState;
    orderPaymentState: InvoicePaymentState | "none";
  }> {
    const now = deps.clock.now();
    const complianceSvc = requireComplianceService();
    const ordersSvc = requireOrdersService();
    const decryptedReason = deps.crypto.decrypt(row.reasonEnc, `payment_refunds.reason:${row.publicId}`);

    const booked = await complianceSvc.invoices.bookSettledRefundInTx(tx, {
      invoiceId: row.invoiceId,
      paymentId: row.compliancePaymentId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      reasonCode: row.reasonCode,
      reference: providerRefundRef,
      notes: decryptedReason,
      refundedAt: settledAt,
      recordedByUserId: row.requestedByUserId,
      idempotencyKey: row.providerIdempotencyKey,
      provider: row.provider,
      providerEventId: row.publicId,
    });

    let noticeSentAt = row.customerNoticeSentAt;
    if (row.sendCustomerNotice && !noticeSentAt && !(await isOrderTrashedInTx(tx, row.orderId))) {
      const orderRef =
        typeof ordersSvc.getOrderRefById === "function"
          ? await ordersSvc.getOrderRefById(row.orderId, tx)
          : null;
      if (orderRef) {
        await deps.mailer.enqueue(
          {
            template: REFUND_NOTICE_TEMPLATE_KEY,
            to: { userId: orderRef.ownerUserId },
            orderId: row.orderId,
            vars: {
              orderReference: orderRef.reference,
              refundAmount: formatRefundNoticeAmount(row.amountMinor, row.currency),
              refundReference: row.publicId,
            },
            idempotencyKey: `refund-notice:${row.publicId}`,
          },
          tx,
        );
        noticeSentAt = now;
      }
    }

    await tx
      .update(paymentRefunds)
      .set({
        status: "succeeded",
        providerRefundRef,
        complianceRefundPublicId: booked.complianceRefundPublicId,
        verifiedWebhookEventId: verifiedWebhookEventId ?? row.verifiedWebhookEventId,
        failureReasonCode: null,
        customerNoticeSentAt: noticeSentAt,
        settledAt: row.settledAt ?? settledAt,
        lastReconciledAt: now,
        version: row.version + 1,
        updatedAt: now,
      })
      .where(eq(paymentRefunds.id, row.id));

    if (!booked.duplicate) {
      await deps.audit.record(
        {
          category: "business",
          eventName: "payment.refund.succeeded",
          action: "create",
          outcome: "completed",
          actor: { role: "system" },
          resource: { type: "payment_refund", publicId: row.publicId },
          orderPublicId: row.orderPublicId,
          attributes: {
            order_public_id: row.orderPublicId,
            invoice_public_id: row.invoicePublicId,
            provider: row.provider,
            execution_kind: "provider_refund",
          },
        },
        tx,
      );
    }

    return {
      complianceRefundPublicId: booked.complianceRefundPublicId,
      invoicePaymentState: booked.invoicePaymentState,
      orderPaymentState: booked.orderPaymentState,
    };
  }

  const DETERMINISTIC_REFUND_MISMATCH_CODES = new Set([
    "STRIPE_REFUND_METADATA_MISMATCH",
    "STRIPE_REFUND_PAYMENT_MISMATCH",
    "STRIPE_REFUND_CHARGE_MISMATCH",
    "STRIPE_REFUND_AMOUNT_OR_CURRENCY_MISMATCH",
    "STRIPE_REFUND_ID_MISMATCH",
    "STRIPE_INVALID_PAYMENT_REF",
    "SQUARE_REFUND_LOOKUP_MISMATCH",
    "SQUARE_REFUND_LOOKUP_INVALID",
  ]);

  async function verifyAndApplyRefundWebhook(args: {
    provider: ActivePaymentProvider;
    credentials: ProviderCredentials;
    refundRow: PaymentRefundRow;
    webhookRowId: number;
    externalEventId: string;
    providerRefundRefHint: string | null;
    duplicate: boolean;
    now: Date;
  }): Promise<PaymentWebhookResult> {
    if (
      args.refundRow.providerRefundRef &&
      args.providerRefundRefHint &&
      args.refundRow.providerRefundRef !== args.providerRefundRefHint
    ) {
      await deps.db
        .update(paymentWebhookEvents)
        .set({
          status: "verification_mismatch",
          reasonCode: "REFUND_PROVIDER_REF_CONFLICT",
          processedAt: args.now,
        })
        .where(eq(paymentWebhookEvents.id, args.webhookRowId));
      return {
        httpStatus: 200,
        accepted: false,
        duplicate: args.duplicate,
        booked: false,
        reasonCode: "REFUND_PROVIDER_REF_CONFLICT",
      };
    }

    const expectedDirectRef = args.refundRow.providerRefundRef ?? args.providerRefundRefHint;
    const refundAdapter = refundAdapters[args.provider];
    const lookup = await refundAdapter.lookupRefund({
      credentials: args.credentials,
      refundPublicId: args.refundRow.publicId,
      providerIdempotencyKey: args.refundRow.providerIdempotencyKey,
      refundMarker: `ReadyPackets refund ${args.refundRow.publicId}`,
      providerPaymentRef: args.refundRow.providerPaymentRef,
      providerRefundRef: expectedDirectRef,
      amountMinor: args.refundRow.amountMinor,
      currency: args.refundRow.currency,
    });

    if (
      lookup.status === "unknown" &&
      lookup.failureReasonCode &&
      DETERMINISTIC_REFUND_MISMATCH_CODES.has(lookup.failureReasonCode)
    ) {
      const code = lookup.failureReasonCode.slice(0, 64);
      await deps.db
        .update(paymentWebhookEvents)
        .set({
          status: "verification_mismatch",
          reasonCode: code,
          processedAt: args.now,
        })
        .where(eq(paymentWebhookEvents.id, args.webhookRowId));
      return {
        httpStatus: 200,
        accepted: false,
        duplicate: args.duplicate,
        booked: false,
        reasonCode: code,
      };
    }

    if (lookup.status === "unknown" || lookup.status === "absent") {
      await deps.db
        .update(paymentWebhookEvents)
        .set({
          status: "retry_pending",
          reasonCode: (lookup.failureReasonCode ?? "REFUND_VERIFICATION_UNCONFIRMED").slice(0, 64),
        })
        .where(eq(paymentWebhookEvents.id, args.webhookRowId));
      return {
        httpStatus: 503,
        accepted: false,
        duplicate: args.duplicate,
        booked: false,
        reasonCode: lookup.failureReasonCode ?? "REFUND_VERIFICATION_UNCONFIRMED",
      };
    }

    if (!lookup.providerRefundRef || (expectedDirectRef && lookup.providerRefundRef !== expectedDirectRef)) {
      await deps.db
        .update(paymentWebhookEvents)
        .set({
          status: "verification_mismatch",
          reasonCode: "REFUND_ID_VERIFICATION_MISMATCH",
          processedAt: args.now,
        })
        .where(eq(paymentWebhookEvents.id, args.webhookRowId));
      return {
        httpStatus: 200,
        accepted: false,
        duplicate: args.duplicate,
        booked: false,
        reasonCode: "REFUND_ID_VERIFICATION_MISMATCH",
      };
    }

    return deps.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, args.refundRow.id))
        .for("update")
        .limit(1);
      if (!locked) {
        await tx
          .update(paymentWebhookEvents)
          .set({ status: "ignored", reasonCode: "REFUND_NOT_FOUND", processedAt: args.now })
          .where(eq(paymentWebhookEvents.id, args.webhookRowId));
        return {
          httpStatus: 200 as const,
          accepted: true,
          duplicate: args.duplicate,
          booked: false,
          reasonCode: "REFUND_NOT_FOUND",
        };
      }

      if (locked.providerRefundRef && locked.providerRefundRef !== lookup.providerRefundRef) {
        await tx
          .update(paymentWebhookEvents)
          .set({
            status: "verification_mismatch",
            reasonCode: "REFUND_PROVIDER_REF_CONFLICT",
            processedAt: args.now,
          })
          .where(eq(paymentWebhookEvents.id, args.webhookRowId));
        return {
          httpStatus: 200 as const,
          accepted: false,
          duplicate: args.duplicate,
          booked: false,
          reasonCode: "REFUND_PROVIDER_REF_CONFLICT",
        };
      }

      const resolvedProviderRef = lookup.providerRefundRef;

      if (lookup.status === "succeeded" && resolvedProviderRef) {
        if (locked.status !== "succeeded") {
          await settleProviderRefundSucceededInTx(
            tx,
            locked,
            resolvedProviderRef,
            lookup.settledAt ?? args.now,
            args.externalEventId,
          );
        }
        await tx
          .update(paymentWebhookEvents)
          .set({
            status: "processed",
            reasonCode: "REFUND_SUCCEEDED",
            providerRefundRef: resolvedProviderRef,
            processedAt: args.now,
          })
          .where(eq(paymentWebhookEvents.id, args.webhookRowId));
        return {
          httpStatus: 200 as const,
          accepted: true,
          duplicate: args.duplicate,
          booked: true,
          reasonCode: "REFUND_SUCCEEDED",
        };
      }

      if (lookup.status === "failed") {
        const failureCode = (lookup.failureReasonCode ?? "PROVIDER_REFUND_FAILED").slice(0, 64);
        if (locked.status !== "succeeded" && locked.status !== "failed") {
          await tx
            .update(paymentRefunds)
            .set({
              status: "failed",
              providerRefundRef: resolvedProviderRef,
              verifiedWebhookEventId: args.externalEventId,
              failureReasonCode: failureCode,
              settledAt: args.now,
              lastReconciledAt: args.now,
              version: locked.version + 1,
              updatedAt: args.now,
            })
            .where(eq(paymentRefunds.id, locked.id));

          await deps.audit.record(
            {
              category: "business",
              eventName: "payment.refund.failed",
              action: "create",
              outcome: "failed",
              severity: "WARN",
              reasonCode: failureCode,
              actor: { role: "system" },
              resource: { type: "payment_refund", publicId: locked.publicId },
              orderPublicId: locked.orderPublicId,
              attributes: {
                order_public_id: locked.orderPublicId,
                invoice_public_id: locked.invoicePublicId,
                provider: locked.provider,
              },
            },
            tx,
          );
        }
        await tx
          .update(paymentWebhookEvents)
          .set({
            status: "processed",
            reasonCode: "REFUND_FAILED",
            providerRefundRef: resolvedProviderRef,
            processedAt: args.now,
          })
          .where(eq(paymentWebhookEvents.id, args.webhookRowId));
        return {
          httpStatus: 200 as const,
          accepted: true,
          duplicate: args.duplicate,
          booked: false,
          reasonCode: "REFUND_FAILED",
        };
      }

      // lookup.status === "pending"
      if (locked.status === "pending" || locked.status === "unknown") {
        await tx
          .update(paymentRefunds)
          .set({
            status: "pending",
            providerRefundRef: resolvedProviderRef,
            verifiedWebhookEventId: args.externalEventId,
            lastReconciledAt: args.now,
            version: locked.version + 1,
            updatedAt: args.now,
          })
          .where(eq(paymentRefunds.id, locked.id));
      }
      await tx
        .update(paymentWebhookEvents)
        .set({
          status: "processed",
          reasonCode: "REFUND_PENDING",
          providerRefundRef: resolvedProviderRef,
          processedAt: args.now,
        })
        .where(eq(paymentWebhookEvents.id, args.webhookRowId));
      return {
        httpStatus: 200 as const,
        accepted: true,
        duplicate: args.duplicate,
        booked: false,
        reasonCode: "REFUND_PENDING",
      };
    });
  }

  async function forOrderRefunds(
    principal: SessionPrincipal,
    input: { orderPublicId: string },
  ): Promise<OrderRefundWorkspaceView> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      await deps.audit.record({
        category: "security",
        eventName: "authz.payments.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "REMEDIATION_SESSION",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "order_refunds", publicId: input.orderPublicId },
      });
      throw forbidden("REMEDIATION_SESSION");
    }
    if (principal.role !== "staff" && principal.role !== "admin") {
      await deps.audit.record({
        category: "security",
        eventName: "authz.payments.denied",
        action: "authorize",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "STAFF_REQUIRED",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "order_refunds", publicId: input.orderPublicId },
      });
      throw forbidden("STAFF_REQUIRED");
    }
    if (!ULID_PATTERN.test(input.orderPublicId)) {
      throw notFound("ORDER_NOT_FOUND");
    }

    const ordersSvc = requireOrdersService();
    // Enforces resource-level order scope; returns NOT_FOUND with zero existence oracle on unauthorized/missing orders.
    await ordersSvc.assertCanReadOrder(principal, input.orderPublicId);

    const canIssueRefund = roleHasCapability(principal.role, "payments.refund");
    const complianceSvc = requireComplianceService();

    const [ledgerSnapshot, providerRefundRows] = await Promise.all([
      complianceSvc.invoices.listOrderPaymentsAndRefunds(input.orderPublicId, undefined, {
        includeNotes: canIssueRefund,
      }),
      deps.db
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.orderPublicId, input.orderPublicId))
        .orderBy(desc(paymentRefunds.createdAt), desc(paymentRefunds.id)),
    ]);

    const providerRefundsByPaymentId = new Map<number, PaymentRefundRow[]>();
    for (const r of providerRefundRows) {
      const list = providerRefundsByPaymentId.get(r.compliancePaymentId) ?? [];
      list.push(r);
      providerRefundsByPaymentId.set(r.compliancePaymentId, list);
    }

    const payments: OrderRefundablePaymentView[] = ledgerSnapshot.payments.map((pmt) => {
      const providerKind: OrderPaymentProviderKind =
        pmt.method === "provider_online" && (pmt.provider === "stripe" || pmt.provider === "square")
          ? pmt.provider
          : "manual";
      const execMeta = executionMetaForProvider(providerKind);
      const pRefundRows = providerRefundsByPaymentId.get(pmt.paymentId) ?? [];

      const linkedComplianceRefundPublicIds = new Set<string>();
      const providerRefundPublicIds = new Set<string>();
      for (const r of pRefundRows) {
        providerRefundPublicIds.add(r.publicId);
        if (r.complianceRefundPublicId) {
          linkedComplianceRefundPublicIds.add(r.complianceRefundPublicId);
        }
      }

      const unlinkedLedgerRefunds = pmt.ledgerRefunds.filter(
        (lr) =>
          !linkedComplianceRefundPublicIds.has(lr.refundPublicId) &&
          (!lr.providerEventId || !providerRefundPublicIds.has(lr.providerEventId)),
      );

      const unlinkedLedgerMinor = unlinkedLedgerRefunds.reduce((sum, lr) => sum + lr.amountMinor, 0);
      const succeededProviderMinor = pRefundRows
        .filter((r) => r.status === "succeeded")
        .reduce((sum, r) => sum + r.amountMinor, 0);
      const reservedPendingOrUnknownMinor = pRefundRows
        .filter((r) => r.status === "pending" || r.status === "unknown")
        .reduce((sum, r) => sum + r.amountMinor, 0);

      const refundedMinor = unlinkedLedgerMinor + succeededProviderMinor;
      const refundableMinor = Math.max(
        0,
        pmt.capturedMinor - refundedMinor - reservedPendingOrUnknownMinor,
      );

      const refundItems: OrderPaymentRefundItemView[] = [
        ...pRefundRows.map((r): OrderPaymentRefundItemView => {
          const itemMeta = executionMetaForProvider(r.provider);
          return {
            refundPublicId: r.publicId,
            paymentPublicId: pmt.paymentPublicId,
            provider: r.provider,
            executionKind: itemMeta.executionKind,
            executionLabel: itemMeta.executionLabel,
            status: r.status,
            amountMinor: r.amountMinor,
            currency: r.currency,
            reasonCode: r.reasonCode,
            reason: canIssueRefund
              ? deps.crypto.decrypt(r.reasonEnc, `payment_refunds.reason:${r.publicId}`)
              : null,
            providerRefundRef: r.providerRefundRef,
            sendCustomerNotice: r.sendCustomerNotice,
            customerNoticeSentAt: r.customerNoticeSentAt ? r.customerNoticeSentAt.toISOString() : null,
            failureReasonCode: r.failureReasonCode,
            createdAt: r.createdAt.toISOString(),
            settledAt: r.settledAt ? r.settledAt.toISOString() : null,
          };
        }),
        ...unlinkedLedgerRefunds.map((lr): OrderPaymentRefundItemView => {
          const lrProvider: OrderPaymentProviderKind =
            lr.provider === "stripe" || lr.provider === "square" ? lr.provider : "manual";
          const lrMeta = executionMetaForProvider(lrProvider);
          return {
            refundPublicId: lr.refundPublicId,
            paymentPublicId: pmt.paymentPublicId,
            provider: lrProvider,
            executionKind: lrMeta.executionKind,
            executionLabel: lrMeta.executionLabel,
            status: "succeeded",
            amountMinor: lr.amountMinor,
            currency: lr.currency,
            reasonCode: lr.reasonCode,
            reason: canIssueRefund ? lr.notes : null,
            providerRefundRef: lrProvider === "manual" ? null : lr.reference,
            sendCustomerNotice: false,
            customerNoticeSentAt: null,
            failureReasonCode: null,
            createdAt: lr.refundedAt.toISOString(),
            settledAt: lr.refundedAt.toISOString(),
          };
        }),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      return {
        paymentPublicId: pmt.paymentPublicId,
        invoicePublicId: pmt.invoicePublicId,
        invoiceNumber: pmt.invoiceNumber,
        invoiceStatus: pmt.invoiceStatus,
        invoicePaymentState: pmt.invoicePaymentState,
        provider: providerKind,
        executionKind: execMeta.executionKind,
        executionLabel: execMeta.executionLabel,
        providerPaymentRef: providerKind === "manual" ? null : pmt.reference,
        capturedMinor: pmt.capturedMinor,
        refundedMinor,
        reservedPendingOrUnknownMinor,
        refundableMinor,
        currency: pmt.currency,
        paidAt: pmt.receivedAt.toISOString(),
        refunds: refundItems,
      };
    });

    return {
      orderPublicId: input.orderPublicId,
      orderPaymentState: ledgerSnapshot.orderPaymentState,
      confirmationPhrase: REFUND_CONFIRMATION_PHRASE,
      canIssueRefund,
      payments,
    };
  }

  async function createOrderRefund(
    principal: SessionPrincipal,
    input: CreateOrderRefundInput,
  ): Promise<CreateOrderRefundResultView> {
    if (input.confirmationPhrase !== REFUND_CONFIRMATION_PHRASE) {
      throw validation(
        "CONFIRMATION_PHRASE_MISMATCH",
        `Type "${REFUND_CONFIRMATION_PHRASE}" exactly to confirm this refund.`,
      );
    }
    const trimmedReason = input.reason.trim();
    if (trimmedReason.length < 1 || trimmedReason.length > 1000) {
      throw validation("REFUND_REASON_REQUIRED", "Enter a refund reason between 1 and 1,000 characters.");
    }
    for (let i = 0; i < trimmedReason.length; i += 1) {
      const code = trimmedReason.charCodeAt(i);
      if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
        throw validation("INVALID_REFUND_REASON", "Refund reason contains unsupported control characters.");
      }
    }
    if (CARD_PAN_LIKE_PATTERN.test(trimmedReason)) {
      throw validation("CARD_DATA_FORBIDDEN", "Do not include payment card numbers in the refund reason.");
    }
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw validation("INVALID_REFUND_AMOUNT", "Refund amount must be a positive integer in minor units.");
    }
    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency)) {
      throw validation("INVALID_CURRENCY", "Currency must be a 3-letter ISO code.");
    }
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw validation("INVALID_IDEMPOTENCY_KEY", "Idempotency key must be between 8 and 128 characters.");
    }
    const reasonCode =
      input.reasonCode && /^[A-Z][A-Z0-9_]{1,63}$/u.test(input.reasonCode)
        ? input.reasonCode
        : "ORDER_REFUND";

    const complianceSvc = requireComplianceService();
    const ordersSvc = requireOrdersService();
    const correlationId = getRequestContext()?.correlationId;

    const prepared = await runComplianceTx(
      deps,
      principal,
      { type: "order_refund", publicId: input.orderPublicId },
      async (tx) => {
        const liveActor = await assertLiveActorInTx(deps, principal, tx, "payments.refund");
        const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };
        const now = deps.clock.now();

        const orderView = await ordersSvc.assertCanWriteOrder(livePrincipal, input.orderPublicId, {
          kind: "invoice",
          tx,
          forUpdate: true,
        });

        const locked = await complianceSvc.invoices.lockOrderPaymentForRefundInTx(tx, {
          orderPublicId: input.orderPublicId,
          paymentPublicId: input.paymentPublicId,
        });

        if (currency !== locked.currency) {
          throw validation(
            "CURRENCY_MISMATCH",
            `Refund currency (${currency}) must match payment currency (${locked.currency}).`,
          );
        }

        const providerKind: OrderPaymentProviderKind =
          locked.method === "provider_online" &&
          (locked.provider === "stripe" || locked.provider === "square")
            ? locked.provider
            : "manual";

        if (providerKind === "manual") {
          const manualIdemKey = `manual-refund:${locked.paymentId}:${idempotencyKey}`.slice(0, 128);
          const alreadyManualRefunded = locked.ledgerRefunds.reduce((sum, r) => sum + r.amountMinor, 0);
          const existingManual = locked.ledgerRefunds.find((r) => r.idempotencyKey === manualIdemKey);

          if (!existingManual && alreadyManualRefunded + input.amountMinor > locked.capturedMinor) {
            throw conflict(
              "REFUND_EXCEEDS_REFUNDABLE",
              "Refund amount exceeds the remaining refundable balance on this payment.",
            );
          }

          const booked = await complianceSvc.invoices.bookSettledRefundInTx(tx, {
            invoiceId: locked.invoiceId,
            paymentId: locked.paymentId,
            amountMinor: input.amountMinor,
            currency,
            reasonCode,
            reference: "RECORDED-ONLY",
            notes: trimmedReason,
            refundedAt: now,
            recordedByUserId: liveActor.userId,
            idempotencyKey: manualIdemKey,
            provider: null,
            providerEventId: null,
          });

          if (!booked.duplicate) {
            await deps.audit.record(
              {
                category: "business",
                eventName: "payment.refund.prepared",
                action: "create",
                outcome: "completed",
                actor: { userId: liveActor.userId, role: liveActor.role },
                resource: { type: "payment_refund", publicId: booked.complianceRefundPublicId },
                orderPublicId: locked.orderPublicId,
                attributes: {
                  order_public_id: locked.orderPublicId,
                  invoice_public_id: locked.invoicePublicId,
                  provider: "manual",
                  execution_kind: "recorded_only",
                },
              },
              tx,
            );

            await deps.audit.record(
              {
                category: "business",
                eventName: "payment.refund.succeeded",
                action: "create",
                outcome: "completed",
                actor: { userId: liveActor.userId, role: liveActor.role },
                resource: { type: "payment_refund", publicId: booked.complianceRefundPublicId },
                orderPublicId: locked.orderPublicId,
                attributes: {
                  order_public_id: locked.orderPublicId,
                  invoice_public_id: locked.invoicePublicId,
                  provider: "manual",
                  execution_kind: "recorded_only",
                },
              },
              tx,
            );

            if (input.sendCustomerNotice && !(await isOrderTrashedInTx(tx, orderView.id))) {
              await deps.mailer.enqueue(
                {
                  template: REFUND_NOTICE_TEMPLATE_KEY,
                  to: { userId: locked.ownerUserId },
                  orderId: orderView.id,
                  vars: {
                    orderReference: locked.orderReference,
                    refundAmount: formatRefundNoticeAmount(input.amountMinor, currency),
                    refundReference: booked.complianceRefundPublicId,
                  },
                  idempotencyKey: `refund-notice:${booked.complianceRefundPublicId}`,
                },
                tx,
              );
            }
          }

          const manualMeta = executionMetaForProvider("manual");
          return {
            kind: "immediate" as const,
            result: {
              refundPublicId: booked.complianceRefundPublicId,
              executionKind: manualMeta.executionKind,
              executionLabel: manualMeta.executionLabel,
              status: "succeeded" as const,
              amountMinor: input.amountMinor,
              currency,
              provider: "manual" as const,
              providerRefundRef: null,
              failureReasonCode: null,
              invoicePaymentState: booked.invoicePaymentState,
              orderPaymentState: booked.orderPaymentState,
              replayed: booked.duplicate,
            },
          };
        }

        // Provider refund branch ("stripe" | "square"): lock existing payment_refunds rows FOR UPDATE.
        const existingProviderRefunds = await tx
          .select()
          .from(paymentRefunds)
          .where(eq(paymentRefunds.compliancePaymentId, locked.paymentId))
          .orderBy(asc(paymentRefunds.id))
          .for("update");

        const duplicateRow = existingProviderRefunds.find((r) => r.idempotencyKey === idempotencyKey);
        if (duplicateRow) {
          const dupMeta = executionMetaForProvider(duplicateRow.provider);
          const ledgerSnap = await complianceSvc.invoices.listOrderPaymentsAndRefunds(
            locked.orderPublicId,
            tx,
            { includeNotes: false },
          );
          const pmtSnap = ledgerSnap.payments.find((p) => p.paymentId === locked.paymentId);
          return {
            kind: "immediate" as const,
            result: {
              refundPublicId: duplicateRow.publicId,
              executionKind: dupMeta.executionKind,
              executionLabel: dupMeta.executionLabel,
              status: duplicateRow.status,
              amountMinor: duplicateRow.amountMinor,
              currency: duplicateRow.currency,
              provider: duplicateRow.provider,
              providerRefundRef: duplicateRow.providerRefundRef,
              failureReasonCode: duplicateRow.failureReasonCode,
              invoicePaymentState: pmtSnap?.invoicePaymentState ?? locked.invoicePaymentState,
              orderPaymentState: ledgerSnap.orderPaymentState,
              replayed: true,
            },
          };
        }

        if (existingProviderRefunds.some((r) => r.status === "unknown")) {
          throw conflict(
            "REFUND_OUTCOME_UNKNOWN_PENDING",
            "A previous refund on this payment has an unconfirmed provider outcome. Confirm or reconcile it before submitting another refund.",
          );
        }

        const linkedIds = new Set(
          existingProviderRefunds
            .filter((r) => r.status === "succeeded" && r.complianceRefundPublicId !== null)
            .map((r) => r.complianceRefundPublicId!),
        );
        const providerRowPubIds = new Set(existingProviderRefunds.map((r) => r.publicId));
        const unlinkedLedgerMinor = locked.ledgerRefunds
          .filter(
            (lr) =>
              !linkedIds.has(lr.refundPublicId) &&
              (!lr.providerEventId || !providerRowPubIds.has(lr.providerEventId)),
          )
          .reduce((sum, lr) => sum + lr.amountMinor, 0);

        const activeProviderMinor = existingProviderRefunds
          .filter((r) => r.status === "pending" || r.status === "succeeded" || r.status === "unknown")
          .reduce((sum, r) => sum + r.amountMinor, 0);

        const refundableMinor = Math.max(
          0,
          locked.capturedMinor - unlinkedLedgerMinor - activeProviderMinor,
        );
        if (input.amountMinor > refundableMinor) {
          throw conflict(
            "REFUND_EXCEEDS_REFUNDABLE",
            "Refund amount exceeds the remaining refundable balance on this payment.",
          );
        }

        let matchedAttempt: PaymentAttemptRow | undefined;
        if (locked.providerEventId && ULID_PATTERN.test(locked.providerEventId)) {
          const [att] = await tx
            .select()
            .from(paymentAttempts)
            .where(
              or(
                eq(paymentAttempts.compliancePaymentPublicId, locked.paymentPublicId),
                eq(paymentAttempts.publicId, locked.providerEventId),
              ),
            )
            .limit(1);
          matchedAttempt = att;
        } else {
          const [att] = await tx
            .select()
            .from(paymentAttempts)
            .where(eq(paymentAttempts.compliancePaymentPublicId, locked.paymentPublicId))
            .limit(1);
          matchedAttempt = att;
        }

        const config = await loadConfig(tx);
        const environment: PaymentEnvironmentMode = matchedAttempt?.environment ?? config.mode;
        const credentials = await loadProviderRefundCredentials(providerKind, environment, tx);
        const providerPaymentRef = matchedAttempt?.providerPaymentRef ?? locked.providerReference;

        const refundPublicId = ulid(now.getTime());
        const providerIdempotencyKey = `rp-refund-${refundPublicId}`;
        const refundMarker = `ReadyPackets refund ${refundPublicId}`;
        const reasonEnc = deps.crypto.encrypt(trimmedReason, `payment_refunds.reason:${refundPublicId}`);

        const enqueued = await enqueueRefundReconciliation(refundPublicId, tx, {
          runAt: new Date(now.getTime() + REFUND_RECONCILE_INITIAL_DELAY_MS),
          ...(correlationId ? { correlationId } : {}),
        });

        const [ins] = await tx.insert(paymentRefunds).values({
          publicId: refundPublicId,
          orderId: locked.orderId,
          orderPublicId: locked.orderPublicId,
          invoiceId: locked.invoiceId,
          invoicePublicId: locked.invoicePublicId,
          compliancePaymentId: locked.paymentId,
          compliancePaymentPublicId: locked.paymentPublicId,
          attemptId: matchedAttempt?.id ?? null,
          provider: providerKind,
          environment,
          status: "pending",
          amountMinor: input.amountMinor,
          currency,
          reasonCode,
          reasonEnc,
          requestedByUserId: liveActor.userId,
          idempotencyKey,
          providerIdempotencyKey,
          providerPaymentRef,
          providerRefundRef: null,
          complianceRefundPublicId: null,
          sendCustomerNotice: input.sendCustomerNotice,
          customerNoticeSentAt: null,
          reconcileJobId: enqueued.jobId,
          verifiedWebhookEventId: null,
          failureReasonCode: null,
          version: 1,
          settledAt: null,
          lastReconciledAt: null,
          createdAt: now,
          updatedAt: now,
        });

        await deps.audit.record(
          {
            category: "business",
            eventName: "payment.refund.prepared",
            action: "create",
            outcome: "completed",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: { type: "payment_refund", publicId: refundPublicId },
            orderPublicId: locked.orderPublicId,
            attributes: {
              order_public_id: locked.orderPublicId,
              invoice_public_id: locked.invoicePublicId,
              provider: providerKind,
              execution_kind: "provider_refund",
            },
          },
          tx,
        );

        return {
          kind: "execute_provider" as const,
          refundRowId: ins.insertId,
          refundPublicId,
          provider: providerKind,
          credentials,
          providerIdempotencyKey,
          refundMarker,
          providerPaymentRef,
          orderPublicId: locked.orderPublicId,
          invoicePublicId: locked.invoicePublicId,
          invoiceNumber: locked.invoiceNumber,
          amountMinor: input.amountMinor,
          currency,
          actorUserId: liveActor.userId,
          actorRole: liveActor.role,
        };
      },
    );

    if (prepared.kind === "immediate") {
      return prepared.result;
    }

    // Phase 2: Execute provider refund OUTSIDE any database transaction.
    // On ambiguous / network error ("unknown"), NEVER resend POST automatically!
    const refundAdapter = refundAdapters[prepared.provider];
    const execOutcome = await refundAdapter.createRefund({
      credentials: prepared.credentials,
      refundPublicId: prepared.refundPublicId,
      providerIdempotencyKey: prepared.providerIdempotencyKey,
      refundMarker: prepared.refundMarker,
      orderPublicId: prepared.orderPublicId,
      invoicePublicId: prepared.invoicePublicId,
      invoiceNumber: prepared.invoiceNumber,
      providerPaymentRef: prepared.providerPaymentRef,
      amountMinor: prepared.amountMinor,
      currency: prepared.currency,
    });

    // Phase 3: Persist provider execution outcome in a short transaction.
    return deps.db.transaction(async (tx) => {
      const now = deps.clock.now();
      const [lockedRow] = await tx
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, prepared.refundRowId))
        .for("update")
        .limit(1);
      if (!lockedRow) {
        throw notFound("REFUND_NOT_FOUND");
      }

      const execMeta = executionMetaForProvider(lockedRow.provider);

      // If a concurrent verified webhook already settled this refund while the HTTP call was returning, preserve it!
      if (lockedRow.status === "succeeded" || lockedRow.status === "failed") {
        const ledgerSnap = await complianceSvc.invoices.listOrderPaymentsAndRefunds(
          lockedRow.orderPublicId,
          tx,
          { includeNotes: false },
        );
        const pmtSnap = ledgerSnap.payments.find((p) => p.paymentId === lockedRow.compliancePaymentId);
        return {
          refundPublicId: lockedRow.publicId,
          executionKind: execMeta.executionKind,
          executionLabel: execMeta.executionLabel,
          status: lockedRow.status,
          amountMinor: lockedRow.amountMinor,
          currency: lockedRow.currency,
          provider: lockedRow.provider,
          providerRefundRef: lockedRow.providerRefundRef,
          failureReasonCode: lockedRow.failureReasonCode,
          invoicePaymentState: pmtSnap?.invoicePaymentState ?? "paid",
          orderPaymentState: ledgerSnap.orderPaymentState,
          replayed: false,
        };
      }

      if (execOutcome.outcome === "succeeded") {
        await deps.audit.record(
          {
            category: "business",
            eventName: "payment.refund.sent",
            action: "create",
            outcome: "completed",
            actor: { userId: prepared.actorUserId, role: prepared.actorRole },
            resource: { type: "payment_refund", publicId: lockedRow.publicId },
            orderPublicId: lockedRow.orderPublicId,
            attributes: {
              order_public_id: lockedRow.orderPublicId,
              invoice_public_id: lockedRow.invoicePublicId,
              provider: lockedRow.provider,
            },
          },
          tx,
        );

        const settled = await settleProviderRefundSucceededInTx(
          tx,
          lockedRow,
          execOutcome.providerRefundRef,
          execOutcome.settledAt ?? now,
          null,
        );

        return {
          refundPublicId: lockedRow.publicId,
          executionKind: execMeta.executionKind,
          executionLabel: execMeta.executionLabel,
          status: "succeeded" as const,
          amountMinor: lockedRow.amountMinor,
          currency: lockedRow.currency,
          provider: lockedRow.provider,
          providerRefundRef: execOutcome.providerRefundRef,
          failureReasonCode: null,
          invoicePaymentState: settled.invoicePaymentState,
          orderPaymentState: settled.orderPaymentState,
          replayed: false,
        };
      }

      if (execOutcome.outcome === "pending") {
        await tx
          .update(paymentRefunds)
          .set({
            status: "pending",
            providerRefundRef: execOutcome.providerRefundRef,
            version: lockedRow.version + 1,
            updatedAt: now,
          })
          .where(eq(paymentRefunds.id, lockedRow.id));

        await deps.audit.record(
          {
            category: "business",
            eventName: "payment.refund.sent",
            action: "create",
            outcome: "completed",
            actor: { userId: prepared.actorUserId, role: prepared.actorRole },
            resource: { type: "payment_refund", publicId: lockedRow.publicId },
            orderPublicId: lockedRow.orderPublicId,
            attributes: {
              order_public_id: lockedRow.orderPublicId,
              invoice_public_id: lockedRow.invoicePublicId,
              provider: lockedRow.provider,
            },
          },
          tx,
        );

        const ledgerSnap = await complianceSvc.invoices.listOrderPaymentsAndRefunds(
          lockedRow.orderPublicId,
          tx,
          { includeNotes: false },
        );
        const pmtSnap = ledgerSnap.payments.find((p) => p.paymentId === lockedRow.compliancePaymentId);
        return {
          refundPublicId: lockedRow.publicId,
          executionKind: execMeta.executionKind,
          executionLabel: execMeta.executionLabel,
          status: "pending" as const,
          amountMinor: lockedRow.amountMinor,
          currency: lockedRow.currency,
          provider: lockedRow.provider,
          providerRefundRef: execOutcome.providerRefundRef,
          failureReasonCode: null,
          invoicePaymentState: pmtSnap?.invoicePaymentState ?? "paid",
          orderPaymentState: ledgerSnap.orderPaymentState,
          replayed: false,
        };
      }

      if (execOutcome.outcome === "failed") {
        const failCode = execOutcome.failureReasonCode.slice(0, 64);
        await tx
          .update(paymentRefunds)
          .set({
            status: "failed",
            failureReasonCode: failCode,
            settledAt: now,
            version: lockedRow.version + 1,
            updatedAt: now,
          })
          .where(eq(paymentRefunds.id, lockedRow.id));

        await deps.audit.record(
          {
            category: "business",
            eventName: "payment.refund.failed",
            action: "create",
            outcome: "failed",
            severity: "WARN",
            reasonCode: failCode,
            actor: { userId: prepared.actorUserId, role: prepared.actorRole },
            resource: { type: "payment_refund", publicId: lockedRow.publicId },
            orderPublicId: lockedRow.orderPublicId,
            attributes: {
              order_public_id: lockedRow.orderPublicId,
              invoice_public_id: lockedRow.invoicePublicId,
              provider: lockedRow.provider,
            },
          },
          tx,
        );

        const ledgerSnap = await complianceSvc.invoices.listOrderPaymentsAndRefunds(
          lockedRow.orderPublicId,
          tx,
          { includeNotes: false },
        );
        const pmtSnap = ledgerSnap.payments.find((p) => p.paymentId === lockedRow.compliancePaymentId);
        return {
          refundPublicId: lockedRow.publicId,
          executionKind: execMeta.executionKind,
          executionLabel: execMeta.executionLabel,
          status: "failed" as const,
          amountMinor: lockedRow.amountMinor,
          currency: lockedRow.currency,
          provider: lockedRow.provider,
          providerRefundRef: null,
          failureReasonCode: failCode,
          invoicePaymentState: pmtSnap?.invoicePaymentState ?? "paid",
          orderPaymentState: ledgerSnap.orderPaymentState,
          replayed: false,
        };
      }

      // execOutcome.outcome === "unknown": NEVER resend POST automatically; leave reserved for reconciliation.
      const unknownCode = (
        execOutcome.outcome === "unknown" ? execOutcome.failureReasonCode : "REFUND_OUTCOME_UNKNOWN"
      ).slice(0, 64);
      await tx
        .update(paymentRefunds)
        .set({
          status: "unknown",
          failureReasonCode: unknownCode,
          version: lockedRow.version + 1,
          updatedAt: now,
        })
        .where(eq(paymentRefunds.id, lockedRow.id));

      await deps.audit.record(
        {
          category: "integration",
          eventName: "payment.refund.unknown",
          action: "create",
          outcome: "unknown",
          severity: "WARN",
          reasonCode: unknownCode,
          actor: { userId: prepared.actorUserId, role: prepared.actorRole },
          resource: { type: "payment_refund", publicId: lockedRow.publicId },
          orderPublicId: lockedRow.orderPublicId,
          attributes: {
            order_public_id: lockedRow.orderPublicId,
            invoice_public_id: lockedRow.invoicePublicId,
            provider: lockedRow.provider,
          },
        },
        tx,
      );

      const ledgerSnap = await complianceSvc.invoices.listOrderPaymentsAndRefunds(
        lockedRow.orderPublicId,
        tx,
        { includeNotes: false },
      );
      const pmtSnap = ledgerSnap.payments.find((p) => p.paymentId === lockedRow.compliancePaymentId);
      return {
        refundPublicId: lockedRow.publicId,
        executionKind: execMeta.executionKind,
        executionLabel: execMeta.executionLabel,
        status: "unknown" as const,
        amountMinor: lockedRow.amountMinor,
        currency: lockedRow.currency,
        provider: lockedRow.provider,
        providerRefundRef: null,
        failureReasonCode: unknownCode,
        invoicePaymentState: pmtSnap?.invoicePaymentState ?? "paid",
        orderPaymentState: ledgerSnap.orderPaymentState,
        replayed: false,
      };
    });
  }

  /**
   * Durable job handler (`compliance.refund.reconcile`) registered via `registerRefundReconciliation`.
   * Performs ONLY read-only `lookupRefund` queries against the provider (NEVER submits a POST refund),
   * and fences finalization with `context.assertStillOwned(tx)` BEFORE locking `payment_refunds`.
   */
  async function reconcileProviderRefund(
    refundPublicId: string,
    context: RefundReconcileContext,
  ): Promise<"settled" | "pending"> {
    const [initialRow] = await deps.db
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.publicId, refundPublicId))
      .limit(1);

    if (!initialRow || initialRow.status === "succeeded" || initialRow.status === "failed") {
      return "settled";
    }

    let credentials: ProviderCredentials;
    try {
      credentials = await loadProviderRefundCredentials(initialRow.provider, initialRow.environment);
    } catch {
      return "pending";
    }

    const refundAdapter = refundAdapters[initialRow.provider];
    const lookup = await refundAdapter.lookupRefund({
      credentials,
      refundPublicId: initialRow.publicId,
      providerIdempotencyKey: initialRow.providerIdempotencyKey,
      refundMarker: `ReadyPackets refund ${initialRow.publicId}`,
      providerPaymentRef: initialRow.providerPaymentRef,
      providerRefundRef: initialRow.providerRefundRef,
      amountMinor: initialRow.amountMinor,
      currency: initialRow.currency,
      signal: context.signal,
      beforeSend: () => context.assertStillOwned(),
    });

    return deps.db.transaction(async (tx) => {
      await context.assertStillOwned(tx);

      const [locked] = await tx
        .select()
        .from(paymentRefunds)
        .where(eq(paymentRefunds.id, initialRow.id))
        .for("update")
        .limit(1);

      if (!locked || locked.status === "succeeded" || locked.status === "failed") {
        return "settled";
      }

      const now = deps.clock.now();
      if (
        locked.providerRefundRef &&
        lookup.providerRefundRef &&
        locked.providerRefundRef !== lookup.providerRefundRef
      ) {
        return "pending";
      }
      const resolvedRef = lookup.providerRefundRef ?? locked.providerRefundRef;

      if (lookup.status === "succeeded" && lookup.providerRefundRef) {
        await settleProviderRefundSucceededInTx(
          tx,
          locked,
          lookup.providerRefundRef,
          lookup.settledAt ?? now,
          null,
        );
        return "settled";
      }

      if (lookup.status === "failed") {
        const failCode = (lookup.failureReasonCode ?? "PROVIDER_REFUND_FAILED").slice(0, 64);
        await tx
          .update(paymentRefunds)
          .set({
            status: "failed",
            providerRefundRef: resolvedRef,
            failureReasonCode: failCode,
            settledAt: now,
            lastReconciledAt: now,
            version: locked.version + 1,
            updatedAt: now,
          })
          .where(eq(paymentRefunds.id, locked.id));

        await deps.audit.record(
          {
            category: "business",
            eventName: "payment.refund.failed",
            action: "create",
            outcome: "failed",
            severity: "WARN",
            reasonCode: failCode,
            actor: { role: "system" },
            resource: { type: "payment_refund", publicId: locked.publicId },
            orderPublicId: locked.orderPublicId,
            attributes: {
              order_public_id: locked.orderPublicId,
              invoice_public_id: locked.invoicePublicId,
              provider: locked.provider,
            },
          },
          tx,
        );
        return "settled";
      }

      // lookup.status is "pending", "unknown", or "absent": never classify unconfirmed/not-yet-visible as failed.
      await tx
        .update(paymentRefunds)
        .set({
          providerRefundRef: resolvedRef,
          lastReconciledAt: now,
          updatedAt: now,
        })
        .where(eq(paymentRefunds.id, locked.id));

      return "pending";
    });
  }

  async function healthCounts(): Promise<{
    provider: PaymentProviderChoice;
    onlineEnabled: boolean;
    redirectedAttempts: number;
    retryPendingWebhooks: number;
  }> {
    const config = await loadConfig();
    const [onlineEnabled, [attRow], [whRow]] = await Promise.all([
      isProviderCredentialsReady(config),
      deps.db
        .select({ total: count() })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.status, "redirected")),
      deps.db
        .select({ total: count() })
        .from(paymentWebhookEvents)
        .where(eq(paymentWebhookEvents.status, "retry_pending")),
    ]);

    return {
      provider: config.provider,
      onlineEnabled,
      redirectedAttempts: attRow?.total ?? 0,
      retryPendingWebhooks: whRow?.total ?? 0,
    };
  }

  /**
   * Authoritative conservative check for G-C3-02 (`compliance.orderPaymentExposureInTx`):
   * `providerAttemptEver` is `true` if ANY `payment_attempts` row has EVER been created for the order or its invoices,
   * regardless of status (`created`, `redirected`, `paid`, `failed`, `cancelled`, `expired`).
   * Uses `FOR SHARE NOWAIT` for a current read that fails closed (`true`) on lock contention without deadlocking.
   */
  async function getAttemptExposureForOrderInTx(
    tx: Tx,
    orderPublicId: string,
    invoiceIds: readonly number[],
  ): Promise<{ providerCapturePending: boolean; providerAttemptEver: boolean }> {
    try {
      const whereClause =
        invoiceIds.length > 0
          ? or(
              eq(paymentAttempts.orderPublicId, orderPublicId),
              inArray(paymentAttempts.invoiceId, [...invoiceIds]),
            )
          : eq(paymentAttempts.orderPublicId, orderPublicId);
      const rows = await tx
        .select({
          id: paymentAttempts.id,
          status: paymentAttempts.status,
          amountMinor: paymentAttempts.amountMinor,
          compliancePaymentPublicId: paymentAttempts.compliancePaymentPublicId,
          verifiedWebhookEventId: paymentAttempts.verifiedWebhookEventId,
        })
        .from(paymentAttempts)
        .where(whereClause)
        .orderBy(asc(paymentAttempts.id))
        .for("share", { noWait: true });
      const providerAttemptEver = rows.length > 0;
      const providerCapturePending = rows.some(
        (r) =>
          r.status === "created" ||
          r.status === "redirected" ||
          r.status === "cancelled" ||
          (r.status === "paid" && r.amountMinor > 0 && r.compliancePaymentPublicId === null) ||
          (r.status === "failed" && r.verifiedWebhookEventId !== null),
      );
      return { providerCapturePending, providerAttemptEver };
    } catch {
      return { providerCapturePending: true, providerAttemptEver: true };
    }
  }

  async function onOrderTrashedInTx(tx: Tx, entity: TrashEntityRef): Promise<void> {
    if (entity.kind !== "order") {
      return;
    }
    const openAttempts = await tx
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.orderPublicId, entity.publicId),
          inArray(paymentAttempts.status, ["created", "redirected"]),
        ),
      )
      .orderBy(asc(paymentAttempts.id))
      .for("update");

    if (openAttempts.length === 0) {
      return;
    }

    const now = deps.clock.now();
    for (const att of openAttempts) {
      await tx
        .update(paymentAttempts)
        .set({
          status: "cancelled",
          cancelledAt: att.cancelledAt ?? now,
          trashCancelledAt: att.trashCancelledAt ?? now,
          failureReasonCode: "ORDER_TRASHED",
          redirectUrlEnc: null,
          version: att.version + 1,
          updatedAt: now,
        })
        .where(eq(paymentAttempts.id, att.id));

      await deps.audit.record(
        {
          category: "business",
          eventName: "payments.attempt.cancelled_on_trash",
          action: "cancel",
          outcome: "completed",
          actor: { role: "system" },
          resource: { type: "payment_attempt", publicId: att.publicId },
          orderPublicId: att.orderPublicId,
          attributes: {
            invoice_public_id: att.invoicePublicId,
            order_public_id: att.orderPublicId,
            provider: att.provider,
            had_provider_ref: Boolean(att.providerRef),
          },
        },
        tx,
      );

      if (att.providerRef && !att.providerCancelledAt) {
        await deps.jobs.enqueue(
          CANCEL_ATTEMPT_PROVIDER_JOB_TYPE,
          { attemptPublicId: att.publicId },
          { idempotencyKey: `pmt-trash-cancel:${att.publicId}` },
          tx,
        );
      }
    }
  }

  async function cancelProviderAttemptFromJob(
    attemptPublicId: string,
    opts?: {
      signal?: AbortSignal | undefined;
      beforeSend?: (() => Promise<void>) | undefined;
      assertOwnedInTx?: ((tx: Tx) => Promise<void>) | undefined;
    },
  ): Promise<{ outcome: "noop" | "cancelled" | "already_cancelled" | "booked_late_payment" }> {
    const [attempt] = await deps.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, attemptPublicId))
      .limit(1);

    if (!attempt || !attempt.providerRef || attempt.providerCancelledAt !== null || attempt.status === "paid") {
      return { outcome: "noop" };
    }

    const config = await loadConfig();
    let credentials: ProviderCredentials;
    let stripeKeyDigest: string | null = null;
    if (attempt.provider === "stripe") {
      const loaded = await loadStripeLookupCredentials(attempt.environment);
      credentials = loaded.credentials;
      stripeKeyDigest = loaded.keyDigest;
    } else {
      const loaded = await loadProviderCredentials(attempt.provider, {
        ...config,
        mode: attempt.environment,
      });
      credentials = loaded.credentials;
    }

    const adapter = adapters[attempt.provider];
    const cancelRes = adapter.cancelCheckout
      ? await adapter.cancelCheckout({
          providerRef: attempt.providerRef,
          providerOrderRef: attempt.providerOrderRef,
          providerPaymentRef: attempt.providerPaymentRef,
          credentials,
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(opts?.beforeSend ? { beforeSend: opts.beforeSend } : {}),
        })
      : { status: "already_cancelled" as const };

    if (cancelRes.status === "already_paid") {
      const fetched = await adapter.fetchPayment({
        providerRef: attempt.providerRef,
        providerOrderRef: attempt.providerOrderRef,
        providerPaymentRef: attempt.providerPaymentRef,
        credentials,
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(opts?.beforeSend ? { beforeSend: opts.beforeSend } : {}),
      });
      await runWithMysqlDeadlockRetry(() =>
        deps.db.transaction(async (tx) => {
          if (opts?.assertOwnedInTx) {
            await opts.assertOwnedInTx(tx);
          }
          if (attempt.provider === "stripe" && stripeKeyDigest) {
            const post = await loadStripeLookupCredentials(attempt.environment, { tx });
            if (post.keyDigest !== stripeKeyDigest) {
              throw new DomainError("UNAVAILABLE", "STRIPE_KEY_DRIFT", "Stripe key rotated during cancel lookup.");
            }
          }
          await bookAuthoritativeAttemptPaymentInTx(tx, {
            attemptId: attempt.id,
            source: "provider_lookup",
            fetched,
          });
        }),
      );
      return { outcome: "booked_late_payment" };
    }

    const now = deps.clock.now();
    await runWithMysqlDeadlockRetry(() =>
      deps.db.transaction(async (tx) => {
        if (opts?.assertOwnedInTx) {
          await opts.assertOwnedInTx(tx);
        }
        await tx
          .update(paymentAttempts)
          .set({
            providerCancelledAt: now,
            updatedAt: now,
          })
          .where(and(eq(paymentAttempts.id, attempt.id), isNull(paymentAttempts.providerCancelledAt)));
      }),
    );

    return { outcome: cancelRes.status };
  }

  async function summarizeOrderForTrash(entity: TrashEntityRef): Promise<Record<string, number>> {
    if (entity.kind !== "order") {
      return {};
    }
    const [[paidAttRow], [openAttRow], [refundRow], [ledgerPaidRow], [ledgerRefundRow]] = await Promise.all([
      deps.db
        .select({ total: count() })
        .from(paymentAttempts)
        .where(and(eq(paymentAttempts.orderPublicId, entity.publicId), eq(paymentAttempts.status, "paid"))),
      deps.db
        .select({ total: count() })
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.orderPublicId, entity.publicId),
            inArray(paymentAttempts.status, ["created", "redirected"]),
          ),
        ),
      deps.db
        .select({ total: count() })
        .from(paymentRefunds)
        .where(
          and(
            eq(paymentRefunds.orderPublicId, entity.publicId),
            inArray(paymentRefunds.status, ["pending", "succeeded", "unknown"]),
          ),
        ),
      deps.db
        .select({ total: count() })
        .from(complianceInvoicePayments)
        .innerJoin(complianceInvoices, eq(complianceInvoicePayments.invoiceId, complianceInvoices.id))
        .where(
          and(
            eq(complianceInvoices.orderPublicId, entity.publicId),
            eq(complianceInvoicePayments.status, "succeeded"),
          ),
        ),
      deps.db
        .select({ total: count() })
        .from(complianceInvoiceRefunds)
        .innerJoin(complianceInvoices, eq(complianceInvoiceRefunds.invoiceId, complianceInvoices.id))
        .where(eq(complianceInvoices.orderPublicId, entity.publicId)),
    ]);

    const payments = Math.max(paidAttRow?.total ?? 0, ledgerPaidRow?.total ?? 0);
    const refunds = Math.max(refundRow?.total ?? 0, ledgerRefundRow?.total ?? 0);
    const paymentAttemptsCount = openAttRow?.total ?? 0;

    const out: Record<string, number> = {};
    if (payments > 0) out.payments = payments;
    if (refunds > 0) out.refunds = refunds;
    if (paymentAttemptsCount > 0) out.paymentAttempts = paymentAttemptsCount;
    return out;
  }

  async function purgeOrderForTrash(entity: TrashEntityRef): Promise<TrashPurgeResult> {
    if (entity.kind !== "order") {
      return { deleted: {} };
    }
    // Scrub any residual encrypted redirect URLs while retaining all payment, refund, and webhook records.
    await deps.db
      .update(paymentAttempts)
      .set({ redirectUrlEnc: null })
      .where(and(eq(paymentAttempts.orderPublicId, entity.publicId), isNotNull(paymentAttempts.redirectUrlEnc)));

    const summary = await summarizeOrderForTrash(entity);
    const kept: Record<string, number> = {};
    if ((summary.payments ?? 0) > 0) kept.payments = summary.payments!;
    if ((summary.refunds ?? 0) > 0) kept.refunds = summary.refunds!;

    return {
      deleted: {},
      ...(Object.keys(kept).length > 0 ? { kept } : {}),
    };
  }

  return {
    isOnlineCheckoutEnabled,
    getPublicCheckoutConfig,
    evaluateCheckoutAmount,
    startCheckout,
    startInvoiceCheckout,
    getCheckoutStatus,
    confirmCheckoutPayment,
    cancelAttemptIfUnpaid,
    handleSignedWebhook,
    recordHttpRejection,
    pruneExpiredWebhookRejections,
    reconcilePendingAttempts,
    reconcileProviderRefund,
    getAttemptExposureForOrderInTx,
    onOrderTrashedInTx,
    cancelProviderAttemptFromJob,
    summarizeOrderForTrash,
    purgeOrderForTrash,
    refunds: {
      forOrder: forOrderRefunds,
      create: createOrderRefund,
    },
    admin: {
      getSettings: adminGetSettings,
      updateSettings: adminUpdateSettings,
      readiness: adminReadiness,
      testConnection: adminTestConnection,
      verifyCheckoutSession: adminVerifyCheckoutSession,
      sendSelfTestWebhook: adminSendSelfTestWebhook,
      listWebhookRejections: adminListWebhookRejections,
      listAttempts: adminListAttempts,
      getAttempt: adminGetAttempt,
      listWebhooks: adminListWebhooks,
      reconcileNow: adminReconcileNow,
      checkWithStripeNow: adminCheckWithStripeNow,
    },
    healthCounts,
  };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;
