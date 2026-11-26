import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type * as trpc from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import { PaymentSettings, type PaymentSettingsInput, type PaymentSettingsView } from "./PaymentSettings";
import PaymentsPage from "./PaymentsPage";
import PaymentSetupPage from "./PaymentSetupPage";

const id = `01J${"0".repeat(22)}1`;
const invoiceId = `01J${"0".repeat(22)}2`;
const date = new Date("2026-11-21T12:00:00Z");
const defaultConfig: PaymentSettingsView = {
  provider: "square",
  mode: "test",
  currency: "USD",
  successPath: "/checkout/return",
  cancelPath: "/checkout/cancel",
  webhookToleranceSeconds: 300,
  stripe: {
    secretKeyConfigured: false,
    secretKeyLast4: null,
    webhookSecretConfigured: false,
    webhookSecretLast4: null,
    webhookSecretSecondaryConfigured: false,
    webhookSecretSecondaryLast4: null,
    webhookUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    returnUrlPattern: "https://portal.example.test/api/payments/return/stripe/<attemptId>",
    egressHost: "api.stripe.com",
    egressAllowlisted: false,
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
    ready: false,
    lastApiVerifiedAt: null,
    lastVerifiedWebhookAt: null,
    lastVerifiedWebhookEventType: null,
    lastVerifiedWebhookStatus: null,
    lastSelfTestWebhookAt: null,
  },
  square: {
    locationId: "LOCATION_01",
    accessTokenConfigured: true,
    accessTokenLast4: "a1b2",
    webhookSignatureKeyConfigured: true,
    webhookSignatureKeyLast4: "c3d4",
    webhookUrl: "https://portal.example.test/api/payments/webhooks/square",
    returnUrlPattern: "https://portal.example.test/api/payments/return/square/<attemptId>",
    egressHost: "connect.squareupsandbox.com",
    egressAllowlisted: true,
  },
  onlineEnabled: true,
};
const attempt = {
  attemptPublicId: id,
  invoicePublicId: invoiceId,
  provider: "square",
  environment: "test",
  status: "redirected",
  amountMinor: 1299,
  currency: "USD",
  createdAt: date,
  failureReasonCode: null,
};
const receipt = {
  webhookPublicId: id,
  provider: "square",
  environment: "test",
  status: "retry_pending",
  eventType: "payment.updated",
  receivedAt: date,
  reasonCode: "SYNTHETIC_PENDING",
};
const rejection = {
  rejectionPublicId: id,
  provider: "stripe" as const,
  reasonCode: "INVALID_SIGNATURE",
  reasonLabel: "Invalid signature",
  httpStatus: 400,
  detail: "Stripe-Signature header did not match primary or secondary signing secret.",
  receivedAt: date,
};

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  testConnection: vi.fn(),
  verifyCheckoutSession: vi.fn(),
  sendSelfTest: vi.fn(),
  listRejections: vi.fn(),
  egressPresets: vi.fn(),
  setEgressPreset: vi.fn(),
}));

beforeEach(() => {
  mocks.getSettings.mockReset().mockResolvedValue(defaultConfig);
  mocks.updateSettings.mockReset().mockResolvedValue(defaultConfig);
  mocks.testConnection.mockReset().mockResolvedValue({
    provider: "stripe",
    mode: "test",
    ok: true,
    egressAllowlisted: true,
    secretConfigured: true,
    httpStatus: 200,
    message: "Connected to Stripe test API over api.stripe.com:443.",
    checkedAt: date,
  });
  mocks.verifyCheckoutSession.mockReset().mockResolvedValue({
    provider: "stripe",
    mode: "test",
    ok: true,
    egressAllowlisted: true,
    secretConfigured: true,
    httpStatus: 200,
    reasonCode: "CHECKOUT_SESSION_VERIFIED",
    stripeErrorType: null,
    stripeErrorCode: null,
    stripeErrorParam: null,
    expiredImmediately: true,
    message: "Created an unpaid test Stripe Checkout Session over api.stripe.com:443 and expired it immediately.",
    checkedAt: date,
  });
  mocks.sendSelfTest.mockReset().mockResolvedValue({
    provider: "stripe",
    mode: "test",
    ok: true,
    httpStatus: 200,
    reasonCode: "SELF_TEST_OK",
    eventId: "evt_selftest_01",
    sentAt: date,
  });
  mocks.listRejections.mockReset().mockResolvedValue([rejection]);
  mocks.egressPresets.mockReset().mockResolvedValue([
    { key: "stripe", label: "Stripe API", enabled: false, parameterized: false },
  ]);
  mocks.setEgressPreset.mockReset().mockResolvedValue({
    key: "stripe",
    label: "Stripe API",
    enabled: true,
    parameterized: false,
  });
});

