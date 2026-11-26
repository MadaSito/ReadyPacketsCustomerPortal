/**
 * D4 customer phase wizard — model (package E, audit_engineer). Shapes follow server/modules/orders/API.md
 * "Increment 07" (`orders.stages.workspace`). The server decides everything; these helpers only present it.
 */
import type { StageActionKey } from "@shared/workflowStages";
import type { OrderProgressStage } from "@/ui";

export type StageState = "future" | "open" | "submitted" | "in_review" | "accepted" | "reopened";
export type AckPolicy = "required" | "optional" | "none";

export interface WizardStage {
  key: string;
  customerLabel: string;
  index: number;
  state: StageState;
  completed: boolean;
  locked: boolean;
  viewable: boolean;
  futureReason?: "PREVIOUS_PHASE_OPEN" | "NOT_REACHED";
  progression: "next" | "submit_lock";
  acknowledgement: { policy: AckPolicy; message: string | null; textSha256: string | null };
  contentMarkdown: string | null;
  actions: Record<StageActionKey, boolean>;
  submittedAt: string | null;
  review: { outcome: "accepted" | "changes_requested"; note: string | null; at: string } | null;
  canNext: boolean;
  canSubmit: boolean;
  /** Current phase only: why the customer has no Next / Submit here (server `waitingOn`). Old servers omit it. */
  waitingOn?: "payment" | "team" | "status_action" | null;
}

export interface WizardWorkspace {
  orderId: string;
  version: number;
  workflowFormat: 1 | 2 | 3;
  derived: boolean;
  progress: { percent: number; canceled: boolean; currentIndex: number; total: number; currentLabel: string | null };
  currentStageKey: string | null;
  orderLocked: boolean;
  stages: WizardStage[];
}

/** The standard warning shown (and hashed by the server) when a phase has no acknowledgement message of its own. */
export const STANDARD_ACK_MESSAGE =
  "When you submit this phase it is locked. You can still read what you sent, but you cannot change it unless an administrator reopens the phase.";

export const STATE_LABEL: Record<StageState, string> = {
  future: "Not open yet",
  open: "In progress",
  submitted: "Submitted",
  in_review: "In review",
  accepted: "Accepted",
  reopened: "Reopened",
};

/**
 * Stepper notes for future phases. Only reasons that add something to the item's state text ("Not started")
 * get a note; NOT_REACHED would only repeat it (lead QA ruling 2).
 */
export const FUTURE_REASON_LABEL: Partial<Record<NonNullable<WizardStage["futureReason"]>, string>> = {
  PREVIOUS_PHASE_OPEN: "Opens when the previous phase is complete",
};

/** Panel text when the current phase has nothing for the customer to do (lead QA ruling 3). */
export const WAITING_MESSAGE: Record<NonNullable<WizardStage["waitingOn"]>, string> = {
  payment: "This step completes when your payment is confirmed.",
  team: "Our team is working on this step. Nothing is needed from you right now.",
  status_action: "When you're ready, use one of the actions at the top of the page, such as Approve or Request changes.",
};

/** Shown under the payment message when no open invoice exists yet. */
export const INVOICE_PREPARING_MESSAGE = "Your invoice is being prepared.";

/** Panel heading, worded like OrderProgress ("Step n of m: label") so the step number and phase names don't clash. */
export function stepHeading(stage: WizardStage, total: number): string {
  return `Step ${stage.index + 1} of ${total}: ${stage.customerLabel}`;
}

/** Inline reason shown when Next / Submit is blocked by files that are selected but not uploaded (ruling 5). */
export function pendingUploadMessage(count: number): string {
  return count === 1
    ? "1 file is selected but not uploaded yet. Upload it or clear the selection."
    : `${count} files are selected but not uploaded yet. Upload them or clear the selection.`;
}

/** Order the actions appear in the panel, with the customer's wording. */
export const ACTION_ORDER: readonly { key: StageActionKey; title: string }[] = [
  { key: "answerQuestions", title: "Questions" },
  { key: "uploadDocuments", title: "Documents" },
  { key: "recordAudio", title: "Record audio" },
  { key: "uploadAudio", title: "Upload audio" },
  { key: "teamFileReview", title: "Files from our team" },
];

