/**
 * D4 customer phase wizard — view (package E, audit_engineer). Pure presentation: the container
 * (`CustomerPhaseWizard`) supplies the workspace, the mutations and the action panels of other owners
 * (questions: assurance; files: files_engineer). The server enforces every rule; the client only shows them.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { StageActionKey } from "@shared/workflowStages";
import { SafePolicyText } from "@/lib/agreementGate";
import { Badge, Button, Callout, Card, Checkbox, DateTime, Dialog, OrderProgress, type Tone } from "@/ui";
import {
  STATE_LABEL, WAITING_MESSAGE, ackText, currentStage, enabledActions, isWritable, pendingUploadMessage, progressStages,
  type WizardStage, type WizardWorkspace,
} from "./wizardModel";

/** A required question the customer has not answered yet (from `orders.questions.customerList`). */
export interface UnansweredQuestion { questionId: string; prompt: string }

/** Why Next / Submit (or leaving the phase) was refused on the client; the live data decides what is still shown. */
type Blocker = "pending" | "questions" | null;

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
  /** Files selected, uploading or with an unknown outcome in a phase (files_engineer's `onPendingChange`). */
  pendingUploads?: (stageKey: string) => number;
  /** Required questions without a saved answer in a phase. */
  unansweredRequired?: (stage: WizardStage) => readonly UnansweredQuestion[];
  /** Link to pay an outstanding invoice, shown when the phase waits for payment. */
  paymentAction?: ReactNode;
  /** Polite announcement of changes found when the workspace was read again. */
  announcement?: string | null;
}

export function PhaseWizard({ workspace, renderAction, renderStageExtras, onNext, onSubmit, busy, error, pendingUploads, unansweredRequired, paymentAction, announcement }: PhaseWizardProps) {
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
  const total = workspace.stages.length;
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
      {viewed ? (
        <StagePanel
          key={viewed.key}
          workspace={workspace}
          stage={viewed}
          total={total}
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
          paymentAction={paymentAction}
          leaveBlock={leaveBlock}
        />
      ) : (
        <div ref={doneRef} tabIndex={-1} className="outline-none">
          <Callout tone="success" title="All phases are complete">There is nothing more to do here. We'll let you know when your order moves on.</Callout>
        </div>
      )}
    </section>
  );
}

