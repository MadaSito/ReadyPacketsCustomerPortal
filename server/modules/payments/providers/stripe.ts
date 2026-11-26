/**
 * Stripe Hosted Checkout Provider Adapter (`server/modules/payments/providers/stripe.ts`).
 *
 * Zero Stripe SDK dependency:
 *  - `POST https://api.stripe.com/v1/checkout/sessions` (`application/x-www-form-urlencoded`) over
 *    `services.integrations.egress.fetchPinned` (`purpose: "stripe"`, `requireAllowlistRule: true`,
 *    `publicAddressesOnly: true`).
 *  - `verifyWebhook`: constant-time HMAC-SHA256 verification of `Stripe-Signature` (`t=<sec>,v1=<hex>`)
 *    over the exact raw `Buffer` BEFORE `JSON.parse`, enforcing `|now - t| <= toleranceSeconds` (`<= 300s`).
 *  - `fetchPayment`: `GET https://api.stripe.com/v1/checkout/sessions/{id}?expand[]=payment_intent`
 *    verifying `livemode`, `status`, `payment_status`, integer `amount_total`, uppercase `currency`,
 *    `metadata.attempt_public_id`, `metadata.invoice_public_id`, and refusing refunded charges.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ModuleDeps } from "../../../container.js";
import { DomainError, validation } from "../../../core/errors.js";
import { ulid } from "../../../core/ids.js";
import type { EgressPolicy } from "../../integrations/egress.js";
import { resolveProviderMinimumMinor, sanitizeStripeDiagnosticToken } from "../settings.js";
import type {
  CreateProviderRefundInput,
  LookupProviderRefundInput,
  PaymentProviderAdapter,
  PaymentRefundAdapter,
  ProviderCreateCheckoutInput,
  ProviderCreateCheckoutOutput,
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
} from "./types.js";

const STRIPE_API_HOST = "api.stripe.com";
const STRIPE_API_ORIGIN = `https://${STRIPE_API_HOST}`;
const STRIPE_API_VERSION = "2024-06-20";
const MAX_STRIPE_RESPONSE_BYTES = 256 * 1024;
const STRIPE_TIMEOUT_MS = 12_000;

export const STRIPE_REQUIRED_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "payment_intent.payment_failed",
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "charge.refund.updated",
] as const;

export function buildSignedStripeSelfTestWebhook(input: {
  webhookSecret: string;
  mode: "test" | "live";
  now: Date;
}): {
  eventId: string;
  rawBody: Buffer;
  headers: Readonly<Record<string, string>>;
} {
  const token = ulid(input.now.getTime());
  const eventId = `evt_test_rp_selftest_${token}`;
  const createdSec = Math.floor(input.now.getTime() / 1000);
  const rawBody = Buffer.from(
    JSON.stringify({
      id: eventId,
      object: "event",
      api_version: STRIPE_API_VERSION,
      created: createdSec,
      livemode: input.mode === "live",
      type: "readypackets.self_test",
      data: {
        object: {
          id: `selftest_${token}`,
          object: "readypackets.self_test",
        },
      },
    }),
    "utf8",
  );
  const v1 = createHmac("sha256", input.webhookSecret)
    .update(`${createdSec}.`, "utf8")
    .update(rawBody)
    .digest("hex");
  return {
    eventId,
    rawBody,
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${createdSec},v1=${v1}`,
    },
  };
}

export function isAllowedStripeHostedUrl(rawUrl: string): boolean {
  if (rawUrl.length > 2048 || /[\s"'<>\\]/u.test(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return false;
    return parsed.hostname === "checkout.stripe.com";
  } catch {
    return false;
  }
}

function assertStripeKeyMatchesMode(secretKey: string, mode: "test" | "live"): void {
  const expectedPrefix = mode === "live" ? /^(?:sk|rk)_live_/u : /^(?:sk|rk)_test_/u;
  if (!expectedPrefix.test(secretKey)) {
    throw validation(
      "STRIPE_KEY_MODE_MISMATCH",
      `Stripe API key prefix does not match configured ${mode} environment.`,
    );
  }
}

function parseStripeSignatureHeader(headerValue: string): { timestamp: number; v1Signatures: Buffer[] } | null {
  if (!headerValue || headerValue.length > 2048) return null;
  let timestamp: number | null = null;
  const v1Signatures: Buffer[] = [];
  for (const part of headerValue.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === "t") {
      if (!/^\d{9,12}$/u.test(val)) return null;
      timestamp = Number.parseInt(val, 10);
    } else if (key === "v1" && /^[0-9a-fA-F]{64}$/u.test(val)) {
      v1Signatures.push(Buffer.from(val, "hex"));
    }
  }
  if (timestamp === null || !Number.isSafeInteger(timestamp) || v1Signatures.length === 0) {
    return null;
  }
  return { timestamp, v1Signatures };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface SafeStripeErrorDiagnostics {
  readonly stripeErrorType: string | null;
  readonly stripeErrorCode: string | null;
  readonly stripeErrorParam: string | null;
}

/**
 * Extracts bounded, secret-safe Stripe error tokens (`error.type`, `error.code`, `error.param`).
 * NEVER inspects or returns `error.message` because Stripe 401/400 messages can echo rejected keys.
 */
export function extractSafeStripeErrorDiagnostics(
  rawBody: Buffer | string | null | undefined,
): SafeStripeErrorDiagnostics {
  if (!rawBody) {
    return { stripeErrorType: null, stripeErrorCode: null, stripeErrorParam: null };
  }
  try {
    const text = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const parsed = asRecord(JSON.parse(text));
    const errObj = asRecord(parsed?.error);
    if (!errObj) {
      return { stripeErrorType: null, stripeErrorCode: null, stripeErrorParam: null };
    }
    return {
      stripeErrorType: sanitizeStripeDiagnosticToken(errObj.type),
      stripeErrorCode: sanitizeStripeDiagnosticToken(errObj.code),
      stripeErrorParam: sanitizeStripeDiagnosticToken(errObj.param, { allowBrackets: true }),
    };
  } catch {
    return { stripeErrorType: null, stripeErrorCode: null, stripeErrorParam: null };
  }
}

function classifyStripeNon2xxStatus(status: number): string {
  if (status === 401) return "STRIPE_AUTH_INVALID_KEY";
  if (status === 403) return "STRIPE_KEY_MISSING_PERMISSION";
  if (status === 429) return "STRIPE_RATE_LIMITED";
  if (status === 400) return "STRIPE_INVALID_REQUEST";
  if (status > 400 && status < 500) return "STRIPE_HTTP_4XX";
  return "STRIPE_UPSTREAM_5XX";
}

function mapStripeCheckoutTransportError(err: unknown): never {
  if (err instanceof DomainError) {
    if (err.reasonCode === "EGRESS_TIMEOUT" || err.reasonCode === "EGRESS_DNS_TIMEOUT") {
      throw new DomainError(
        "UNAVAILABLE",
        "STRIPE_NETWORK_TIMEOUT",
        "Connecting to Stripe timed out.",
        { egressReasonCode: err.reasonCode },
      );
    }
    if (
      err.reasonCode === "EGRESS_CONNECT_REFUSED" ||
      err.reasonCode === "EGRESS_CONNECTION_FAILED" ||
      err.reasonCode === "EGRESS_DNS_RESOLUTION_FAILED" ||
      err.reasonCode === "EGRESS_NETWORK_ERROR" ||
      err.reasonCode === "EGRESS_ABORTED"
    ) {
      throw new DomainError(
        "UNAVAILABLE",
        "STRIPE_TRANSPORT_FAILED",
        "Connecting to Stripe failed before receiving an HTTP response.",
        { egressReasonCode: err.reasonCode },
      );
    }
    throw err;
  }
  const msg = err instanceof Error ? `${err.name} ${err.message}` : "";
  if (/timeout|timed out|etimedout|aborterror/iu.test(msg)) {
    throw new DomainError("UNAVAILABLE", "STRIPE_NETWORK_TIMEOUT", "Connecting to Stripe timed out.");
  }
  throw new DomainError(
    "UNAVAILABLE",
    "STRIPE_TRANSPORT_FAILED",
    "Connecting to Stripe failed before receiving an HTTP response.",
  );
}