/** Customer-facing messages for the server's reason codes; unknown codes use the server's safe message. */
export const WIZARD_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  STAGE_NOT_OPEN: "This phase is not open for changes right now.",
  STAGE_LOCKED: "This phase is locked. An administrator can reopen it if something needs to change.",
  STAGE_NOT_FOUND: "This phase is no longer part of the order. The page has been refreshed.",
  ACK_REQUIRED: "Please confirm the acknowledgement before submitting.",
  ACK_TEXT_CHANGED: "The acknowledgement text changed. Please read it again and confirm.",
  QUESTIONS_UNANSWERED: "Please answer every required question in this phase first.",
  REQUIREMENTS_UNMET: "Something required in this phase is still missing. Check the items above.",
  STALE_VERSION: "This order changed in the meantime. The page has been refreshed; please try again.",
  AGREEMENT_REQUIRED: "Please accept the agreement shown at the top of the page first.",
  POLICY_ACCEPTANCE_REQUIRED: "Please accept the required policy shown at the top of the page first.",
  STAGE_NOT_CUSTOMER_ACTIONABLE: "Nothing is needed from you in this phase. It moves on when our team or your payment completes it.",
  STAGE_SUBMIT_REQUIRED: "Please submit and lock this phase first.",
  STAGE_USE_STATUS_ACTION: "Use one of the actions at the top of the page to continue, such as Approve or Request changes.",
};

/** Codes after which the workspace should be read again (the server state moved on). */
export const REFRESH_CODES: ReadonlySet<string> = new Set(["STALE_VERSION", "ACK_TEXT_CHANGED", "STAGE_NOT_FOUND", "STAGE_NOT_OPEN", "STAGE_LOCKED", "STAGE_NOT_CUSTOMER_ACTIONABLE", "STAGE_USE_STATUS_ACTION"]);

export function wizardErrorMessage(reasonCode: string | undefined, safeMessage: string | undefined): string {
  return (reasonCode && WIZARD_ERROR_MESSAGES[reasonCode]) ?? safeMessage ?? "Something went wrong. Please try again.";
}

export function currentStage(ws: WizardWorkspace): WizardStage | null {
  return ws.stages.find((s) => s.key === ws.currentStageKey) ?? null;
}

/** Stepper entries for `OrderProgress`: done / current / upcoming, with the reason a future phase is closed. */
export function progressStages(ws: WizardWorkspace): OrderProgressStage[] {
  return ws.stages.map((s) => ({
    key: s.key,
    label: s.customerLabel,
    state: s.key === ws.currentStageKey ? "current" : s.completed ? "done" : s.state === "future" ? "upcoming" : s.locked ? "locked" : "upcoming",
    note: s.state === "future" && s.futureReason ? FUTURE_REASON_LABEL[s.futureReason] : undefined,
  }));
}

/** May the customer work in this stage now (everything else is read-only)? */
export function isWritable(ws: WizardWorkspace, stage: WizardStage): boolean {
  return !ws.orderLocked && !ws.progress.canceled && stage.key === ws.currentStageKey && !stage.locked && (stage.state === "open" || stage.state === "reopened");
}

/** A short, customer-facing description of what changed between two reads of the workspace, or null. */
export function describeWorkspaceChange(before: WizardWorkspace, after: WizardWorkspace): string | null {
  if (before.version === after.version) return null;
  if (before.currentStageKey !== after.currentStageKey) {
    const now = currentStage(after);
    return now ? `This order was updated. The current phase is now ${now.customerLabel}.` : "This order was updated. All phases are complete.";
  }
  const was = currentStage(before);
  const now = currentStage(after);
  if (was && now && was.state !== now.state) return `This order was updated. ${now.customerLabel} is now ${STATE_LABEL[now.state].toLowerCase()}.`;
  return "This order was updated.";
}

export function enabledActions(stage: WizardStage): typeof ACTION_ORDER {
  return ACTION_ORDER.filter((a) => stage.actions[a.key]);
}

export function ackText(stage: WizardStage): string {
  return stage.acknowledgement.message?.trim() || STANDARD_ACK_MESSAGE;
}

/* ------------------------------------------------------------------------------------------------------------
 * Increment 08 (D6): steps inside the current phase. A step exists only when the workflow asks for it, always in
 * this order: review and accept → questions → documents → audio → review and submit. The server still checks
 * everything at Submit / Next; these helpers only decide what to show and where to resume.
 * ---------------------------------------------------------------------------------------------------------- */

export type WizardStepKey = "accept" | "questions" | "documents" | "audio" | "review";

export const STEP_ORDER: readonly WizardStepKey[] = ["accept", "questions", "documents", "audio", "review"];

export const STEP_TITLE: Record<WizardStepKey, string> = {
  accept: "Review and accept",
  questions: "Questions",
  documents: "Upload documents",
  audio: "Record or upload audio",
  review: "Review and submit",
};

/** What one step needs, as far as the client can tell. `required` > 0 means Next waits until `provided` reaches it. */
export interface StepFacts {
  /** Accept: there is something to read or accept. Other steps: the workflow asks for it and the customer may do it. */
  present: boolean;
  /** Accept: an acknowledgement must be ticked. Questions: unanswered required count. Uploads: minimum file count. */
  required: number;
  /** Accept: 1 when ticked. Questions: answered required. Uploads: files provided (current versions). */
  provided: number;
  /** Files selected or uploading but not finished; Next waits for them. */
  pending?: number;
}