function StagePanel({ workspace, stage, total, isCurrent, onBackToCurrent, focusToken, renderAction, renderStageExtras, onNext, onSubmit, busy, error, pendingUploads, unansweredRequired, paymentAction, leaveBlock }: {
  workspace: WizardWorkspace; stage: WizardStage; total: number; isCurrent: boolean; onBackToCurrent?: () => void; focusToken: number; leaveBlock: number;
} & Omit<PhaseWizardProps, "workspace" | "announcement">) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focusToken) headingRef.current?.focus(); }, [focusToken]);
  const writable = isWritable(workspace, stage);
  const readOnly = !writable;
  const [ackOpen, setAckOpen] = useState(false);
  const actions = enabledActions(stage);
  const [blocker, setBlocker] = useState<Blocker>(null);
  const [blockToken, setBlockToken] = useState(0);
  const blockerRef = useRef<HTMLDivElement>(null);
  const blockerId = useId();
  const pending = writable ? (pendingUploads?.(stage.key) ?? 0) : 0;
  const unanswered = writable && stage.actions.answerQuestions ? (unansweredRequired?.(stage) ?? []) : [];
  // What is still true is shown; a blocker disappears once the files are uploaded or the questions answered.
  const shown: Blocker = blocker === "pending" && pending > 0 ? "pending" : blocker === "questions" && unanswered.length > 0 ? "questions" : null;
  const block = (kind: Exclude<Blocker, null>) => { setBlocker(kind); setBlockToken((n) => n + 1); };
  const seenLeave = useRef(leaveBlock);
  useEffect(() => {
    if (leaveBlock === seenLeave.current) return;
    seenLeave.current = leaveBlock;
    setBlocker("pending");
    setBlockToken((n) => n + 1);
  }, [leaveBlock]);
  useEffect(() => {
    if (!blockToken) return;
    if (blocker === "questions" && unanswered[0]) {
      const target = document.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(unanswered[0].questionId)}"]`);
      if (target) { target.focus(); return; }
    }
    blockerRef.current?.focus();
    // Focus only when a new block is raised.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockToken]);
  /** Client-side checks before Next / Submit; the server checks the same rules again. */
  const proceed = (go: () => void) => {
    if (pending > 0) return block("pending");
    if (unanswered.length > 0) return block("questions");
    setBlocker(null);
    go();
  };
  const waiting = writable && !stage.canNext && !stage.canSubmit && stage.waitingOn ? stage.waitingOn : null;

  return (
    <Card>
      <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 ref={headingRef} tabIndex={-1} className="min-w-0 break-words text-lg font-semibold text-ink outline-none">
            {`Phase ${stage.index + 1} of ${total}: ${stage.customerLabel}`}
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
          </Callout>
        ) : null}
        {stage.review?.outcome === "accepted" ? <Callout tone="success">Our team accepted this phase.</Callout> : null}
        {stage.state === "reopened" && writable ? <Callout tone="warning">This phase was reopened. Make your changes, then continue.</Callout> : null}
        {workspace.orderLocked ? <Callout tone="info">The order is locked, so nothing can be changed right now.</Callout> : null}

        {stage.contentMarkdown ? (
          <div className="min-w-0 break-words">
            <h4 className="mb-2 text-base font-semibold text-ink">Instructions</h4>
            <SafePolicyText bodyText={stage.contentMarkdown} format="safe_markdown" />
          </div>
        ) : null}

        {actions.length ? (
          actions.map((a) => (
            <div key={a.key} className="min-w-0 border-t border-line pt-4">
              {/* The questions panel brings its own heading (level 4, set by the container). */}
              {a.key === "answerQuestions" ? null : <h4 className="mb-2 text-base font-semibold text-ink">{a.title}</h4>}
              {renderAction(a.key, stage, readOnly)}
            </div>
          ))
        ) : isCurrent ? (
          <p className="text-body">There is nothing to upload or answer in this phase.</p>
        ) : null}

        {renderStageExtras ? renderStageExtras(stage) : null}

        {waiting ? (
          <Callout tone="info">
            <p>{WAITING_MESSAGE[waiting]}</p>
            {waiting === "payment" && paymentAction ? <div className="mt-2">{paymentAction}</div> : null}
          </Callout>
        ) : null}

        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}

        {shown ? (
          <div ref={blockerRef} id={blockerId} tabIndex={-1} className="outline-none">
            {shown === "pending" ? (
              <Callout tone="warning">{pendingUploadMessage(pending)}</Callout>
            ) : (
              <Callout tone="warning" title="Answer the required questions first">
                <ul className="ml-5 list-disc">
                  {unanswered.map((q) => (
                    <li key={q.questionId} className="ph-no-capture whitespace-pre-wrap break-words" data-clarity-mask="true">
                      <Button
                        variant="link"
                        onClick={() => document.querySelector<HTMLElement>(`[data-question-id="${CSS.escape(q.questionId)}"]`)?.focus()}
                      >
                        {q.prompt}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
          </div>
        ) : null}

        {writable && (stage.canNext || stage.canSubmit) ? (
          <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-end">
            {stage.progression === "submit_lock" && stage.canSubmit ? (
              <Button size="lg" aria-describedby={shown ? blockerId : undefined} onClick={() => proceed(() => setAckOpen(true))} disabled={busy}>Submit and lock</Button>
            ) : stage.canNext ? (
              <Button size="lg" aria-describedby={shown ? blockerId : undefined} onClick={() => proceed(() => void onNext(stage).catch(() => undefined))} loading={busy}>Next</Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <AcknowledgementDialog
        open={ackOpen}
        stage={stage}
        busy={busy}
        onCancel={() => setAckOpen(false)}
        onConfirm={async (ack) => {
          await onSubmit(stage, ack).then(() => setAckOpen(false)).catch(() => setAckOpen(false));
        }}
      />
    </Card>
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
