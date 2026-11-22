import { describe, expect, it, vi } from "vitest";
import type { EgressPolicy } from "../../integrations/egress.js";
import { createSquareRefundAdapter, parseSquareRefundMarker } from "./square-refund.js";
import type { CreateProviderRefundInput, LookupProviderRefundInput } from "./types.js";

const refundPublicId = `01J${"0".repeat(22)}1`;
const original = "sample_original_payment";
const providerRef = "sample_provider_refund";
const marker = `ReadyPackets refund ${refundPublicId}`;
const input: CreateProviderRefundInput = {
  refundPublicId, providerPaymentRef: original, amountMinor: 150, currency: "USD",
  credentials: { mode: "test", secretKey: "synthetic_token" },
  orderPublicId: refundPublicId, invoicePublicId: refundPublicId, invoiceNumber: "INV-SYNTHETIC",
  providerIdempotencyKey: `rp-refund-${refundPublicId}`, refundMarker: marker,
};
const lookup: LookupProviderRefundInput = { ...input, providerRefundRef: null };
const row = (status: string, fields: Record<string, unknown> = {}) => ({
  id: providerRef, payment_id: original, status, amount_money: { amount: 150, currency: "USD" }, reason: marker, ...fields,
});
const respond = (payload: unknown, status = 200) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(payload)) });
type Fetch = EgressPolicy["fetchPinned"];
const fakeAdapter = (fetchPinned = vi.fn<Fetch>()) => createSquareRefundAdapter({
  egress: { fetchPinned }, clock: { now: () => new Date("2026-11-21T12:00:00Z") },
});