function isSuspectedCustomDomainRedirect(rawUrl: string): boolean {
  if (!rawUrl || rawUrl.length > 2048 || /[\s"'<>\\]/u.test(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) && parsed.hostname !== "checkout.stripe.com";
  } catch {
    return false;
  }
}

export function createStripeProvider(
  getEgress: () => Pick<EgressPolicy, "fetchPinned">,
): PaymentProviderAdapter {
  return {
    key: "stripe",

    async createCheckout(input: ProviderCreateCheckoutInput): Promise<ProviderCreateCheckoutOutput> {
      assertStripeKeyMatchesMode(input.credentials.secretKey, input.credentials.mode);

      const params = new URLSearchParams();
      params.set("mode", "payment");
      params.set("success_url", input.returnUrl);
      params.set("cancel_url", input.cancelUrl);
      params.set("client_reference_id", input.attemptPublicId);
      params.set("metadata[attempt_public_id]", input.attemptPublicId);
      params.set("metadata[invoice_public_id]", input.invoicePublicId);
      params.set("metadata[order_public_id]", input.orderPublicId);
      params.set("payment_intent_data[metadata][attempt_public_id]", input.attemptPublicId);
      params.set("payment_intent_data[metadata][invoice_public_id]", input.invoicePublicId);
      params.set("line_items[0][quantity]", "1");
      params.set("line_items[0][price_data][currency]", input.currency.toLowerCase());
      params.set("line_items[0][price_data][unit_amount]", String(input.amountMinor));
      params.set(
        "line_items[0][price_data][product_data][name]",
        `Invoice ${input.invoiceNumber} (${input.orderReference})`.slice(0, 120),
      );

      let response;
      try {
        const egress = getEgress();
        response = await egress.fetchPinned(
          new URL("/v1/checkout/sessions", STRIPE_API_ORIGIN),
          "stripe",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${input.credentials.secretKey}`,
              "content-type": "application/x-www-form-urlencoded",
              "stripe-version": STRIPE_API_VERSION,
              "idempotency-key": `rp-checkout:${input.attemptPublicId}:${input.idempotencyKey}`.slice(0, 200),
            },
            body: params.toString(),
            timeoutMs: STRIPE_TIMEOUT_MS,
            maxRequestBytes: 16 * 1024,
            maxResponseBytes: MAX_STRIPE_RESPONSE_BYTES,
            requireAllowlistRule: true,
            publicAddressesOnly: true,
            expectedHostSuffixes: [STRIPE_API_HOST],
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.beforeSend ? { beforeSend: input.beforeSend } : {}),
          },
        );
      } catch (err) {
        mapStripeCheckoutTransportError(err);
      }

      if (response.status < 200 || response.status >= 300) {
        const diag = extractSafeStripeErrorDiagnostics(response.body);
        const reasonCode = classifyStripeNon2xxStatus(response.status);
        throw new DomainError(
          "UNAVAILABLE",
          reasonCode,
          "Stripe Checkout session could not be created.",
          {
            upstreamStatus: response.status,
            ...(diag.stripeErrorType ? { stripeErrorType: diag.stripeErrorType } : {}),
            ...(diag.stripeErrorCode ? { stripeErrorCode: diag.stripeErrorCode } : {}),
            ...(diag.stripeErrorParam ? { stripeErrorParam: diag.stripeErrorParam } : {}),
          },
        );
      }

      let parsed: Record<string, unknown> | null;
      try {
        parsed = asRecord(JSON.parse(response.body.toString("utf8")));
      } catch {
        throw new DomainError("UNAVAILABLE", "STRIPE_INVALID_JSON", "Invalid JSON returned by Stripe.", {
          upstreamStatus: response.status,
        });
      }

      const sessionId = typeof parsed?.id === "string" ? parsed.id.trim() : "";
      const redirectUrl = typeof parsed?.url === "string" ? parsed.url.trim() : "";
      const livemode = parsed?.livemode === true;
      const expectedLivemode = input.credentials.mode === "live";

      if (!/^cs_[A-Za-z0-9_]{8,120}$/u.test(sessionId)) {
        throw new DomainError(
          "UNAVAILABLE",
          "STRIPE_INVALID_SESSION_ID",
          "Stripe returned an invalid session id.",
          { upstreamStatus: response.status },
        );
      }
      if (livemode !== expectedLivemode) {
        throw new DomainError(
          "CONFLICT",
          "STRIPE_MODE_MISMATCH",
          "Stripe session livemode did not match portal mode.",
          { upstreamStatus: response.status },
        );
      }
      if (!isAllowedStripeHostedUrl(redirectUrl)) {
        throw new DomainError(
          "UNAVAILABLE",
          "STRIPE_UNTRUSTED_REDIRECT_URL",
          "Stripe returned an untrusted hosted checkout URL.",
          {
            upstreamStatus: response.status,
            customDomainSuspected: isSuspectedCustomDomainRedirect(redirectUrl),
          },
        );
      }

      const paymentIntentRaw = parsed?.payment_intent;
      const paymentIntentId =
        typeof paymentIntentRaw === "string"
          ? paymentIntentRaw
          : typeof asRecord(paymentIntentRaw)?.id === "string"
            ? (asRecord(paymentIntentRaw)!.id as string)
            : null;

      const expiresAtSec = typeof parsed?.expires_at === "number" ? parsed.expires_at : null;
      const expiresAt =
        expiresAtSec !== null && Number.isSafeInteger(expiresAtSec) && expiresAtSec > 0
          ? new Date(expiresAtSec * 1000)
          : null;

      return {
        redirectUrl,
        providerRef: sessionId,
        providerOrderRef: paymentIntentId,
        providerPaymentRef: paymentIntentId,
        expiresAt,
      };
    },

    verifyWebhook(input: ProviderVerifyWebhookInput): ProviderVerifyWebhookOutput {
      const sigHeader = input.headers["stripe-signature"];
      if (!sigHeader) {
        return { ok: false, reasonCode: "MISSING_SIGNATURE" };
      }
      const parsedSig = parseStripeSignatureHeader(sigHeader);
      if (!parsedSig) {
        return { ok: false, reasonCode: "MALFORMED_SIGNATURE" };
      }

      const expectedPrimaryMac = createHmac("sha256", input.webhookSecret)
        .update(`${parsedSig.timestamp}.`, "utf8")
        .update(input.rawBody)
        .digest();

      const expectedSecondaryMac =
        input.secondaryWebhookSecret && input.secondaryWebhookSecret.trim().length > 0
          ? createHmac("sha256", input.secondaryWebhookSecret.trim())
              .update(`${parsedSig.timestamp}.`, "utf8")
              .update(input.rawBody)
              .digest()
          : null;

      let matchedSecretSlot: "primary" | "secondary" | null = null;
      for (const candidate of parsedSig.v1Signatures) {
        if (
          candidate.byteLength === expectedPrimaryMac.byteLength &&
          timingSafeEqual(candidate, expectedPrimaryMac)
        ) {
          matchedSecretSlot = "primary";
        } else if (
          expectedSecondaryMac &&
          candidate.byteLength === expectedSecondaryMac.byteLength &&
          timingSafeEqual(candidate, expectedSecondaryMac)
        ) {
          matchedSecretSlot ??= "secondary";
        }
      }
      if (!matchedSecretSlot) {
        return { ok: false, reasonCode: "INVALID_SIGNATURE" };
      }

      const nowSeconds = Math.floor(input.now.getTime() / 1000);
      const tolerance = Math.min(Math.max(input.toleranceSeconds, 30), 300);
      const skewSeconds = Math.abs(nowSeconds - parsedSig.timestamp);
      if (skewSeconds > tolerance) {
        return { ok: false, reasonCode: "TIMESTAMP_OUT_OF_RANGE", skewSeconds };
      }

      let payload: Record<string, unknown> | null;
      try {
        payload = asRecord(JSON.parse(input.rawBody.toString("utf8")));
      } catch {
        return { ok: false, reasonCode: "INVALID_JSON", skewSeconds };
      }
      if (!payload) {
        return { ok: false, reasonCode: "INVALID_EVENT_PAYLOAD", skewSeconds };
      }

      const externalEventId = typeof payload.id === "string" ? payload.id.trim() : "";
      const eventType = typeof payload.type === "string" ? payload.type.trim() : "";
      const livemodeValid = typeof payload.livemode === "boolean";
      const livemode = payload.livemode === true;
      const environmentHint = livemodeValid ? (livemode ? "live" : "test") : "unknown";
      const createdSec = typeof payload.created === "number" ? payload.created : parsedSig.timestamp;

      if (
        !livemodeValid ||
        !/^evt_[A-Za-z0-9_]{6,120}$/u.test(externalEventId) ||
        !eventType ||
        eventType.length > 96
      ) {
        return { ok: false, reasonCode: "INVALID_EVENT_ENVELOPE", skewSeconds, environmentHint };
      }

      const dataObj = asRecord(asRecord(payload.data)?.object);
      const metadata = asRecord(dataObj?.metadata);
      const objectId = typeof dataObj?.id === "string" ? dataObj.id.trim() : null;
      const clientReferenceId =
        typeof dataObj?.client_reference_id === "string" && dataObj.client_reference_id.trim() !== ""
          ? dataObj.client_reference_id.trim()
          : null;
      const metaAttemptId =
        typeof metadata?.attempt_public_id === "string" && metadata.attempt_public_id.trim() !== ""
          ? metadata.attempt_public_id.trim()
          : null;
      if (metaAttemptId && clientReferenceId && metaAttemptId !== clientReferenceId) {
        return { ok: false, reasonCode: "INVALID_EVENT_ENVELOPE", skewSeconds, environmentHint };
      }
      const metaInvoiceId =
        typeof metadata?.invoice_public_id === "string" && metadata.invoice_public_id.trim() !== ""
          ? metadata.invoice_public_id.trim()
          : null;
      const metaOrderId =
        typeof metadata?.order_public_id === "string" && metadata.order_public_id.trim() !== ""
          ? metadata.order_public_id.trim()
          : null;
      const hasPortalMetadata = Boolean(metaAttemptId || metaInvoiceId || metaOrderId);

      const attemptPublicId = metaAttemptId ?? clientReferenceId;
      const paymentIntentRaw = dataObj?.payment_intent;
      const paymentIntentId =
        typeof paymentIntentRaw === "string"
          ? paymentIntentRaw
          : typeof asRecord(paymentIntentRaw)?.id === "string"
            ? (asRecord(paymentIntentRaw)!.id as string)
            : null;
      const chargeRaw = dataObj?.charge;
      const chargeId =
        typeof chargeRaw === "string"
          ? chargeRaw
          : typeof asRecord(chargeRaw)?.id === "string"
            ? (asRecord(chargeRaw)!.id as string)
            : null;

      let outcomeHint: "paid" | "failed" | "expired" | "refund_updated" | "self_test" | "ignored" = "ignored";
      let providerRef: string | null = null;
      let providerOrderRef: string | null = paymentIntentId;
      let providerPaymentRef: string | null = paymentIntentId;
      let providerRefundRef: string | null = null;
      let refundPublicIdHint: string | null = null;
      let refundStatusHint: "pending" | "succeeded" | "failed" | null = null;
      let refundAmountMinorHint: number | null = null;
      let refundCurrencyHint: string | null = null;

      const parseRefundStatusHint = (raw: unknown): "pending" | "succeeded" | "failed" | null => {
        if (raw === "succeeded") return "succeeded";
        if (raw === "pending" || raw === "requires_action") return "pending";
        if (raw === "failed" || raw === "canceled") return "failed";
        return null;
      };

      if (
        eventType === "checkout.session.completed" ||
        eventType === "checkout.session.async_payment_succeeded"
      ) {
        outcomeHint = "paid";
        providerRef = objectId;
      } else if (eventType === "checkout.session.async_payment_failed") {
        outcomeHint = "failed";
        providerRef = objectId;
      } else if (eventType === "checkout.session.expired") {
        outcomeHint = "expired";
        providerRef = objectId;
      } else if (eventType === "payment_intent.payment_failed") {
        outcomeHint = "failed";
        providerOrderRef = objectId;
        providerPaymentRef = objectId;
      } else if (
        eventType === "refund.created" ||
        eventType === "refund.updated" ||
        eventType === "charge.refund.updated"
      ) {
        outcomeHint = "refund_updated";
        providerRefundRef = objectId && /^re_[A-Za-z0-9_]{6,120}$/u.test(objectId) ? objectId : null;
        providerPaymentRef = paymentIntentId ?? chargeId;
        const metaRefundId =
          typeof metadata?.refund_public_id === "string" ? metadata.refund_public_id.trim() : null;
        refundPublicIdHint =
          metaRefundId && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(metaRefundId) ? metaRefundId : null;
        refundStatusHint = parseRefundStatusHint(dataObj?.status);
        refundAmountMinorHint =
          typeof dataObj?.amount === "number" && Number.isSafeInteger(dataObj.amount) && dataObj.amount > 0
            ? dataObj.amount
            : null;
        refundCurrencyHint =
          typeof dataObj?.currency === "string" && /^[a-zA-Z]{3}$/u.test(dataObj.currency)
            ? dataObj.currency.toUpperCase()
            : null;
      } else if (eventType === "charge.refunded") {
        outcomeHint = "refund_updated";
        providerPaymentRef = paymentIntentId ?? objectId;
        const refundsList = asRecord(dataObj?.refunds)?.data;
        if (Array.isArray(refundsList) && refundsList.length > 0) {
          const portalRefundCandidate = refundsList.find((entry) => {
            const meta = asRecord(asRecord(entry)?.metadata);
            const pubId = typeof meta?.refund_public_id === "string" ? meta.refund_public_id.trim() : "";
            return /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(pubId);
          });
          const latestRefund = asRecord(portalRefundCandidate ?? refundsList[0]);
          const rId = typeof latestRefund?.id === "string" ? latestRefund.id.trim() : null;
          const rMeta = asRecord(latestRefund?.metadata);
          const rPubId =
            typeof rMeta?.refund_public_id === "string" ? rMeta.refund_public_id.trim() : null;
          providerRefundRef = rId && /^re_[A-Za-z0-9_]{6,120}$/u.test(rId) ? rId : null;
          refundPublicIdHint =
            rPubId && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(rPubId) ? rPubId : null;
          refundStatusHint = parseRefundStatusHint(latestRefund?.status);
          refundAmountMinorHint =
            typeof latestRefund?.amount === "number" &&
            Number.isSafeInteger(latestRefund.amount) &&
            latestRefund.amount > 0
              ? latestRefund.amount
              : null;
          refundCurrencyHint =
            typeof latestRefund?.currency === "string" && /^[a-zA-Z]{3}$/u.test(latestRefund.currency)
              ? latestRefund.currency.toUpperCase()
              : null;
        }
      } else if (
        eventType === "readypackets.self_test" &&
        /^evt_test_rp_selftest_[0-9A-HJKMNP-TV-Z]{26}$/u.test(externalEventId)
      ) {
        outcomeHint = "self_test";
      }

      return {
        ok: true,
        externalEventId,
        eventType,
        occurredAt: new Date(createdSec * 1000),
        livemode,
        matchedSecretSlot,
        attemptPublicId: attemptPublicId && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(attemptPublicId) ? attemptPublicId : null,
        invoicePublicId: metaInvoiceId && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(metaInvoiceId) ? metaInvoiceId : null,
        orderPublicId: metaOrderId && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(metaOrderId) ? metaOrderId : null,
        hasPortalMetadata,
        providerRef,
        providerOrderRef,
        providerPaymentRef,
        providerRefundRef,
        refundPublicIdHint,
        refundStatusHint,
        refundAmountMinorHint,
        refundCurrencyHint,
        outcomeHint,
      };
    },

    async fetchPayment(input: ProviderFetchPaymentInput): Promise<ProviderFetchedPayment> {
      assertStripeKeyMatchesMode(input.credentials.secretKey, input.credentials.mode);
      if (!/^cs_[A-Za-z0-9_]{8,120}$/u.test(input.providerRef)) {
        throw validation("INVALID_STRIPE_SESSION_ID", "Invalid Stripe Checkout Session reference.");
      }

      const egress = getEgress();
      const targetUrl = new URL(
        `/v1/checkout/sessions/${encodeURIComponent(input.providerRef)}?expand[]=payment_intent.latest_charge`,
        STRIPE_API_ORIGIN,
      );
      const response = await egress.fetchPinned(targetUrl, "stripe", {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.credentials.secretKey}`,
          "stripe-version": STRIPE_API_VERSION,
        },
        timeoutMs: STRIPE_TIMEOUT_MS,
        maxResponseBytes: MAX_STRIPE_RESPONSE_BYTES,
        requireAllowlistRule: true,
        publicAddressesOnly: true,
        expectedHostSuffixes: [STRIPE_API_HOST],
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.beforeSend ? { beforeSend: input.beforeSend } : {}),
      });

      if (response.status < 200 || response.status >= 300) {
        throw new DomainError(
          "UNAVAILABLE",
          "STRIPE_FETCH_SESSION_FAILED",
          "Failed to fetch Stripe Checkout session.",
          { upstreamStatus: response.status },
        );
      }

      let parsed: Record<string, unknown> | null;
      try {
        parsed = asRecord(JSON.parse(response.body.toString("utf8")));
      } catch {
        throw new DomainError("UNAVAILABLE", "STRIPE_INVALID_JSON", "Invalid JSON returned by Stripe.");
      }
      if (!parsed) {
        throw new DomainError("UNAVAILABLE", "STRIPE_INVALID_RESPONSE", "Malformed Stripe session payload.");
      }

      const sessionId = typeof parsed.id === "string" ? parsed.id.trim() : "";
      const sessionStatus = typeof parsed.status === "string" ? parsed.status.trim() : "";
      const paymentStatus = typeof parsed.payment_status === "string" ? parsed.payment_status.trim() : "";
      const amountValid =
        typeof parsed.amount_total === "number" &&
        Number.isSafeInteger(parsed.amount_total) &&
        parsed.amount_total >= 0;
      const amountMinor = amountValid ? (parsed.amount_total as number) : -1;
      const currency = typeof parsed.currency === "string" ? parsed.currency.trim().toUpperCase() : "";
      const livemodeValid = typeof parsed.livemode === "boolean";
      const livemode = parsed.livemode === true;
      const metadata = asRecord(parsed.metadata);
      const clientReferenceId =
        typeof parsed.client_reference_id === "string" && parsed.client_reference_id.trim().length > 0
          ? parsed.client_reference_id.trim()
          : null;
      const metadataAttemptPublicId =
        typeof metadata?.attempt_public_id === "string" && metadata.attempt_public_id.trim().length > 0
          ? metadata.attempt_public_id.trim()
          : null;
      const hasReferenceConflict = Boolean(
        metadataAttemptPublicId && clientReferenceId && metadataAttemptPublicId !== clientReferenceId,
      );
      // Strict authoritative binding: never synthesize `attemptPublicId` from `client_reference_id`.
      const attemptPublicId = metadataAttemptPublicId;
      const invoicePublicId =
        typeof metadata?.invoice_public_id === "string" && metadata.invoice_public_id.trim().length > 0
          ? metadata.invoice_public_id.trim()
          : null;
      const orderPublicId =
        typeof metadata?.order_public_id === "string" && metadata.order_public_id.trim().length > 0
          ? metadata.order_public_id.trim()
          : null;

      const piObj = asRecord(parsed.payment_intent);
      const piMetadata = asRecord(piObj?.metadata);
      const paymentIntentAttemptPublicId =
        typeof piMetadata?.attempt_public_id === "string" && piMetadata.attempt_public_id.trim().length > 0
          ? piMetadata.attempt_public_id.trim()
          : null;
      const paymentIntentInvoicePublicId =
        typeof piMetadata?.invoice_public_id === "string" && piMetadata.invoice_public_id.trim().length > 0
          ? piMetadata.invoice_public_id.trim()
          : null;
      const paymentIntentId =
        typeof parsed.payment_intent === "string" && parsed.payment_intent.trim().length > 0
          ? parsed.payment_intent.trim()
          : typeof piObj?.id === "string" && piObj.id.trim().length > 0
            ? piObj.id.trim()
            : null;
      const amountRefunded = typeof piObj?.amount_refunded === "number" ? piObj.amount_refunded : 0;
      const piCreated = typeof piObj?.created === "number" ? new Date(piObj.created * 1000) : null;

      // Extract non-sensitive card brand & last4 when Stripe expands `latest_charge` or `charges.data[0]`.
      const latestChargeObj =
        asRecord(piObj?.latest_charge) ??
        (Array.isArray(asRecord(piObj?.charges)?.data)
          ? asRecord((asRecord(piObj?.charges)?.data as unknown[])[0])
          : null);
      const pmDetails = asRecord(latestChargeObj?.payment_method_details);
      const cardDetails = asRecord(pmDetails?.card);
      const rawBrand = typeof cardDetails?.brand === "string" ? cardDetails.brand.trim().toLowerCase() : "";
      const paymentMethodBrand =
        rawBrand && /^[a-z][a-z0-9_-]{0,31}$/u.test(rawBrand) && !/\d{4,}/u.test(rawBrand)
          ? rawBrand
          : null;
      const rawLast4 = typeof cardDetails?.last4 === "string" ? cardDetails.last4.trim() : "";
      const paymentMethodLast4 = /^[0-9]{4}$/u.test(rawLast4) ? rawLast4 : null;

      const asyncPending =
        amountRefunded <= 0 &&
        sessionStatus === "complete" &&
        paymentStatus === "unpaid" &&
        piObj?.status !== "canceled";

      let status: "paid" | "open" | "failed" | "expired" = "open";
      if (amountRefunded > 0) {
        status = "failed";
      } else if (
        sessionStatus === "complete" &&
        (paymentStatus === "paid" || paymentStatus === "no_payment_required")
      ) {
        status = "paid";
      } else if (sessionStatus === "expired") {
        status = "expired";
      } else if (piObj?.status === "canceled") {
        status = "failed";
      }

      return {
        providerRef: sessionId,
        providerOrderRef: paymentIntentId,
        providerPaymentRef: paymentIntentId ?? (sessionId || null),
        status,
        sessionStatus: sessionStatus || null,
        paymentStatus: paymentStatus || null,
        asyncPending,
        amountMinor,
        amountValid,
        currency,
        livemode,
        livemodeValid,
        attemptPublicId,
        clientReferenceId,
        hasReferenceConflict,
        invoicePublicId,
        orderPublicId,
        paymentIntentAttemptPublicId,
        paymentIntentInvoicePublicId,
        paidAt: status === "paid" ? piCreated : null,
        paymentMethodBrand,
        paymentMethodLast4,
      };
    },

    async testConnection(input: ProviderTestConnectionInput): Promise<ProviderTestConnectionResult> {
      const startedMs = Date.now();
      try {
        assertStripeKeyMatchesMode(input.credentials.secretKey, input.credentials.mode);
      } catch {
        return {
          ok: false,
          mode: input.credentials.mode,
          latencyMs: Math.max(0, Date.now() - startedMs),
          verifiedAt: null,
          reasonCode: "STRIPE_KEY_MODE_MISMATCH",
        };
      }

      let response;
      try {
        const egress = getEgress();
        response = await egress.fetchPinned(
          new URL("/v1/checkout/sessions?limit=1", STRIPE_API_ORIGIN),
          "stripe",
          {
            method: "GET",
            headers: {
              authorization: `Bearer ${input.credentials.secretKey}`,
              "stripe-version": STRIPE_API_VERSION,
            },
            timeoutMs: STRIPE_TIMEOUT_MS,
            maxResponseBytes: MAX_STRIPE_RESPONSE_BYTES,
            requireAllowlistRule: true,
            publicAddressesOnly: true,
            expectedHostSuffixes: [STRIPE_API_HOST],
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
      } catch (err) {
        const reasonCode =
          err instanceof DomainError && /^[A-Z0-9_]{2,64}$/u.test(err.reasonCode)
            ? err.reasonCode
            : "STRIPE_EGRESS_OR_NETWORK_FAILED";
        return {
          ok: false,
          mode: input.credentials.mode,
          latencyMs: Math.max(0, Date.now() - startedMs),
          verifiedAt: null,
          reasonCode,
        };
      }

      const latencyMs = Math.max(0, Date.now() - startedMs);
      if (response.status === 401 || response.status === 403) {
        const diag = extractSafeStripeErrorDiagnostics(response.body);
        return {
          ok: false,
          mode: input.credentials.mode,
          latencyMs,
          verifiedAt: null,
          reasonCode: response.status === 401 ? "STRIPE_AUTH_INVALID_KEY" : "STRIPE_KEY_MISSING_PERMISSION",
          upstreamStatus: response.status,
          stripeErrorType: diag.stripeErrorType,
          stripeErrorCode: diag.stripeErrorCode,
        };
      }
      if (response.status < 200 || response.status >= 300) {
        const diag = extractSafeStripeErrorDiagnostics(response.body);
        return {
          ok: false,
          mode: input.credentials.mode,
          latencyMs,
          verifiedAt: null,
          reasonCode: "STRIPE_UPSTREAM_HTTP_ERROR",
          upstreamStatus: response.status,
          stripeErrorType: diag.stripeErrorType,
          stripeErrorCode: diag.stripeErrorCode,
        };
      }

      try {
        const parsed = asRecord(JSON.parse(response.body.toString("utf8")));
        if (parsed?.object !== "list") {
          return {
            ok: false,
            mode: input.credentials.mode,
            latencyMs,
            verifiedAt: null,
            reasonCode: "STRIPE_UNEXPECTED_PAYLOAD",
            upstreamStatus: response.status,
          };
        }
      } catch {
        return {
          ok: false,
          mode: input.credentials.mode,
          latencyMs,
          verifiedAt: null,
          reasonCode: "STRIPE_INVALID_JSON",
          upstreamStatus: response.status,
        };
      }

      return {
        ok: true,
        mode: input.credentials.mode,
        latencyMs,
        verifiedAt: input.now,
        reasonCode: null,
        upstreamStatus: response.status,
      };
    },

    async verifyCheckoutSession(
      input: ProviderVerifyCheckoutSessionInput,
    ): Promise<ProviderVerifyCheckoutSessionResult> {
      const startedMs = Date.now();
      try {
        assertStripeKeyMatchesMode(input.credentials.secretKey, input.credentials.mode);
      } catch {
        return {
          ok: false,
          mode: input.credentials.mode,
          latencyMs: Math.max(0, Date.now() - startedMs),
          verifiedAt: null,
          sessionId: null,
          expiredImmediately: false,
          reasonCode: "STRIPE_KEY_MODE_MISMATCH",
        };
      }

      const probeToken = ulid(input.now.getTime());
      const currency = /^[A-Z]{3}$/u.test(input.currency) ? input.currency : "USD";
      const minMinor = Math.max(
        resolveProviderMinimumMinor("stripe", currency, { belowProviderMinimum: "waive" }),
        100,
      );
      const origin = input.canonicalOrigin.replace(/\/+$/u, "");

      const params = new URLSearchParams();
      params.set("mode", "payment");
      params.set("success_url", `${origin}/admin/payments/setup?probe=ok`);
      params.set("cancel_url", `${origin}/admin/payments/setup?probe=cancel`);
      params.set("client_reference_id", `rp_probe_${probeToken}`);
      params.set("metadata[rp_setup_probe]", "1");
      params.set("line_items[0][quantity]", "1");
      params.set("line_items[0][price_data][currency]", currency.toLowerCase());
      params.set("line_items[0][price_data][unit_amount]", String(minMinor));
      params.set(
        "line_items[0][price_data][product_data][name]",
        "ReadyPackets Checkout setup verification (auto-expired)",
      );

      let createResp;
      try {
        const egress = getEgress();
        createResp = await egress.fetchPinned(
          new URL("/v1/checkout/sessions", STRIPE_API_ORIGIN),
          "stripe",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${input.credentials.secretKey}`,
              "content-type": "application/x-www-form-urlencoded",
              "stripe-version": STRIPE_API_VERSION,
              "idempotency-key": `rp-probe-create:${probeToken}`,
            },
            body: params.toString(),
            timeoutMs: STRIPE_TIMEOUT_MS,
            maxRequestBytes: 8 * 1024,
            maxResponseBytes: MAX_STRIPE_RESPONSE_BYTES,
            requireAllowlistRule: true,
            publicAddressesOnly: true,
            expectedHostSuffixes: [STRIPE_API_HOST],
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
      } catch (err) {
        let reasonCode = "STRIPE_TRANSPORT_FAILED";
        if (err instanceof DomainError && /^[A-Z0-9_]{2,64}$/u.test(err.reasonCode)) {
          if (err.reasonCode === "EGRESS_TIMEOUT" || err.reasonCode === "EGRESS_DNS_TIMEOUT") {
            reasonCode = "STRIPE_NETWORK_TIMEOUT";
          } else if (
            err.reasonCode === "EGRESS_CONNECT_REFUSED" ||
            err.reasonCode === "EGRESS_CONNECTION_FAILED" ||
            err.reasonCode === "EGRESS_DNS_RESOLUTION_FAILED" ||
            err.reasonCode === "EGRESS_NETWORK_ERROR" ||
            err.reasonCode === "EGRESS_ABORTED"
          ) {
            reasonCode = "STRIPE_TRANSPORT_FAILED";
          } else {
            reasonCode = err.reasonCode;
          }
        }
        return {
          ok: false,
          mode: input.credentials.mode,
          latencyMs: Math.max(0, Date.now() - startedMs),
          verifiedAt: null,
          sessionId: null,
          expiredImmediately: false,
          reasonCode,
        };
      }

      if (createResp.status < 200 || createResp.status >= 300) {
        const diag = extractSafeStripeErrorDiagnostics(createResp.body);
        return {
          ok: false,
          mode: input.credentials.mode,
          latencyMs: Math.max(0, Date.now() - startedMs),
          verifiedAt: null,
          sessionId: null,
          expiredImmediately: false,
          reasonCode: classifyStripeNon2xxStatus(createResp.status),
          upstreamStatus: createResp.status,
          stripeErrorType: diag.stripeErrorType,
          stripeErrorCode: diag.stripeErrorCode,
          stripeErrorParam: diag.stripeErrorParam,
        };
      }

      let parsed: Record<string, unknown> | null;
      try {
        parsed = asRecord(JSON.parse(createResp.body.toString("utf8")));
      } catch {
        return {
          ok: false,
          mode: input.credentials.mode,
          latencyMs: Math.max(0, Date.now() - startedMs),
          verifiedAt: null,
          sessionId: null,
          expiredImmediately: false,
          reasonCode: "STRIPE_INVALID_JSON",
          upstreamStatus: createResp.status,
        };
      }

      const sessionId = typeof parsed?.id === "string" ? parsed.id.trim() : "";
      const redirectUrl = typeof parsed?.url === "string" ? parsed.url.trim() : "";
      const livemode = parsed?.livemode === true;
      const expectedLivemode = input.credentials.mode === "live";

      if (!/^cs_[A-Za-z0-9_]{8,120}$/u.test(sessionId)) {
        return {
          ok: false,
          mode: input.credentials.mode,
          latencyMs: Math.max(0, Date.now() - startedMs),
          verifiedAt: null,
          sessionId: null,
          expiredImmediately: false,
          reasonCode: "STRIPE_INVALID_SESSION_ID",
          upstreamStatus: createResp.status,
        };
      }

      let expiredImmediately: boolean;
      try {
        const egress = getEgress();
        const expireResp = await egress.fetchPinned(
          new URL(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, STRIPE_API_ORIGIN),
          "stripe",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${input.credentials.secretKey}`,
              "content-type": "application/x-www-form-urlencoded",
              "stripe-version": STRIPE_API_VERSION,
              "idempotency-key": `rp-probe-expire:${probeToken}`,
            },
            body: "",
            timeoutMs: STRIPE_TIMEOUT_MS,
            maxRequestBytes: 1024,
            maxResponseBytes: MAX_STRIPE_RESPONSE_BYTES,
            requireAllowlistRule: true,
            publicAddressesOnly: true,
            expectedHostSuffixes: [STRIPE_API_HOST],
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
        expiredImmediately = expireResp.status >= 200 && expireResp.status < 300;
      } catch {
        expiredImmediately = false;
      }

      const latencyMs = Math.max(0, Date.now() - startedMs);
      if (livemode !== expectedLivemode) {
        return {
          ok: false,
          mode: input.credentials.mode,
          latencyMs,
          verifiedAt: null,
          sessionId,
          expiredImmediately,
          reasonCode: "STRIPE_MODE_MISMATCH",
          upstreamStatus: createResp.status,
        };
      }
      if (!isAllowedStripeHostedUrl(redirectUrl)) {
        return {
          ok: false,
          mode: input.credentials.mode,
          latencyMs,
          verifiedAt: null,
          sessionId,
          expiredImmediately,
          reasonCode: "STRIPE_UNTRUSTED_REDIRECT_URL",
          upstreamStatus: createResp.status,
        };
      }

      return {
        ok: true,
        mode: input.credentials.mode,
        latencyMs,
        verifiedAt: input.now,
        sessionId,
        expiredImmediately,
        reasonCode: null,
        upstreamStatus: createResp.status,
      };
    },
  };
}

export function createStripeProviderAdapter(deps: ModuleDeps): PaymentProviderAdapter {
  return createStripeProvider(() => {
    const egress = (deps.services as Partial<typeof deps.services>).integrations?.egress;
    if (!egress) {
      throw new DomainError("UNAVAILABLE", "EGRESS_UNAVAILABLE", "Outbound egress policy is unavailable.");
    }
    return egress;
  });
}

function parseStripeRefundObject(
  rawObj: Record<string, unknown> | null,
  expected: {
    refundPublicId: string;
    providerPaymentRef: string;
    amountMinor: number;
    currency: string;
    expectedRefundId?: string | null;
    mode: "direct" | "list_filter";
  },
): {
  status: "succeeded" | "pending" | "failed" | "unknown";
  providerRefundRef: string | null;
  failureReasonCode: string | null;
  settledAt: Date | null;
} | null {
  if (!rawObj) return null;
  const refundId = typeof rawObj.id === "string" ? rawObj.id.trim() : "";
  if (!/^re_[A-Za-z0-9_]{6,120}$/u.test(refundId)) return null;

  if (expected.expectedRefundId && refundId !== expected.expectedRefundId) {
    return {
      status: "unknown",
      providerRefundRef: null,
      failureReasonCode: "STRIPE_REFUND_ID_MISMATCH",
      settledAt: null,
    };
  }

  const metadata = asRecord(rawObj.metadata);
  const metaRefundPubId =
    typeof metadata?.refund_public_id === "string" ? metadata.refund_public_id.trim() : null;
  if (metaRefundPubId !== expected.refundPublicId) {
    if (expected.mode === "list_filter") {
      return null;
    }
    return {
      status: "unknown",
      providerRefundRef: null,
      failureReasonCode: "STRIPE_REFUND_METADATA_MISMATCH",
      settledAt: null,
    };
  }

  const piRaw = rawObj.payment_intent;
  const piId =
    typeof piRaw === "string"
      ? piRaw.trim()
      : typeof asRecord(piRaw)?.id === "string"
        ? (asRecord(piRaw)!.id as string).trim()
        : null;
  const chRaw = rawObj.charge;
  const chId =
    typeof chRaw === "string"
      ? chRaw.trim()
      : typeof asRecord(chRaw)?.id === "string"
        ? (asRecord(chRaw)!.id as string).trim()
        : null;

  if (expected.providerPaymentRef.startsWith("pi_")) {
    if (!piId || piId !== expected.providerPaymentRef) {
      return {
        status: "unknown",
        providerRefundRef: null,
        failureReasonCode: "STRIPE_REFUND_PAYMENT_MISMATCH",
        settledAt: null,
      };
    }
  } else if (expected.providerPaymentRef.startsWith("ch_")) {
    if (!chId || chId !== expected.providerPaymentRef) {
      return {
        status: "unknown",
        providerRefundRef: null,
        failureReasonCode: "STRIPE_REFUND_CHARGE_MISMATCH",
        settledAt: null,
      };
    }
  } else {
    return {
      status: "unknown",
      providerRefundRef: null,
      failureReasonCode: "STRIPE_INVALID_PAYMENT_REF",
      settledAt: null,
    };
  }

  const amount = typeof rawObj.amount === "number" ? rawObj.amount : -1;
  const currency = typeof rawObj.currency === "string" ? rawObj.currency.toUpperCase() : "";
  if (amount !== expected.amountMinor || currency !== expected.currency.toUpperCase()) {
    return {
      status: "unknown",
      providerRefundRef: null,
      failureReasonCode: "STRIPE_REFUND_AMOUNT_OR_CURRENCY_MISMATCH",
      settledAt: null,
    };
  }

  const rawStatus = typeof rawObj.status === "string" ? rawObj.status : "";
  const createdSec = typeof rawObj.created === "number" ? rawObj.created : null;
  const createdAt = createdSec && Number.isSafeInteger(createdSec) && createdSec > 0 ? new Date(createdSec * 1000) : null;
  const failureReasonRaw =
    typeof rawObj.failure_reason === "string" && /^[a-z0-9_]{2,64}$/iu.test(rawObj.failure_reason)
      ? rawObj.failure_reason.toUpperCase()
      : "STRIPE_REFUND_FAILED";

  if (rawStatus === "succeeded") {
    return {
      status: "succeeded",
      providerRefundRef: refundId,
      failureReasonCode: null,
      settledAt: createdAt,
    };
  }
  if (rawStatus === "pending" || rawStatus === "requires_action") {
    return {
      status: "pending",
      providerRefundRef: refundId,
      failureReasonCode: null,
      settledAt: null,
    };
  }
  if (rawStatus === "failed" || rawStatus === "canceled") {
    return {
      status: "failed",
      providerRefundRef: refundId,
      failureReasonCode: failureReasonRaw,
      settledAt: createdAt,
    };
  }
  return {
    status: "unknown",
    providerRefundRef: refundId,
    failureReasonCode: "STRIPE_REFUND_UNEXPECTED_STATUS",
    settledAt: null,
  };
}

export function createStripeRefundProvider(
  getEgress: () => Pick<EgressPolicy, "fetchPinned">,
): PaymentRefundAdapter<"stripe"> {
  return {
    provider: "stripe",

    async createRefund(input: CreateProviderRefundInput): Promise<ProviderRefundExecutionOutcome> {
      try {
        assertStripeKeyMatchesMode(input.credentials.secretKey, input.credentials.mode);
      } catch {
        return { outcome: "failed", failureReasonCode: "STRIPE_KEY_MODE_MISMATCH" };
      }
      if (
        !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(input.refundPublicId) ||
        input.providerIdempotencyKey !== `rp-refund-${input.refundPublicId}` ||
        !/^(pi|ch)_[A-Za-z0-9_]{6,120}$/u.test(input.providerPaymentRef) ||
        !Number.isSafeInteger(input.amountMinor) ||
        input.amountMinor <= 0 ||
        !/^[A-Z]{3}$/u.test(input.currency)
      ) {
        return { outcome: "failed", failureReasonCode: "STRIPE_REFUND_INVALID_REQUEST" };
      }

      const params = new URLSearchParams();
      if (input.providerPaymentRef.startsWith("pi_")) {
        params.set("payment_intent", input.providerPaymentRef);
      } else {
        params.set("charge", input.providerPaymentRef);
      }
      params.set("amount", String(input.amountMinor));
      params.set("reason", "requested_by_customer");
      params.set("metadata[refund_public_id]", input.refundPublicId);
      params.set("metadata[order_public_id]", input.orderPublicId);
      params.set("metadata[invoice_public_id]", input.invoicePublicId);

      let response;
      try {
        const egress = getEgress();
        response = await egress.fetchPinned(new URL("/v1/refunds", STRIPE_API_ORIGIN), "stripe", {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.credentials.secretKey}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": input.providerIdempotencyKey,
            "stripe-version": STRIPE_API_VERSION,
          },
          body: params.toString(),
          timeoutMs: STRIPE_TIMEOUT_MS,
          maxRequestBytes: 8 * 1024,
          maxResponseBytes: MAX_STRIPE_RESPONSE_BYTES,
          requireAllowlistRule: true,
          publicAddressesOnly: true,
          expectedHostSuffixes: [STRIPE_API_HOST],
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.beforeSend ? { beforeSend: input.beforeSend } : {}),
        });
      } catch {
        // Network interruption, timeout, or egress failure after intent commit -> NEVER resend POST!
        return { outcome: "unknown", failureReasonCode: "STRIPE_REFUND_TRANSPORT_UNKNOWN" };
      }

      if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        return { outcome: "unknown", failureReasonCode: "STRIPE_REFUND_UPSTREAM_UNKNOWN" };
      }

      let parsed: Record<string, unknown> | null;
      try {
        parsed = asRecord(JSON.parse(response.body.toString("utf8")));
      } catch {
        return { outcome: "unknown", failureReasonCode: "STRIPE_REFUND_INVALID_JSON" };
      }

      if (response.status >= 400 && response.status < 500) {
        const errObj = asRecord(parsed?.error);
        const errType = typeof errObj?.type === "string" ? errObj.type : "";
        const errCode = typeof errObj?.code === "string" ? errObj.code : "";
        if (errType === "idempotency_error" || errCode === "lock_timeout") {
          return { outcome: "unknown", failureReasonCode: "STRIPE_REFUND_IDEMPOTENCY_IN_FLIGHT" };
        }
        const safeCode =
          errCode && /^[a-z0-9_]{2,56}$/iu.test(errCode)
            ? `STRIPE_${errCode.toUpperCase()}`
            : "STRIPE_REFUND_REFUSED";
        return { outcome: "failed", failureReasonCode: safeCode.slice(0, 64) };
      }

      const mapped = parseStripeRefundObject(parsed, {
        refundPublicId: input.refundPublicId,
        providerPaymentRef: input.providerPaymentRef,
        amountMinor: input.amountMinor,
        currency: input.currency,
        mode: "direct",
      });
      if (!mapped || mapped.status === "unknown") {
        return {
          outcome: "unknown",
          failureReasonCode: mapped?.failureReasonCode ?? "STRIPE_REFUND_UNCONFIRMED",
        };
      }
      if (mapped.status === "failed") {
        return {
          outcome: "failed",
          failureReasonCode: mapped.failureReasonCode ?? "STRIPE_REFUND_FAILED",
        };
      }
      return {
        outcome: mapped.status,
        providerRefundRef: mapped.providerRefundRef!,
        settledAt: mapped.settledAt,
      };
    },

    async lookupRefund(input: LookupProviderRefundInput): Promise<ProviderRefundLookupResult> {
      try {
        assertStripeKeyMatchesMode(input.credentials.secretKey, input.credentials.mode);
      } catch {
        return {
          status: "unknown",
          providerRefundRef: input.providerRefundRef,
          failureReasonCode: "STRIPE_KEY_MODE_MISMATCH",
          settledAt: null,
        };
      }

      let egress: Pick<EgressPolicy, "fetchPinned">;
      try {
        egress = getEgress();
      } catch {
        return {
          status: "unknown",
          providerRefundRef: input.providerRefundRef,
          failureReasonCode: "EGRESS_UNAVAILABLE",
          settledAt: null,
        };
      }

      if (input.providerRefundRef && /^re_[A-Za-z0-9_]{6,120}$/u.test(input.providerRefundRef)) {
        try {
          const response = await egress.fetchPinned(
            new URL(`/v1/refunds/${encodeURIComponent(input.providerRefundRef)}`, STRIPE_API_ORIGIN),
            "stripe",
            {
              method: "GET",
              headers: {
                authorization: `Bearer ${input.credentials.secretKey}`,
                "stripe-version": STRIPE_API_VERSION,
              },
              timeoutMs: STRIPE_TIMEOUT_MS,
              maxResponseBytes: MAX_STRIPE_RESPONSE_BYTES,
              requireAllowlistRule: true,
              publicAddressesOnly: true,
              expectedHostSuffixes: [STRIPE_API_HOST],
              ...(input.signal ? { signal: input.signal } : {}),
              ...(input.beforeSend ? { beforeSend: input.beforeSend } : {}),
            },
          );
          if (response.status === 404) {
            return {
              status: "absent",
              providerRefundRef: null,
              failureReasonCode: "STRIPE_REFUND_NOT_FOUND",
              settledAt: null,
            };
          }
          if (response.status < 200 || response.status >= 300) {
            return {
              status: "unknown",
              providerRefundRef: input.providerRefundRef,
              failureReasonCode: "STRIPE_LOOKUP_UPSTREAM_UNKNOWN",
              settledAt: null,
            };
          }
          const parsed = asRecord(JSON.parse(response.body.toString("utf8")));
          const mapped = parseStripeRefundObject(parsed, {
            refundPublicId: input.refundPublicId,
            providerPaymentRef: input.providerPaymentRef,
            amountMinor: input.amountMinor,
            currency: input.currency,
            expectedRefundId: input.providerRefundRef,
            mode: "direct",
          });
          if (!mapped) {
            return {
              status: "unknown",
              providerRefundRef: null,
              failureReasonCode: "STRIPE_LOOKUP_INVALID_PAYLOAD",
              settledAt: null,
            };
          }
          if (mapped.status !== "unknown" && mapped.providerRefundRef !== input.providerRefundRef) {
            return {
              status: "unknown",
              providerRefundRef: null,
              failureReasonCode: "STRIPE_REFUND_ID_MISMATCH",
              settledAt: null,
            };
          }
          return mapped;
        } catch {
          return {
            status: "unknown",
            providerRefundRef: input.providerRefundRef,
            failureReasonCode: "STRIPE_LOOKUP_TRANSPORT_UNKNOWN",
            settledAt: null,
          };
        }
      }

      if (!/^(pi|ch)_[A-Za-z0-9_]{6,120}$/u.test(input.providerPaymentRef)) {
        return {
          status: "unknown",
          providerRefundRef: null,
          failureReasonCode: "STRIPE_INVALID_PAYMENT_REF",
          settledAt: null,
        };
      }

      const queryKey = input.providerPaymentRef.startsWith("pi_") ? "payment_intent" : "charge";
      try {
        const listUrl = new URL(
          `/v1/refunds?${queryKey}=${encodeURIComponent(input.providerPaymentRef)}&limit=25`,
          STRIPE_API_ORIGIN,
        );
        const response = await egress.fetchPinned(listUrl, "stripe", {
          method: "GET",
          headers: {
            authorization: `Bearer ${input.credentials.secretKey}`,
            "stripe-version": STRIPE_API_VERSION,
          },
          timeoutMs: STRIPE_TIMEOUT_MS,
          maxResponseBytes: MAX_STRIPE_RESPONSE_BYTES,
          requireAllowlistRule: true,
          publicAddressesOnly: true,
          expectedHostSuffixes: [STRIPE_API_HOST],
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.beforeSend ? { beforeSend: input.beforeSend } : {}),
        });
        if (response.status === 404) {
          return {
            status: "absent",
            providerRefundRef: null,
            failureReasonCode: "STRIPE_PAYMENT_NOT_FOUND",
            settledAt: null,
          };
        }
        if (response.status < 200 || response.status >= 300) {
          return {
            status: "unknown",
            providerRefundRef: null,
            failureReasonCode: "STRIPE_LOOKUP_LIST_UNKNOWN",
            settledAt: null,
          };
        }
        const parsed = asRecord(JSON.parse(response.body.toString("utf8")));
        const list = parsed?.data;
        if (!Array.isArray(list)) {
          return {
            status: "unknown",
            providerRefundRef: null,
            failureReasonCode: "STRIPE_LOOKUP_INVALID_LIST",
            settledAt: null,
          };
        }
        let matched: ProviderRefundLookupResult | null = null;
        for (const item of list) {
          const row = parseStripeRefundObject(asRecord(item), {
            refundPublicId: input.refundPublicId,
            providerPaymentRef: input.providerPaymentRef,
            amountMinor: input.amountMinor,
            currency: input.currency,
            mode: "list_filter",
          });
          if (!row) continue;
          if (matched) {
            return {
              status: "unknown",
              providerRefundRef: null,
              failureReasonCode: "STRIPE_LOOKUP_AMBIGUOUS_MATCH",
              settledAt: null,
            };
          }
          matched = row;
        }
        if (matched) return matched;
        return {
          status: "absent",
          providerRefundRef: null,
          failureReasonCode: null,
          settledAt: null,
        };
      } catch {
        return {
          status: "unknown",
          providerRefundRef: null,
          failureReasonCode: "STRIPE_LOOKUP_TRANSPORT_UNKNOWN",
          settledAt: null,
        };
      }
    },

    async listPaymentRefunds(input: ProviderListPaymentRefundsInput): Promise<ProviderListPaymentRefundsResult> {
      try {
        assertStripeKeyMatchesMode(input.credentials.secretKey, input.credentials.mode);
      } catch {
        return { ok: false, items: [], failureReasonCode: "STRIPE_KEY_MODE_MISMATCH" };
      }

      if (!/^(pi|ch)_[A-Za-z0-9_]{6,120}$/u.test(input.providerPaymentRef)) {
        return { ok: false, items: [], failureReasonCode: "STRIPE_INVALID_PAYMENT_REF" };
      }

      let egress: Pick<EgressPolicy, "fetchPinned">;
      try {
        egress = getEgress();
      } catch {
        return { ok: false, items: [], failureReasonCode: "EGRESS_UNAVAILABLE" };
      }

      const queryKey = input.providerPaymentRef.startsWith("pi_") ? "payment_intent" : "charge";
      try {
        const listUrl = new URL(
          `/v1/refunds?${queryKey}=${encodeURIComponent(input.providerPaymentRef)}&limit=25`,
          STRIPE_API_ORIGIN,
        );
        const response = await egress.fetchPinned(listUrl, "stripe", {
          method: "GET",
          headers: {
            authorization: `Bearer ${input.credentials.secretKey}`,
            "stripe-version": STRIPE_API_VERSION,
          },
          timeoutMs: STRIPE_TIMEOUT_MS,
          maxResponseBytes: MAX_STRIPE_RESPONSE_BYTES,
          requireAllowlistRule: true,
          publicAddressesOnly: true,
          expectedHostSuffixes: [STRIPE_API_HOST],
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.beforeSend ? { beforeSend: input.beforeSend } : {}),
        });
        if (response.status < 200 || response.status >= 300) {
          return { ok: false, items: [], failureReasonCode: "STRIPE_LOOKUP_LIST_UNKNOWN" };
        }
        const parsed = asRecord(JSON.parse(response.body.toString("utf8")));
        const list = parsed?.data;
        if (!Array.isArray(list)) {
          return { ok: false, items: [], failureReasonCode: "STRIPE_LOOKUP_INVALID_LIST" };
        }

        const items: ProviderListedRefundItem[] = [];
        for (const rawItem of list) {
          const obj = asRecord(rawItem);
          if (!obj) continue;
          const refundId = typeof obj.id === "string" ? obj.id.trim() : "";
          if (!/^re_[A-Za-z0-9_]{6,120}$/u.test(refundId)) continue;
          const metadata = asRecord(obj.metadata);
          const rawPubId = typeof metadata?.refund_public_id === "string" ? metadata.refund_public_id.trim() : "";
          const refundPublicIdHint = /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(rawPubId) ? rawPubId : null;
          const amount = typeof obj.amount === "number" && Number.isSafeInteger(obj.amount) && obj.amount > 0 ? obj.amount : 0;
          const currency =
            typeof obj.currency === "string" && /^[a-zA-Z]{3}$/u.test(obj.currency)
              ? obj.currency.toUpperCase()
              : "";
          const rawStatus = typeof obj.status === "string" ? obj.status : "";
          const createdSec = typeof obj.created === "number" ? obj.created : null;
          const settledAt =
            createdSec && Number.isSafeInteger(createdSec) && createdSec > 0 ? new Date(createdSec * 1000) : null;
          const failureReasonCode =
            typeof obj.failure_reason === "string" && /^[a-z0-9_]{2,64}$/iu.test(obj.failure_reason)
              ? obj.failure_reason.toUpperCase()
              : null;

          let status: "succeeded" | "pending" | "failed" | "unknown" = "unknown";
          if (rawStatus === "succeeded") status = "succeeded";
          else if (rawStatus === "pending" || rawStatus === "requires_action") status = "pending";
          else if (rawStatus === "failed" || rawStatus === "canceled") status = "failed";

          items.push({
            providerRefundRef: refundId,
            refundPublicIdHint,
            status,
            amountMinor: amount,
            currency,
            settledAt: status === "succeeded" || status === "failed" ? settledAt : null,
            failureReasonCode: status === "failed" ? (failureReasonCode ?? "STRIPE_REFUND_FAILED") : null,
          });
        }
        return { ok: true, items, failureReasonCode: null };
      } catch {
        return { ok: false, items: [], failureReasonCode: "STRIPE_LOOKUP_TRANSPORT_UNKNOWN" };
      }
    },
  };
}

export function createStripeRefundAdapter(deps: ModuleDeps): PaymentRefundAdapter<"stripe"> {
  return createStripeRefundProvider(() => {
    const egress = (deps.services as Partial<typeof deps.services>).integrations?.egress;
    if (!egress) {
      throw new DomainError("UNAVAILABLE", "EGRESS_UNAVAILABLE", "Outbound egress policy is unavailable.");
    }
    return egress;
  });
}

