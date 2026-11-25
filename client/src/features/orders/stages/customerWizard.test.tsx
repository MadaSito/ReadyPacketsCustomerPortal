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
    return <p>{`upload ${p.intent} ${p.stageKey} ro=${String(p.readOnly)}`}</p>;
  },
  PhaseTeamFiles: (p: { stageKey: string }) => <p>{`team ${p.stageKey}`}</p>,
}));
vi.mock("../../files/archives/ArchiveAction", () => ({ PhaseArchiveAction: (p: { stageKey: string }) => <p>{`zip ${p.stageKey}`}</p> }));

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

beforeEach(() => { for (const key of Object.keys(handlers)) delete handlers[key]; uploadPending.clear(); });

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
    await userEvent.setup().click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(seen).toEqual([{ orderId: ORDER, stageKey: "intake", expectedVersion: 12 }]));
  });

  it("a refused Next shows the customer message for the reason code and reads the workspace again", async () => {
    let reads = 0;
    handlers["orders.stages.workspace"] = () => { reads += 1; return ws(); };
    handlers["orders.stages.next"] = () => { throw safeError("QUESTIONS_UNANSWERED"); };
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByText("Please answer every required question in this phase first.")).toBeInTheDocument();
    handlers["orders.stages.next"] = () => { throw safeError("STALE_VERSION"); };
    await userEvent.setup().click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/This order changed in the meantime/)).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });

  it("shows the previous checklist when the workspace cannot be read", async () => {
    handlers["orders.stages.workspace"] = () => { throw safeError("NOT_FOUND"); };
    renderUi(<CustomerPhaseWizard orderId={ORDER} fallback={<p>Legacy checklist</p>} />);
    expect(await screen.findByText("Legacy checklist")).toBeInTheDocument();
  });

  it("blocks Next while a file is selected but not uploaded, and focuses the reason", async () => {
    const seen: unknown[] = [];
    handlers["orders.stages.workspace"] = () => ws();
    handlers["orders.stages.next"] = (input) => { seen.push(input); return { version: 13 }; };
    renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    const next = await screen.findByRole("button", { name: "Next" });
    act(() => uploadPending.get("intake:document")?.(1));
    await userEvent.setup().click(next);
    const reason = screen.getByText("1 file is selected but not uploaded yet. Upload it or clear the selection.");
    await waitFor(() => expect(reason.closest("[tabindex='-1']")).toHaveFocus());
    expect(next).toBeEnabled();
    expect(seen).toEqual([]);
    act(() => uploadPending.get("intake:document")?.(0));
    expect(screen.queryByText(/is selected but not uploaded/)).toBeNull();
    await userEvent.setup().click(next);
    await waitFor(() => expect(seen).toHaveLength(1));
  });

  it("does not continue with an unanswered required question: lists it and focuses the first", async () => {
    const seen: unknown[] = [];
    handlers["orders.stages.workspace"] = () => ws();
    handlers["orders.questions.customerList"] = () => ({ canAnswer: true, questions: [
      { questionId: "q1", prompt: "Your date of birth?", required: true, askedAt: new Date(), latestAnswer: null },
      { questionId: "q2", prompt: "Anything else?", required: false, askedAt: new Date(), latestAnswer: null },
    ] });
    handlers["orders.stages.next"] = (input) => { seen.push(input); return { version: 13 }; };
    const view = renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    const next = await screen.findByRole("button", { name: "Next" });
    await waitFor(() => expect(view.queryClient.getQueryData(["orders.questions.customerList", { orderId: ORDER, stageKey: "intake" }])).toBeDefined());
    await userEvent.setup().click(next);
    expect(await screen.findByText("Answer the required questions first")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Your date of birth?" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anything else?" })).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-question-id='q1']")).toHaveFocus());
    expect(seen).toEqual([]);
  });

  it("a phase waiting for payment says so and links to the payable invoice; a team phase says nothing is needed", async () => {
    handlers["orders.stages.workspace"] = () => ws({ stages: [stage({ canNext: false, waitingOn: "payment", actions: { ...actions, answerQuestions: false, uploadDocuments: false } })] });
    handlers["compliance.invoices.listForOrder"] = () => ({ items: [
      { invoicePublicId: "inv_paid", invoiceNumber: "INV-1", status: "paid", issuedAt: new Date(), balanceDueMinor: 0 },
      { invoicePublicId: "inv_open", invoiceNumber: "INV-2", status: "issued", issuedAt: new Date(), balanceDueMinor: 5000 },
    ] });
    const view = renderUi(<CustomerPhaseWizard orderId={ORDER} />);
    expect(await screen.findByText("This step completes when your payment is confirmed.")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Pay invoice INV-2" })).toHaveAttribute("href", "/invoices/inv_open");
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

  it("offers the phase ZIP only where the phase lists files", () => {
    expect(hasFileActions(stage({ actions: { ...actions, uploadDocuments: false } }))).toBe(false);
    expect(hasFileActions(stage({ actions: { ...actions, uploadDocuments: false, teamFileReview: true } }))).toBe(true);
  });
});
