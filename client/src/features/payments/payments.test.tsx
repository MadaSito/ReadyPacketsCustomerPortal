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
  reasonCode: "invalid_signature" as const,
  httpStatus: 400,
  detail: "Stripe-Signature header did not match primary or secondary signing secret.",
  receivedAt: date,
};

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  testConnection: vi.fn(),
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

  // Rejections table renders safe reason codes
  expect(
    (await screen.findAllByText("Stripe-Signature header did not match primary or secondary signing secret.")).length,
  ).toBeGreaterThan(0);
});
