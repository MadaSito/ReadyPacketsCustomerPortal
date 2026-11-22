import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vitest";
import { pageA11y } from "@/test/a11y";
import { StepUpCancelledError } from "@/ui";
import { renderUi } from "@/ui/testing";
import { OrderRefundPanel } from "./OrderRefundTab";

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
  panel({ submit });
  const dialog = within(await open());
  const confirm = dialog.getByRole("button", { name: "Send refund" });
  expect(confirm).toBeDisabled();
  await userEvent.type(dialog.getByLabelText(/Amount \(USD minor units\)/u), "150");
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
  await userEvent.type(dialog.getByLabelText(/Amount \(USD minor units\)/u), "1601");
  await userEvent.type(dialog.getByLabelText(/Refund reason/u), "Refunded offline");
  await userEvent.type(dialog.getByLabelText(/type REFUND ORDER to confirm/i), "REFUND ORDER");
  const confirm = dialog.getByRole("button", { name: "Record refund" });
  await userEvent.click(confirm);
  expect(await dialog.findByText(/no higher than the refundable balance/u)).toBeVisible();
  expect(submit).not.toHaveBeenCalled();
  await userEvent.click(dialog.getByRole("button", { name: "Use full refundable balance" }));
  await userEvent.click(confirm);
  expect(await screen.findByText("No money was moved by the portal.")).toBeVisible();
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 1600 }));
});
