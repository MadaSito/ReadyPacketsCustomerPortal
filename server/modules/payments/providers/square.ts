import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ModuleDeps } from "../../../container.js";
import { DomainError } from "../../../core/errors.js";
import { ULID_PATTERN } from "../../../core/ids.js";
import type { EgressPolicy } from "../../integrations/egress.js";
import type { PaymentProviderAdapter } from "./types.js";

const apiHosts = { live: "connect.squareup.com", test: "connect.squareupsandbox.com" } as const;
const hostedHosts = { live: ["square.link", "checkout.square.site"], test: ["sandbox.square.link"] } as const;
const jsonLimit = 256 * 1024;
const invoicePrefix = "rp-invoice:";
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const portalId = z.string().length(26).regex(ULID_PATTERN);
const currencyCode = z.string().regex(/^[A-Z]{3}$/u);
const money = z.object({ amount: z.number().int().nonnegative(), currency: currencyCode });
const eventShape = z.object({ event_id: providerId, type: z.string().regex(/^[a-z][a-z0-9_.]{1,95}$/u),
  created_at: z.iso.datetime({ offset: true }), data: z.unknown().optional() });
const eventPayment = z.object({ data: z.object({ type: z.literal("payment"), id: providerId,
  object: z.object({ payment: z.object({ id: providerId, order_id: providerId.optional(), status: z.string().max(32) }) }),
}) });
const linkResponse = z.object({ payment_link: z.object({ id: providerId, order_id: providerId, url: z.string().max(512) }) });
const orderResponse = z.object({ order: z.object({
  id: providerId, location_id: providerId, reference_id: portalId, total_money: money, state: z.string().max(32),
  line_items: z.tuple([z.object({ note: z.string().max(64), quantity: z.literal("1"), base_price_money: money })]),
  tenders: z.array(z.object({ payment_id: providerId.optional() })).max(100).optional(),
}) });
const paymentResponse = z.object({ payment: z.object({
  id: providerId, order_id: providerId, location_id: providerId,
  status: z.enum(["COMPLETED", "APPROVED", "PENDING", "FAILED", "CANCELED"]),
  amount_money: money, total_money: money.optional(), tip_money: money.optional(), refunded_money: money.optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
}) });
type Mode = keyof typeof apiHosts;
type Claim = Pick<Parameters<PaymentProviderAdapter["fetchPayment"]>[0], "signal" | "beforeSend">;
type VerifyInput = Parameters<PaymentProviderAdapter["verifyWebhook"]>[0];

function unavailable(reason: string) {
  return new DomainError("UNAVAILABLE", reason, "The Square payment service is unavailable or returned an unexpected result.");
}

function readJson<T>(body: Buffer, shape: z.ZodType<T>) {
  let data: unknown;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { throw unavailable("SQUARE_RESPONSE_INVALID"); }
  const parsed = shape.safeParse(data);
  if (!parsed.success) throw unavailable("SQUARE_RESPONSE_INVALID");
  return parsed.data;
}

export function isSquareHostedCheckoutUrl(raw: string, mode: Mode) {
  try {
    const url = new URL(raw);
    const hosts: readonly string[] = hostedHosts[mode];
    return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash &&
      hosts.includes(url.hostname) && (url.hostname === "checkout.square.site" ? url.pathname.startsWith("/merchant/") :
        /^\/u\/[A-Za-z0-9_-]{1,160}$/u.test(url.pathname));
  } catch { return false; }
}

function header(input: VerifyInput["headers"], name: string) {
  return input[name] ?? Object.entries(input).find(([key]) => key.toLowerCase() === name)?.[1];
}

