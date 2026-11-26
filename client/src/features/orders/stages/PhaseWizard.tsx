/**
 * D4 customer phase wizard — view (package E, audit_engineer). Pure presentation: the container
 * (`CustomerPhaseWizard`) supplies the workspace, the mutations and the action panels of other owners
 * (questions: assurance; files: files_engineer). The server enforces every rule; the client only shows them.
 */
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import type { StageActionKey } from "@shared/workflowStages";
import { SafePolicyText } from "@/lib/agreementGate";
import { Badge, Button, Callout, Card, Checkbox, DateTime, Dialog, OrderProgress, Skeleton, type Tone } from "@/ui";
import { StepWizard } from "./StepWizard";
import { WaitingScreen } from "./WaitingScreen";
import {
  STANDARD_ACK_MESSAGE, STATE_LABEL, ackStorageKey, ackText, buildSteps, currentStage, enabledActions, isWritable, openRequirements,
  pendingUploadMessage, progressStages, resumeIndex,
  type WaitingKind, type WizardStage, type WizardStepKey, type WizardWorkspace,
} from "./wizardModel";

/** A required question the customer has not answered yet (from `orders.questions.customerList`). */
export interface UnansweredQuestion { questionId: string; prompt: string }

const REOPENED_TEXT = "This phase was reopened. Make your changes, then continue.";

const STATE_TONE: Record<WizardStage["state"], Tone> = {
  future: "neutral", open: "brand", submitted: "info", in_review: "info", accepted: "success", reopened: "warning",
};

export interface PhaseWizardProps {
  workspace: WizardWorkspace;
  /** Renders one enabled action of a stage (questions, documents, audio, team files). */
  renderAction: (action: StageActionKey, stage: WizardStage, readOnly: boolean) => ReactNode;
  /** Optional extras under a phase's actions (for example the phase ZIP download). */
  renderStageExtras?: (stage: WizardStage) => ReactNode;
  onNext: (stage: WizardStage) => Promise<void>;
  onSubmit: (stage: WizardStage, ack: { accepted: true; textSha256: string } | undefined) => Promise<void>;
  busy: boolean;
  /** Announced error from the last action (already mapped to a customer message). */
  error: string | null;
  /** Files selected, uploading or with an unknown outcome in a phase, optionally for one kind (files_engineer's `onPendingChange`). */
  pendingUploads?: (stageKey: string, kind?: "document" | "audio") => number;
  /** Files the customer already uploaded in a phase (documents / audio), for the step state and the summary. */
  uploadCounts?: (stageKey: string) => { documents: number; audio: number };
  /** False while the data the steps depend on (questions, uploads) is still loading; the steps resume once it is known. */
  factsReady?: (stage: WizardStage) => boolean;
  /** The single useful action on a waiting screen other than payment (for example the page's status actions). */
  waitingAction?: (kind: WaitingKind) => ReactNode;
  /** Shown when every phase is complete (for example "Download your deliverables"); a default message otherwise. */
  completion?: ReactNode;
  /** Required questions without a saved answer in a phase. */
  unansweredRequired?: (stage: WizardStage) => readonly UnansweredQuestion[];
  /** Questions configured or assigned to a phase (null when unknown). With 0 the Questions step is left out. */
  questionCount?: (stage: WizardStage) => number | null;
  /** Shown when the phase waits for payment: the pay-invoice link, or that the invoice is being prepared. */
  paymentAction?: ReactNode;
  /** Replaces the current phase's panel (derived workflows: the order-level wizard); earlier phases still open read-only. */
  currentBody?: ReactNode;
  /** Polite announcement of changes found when the workspace was read again. */
  announcement?: string | null;
}

