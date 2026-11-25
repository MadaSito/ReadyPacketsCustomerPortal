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
