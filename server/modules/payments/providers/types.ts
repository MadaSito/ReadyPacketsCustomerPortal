import type { ActivePaymentProvider, PaymentEnvironmentMode } from "../schema.js";

export interface ProviderCredentials {
  mode: PaymentEnvironmentMode;
  /** Stripe `sk_test_...`/`sk_live_...` or Square access token. */
  secretKey: string;
  /** Required for Square (`location_id` for `/v2/online-checkout/payment-links`). */
  squareLocationId?: string | null | undefined;
}

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
      attemptPublicId: string | null;
      invoicePublicId: string | null;
      providerRef: string | null;
      providerOrderRef: string | null;
      providerPaymentRef: string | null;
      outcomeHint: "paid" | "failed" | "expired" | "ignored";
    }
  | {
      ok: false;
      reasonCode: string;
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
  providerRef: string;
  providerOrderRef: string | null;
  providerPaymentRef: string | null;
  status: "paid" | "open" | "failed" | "expired";
  amountMinor: number;
  currency: string;
  livemode: boolean;
  attemptPublicId: string | null;
  invoicePublicId: string | null;
  paidAt: Date | null;
}

export interface PaymentProviderAdapter {
  readonly key: ActivePaymentProvider;
  createCheckout(input: ProviderCreateCheckoutInput): Promise<ProviderCreateCheckoutOutput>;
  verifyWebhook(input: ProviderVerifyWebhookInput): ProviderVerifyWebhookOutput;
  fetchPayment(input: ProviderFetchPaymentInput): Promise<ProviderFetchedPayment>;
}
