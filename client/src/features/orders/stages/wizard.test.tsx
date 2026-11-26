import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { pageA11y } from "@/test/a11y";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import { OrderListProgress } from "./OrderListProgress";
import { CustomerOrderLayout } from "./CustomerOrderLayout";
import { derivedWaitingKind } from "./CustomerPhaseWizard";
import { finishTransition, uploadTotals } from "./DerivedOrderWizard";
import { PhaseWizard, type PhaseWizardProps } from "./PhaseWizard";
import { StepWizard } from "./StepWizard";
import {
  STANDARD_ACK_MESSAGE, buildSteps, describeWorkspaceChange, isWritable, openRequirements, progressStages, resumeIndex, stepExtensions, stepTitle,
  wizardErrorMessage, type WizardStage, type WizardWorkspace,
} from "./wizardModel";

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
    expect(screen.getByRole("heading", { level: 3, name: /Phase 2 of 3/ })).toBeInTheDocument();
    const notices = screen.getAllByText("2 files are selected but not uploaded yet. Upload them or clear the selection.");
    expect(notices.some((n) => n.closest("[tabindex='-1']") === document.activeElement)).toBe(true);
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
  it("a phase left through a status action points to the page actions", () => {
    const ws = workspace();
    ws.stages[1] = { ...ws.stages[1]!, canNext: false, waitingOn: "status_action" };
    setup(ws);
    expect(screen.getByText(/use one of the actions at the top of the page, such as Approve or Request changes/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });
  it("a team phase shows the waiting text and no Next", () => {
    const ws = workspace();
    ws.stages[1] = { ...ws.stages[1]!, canNext: false, waitingOn: "team", actions: { ...noActions } };
    setup(ws);
    expect(screen.queryByText("There is nothing to upload or answer in this phase.")).toBeNull();
    expect(screen.getByRole("heading", { level: 4, name: "We are working on this phase" })).toBeInTheDocument();
    expect(screen.getByText("Our team is working on this step. Nothing is needed from you right now. Next: Review.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });
  it("a payment phase shows one waiting screen with the Pay now action", () => {
    const ws = workspace();
    ws.stages[1] = { ...ws.stages[1]!, canNext: false, waitingOn: "payment" };
    setup(ws, { paymentAction: <a href="/invoices/inv_open">Pay now</a> });
    expect(screen.getByRole("heading", { level: 4, name: "Waiting for your payment" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pay now" })).toHaveAttribute("href", "/invoices/inv_open");
  });
});

describe("step model (D6)", () => {
  const none = { present: false, required: 0, provided: 0 };
  it("keeps only the steps the phase needs, in order, and always ends with review", () => {
    const steps = buildSteps({ accept: { present: true, required: 1, provided: 0 }, questions: none, documents: { present: true, required: 2, provided: 1 }, audio: none });
    expect(steps.map((s) => s.key)).toEqual(["accept", "documents", "review"]);
    expect(stepTitle(steps[1]!, 1, steps.length)).toBe("Step 2 of 3: Upload documents");
    expect(steps[0]!.blockedReason).toBe("Tick the box to accept before you continue.");
    expect(steps[1]!.blockedReason).toBe("Upload 1 more file to continue.");
    expect(openRequirements(steps).map((s) => s.key)).toEqual(["accept", "documents"]);
    expect(resumeIndex(steps)).toBe(0);
  });
  it("optional uploads never block; pending uploads do; resume skips done steps", () => {
    const steps = buildSteps({
      accept: { present: true, required: 0, provided: 0 }, questions: { present: true, required: 0, provided: 0 },
      documents: { present: true, required: 0, provided: 0 }, audio: { present: true, required: 0, provided: 3, pending: 1 },
    });
    expect(steps.find((s) => s.key === "documents")).toMatchObject({ complete: false, blockedReason: null });
    expect(steps.find((s) => s.key === "audio")!.blockedReason).toMatch(/selected but not uploaded/);
    expect(resumeIndex(steps)).toBe(2);
    expect(resumeIndex(buildSteps({ accept: none, questions: none, documents: none, audio: none }))).toBe(0);
  });
  it("narrows upload extensions to the step kind, the policy and the slot", () => {
    expect(stepExtensions(["pdf", "png", "mp3", "exe"], "document")).toEqual(["pdf", "png"]);
    expect(stepExtensions(["pdf", "mp3", "wav"], "audio", ["mp3"])).toEqual(["mp3"]);
    expect(stepExtensions(["pdf"], "audio")).toEqual([]);
  });
  it("derived orders: Finish uses the one forward change; upload totals count toward minimums", () => {
    const t = (to: string, destructive = false, requiresNote = false) => ({ to, label: to, actionLabel: null, requiresNote, destructive }) as unknown as Parameters<typeof finishTransition>[0][number];
    expect(finishTransition([t("submitted"), t("canceled", true)])?.to).toBe("submitted");
    expect(finishTransition([t("submitted"), t("review")])).toBeNull();
    expect(finishTransition([t("submitted", false, true)])).toBeNull();
    expect(uploadTotals([
      { kind: "document", minCount: 2, count: 5, waived: false }, { kind: "audio", minCount: 1, count: 0, waived: false },
      { kind: "document", minCount: 0, count: 1, waived: false }, { kind: "document", minCount: 3, count: 0, waived: true },
    ] as Parameters<typeof uploadTotals>[0], "document")).toEqual({ required: 2, provided: 3 });
  });
  it("derived waiting kinds", () => {
    const ws = workspace();
    expect(derivedWaitingKind(ws)).toBe("team");
    expect(derivedWaitingKind({ ...ws, currentStageKey: null })).toBe("delivered");
    expect(derivedWaitingKind({ ...ws, progress: { ...ws.progress, canceled: true } })).toBe("canceled");
    ws.stages[1] = { ...ws.stages[1]!, waitingOn: "payment" };
    expect(derivedWaitingKind(ws)).toBe("payment");
  });
});

describe("StepWizard", () => {
  const steps = buildSteps({
    accept: { present: true, required: 1, provided: 0 }, questions: { present: false, required: 0, provided: 0 },
    documents: { present: true, required: 0, provided: 0 }, audio: { present: false, required: 0, provided: 0 },
  });
  it("is an ordered list with the current step, written states, a disabled Next with its reason, and moves focus", async () => {
    const run = vi.fn();
    renderUi(<StepWizard label="Steps in Intake" steps={steps} initialIndex={1} renderStep={(k) => <p>{`content ${k}`}</p>}
      final={{ label: "Submit", run, busy: false, disabledReason: "Complete the steps marked Not done first." }} />);
    const list = screen.getByRole("list", { name: "Steps in Intake" });
    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByRole("listitem")[1]).toHaveAttribute("aria-current", "step");
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Not done");
    expect(screen.getByRole("heading", { name: "Step 2 of 3: Upload documents" })).toBeInTheDocument();
    expect(screen.getByText("content documents")).toBeVisible();
    expect(screen.getByText("content accept")).not.toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Step 1 of 3: Review and accept" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toBeDisabled();
    expect(next).toHaveAccessibleDescription("Tick the box to accept before you continue.");
    await user.click(within(list).getAllByRole("button")[2]!);
    expect(screen.getByRole("heading", { name: "Step 3 of 3: Review and submit" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Submit" })).toHaveAccessibleDescription("Complete the steps marked Not done first.");
    expect(run).not.toHaveBeenCalled();
    await expectNoAxeViolations();
  });
  it("summarises errors at the top; a step error opens that step", async () => {
    renderUi(<StepWizard label="Steps" steps={steps} initialIndex={2} renderStep={() => null}
      final={{ label: "Submit", run: () => undefined, busy: false }} errors={[{ message: "Network problem." }, { message: "Accept first.", step: "accept" }]} />);
    expect(screen.getByRole("region", { name: "Please check the following" })).toHaveFocus();
    await userEvent.setup().click(screen.getByRole("button", { name: "Accept first." }));
    expect(screen.getByRole("heading", { name: "Step 1 of 3: Review and accept" })).toHaveFocus();
  });
});

describe("CustomerOrderLayout", () => {
  it("shows the wizard first and the details behind a disclosure; a deep link opens them", async () => {
    const { unmount } = renderUi(<CustomerOrderLayout wizard={<p>Wizard</p>} details={<p>Tabs</p>} deepLink={null} />);
    const toggle = screen.getByRole("button", { name: "Order details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Tabs")).toBeNull();
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Tabs")).toBeVisible();
    unmount();
    renderUi(<CustomerOrderLayout wizard={<p>Wizard</p>} details={<p>Tabs</p>} deepLink="files" />);
    expect(screen.getByRole("button", { name: "Order details" })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("PhaseWizard", () => {
  it("shows progress, the current phase, safe instructions and only the enabled actions", () => {
    setup(workspace());
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByRole("heading", { name: "Phase 2 of 3: Synthesis" })).toBeInTheDocument();
    // Steps: instructions → questions → audio → review; resumes on the first step that is not done (audio).
    expect(screen.getByRole("heading", { level: 4, name: "Step 3 of 4: Record or upload audio" })).toBeInTheDocument();
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

  it("Next moves to the review step; Finish this phase calls onNext for the current stage", async () => {
    const props = setup(workspace());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { level: 4, name: "Step 4 of 4: Review and submit" })).toHaveFocus();
    expect(props.onNext).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Finish this phase" }));
    expect(props.onNext).toHaveBeenCalledWith(expect.objectContaining({ key: "phase_2" }));
  });

  it("required questions block their step and the final action, with the reason written", async () => {
    setup(workspace(), { unansweredRequired: () => [{ questionId: "q1", prompt: "Where were you born?" }] });
    expect(screen.getByRole("heading", { level: 4, name: "Step 2 of 4: Questions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toHaveAccessibleDescription("Answer the required question to continue.");
  });

  it("waits for the step data before choosing where to resume", () => {
    setup(workspace(), { factsReady: () => false });
    expect(screen.getByRole("status", { name: "Loading the steps of this phase" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  it("a completed phase opens read-only from the stepper, with a way back", async () => {
    setup(workspace());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Intake/ }));
    expect(screen.getByRole("heading", { name: "Phase 1 of 3: Intake" })).toHaveFocus();
    expect(screen.getByText(/This phase is complete/)).toBeInTheDocument();
    expect(screen.getByTestId("action-uploadDocuments")).toHaveTextContent("(read only)");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back to the current phase" }));
    expect(screen.getByRole("heading", { name: "Phase 2 of 3: Synthesis" })).toHaveFocus();
  });

  it("Submit and lock with a required acknowledgement needs the box and sends the server's text hash", async () => {
    const ws = workspace({}, [
      stage(0, { state: "open", viewable: true, progression: "submit_lock", canSubmit: true, acknowledgement: { policy: "required", message: "I confirm my story is true.", textSha256: HASH } }),
      stage(1),
    ]);
    const props = setup({ ...ws, currentStageKey: "phase_1", progress: { ...ws.progress, currentIndex: 0 } });
    const user = userEvent.setup();
    // Step 1 of 2: the acknowledgement text and its box; Next waits for the tick and says so.
    expect(screen.getByRole("heading", { level: 4, name: "Step 1 of 2: Review and accept" })).toBeInTheDocument();
    expect(screen.getByText("I confirm my story is true.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toHaveAccessibleDescription("Tick the box to accept before you continue.");
    await user.click(screen.getByRole("checkbox", { name: /I have read and accept this/ }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { level: 4, name: "Step 2 of 2: Review and submit" })).toHaveFocus();
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(STANDARD_ACK_MESSAGE)).toBeInTheDocument();
    expect(props.onSubmit).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Submit" }));
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ key: "phase_1" }), { accepted: true, textSha256: HASH });
    await expectNoAxeViolations();
  });

  it("Cancel keeps the phase open and sends nothing; the review note is masked for analytics", async () => {
    const ws = workspace({ currentStageKey: "phase_1" }, [
      stage(0, { state: "reopened", viewable: true, progression: "submit_lock", canSubmit: true, acknowledgement: { policy: "optional", message: null, textSha256: HASH },
        review: { outcome: "changes_requested", note: "Add page two.", at: "2026-11-21T10:00:00.000Z" } }),
    ]);
    const props = setup(ws);
    expect(screen.getByText("Add page two.")).toHaveAttribute("data-clarity-mask", "true");
    expect(screen.getByText("Add page two.")).toHaveClass("ph-no-capture");
    const user = userEvent.setup();
    // Optional acknowledgement: the step is done without the tick, so the wizard resumes on review.
    expect(screen.getByRole("heading", { level: 4, name: "Step 2 of 2: Review and submit" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("policy none: only the review step; Submit sends no acknowledgement", async () => {
    const ws = workspace({ currentStageKey: "phase_1" }, [stage(0, { state: "open", viewable: true, progression: "submit_lock", canSubmit: true })]);
    const props = setup(ws);
    const user = userEvent.setup();
    expect(screen.getByRole("heading", { level: 4, name: "Step 1 of 1: Review and submit" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Submit" }));
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