export function PhaseWizard({ workspace, renderAction, renderStageExtras, onNext, onSubmit, busy, error, pendingUploads, unansweredRequired, questionCount, uploadCounts, factsReady, paymentAction, waitingAction, completion, currentBody, announcement }: PhaseWizardProps) {
  const current = currentStage(workspace);
  const [viewKey, setViewKey] = useState<string | null>(null);
  /** Set when leaving the current phase would discard selected files (the panels unmount); bumps focus. */
  const [leaveBlock, setLeaveBlock] = useState(0);
  /** Bumped when the shown phase changes without a route change, so focus moves to the new heading. */
  const [focusToken, setFocusToken] = useState(0);
  const show = (key: string | null) => { setViewKey(key); setFocusToken((n) => n + 1); };
  const doneRef = useRef<HTMLDivElement>(null);
  const after = (action: Promise<void>) => action.then(() => show(null));
  const viewed = workspace.stages.find((s) => s.key === viewKey && s.viewable) ?? current;
  useEffect(() => { if (focusToken && !viewed) doneRef.current?.focus(); }, [focusToken, viewed]);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="mb-6 flex min-w-0 flex-col gap-4">
      <h2 id={headingId} className="sr-only">Order phases</h2>
      <p role="status" aria-live="polite" className="sr-only">{announcement ?? ""}</p>
      <Card>
        <div className="p-4 sm:p-6">
          <OrderProgress
            percent={workspace.progress.percent}
            stages={progressStages(workspace)}
            currentIndex={workspace.progress.currentIndex}
            canceled={workspace.progress.canceled}
            onStageSelect={(key) => {
              const leaving = key !== workspace.currentStageKey && viewKey === null && current;
              if (leaving && (pendingUploads?.(current.key) ?? 0) > 0) { setLeaveBlock((n) => n + 1); return; }
              show(key === workspace.currentStageKey ? null : key);
            }}
          />
        </div>
      </Card>
      {workspace.progress.canceled ? (
        <Callout tone="info">This order was canceled. Progress is shown as it was; the phases can still be read.</Callout>
      ) : null}
      {currentBody && viewKey === null ? (
        currentBody
      ) : viewed ? (
        <StagePanel
          key={viewed.key}
          workspace={workspace}
          stage={viewed}
          isCurrent={viewed.key === workspace.currentStageKey}
          onBackToCurrent={current && viewed.key !== current.key ? () => show(null) : undefined}
          focusToken={focusToken}
          renderAction={renderAction}
          renderStageExtras={renderStageExtras}
          onNext={(stage) => after(onNext(stage))}
          onSubmit={(stage, ack) => after(onSubmit(stage, ack))}
          busy={busy}
          error={error}
          pendingUploads={pendingUploads}
          unansweredRequired={unansweredRequired}
          questionCount={questionCount}
          uploadCounts={uploadCounts}
          factsReady={factsReady}
          paymentAction={paymentAction}
          waitingAction={waitingAction}
          leaveBlock={leaveBlock}
        />
      ) : (
        <div ref={doneRef} tabIndex={-1} className="outline-none">
          {completion ?? <Callout tone="success" title="All phases are complete">There is nothing more to do here. We'll let you know when your order moves on.</Callout>}
        </div>
      )}
    </section>
  );
}

