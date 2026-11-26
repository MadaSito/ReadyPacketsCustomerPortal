import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as sessionMod from "@/lib/session";
import type * as trpc from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import { AdminCheckStripePaymentButton } from "./AdminCheckStripePaymentButton";
import {
  CONFIRM_BACKOFF_DELAYS_MS,
  PaymentReturnConfirmation,
  type PaymentReturnPaidInfo,
} from "./PaymentReturnConfirmation";
import type { PaymentSettingsView } from "./PaymentSettings";
import PaymentSetupPage from "./PaymentSetupPage";

const attemptId = `01J${"0".repeat(22)}1`;
const invoiceId = `01J${"0".repeat(22)}2`;
const orderId = `01J${"0".repeat(22)}3`;
const receiptId = `01J${"0".repeat(22)}4`;
const cartId = `01J${"0".repeat(22)}5`;
const now = new Date("2026-11-26T12:00:00Z");

const missingWebhookConfig: PaymentSettingsView = {
  provider: "stripe",
  mode: "test",
  currency: "USD",
  successPath: "/checkout/return",
  cancelPath: "/checkout/cancel",
  webhookToleranceSeconds: 300,
  stripe: {
    secretKeyConfigured: true,
    secretKeyLast4: "4242",
    webhookSecretConfigured: true,
    webhookSecretLast4: "9876",
    webhookSecretSecondaryConfigured: false,
    webhookSecretSecondaryLast4: null,
    webhookUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    returnUrlPattern: "https://portal.example.test/api/payments/return/stripe/<attemptId>",
    egressHost: "api.stripe.com",
    egressAllowlisted: true,
    inboundCountryAllowlistExempt: true,
    requiredEvents: [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
      "payment_intent.payment_failed",
      "charge.refunded",
      "charge.refund.updated",
      "refund.created",
      "refund.updated",
    ],
    ready: true,
    lastApiVerifiedAt: now.toISOString(),
    lastVerifiedWebhookAt: null,
    lastVerifiedWebhookEventType: null,
    lastVerifiedWebhookStatus: null,
    lastSelfTestWebhookAt: now.toISOString(),
    webhookDelivery: {
      missingWebhookDetected: true,
      unwebhookedLookupPaidCount: 2,
      oldestUnwebhookedPaidAt: "2026-11-26T11:40:00.000Z",
      graceSeconds: 600,
      lastVerifiedWebhookAt: null,
      lastVerifiedWebhookEventType: null,
      recentRejectionCount: 3,
      recentRejectionReasons: [
        {
          reasonCode: "INVALID_SIGNATURE",
          reasonLabel: "Invalid signature",
          count: 3,
          latestAt: "2026-11-26T11:55:00.000Z",
        },
      ],
      endpointUrl: "https://portal.example.test/api/payments/webhooks/stripe",
      requiredEvents: [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "checkout.session.expired",
        "payment_intent.payment_failed",
        "charge.refunded",
        "charge.refund.updated",
        "refund.created",
        "refund.updated",
      ],
      usualCauses: [
        "Wrong webhook endpoint URL in Stripe — confirm Stripe sends POST requests to https://portal.example.test/api/payments/webhooks/stripe.",
        "Mismatched webhook signing secret (whsec_) — each Stripe webhook endpoint has its own signing secret in test vs live mode.",
        "Reverse proxy, firewall, or raw-body middleware blocking Stripe — ensure POST /api/payments/webhooks/stripe reaches ReadyPackets with the unmodified raw body and Stripe-Signature header.",
      ],
    },
  },
  square: {
    locationId: null,
    accessTokenConfigured: false,
    accessTokenLast4: null,
    webhookSignatureKeyConfigured: false,
    webhookSignatureKeyLast4: null,
    webhookUrl: "https://portal.example.test/api/payments/webhooks/square",
    returnUrlPattern: "https://portal.example.test/api/payments/return/square/<attemptId>",
    egressHost: "connect.squareupsandbox.com",
    egressAllowlisted: false,
  },
  onlineEnabled: true,
};