vi.mock("@/lib/trpc", async (original) => ({
  ...(await original<typeof trpc>()),
  useTRPCClient: () => ({
    payments: {
      admin: {
        updateSettings: { mutate: (input: unknown) => mocks.updateSettings(input) },
      },
    },
  }),
  useTRPC: () => {
    const query = (key: string, fn: (input?: unknown) => unknown) => ({
      queryKey: (input?: unknown) => ["payments", key, input ?? null],
      queryOptions: (input?: unknown) => ({
        queryKey: ["payments", key, input ?? null],
        queryFn: async () => fn(input),
      }),
      infiniteQueryOptions: (input: unknown, options: object) => ({
        queryKey: ["payments", key, input],
        queryFn: async () => ({ items: await fn(input), nextCursor: null }),
        initialPageParam: null,
        ...options,
      }),
    });
    return {
      payments: {
        admin: {
          getSettings: query("config", () => mocks.getSettings()),
          getAttempt: query("details", () => ({ attempt, webhooks: [receipt] })),
          listAttempts: query("attempts", () => [attempt]),
          listWebhooks: query("receipts", () => [receipt]),
          listWebhookRejections: query("rejections", () => mocks.listRejections()),
          pathKey: () => ["payments"],
          reconcileNow: {
            mutationOptions: () => ({
              mutationFn: async () => ({ scanned: 1, booked: 0, stillPending: 1 }),
            }),
          },
          testConnection: {
            mutationOptions: () => ({
              mutationFn: (input: unknown) => mocks.testConnection(input),
            }),
          },
          verifyCheckoutSession: {
            mutationOptions: () => ({
              mutationFn: (input: unknown) => mocks.verifyCheckoutSession(input),
            }),
          },
          sendSelfTestWebhook: {
            mutationOptions: () => ({
              mutationFn: (input: unknown) => mocks.sendSelfTest(input),
            }),
          },
        },
      },
      integrations: {
        admin: {
          egress: {
            presets: query("egress-presets", () => mocks.egressPresets()),
            setPreset: {
              mutationOptions: () => ({
                mutationFn: (input: unknown) => mocks.setEgressPreset(input),
              }),
            },
          },
        },
      },
    };
  },
}));

function renderPage() {
  return renderUi(
    <main>
      <title>Payments · ReadyPackets</title>
      <PaymentsPage />
    </main>,
    { path: "/admin/payments" },
  );
}

function renderSetupPage() {
  return renderUi(
    <main>
      <title>Stripe setup · ReadyPackets</title>
      <PaymentSetupPage />
    </main>,
    { path: "/admin/payments/setup" },
  );
}

pageA11y("/admin/payments configuration", async () => {
  renderPage();
  await screen.findByRole("heading", { name: "Checkout configuration" });
});

pageA11y("/admin/payments attempt details", async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole("tab", { name: "Payment attempts" }));
  await user.click((await screen.findAllByRole("button", { name: `Details for attempt ${id}` }))[0]!);
  await screen.findByRole("dialog", { name: "Payment attempt details" });
  await screen.findByText("payment.updated");
});

pageA11y("/admin/payments/setup checklist and diagnostics", async () => {
  renderSetupPage();
  await screen.findByRole("heading", { name: "Stripe readiness checklist" });
  await screen.findAllByText("Stripe-Signature header did not match primary or secondary signing secret.");
});

it("keeps stored keys out of inputs and submits only replacement secrets for the same environment", async () => {
  const user = userEvent.setup();
  const save = vi.fn<(input: PaymentSettingsInput) => Promise<void>>().mockResolvedValue(undefined);
  renderUi(<PaymentSettings settings={defaultConfig} saving={false} onSave={save} />);
  expect(screen.getByLabelText("Square access token")).toHaveValue("");
  expect(screen.getByLabelText("Square webhook signature key")).toHaveValue("");
  await user.type(screen.getByLabelText("Square access token"), "synthetic_new_square_token");
  await user.click(screen.getByRole("button", { name: "Save payment settings" }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "square", mode: "test", squareAccessToken: "synthetic_new_square_token" }),
  );
  expect(save.mock.calls[0]?.[0]).not.toHaveProperty("squareWebhookSignatureKey");
  expect(screen.getByLabelText("Square access token")).toHaveValue("");
});

