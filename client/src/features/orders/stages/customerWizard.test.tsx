import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as trpcModule from "@/lib/trpc";
import { renderUi } from "@/ui/testing";
import { CustomerPhaseWizard, hasFileActions } from "./CustomerPhaseWizard";
import type { WizardStage, WizardWorkspace } from "./wizardModel";

/* ---- tRPC mock: every procedure path resolves through `handlers[path]` ---- */
const { handlers, uploadPending } = vi.hoisted(() => ({
  handlers: {} as Record<string, (input: unknown) => unknown>,
  /** onPendingChange callbacks the upload stubs received, by `${stageKey}:${intent}`. */
  uploadPending: new Map<string, (count: number) => void>(),
}));
vi.mock("@/lib/trpc", async (original) => {
  const call = (path: string, input: unknown) => {
    const handler = handlers[path];
    if (!handler) return Promise.reject(new Error(`unmocked ${path}`));
    try { return Promise.resolve(handler(input)); } catch (e) { return Promise.reject(e); }
  };
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        const key = path.join(".");
        if (prop === "queryOptions") return (input?: unknown) => ({ queryKey: [key, input ?? null], queryFn: () => call(key, input), retry: false });
        if (prop === "infiniteQueryOptions") return (input?: unknown) => ({
          queryKey: [key, input ?? null], queryFn: () => call(key, input), initialPageParam: null, getNextPageParam: () => null, retry: false,
        });
        if (prop === "mutationOptions") return () => ({ mutationFn: (input: unknown) => call(key, input) });
        if (prop === "queryKey" || prop === "pathKey") return () => [key];
        return node([...path, prop]);
      },
    });
  return { ...await original<typeof trpcModule>(), useTRPC: () => node([]) };
});
/* Other owners' panels are stubbed: this file tests the wiring, not their behaviour. */
vi.mock("./StageQuestions", () => ({
  StageQuestions: (p: { stageKey: string; readOnly?: boolean; headingLevel?: number }) => (
    <div>
      <p>{`questions ${p.stageKey} ro=${String(p.readOnly)} h${p.headingLevel}`}</p>
      <h5 tabIndex={-1} data-question-id="q1">Your date of birth?</h5>
    </div>
  ),
}));
vi.mock("../../files/PhaseFiles", () => ({
  PhaseUploadPanel: (p: { stageKey: string; intent: string; readOnly?: boolean; onPendingChange?: (count: number) => void }) => {
    if (p.onPendingChange) uploadPending.set(`${p.stageKey}:${p.intent}`, p.onPendingChange);
    return <p>{`upload ${p.intent} ${p.stageKey} ro=${String(Boolean(p.readOnly))}`}</p>;
  },
  PhaseUploadedFiles: (p: { stageKey: string; intent: string; headingLevel?: number }) => <p>{`uploaded ${p.intent} ${p.stageKey} h${p.headingLevel}`}</p>,
  PhaseTeamFiles: (p: { stageKey: string }) => <p>{`team ${p.stageKey}`}</p>,
}));
vi.mock("../../files/archives/ArchiveAction", () => ({ PhaseArchiveAction: (p: { stageKey: string }) => <p>{`zip ${p.stageKey}`}</p> }));
vi.mock("../../files/FileUploadPanel", () => ({
  FileUploadPanel: (p: { policy: { extensions: string[] }; slot?: { key: string }; audio?: unknown }) => (
    <p>{`file panel ${p.slot?.key ?? "order"} ${p.policy.extensions.join(",")}${p.audio ? " audio" : ""}`}</p>
  ),
}));
vi.mock("../../compliance/customer/OrderIntakeTab", () => ({ default: () => <p>intake questionnaires</p> }));
vi.mock("../WorkflowRulesPanel", () => ({ AcknowledgementDialog: () => <div role="dialog" aria-label="Acknowledge" /> }));

const ORDER = "01JTESTORDER00000000000001";
const actions = { uploadDocuments: true, answerQuestions: true, recordAudio: false, uploadAudio: false, teamFileReview: false };
const stage = (patch: Partial<WizardStage>): WizardStage => ({
  key: "intake", customerLabel: "Intake", index: 0, state: "open", completed: false, locked: false, viewable: true, progression: "next",
  acknowledgement: { policy: "none", message: null, textSha256: null }, contentMarkdown: null, actions, submittedAt: null, review: null,
  canNext: true, canSubmit: false, ...patch,
});
const ws = (patch: Partial<WizardWorkspace> = {}): WizardWorkspace => ({
  orderId: ORDER, version: 12, workflowFormat: 3, derived: false,
  progress: { percent: 0, canceled: false, currentIndex: 0, total: 2, currentLabel: "Intake" },
  currentStageKey: "intake", orderLocked: false,
  stages: [stage({}), stage({ key: "review", customerLabel: "Review", index: 1, state: "future", viewable: false, canNext: false, futureReason: "PREVIOUS_PHASE_OPEN" })],
  ...patch,
});
const safeError = (reasonCode: string) => Object.assign(new Error(reasonCode), { data: { safe: { reasonCode, safeMessage: "Server says no.", domainCode: "CONFLICT", requestId: "r" } } });