const mocks = vi.hoisted(() => ({
  confirmCheckoutPayment: vi.fn(),
  checkWithStripeNow: vi.fn(),
  getSettings: vi.fn(),
  listRejections: vi.fn(),
  egressPresets: vi.fn(),
  sessionRole: "admin" as "customer" | "staff" | "admin",
}));

vi.mock("@/lib/session", async (original) => ({
  ...(await original<typeof sessionMod>()),
  useSession: () => ({
    me: {
      user: {
        publicId: `01J${"0".repeat(22)}9`,
        email: "actor@example.test",
        name: "Test Actor",
        role: mocks.sessionRole,
      },
    },
    view: {
      status: "full" as const,
      role: mocks.sessionRole,
    },
  }),
}));

vi.mock("@/lib/trpc", async (original) => ({
  ...(await original<typeof trpc>()),
  useTRPCClient: () => ({
    payments: {
      admin: {
        updateSettings: { mutate: vi.fn() },
      },
    },
  }),
  useTRPC: () => {
    const query = (key: string, fn: (input?: unknown) => unknown) => ({
      queryKey: (input?: unknown) => ["payments-d5", key, input ?? null],
      queryOptions: (input?: unknown) => ({
        queryKey: ["payments-d5", key, input ?? null],
        queryFn: async () => fn(input),
      }),
      infiniteQueryOptions: (input: unknown, options: object) => ({
        queryKey: ["payments-d5", key, input],
        queryFn: async () => ({ items: await fn(input), nextCursor: null }),
        initialPageParam: null,
        ...options,
      }),
    });
    return {
      cart: { pathKey: () => ["cart"] },
      orders: { pathKey: () => ["orders"] },
      compliance: {
        pathKey: () => ["compliance"],
        invoices: { pathKey: () => ["compliance", "invoices"] },
      },
      payments: {
        pathKey: () => ["payments"],
        confirmCheckoutPayment: {
          mutationOptions: () => ({
            mutationFn: (input: unknown) => mocks.confirmCheckoutPayment(input),
          }),
        },
        admin: {
          pathKey: () => ["payments", "admin"],
          getSettings: query("settings", () => mocks.getSettings()),
          listWebhookRejections: query("rejections", () => mocks.listRejections()),
          checkWithStripeNow: {
            mutationOptions: () => ({
              mutationFn: (input: unknown) => mocks.checkWithStripeNow(input),
            }),
          },
          testConnection: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
          verifyCheckoutSession: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
          sendSelfTestWebhook: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
        },
      },
      integrations: {
        admin: {
          egress: {
            presets: query("egress-presets", () => mocks.egressPresets()),
            setPreset: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
          },
        },
      },
    };
  },
}));

