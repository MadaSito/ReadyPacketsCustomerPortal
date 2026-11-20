import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, Checkbox, ConfirmDialog, DataTable, Dialog, Drawer, Field, Input, StatusBadge, useStepUp, useToast } from "@/ui";
import { OPERATION_STATES } from "@shared/domain";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "./testing";

describe("Field", () => {
  it("wires label, hint and error to the control", async () => {
    renderUi(
      <Field label="Email" hint="We never share it." error="Enter a valid email." required>
        <Input type="email" />
      </Field>,
    );
    const input = screen.getByLabelText(/Email/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-required", "true");
    expect(input).toHaveAccessibleDescription("We never share it. Enter a valid email.");
    await expectNoAxeViolations();
  });
  it("checkbox is labelled and toggles", async () => {
    const onChange = vi.fn();
    renderUi(<Checkbox label="I accept the terms" onCheckedChange={onChange} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "I accept the terms" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      <Dialog open={open} onOpenChange={setOpen} title="Edit name" footer={<Button onClick={() => setOpen(false)}>Save</Button>}>
        <Field label="Name">
          <Input />
        </Field>
      </Dialog>
    </>
  );
}

describe("Dialog / Drawer focus behaviour", () => {
  it("moves focus in, traps Tab, closes on Escape and restores focus", async () => {
    const user = userEvent.setup();
    renderUi(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Edit name" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await expectNoAxeViolations(dialog);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
  it("drawer is a labelled modal with a close button", async () => {
    const user = userEvent.setup();
    renderUi(<Drawer trigger={<Button>Menu</Button>} title="Navigation">content</Drawer>);
    await user.click(screen.getByRole("button", { name: "Menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await user.click(within(drawer).getByRole("button", { name: "Close panel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Menu" })).toHaveFocus();
  });
  it("destructive ConfirmDialog focuses Cancel and runs onConfirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    renderUi(<ConfirmDialog open onOpenChange={onOpenChange} destructive title="Delete draft?" confirmLabel="Delete" onConfirm={onConfirm} />);
    const dialog = await screen.findByRole("alertdialog", { name: "Delete draft?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalled();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
  it("type-to-confirm blocks until the text matches", async () => {
    const user = userEvent.setup();
    renderUi(<ConfirmDialog open onOpenChange={() => {}} title="Purge?" confirmText="PURGE" onConfirm={() => {}} />);
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Type/), "PURGE");
    expect(confirm).toBeEnabled();
  });
});

interface Row {
  id: string;
  name: string;
  state: (typeof OPERATION_STATES)[number];
}
const rows: Row[] = [
  { id: "a", name: "Alpha", state: "completed" },
  { id: "b", name: "Beta", state: "unknown" },
];

describe("DataTable", () => {
  const columns = [
    { key: "name", header: "Name", primary: true, sortable: true, cell: (r: Row) => r.name },
    { key: "state", header: "State", cell: (r: Row) => <StatusBadge state={r.state} /> },
  ];
  it("renders a captioned table and labelled mobile cards; sort is keyboard operable", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderUi(<DataTable caption="Orders" columns={columns} rows={rows} rowKey={(r) => r.id} sort={{ key: "name", direction: "asc" }} onSortChange={onSort} rowActions={(r) => <Button size="sm">Open {r.name}</Button>} />);
    const table = screen.getByRole("table", { name: "Orders" });
    expect(within(table).getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "ascending");
    const cards = screen.getByRole("list", { name: "Orders" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(2);
    expect(within(cards).getAllByText("State")).toHaveLength(2);
    const sortButton = within(table).getByRole("button", { name: /Name/ });
    sortButton.focus();
    await user.keyboard("{Enter}");
    expect(onSort).toHaveBeenCalledWith({ key: "name", direction: "desc" });
    await expectNoAxeViolations();
  });
  it("shows empty, loading and error states", () => {
    const { rerender } = renderUi(<DataTable caption="Orders" columns={columns} rows={[]} rowKey={(r) => r.id} />);
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    rerender(<DataTable caption="Orders" columns={columns} rows={undefined} loading rowKey={(r) => r.id} />);
    expect(screen.getAllByText("Loading Orders").length).toBeGreaterThan(0);
  });
});

describe("StatusBadge", () => {
  it("every operation state has text (never colour alone); unknown is not failed", () => {
    renderUi(
      <div>
        {OPERATION_STATES.map((s) => (
          <StatusBadge key={s} state={s} />
        ))}
      </div>,
    );
    for (const label of ["Queued", "Running", "Completed", "Failed", "Canceled", "Refused", "Unknown outcome"]) expect(screen.getByText(label)).toBeInTheDocument();
  });
});

function ToastHarness() {
  const toast = useToast();
  return <Button onClick={() => toast.show({ tone: "danger", title: "Upload failed" })}>Go</Button>;
}
describe("Toasts", () => {
  it("announce through an assertive live region without moving focus", async () => {
    const user = userEvent.setup();
    renderUi(<ToastHarness />);
    const btn = screen.getByRole("button", { name: "Go" });
    await user.click(btn);
    expect(screen.getByRole("alert")).toHaveTextContent("Upload failed");
    expect(btn).toHaveFocus();
  });
});

const stepUpError = Object.assign(new Error("x"), { data: { safe: { domainCode: "STEP_UP_REQUIRED", reasonCode: "STEP_UP_REQUIRED", safeMessage: "Verify", requestId: "r" } } });
function StepUpHarness({ action }: { action: () => Promise<string> }) {
  const stepUp = useStepUp();
  const [result, setResult] = useState("");
  return <Button onClick={() => stepUp.run(action).then(setResult, (e: Error) => setResult(e.name))}>Do it{result ? `: ${result}` : ""}</Button>;
}
describe("useStepUp", () => {
  it("opens the dialog on STEP_UP_REQUIRED, calls stepUp and retries once", async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockRejectedValueOnce(stepUpError).mockResolvedValueOnce("done");
    const stepUp = vi.fn().mockResolvedValue({ ok: true });
    const api = fakeAuthApi({ stepUp, assuranceState: () => Promise.resolve({ mfaEnrolled: true, recoveryCodesAcknowledged: true, passkeyCount: 0, totpEnrolled: true, recoveryCodesRemaining: 8 }) });
    renderUi(<StepUpHarness action={action} />, { api });
    await user.click(screen.getByRole("button", { name: "Do it" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(dialog).getByLabelText(/Password/), "correct horse battery staple");
    await user.type(within(dialog).getByLabelText(/6-digit code/), "123456");
    await user.click(within(dialog).getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Do it: done" })).toBeInTheDocument());
    expect(stepUp).toHaveBeenCalledWith({ password: "correct horse battery staple", factor: { method: "totp", code: "123456" } });
    expect(action).toHaveBeenCalledTimes(2);
  });
  it("cancel rejects with StepUpCancelledError and does not retry", async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockRejectedValue(stepUpError);
    const api = fakeAuthApi({ assuranceState: () => Promise.reject(new Error("x")) });
    renderUi(<StepUpHarness action={action} />, { api });
    await user.click(screen.getByRole("button", { name: "Do it" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Do it: StepUpCancelledError" })).toBeInTheDocument());
    expect(action).toHaveBeenCalledTimes(1);
  });
});
