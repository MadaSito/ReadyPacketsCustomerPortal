import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button, EmailLink, mailtoHref, TOAST_ACTION_MIN_DURATION, useToast } from "@/ui";
import { expectNoAxeViolations, renderUi } from "./testing";

describe("increment 09 D1: EmailLink", () => {
  it("renders a mailto link whose text is the address, underlined and wrapping", async () => {
    renderUi(
      <p>
        Contact <EmailLink email=" zeus.greene@example.com " />
      </p>,
    );
    const link = screen.getByRole("link", { name: "zeus.greene@example.com" });
    expect(link).toHaveAttribute("href", "mailto:zeus.greene@example.com");
    expect(link.className).toContain("underline");
    expect(link.className).toContain("[overflow-wrap:anywhere]");
    await expectNoAxeViolations();
  });

  it("accepts custom text and an accessible label", () => {
    renderUi(<EmailLink email="support@example.com" label="Email ReadyPackets support">support@example.com</EmailLink>);
    expect(screen.getByRole("link", { name: "Email ReadyPackets support" })).toHaveAttribute("href", "mailto:support@example.com");
  });

  it.each([
    "zeus greene@example.com",
    "zeus@example.com?subject=x",
    "zeus@example.com&cc=a@b.c",
    "zeus@example.com\nBcc: a@b.c",
    "zeus@@example.com",
    "javascript:alert(1)@example.com",
    "zeus@localhost",
    "zeus@example..com",
    "zeus@example.com\u202e",
    "",
    `${"a".repeat(250)}@example.com`,
  ])("never links an unsafe or non-plain value: %j", (value) => {
    expect(mailtoHref(value)).toBeNull();
    renderUi(<EmailLink email={value}>{value || "none"}</EmailLink>);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

function ToastActionHarness({ onUndo, duration }: { onUndo: () => void; duration?: number }) {
  const toast = useToast();
  return (
    <Button onClick={() => toast.show({ tone: "success", title: "Order moved to trash", duration, action: { label: "Undo", onClick: onUndo } })}>Trash it</Button>
  );
}

describe("increment 09 D2.7: toast action", () => {
  it("renders a real button inside the live region that runs the action and dismisses the toast", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    renderUi(<ToastActionHarness onUndo={onUndo} />);
    await user.click(screen.getByRole("button", { name: "Trash it" }));
    const region = screen.getByRole("status");
    const undo = within(region).getByRole("button", { name: "Undo" });
    expect(undo.className).toContain("min-h-8");
    await expectNoAxeViolations();
    await user.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(within(region).queryByText("Order moved to trash")).toBeNull();
  });

  it("stays at least 10 seconds when an action is present", () => {
    vi.useFakeTimers();
    try {
      renderUi(<ToastActionHarness onUndo={() => {}} duration={3000} />);
      act(() => screen.getByRole("button", { name: "Trash it" }).click());
      act(() => vi.advanceTimersByTime(TOAST_ACTION_MIN_DURATION - 100));
      expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
