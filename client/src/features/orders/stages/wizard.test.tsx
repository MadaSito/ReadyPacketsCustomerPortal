import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { pageA11y } from "@/test/a11y";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import { OrderListProgress } from "./OrderListProgress";
import { PhaseWizard, type PhaseWizardProps } from "./PhaseWizard";
import { STANDARD_ACK_MESSAGE, describeWorkspaceChange, isWritable, progressStages, wizardErrorMessage, type WizardStage, type WizardWorkspace } from "./wizardModel";

const HASH = "a".repeat(64);
const noActions = { uploadDocuments: false, answerQuestions: false, recordAudio: false, uploadAudio: false, teamFileReview: false };

function stage(index: number, patch: Partial<WizardStage> = {}): WizardStage {
  return {
    key: `phase_${index + 1}`, customerLabel: ["Intake", "Synthesis", "Review"][index] ?? `Phase ${index + 1}`, index,
    state: "future", completed: false, locked: false, viewable: false, progression: "next",
    acknowledgement: { policy: "none", message: null, textSha256: null }, contentMarkdown: null, actions: { ...noActions },
    submittedAt: null, review: null, canNext: false, canSubmit: false, ...patch,
  };
}

function workspace(patch: Partial<WizardWorkspace> = {}, stages?: WizardStage[]): WizardWorkspace {
  const list = stages ?? [
    stage(0, { state: "accepted", completed: true, locked: true, viewable: true, submittedAt: "2026-11-20T10:00:00.000Z", actions: { ...noActions, uploadDocuments: true } }),
    stage(1, { state: "open", viewable: true, contentMarkdown: "Please **record** your story.\n\n- One\n- Two", actions: { ...noActions, answerQuestions: true, recordAudio: true }, canNext: true }),
    stage(2, { futureReason: "PREVIOUS_PHASE_OPEN" }),
  ];
  return {
    orderId: "01JTESTORDER00000000000001", version: 7, workflowFormat: 3, derived: false,
    progress: { percent: 40, canceled: false, currentIndex: 1, total: 3, currentLabel: "Synthesis" },
    currentStageKey: "phase_2", orderLocked: false, stages: list, ...patch,
  };
}

function setup(ws: WizardWorkspace, overrides: Partial<PhaseWizardProps> = {}) {
  const props: PhaseWizardProps = {
    workspace: ws,
    renderAction: (action, s, readOnly) => <p data-testid={`action-${action}`}>{`${action} for ${s.key}${readOnly ? " (read only)" : ""}`}</p>,
    onNext: vi.fn(async () => undefined),
    onSubmit: vi.fn(async () => undefined),
    busy: false,
    error: null,
    ...overrides,
  };
  renderUi(<PhaseWizard {...props} />);
  return props;
}

describe("phase wizard model", () => {
  it("maps stages to stepper states with the future reason", () => {
    expect(progressStages(workspace()).map((s) => [s.state, s.note])).toEqual([
      ["done", undefined], ["current", undefined], ["upcoming", "Opens when the previous phase is complete"],
    ]);
  });
  it("adds no stepper note for NOT_REACHED (it would repeat the state text)", () => {
    const ws = workspace({}, [stage(0, { state: "open" }), stage(1, { futureReason: "NOT_REACHED" })]);
    expect(progressStages({ ...ws, currentStageKey: "phase_1" }).map((s) => s.note)).toEqual([undefined, undefined]);
  });
  it("describes changes found on a later read", () => {
    const before = workspace();
    expect(describeWorkspaceChange(before, before)).toBeNull();
    const moved = { ...before, version: before.version + 1, currentStageKey: before.stages[2]!.key };
    expect(describeWorkspaceChange(before, moved)).toBe(`This order was updated. The current phase is now ${before.stages[2]!.customerLabel}.`);
    expect(describeWorkspaceChange(before, { ...before, version: before.version + 1, currentStageKey: null })).toBe("This order was updated. All phases are complete.");
  });
  it("only the current open stage is writable; canceled or locked orders are read-only", () => {
    const ws = workspace();
    expect(isWritable(ws, ws.stages[1]!)).toBe(true);
    expect(isWritable(ws, ws.stages[0]!)).toBe(false);
    expect(isWritable(workspace({ orderLocked: true }), ws.stages[1]!)).toBe(false);
    expect(isWritable(workspace({ progress: { ...ws.progress, canceled: true } }), ws.stages[1]!)).toBe(false);
  });
  it("maps reason codes, falling back to the server's safe message", () => {
    expect(wizardErrorMessage("STALE_VERSION", "x")).toMatch(/changed in the meantime/);
    expect(wizardErrorMessage("SOMETHING_NEW", "Safe text")).toBe("Safe text");
    expect(wizardErrorMessage(undefined, undefined)).toMatch(/Something went wrong/);
  });
});

