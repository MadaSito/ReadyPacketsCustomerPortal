import { z } from "zod";
import { ULID_PATTERN } from "../../../core/ids.js";
import type { EgressFetchResponse, EgressPolicy } from "../../integrations/egress.js";
import type { PaymentProviderAdapterDeps, PaymentRefundAdapter, ProviderCredentials } from "./types.js";

const apiHosts = { live: "connect.squareup.com", test: "connect.squareupsandbox.com" } as const;
const maxRefundsPerPayment = 20;
const identifier = /^[A-Za-z0-9_-]+$/u;
const refundId = z.string().min(1).max(255).regex(identifier);
const paymentId = z.string().min(1).max(192).regex(identifier);
const canonicalRefundId = z.string().length(26).regex(ULID_PATTERN);
const currency = z.string().regex(/^[A-Z]{3}$/u);
const money = z.object({ amount: z.number().int().positive(), currency });
const refund = z.object({
  id: refundId, payment_id: paymentId, status: z.string().min(1).max(32), amount_money: money, reason: z.string().max(192).optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
});
const refundResponse = z.object({ refund });
const paymentResponse = z.object({ payment: z.object({
  id: paymentId, refund_ids: z.array(refundId).max(maxRefundsPerPayment).optional(),
}) });
const errors = z.object({ errors: z.array(z.object({ code: z.string().max(96) })).min(1).max(10) });
// A timeout, rate limit, idempotency conflict, or unfamiliar upstream error is never proof of rejection.
const explicitRefusals = new Set([
  "PAYMENT_NOT_REFUNDABLE", "REFUND_DECLINED", "INSUFFICIENT_PERMISSIONS_FOR_REFUND", "AMOUNT_TOO_HIGH",
  "PAYMENT_NOT_REFUNDABLE_DUE_TO_DISPUTE", "TRANSACTION_AMOUNT_INVALID", "PAYMENT_NOT_FOUND",
]);

type SquareRefundBinding = {
  refundPublicId: string;
  providerPaymentRef: string;
  amountMinor: number;
  currency: string;
  credentials: ProviderCredentials;
  signal?: AbortSignal | undefined;
  beforeSend?: (() => Promise<void>) | undefined;
};
type SquareFindRefundInput = SquareRefundBinding & { providerRefundRef: string | null };
type SquareRefundOutcome = {
  status: "pending" | "succeeded" | "failed" | "unknown";
  providerRefundRef: string | null;
  reasonCode: string | null;
  settledAt?: Date | null;
};

const unknown = (reasonCode: string): SquareRefundOutcome => ({ status: "unknown", providerRefundRef: null, reasonCode });
const failed = (reasonCode: string): SquareRefundOutcome => ({ status: "failed", providerRefundRef: null, reasonCode });
const markerPrefix = "ReadyPackets refund ";
const marker = (id: string) => `${markerPrefix}${id}`;
export function parseSquareRefundMarker(value: string | undefined): string | null {
  if (!value?.startsWith(markerPrefix)) return null;
  const id = value.slice(markerPrefix.length);
  return canonicalRefundId.safeParse(id).success ? id : null;
}

function parse<T>(response: EgressFetchResponse, schema: z.ZodType<T>): T | undefined {
  try {
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
    const result = schema.safeParse(raw);
    return result.success ? result.data : undefined;
  } catch { return undefined; }
}

function validBinding(input: SquareRefundBinding): boolean {
  return canonicalRefundId.safeParse(input.refundPublicId).success && paymentId.safeParse(input.providerPaymentRef).success &&
    Number.isSafeInteger(input.amountMinor) && input.amountMinor > 0 && currency.safeParse(input.currency).success &&
    !!apiHosts[input.credentials.mode] && /^[^\s]{1,256}$/u.test(input.credentials.secretKey);
}

function matches(row: z.output<typeof refund>, input: SquareRefundBinding): boolean {
  return row.payment_id === input.providerPaymentRef && row.amount_money.amount === input.amountMinor &&
    row.amount_money.currency === input.currency && row.reason === marker(input.refundPublicId);
}

function outcome(row: z.output<typeof refund>): SquareRefundOutcome {
  switch (row.status) {
    case "PENDING": return { status: "pending", providerRefundRef: row.id, reasonCode: null };
    case "COMPLETED": return { status: "succeeded", providerRefundRef: row.id, reasonCode: null,
      settledAt: row.updated_at ? new Date(row.updated_at) : null };
    case "FAILED":
    case "REJECTED": return { status: "failed", providerRefundRef: row.id, reasonCode: "SQUARE_REFUND_REJECTED" };
    default: return { status: "unknown", providerRefundRef: row.id, reasonCode: "SQUARE_REFUND_STATUS_UNKNOWN" };
  }
}

