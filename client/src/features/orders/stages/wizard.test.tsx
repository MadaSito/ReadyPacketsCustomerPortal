import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { pageA11y } from "@/test/a11y";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import { PhaseWizard, type PhaseWizardProps } from "./PhaseWizard";
import { STANDARD_ACK_MESSAGE, isWritable, progressStages, wizardErrorMessage, type WizardStage, type WizardWorkspace } from "./wizardModel";

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

describe("PhaseWizard", () => {
  it("shows progress, the current phase, safe instructions and only the enabled actions", () => {
    setup(workspace());
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByRole("heading", { name: "Phase 2 of 3: Synthesis" })).toBeInTheDocument();
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
    expect(screen.getByRole("heading", { name: "Phase 1 of 3: Intake" })).toBeInTheDocument();
    expect(screen.getByText(/This phase is complete/)).toBeInTheDocument();
    expect(screen.getByTestId("action-uploadDocuments")).toHaveTextContent("(read only)");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back to the current phase" }));
    expect(screen.getByRole("heading", { name: "Phase 2 of 3: Synthesis" })).toBeInTheDocument();
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
    expect(within(dialog).getByText("Please tick the box to confirm.")).toBeInTheDocument();
    expect(props.onSubmit).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Submit and lock" }));
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ key: "phase_1" }), { accepted: true, textSha256: HASH });
    await expectNoAxeViolations();
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
