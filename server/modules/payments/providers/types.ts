import type { Clock } from "../../../core/types.js";
import type { EgressPolicy } from "../../integrations/egress.js";
import type { ActivePaymentProvider, PaymentEnvironmentMode } from "../schema.js";

export interface PaymentProviderAdapterDeps {
  readonly egress: Pick<EgressPolicy, "fetchPinned">;
  readonly clock: Clock;
}

export interface ProviderCredentials {
  mode: PaymentEnvironmentMode;
  /** Stripe `sk_test_...`/`sk_live_...` or Square access token. */
  secretKey: string;
  /** Required for Square (`location_id` for `/v2/online-checkout/payment-links`). */
  squareLocationId?: string | null | undefined;
}

export type DecryptedProviderCredentials = ProviderCredentials;

export interface ProviderCreateCheckoutInput {
  attemptPublicId: string;
  invoicePublicId: string;
  invoiceNumber: string;
  orderPublicId: string;
  orderReference: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  /** Canonical HTTPS return URL (`https://<canonicalOrigin>/api/payments/return/<provider>/<attemptPublicId>`). */
  returnUrl: string;
  /** Canonical HTTPS cancel URL (`https://<canonicalOrigin>/api/payments/return/<provider>/<attemptPublicId>?outcome=cancelled`). */
  cancelUrl: string;
  credentials: ProviderCredentials;
  signal?: AbortSignal | undefined;
  beforeSend?: (() => Promise<void>) | undefined;
}

export interface ProviderCreateCheckoutOutput {
  redirectUrl: string;
  providerRef: string;
  providerOrderRef?: string | null | undefined;
  providerPaymentRef?: string | null | undefined;
  expiresAt?: Date | null | undefined;
}

export interface ProviderVerifyWebhookInput {
  rawBody: Buffer;
  headers: Readonly<Record<string, string | undefined>>;
  webhookSecret: string;
  secondaryWebhookSecret?: string | null | undefined;
  /** Exact canonical notification URL (`https://<canonicalOrigin>/api/payments/webhooks/<provider>`). */
  notificationUrl: string;
  now: Date;
  toleranceSeconds: number;
}

export type ProviderVerifyWebhookOutput =
  | {
      ok: true;
      externalEventId: string;
      eventType: string;
      occurredAt: Date;
      livemode: boolean;
      matchedSecretSlot?: "primary" | "secondary" | undefined;
      attemptPublicId: string | null;
      invoicePublicId: string | null;
      orderPublicId?: string | null | undefined;
      /**
       * True when the signed provider object explicitly carries ReadyPackets portal metadata
       * (`attempt_public_id`, `invoice_public_id`, or `order_public_id`). Events without portal
       * metadata (e.g. from another product sharing the same Stripe account) leave this false/undefined.
       */
      hasPortalMetadata?: boolean | undefined;
      providerRef: string | null;
      providerOrderRef: string | null;
      providerPaymentRef: string | null;
      providerRefundRef?: string | null | undefined;
      refundPublicIdHint?: string | null | undefined;
      refundStatusHint?: "pending" | "succeeded" | "failed" | null | undefined;
      refundAmountMinorHint?: number | null | undefined;
      refundCurrencyHint?: string | null | undefined;
      outcomeHint: "paid" | "failed" | "expired" | "refund_updated" | "self_test" | "ignored";
    }
  | {
      ok: false;
      reasonCode: string;
      skewSeconds?: number | null | undefined;
      environmentHint?: "test" | "live" | "unknown" | undefined;
    };

export interface ProviderFetchPaymentInput {
  providerRef: string;
  providerOrderRef?: string | null | undefined;
  providerPaymentRef?: string | null | undefined;
  credentials: ProviderCredentials;
  signal?: AbortSignal | undefined;
  beforeSend?: (() => Promise<void>) | undefined;
}

export interface ProviderFetchedPayment {
  /** Echoed upstream session/order/link identifier — never substituted from request input when missing. */
  providerRef: string;
  providerOrderRef: string | null;
  providerPaymentRef: string | null;
  status: "paid" | "open" | "failed" | "expired";
  /** Raw upstream session status when applicable (e.g. Stripe `open` | `complete` | `expired`). */
  sessionStatus?: string | null | undefined;
  /** Raw upstream payment status when applicable (e.g. Stripe `paid` | `unpaid` | `no_payment_required`). */
  paymentStatus?: string | null | undefined;
  /** True when a Stripe session is `complete` while an async payment method is still `unpaid`. */
  asyncPending?: boolean | undefined;
  /** Non-negative integer minor units, or `-1` when upstream `amount_total` was missing/malformed. */
  amountMinor: number;
  /** Explicit flag `false` when upstream amount was missing, negative, or non-integer. */
  amountValid?: boolean | undefined;
  currency: string;
  livemode: boolean;
  /** Explicit flag `false` when upstream `livemode` was missing or non-boolean. */
  livemodeValid?: boolean | undefined;
  attemptPublicId: string | null;
  /** Explicit upstream `client_reference_id` when present. */
  clientReferenceId?: string | null | undefined;
  /** True when `metadata.attempt_public_id` and `client_reference_id` are both present and disagree. */
  hasReferenceConflict?: boolean | undefined;
  invoicePublicId: string | null;
  orderPublicId?: string | null | undefined;
  paymentIntentAttemptPublicId?: string | null | undefined;
  paymentIntentInvoicePublicId?: string | null | undefined;
  paidAt: Date | null;
  paymentMethodBrand?: string | null | undefined;
  paymentMethodLast4?: string | null | undefined;
}