it("requires fresh credentials for switching environments and confirms live activation", async () => {
  const user = userEvent.setup();
  const save = vi.fn<(input: PaymentSettingsInput) => Promise<void>>().mockResolvedValue(undefined);
  renderUi(<PaymentSettings settings={defaultConfig} saving={false} onSave={save} />);
  await user.selectOptions(screen.getByRole("combobox", { name: /^Environment/u }), "live");
  expect(screen.getByText("connect.squareup.com")).toBeInTheDocument();
  expect(screen.getByText(/verify the rule for this environment/i)).toBeInTheDocument();
  await user.type(screen.getByLabelText(/^Square access token/u), "synthetic_live_square_token");
  await user.click(screen.getByRole("button", { name: "Save payment settings" }));
  expect(
    await screen.findByText("Enter both credentials for the selected provider and environment before activating it."),
  ).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText(/^Square webhook signature key/u), "synthetic_live_square_signing_key");
  await user.click(screen.getByRole("button", { name: "Save payment settings" }));
  expect(screen.getByRole("alertdialog", { name: "Enable live payments?" })).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Enable live payments" })).toBeDisabled();
  await user.type(screen.getByLabelText(/Type ACTIVATE LIVE PAYMENTS/i), "ACTIVATE LIVE PAYMENTS");
  await user.click(screen.getByRole("button", { name: "Enable live payments" }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "square",
      mode: "live",
      squareAccessToken: "synthetic_live_square_token",
      squareWebhookSignatureKey: "synthetic_live_square_signing_key",
    }),
  );
  expect(screen.getByLabelText(/^Square access token/u)).toHaveValue("");
});

it("renders safe receipt outcomes and validates the exact invoice filter", async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole("tab", { name: "Verified webhooks" }));
  expect((await screen.findAllByText("SYNTHETIC_PENDING")).length).toBeGreaterThan(0);
  await user.click(screen.getByRole("tab", { name: "Payment attempts" }));
  const invoice = screen.getByRole("searchbox", { name: "Invoice public ID" });
  await user.type(invoice, "not-a-valid-id{Enter}");
  expect(await screen.findByText("Enter a valid 26-character invoice public ID.")).toBeInTheDocument();
});

it("submits D5 small-total mode and D15 payment receipt preferences", async () => {
  const user = userEvent.setup();
  const save = vi.fn<(input: PaymentSettingsInput) => Promise<void>>().mockResolvedValue(undefined);
  renderUi(
    <PaymentSettings
      settings={{
        ...defaultConfig,
        smallTotals: { belowProviderMinimum: "waive" },
        receipts: { enabled: true, emailCustomer: true, footerText: "" },
      }}
      saving={false}
      onSave={save}
    />,
  );
  await user.selectOptions(screen.getByLabelText("Totals below provider minimum"), "block");
  await user.type(screen.getByLabelText("Receipt footer note"), "Thank you for your business.");
  await user.click(screen.getByRole("button", { name: "Save payment settings" }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      smallTotals: { belowProviderMinimum: "block" },
      receipts: {
        enabled: true,
        emailCustomer: true,
        footerText: "Thank you for your business.",
      },
    }),
  );
});

it("shows the Stripe readiness warning banner on /admin/payments when Stripe is selected but incomplete", async () => {
  mocks.getSettings.mockResolvedValue({
    ...defaultConfig,
    provider: "stripe",
    onlineEnabled: false,
  });
  renderPage();
  expect(
    await screen.findByText("Stripe checkout is selected, but readiness checks are incomplete"),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open Stripe setup checklist" })).toHaveAttribute(
    "href",
    "/admin/payments/setup",
  );
});

