import { useQuery } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { ComponentProps } from "react";
import superjson from "superjson";
import { expect, it, vi } from "vitest";
import type { AppRouter } from "@server/trpc/root";
import { formatMinorToDecimalInput, parseDecimalToMinor } from "@/lib/moneyInput";
import { TRPCProvider, useTRPC } from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { StepUpCancelledError } from "@/ui";
import { createTestQueryClient, renderUi } from "@/ui/testing";
import OrderRefundTab, { OrderRefundPanel } from "./OrderRefundTab";

type Props = ComponentProps<typeof OrderRefundPanel>;
const payment: Props["payments"][number] = {
  paymentPublicId: "example-payment", invoiceNumber: "INV-EXAMPLE", provider: "square", executionKind: "provider_refund",
  capturedMinor: 2000, refundedMinor: 200, refundableMinor: 1600, reservedPendingOrUnknownMinor: 200, currency: "USD", refunds: [{
    refundPublicId: "example-refund", status: "succeeded", executionKind: "provider_refund", amountMinor: 200,
    currency: "USD", createdAt: "2026-11-21T12:00:00Z", reason: null,
  }],
};
const panel = (overrides: Partial<Props> = {}) => renderUi(<main><title>Order refunds · ReadyPackets</title><h1>Order refunds</h1>
  <OrderRefundPanel payments={[payment]} canIssueRefund submit={vi.fn<Props["submit"]>()} {...overrides} />
</main>);
const paymentsTable = () => within(screen.getByRole("region", { name: "Order payments table" }));
const refundsTable = () => within(screen.getByRole("region", { name: "Order refunds table" }));

async function open() {
  await userEvent.click(paymentsTable().getByRole("button", { name: /prepare refund for square payment/i }));
  return screen.findByRole("alertdialog", { name: "Prepare refund" });
}

pageA11y("Refund balances and read-only history", () => { panel({ canIssueRefund: false }); });
pageA11y("Prepare refund dialog", async () => { panel(); await open(); });

it("uses exact currency exponents and rejects unsupported fractional and nonpositive values", () => {
  expect(parseDecimalToMinor("625.00", false)).toBe(62500);
  expect(parseDecimalToMinor("625", false, "JPY")).toBe(625);
  expect(parseDecimalToMinor("625.0", false, "JPY")).toBeNull();
  expect(parseDecimalToMinor("6.251", false, "KWD")).toBe(6251);
  expect(formatMinorToDecimalInput(6251, "KWD")).toBe("6.251");
  expect(formatMinorToDecimalInput(625, "JPY")).toBe("625");
  for (const amount of ["1.500", "-1.50", "0.00", "1e2", "90071992547409.92"]) {
    expect(parseDecimalToMinor(amount, false, "USD")).toBeNull();
  }
});

it("shows history and balances but no action for staff without refund permission", () => {
  panel({ canIssueRefund: false });
  expect(screen.getByText("Read-only refund history")).toBeVisible();
  expect(refundsTable().getByText("example-refund")).toBeVisible();
  expect(refundsTable().getByText("Succeeded")).toBeVisible();
  expect(screen.queryByRole("button", { name: /prepare|record refund/i })).not.toBeInTheDocument();
});

it("focuses Cancel on open and restores the actual row launcher when Escape cancels", async () => {
  const submit = vi.fn<Props["submit"]>();
  panel({ submit });
  const launcher = paymentsTable().getByRole("button", { name: /prepare refund for square payment/i });
  launcher.focus();
  await userEvent.keyboard("{Enter}");
  const dialog = await screen.findByRole("alertdialog", { name: "Prepare refund" });
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(launcher).toHaveFocus());
  expect(dialog).not.toBeInTheDocument();
  expect(submit).not.toHaveBeenCalled();
});

