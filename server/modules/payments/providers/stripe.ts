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
import type { EgressPolicy } from "../../integrations/egress.js";
import type {
  PaymentProviderAdapter,
  ProviderCreateCheckoutInput,
  ProviderCreateCheckoutOutput,
  ProviderFetchedPayment,
  ProviderFetchPaymentInput,
  ProviderVerifyWebhookInput,
  ProviderVerifyWebhookOutput,
} from "./types.js";

const STRIPE_API_HOST = "api.stripe.com";
const STRIPE_API_ORIGIN = `https://${STRIPE_API_HOST}`;
const STRIPE_API_VERSION = "2024-06-20";
const MAX_STRIPE_RESPONSE_BYTES = 256 * 1024;
const STRIPE_TIMEOUT_MS = 12_000;

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

export function createStripeProvider(
  getEgress: () => Pick<EgressPolicy, "fetchPinned">,
): PaymentProviderAdapter {
  return {
    key: "stripe",

    async createCheckout(input: ProviderCreateCheckoutInput): Promise<ProviderCreateCheckoutOutput> {
      assertStripeKeyMatchesMode(input.credentials.secretKey, input.credentials.mode);
      const egress = getEgress();

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

      const response = await egress.fetchPinned(
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

      if (response.status < 200 || response.status >= 300) {
        throw new DomainError(
          "UNAVAILABLE",
          "STRIPE_CHECKOUT_CREATE_FAILED",
          "Stripe Checkout session could not be created.",
          { upstreamStatus: response.status },
        );
      }

      let parsed: Record<string, unknown> | null;
      try {
        parsed = asRecord(JSON.parse(response.body.toString("utf8")));
      } catch {
        throw new DomainError("UNAVAILABLE", "STRIPE_INVALID_JSON", "Invalid JSON returned by Stripe.");
      }

      const sessionId = typeof parsed?.id === "string" ? parsed.id.trim() : "";
      const redirectUrl = typeof parsed?.url === "string" ? parsed.url.trim() : "";
      const livemode = parsed?.livemode === true;
      const expectedLivemode = input.credentials.mode === "live";

      if (!/^cs_[A-Za-z0-9_]{8,120}$/u.test(sessionId)) {
        throw new DomainError("UNAVAILABLE", "STRIPE_INVALID_SESSION_ID", "Stripe returned an invalid session id.");
      }
      if (livemode !== expectedLivemode) {
        throw new DomainError("CONFLICT", "STRIPE_MODE_MISMATCH", "Stripe session livemode did not match portal mode.");
      }
      if (!isAllowedStripeHostedUrl(redirectUrl)) {
        throw new DomainError(
          "UNAVAILABLE",
          "STRIPE_UNTRUSTED_REDIRECT_URL",
          "Stripe returned an untrusted hosted checkout URL.",
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

      const expectedMac = createHmac("sha256", input.webhookSecret)
        .update(`${parsedSig.timestamp}.`, "utf8")
        .update(input.rawBody)
        .digest();

      let matched = false;
      for (const candidate of parsedSig.v1Signatures) {
        if (candidate.byteLength === expectedMac.byteLength && timingSafeEqual(candidate, expectedMac)) {
          matched = true;
        }
      }
      if (!matched) {
        return { ok: false, reasonCode: "INVALID_SIGNATURE" };
      }

      const nowSeconds = Math.floor(input.now.getTime() / 1000);
      const tolerance = Math.min(Math.max(input.toleranceSeconds, 30), 300);
      if (Math.abs(nowSeconds - parsedSig.timestamp) > tolerance) {
        return { ok: false, reasonCode: "TIMESTAMP_OUT_OF_RANGE" };
      }

      let payload: Record<string, unknown> | null;
      try {
        payload = asRecord(JSON.parse(input.rawBody.toString("utf8")));
      } catch {
        return { ok: false, reasonCode: "INVALID_JSON" };
      }
      if (!payload) {
        return { ok: false, reasonCode: "INVALID_EVENT_PAYLOAD" };
      }

      const externalEventId = typeof payload.id === "string" ? payload.id.trim() : "";
      const eventType = typeof payload.type === "string" ? payload.type.trim() : "";
      const livemode = payload.livemode === true;
      const createdSec = typeof payload.created === "number" ? payload.created : parsedSig.timestamp;

      if (!/^evt_[A-Za-z0-9_]{6,120}$/u.test(externalEventId) || !eventType || eventType.length > 96) {
        return { ok: false, reasonCode: "INVALID_EVENT_ENVELOPE" };
      }

      const dataObj = asRecord(asRecord(payload.data)?.object);
      const metadata = asRecord(dataObj?.metadata);
      const objectId = typeof dataObj?.id === "string" ? dataObj.id.trim() : null;
      const clientReferenceId =
        typeof dataObj?.client_reference_id === "string" ? dataObj.client_reference_id.trim() : null;
      const metaAttemptId =
        typeof metadata?.attempt_public_id === "string" ? metadata.attempt_public_id.trim() : null;
      const metaInvoiceId =
        typeof metadata?.invoice_public_id === "string" ? metadata.invoice_public_id.trim() : null;

      const attemptPublicId = metaAttemptId ?? clientReferenceId;
      const paymentIntentRaw = dataObj?.payment_intent;
      const paymentIntentId =
        typeof paymentIntentRaw === "string"
          ? paymentIntentRaw
          : typeof asRecord(paymentIntentRaw)?.id === "string"
            ? (asRecord(paymentIntentRaw)!.id as string)
            : null;

      let outcomeHint: "paid" | "failed" | "expired" | "ignored" = "ignored";
      let providerRef: string | null = null;
      let providerOrderRef: string | null = paymentIntentId;
      let providerPaymentRef: string | null = paymentIntentId;

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
      }

      return {
        ok: true,
        externalEventId,
        eventType,
        occurredAt: new Date(createdSec * 1000),
        livemode,
        attemptPublicId: attemptPublicId && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(attemptPublicId) ? attemptPublicId : null,
        invoicePublicId: metaInvoiceId && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(metaInvoiceId) ? metaInvoiceId : null,
        providerRef,
        providerOrderRef,
        providerPaymentRef,
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
        `/v1/checkout/sessions/${encodeURIComponent(input.providerRef)}?expand[]=payment_intent`,
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
      const sessionStatus = typeof parsed.status === "string" ? parsed.status : "";
      const paymentStatus = typeof parsed.payment_status === "string" ? parsed.payment_status : "";
      const amountTotal = typeof parsed.amount_total === "number" ? parsed.amount_total : -1;
      const currency = typeof parsed.currency === "string" ? parsed.currency.trim().toUpperCase() : "";
      const livemode = parsed.livemode === true;
      const metadata = asRecord(parsed.metadata);
      const clientReferenceId =
        typeof parsed.client_reference_id === "string" ? parsed.client_reference_id.trim() : null;
      const attemptPublicId =
        typeof metadata?.attempt_public_id === "string" ? metadata.attempt_public_id.trim() : clientReferenceId;
      const invoicePublicId =
        typeof metadata?.invoice_public_id === "string" ? metadata.invoice_public_id.trim() : null;

      const piObj = asRecord(parsed.payment_intent);
      const paymentIntentId =
        typeof parsed.payment_intent === "string"
          ? parsed.payment_intent
          : typeof piObj?.id === "string"
            ? piObj.id
            : null;
      const amountRefunded = typeof piObj?.amount_refunded === "number" ? piObj.amount_refunded : 0;
      const piCreated = typeof piObj?.created === "number" ? new Date(piObj.created * 1000) : null;

      let status: "paid" | "open" | "failed" | "expired" = "open";
      if (amountRefunded > 0) {
        status = "failed";
      } else if (sessionStatus === "complete" && paymentStatus === "paid") {
        status = "paid";
      } else if (sessionStatus === "expired") {
        status = "expired";
      } else if (piObj?.status === "canceled") {
        status = "failed";
      }

      return {
        providerRef: sessionId || input.providerRef,
        providerOrderRef: paymentIntentId,
        providerPaymentRef: paymentIntentId ?? sessionId,
        status,
        amountMinor: Number.isSafeInteger(amountTotal) && amountTotal >= 0 ? amountTotal : 0,
        currency,
        livemode,
        attemptPublicId,
        invoicePublicId,
        paidAt: status === "paid" ? piCreated : null,
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