it("toggles Stripe egress, stages keys while keeping Pay by invoice active, and runs API + self-test checks", async () => {
  const user = userEvent.setup();
  mocks.getSettings.mockResolvedValue({
    ...defaultConfig,
    provider: "none",
    onlineEnabled: false,
    stripe: {
      ...defaultConfig.stripe,
      secretKeyConfigured: true,
      secretKeyLast4: "4242",
      webhookSecretConfigured: true,
      webhookSecretLast4: "9876",
      egressAllowlisted: true,
    },
  });
  mocks.egressPresets.mockResolvedValue([
    { key: "stripe", label: "Stripe API", enabled: true, parameterized: false },
  ]);

  renderSetupPage();
  await screen.findByRole("heading", { name: "Stripe readiness checklist" });

  // Egress switch toggles preset via integrations.admin.egress.setPreset
  await user.click(screen.getByRole("switch", { name: "Allow api.stripe.com:443" }));
  expect(mocks.setEgressPreset).toHaveBeenCalledWith({ presetKey: "stripe", enabled: false });

  // Stage secondary rollover signing secret while provider stays "none"
  await user.type(
    screen.getByLabelText("Secondary Stripe webhook signing secret (optional rollover)"),
    "whsec_test_secondary_rollover_secret_1234",
  );
  await user.click(screen.getByRole("button", { name: "Stage Stripe credentials" }));
  expect(mocks.updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "none",
      mode: "test",
      stripeWebhookSecretSecondary: "whsec_test_secondary_rollover_secret_1234",
    }),
  );
  expect(
    screen.getByLabelText("Secondary Stripe webhook signing secret (optional rollover)"),
  ).toHaveValue("");

  // Test Stripe API and send self-test webhook
  await user.click(screen.getByRole("button", { name: "Test Stripe API" }));
  expect(mocks.testConnection).toHaveBeenCalledWith({ provider: "stripe" });

  await user.click(screen.getByRole("button", { name: "Send self-test webhook" }));
  expect(mocks.sendSelfTest).toHaveBeenCalledWith({ provider: "stripe" });

  // Rejections table renders human reason labels + secondary raw codes, and omits HTTP-layer filter options
  expect((await screen.findAllByText("Invalid signature")).length).toBeGreaterThan(0);
  expect((await screen.findAllByText(/INVALID_SIGNATURE · HTTP 400/u)).length).toBeGreaterThan(0);
  expect(
    (await screen.findAllByText("Stripe-Signature header did not match primary or secondary signing secret.")).length,
  ).toBeGreaterThan(0);
  const reasonSelect = screen.getByLabelText("Rejection reason");
  expect(reasonSelect.textContent).not.toContain("Unsupported media type");
  expect(reasonSelect.textContent).not.toContain("Payload over 256 KB");
  expect(screen.getByText(/payloads over 256 KB \(HTTP 413\) are refused by the HTTP transport layer/i)).toBeInTheDocument();
});

it("keeps Activate Stripe Checkout disabled when API check fails (HTTP 401), requires confirmation dialogs (ACTIVATE LIVE PAYMENTS in live mode), and deactivates in one confirm", async () => {
  const user = userEvent.setup();
  mocks.egressPresets.mockResolvedValue([
    { key: "stripe", label: "Stripe API", enabled: true, parameterized: false },
  ]);

  // 1. Staged fake key: API check fails with HTTP 401 -> Activate button remains disabled & checklist item is NOT Optional.
  mocks.getSettings.mockResolvedValue({
    ...defaultConfig,
    provider: "none",
    mode: "test",
    onlineEnabled: false,
    stripe: {
      ...defaultConfig.stripe,
      egressAllowlisted: true,
      secretKeyConfigured: true,
      secretKeyLast4: "0001",
      webhookSecretConfigured: true,
      webhookSecretLast4: "9876",
      lastApiVerifiedAt: null,
      lastSelfTestWebhookAt: "2026-11-21T12:00:00.000Z",
    },
  });
  mocks.testConnection.mockResolvedValueOnce({
    provider: "stripe",
    mode: "test",
    ok: false,
    message: "Stripe rejected the staged secret key (HTTP 401).",
  });

  const firstRender = renderSetupPage();
  await screen.findByRole("heading", { name: "Stripe readiness checklist" });
  expect(screen.queryByText("Optional")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Activate Stripe Checkout" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "Test Stripe API" }));
  expect((await screen.findAllByText("Stripe rejected the staged secret key (HTTP 401).")).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "Activate Stripe Checkout" })).toBeDisabled();
  firstRender.unmount();

  // 2. Live mode with verified API + Checkout session probe + self-test requires typing ACTIVATE LIVE PAYMENTS in confirmation dialog.
  mocks.getSettings.mockResolvedValue({
    ...defaultConfig,
    provider: "none",
    mode: "live",
    onlineEnabled: false,
    stripe: {
      ...defaultConfig.stripe,
      egressAllowlisted: true,
      secretKeyConfigured: true,
      secretKeyLast4: "4242",
      webhookSecretConfigured: true,
      webhookSecretLast4: "9876",
      lastApiVerifiedAt: "2026-11-21T12:05:00.000Z",
      lastSelfTestWebhookAt: "2026-11-21T12:06:00.000Z",
      checkoutSessionVerified: true,
      lastCheckoutProbe: {
        checkedAt: "2026-11-21T12:05:30.000Z",
        mode: "live",
        ok: true,
        reasonCode: "CHECKOUT_PROBE_OK",
        message: "Verified Checkout session creation and immediate expiration.",
      },
    },
  });

  const liveRender = renderSetupPage();
  const activateBtn = await screen.findByRole("button", { name: "Activate Stripe Checkout" });
  expect(activateBtn).toBeEnabled();
  await user.click(activateBtn);

  expect(screen.getByRole("alertdialog", { name: "Activate live Stripe Checkout?" })).toBeInTheDocument();
  const confirmLiveBtn = screen.getByRole("button", { name: "Activate live Stripe Checkout" });
  expect(confirmLiveBtn).toBeDisabled();
  expect(mocks.updateSettings).not.toHaveBeenCalled();

  await user.type(screen.getByLabelText(/Type ACTIVATE LIVE PAYMENTS/i), "ACTIVATE LIVE PAYMENTS");
  expect(confirmLiveBtn).toBeEnabled();
  await user.click(confirmLiveBtn);
  expect(mocks.updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "stripe", mode: "live" }),
  );
  liveRender.unmount();

  // 3. Deactivation back to Pay by invoice stays a single confirmation click (even if Stripe was selected with incomplete checks).
  mocks.updateSettings.mockReset().mockResolvedValue(defaultConfig);
  mocks.getSettings.mockResolvedValue({
    ...defaultConfig,
    provider: "stripe",
    mode: "test",
    onlineEnabled: false,
    stripe: {
      ...defaultConfig.stripe,
      egressAllowlisted: true,
      secretKeyConfigured: true,
      secretKeyLast4: "0001",
      webhookSecretConfigured: true,
      webhookSecretLast4: "9876",
      lastApiVerifiedAt: null,
      lastSelfTestWebhookAt: null,
    },
  });

  renderSetupPage();
  const switchBackBtn = await screen.findByRole("button", { name: "Switch to Pay by invoice" });
  await user.click(switchBackBtn);
  expect(screen.getByRole("alertdialog", { name: "Switch back to Pay by invoice?" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Switch to Pay by invoice" }));
  expect(mocks.updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "none", mode: "test" }),
  );
});