export interface StepInputs {
  accept: StepFacts;
  questions: StepFacts;
  documents: StepFacts;
  audio: StepFacts;
}

export interface WizardStep {
  key: WizardStepKey;
  title: string;
  /** Done for resuming and for the summary: accepted, required answers saved, at least the minimum (or one) file. */
  complete: boolean;
  /** Why Next is not available on this step (shown next to the disabled button), or null. */
  blockedReason: string | null;
}

/** "Step 2 of 4: Questions" — the heading of the shown step. */
export function stepTitle(step: WizardStep, index: number, total: number): string {
  return `Step ${index + 1} of ${total}: ${step.title}`;
}

function uploadBlock(facts: StepFacts, noun: "file" | "audio file"): string | null {
  if ((facts.pending ?? 0) > 0) return pendingUploadMessage(facts.pending ?? 0);
  const missing = facts.required - facts.provided;
  if (missing > 0) return missing === 1 ? `Upload 1 more ${noun} to continue.` : `Upload ${missing} more ${noun}s to continue.`;
  return null;
}

export function buildSteps(inputs: StepInputs): WizardStep[] {
  const steps: WizardStep[] = [];
  const { accept, questions, documents, audio } = inputs;
  if (accept.present) {
    const done = accept.provided >= accept.required;
    steps.push({ key: "accept", title: STEP_TITLE.accept, complete: done, blockedReason: done ? null : "Tick the box to accept before you continue." });
  }
  if (questions.present) {
    const missing = Math.max(0, questions.required - questions.provided);
    steps.push({
      key: "questions", title: STEP_TITLE.questions, complete: missing === 0,
      blockedReason: missing === 0 ? null : missing === 1 ? "Answer the required question to continue." : `Answer the ${missing} required questions to continue.`,
    });
  }
  if (documents.present) {
    steps.push({ key: "documents", title: STEP_TITLE.documents, complete: documents.provided >= Math.max(1, documents.required) && !(documents.pending ?? 0), blockedReason: uploadBlock(documents, "file") });
  }
  if (audio.present) {
    steps.push({ key: "audio", title: STEP_TITLE.audio, complete: audio.provided >= Math.max(1, audio.required) && !(audio.pending ?? 0), blockedReason: uploadBlock(audio, "audio file") });
  }
  steps.push({ key: "review", title: STEP_TITLE.review, complete: false, blockedReason: null });
  return steps;
}

/** Where to resume: the first step that is not done (the review step when everything before it is). */
export function resumeIndex(steps: readonly WizardStep[]): number {
  const index = steps.findIndex((s) => s.key !== "review" && !s.complete);
  return index === -1 ? steps.length - 1 : index;
}

/** Steps whose requirement is still open (they block the final Submit / Finish). Optional steps never block. */
export function openRequirements(steps: readonly WizardStep[]): WizardStep[] {
  return steps.filter((s) => s.key !== "review" && s.blockedReason !== null);
}

/** Only these extensions belong in the document step; audio goes to the audio step (files_engineer's guidance). */
export const DOCUMENT_EXTENSIONS: readonly string[] = ["pdf", "png", "jpg", "jpeg", "docx"];
export const AUDIO_EXTENSIONS: readonly string[] = ["wav", "webm", "mp4", "m4a", "ogg", "mp3", "aac", "caf"];

/** Policy extensions ∩ the step's kind ∩ (slot types when the slot restricts them). Empty means the step is not offered. */
export function stepExtensions<E extends string>(policy: readonly E[], kind: "document" | "audio", slotTypes: readonly string[] = []): E[] {
  const norm = (e: string) => e.replace(/^\./, "").toLowerCase();
  const kindSet = new Set<string>(kind === "document" ? DOCUMENT_EXTENSIONS : AUDIO_EXTENSIONS);
  const slotSet = new Set(slotTypes.map(norm));
  return policy.filter((e) => kindSet.has(norm(e)) && (slotSet.size === 0 || slotSet.has(norm(e))));
}

/** A key for the acceptance ticked in this browser tab (kept in memory), so returning to the phase resumes after "Review and accept". */
export function ackStorageKey(orderId: string, stageKey: string, textSha256: string | null): string {
  return `rp.wizard.ack.${orderId}.${stageKey}.${textSha256 ?? "none"}`;
}

/** Waiting screens: what happens next and the one useful action. */
export type WaitingKind = "payment" | "team" | "status_action" | "submitted" | "delivered" | "nothing" | "canceled";