beforeEach(() => {
  mocks.sessionRole = "admin";
  mocks.confirmCheckoutPayment.mockReset().mockResolvedValue({
    attemptPublicId: attemptId,
    orderPublicId: orderId,
    orderReference: "RP-ORD-2026-0088",
    invoicePublicId: invoiceId,
    invoiceNumber: "INV-2026-0088",
    invoiceStatus: "paid",
    receiptPublicId: receiptId,
    cartPublicId: cartId,
    provider: "stripe",
    environment: "test",
    attemptStatus: "paid",
    state: "paid",
    bookedNow: true,
    bookingSource: "provider_lookup",
    paidAt: "2026-11-26T12:00:00.000Z",
    cooldownRemainingMs: 0,
  });
  mocks.checkWithStripeNow.mockReset().mockResolvedValue({
    checkedCount: 1,
    booked: true,
    alreadyPaid: false,
    invoicePublicId: invoiceId,
    invoiceStatus: "paid",
    receiptPublicId: receiptId,
    attemptPublicId: attemptId,
    attemptStatus: "paid",
    bookingSource: "provider_lookup",
    reasonCode: "BOOKED",
  });
  mocks.getSettings.mockReset().mockResolvedValue(missingWebhookConfig);
  mocks.listRejections.mockReset().mockResolvedValue([]);
  mocks.egressPresets.mockReset().mockResolvedValue([
    { key: "stripe", label: "Stripe API", enabled: true, parameterized: false },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

pageA11y("PaymentReturnConfirmation paid state (including 240px container)", async () => {
  renderUi(
    <main>
      <title>Payment confirmation · ReadyPackets</title>
      <h1>Payment confirmation</h1>
      <div style={{ maxWidth: 240 }}>
        <PaymentReturnConfirmation attemptPublicId={attemptId} />
      </div>
    </main>,
    { path: `/checkout/return?attempt=${attemptId}` },
  );
  await screen.findByText("Payment received");
  expect(screen.getByRole("link", { name: "Continue to your order" })).toHaveAttribute(
    "href",
    `/orders/${orderId}`,
  );
});

pageA11y("/admin/payments/setup missing-webhook diagnostics", async () => {
  renderUi(
    <main>
      <title>Stripe setup · ReadyPackets</title>
      <PaymentSetupPage />
    </main>,
    { path: "/admin/payments/setup" },
  );
  await screen.findByTestId("stripe-missing-webhook-banner");
  expect(screen.getByTestId("stripe-webhook-diagnostics")).toBeInTheDocument();
  expect(screen.getByText(/Wrong webhook endpoint URL in Stripe/i)).toBeInTheDocument();
  expect(screen.getByText(/Mismatched webhook signing secret/i)).toBeInTheDocument();
  expect(screen.getByText(/Reverse proxy, firewall, or raw-body middleware/i)).toBeInTheDocument();
  expect(screen.getByText(/Invalid signature: 3/i)).toBeInTheDocument();
});

describe("D5 PaymentReturnConfirmation & AdminCheckStripePaymentButton", () => {
  it("calls confirmCheckoutPayment immediately on mount, invokes onPaid once, and links to order & receipt", async () => {
    const onPaid = vi.fn<(info: PaymentReturnPaidInfo) => void>();
    renderUi(
      <main>
        <PaymentReturnConfirmation attemptPublicId={attemptId} onPaid={onPaid} />
      </main>,
      { path: `/checkout/return?attempt=${attemptId}` },
    );

    await screen.findByText("Payment received");
    expect(mocks.confirmCheckoutPayment).toHaveBeenCalledTimes(1);
    expect(mocks.confirmCheckoutPayment).toHaveBeenCalledWith({ attemptPublicId: attemptId });
    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
    expect(onPaid).toHaveBeenCalledWith({
      orderPublicId: orderId,
      orderReference: "RP-ORD-2026-0088",
      invoicePublicId: invoiceId,
      invoiceNumber: "INV-2026-0088",
      receiptPublicId: receiptId,
      continueHref: `/orders/${orderId}`,
    });
    expect(screen.getByRole("link", { name: "View receipt" })).toHaveAttribute(
      "href",
      `/receipts/${receiptId}`,
    );
  });

  it("auto-rechecks with exponential back-off while processing, supports manual Check payment status, and shows async settlement guidance after bounded checks", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.confirmCheckoutPayment.mockResolvedValue({
      attemptPublicId: attemptId,
      orderPublicId: orderId,
      orderReference: "RP-ORD-2026-0089",
      invoicePublicId: invoiceId,
      invoiceNumber: "INV-2026-0089",
      invoiceStatus: "issued",
      receiptPublicId: null,
      cartPublicId: cartId,
      provider: "stripe",
      environment: "test",
      attemptStatus: "redirected",
      state: "processing",
      bookedNow: false,
      bookingSource: null,
      paidAt: null,
      cooldownRemainingMs: 0,
    });

    renderUi(
      <main>
        <PaymentReturnConfirmation attemptPublicId={attemptId} />
      </main>,
      { path: `/checkout/return?attempt=${attemptId}` },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    await waitFor(() => expect(mocks.confirmCheckoutPayment).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Confirming your payment with the payment provider/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check payment status" })).toBeInTheDocument();

    for (let i = 0; i < CONFIRM_BACKOFF_DELAYS_MS.length; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONFIRM_BACKOFF_DELAYS_MS[i]! + 50);
      });
      await waitFor(() => expect(mocks.confirmCheckoutPayment).toHaveBeenCalledTimes(i + 2));
    }

    // After exhausting bounded auto-rechecks, shows async settlement guidance + Continue to your order
    expect(
      await screen.findByText(/Your payment is still settling with the provider/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue to your order" })).toHaveAttribute(
      "href",
      `/orders/${orderId}`,
    );

    // No further automatic timer calls fire after exhaustion
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.confirmCheckoutPayment).toHaveBeenCalledTimes(1 + CONFIRM_BACKOFF_DELAYS_MS.length);
  });

  it("handles invalid ULID on return page without firing confirmCheckoutPayment", () => {
    renderUi(
      <main>
        <PaymentReturnConfirmation attemptPublicId="not-a-valid-ulid" />
      </main>,
      { path: "/checkout/return?attempt=not-a-valid-ulid" },
    );

    expect(screen.getByText("Missing payment confirmation reference")).toBeInTheDocument();
    expect(mocks.confirmCheckoutPayment).not.toHaveBeenCalled();
  });

  it("guards AdminCheckStripePaymentButton visibility (admin + portal + issued only) and executes checkWithStripeNow", async () => {
    const user = userEvent.setup();
    const onUpdated = vi.fn();

    // Hidden for staff
    mocks.sessionRole = "staff";
    const { unmount: u1 } = renderUi(
      <AdminCheckStripePaymentButton invoicePublicId={invoiceId} invoiceStatus="issued" />,
    );
    expect(screen.queryByRole("button", { name: "Check with Stripe now" })).toBeNull();
    u1();

    // Hidden for imported or already-paid invoices even for admin
    mocks.sessionRole = "admin";
    const { unmount: u2 } = renderUi(
      <div>
        <AdminCheckStripePaymentButton
          invoicePublicId={invoiceId}
          invoiceStatus="issued"
          origin="import"
        />
        <AdminCheckStripePaymentButton
          invoicePublicId={invoiceId}
          invoiceStatus="paid"
          origin="portal"
        />
      </div>,
    );
    expect(screen.queryByRole("button", { name: "Check with Stripe now" })).toBeNull();
    u2();

    // Visible for admin on issued portal invoice and triggers checkWithStripeNow + onUpdated
    renderUi(
      <AdminCheckStripePaymentButton
        invoicePublicId={invoiceId}
        invoiceStatus="issued"
        origin="portal"
        attemptPublicId={attemptId}
        onUpdated={onUpdated}
      />,
    );

    const btn = screen.getByRole("button", { name: "Check with Stripe now" });
    await user.click(btn);

    await waitFor(() =>
      expect(mocks.checkWithStripeNow).toHaveBeenCalledWith({
        invoicePublicId: invoiceId,
        attemptPublicId: attemptId,
      }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
  });

  it("preserves WCAG 2.2 AA 2.4.3 focus on manual Check payment status (including first-error retry -> processing -> paid) without stealing focus on background polls", async () => {
    const user = userEvent.setup();

    // 1. Initial check fails -> user activates `Check payment status` in error state -> moves focus to summary `Check payment status` -> user activates again -> moves focus to `Continue to your order` on Paid
    mocks.confirmCheckoutPayment
      .mockRejectedValueOnce(new Error("Temporary Stripe timeout"))
      .mockResolvedValueOnce({
        attemptPublicId: attemptId,
        orderPublicId: orderId,
        orderReference: "RP-ORD-2026-0091",
        invoicePublicId: invoiceId,
        invoiceNumber: "INV-2026-0091",
        invoiceStatus: "issued",
        receiptPublicId: null,
        cartPublicId: cartId,
        provider: "stripe",
        environment: "test",
        attemptStatus: "redirected",
        state: "processing",
        bookedNow: false,
        bookingSource: null,
        paidAt: null,
        cooldownRemainingMs: 0,
      })
      .mockResolvedValueOnce({
        attemptPublicId: attemptId,
        orderPublicId: orderId,
        orderReference: "RP-ORD-2026-0091",
        invoicePublicId: invoiceId,
        invoiceNumber: "INV-2026-0091",
        invoiceStatus: "paid",
        receiptPublicId: receiptId,
        cartPublicId: cartId,
        provider: "stripe",
        environment: "test",
        attemptStatus: "paid",
        state: "paid",
        bookedNow: true,
        bookingSource: "provider_lookup",
        paidAt: "2026-11-26T12:00:05.000Z",
        cooldownRemainingMs: 0,
      });

    const { unmount } = renderUi(
      <main>
        <PaymentReturnConfirmation attemptPublicId={attemptId} />
      </main>,
      { path: `/checkout/return?attempt=${attemptId}` },
    );

    const errorRetryBtn = await screen.findByRole("button", { name: "Check payment status" });
    errorRetryBtn.focus();
    expect(errorRetryBtn).toHaveFocus();
    await user.keyboard("{Enter}");

    await screen.findByText(/Confirming your payment with the payment provider/i);
    const processingCheckBtn = screen.getByRole("button", { name: "Check payment status" });
    await waitFor(() => expect(processingCheckBtn).toHaveFocus());

    await user.keyboard("{Enter}");
    await screen.findByText("Payment received");
    expect(screen.queryByRole("button", { name: "Check payment status" })).toBeNull();
    const continueLink = screen.getByRole("link", { name: "Continue to your order" });
    await waitFor(() => expect(continueLink).toHaveFocus());
    unmount();

    // 2. Background automatic poll transitioning processing -> paid does NOT steal focus from another focused control
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.confirmCheckoutPayment
      .mockReset()
      .mockResolvedValueOnce({
        attemptPublicId: attemptId,
        orderPublicId: orderId,
        orderReference: "RP-ORD-2026-0092",
        invoicePublicId: invoiceId,
        invoiceNumber: "INV-2026-0092",
        invoiceStatus: "issued",
        receiptPublicId: null,
        cartPublicId: cartId,
        provider: "stripe",
        environment: "test",
        attemptStatus: "redirected",
        state: "processing",
        bookedNow: false,
        bookingSource: null,
        paidAt: null,
        cooldownRemainingMs: 0,
      })
      .mockResolvedValueOnce({
        attemptPublicId: attemptId,
        orderPublicId: orderId,
        orderReference: "RP-ORD-2026-0092",
        invoicePublicId: invoiceId,
        invoiceNumber: "INV-2026-0092",
        invoiceStatus: "paid",
        receiptPublicId: receiptId,
        cartPublicId: cartId,
        provider: "stripe",
        environment: "test",
        attemptStatus: "paid",
        state: "paid",
        bookedNow: true,
        bookingSource: "provider_lookup",
        paidAt: "2026-11-26T12:00:10.000Z",
        cooldownRemainingMs: 0,
      });

    renderUi(
      <main>
        <PaymentReturnConfirmation attemptPublicId={attemptId} />
      </main>,
      { path: `/checkout/return?attempt=${attemptId}` },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    const openInvoiceLink = await screen.findByRole("link", { name: "Open invoice" });
    openInvoiceLink.focus();
    expect(openInvoiceLink).toHaveFocus();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFIRM_BACKOFF_DELAYS_MS[0] + 50);
    });
    await screen.findByText("Payment received");
    expect(openInvoiceLink).toHaveFocus();
  });
});