export type ProviderRefundExecutionOutcome =
  | {
      readonly outcome: "succeeded" | "pending";
      readonly providerRefundRef: string;
      readonly settledAt: Date | null;
    }
  | {
      /** Definitive provider 4xx refusal where no refund was created (releases refundable reservation). */
      readonly outcome: "failed";
      readonly failureReasonCode: string;
    }
  | {
      /** Network timeout, 5xx, rate-limit, or unparseable body. NEVER resend POST automatically! */
      readonly outcome: "unknown";
      readonly failureReasonCode: string;
    };

export interface CreateProviderRefundInput {
  readonly credentials: ProviderCredentials;
  readonly refundPublicId: string;
  /** Deterministic idempotency key (`rp-refund-${refundPublicId}`). */
  readonly providerIdempotencyKey: string;
  /** Opaque Square/provider marker: `ReadyPackets refund ${refundPublicId}` (never operator reason PII). */
  readonly refundMarker: string;
  readonly orderPublicId: string;
  readonly invoicePublicId: string;
  readonly invoiceNumber: string;
  readonly providerPaymentRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly signal?: AbortSignal | undefined;
  readonly beforeSend?: (() => Promise<void>) | undefined;
}

export interface LookupProviderRefundInput {
  readonly credentials: ProviderCredentials;
  readonly refundPublicId: string;
  readonly providerIdempotencyKey: string;
  readonly refundMarker: string;
  readonly providerPaymentRef: string;
  readonly providerRefundRef: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly signal?: AbortSignal | undefined;
  readonly beforeSend?: (() => Promise<void>) | undefined;
}

export interface ProviderRefundLookupResult {
  /** `"absent"` = provider authoritatively responded and has no matching refund on the payment; `"unknown"` = transient/network lookup error (keep retrying). */
  readonly status: "succeeded" | "pending" | "failed" | "absent" | "unknown";
  readonly providerRefundRef: string | null;
  readonly failureReasonCode: string | null;
  readonly settledAt: Date | null;
}

export interface ProviderListedRefundItem {
  readonly providerRefundRef: string;
  readonly refundPublicIdHint: string | null;
  readonly status: "succeeded" | "pending" | "failed" | "unknown";
  readonly amountMinor: number;
  readonly currency: string;
  readonly settledAt: Date | null;
  readonly failureReasonCode: string | null;
}

export interface ProviderListPaymentRefundsInput {
  readonly credentials: ProviderCredentials;
  readonly providerPaymentRef: string;
  readonly signal?: AbortSignal | undefined;
  readonly beforeSend?: (() => Promise<void>) | undefined;
}

export interface ProviderListPaymentRefundsResult {
  readonly ok: boolean;
  readonly items: readonly ProviderListedRefundItem[];
  readonly failureReasonCode: string | null;
}

export interface ProviderTestConnectionInput {
  readonly credentials: ProviderCredentials;
  readonly now: Date;
  readonly signal?: AbortSignal | undefined;
}

export interface ProviderTestConnectionResult {
  readonly ok: boolean;
  readonly mode: PaymentEnvironmentMode;
  readonly latencyMs: number;
  readonly verifiedAt: Date | null;
  readonly reasonCode: string | null;
  readonly upstreamStatus?: number | null | undefined;
  readonly stripeErrorType?: string | null | undefined;
  readonly stripeErrorCode?: string | null | undefined;
}

export interface ProviderVerifyCheckoutSessionInput {
  readonly credentials: ProviderCredentials;
  readonly currency: string;
  readonly canonicalOrigin: string;
  readonly now: Date;
  readonly signal?: AbortSignal | undefined;
}

export interface ProviderVerifyCheckoutSessionResult {
  readonly ok: boolean;
  readonly mode: PaymentEnvironmentMode;
  readonly latencyMs: number;
  readonly verifiedAt: Date | null;
  readonly sessionId: string | null;
  readonly expiredImmediately: boolean;
  readonly reasonCode: string | null;
  readonly upstreamStatus?: number | null | undefined;
  readonly stripeErrorType?: string | null | undefined;
  readonly stripeErrorCode?: string | null | undefined;
  readonly stripeErrorParam?: string | null | undefined;
}

export interface PaymentRefundAdapter<P extends ActivePaymentProvider = ActivePaymentProvider> {
  readonly provider: P;
  createRefund(input: CreateProviderRefundInput): Promise<ProviderRefundExecutionOutcome>;
  /** Read-only GET lookup (NEVER sends POST). Used by reconcile job and webhook verification. */
  lookupRefund(input: LookupProviderRefundInput): Promise<ProviderRefundLookupResult>;
  /** Read-only GET list of upstream refunds on a payment/charge (used when `charge.refunded` omits `refunds.data`). */
  listPaymentRefunds?(input: ProviderListPaymentRefundsInput): Promise<ProviderListPaymentRefundsResult>;
}

export interface PaymentProviderAdapter {
  readonly key: ActivePaymentProvider;
  createCheckout(input: ProviderCreateCheckoutInput): Promise<ProviderCreateCheckoutOutput>;
  verifyWebhook(input: ProviderVerifyWebhookInput): ProviderVerifyWebhookOutput;
  fetchPayment(input: ProviderFetchPaymentInput): Promise<ProviderFetchedPayment>;
  testConnection?(input: ProviderTestConnectionInput): Promise<ProviderTestConnectionResult>;
  verifyCheckoutSession?(
    input: ProviderVerifyCheckoutSessionInput,
  ): Promise<ProviderVerifyCheckoutSessionResult>;
}