describe("phase wizard guards (lead QA rulings 5 and 3)", () => {
  it("keeps the current phase open while files are pending and says why", async () => {
    setup(workspace(), { pendingUploads: (key) => (key === "phase_2" ? 2 : 0) });
    await userEvent.setup().click(screen.getByRole("button", { name: /Intake.*review/ }));
    expect(screen.getByRole("heading", { level: 3, name: /Step 2 of 3/ })).toBeInTheDocument();
    expect(screen.getByText("2 files are selected but not uploaded yet. Upload them or clear the selection.")).toBeInTheDocument();
  });
  it("a reopened phase shows only the reopened notice, not the earlier acceptance", () => {
    const ws = workspace();
    ws.stages[1] = { ...ws.stages[1]!, state: "reopened", review: { outcome: "accepted", note: null, at: "2026-11-21T10:00:00.000Z" } };
    setup(ws);
    expect(screen.queryByText("Our team accepted this phase.")).toBeNull();
    expect(screen.getAllByText("This phase was reopened. Make your changes, then continue.")).toHaveLength(1);
  });
  it("a reopened phase with changes requested shows one notice with the reviewer note", () => {
    const ws = workspace();
    ws.stages[1] = { ...ws.stages[1]!, state: "reopened", review: { outcome: "changes_requested", note: "Add page two.", at: "2026-11-21T10:00:00.000Z" } };
    setup(ws);
    expect(screen.getByText("Add page two.")).toBeInTheDocument();
    expect(screen.getAllByText("This phase was reopened. Make your changes, then continue.")).toHaveLength(1);
  });
  it("a team phase shows the waiting text and no Next", () => {
    const ws = workspace();
    ws.stages[1] = { ...ws.stages[1]!, canNext: false, waitingOn: "team", actions: { ...noActions } };
    setup(ws);
    expect(screen.queryByText("There is nothing to upload or answer in this phase.")).toBeNull();
    expect(screen.getByText("Our team is working on this step. Nothing is needed from you right now.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });
});

describe("PhaseWizard", () => {
  it("shows progress, the current phase, safe instructions and only the enabled actions", () => {
    setup(workspace());
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByRole("heading", { name: "Step 2 of 3: Synthesis" })).toBeInTheDocument();
    expect(screen.getByText("record").tagName).toBe("STRONG");
    expect(screen.getByTestId("action-answerQuestions")).toHaveTextContent("answerQuestions for phase_2");
    expect(screen.getByTestId("action-recordAudio")).not.toHaveTextContent("read only");
    expect(screen.queryByTestId("action-uploadDocuments")).toBeNull();
    expect(screen.getByText("Opens when the previous phase is complete")).toBeInTheDocument();
  });

  it("never renders raw HTML from the instructions", () => {
    setup(workspace({}, [stage(0, { state: "open", viewable: true, contentMarkdown: "<img src=x onerror=alert(1)> hello" })].map((s) => s)), {});
    expect(document.querySelector("img")).toBeNull();
  });

  it("Next calls onNext for the current stage", async () => {
    const props = setup(workspace());
    await userEvent.setup().click(screen.getByRole("button", { name: "Next" }));
    expect(props.onNext).toHaveBeenCalledWith(expect.objectContaining({ key: "phase_2" }));
  });

  it("a completed phase opens read-only from the stepper, with a way back", async () => {
    setup(workspace());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Intake/ }));
    expect(screen.getByRole("heading", { name: "Step 1 of 3: Intake" })).toHaveFocus();
    expect(screen.getByText(/This phase is complete/)).toBeInTheDocument();
    expect(screen.getByTestId("action-uploadDocuments")).toHaveTextContent("(read only)");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back to the current phase" }));
    expect(screen.getByRole("heading", { name: "Step 2 of 3: Synthesis" })).toHaveFocus();
  });

  it("Submit and lock with a required acknowledgement needs the box and sends the server's text hash", async () => {
    const ws = workspace({}, [
      stage(0, { state: "open", viewable: true, progression: "submit_lock", canSubmit: true, acknowledgement: { policy: "required", message: "I confirm my story is true.", textSha256: HASH } }),
      stage(1),
    ]);
    const props = setup({ ...ws, currentStageKey: "phase_1", progress: { ...ws.progress, currentIndex: 0 } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Submit and lock" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("I confirm my story is true.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Submit and lock" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Please tick the box to confirm.");
    expect(within(dialog).getByRole("checkbox")).toHaveFocus();
    expect(props.onSubmit).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Submit and lock" }));
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ key: "phase_1" }), { accepted: true, textSha256: HASH });
    await expectNoAxeViolations();
  });

  it("Cancel resets the acknowledgement; the review note is masked for analytics", async () => {
    const ws = workspace({ currentStageKey: "phase_1" }, [
      stage(0, { state: "reopened", viewable: true, progression: "submit_lock", canSubmit: true, acknowledgement: { policy: "required", message: null, textSha256: HASH },
        review: { outcome: "changes_requested", note: "Add page two.", at: "2026-11-21T10:00:00.000Z" } }),
    ]);
    setup(ws);
    expect(screen.getByText("Add page two.")).toHaveAttribute("data-clarity-mask", "true");
    expect(screen.getByText("Add page two.")).toHaveClass("ph-no-capture");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Submit and lock" }));
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Submit and lock" }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
  });

  it("policy none shows the standard warning and sends no acknowledgement", async () => {
    const ws = workspace({ currentStageKey: "phase_1" }, [stage(0, { state: "open", viewable: true, progression: "submit_lock", canSubmit: true })]);
    const props = setup(ws);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Submit and lock" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(STANDARD_ACK_MESSAGE)).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Submit and lock" }));
    expect(props.onSubmit).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it("a submitted (locked) current phase is read-only and explains why; changes requested shows the note", () => {
    const ws = workspace({ currentStageKey: "phase_1", progress: { percent: 0, canceled: false, currentIndex: 0, total: 2, currentLabel: "Intake" } }, [
      stage(0, { state: "submitted", locked: true, viewable: true, submittedAt: "2026-11-20T10:00:00.000Z", review: { outcome: "changes_requested", note: "Please add the second page.", at: "2026-11-21T10:00:00.000Z" }, actions: { ...noActions, uploadDocuments: true } }),
      stage(1),
    ]);
    setup(ws);
    expect(screen.getByText(/It is locked while our team reviews it/)).toBeInTheDocument();
    expect(screen.getByText("Please add the second page.")).toBeInTheDocument();
    expect(screen.getByTestId("action-uploadDocuments")).toHaveTextContent("(read only)");
    expect(screen.queryByRole("button", { name: /Submit|Next/ })).toBeNull();
  });

  it("canceled orders show the frozen progress and no actions; errors are announced", () => {
    const ws = workspace();
    setup({ ...ws, progress: { ...ws.progress, canceled: true } }, { error: "This order changed in the meantime." });
    expect(screen.getByText(/This order was canceled/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.getByText("This order changed in the meantime.")).toBeInTheDocument();
  });

  it("all phases complete", () => {
    setup(workspace({ currentStageKey: null, progress: { percent: 100, canceled: false, currentIndex: -1, total: 1, currentLabel: null } }, [stage(0, { state: "accepted", completed: true, viewable: true })]));
    expect(screen.getByText("All phases are complete")).toBeInTheDocument();
  });

  pageA11y("phase wizard", () => {
    document.title = "Order · ReadyPackets";
    renderUi(
      <main>
        <h1>Order</h1>
        <PhaseWizard workspace={workspace()} renderAction={() => <p>Action</p>} onNext={async () => undefined} onSubmit={async () => undefined} busy={false} error={null} />
      </main>,
    );
  });
});

describe("OrderListProgress", () => {
  it("names each bar after its order and describes the current phase", async () => {
    renderUi(<ul><li><OrderListProgress name="Smith family" progressPercent={40} phaseLabel="Synthesis" phaseIndex={1} phaseTotal={5} /></li></ul>);
    const bar = screen.getByRole("progressbar", { name: "Progress of Smith family" });
    expect(bar).toHaveAttribute("aria-valuetext", "40 percent, step 2 of 5: Synthesis");
    await expectNoAxeViolations();
  });
  it("shows nothing for rows without a phase model; canceled is said in words", () => {
    const { container } = renderUi(<OrderListProgress name="Old" progressPercent={null} phaseLabel={null} phaseIndex={null} phaseTotal={null} />);
    expect(container.querySelector("[role=progressbar]")).toBeNull();
    renderUi(<OrderListProgress name="Gone" progressPercent={60} phaseLabel="Review" phaseIndex={2} phaseTotal={3} canceled />);
    expect(screen.getByRole("progressbar", { name: "Progress of Gone" }).getAttribute("aria-valuetext")).toMatch(/canceled/);
  });
});
