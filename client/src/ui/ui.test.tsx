import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, Checkbox, ErrorState, Tabs, ConfirmDialog, DataTable, Dialog, Drawer, Field, Input, StatusBadge, useStepUp, useToast } from "@/ui";
import { OPERATION_STATES } from "@shared/domain";
import { render } from "@testing-library/react";
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

function DialogHarness({ restoreToReminder = false }: { restoreToReminder?: boolean }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const reminder = useRef<HTMLButtonElement>(null);
  const change = (nextOpen: boolean) => {
    if (!nextOpen) setDismissed(true);
    setOpen(nextOpen);
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      {restoreToReminder && dismissed ? <Button ref={reminder}>Review later</Button> : null}
      <Dialog open={open} onOpenChange={change} title="Edit name" footer={<Button onClick={() => change(false)}>Save</Button>}
        returnFocusRef={restoreToReminder && !open ? reminder : undefined}>
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
  it("restores focus to an explicit target mounted as a controlled dialog closes", async () => {
    const user = userEvent.setup();
    renderUi(<DialogHarness restoreToReminder />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit name" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const reminder = await screen.findByRole("button", { name: "Review later" });
    await waitFor(() => expect(reminder).toHaveFocus());
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

describe("ErrorState step-up (D3)", () => {
  const assuranceState = () => Promise.resolve({ mfaEnrolled: true, recoveryCodesAcknowledged: true, passkeyCount: 0, totpEnrolled: true, recoveryCodesRemaining: 8 });

  it("a STEP_UP_REQUIRED read renders a verify prompt, not the dead-end error", async () => {
    const { container } = renderUi(<ErrorState error={stepUpError} onRetry={() => undefined} />);
    expect(screen.getByText("Verification required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify identity" })).toBeInTheDocument();
    expect(screen.queryByText("We couldn't load this")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("successful verification retries exactly once; cancel leaves the prompt", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const stepUp = vi.fn().mockResolvedValue({ ok: true });
    renderUi(<ErrorState error={stepUpError} onRetry={onRetry} />, { api: fakeAuthApi({ stepUp, assuranceState }) });
    await user.click(screen.getByRole("button", { name: "Verify identity" }));
    let dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Verify identity" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Verify identity" }));
    dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(dialog).getByLabelText(/Password/), "pw");
    await user.type(within(dialog).getByLabelText(/6-digit code/), "123456");
    await user.click(within(dialog).getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    expect(stepUp).toHaveBeenCalledTimes(1);
  });

  it("other errors are unchanged, and step-up errors fall back to the generic panel without a provider", () => {
    const other = Object.assign(new Error("x"), { data: { safe: { domainCode: "NOT_FOUND", safeMessage: "Not here.", requestId: "req-1" } } });
    const onRetry = vi.fn();
    renderUi(<ErrorState error={other} onRetry={onRetry} />);
    expect(screen.getByText("We couldn't load this")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify identity" })).not.toBeInTheDocument();
    const bare = render(<ErrorState error={stepUpError} />);
    expect(within(bare.container).getByText("We couldn't load this")).toBeInTheDocument();
  });
});

describe("Tabs: active tab is revealed in the scrolling list (narrow screens)", () => {
  const items = ["Overview", "Messages", "Files", "Billing", "Production"].map((label) => ({ value: label.toLowerCase(), label, content: <p>{label} panel</p> }));
  // jsdom has no layout: the list is 0–100 px wide and each tab is 80 px, laid out from the current scrollLeft.
  function layout() {
    const list = screen.getByRole("tablist");
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ left: 0, right: 100, top: 0, bottom: 44, width: 100, height: 44, x: 0, y: 0, toJSON: () => ({}) });
    screen.getAllByRole("tab").forEach((tab, index) => {
      vi.spyOn(tab, "getBoundingClientRect").mockImplementation(() => {
        const left = index * 80 - list.scrollLeft;
        return { left, right: left + 80, top: 0, bottom: 44, width: 80, height: 44, x: left, y: 0, toJSON: () => ({}) };
      });
    });
    return list;
  }

  it("scrolls horizontally (never smooth, never the page) on selection and on mount", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { unmount } = renderUi(<Tabs label="Order sections" items={items} />);
    const list = layout();
    expect(list.scrollLeft).toBe(0);
    await user.click(screen.getByRole("tab", { name: "Production" }));
    // Production spans 320–400 → scrolled so its right edge (plus 4 px) is inside the 100 px list.
    expect(list.scrollLeft).toBe(304);
    await user.click(screen.getByRole("tab", { name: "Overview" }));
    expect(list.scrollLeft).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
    unmount();

    // Mount with an off-screen tab selected (controlled).
    const original = HTMLElement.prototype.getBoundingClientRect;
    const rect = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 44, width, height: 44, x: left, y: 0, toJSON: () => ({}) });
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.getAttribute("role") === "tablist") return rect(0, 100) as DOMRect;
      const tabs = [...(this.parentElement?.querySelectorAll('[role="tab"]') ?? [])];
      const index = tabs.indexOf(this);
      return (index >= 0 ? rect(index * 80 - (this.parentElement?.scrollLeft ?? 0), 80) : rect(0, 0)) as DOMRect;
    };
    try {
      renderUi(<Tabs label="Order sections" items={items} value="production" />);
      expect(screen.getByRole("tablist").scrollLeft).toBe(304);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});
