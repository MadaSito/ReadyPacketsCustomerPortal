import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowStage } from "@shared/workflowStages";
import { OrderProgress } from "@/ui";
import { expectNoAxeViolations, renderUi } from "../testing";
import { PhaseEditor, newStage, stageErrors, keyFromLabel, type PhaseSlotRenderer, type PhaseStatusOption } from "./index";

const STATUSES: PhaseStatusOption[] = [
  { key: "new", label: "New", category: "start" },
  { key: "intake", label: "Intake", category: "working" },
  { key: "review", label: "Review", category: "working" },
  { key: "done", label: "Done", category: "done" },
];

function stages(labels: string[]): WorkflowStage[] {
  const list: WorkflowStage[] = [];
  for (const label of labels) {
    const stage = newStage(list, undefined);
    list.push({ ...stage, key: keyFromLabel(label), customerLabel: label, staffLabel: label });
  }
  return list;
}

function Harness({ initial, onChange, ...rest }: { initial: WorkflowStage[]; onChange?: (next: WorkflowStage[]) => void } & Partial<Parameters<typeof PhaseEditor>[0]>) {
  const [value, setValue] = useState(initial);
  return <PhaseEditor value={value} statusOptions={STATUSES} {...rest} onChange={(next) => { setValue(next); onChange?.(next); }} />;
}

const names = () => within(screen.getByRole("list", { name: "Phases in order" })).getAllByRole("listitem", { name: undefined })
  .filter((item) => item.parentElement?.getAttribute("aria-label") === "Phases in order")
  .map((item) => item.querySelector("button[aria-expanded]")?.textContent ?? "");

describe("PhaseEditor canvas", () => {
  it("reorders with the Up and Down buttons, keeps focus on the moved card and announces it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<Harness initial={stages(["Intake", "Review", "Delivery"])} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Move Review up" }));
    expect(onChange.mock.lastCall?.[0].map((s: WorkflowStage) => s.key)).toEqual(["review", "intake", "delivery"]);
    expect(names()[0]).toContain("Review");
    const focused = document.activeElement as HTMLElement;
    expect(`${focused.getAttribute("aria-label") ?? ""} ${focused.textContent ?? ""}`).toMatch(/Review/);
    expect(screen.getByText("Review moved to position 1 of 3.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move Review up" })).toBeDisabled();
    await expectNoAxeViolations();
  });

  it("reorders by dragging the grip onto another card", () => {
    const onChange = vi.fn();
    renderUi(<Harness initial={stages(["Intake", "Review", "Delivery"])} onChange={onChange} />);
    const cards = screen.getByRole("list", { name: "Phases in order" }).querySelectorAll(":scope > li");
    const grip = cards[0]!.querySelector("[title='Drag to reorder']")!;
    const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "", dropEffect: "" };
    expect(grip).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(grip, { dataTransfer });
    fireEvent.dragOver(cards[2]!, { dataTransfer });
    fireEvent.drop(cards[2]!, { dataTransfer });
    expect(onChange.mock.lastCall?.[0].map((s: WorkflowStage) => s.key)).toEqual(["review", "delivery", "intake"]);
  });

  it("adds a phase and removes one after confirmation", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderUi(<Harness initial={stages(["Intake", "Review"])} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /Add phase/ }));
    expect(onChange.mock.lastCall?.[0]).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Remove Intake" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /Remove/ }));
    expect(onChange.mock.lastCall?.[0].map((s: WorkflowStage) => s.key)).not.toContain("intake");
    expect(await screen.findByText("Intake removed.")).toBeInTheDocument();
  });

  it("shows server errors by path on the right card and the list error", () => {
    renderUi(<Harness initial={stages(["Intake", "Review"])} errors={{ "stages.1.customerLabel": "Enter a label.", stages: "Every status may belong to one phase." }} />);
    expect(screen.getByText("Every status may belong to one phase.")).toBeInTheDocument();
    expect(stageErrors({ "stages.1.customerLabel": "x", "stages.10.key": "y" }, 1)).toEqual({ customerLabel: "x" });
  });

  it("explains when a feature slot is not installed and renders installed ones", async () => {
    const user = userEvent.setup();
    const slots: PhaseSlotRenderer = { has: (name) => name === "webhook", render: (name) => <p>Slot {name}</p> };
    renderUi(<Harness initial={stages(["Intake"])} slots={slots} />);
    const toggle = screen.getAllByRole("button", { expanded: true })[0] ?? screen.getByRole("button", { name: /Intake/ });
    if (toggle.getAttribute("aria-expanded") !== "true") await user.click(toggle);
    expect(screen.getByText("Slot webhook")).toBeInTheDocument();
    expect(screen.queryByText("Slot actions")).not.toBeInTheDocument();
  });
});

describe("PhaseEditor guided designer", () => {
  it("steps through phases with Previous and Next", async () => {
    const user = userEvent.setup();
    renderUi(<Harness initial={stages(["Intake", "Review", "Delivery"])} defaultView="guided" />);
    const next = screen.getByRole("button", { name: "Next phase" });
    expect(screen.getByRole("button", { name: "Previous phase" })).toBeDisabled();
    await user.click(next);
    await user.click(next);
    expect(next).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /Customer-facing phase label/ })).toHaveValue("Delivery");
    await expectNoAxeViolations();
  });
});

describe("OrderProgress dense layout", () => {
  it("renders 20 phases and the all-complete state only when nothing is current", () => {
    const many = Array.from({ length: 20 }, (_, n) => ({ key: `p${n}`, label: `Phase ${n + 1}` }));
    const { unmount } = renderUi(<OrderProgress percent={100} stages={many} currentIndex={19} />);
    expect(within(screen.getByRole("list", { name: "Order phases" })).getAllByRole("listitem")).toHaveLength(20);
    expect(screen.queryByText("All phases complete")).not.toBeInTheDocument();
    unmount();
    act(() => { renderUi(<OrderProgress percent={100} stages={many} currentIndex={-1} />); });
    expect(screen.getAllByText(/All phases complete/).length).toBeGreaterThan(0);
  });
});