it("Fix Pack 07.2 Problem A — renders ACTIVE/NOT ACTIVE customer banner, stale verification warning, last checkout failure diagnostics, and Verify Checkout session creation probe", async () => {
  const user = userEvent.setup();
  mocks.egressPresets.mockResolvedValue([
    { key: "stripe", label: "Stripe API", enabled: true, parameterized: false },
  ]);

  // 1. Paused / stale verification + lastCheckoutFailure diagnostics + failed probe blocks activation
  mocks.getSettings.mockResolvedValue({
    ...defaultConfig,
    provider: "stripe",
    mode: "live",
    onlineEnabled: false,
    stripe: {
      ...defaultConfig.stripe,
      egressAllowlisted: true,
      secretKeyConfigured: true,
      secretKeyLast4: "4242",
      webhookSecretConfigured: true,
      webhookSecretLast4: "9876",
      lastApiVerifiedAt: "2026-11-21T12:05:00.000Z",
      lastSelfTestWebhookAt: "2026-11-21T12:06:00.000Z",
      reverificationNeeded: true,
      reverificationReasons: [
        "Primary signing secret changed after the last self-test; re-run Send self-test webhook.",
      ],
      missingGates: ["api_verified", "checkout_session_verified", "webhook_verified"],
      lastCheckoutProbe: {
        checkedAt: "2026-11-21T12:10:00.000Z",
        mode: "live",
        ok: false,
        reasonCode: "STRIPE_KEY_MISSING_PERMISSION",
        httpStatus: 403,
        stripeErrorType: "invalid_request_error",
        stripeErrorCode: "permission_denied",
        stripeErrorParam: "line_items",
        expiredImmediately: false,
      },
      lastCheckoutFailure: {
        occurredAt: "2026-11-21T12:15:00.000Z",
        provider: "stripe",
        mode: "live",
        reasonCode: "STRIPE_KEY_MISSING_PERMISSION",
        failureClass: "provider_permission",
        upstreamStatus: 403,
        stripeErrorType: "invalid_request_error",
        stripeErrorCode: "permission_denied",
        stripeErrorParam: "line_items",
        invoicePublicId: invoiceId,
        attemptPublicId: id,
      },
    },
  });

  const pausedView = renderSetupPage();
  expect(
    await screen.findByText(/Online card checkout: NOT ACTIVE — Stripe Checkout \(live\) is paused pending verification/u),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Credentials or outbound allowlist changed after verification/u),
  ).toBeInTheDocument();
  expect(screen.getByText("Last checkout-session failure")).toBeInTheDocument();
  expect(screen.getByText("Restricted key missing permission (HTTP 403)")).toBeInTheDocument();
  expect(screen.getAllByText("STRIPE_KEY_MISSING_PERMISSION").length).toBeGreaterThan(0);
  expect(screen.getAllByText(/permission_denied/u).length).toBeGreaterThan(0);
  expect(screen.queryByText("Optional")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Switch to Pay by invoice" })).toBeEnabled();

  await user.click(screen.getByRole("button", { name: "Verify Checkout session creation" }));
  expect(mocks.verifyCheckoutSession).toHaveBeenCalledWith({ provider: "stripe" });
  pausedView.unmount();

  // 2. Pay-by-invoice mode banner states plainly: Customers get pay-by-invoice; no card payment is collected; failed probe keeps Activate disabled
  mocks.getSettings.mockResolvedValue({
    ...defaultConfig,
    provider: "none",
    mode: "live",
    onlineEnabled: false,
    stripe: {
      ...defaultConfig.stripe,
      egressAllowlisted: true,
      secretKeyConfigured: true,
      secretKeyLast4: "4242",
      webhookSecretConfigured: true,
      webhookSecretLast4: "9876",
      lastApiVerifiedAt: "2026-11-21T12:05:00.000Z",
      lastSelfTestWebhookAt: "2026-11-21T12:06:00.000Z",
      lastCheckoutProbe: {
        checkedAt: "2026-11-21T12:10:00.000Z",
        mode: "live",
        ok: false,
        reasonCode: "STRIPE_KEY_MISSING_PERMISSION",
        httpStatus: 403,
        stripeErrorType: "invalid_request_error",
        stripeErrorCode: "permission_denied",
        stripeErrorParam: "line_items",
        expiredImmediately: false,
      },
      missingGates: ["checkout_session_verified"],
    },
  });
  const invoiceOnlyView = renderSetupPage();
  expect(
    await screen.findByText(
      /Online card checkout: NOT ACTIVE — Customers get pay-by-invoice; no card payment is collected/u,
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Activate Stripe Checkout" })).toBeDisabled();
  invoiceOnlyView.unmount();

  // 3. Active live mode banner states plainly that customers are sent to Stripe Checkout (live)
  mocks.getSettings.mockResolvedValue({
    ...defaultConfig,
    provider: "stripe",
    mode: "live",
    onlineEnabled: true,
    stripe: {
      ...defaultConfig.stripe,
      egressAllowlisted: true,
      secretKeyConfigured: true,
      secretKeyLast4: "4242",
      webhookSecretConfigured: true,
      webhookSecretLast4: "9876",
      ready: true,
      lastApiVerifiedAt: "2026-11-21T12:05:00.000Z",
      lastSelfTestWebhookAt: "2026-11-21T12:06:00.000Z",
      missingGates: [],
    },
  });

  const activeView = renderSetupPage();
  expect(
    await screen.findByText(/Online card checkout: ACTIVE — Customers are sent to Stripe Checkout \(live\)/u),
  ).toBeInTheDocument();
  activeView.unmount();
});

it("Fix Pack 07.2 Problem B — validates shapes per field with focus management without echoing secrets, normalizes pasted whitespace/quotes, toggles Show/Hide, and warns on Secondary vs Primary", async () => {
  const user = userEvent.setup();
  mocks.egressPresets.mockResolvedValue([
    { key: "stripe", label: "Stripe API", enabled: true, parameterized: false },
  ]);
  mocks.getSettings.mockResolvedValue({
    ...defaultConfig,
    provider: "none",
    mode: "live",
    onlineEnabled: false,
    stripe: {
      ...defaultConfig.stripe,
      egressAllowlisted: true,
      secretKeyConfigured: true,
      secretKeyLast4: "4242",
      webhookSecretConfigured: true,
      webhookSecretLast4: "9876",
    },
  });

  const { container } = renderSetupPage();
  const apiKeyInput = await screen.findByLabelText("Stripe API secret key");
  const primaryWhInput = screen.getByLabelText("Primary Stripe webhook signing secret");
  const secondaryWhInput = screen.getByLabelText("Secondary Stripe webhook signing secret (optional rollover)");

  // Anti-autofill attributes + password type + Show/Hide toggles + zero character counters
  for (const input of [apiKeyInput, primaryWhInput, secondaryWhInput]) {
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("data-1p-ignore", "true");
    expect(input).toHaveAttribute("data-lpignore", "true");
    expect(input).toHaveAttribute("data-bwignore", "true");
    expect(input).toHaveAttribute("data-form-type", "other");
    expect(input).toHaveAttribute("type", "password");
  }
  expect(container.textContent).not.toMatch(/\b\d+\s*\/\s*256\b/u);

  const showPrimaryBtn = screen.getByRole("button", { name: "Show Primary Stripe webhook signing secret" });
  expect(showPrimaryBtn).toHaveAttribute("aria-pressed", "false");
  await user.click(showPrimaryBtn);
  expect(primaryWhInput).toHaveAttribute("type", "text");
  const hidePrimaryBtn = screen.getByRole("button", { name: "Hide Primary Stripe webhook signing secret" });
  expect(hidePrimaryBtn).toHaveAttribute("aria-pressed", "true");
  await user.click(hidePrimaryBtn);
  expect(primaryWhInput).toHaveAttribute("type", "password");

  // Wrong-key shapes: publishable key in API field + API key in webhook field -> per-field inline errors, focus moves to first invalid field, secret content never echoed
  const fakePubFragment = "PublishableNeverEcho9911";
  const fakeSkFragment = "SecretNeverEcho8822";
  await user.type(apiKeyInput, `pk_live_fake_${fakePubFragment}`);
  await user.type(primaryWhInput, `sk_live_fake_${fakeSkFragment}`);
  await user.click(screen.getByRole("button", { name: "Stage Stripe credentials" }));

  expect(mocks.updateSettings).not.toHaveBeenCalled();
  expect(apiKeyInput).toHaveAttribute("aria-invalid", "true");
  expect(primaryWhInput).toHaveAttribute("aria-invalid", "true");
  expect(document.activeElement).toBe(apiKeyInput);
  expect(screen.getAllByText(/publishable key \(pk_…\)/u).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/This looks like a Stripe API key \(sk_… \/ rk_…\)/u).length).toBeGreaterThan(0);
  expect(container.textContent).not.toContain(fakePubFragment);
  expect(container.textContent).not.toContain(fakeSkFragment);

  // Endpoint ID in Primary webhook field
  await user.clear(apiKeyInput);
  await user.clear(primaryWhInput);
  await user.type(primaryWhInput, "we_1FakeEndpointIdentifier7733");
  await user.click(screen.getByRole("button", { name: "Stage Stripe credentials" }));
  expect(document.activeElement).toBe(primaryWhInput);
  expect(screen.getAllByText(/webhook endpoint ID \(we_…\)/u).length).toBeGreaterThan(0);
  expect(container.textContent).not.toContain("Identifier7733");

  // Secondary-only rollover pre-save explanation callout when Primary is blank and already saved
  await user.clear(primaryWhInput);
  await user.type(secondaryWhInput, "whsec_fake_rollover_candidate_secret_5566");
  expect(
    await screen.findByText(/Saving Secondary keeps your existing Primary signing secret/u),
  ).toBeInTheDocument();

  // Quoted + wrapped Primary signing secret normalizes cleanly on save and shows post-save self-test + Stripe test-event reminder
  await user.clear(secondaryWhInput);
  await user.type(primaryWhInput, '  "whsec_live_fake_normalized_secret_4455"  ');
  await user.click(screen.getByRole("button", { name: "Stage Stripe credentials" }));
  expect(mocks.updateSettings).toHaveBeenCalledWith(
    expect.objectContaining({
      stripeWebhookSecret: "whsec_live_fake_normalized_secret_4455",
    }),
  );
  expect(
    await screen.findByText(/Re-run webhook verification after changing a signing secret/u),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/portal self-test only proves ReadyPackets' local signature check/u),
  ).toBeInTheDocument();
});

it("Fix Pack 07.2 Problem B (PaymentSettings) — validates inline per field, focuses first invalid input, and displays post-save webhook reminder", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue(undefined);
  const { container } = renderUi(
    <PaymentSettings
      settings={{
        ...defaultConfig,
        provider: "stripe",
        mode: "live",
        stripe: {
          ...defaultConfig.stripe,
          egressAllowlisted: true,
          secretKeyConfigured: true,
          secretKeyLast4: "4242",
          webhookSecretConfigured: true,
          webhookSecretLast4: "9876",
          ready: true,
        },
      }}
      saving={false}
      onSave={onSave}
    />,
  );

  const primaryWh = screen.getByLabelText(/^Primary Stripe webhook signing secret/u);
  await user.type(primaryWh, "sk_live_fake_wrong_slot_secret_31415");
  await user.click(screen.getByRole("button", { name: "Save payment settings" }));

  expect(onSave).not.toHaveBeenCalled();
  expect(primaryWh).toHaveAttribute("aria-invalid", "true");
  expect(document.activeElement).toBe(primaryWh);
  expect(container.textContent).not.toContain("31415");

  await user.clear(primaryWh);
  await user.type(primaryWh, " `whsec_live_fake_updated_primary_secret_27182` ");
  await user.click(screen.getByRole("button", { name: "Save payment settings" }));

  // Live Stripe confirmation dialog requires ACTIVATE LIVE PAYMENTS when provider=stripe & mode=live
  const liveDialogInput = screen.queryByLabelText(/Type ACTIVATE LIVE PAYMENTS/i);
  if (liveDialogInput) {
    await user.type(liveDialogInput, "ACTIVATE LIVE PAYMENTS");
    await user.click(screen.getByRole("button", { name: /Save live payment settings|Activate/i }));
  }

  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      stripeWebhookSecret: "whsec_live_fake_updated_primary_secret_27182",
    }),
  );
  expect(
    await screen.findByText(/Re-verify your Stripe webhook signing secret/u),
  ).toBeInTheDocument();
});