describe("Square RefundPayment protocol", () => {
  it("posts a linked partial refund with the deterministic intent key using pinned sandbox egress", async () => {
    const fetchPinned = vi.fn<Fetch>().mockImplementation(async (_url, _purpose, options) => {
      await options?.beforeSend?.();
      return respond({ refund: row("PENDING") });
    });
    const provider = fakeAdapter(fetchPinned);
    const beforeSend = vi.fn(async () => {});
    await expect(provider.createRefund({ ...input, beforeSend })).resolves.toEqual({
      outcome: "pending", providerRefundRef: providerRef, settledAt: null,
    });
    const [url, purpose, options] = fetchPinned.mock.calls[0]!;
    expect(String(url)).toBe("https://connect.squareupsandbox.com/v2/refunds");
    expect(purpose).toBe("square");
    expect(options).toMatchObject({ method: "POST", requireAllowlistRule: true, publicAddressesOnly: true, beforeSend,
      expectedHostSuffixes: ["connect.squareupsandbox.com"], headers: { Authorization: "Bearer synthetic_token" } });
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(JSON.parse(String(options?.body))).toEqual({
      idempotency_key: input.providerIdempotencyKey, payment_id: original, amount_money: { amount: 150, currency: "USD" }, reason: marker,
    });
  });

  it("maps completion and definitive rejection, but keeps uncertain outcomes reserved", async () => {
    const fetchPinned = vi.fn<Fetch>()
      .mockResolvedValueOnce(respond({ refund: row("COMPLETED") }))
      .mockResolvedValueOnce(respond({ refund: row("FAILED") }))
      .mockResolvedValueOnce(respond({ errors: [{ code: "PAYMENT_NOT_REFUNDABLE", detail: "private detail" }] }, 400))
      .mockResolvedValueOnce(respond({ errors: [{ code: "IDEMPOTENCY_KEY_REUSED" }] }, 400))
      .mockResolvedValueOnce(respond("Synthetic gateway timeout", 504))
      .mockRejectedValueOnce(new Error("private details"))
      .mockResolvedValueOnce(respond({ refund: row("COMPLETED", { amount_money: { amount: 151, currency: "USD" } }) }));
    const adapter = fakeAdapter(fetchPinned);
    await expect(adapter.createRefund(input)).resolves.toMatchObject({ outcome: "succeeded", providerRefundRef: providerRef });
    for (let i = 0; i < 2; i++) await expect(adapter.createRefund(input)).resolves.toEqual({
      outcome: "failed", failureReasonCode: "SQUARE_REFUND_REJECTED",
    });
    for (let i = 0; i < 4; i++) await expect(adapter.createRefund(input)).resolves.toMatchObject({ outcome: "unknown" });
    expect(fetchPinned).toHaveBeenCalledTimes(7);
  });

  it("reconciles a known ID using GET and requires exact binding even on a provider success", async () => {
    const fetchPinned = vi.fn<Fetch>()
      .mockResolvedValueOnce(respond({ refund: row("COMPLETED") }))
      .mockResolvedValueOnce(respond({ refund: row("COMPLETED", { reason: "another intent" }) }))
      .mockResolvedValueOnce(respond({ refund: row("COMPLETED", { payment_id: "another_payment" }) }))
      .mockResolvedValueOnce(respond({ refund: row("COMPLETED", { amount_money: { amount: 150, currency: "CAD" } }) }));
    const adapter = fakeAdapter(fetchPinned);
    const live = { ...lookup, providerRefundRef: providerRef, credentials: { mode: "live" as const, secretKey: "synthetic_live_token" } };
    await expect(adapter.lookupRefund(live)).resolves.toMatchObject({ status: "succeeded", providerRefundRef: providerRef });
    for (let i = 0; i < 3; i++) await expect(adapter.lookupRefund(live)).resolves.toMatchObject({ status: "unknown" });
    expect(fetchPinned.mock.calls.map(([url, role, options]) => [String(url), role, options?.method])).toEqual(
      Array.from({ length: 4 }, () => [`https://connect.squareup.com/v2/refunds/${providerRef}`, "square", "GET"]),
    );
  });

  it("uses the original payment’s bounded IDs and correlates the exact marker without re-POSTing", async () => {
    const external = "external_refund";
    const fetchPinned = vi.fn<Fetch>()
      .mockResolvedValueOnce(respond({ payment: { id: original, refund_ids: [external, providerRef] } }))
      .mockResolvedValueOnce(respond({ refund: row("COMPLETED", { id: external, reason: "Identical amount, unrelated intent" }) }))
      .mockResolvedValueOnce(respond({ refund: row("COMPLETED") }));
    await expect(fakeAdapter(fetchPinned).lookupRefund(lookup)).resolves.toMatchObject({ status: "succeeded", providerRefundRef: providerRef });
    expect(fetchPinned.mock.calls.map(([url, , options]) => [new URL(url).pathname, options?.method])).toEqual([
      [`/v2/payments/${original}`, "GET"], [`/v2/refunds/${external}`, "GET"], [`/v2/refunds/${providerRef}`, "GET"],
    ]);
    expect(parseSquareRefundMarker(marker)).toBe(refundPublicId);
    expect(parseSquareRefundMarker(`${marker} extra`)).toBeNull();
  });

  it("keeps ambiguous or absent matches unknown and rejects invalid intent data off the wire", async () => {
    const fetchPinned = vi.fn<Fetch>()
      .mockResolvedValueOnce(respond({ payment: { id: original, refund_ids: ["a", "b"] } }))
      .mockResolvedValueOnce(respond({ refund: row("COMPLETED", { id: "a" }) }))
      .mockResolvedValueOnce(respond({ refund: row("COMPLETED", { id: "b" }) }))
      .mockResolvedValueOnce(respond({ payment: { id: original, refund_ids: Array.from({ length: 21 }, (_, i) => `id_${i}`) } }))
      .mockResolvedValueOnce(respond({ payment: { id: original } }));
    const adapter = fakeAdapter(fetchPinned);
    for (let i = 0; i < 3; i++) await expect(adapter.lookupRefund(lookup)).resolves.toMatchObject({ status: "unknown" });
    await expect(adapter.lookupRefund({ ...lookup, providerRefundRef: "../unexpected" })).resolves.toMatchObject({ status: "unknown" });
    for (const invalid of [{ amountMinor: -1 }, { refundMarker: "free-form text" }, { providerIdempotencyKey: "noncanonical-key" }]) {
      await expect(adapter.createRefund({ ...input, ...invalid })).resolves.toMatchObject({ outcome: "failed" });
    }
    expect(fetchPinned).toHaveBeenCalledTimes(5);
  });
});
