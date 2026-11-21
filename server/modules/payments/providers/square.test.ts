import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { EgressPolicy } from "../../integrations/egress.js";
import { createSquareProvider, isSquareHostedCheckoutUrl } from "./square.js";

const attemptPublicId = `01J${"0".repeat(22)}1`;
const invoicePublicId = `01J${"0".repeat(22)}2`;
const notificationUrl = "https://portal.example.test/api/payments/webhooks/square";
const webhookSecret = "synthetic-webhook-secret";
const now = new Date("2026-11-21T12:00:00Z");
const price = { amount: 1299, currency: "USD" };
const link = { id: "LINK_01", order_id: "ORDER_01", url: "https://sandbox.square.link/u/EXAMPLE" };
const order = {
  id: link.order_id, location_id: "LOCATION_01", reference_id: attemptPublicId, total_money: price, state: "OPEN",
  line_items: [{ note: `rp-invoice:${invoicePublicId}`, quantity: "1", base_price_money: price }],
  tenders: [{ payment_id: "PAYMENT_01" }],
};
const payment = { id: "PAYMENT_01", order_id: order.id, location_id: order.location_id, status: "COMPLETED", amount_money: price, total_money: price };
const credentials = { mode: "test" as const, secretKey: "synthetic-access-token", squareLocationId: order.location_id };
const fetchArgs = { providerRef: link.id, providerOrderRef: order.id, credentials };
const event = {
  type: "payment.updated", event_id: "event-01", created_at: now.toISOString(),
  data: { type: "payment", id: payment.id, object: { payment } },
};

function signed(data: unknown = event, url = notificationUrl) {
  const rawBody = Buffer.from(JSON.stringify(data));
  const signature = createHmac("sha256", webhookSecret).update(url).update(rawBody).digest("base64");
  return { rawBody, notificationUrl, webhookSecret, now, toleranceSeconds: 300,
    headers: { "x-square-hmacsha256-signature": signature, "square-environment": "Sandbox" } };
}

function protocolFake(override: { link?: object; order?: object; payment?: object } = {}) {
  const wire = vi.fn();
  const fetchPinned = vi.fn<EgressPolicy["fetchPinned"]>(async (candidate, purpose, options) => {
    const url = new URL(candidate);
    expect(url.origin).toBe("https://connect.squareupsandbox.com");
    expect(purpose).toBe("square");
    expect(options).toMatchObject({
      requireAllowlistRule: true, publicAddressesOnly: true, expectedHostSuffixes: [url.hostname],
      headers: { Authorization: "Bearer synthetic-access-token", "Square-Version": "2026-11-18" },
      timeoutMs: 6000, maxResponseBytes: 262144,
    });
    await options?.beforeSend?.();
    wire(url.pathname);
    switch (url.pathname) {
      case "/v2/online-checkout/payment-links": return ok({ payment_link: override.link ?? link });
      case `/v2/online-checkout/payment-links/${link.id}`: return ok({ payment_link: override.link ?? link });
      case `/v2/orders/${order.id}`: return ok({ order: override.order ?? order });
      case `/v2/payments/${payment.id}`: return ok({ payment: override.payment ?? payment });
      default: throw new Error("Unexpected test endpoint");
    }
  });
  return { adapter: createSquareProvider({ fetchPinned }), fetchPinned, wire };
}

function ok(body: object) {
  return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) };
}

