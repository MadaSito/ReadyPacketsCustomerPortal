import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartFrame, ConfirmSwitch, Countdown, formatRemaining, useChartIds } from "@/ui";
import { AccountMenu } from "@/app/shell/common";
import { expectNoAxeViolations, renderUi } from "./testing";

describe("Countdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("formats coarsely", () => {
    expect(formatRemaining(2 * 86400 + 3 * 3600)).toBe("2 d 3 h");
    expect(formatRemaining(3600 + 5 * 60)).toBe("1 h 5 min");
    expect(formatRemaining(600)).toBe("10 min");
    expect(formatRemaining(75)).toBe("1 min 15 s");
    expect(formatRemaining(9.2)).toBe("10 s");
    expect(formatRemaining(-3)).toBe("0 s");
  });

  it("announces only at milestones, never on mount, and fires onElapsed once", async () => {
    let t = 1_000_000;
    const onElapsed = vi.fn();
    const { container } = renderUi(
      <div data-testid="cd">
        <Countdown to={new Date(t + 62_000)} label="Maintenance starts" now={() => t} onElapsed={onElapsed} />
      </div>,
    );
    const status = within(screen.getByTestId("cd")).getByRole("status");
    expect(status).toHaveTextContent("");
    expect(container.querySelector("time")).toHaveTextContent("1 min 2 s");
    expect(container.querySelector("time")).not.toHaveAttribute("aria-live");
    await act(async () => {
      t += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(status).toHaveTextContent("");
    await act(async () => {
      t += 1_500;
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(status).toHaveTextContent("Maintenance starts: 1 min 0 s remaining");
    await act(async () => {
      t += 61_000;
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(status).toHaveTextContent("Maintenance starts: Now");
    expect(onElapsed).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await expectNoAxeViolations(container);
  });

  it("announce=off renders no status", () => {
    renderUi(
      <div data-testid="cd">
        <Countdown to={new Date(Date.now() + 5_000)} label="Grace ends" announce="off" />
      </div>,
    );
    expect(within(screen.getByTestId("cd")).queryByRole("status")).toBeNull();
  });
});

describe("ConfirmSwitch", () => {
  it("keeps the stored value until confirmed; cancel leaves it unchanged", async () => {
    const user = userEvent.setup();
    const saved: boolean[] = [];
    function Demo() {
      const [on, setOn] = useState(false);
      return (
        <ConfirmSwitch
          label="Enforce policies"
          checked={on}
          onConfirmedChange={(next) => {
            saved.push(next);
            setOn(next);
          }}
          confirmOn={{ title: "Turn on policy enforcement?", description: "Customers must accept before ordering." }}
        />
      );
    }
    renderUi(<Demo />);
    const sw = screen.getByRole("switch", { name: "Enforce policies" });
    await user.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
    const dialog = await screen.findByRole("alertdialog", { name: "Turn on policy enforcement?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(saved).toEqual([]);
    expect(sw).toHaveAttribute("aria-checked", "false");
    await user.click(sw);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Turn on" }));
    expect(saved).toEqual([true]);
    expect(sw).toHaveAttribute("aria-checked", "true");
    // No confirmOff: turning off is immediate.
    await user.click(sw);
    expect(saved).toEqual([true, false]);
  });
});

function Bars() {
  const ids = useChartIds();
  return (
    <svg role="img" aria-labelledby={ids.labelledBy} viewBox="0 0 100 40">
      <rect x="0" y="10" width="40" height="30" className="fill-chart-1" />
      <rect x="50" y="20" width="40" height="20" fill={ids.patternFill(2)} />
    </svg>
  );
}

describe("ChartFrame", () => {
  it("names the chart, shows a summary and legend, and switches to the table", async () => {
    const user = userEvent.setup();
    const { container } = renderUi(
      <ChartFrame
        title="Orders per month"
        summary="Orders rose from 12 in May to 20 in June."
        legend={[
          { label: "Packet 1", series: 1 },
          { label: "Packet 2", series: 2, pattern: true },
        ]}
        table={
          <table>
            <caption>Orders per month</caption>
            <tbody>
              <tr>
                <th scope="row">May</th>
                <td>12</td>
              </tr>
            </tbody>
          </table>
        }
      >
        <Bars />
      </ChartFrame>,
    );
    const img = screen.getByRole("img", { name: "Orders per month Orders rose from 12 in May to 20 in June." });
    expect(img).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Orders per month: legend" })).toHaveTextContent("Packet 2");
    expect(container.querySelector("pattern[id$='-pattern-2']")).not.toBeNull();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("radio", { name: "Table" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("table", { name: "Orders per month" })).toBeInTheDocument();
    expect(screen.getByText("Orders rose from 12 in May to 20 in June.")).toBeInTheDocument();
  });

  it("shows loading and empty states without the view switch", () => {
    const { rerender } = renderUi(
      <ChartFrame title="Revenue" summary="" table={null} loading>
        <Bars />
      </ChartFrame>,
    );
    expect(screen.getByRole("status", { name: "Loading Revenue" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    rerender(
      <ChartFrame title="Revenue" summary="" table={null} empty>
        <Bars />
      </ChartFrame>,
    );
    expect(screen.getByText("No data for this selection")).toBeInTheDocument();
  });
});

vi.mock("@/app/PwaInstallEntry", async () => {
  const { Dialog } = await import("@/ui");
  return {
    usePwaInstall: () => ({ available: true, installed: false, prompt: async () => "unavailable" as const }),
    PwaInstallDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) => (
      <Dialog open={open} onOpenChange={onOpenChange} size="sm" title="Install ReadyPackets"><p>Steps</p></Dialog>
    ),
  };
});

describe("AccountMenu install entry", () => {
  it("returns focus to the account menu trigger when the manual install dialog closes", async () => {
    renderUi(<AccountMenu area="customer" user={{ publicId: "u1", role: "customer", name: "Avery Example", email: "a@example.test", status: "active" }} />);
    const trigger = screen.getByRole("button", { name: /account menu for avery example/i });
    const user = userEvent.setup();
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Install app" }));
    expect(await screen.findByRole("dialog", { name: "Install ReadyPackets" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
