import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type * as trpc from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import { PaymentSettings, type PaymentSettingsInput, type PaymentSettingsView } from "./PaymentSettings";
import PaymentsPage from "./PaymentsPage";

const id = `01J${"0".repeat(22)}1`;
const invoiceId = `01J${"0".repeat(22)}2`;
const date = new Date("2026-11-21T12:00:00Z");
const config: PaymentSettingsView = {
  provider: "square", mode: "test", currency: "USD", successPath: "/checkout/return", cancelPath: "/checkout/cancel",
  webhookToleranceSeconds: 300,
  stripe: {
    secretKeyConfigured: false, secretKeyLast4: null, webhookSecretConfigured: false, webhookSecretLast4: null,
    webhookUrl: "https://portal.example.test/api/payments/webhooks/stripe",
    returnUrlPattern: "https://portal.example.test/api/payments/return/stripe/<attemptId>",
    egressHost: "api.stripe.com", egressAllowlisted: false,
  },
  square: {
    locationId: "LOCATION_01", accessTokenConfigured: true, accessTokenLast4: "a1b2",
    webhookSignatureKeyConfigured: true, webhookSignatureKeyLast4: "c3d4",
    webhookUrl: "https://portal.example.test/api/payments/webhooks/square",
    returnUrlPattern: "https://portal.example.test/api/payments/return/square/<attemptId>",
    egressHost: "connect.squareupsandbox.com", egressAllowlisted: true,
  },
  onlineEnabled: true,
};
const attempt = {
  attemptPublicId: id, invoicePublicId: invoiceId, provider: "square", environment: "test", status: "redirected",
  amountMinor: 1299, currency: "USD", createdAt: date, failureReasonCode: null,
};
const receipt = { webhookPublicId: id, provider: "square", environment: "test", status: "retry_pending", eventType: "payment.updated",
  receivedAt: date, reasonCode: "SYNTHETIC_PENDING" };

vi.mock("@/lib/trpc", async (original) => ({
  ...await original<typeof trpc>(),
  useTRPCClient: () => ({ payments: { admin: { updateSettings: { mutate: async () => config } } } }),
  useTRPC: () => {
    const query = (key: string, value: unknown) => ({
      queryOptions: (input?: unknown) => ({ queryKey: ["payments", key, input], queryFn: async () => value }),
      infiniteQueryOptions: (input: unknown, options: object) => ({
        queryKey: ["payments", key, input], queryFn: async () => ({ items: value, nextCursor: null }),
        initialPageParam: null, ...options,
      }),
    });
    return { payments: { admin: {
      getSettings: query("config", config), getAttempt: query("details", { attempt, webhooks: [receipt] }),
      listAttempts: query("attempts", [attempt]), listWebhooks: query("receipts", [receipt]), pathKey: () => ["payments"],
      reconcileNow: { mutationOptions: () => ({ mutationFn: async () => ({ scanned: 1, booked: 0, stillPending: 1 }) }) },
    } } };
  },
}));

function renderPage() {
  return renderUi(<main><title>Payments · ReadyPackets</title><PaymentsPage /></main>, { path: "/admin/payments" });
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

it("keeps stored keys out of inputs and submits only replacement secrets for the same environment", async () => {
  const user = userEvent.setup();
  const save = vi.fn<(input: PaymentSettingsInput) => Promise<void>>().mockResolvedValue(undefined);
  renderUi(<PaymentSettings settings={config} saving={false} onSave={save} />);
  expect(screen.getByLabelText("Square access token")).toHaveValue("");
  expect(screen.getByLabelText("Square webhook signature key")).toHaveValue("");
  await user.type(screen.getByLabelText("Square access token"), "synthetic_new_square_token");
  await user.click(screen.getByRole("button", { name: "Save payment settings" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ provider: "square", mode: "test", squareAccessToken: "synthetic_new_square_token" }));
  expect(save.mock.calls[0]?.[0]).not.toHaveProperty("squareWebhookSignatureKey");
  expect(screen.getByLabelText("Square access token")).toHaveValue("");
});

it("requires fresh credentials for switching environments and confirms live activation", async () => {
  const user = userEvent.setup();
  const save = vi.fn<(input: PaymentSettingsInput) => Promise<void>>().mockResolvedValue(undefined);
  renderUi(<PaymentSettings settings={config} saving={false} onSave={save} />);
  await user.selectOptions(screen.getByRole("combobox", { name: /^Environment/u }), "live");
  expect(screen.getByText("connect.squareup.com")).toBeInTheDocument();
  expect(screen.getByText(/verify the rule for this environment/i)).toBeInTheDocument();
  await user.type(screen.getByLabelText(/^Square access token/u), "synthetic_live_square_token");
  await user.click(screen.getByRole("button", { name: "Save payment settings" }));
  expect(await screen.findByText("Enter both credentials for the selected provider and environment before activating it.")).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText(/^Square webhook signature key/u), "synthetic_live_square_signing_key");
  await user.click(screen.getByRole("button", { name: "Save payment settings" }));
  expect(screen.getByRole("alertdialog", { name: "Enable live payments?" })).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Enable live payments" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ provider: "square", mode: "live", squareAccessToken: "synthetic_live_square_token",
    squareWebhookSignatureKey: "synthetic_live_square_signing_key" }));
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
        ...config,
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