it("Fix Pack 07.2 follow-up — gates new Stripe activation on Verify Checkout session creation while keeping upgraded already-active setups ACTIVE with recommended probe copy", async () => {
  const user = userEvent.setup();
  mocks.egressPresets.mockResolvedValue([
    { key: "stripe", label: "Stripe API", enabled: true, parameterized: false },
  ]);

  // 1. New activation (provider === "none") without probe keeps Activate disabled until probe succeeds
  mocks.getSettings.mockResolvedValue({
    ...defaultConfig,
    provider: "none",
    mode: "test",
    onlineEnabled: false,
    stripe: {
      ...defaultConfig.stripe,
      egressAllowlisted: true,
      secretKeyConfigured: true,
      secretKeyLast4: "4242",
      webhookSecretConfigured: true,
      webhookSecretLast4: "9876",
      lastApiVerifiedAt: "2026-11-21T12:05:00.000Z",
      lastSelfTestWebhookAt: "2026-11-21T12:06:00.000Z",
      checkoutSessionVerified: false,
      lastCheckoutProbe: null,
    },
  });

  const newSetupView = renderSetupPage();
  const activateBtn = await screen.findByRole("button", { name: "Activate Stripe Checkout" });
  expect(activateBtn).toBeDisabled();
  expect(
    screen.getByText(/Checkout session creation has not been verified for the current API key and mode/u),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Required before activating Stripe Checkout: creates an unpaid Checkout Session/u),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Verify Checkout session creation" }));
  expect(mocks.verifyCheckoutSession).toHaveBeenCalledWith({ provider: "stripe" });
  expect(activateBtn).toBeEnabled();
  newSetupView.unmount();

  // 2. Upgraded already-active setup (provider === "stripe", onlineEnabled === true, no probe on record) stays ACTIVE and marks probe as recommended (never paused)
  mocks.getSettings.mockResolvedValue({
    ...defaultConfig,
    provider: "stripe",
    mode: "live",
    onlineEnabled: true,
    stripe: {
      ...defaultConfig.stripe,
      egressAllowlisted: true,
      secretKeyConfigured: true,
      secretKeyLast4: "4242",
      webhookSecretConfigured: true,
      webhookSecretLast4: "9876",
      lastApiVerifiedAt: "2026-11-21T12:05:00.000Z",
      lastSelfTestWebhookAt: "2026-11-21T12:06:00.000Z",
      checkoutSessionVerified: false,
      lastCheckoutProbe: null,
      statusHeadline: "Online card checkout: ACTIVE (live)",
      customerExperienceSummary:
        "Customers are sent to Stripe Checkout (live) when placing an order or clicking Pay now.",
      missingGates: [],
    },
  });

  renderSetupPage();
  expect(await screen.findByText("Online card checkout: ACTIVE (live)")).toBeInTheDocument();
  expect(screen.queryByText(/paused pending verification/iu)).not.toBeInTheDocument();
  expect(
    screen.getAllByText(/Recommended check \(online card checkout remains active\)/u).length,
  ).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText("Optional")).not.toBeInTheDocument();
});