function StagePanel({ workspace, stage, isCurrent, onBackToCurrent, focusToken, renderAction, renderStageExtras, onNext, onSubmit, busy, error, pendingUploads, unansweredRequired, questionCount, uploadCounts, factsReady, paymentAction, waitingAction, leaveBlock }: {
  workspace: WizardWorkspace; stage: WizardStage; isCurrent: boolean; onBackToCurrent?: () => void; focusToken: number; leaveBlock: number;
} & Omit<PhaseWizardProps, "workspace" | "announcement" | "completion">) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focusToken) headingRef.current?.focus(); }, [focusToken]);
  const writable = isWritable(workspace, stage);
  const actions = enabledActions(stage);
  const reopened = stage.state === "reopened" && writable;
  const working = writable && (stage.canNext || stage.canSubmit);
  const waiting = writable && !working && stage.waitingOn ? stage.waitingOn : null;
  // Leaving the current phase from the stepper would discard selected files; the reason is shown and focused.
  const leaveRef = useRef<HTMLDivElement>(null);
  const seenLeave = useRef(leaveBlock);
  const [leaveShown, setLeaveShown] = useState(false);
  const pending = writable ? (pendingUploads?.(stage.key) ?? 0) : 0;
  useEffect(() => {
    if (leaveBlock === seenLeave.current) return;
    seenLeave.current = leaveBlock;
    setLeaveShown(true);
  }, [leaveBlock]);
  useEffect(() => { if (leaveShown) leaveRef.current?.focus(); }, [leaveShown, leaveBlock]);

  return (
    <Card>
      <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 ref={headingRef} tabIndex={-1} className="min-w-0 break-words text-lg font-semibold text-ink outline-none">
            {phaseHeading(stage, workspace.stages.length)}
          </h3>
          <Badge tone={STATE_TONE[stage.state]}>{STATE_LABEL[stage.state]}</Badge>
        </div>
        {onBackToCurrent ? (
          <div>
            <Button variant="link" onClick={onBackToCurrent}>Back to the current phase</Button>
          </div>
        ) : null}
        {!isCurrent && stage.completed ? (
          <Callout tone="info">This phase is complete. You can read what you sent; an administrator can reopen it if something needs to change.</Callout>
        ) : null}
        {isCurrent && stage.locked ? (
          <Callout tone="info">
            You submitted this phase{stage.submittedAt ? <> on <DateTime value={stage.submittedAt} format="date" /></> : null}. It is locked while our team reviews it.
          </Callout>
        ) : null}
        {stage.review?.outcome === "changes_requested" ? (
          <Callout tone="warning" title="Changes requested">
            {stage.review.note ? <p className="ph-no-capture whitespace-pre-line break-words" data-clarity-mask="true">{stage.review.note}</p> : <p>Our team asked for changes in this phase.</p>}
            {stage.locked ? <p className="mt-1">An administrator will reopen the phase so you can make them.</p> : null}
            {reopened ? <p className="mt-1">{REOPENED_TEXT}</p> : null}
          </Callout>
        ) : null}
        {/* An earlier acceptance of a reopened phase belongs in the order history, not next to the reopened notice. */}
        {stage.review?.outcome === "accepted" && stage.state !== "reopened" ? <Callout tone="success">Our team accepted this phase.</Callout> : null}
        {reopened && stage.review?.outcome !== "changes_requested" ? <Callout tone="warning">{REOPENED_TEXT}</Callout> : null}
        {workspace.orderLocked ? <Callout tone="info">The order is locked, so nothing can be changed right now.</Callout> : null}
        {leaveShown && pending > 0 ? (
          <div ref={leaveRef} tabIndex={-1} className="outline-none">
            <Callout tone="warning">{pendingUploadMessage(pending)}</Callout>
          </div>
        ) : null}

        {working ? (
          factsReady && !factsReady(stage) ? (
            <div role="status" aria-label="Loading the steps of this phase"><Skeleton lines={4} /></div>
          ) : (
            <CurrentPhaseSteps
              workspace={workspace}
              stage={stage}
              renderAction={renderAction}
              renderStageExtras={renderStageExtras}
              onNext={onNext}
              onSubmit={onSubmit}
              busy={busy}
              error={error}
              pendingUploads={pendingUploads}
              unansweredRequired={unansweredRequired}
              questionCount={questionCount}
              uploadCounts={uploadCounts}
            />
          )
        ) : waiting ? (
          <>
            <WaitingScreen
              kind={waiting}
              headingLevel={4}
              nextLabel={nextPhaseLabel(workspace, stage)}
              action={waiting === "payment" ? paymentAction : waitingAction?.(waiting)}
            />
            {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
          </>
        ) : (
          <>
            {stage.contentMarkdown ? (
              <div className="min-w-0 break-words">
                <h4 className="mb-2 text-base font-semibold text-ink">Instructions</h4>
                <SafePolicyText bodyText={stage.contentMarkdown} format="safe_markdown" />
              </div>
            ) : null}
            {actions.map((a) => (
              <div key={a.key} className="min-w-0 border-t border-line pt-4">
                {/* The questions panel brings its own heading (level 4, set by the container). */}
                {a.key === "answerQuestions" ? null : <h4 className="mb-2 text-base font-semibold text-ink">{a.title}</h4>}
                {renderAction(a.key, stage, true)}
              </div>
            ))}
            {renderStageExtras ? renderStageExtras(stage) : null}
            {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
          </>
        )}
      </div>
    </Card>
  );
}

/** "Phase 2 of 3: Synthesis" — distinct from the steps inside a phase ("Step 1 of 4: Review and accept"). */
export function phaseHeading(stage: WizardStage, total: number): string {
  return `Phase ${stage.index + 1} of ${total}: ${stage.customerLabel}`;
}

/** The label of the phase after `stage`, for "what happens next". */
function nextPhaseLabel(workspace: WizardWorkspace, stage: WizardStage): string | null {
  return workspace.stages.find((s) => s.index === stage.index + 1)?.customerLabel ?? null;
}

/**
 * Ticked acknowledgements, kept in memory for this browser tab (browser storage is not used by policy). The
 * server records the acknowledgement only with Submit; the key includes the text hash, so changed text asks again.
 */
const ticks = new Set<string>();
function readFlag(key: string): boolean { return ticks.has(key); }
function writeFlag(key: string, on: boolean): void { if (on) ticks.add(key); else ticks.delete(key); }

/** The steps of the current, writable phase: accept → questions → documents → audio → review and submit. */
function CurrentPhaseSteps({ workspace, stage, renderAction, renderStageExtras, onNext, onSubmit, busy, error, pendingUploads, unansweredRequired, questionCount, uploadCounts }: {
  workspace: WizardWorkspace; stage: WizardStage;
} & Pick<PhaseWizardProps, "renderAction" | "renderStageExtras" | "onNext" | "onSubmit" | "busy" | "error" | "pendingUploads" | "unansweredRequired" | "questionCount" | "uploadCounts">) {
  const policy = stage.acknowledgement.policy;
  const hash = stage.acknowledgement.textSha256;
  const storageKey = ackStorageKey(workspace.orderId, stage.key, hash);
  const [ticked, setTicked] = useState(() => policy !== "none" && readFlag(storageKey));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const checkboxId = `ack-${useId().replace(/:/g, "")}`;
  const unanswered = stage.actions.answerQuestions ? (unansweredRequired?.(stage) ?? []) : [];
  const counts = uploadCounts?.(stage.key) ?? { documents: 0, audio: 0 };
  const steps = buildSteps({
    accept: { present: Boolean(stage.contentMarkdown) || policy !== "none" || stage.actions.teamFileReview, required: policy === "required" ? 1 : 0, provided: ticked ? 1 : 0 },
    questions: { present: stage.actions.answerQuestions && (questionCount?.(stage) ?? 1) > 0, required: unanswered.length, provided: 0 },
    documents: { present: stage.actions.uploadDocuments, required: 0, provided: counts.documents, pending: pendingUploads?.(stage.key, "document") ?? 0 },
    audio: { present: stage.actions.recordAudio || stage.actions.uploadAudio, required: 0, provided: counts.audio, pending: pendingUploads?.(stage.key, "audio") ?? 0 },
  });
  const [initialIndex] = useState(() => resumeIndex(steps));
  const open = openRequirements(steps);
  const submitLock = stage.progression === "submit_lock";
  const ack = policy !== "none" && ticked && hash ? { accepted: true as const, textSha256: hash } : undefined;

  const renderStep = (key: WizardStepKey): ReactNode => {
    switch (key) {
      case "accept":
        return (
          <div className="flex min-w-0 flex-col gap-4">
            {stage.contentMarkdown ? (
              <div className="min-w-0 break-words">
                <h5 className="mb-2 text-sm font-semibold text-ink">Instructions</h5>
                <SafePolicyText bodyText={stage.contentMarkdown} format="safe_markdown" />
              </div>
            ) : null}
            {stage.actions.teamFileReview ? (
              <div className="min-w-0">
                <h5 className="mb-2 text-sm font-semibold text-ink">Files from our team</h5>
                {renderAction("teamFileReview", stage, false)}
              </div>
            ) : null}
            {policy !== "none" ? (
              <div className="flex min-w-0 flex-col gap-2">
                <p className="whitespace-pre-line break-words text-body">{ackText(stage)}</p>
                <Checkbox
                  id={checkboxId}
                  label={policy === "required" ? "I have read and accept this" : "I have read this (optional)"}
                  checked={ticked}
                  onCheckedChange={(v) => { const on = v === true; setTicked(on); writeFlag(storageKey, on); }}
                  required={policy === "required"}
                />
              </div>
            ) : null}
          </div>
        );
      case "questions":
        return renderAction("answerQuestions", stage, false);
      case "documents":
        return renderAction("uploadDocuments", stage, false);
      case "audio":
        return (
          <div className="flex min-w-0 flex-col gap-4">
            {stage.actions.recordAudio ? (
              <div className="min-w-0">
                {stage.actions.uploadAudio ? <h5 className="mb-2 text-sm font-semibold text-ink">Record audio</h5> : null}
                {renderAction("recordAudio", stage, false)}
              </div>
            ) : null}
            {stage.actions.uploadAudio ? (
              <div className="min-w-0">
                {stage.actions.recordAudio ? <h5 className="mb-2 text-sm font-semibold text-ink">Upload audio</h5> : null}
                {renderAction("uploadAudio", stage, false)}
              </div>
            ) : null}
          </div>
        );
      case "review":
        return (
          <div className="flex min-w-0 flex-col gap-4">
            <ul className="grid min-w-0 gap-2" aria-label="What you provided">
              {steps.filter((s) => s.key !== "review").map((s) => (
                <li key={s.key} className="flex min-w-0 flex-col gap-0.5 rounded-[var(--radius-control)] border border-line p-3 sm:flex-row sm:justify-between sm:gap-3">
                  <span className="font-medium text-ink">{s.title}</span>
                  <span className="break-words text-sm text-body">{summaryLine(s.key, s.complete, { policy, ticked, unanswered: unanswered.length, ...counts })}</span>
                </li>
              ))}
            </ul>
            {renderStageExtras ? renderStageExtras(stage) : null}
            <p className="text-sm text-body">
              {submitLock
                ? "When you submit, this phase is locked. You can still read what you sent; an administrator can reopen it if something needs to change."
                : "When you finish this phase, the order moves on to the next phase."}
            </p>
          </div>
        );
    }
  };

  return (
    <>
      <StepWizard
        label={`Steps in ${stage.customerLabel}`}
        steps={steps}
        initialIndex={initialIndex}
        renderStep={renderStep}
        summaryRef={summaryRef}
        errors={error ? [{ message: error }, ...open.map((s) => ({ message: `${s.title}: ${s.blockedReason ?? ""}`, step: s.key }))] : []}
        final={{
          label: submitLock ? "Submit" : "Finish this phase",
          busy,
          disabledReason: open.length ? "Complete the steps marked Not done first." : null,
          run: () => (submitLock ? setConfirmOpen(true) : void onNext(stage).catch(() => undefined)),
        }}
      />
      <SubmitConfirmDialog
        open={confirmOpen}
        stage={stage}
        busy={busy}
        returnFocusRef={summaryRef}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={async () => {
          await onSubmit(stage, ack).then(() => { writeFlag(storageKey, false); setConfirmOpen(false); }).catch(() => setConfirmOpen(false));
        }}
      />
    </>
  );
}

function summaryLine(key: WizardStepKey, complete: boolean, f: { policy: WizardStage["acknowledgement"]["policy"]; ticked: boolean; unanswered: number; documents: number; audio: number }): string {
  const files = (n: number, noun: string) => (n === 0 ? `No ${noun}s uploaded yet` : n === 1 ? `1 ${noun} uploaded` : `${n} ${noun}s uploaded`);
  switch (key) {
    case "accept": return f.policy === "none" ? "Read" : f.ticked ? "Accepted" : f.policy === "required" ? "Not accepted yet" : "Read (not ticked)";
    case "questions": return complete ? "All required questions answered" : f.unanswered === 1 ? "1 required question not answered" : `${f.unanswered} required questions not answered`;
    case "documents": return files(f.documents, "file");
    case "audio": return files(f.audio, "audio file");
    case "review": return "";
  }
}

/** Last step: confirm that Submit locks the phase. The acknowledgement itself was given in "Review and accept". */
export function SubmitConfirmDialog({ open, stage, busy, onCancel, onConfirm, returnFocusRef }: {
  open: boolean; stage: WizardStage; busy: boolean; onCancel: () => void; onConfirm: () => Promise<void>;
  /** On close, focus this (the error summary after a failed submit) before the Submit opener. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog
      open={open}
      returnFocusRef={returnFocusRef}
      onOpenChange={(next) => { if (!next && !busy) onCancel(); }}
      dismissible={!busy}
      title={`Submit and lock “${stage.customerLabel}”?`}
      description="After you submit, this phase is locked for changes."
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={() => void onConfirm()} loading={busy}>Submit</Button>
        </>
      }
    >
      <p className="whitespace-pre-line break-words text-body">{STANDARD_ACK_MESSAGE}</p>
    </Dialog>
  );
}

/**
 * "Submit and lock" confirmation. Required policy: the box must be ticked; optional: may be ticked (evidence
 * recorded only when ticked); none: a plain confirmation that the phase will lock.
 */
export function AcknowledgementDialog({ open, stage, busy, onCancel, onConfirm }: {
  open: boolean; stage: WizardStage; busy: boolean; onCancel: () => void;
  onConfirm: (ack: { accepted: true; textSha256: string } | undefined) => Promise<void>;
}) {
  const policy = stage.acknowledgement.policy;
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkboxId = `ack-${useId().replace(/:/g, "")}`;
  const hash = stage.acknowledgement.textSha256;
  const cancel = () => { setChecked(false); setError(null); onCancel(); };
  const confirm = async () => {
    if (policy === "required" && !checked) {
      setError("Please tick the box to confirm.");
      document.getElementById(checkboxId)?.focus();
      return;
    }
    setError(null);
    await onConfirm(policy !== "none" && checked && hash ? { accepted: true, textSha256: hash } : undefined);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) cancel(); }}
      dismissible={!busy}
      title={`Submit and lock “${stage.customerLabel}”?`}
      description="After you submit, this phase is locked for changes."
      footer={
        <>
          <Button variant="secondary" onClick={cancel} disabled={busy}>Cancel</Button>
          <Button onClick={() => void confirm()} loading={busy}>Submit and lock</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="whitespace-pre-line break-words text-body">{ackText(stage)}</p>
        {policy !== "none" ? (
          <Checkbox
            id={checkboxId}
            label={policy === "required" ? "I have read and accept this" : "I have read this (optional)"}
            checked={checked}
            onCheckedChange={(v) => { setChecked(v === true); setError(null); }}
            required={policy === "required"}
            error={error ?? undefined}
          />
        ) : null}
        <p role="alert" className="sr-only">{error ?? ""}</p>
      </div>
    </Dialog>
  );
}