describe("Square hosted checkout protocol", () => {
  it("pins the Sandbox API and submits one fixed-price bound order using the attempt idempotency key", async () => {
    const { adapter, fetchPinned } = protocolFake();
    const successUrl = `https://portal.example.test/api/payments/return/square/${attemptPublicId}`;
    await expect(adapter.createCheckout({
      attemptPublicId, invoicePublicId, amountMinor: price.amount, currency: price.currency,
      invoiceNumber: "INV-TEST", orderPublicId: invoicePublicId, orderReference: "RP-TEST", idempotencyKey: attemptPublicId,
      credentials, returnUrl: successUrl, cancelUrl: successUrl,
    })).resolves.toEqual({ redirectUrl: link.url, providerRef: link.id, providerOrderRef: order.id, expiresAt: null });
    const options = fetchPinned.mock.calls[0]![2]!;
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({
      idempotency_key: attemptPublicId,
      order: { location_id: order.location_id, reference_id: attemptPublicId,
        line_items: [{ name: "ReadyPackets invoice", quantity: "1", note: `rp-invoice:${invoicePublicId}`, base_price_money: price }] },
      checkout_options: { allow_tipping: false, enable_coupon: false, enable_loyalty: false, redirect_url: successUrl },
    });
    expect(isSquareHostedCheckoutUrl("https://square.link/u/abc", "live")).toBe(true);
    for (const unsafe of ["https://square.link/u/abc", "https://sandbox.square.link.evil.test/u/abc",
      "https://hacker@sandbox.square.link/u/abc", "https://sandbox.square.link:444/u/abc"]) {
      expect(isSquareHostedCheckoutUrl(unsafe, "test")).toBe(false);
    }
  });

  it("binds a signed fresh event to the canonical URL and exact raw bytes before parsing", () => {
    const { adapter } = protocolFake();
    expect(adapter.verifyWebhook(signed())).toMatchObject({
      ok: true, externalEventId: event.event_id, eventType: event.type, livemode: false,
      outcomeHint: "paid", providerOrderRef: order.id, providerPaymentRef: payment.id, providerRef: null,
    });
    expect(adapter.verifyWebhook(signed(event, `${notificationUrl}/`))).toEqual({ ok: false, reasonCode: "SQUARE_SIGNATURE_INVALID" });
    expect(adapter.verifyWebhook({ ...signed(), rawBody: Buffer.from(`${JSON.stringify(event)}\n`) }))
      .toEqual({ ok: false, reasonCode: "SQUARE_SIGNATURE_INVALID" });
    expect(adapter.verifyWebhook(signed({ ...event, created_at: new Date(now.getTime() - 301_000).toISOString() })))
      .toEqual({ ok: false, reasonCode: "SQUARE_EVENT_STALE" });
    expect(adapter.verifyWebhook(signed({ ...event, type: "refund.updated" }))).toMatchObject({ ok: true, outcomeHint: "ignored" });
  });

  it("only reports completion after authoritative link, order, location, amount, currency and payment all agree", async () => {
    const { adapter, wire } = protocolFake();
    await expect(adapter.fetchPayment({ ...fetchArgs, providerPaymentRef: payment.id })).resolves.toEqual({
      providerRef: link.id, providerOrderRef: order.id, providerPaymentRef: payment.id, status: "paid", amountMinor: price.amount,
      currency: price.currency, livemode: false, attemptPublicId, invoicePublicId, paidAt: null,
    });
    expect(wire.mock.calls.flat()).toEqual([`/v2/online-checkout/payment-links/${link.id}`, `/v2/orders/${order.id}`, `/v2/payments/${payment.id}`]);
    for (const wrong of [
      { order_id: "ORDER_02" }, { location_id: "LOCATION_02" }, { amount_money: { ...price, amount: 1298 } },
      { amount_money: { ...price, currency: "CAD" } }, { refunded_money: { ...price, amount: 1 } }, { tip_money: { ...price, amount: 1 } },
    ]) {
      const fake = protocolFake({ payment: { ...payment, ...wrong } });
      await expect(fake.adapter.fetchPayment(fetchArgs)).rejects.toMatchObject({ reasonCode: "SQUARE_PAYMENT_MISMATCH" });
    }
    const stale = protocolFake({ link: { ...link, order_id: "UNRELATED_ORDER" } });
    await expect(stale.adapter.fetchPayment(fetchArgs)).rejects.toMatchObject({ reasonCode: "SQUARE_REFERENCE_MISMATCH" });
    expect(stale.wire).toHaveBeenCalledOnce();
  });

  it("executes the lease guard before every provider request and never trusts a pending payment", async () => {
    const { adapter, wire } = protocolFake({ payment: { ...payment, status: "PENDING" } });
    const fence = new Error("synthetic stale grant");
    const beforeSend = vi.fn<() => Promise<void>>().mockResolvedValueOnce().mockRejectedValueOnce(fence);
    await expect(adapter.fetchPayment({ ...fetchArgs, beforeSend })).rejects.toBe(fence);
    expect(wire).toHaveBeenCalledOnce();
    await expect(adapter.fetchPayment(fetchArgs)).resolves.toMatchObject({ status: "open" });
  });
});