function verifyWebhook(input: VerifyInput): ReturnType<PaymentProviderAdapter["verifyWebhook"]> {
  const refusal = (reasonCode: string) => ({ ok: false as const, reasonCode });
  const signature = header(input.headers, "x-square-hmacsha256-signature");
  if (!signature || !/^[A-Za-z0-9+/]{43}=$/u.test(signature) || !input.rawBody.length ||
      input.rawBody.length > jsonLimit || !input.webhookSecret) return refusal("SQUARE_SIGNATURE_INVALID");
  const supplied = Buffer.from(signature, "base64");
  const expected = createHmac("sha256", input.webhookSecret).update(input.notificationUrl, "utf8").update(input.rawBody).digest();
  if (supplied.length !== expected.length || supplied.toString("base64") !== signature || !timingSafeEqual(supplied, expected)) {
    return refusal("SQUARE_SIGNATURE_INVALID");
  }
  let parsed: z.output<typeof eventShape>;
  try { parsed = readJson(input.rawBody, eventShape); }
  catch { return refusal("SQUARE_EVENT_INVALID"); }
  const occurredAt = new Date(parsed.created_at);
  const age = Math.abs(input.now.getTime() - occurredAt.getTime());
  if (!Number.isFinite(age) || !Number.isFinite(input.toleranceSeconds) || input.toleranceSeconds <= 0 ||
      age > Math.min(300, input.toleranceSeconds) * 1000) return refusal("SQUARE_EVENT_STALE");
  const environment = header(input.headers, "square-environment")?.toLowerCase();
  if (environment !== "production" && environment !== "sandbox") return refusal("SQUARE_EVENT_ENVIRONMENT");
  const base = { ok: true as const, externalEventId: parsed.event_id, eventType: parsed.type, occurredAt,
    livemode: environment === "production", attemptPublicId: null, invoicePublicId: null, providerRef: null,
    providerOrderRef: null, providerPaymentRef: null, outcomeHint: "ignored" as const };
  if (!["payment.created", "payment.updated"].includes(parsed.type)) return base;
  const outcome = eventPayment.safeParse(parsed);
  if (!outcome.success) return refusal("SQUARE_EVENT_INVALID");
  const { data } = outcome.data;
  const payment = data.object.payment;
  if (payment.id !== data.id) return refusal("SQUARE_EVENT_INVALID");
  if (!payment.order_id) return base;
  return { ...base, providerOrderRef: payment.order_id, providerPaymentRef: payment.id,
    outcomeHint: payment.status === "COMPLETED" ? "paid" : ["CANCELED", "FAILED"].includes(payment.status) ? "failed" : "ignored" };
}