pageA11y("/admin/payments/setup Fix Pack 07.2 diagnostics, banners, and secret toggles", async () => {
  mocks.egressPresets.mockResolvedValue([
    { key: "stripe", label: "Stripe API", enabled: true, parameterized: false },
  ]);
  mocks.getSettings.mockResolvedValue({
    ...defaultConfig,
    provider: "stripe",
    mode: "live",
    onlineEnabled: false,
    stripe: {
      ...defaultConfig.stripe,
      egressAllowlisted: true,
      secretKeyConfigured: true,
      secretKeyLast4: "4242",
      webhookSecretConfigured: true,
      webhookSecretLast4: "9876",
      reverificationNeeded: true,
      reverificationReasons: [
        "Primary signing secret changed after the last self-test; re-run Send self-test webhook.",
      ],
      lastCheckoutFailure: {
        occurredAt: "2026-11-21T12:15:00.000Z",
        provider: "stripe",
        mode: "live",
        reasonCode: "STRIPE_KEY_MISSING_PERMISSION",
        failureClass: "provider_permission",
        upstreamStatus: 403,
        stripeErrorType: "invalid_request_error",
        stripeErrorCode: "permission_denied",
        stripeErrorParam: "line_items",
        invoicePublicId: invoiceId,
        attemptPublicId: id,
      },
    },
  });
  renderSetupPage();
  await screen.findByRole("heading", { name: "Stripe setup" });
  await screen.findByText("Last checkout-session failure");
});