it("requires the exact phrase and prevents another attempt after an unknown result", async () => {
  const submit = vi.fn<Props["submit"]>().mockResolvedValue({ status: "unknown", executionKind: "provider_refund" });
  panel({ submit, payments: [{ ...payment, capturedMinor: 263000, refundableMinor: 262500 }] });
  const dialog = within(await open());
  const confirm = dialog.getByRole("button", { name: "Send refund" });
  expect(confirm).toBeDisabled();
  const amount = dialog.getByLabelText(/^Amount \(USD\)/u);
  expect(amount).toHaveValue("2625.00");
  expect(amount).toHaveAccessibleDescription("Up to $2,625.00");
  await userEvent.clear(amount);
  await userEvent.type(amount, "1.50");
  await userEvent.type(dialog.getByLabelText(/Refund reason/u), "Customer request");
  await userEvent.click(dialog.getByRole("checkbox", { name: "Email the customer when the refund is confirmed" }));
  const phrase = dialog.getByLabelText(/type REFUND ORDER to confirm/i);
  await userEvent.type(phrase, "refund order");
  expect(confirm).toBeDisabled();
  await userEvent.clear(phrase);
  await userEvent.type(phrase, "REFUND ORDER");
  await userEvent.click(confirm);
  expect(await screen.findByText("Outcome unknown")).toBeVisible();
  expect(screen.getByText(/Do not send another refund/u)).toBeVisible();
  expect(screen.queryByRole("button", { name: /prepare refund for square payment/i })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("group", { name: "Refund result: Outcome unknown" })).toHaveFocus());
  expect(submit).toHaveBeenCalledExactlyOnceWith({
    paymentPublicId: payment.paymentPublicId, amountMinor: 150, currency: "USD", reason: "Customer request",
    confirmationPhrase: "REFUND ORDER", sendCustomerNotice: true, idempotencyKey: expect.stringMatching(/^order-refund:/u),
  });
});

it("keeps the form open and preserves the idempotency key when step-up is cancelled", async () => {
  const submit = vi.fn<Props["submit"]>().mockRejectedValueOnce(new StepUpCancelledError())
    .mockResolvedValueOnce({ status: "pending", executionKind: "provider_refund" });
  panel({ submit });
  const dialog = within(await open());
  await userEvent.click(dialog.getByRole("button", { name: "Use full refundable balance" }));
  await userEvent.type(dialog.getByLabelText(/Refund reason/u), "Duplicate");
  await userEvent.type(dialog.getByLabelText(/type REFUND ORDER to confirm/i), "REFUND ORDER");
  const confirm = dialog.getByRole("button", { name: "Send refund" });
  await userEvent.click(confirm);
  expect(await dialog.findByText(/Verification was cancelled/u)).toBeVisible();
  await userEvent.click(confirm);
  expect(await screen.findByText("Pending")).toBeVisible();
  expect(submit.mock.calls[0]?.[0].idempotencyKey).toBe(submit.mock.calls[1]?.[0].idempotencyKey);
});

it("shows a definitive server balance refusal without treating it as an unknown refund", async () => {
  const submit = vi.fn<Props["submit"]>().mockRejectedValueOnce({
    data: { safe: { domainCode: "CONFLICT", reasonCode: "REFUND_EXCEEDS_REFUNDABLE",
      safeMessage: "The remaining refundable balance changed." } },
  });
  panel({ submit });
  const dialog = within(await open());
  await userEvent.click(dialog.getByRole("button", { name: "Use full refundable balance" }));
  await userEvent.type(dialog.getByLabelText(/Refund reason/u), "Customer request");
  await userEvent.type(dialog.getByLabelText(/type REFUND ORDER to confirm/i), "REFUND ORDER");
  await userEvent.click(dialog.getByRole("button", { name: "Send refund" }));
  expect(await dialog.findByText("The remaining refundable balance changed.")).toBeVisible();
  expect(screen.queryByText("Outcome unknown")).not.toBeInTheDocument();
});