export function createSquareProvider(egress: Pick<EgressPolicy, "fetchPinned">): PaymentProviderAdapter {
  async function call<T>(mode: Mode, key: string, path: string, shape: z.ZodType<T>, claim: Claim, payload?: unknown) {
    const host = apiHosts[mode];
    if (!host || !key || /[\r\n]/u.test(key)) throw unavailable("SQUARE_CONFIGURATION_INVALID");
    const auth = { Authorization: `Bearer ${key}`, Accept: "application/json", "Square-Version": "2026-11-18" };
    const response = await egress.fetchPinned(new URL(path, `https://${host}`), "square", {
      method: payload === undefined ? "GET" : "POST",
      headers: payload === undefined ? auth : { ...auth, "Content-Type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      requireAllowlistRule: true, publicAddressesOnly: true, expectedHostSuffixes: [host],
      timeoutMs: 6000, maxRequestBytes: 12 * 1024, maxResponseBytes: jsonLimit,
      signal: claim.signal, beforeSend: claim.beforeSend,
    });
    if (response.status < 200 || response.status >= 300) throw unavailable("SQUARE_REQUEST_REFUSED");
    return readJson(response.body, shape);
  }

  return {
    key: "square",
    verifyWebhook,
    async createCheckout(input) {
      const { mode, secretKey, squareLocationId } = input.credentials;
      const location = providerId.safeParse(squareLocationId);
      if (!location.success || !portalId.safeParse(input.attemptPublicId).success || !portalId.safeParse(input.invoicePublicId).success ||
          !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || !currencyCode.safeParse(input.currency).success) {
        throw unavailable("SQUARE_CONFIGURATION_INVALID");
      }
      const response = await call(mode, secretKey, "/v2/online-checkout/payment-links", linkResponse, input, {
        idempotency_key: input.attemptPublicId,
        order: {
          location_id: location.data, reference_id: input.attemptPublicId,
          line_items: [{ name: "ReadyPackets invoice", quantity: "1", note: `${invoicePrefix}${input.invoicePublicId}`,
            base_price_money: { amount: input.amountMinor, currency: input.currency } }],
        },
        checkout_options: { allow_tipping: false, enable_coupon: false, enable_loyalty: false, redirect_url: input.returnUrl },
      });
      const link = response.payment_link;
      if (!isSquareHostedCheckoutUrl(link.url, mode)) throw unavailable("SQUARE_REDIRECT_UNSAFE");
      return { redirectUrl: link.url, providerRef: link.id, providerOrderRef: link.order_id, expiresAt: null };
    },
    async fetchPayment(input) {
      const { mode, secretKey } = input.credentials;
      const ref = providerId.safeParse(input.providerRef);
      const orderRef = providerId.safeParse(input.providerOrderRef);
      const paymentRef = input.providerPaymentRef ? providerId.safeParse(input.providerPaymentRef) : null;
      if (!ref.success || !orderRef.success || (paymentRef && !paymentRef.success)) throw unavailable("SQUARE_REFERENCE_INVALID");
      const { payment_link: link } = await call(mode, secretKey, `/v2/online-checkout/payment-links/${ref.data}`, linkResponse, input);
      if (link.id !== ref.data || link.order_id !== orderRef.data) throw unavailable("SQUARE_REFERENCE_MISMATCH");
      const { order } = await call(mode, secretKey, `/v2/orders/${orderRef.data}`, orderResponse, input);
      const line = order.line_items[0];
      const invoice = line.note.startsWith(invoicePrefix) ? portalId.safeParse(line.note.slice(invoicePrefix.length)) : undefined;
      if (order.id !== orderRef.data || !invoice?.success || order.total_money.amount <= 0 ||
          order.total_money.amount !== line.base_price_money.amount || order.total_money.currency !== line.base_price_money.currency) {
        throw unavailable("SQUARE_REFERENCE_MISMATCH");
      }
      const candidates = [...new Set((order.tenders ?? []).flatMap((tender) => tender.payment_id ? [tender.payment_id] : []))];
      const paymentId = paymentRef?.data ?? (candidates.length === 1 ? candidates[0] : undefined);
      const binding = { providerRef: ref.data, providerOrderRef: order.id, livemode: mode === "live", attemptPublicId: order.reference_id,
        invoicePublicId: invoice.data, amountMinor: order.total_money.amount, currency: order.total_money.currency };
      if (!paymentId) return { ...binding, status: order.state === "CANCELED" ? "expired" : "open", providerPaymentRef: null, paidAt: null };
      const { payment } = await call(mode, secretKey, `/v2/payments/${paymentId}`, paymentResponse, input);
      if (payment.id !== paymentId || payment.order_id !== orderRef.data || payment.location_id !== order.location_id ||
          payment.amount_money.amount !== binding.amountMinor || payment.amount_money.currency !== binding.currency ||
          (payment.total_money && (payment.total_money.amount !== binding.amountMinor || payment.total_money.currency !== binding.currency)) ||
          (payment.refunded_money?.amount ?? 0) !== 0 || (payment.tip_money?.amount ?? 0) !== 0) {
        throw unavailable("SQUARE_PAYMENT_MISMATCH");
      }
      return { ...binding, providerPaymentRef: payment.id,
        paidAt: payment.status === "COMPLETED" && payment.updated_at ? new Date(payment.updated_at) : null,
        status: payment.status === "COMPLETED" ? "paid" : ["CANCELED", "FAILED"].includes(payment.status) ? "failed" : "open" };
    },
  };
}

export function createSquareProviderAdapter(deps: ModuleDeps): PaymentProviderAdapter {
  return createSquareProvider({ fetchPinned: (url, purpose, options) => deps.services.integrations.egress.fetchPinned(url, purpose, options) });
}