function createSquareRefundProvider(egress: Pick<EgressPolicy, "fetchPinned">) {
  async function fetch(input: SquareRefundBinding, path: string, body?: string): Promise<EgressFetchResponse> {
    const host = apiHosts[input.credentials.mode];
    const headers = { Authorization: `Bearer ${input.credentials.secretKey}`, Accept: "application/json", "Square-Version": "2026-11-18" };
    return egress.fetchPinned(new URL(path, `https://${host}`), "square", {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body }),
      requireAllowlistRule: true, publicAddressesOnly: true, expectedHostSuffixes: [host], timeoutMs: 6000,
      maxRequestBytes: 4096, maxResponseBytes: 128 * 1024, signal: input.signal, beforeSend: input.beforeSend,
    });
  }

  async function getRefund(input: SquareRefundBinding, id: string) {
    const response = await fetch(input, `/v2/refunds/${id}`);
    if (response.status !== 200) return undefined;
    const data = parse(response, refundResponse)?.refund;
    return data?.id === id ? data : undefined;
  }

  return {
    key: "square" as const,
    async createRefund(input: SquareRefundBinding): Promise<SquareRefundOutcome> {
      if (!validBinding(input)) return failed("SQUARE_REFUND_INVALID_REQUEST");
      try {
        const response = await fetch(input, "/v2/refunds", JSON.stringify({
          idempotency_key: `rp-refund-${input.refundPublicId}`,
          payment_id: input.providerPaymentRef,
          amount_money: { amount: input.amountMinor, currency: input.currency },
          reason: marker(input.refundPublicId),
        }));
        if (response.status === 400 && parse(response, errors)?.errors.every(({ code }) => explicitRefusals.has(code))) {
          return failed("SQUARE_REFUND_REJECTED");
        }
        if (response.status < 200 || response.status >= 300) return unknown("SQUARE_REFUND_UNCONFIRMED");
        const row = parse(response, refundResponse)?.refund;
        return row && matches(row, input) ? outcome(row) : unknown("SQUARE_REFUND_RESPONSE_MISMATCH");
      } catch { return unknown("SQUARE_REFUND_UNCONFIRMED"); }
    },
    async findRefund(input: SquareFindRefundInput): Promise<SquareRefundOutcome> {
      if (!validBinding(input)) return unknown("SQUARE_REFUND_LOOKUP_INVALID");
      try {
        if (input.providerRefundRef !== null) {
          if (!refundId.safeParse(input.providerRefundRef).success) return unknown("SQUARE_REFUND_LOOKUP_INVALID");
          const row = await getRefund(input, input.providerRefundRef);
          return row && matches(row, input) ? outcome(row) : unknown("SQUARE_REFUND_LOOKUP_UNCONFIRMED");
        }
        // Square documents GET by provider refund ID only. Resolve through the immutable original
        // payment's refund_ids; correlate with our opaque marker, never a matching amount alone.
        const fetched = await fetch(input, `/v2/payments/${input.providerPaymentRef}`);
        if (fetched.status !== 200) return unknown("SQUARE_REFUND_LOOKUP_UNCONFIRMED");
        const original = parse(fetched, paymentResponse)?.payment;
        if (!original || original.id !== input.providerPaymentRef) return unknown("SQUARE_REFUND_LOOKUP_UNCONFIRMED");
        const candidates = [...new Set(original.refund_ids ?? [])];
        let found: z.output<typeof refund> | undefined;
        for (const id of candidates) {
          const row = await getRefund(input, id);
          if (!row || row.payment_id !== input.providerPaymentRef) return unknown("SQUARE_REFUND_LOOKUP_UNCONFIRMED");
          if (row.reason !== marker(input.refundPublicId)) continue;
          if (!matches(row, input) || found) return unknown("SQUARE_REFUND_LOOKUP_MISMATCH");
          found = row;
        }
        return found ? outcome(found) : unknown("SQUARE_REFUND_LOOKUP_UNCONFIRMED");
      } catch { return unknown("SQUARE_REFUND_LOOKUP_UNCONFIRMED"); }
    },
  };
}

export function createSquareRefundAdapter(deps: Pick<PaymentProviderAdapterDeps, "egress" | "clock">): PaymentRefundAdapter<"square"> {
  const wire = createSquareRefundProvider(deps.egress);
  return {
    provider: "square",
    async createRefund(input) {
      if (input.providerIdempotencyKey !== `rp-refund-${input.refundPublicId}` || input.refundMarker !== marker(input.refundPublicId)) {
        return { outcome: "failed", failureReasonCode: "SQUARE_REFUND_INVALID_REQUEST" };
      }
      const result = await wire.createRefund(input);
      if ((result.status === "pending" || result.status === "succeeded") && result.providerRefundRef !== null) {
        return { outcome: result.status, providerRefundRef: result.providerRefundRef, settledAt: result.settledAt ?? null };
      }
      return { outcome: result.status === "failed" ? "failed" : "unknown",
        failureReasonCode: result.reasonCode ?? "SQUARE_REFUND_UNCONFIRMED" };
    },
    async lookupRefund(input) {
      if (input.providerIdempotencyKey !== `rp-refund-${input.refundPublicId}` || input.refundMarker !== marker(input.refundPublicId)) {
        return { status: "unknown", providerRefundRef: null, failureReasonCode: "SQUARE_REFUND_LOOKUP_INVALID", settledAt: null };
      }
      const result = await wire.findRefund(input);
      return { status: result.status, providerRefundRef: result.providerRefundRef,
        failureReasonCode: result.reasonCode, settledAt: result.settledAt ?? null };
    },
  };
}