it("labels manual refunds as recorded only and prevents submitting more than the refundable balance", async () => {
  const submit = vi.fn<Props["submit"]>().mockResolvedValue({ status: "succeeded", executionKind: "recorded_only" });
  panel({ submit, payments: [{ ...payment, provider: "manual", executionKind: "recorded_only", refunds: [] }] });
  await userEvent.click(paymentsTable().getByRole("button", { name: /record refund for manual payment/i }));
  const dialog = within(await screen.findByRole("alertdialog", { name: "Record refund" }));
  expect(dialog.getByText("No money is moved by the portal.")).toBeVisible();
  const amount = dialog.getByLabelText(/^Amount \(USD\)/u);
  await userEvent.clear(amount);
  await userEvent.type(amount, "16.01");
  await userEvent.type(dialog.getByLabelText(/Refund reason/u), "Refunded offline");
  await userEvent.type(dialog.getByLabelText(/type REFUND ORDER to confirm/i), "REFUND ORDER");
  const confirm = dialog.getByRole("button", { name: "Record refund" });
  await userEvent.click(confirm);
  expect(await dialog.findByText(/no higher than the refundable balance/u)).toBeVisible();
  expect(submit).not.toHaveBeenCalled();
  await userEvent.click(dialog.getByRole("button", { name: "Use full refundable balance" }));
  expect(amount).toHaveValue("16.00");
  await userEvent.click(confirm);
  expect(await screen.findByText("No money was moved by the portal.")).toBeVisible();
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 1600 }));
});

it("refreshes the active payment badge and invalidates cached history and invoices for only the refunded order", async () => {
  const orderId = "01JD0000000000000000000001";
  const otherId = "01JD0000000000000000000002";
  const queryClient = createTestQueryClient();
  queryClient.setQueryDefaults([], { gcTime: Infinity });
  let refunded = false;
  const client = createTRPCClient<AppRouter>({
    links: [httpLink({
      url: "https://portal.example.test/rpc", transformer: superjson,
      fetch: async (request) => {
        const path = new URL(String(request)).pathname.slice("/rpc/".length);
        let data: unknown;
        if (path === "orders.admin.get") data = { console: { payment: { state: refunded ? "partially_refunded" : "paid" } } };
        else if (path === "payments.refunds.forOrder") data = { canIssueRefund: true, payments: [payment] };
        else if (path === "payments.refunds.create") {
          refunded = true;
          data = { status: "succeeded", executionKind: "provider_refund" };
        } else throw new Error(`Unexpected synthetic request: ${path}`);
        return Response.json({ result: { data: superjson.serialize(data) } });
      },
    })],
  });
  const keys = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
  const activeOrderKeys = [
    keys.audit.orderActivity.infiniteQueryKey({ orderPublicId: orderId, limit: 25 }),
    keys.audit.orderActivity.infiniteQueryKey({ orderPublicId: orderId, limit: 25, category: "payments" }),
    keys.audit.orderStatusHistory.infiniteQueryKey({ orderPublicId: orderId, limit: 25 }),
    keys.compliance.invoices.listForOrder.queryKey({ orderPublicId: orderId }),
  ];
  const unrelatedKey = keys.audit.orderActivity.infiniteQueryKey({ orderPublicId: otherId, limit: 25, category: "payments" });
  for (const key of [...activeOrderKeys, unrelatedKey]) queryClient.setQueryData([...key], {});

  function HeaderState() {
    const trpc = useTRPC();
    const detail = useQuery(trpc.orders.admin.get.queryOptions({ orderId }));
    return <p>Header payment state: {detail.data?.console?.payment?.state}</p>;
  }
  renderUi(<main><HeaderState /><OrderRefundTab orderId={orderId} area="console" /></main>, {
    queryClient, wrapper: (tree) => <TRPCProvider trpcClient={client} queryClient={queryClient}>{tree}</TRPCProvider>,
  });
  expect(await screen.findByText("Header payment state: paid")).toBeVisible();
  await screen.findByRole("region", { name: "Order payments table" });
  const dialog = within(await open());
  await userEvent.type(dialog.getByLabelText(/Refund reason/u), "Customer request");
  await userEvent.type(dialog.getByLabelText(/type REFUND ORDER to confirm/i), "REFUND ORDER");
  await userEvent.click(dialog.getByRole("button", { name: "Send refund" }));
  expect(await screen.findByText("Header payment state: partially_refunded")).toBeVisible();
  for (const key of activeOrderKeys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
});
