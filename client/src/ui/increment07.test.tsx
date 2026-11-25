import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OrderProgress, progressValueText, stageStates } from "@/ui";
import { expectNoAxeViolations, renderUi } from "./testing";

const STAGES = [
  { key: "paid", label: "Payment confirmed" },
  { key: "intake", label: "Intake" },
  { key: "synthesis", label: "Synthesis" },
  { key: "review", label: "Review" },
  { key: "delivery", label: "Delivery" },
] as const;

describe("OrderProgress", () => {
  it("exposes a named progressbar with value text and the number as text", async () => {
    renderUi(<OrderProgress percent={40} stages={STAGES} currentIndex={1} />);
    const bar = screen.getByRole("progressbar", { name: "Order progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "40 percent, step 2 of 5: Intake");
    expect(screen.getByText("Step 2 of 5: Intake")).toBeInTheDocument();
    const steps = within(screen.getByRole("list", { name: "Order phases" })).getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    expect(steps[1]).toHaveAttribute("aria-current", "step");
    expect(steps[0]).toHaveTextContent("Payment confirmed, completed");
    expect(steps[2]).toHaveTextContent("Synthesis, not started");
    await expectNoAxeViolations();
  });

  it("shows the final number immediately when motion is reduced (jsdom has no matchMedia → no animation path)", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const { container } = renderUi(<OrderProgress percent={73} stages={STAGES} currentIndex={3} />);
      expect(container.querySelector("[aria-hidden=true].tabular-nums")).toHaveTextContent("73%");
      expect(container.querySelector(".rp-progress-animate")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("freezes a canceled order and says Canceled, never by colour alone", () => {
    const { container } = renderUi(<OrderProgress percent={60} stages={STAGES} currentIndex={2} canceled />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuetext", "60 percent, canceled, step 3 of 5: Synthesis");
    expect(screen.getByText("Canceled during Synthesis")).toBeInTheDocument();
    expect(container.querySelector(".rp-progress-animate")).toBeNull();
  });

  it("clamps, rounds and reports completion", () => {
    expect(progressValueText({ percent: 140, stages: STAGES, currentIndex: -1 })).toBe("100 percent, all phases complete");
    expect(progressValueText({ percent: Number.NaN, stages: [], currentIndex: -1 })).toBe("0 percent");
    expect(progressValueText({ percent: 12.6, stages: STAGES, currentIndex: 0 })).toBe("13 percent, step 1 of 5: Payment confirmed");
    expect(stageStates(STAGES, -1, 100)).toEqual(["done", "done", "done", "done", "done"]);
    expect(stageStates([{ key: "a", label: "A", state: "locked" }, { key: "b", label: "B" }], 1, 50)).toEqual(["locked", "current"]);
  });

  it("makes completed phases selectable and shows notes for future phases", async () => {
    const onStageSelect = vi.fn();
    const stages = STAGES.map((stage, index) => (index === 2 ? { ...stage, note: "Opens after Intake is reviewed" } : stage));
    renderUi(<OrderProgress percent={20} stages={stages} currentIndex={1} onStageSelect={onStageSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /Payment confirmed, completed/ }));
    expect(onStageSelect).toHaveBeenCalledWith("paid");
    expect(screen.queryByRole("button", { name: /Intake/ })).toBeNull();
    expect(screen.getByText("Opens after Intake is reviewed")).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("keeps the current phase at an explicit 100 percent", () => {
    renderUi(<OrderProgress percent={100} stages={STAGES} currentIndex={3} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "100 percent, step 4 of 5: Review");
    expect(screen.getByText("Step 4 of 5: Review")).toBeInTheDocument();
    expect(screen.queryByText("All phases complete")).toBeNull();
  });

  it("compact variant has no stepper", () => {
    renderUi(<OrderProgress percent={50} stages={STAGES} currentIndex={2} variant="compact" label="Progress for RP-2026-000006" />);
    expect(screen.getByRole("progressbar", { name: "Progress for RP-2026-000006" })).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("steps variant renders only the stepper: no bar, number or status", async () => {
    const onStageSelect = vi.fn();
    const user = userEvent.setup();
    const { container } = renderUi(<OrderProgress percent={40} stages={STAGES} currentIndex={1} variant="steps" label="Phases for RP-2026-000006" onStageSelect={onStageSelect} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.querySelector("[data-variant=steps] [role=status]")).toBeNull();
    expect(screen.queryByText("%")).toBeNull();
    const list = screen.getByRole("list", { name: "Phases for RP-2026-000006" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(within(list).getByText("Intake").closest("li")).toHaveAttribute("aria-current", "step");
    await user.click(within(list).getByRole("button", { name: /Payment confirmed/ }));
    expect(onStageSelect).toHaveBeenCalledWith("paid");
    await expectNoAxeViolations(container);
  });

  it("announces later progress changes politely, not the first render", async () => {
    const user = userEvent.setup();
    function Live() {
      const [step, setStep] = useState(0);
      return (<><OrderProgress percent={step * 20} stages={STAGES} currentIndex={step} /><button type="button" onClick={() => setStep(1)}>Advance</button></>);
    }
    const { container } = renderUi(<Live />);
    const status = () => container.querySelector("[data-variant] > [role=status]");
    expect(status()).toHaveTextContent(/^$/);
    await user.click(screen.getByRole("button", { name: "Advance" }));
    expect(status()).toHaveTextContent("Progress updated: 20 percent, step 2 of 5: Intake");
  });

});