beforeEach(() => {
  for (const key of Object.keys(handlers)) delete handlers[key];
  uploadPending.clear();
  // What the steps read before choosing where to resume: no uploads yet, one optional question.
  handlers["files.list"] = () => ({ items: [], nextCursor: null });
  handlers["orders.questions.customerList"] = () => ({ canAnswer: true, questions: [
    { questionId: "q2", prompt: "Anything else?", required: false, askedAt: new Date(), latestAnswer: null },
  ] });
});

describe("CustomerPhaseWizard", () => {
  it("mounts the enabled panels for the current phase with the right props and the phase ZIP", async () => {
    handlers["orders.stages.workspace"] = () => ws();
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByText("questions intake ro=false h4")).toBeInTheDocument();
    expect(screen.getByText("upload document intake ro=false")).toBeInTheDocument();
    expect(screen.getByText("zip intake")).toBeInTheDocument();
    expect(screen.queryByText(/upload recording/)).toBeNull();
  });

  it("Next sends the order version and the stage key", async () => {
    const seen: unknown[] = [];
    handlers["orders.stages.workspace"] = () => ws();
    handlers["orders.stages.next"] = (input) => { seen.push(input); return { version: 13, currentStageKey: "review", progressPercent: 50 }; };
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    const user = userEvent.setup();
    // Resumes on the documents step (questions have nothing required); Next only moves to the review step.
    expect(await screen.findByRole("heading", { name: "Step 2 of 3: Upload documents" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(seen).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Finish this phase" }));
    await waitFor(() => expect(seen).toEqual([{ orderId: ORDER, stageKey: "intake", expectedVersion: 12 }]));
  });

  it("a refused Finish shows the customer message for the reason code and reads the workspace again", async () => {
    let reads = 0;
    handlers["orders.stages.workspace"] = () => { reads += 1; return ws(); };
    handlers["orders.stages.next"] = () => { throw safeError("QUESTIONS_UNANSWERED"); };
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Finish this phase" }));
    expect(await screen.findByText("Please answer every required question in this phase first.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Please check the following" })).toHaveFocus();
    handlers["orders.stages.next"] = () => { throw safeError("STALE_VERSION"); };
    await user.click(screen.getByRole("button", { name: "Finish this phase" }));
    expect(await screen.findByText(/This order changed in the meantime/)).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });

  it("shows the previous checklist when the workspace cannot be read", async () => {
    handlers["orders.stages.workspace"] = () => { throw safeError("NOT_FOUND"); };
    renderUi(<CustomerPhaseWizard orderId={ORDER} fallback={<p>Legacy checklist</p>} />);
    expect(await screen.findByText("Legacy checklist")).toBeInTheDocument();
  });

  it("Next waits while a file is selected but not uploaded and says why next to the button", async () => {
    handlers["orders.stages.workspace"] = () => ws();
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    const next = await screen.findByRole("button", { name: "Next" });
    act(() => uploadPending.get("intake:document")?.(1));
    expect(next).toBeDisabled();
    expect(next).toHaveAccessibleDescription("1 file is selected but not uploaded yet. Upload it or clear the selection.");
    act(() => uploadPending.get("intake:document")?.(0));
    expect(next).toBeEnabled();
    expect(screen.queryByText(/is selected but not uploaded/)).toBeNull();
  });

  it("resumes on the questions step while a required question is unanswered; files already uploaded count", async () => {
    handlers["orders.stages.workspace"] = () => ws();
    handlers["files.list"] = () => ({ nextCursor: null, items: [
      { visibility: "customer_visible", deletedAt: null, supersededAt: null, category: "supporting", contentType: "application/pdf" },
    ] });
    handlers["orders.questions.customerList"] = () => ({ canAnswer: true, questions: [
      { questionId: "q1", prompt: "Your date of birth?", required: true, askedAt: new Date(), latestAnswer: null },
      { questionId: "q2", prompt: "Anything else?", required: false, askedAt: new Date(), latestAnswer: null },
    ] });
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByRole("heading", { name: "Step 1 of 3: Questions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toHaveAccessibleDescription("Answer the required question to continue.");
    expect(screen.getByText("1 file uploaded")).toBeInTheDocument();
  });

  it("a derived order offers the allowed uploads, then Finish makes the one forward status change", async () => {
    const seen: unknown[] = [];
    handlers["orders.stages.workspace"] = () => ws({ derived: true, workflowFormat: 2, stages: [stage({ canNext: false, actions: { ...actions, answerQuestions: false, uploadDocuments: false } })] });
    handlers["orders.get"] = () => ({ statusKind: "active", version: 3, transitions: [
      { to: "in_review", label: "In review", actionLabel: "Send for review", requiresNote: false, destructive: false },
      { to: "canceled", label: "Canceled", actionLabel: "Cancel order", requiresNote: true, destructive: true },
    ] });
    handlers["orders.requirements.forOrder"] = () => ({ status: { key: "submitted" }, acknowledgements: [], uploads: [] });
    handlers["files.list"] = () => ({ items: [], nextCursor: null, canUpload: true, uploadSlots: null, audio: { enabled: false, maxMinutes: 10 },
      uploadPolicy: { extensions: ["pdf", "png", "mp3", "exe"], maxBytes: 1000 } });
    handlers["compliance.intake.listForOrder"] = () => ({ items: [], lockState: "none" });
    handlers["orders.transition"] = (input) => { seen.push(input); return { version: 4 }; };
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByRole("heading", { name: "Step 1 of 2: Upload documents" })).toBeInTheDocument();
    expect(screen.getByText("file panel order pdf,png")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Send for review" }));
    await waitFor(() => expect(seen).toEqual([{ orderId: ORDER, expectedVersion: 3, toStatus: "in_review" }]));
  });

  it("leaves out the Questions step when the phase has no questions; keeps it with one", async () => {
    handlers["orders.stages.workspace"] = () => ws();
    handlers["orders.questions.customerList"] = () => ({ canAnswer: true, questions: [] });
    const view = renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByRole("heading", { name: "Step 1 of 2: Upload documents" })).toBeInTheDocument();
    expect(screen.queryByText(/^questions intake/)).toBeNull();
    view.unmount();
    handlers["orders.questions.customerList"] = () => ({ canAnswer: true, questions: [
      { questionId: "q2", prompt: "Anything else?", required: false, askedAt: new Date(), latestAnswer: null },
    ] });
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByRole("heading", { name: "Step 2 of 3: Upload documents" })).toBeInTheDocument();
    expect(screen.getByText("questions intake ro=false h4")).toBeInTheDocument();
  });

  it("a derived order with a pending agreement gate shows one line, not a second accept step", async () => {
    handlers["orders.stages.workspace"] = () => ws({ derived: true, workflowFormat: 2, stages: [stage({ canNext: false, actions: { ...actions, answerQuestions: false, uploadDocuments: false } })] });
    handlers["orders.get"] = () => ({ statusKind: "active", version: 3, transitions: [] });
    handlers["orders.requirements.forOrder"] = () => ({ status: { key: "submitted" }, uploads: [],
      acknowledgements: [{ key: "terms", acceptedBy: "customer", canAccept: true, met: false }] });
    handlers["files.list"] = () => ({ items: [], nextCursor: null, canUpload: false, uploadSlots: null, audio: null, uploadPolicy: null });
    handlers["compliance.intake.listForOrder"] = () => ({ items: [], lockState: "none" });
    handlers["compliance.acceptance.forOrder"] = () => ({ gates: [{ key: "tos", required: true, applies: true, met: false, acceptance: null }] });
    const view = renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByText("Accept the agreement above to continue.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Review and accept/ })).toBeNull();
    view.unmount();
    // Once the gate is met, the wizard's own steps come back.
    handlers["compliance.acceptance.forOrder"] = () => ({ gates: [{ key: "tos", required: true, applies: true, met: true, acceptance: { at: new Date() } }] });
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByRole("heading", { name: "Step 1 of 2: Review and accept" })).toBeInTheDocument();
    expect(screen.queryByText("Accept the agreement above to continue.")).toBeNull();
  });

  it("a derived order with nothing to do shows one waiting screen, never a dead end", async () => {
    handlers["orders.stages.workspace"] = () => ws({ derived: true, workflowFormat: 1, stages: [stage({ canNext: false, actions: { ...actions, answerQuestions: false, uploadDocuments: false } })] });
    handlers["orders.get"] = () => ({ statusKind: "active", version: 3, transitions: [] });
    handlers["orders.requirements.forOrder"] = () => ({ status: { key: "submitted" }, acknowledgements: [], uploads: [] });
    handlers["files.list"] = () => ({ items: [], nextCursor: null, canUpload: false, uploadSlots: null, audio: null, uploadPolicy: null });
    handlers["compliance.intake.listForOrder"] = () => ({ items: [], lockState: "none" });
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByRole("heading", { name: "We are working on this phase" })).toBeInTheDocument();
    expect(screen.queryByText("There is nothing to upload or answer in this phase.")).toBeNull();
  });

  it("a phase waiting for payment says so and links to the payable invoice; a team phase says nothing is needed", async () => {
    handlers["orders.stages.workspace"] = () => ws({ stages: [stage({ canNext: false, waitingOn: "payment", actions: { ...actions, answerQuestions: false, uploadDocuments: false } })] });
    handlers["compliance.invoices.listForOrder"] = () => ({ items: [
      { invoicePublicId: "inv_paid", invoiceNumber: "INV-1", status: "paid", issuedAt: new Date(), balanceDueMinor: 0 },
      { invoicePublicId: "inv_open", invoiceNumber: "INV-2", status: "issued", issuedAt: new Date(), balanceDueMinor: 5000 },
    ] });
    const view = renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByText("This step completes when your payment is confirmed.")).toBeInTheDocument();
    const pay = await screen.findByRole("link", { name: "Pay now, invoice INV-2" });
    expect(pay).toHaveAttribute("href", "/invoices/inv_open");
    // The primary button of the screen; the invoice number is separate text beside it, not glued to the label.
    expect(pay).toHaveTextContent(/^Pay now$/);
    expect(screen.getByText("Invoice INV-2")).not.toBe(pay);
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    view.unmount();
    handlers["compliance.invoices.listForOrder"] = () => ({ items: [] });
    const none = renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByText("Your invoice is being prepared.")).toBeInTheDocument();
    expect(screen.queryByText("There is nothing to upload or answer in this phase.")).toBeNull();
    none.unmount();
    handlers["orders.stages.workspace"] = () => ws({ stages: [stage({ canNext: false, waitingOn: "team", actions: { ...actions, answerQuestions: false, uploadDocuments: false } })] });
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByText("Our team is working on this step. Nothing is needed from you right now.")).toBeInTheDocument();
  });

  it("when a later read finds a new order version, the order header is read again and the change is announced", async () => {
    let version = 12;
    handlers["orders.stages.workspace"] = () => ws({ version, currentStageKey: version > 12 ? "review" : "intake" });
    const view = renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    await screen.findByRole("button", { name: "Next" });
    const invalidate = vi.spyOn(view.queryClient, "invalidateQueries");
    version = 13;
    await act(async () => { await view.queryClient.refetchQueries({ queryKey: ["orders.stages.workspace"] }); });
    expect(await screen.findByText("This order was updated. The current phase is now Review.")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["orders.get"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["orders.list"] });
  });

  it("lists the phase's own uploads under each editable form, audio once; locked phases show the list alone", async () => {
    const both = { ...actions, answerQuestions: false, recordAudio: true, uploadAudio: true };
    handlers["orders.stages.workspace"] = () => ws({ stages: [stage({ actions: both })] });
    const view = renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByText("uploaded document intake h5")).toBeInTheDocument();
    expect(screen.getByText("uploaded prerecorded_audio intake h5")).toBeInTheDocument();
    expect(screen.queryByText(/uploaded recording/)).toBeNull();
    expect(screen.getByText("Recordings are listed under Upload audio.")).toBeInTheDocument();
    view.unmount();
    handlers["orders.stages.workspace"] = () => ws({ stages: [stage({ state: "submitted", locked: true, canNext: false, actions: { ...actions, answerQuestions: false } })] });
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByText("upload document intake ro=true")).toBeInTheDocument();
    expect(screen.queryByText(/^uploaded /)).toBeNull();
  });

  it("offers the phase ZIP only where the phase lists files", () => {
    expect(hasFileActions(stage({ actions: { ...actions, uploadDocuments: false } }))).toBe(false);
    expect(hasFileActions(stage({ actions: { ...actions, uploadDocuments: false, teamFileReview: true } }))).toBe(true);
  });
});
