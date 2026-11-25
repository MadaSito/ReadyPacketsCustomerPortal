/**
 * D4 customer phase wizard — view (package E, audit_engineer). Pure presentation: the container
 * (`CustomerPhaseWizard`) supplies the workspace, the mutations and the action panels of other owners
 * (questions: assurance; files: files_engineer). The server enforces every rule; the client only shows them.
 */
import { useId, useState, type ReactNode } from "react";
import type { StageActionKey } from "@shared/workflowStages";
import { SafePolicyText } from "@/lib/agreementGate";
import { Badge, Button, Callout, Card, Checkbox, DateTime, Dialog, OrderProgress, type Tone } from "@/ui";
import {
  STATE_LABEL, ackText, currentStage, enabledActions, isWritable, progressStages,
  type WizardStage, type WizardWorkspace,
} from "./wizardModel";

const STATE_TONE: Record<WizardStage["state"], Tone> = {
  future: "neutral", open: "brand", submitted: "info", in_review: "info", accepted: "success", reopened: "warning",
};

export interface PhaseWizardProps {
  workspace: WizardWorkspace;
  /** Renders one enabled action of a stage (questions, documents, audio, team files). */
  renderAction: (action: StageActionKey, stage: WizardStage, readOnly: boolean) => ReactNode;
  onNext: (stage: WizardStage) => Promise<void>;
  onSubmit: (stage: WizardStage, ack: { accepted: true; textSha256: string } | undefined) => Promise<void>;
  busy: boolean;
  /** Announced error from the last action (already mapped to a customer message). */
  error: string | null;
}

export function PhaseWizard({ workspace, renderAction, onNext, onSubmit, busy, error }: PhaseWizardProps) {
  const current = currentStage(workspace);
  const [viewKey, setViewKey] = useState<string | null>(null);
  const viewed = workspace.stages.find((s) => s.key === viewKey && s.viewable) ?? current;
  const total = workspace.stages.length;
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="mb-6 flex min-w-0 flex-col gap-4">
      <h2 id={headingId} className="sr-only">Order phases</h2>
      <Card>
        <div className="p-4 sm:p-6">
          <OrderProgress
            percent={workspace.progress.percent}
            stages={progressStages(workspace)}
            currentIndex={workspace.progress.currentIndex}
            canceled={workspace.progress.canceled}
            onStageSelect={(key) => setViewKey(key === workspace.currentStageKey ? null : key)}
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
          onBackToCurrent={current && viewed.key !== current.key ? () => setViewKey(null) : undefined}
          renderAction={renderAction}
          onNext={onNext}
          onSubmit={onSubmit}
          busy={busy}
          error={error}
        />
      ) : (
        <Callout tone="success" title="All phases are complete">There is nothing more to do here. We'll let you know when your order moves on.</Callout>
      )}
    </section>
  );
}

function StagePanel({ workspace, stage, total, isCurrent, onBackToCurrent, renderAction, onNext, onSubmit, busy, error }: {
  workspace: WizardWorkspace; stage: WizardStage; total: number; isCurrent: boolean; onBackToCurrent?: () => void;
} & Omit<PhaseWizardProps, "workspace">) {
  const writable = isWritable(workspace, stage);
  const readOnly = !writable;
  const [ackOpen, setAckOpen] = useState(false);
  const actions = enabledActions(stage);

  return (
    <Card
      headingLevel={3}
      title={`Phase ${stage.index + 1} of ${total}: ${stage.customerLabel}`}
      actions={<Badge tone={STATE_TONE[stage.state]}>{STATE_LABEL[stage.state]}</Badge>}
    >
      <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
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
            {stage.review.note ? <p className="whitespace-pre-line break-words">{stage.review.note}</p> : <p>Our team asked for changes in this phase.</p>}
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
              <h4 className="mb-2 text-base font-semibold text-ink">{a.title}</h4>
              {renderAction(a.key, stage, readOnly)}
            </div>
          ))
        ) : isCurrent ? (
          <p className="text-body">There is nothing to upload or answer in this phase.</p>
        ) : null}

        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}

        {writable && (stage.canNext || stage.canSubmit) ? (
          <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-end">
            {stage.progression === "submit_lock" && stage.canSubmit ? (
              <Button size="lg" onClick={() => setAckOpen(true)} disabled={busy}>Submit and lock</Button>
            ) : stage.canNext ? (
              <Button size="lg" onClick={() => void onNext(stage).catch(() => undefined)} loading={busy}>Next</Button>
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
  const hash = stage.acknowledgement.textSha256;
  const confirm = async () => {
    if (policy === "required" && !checked) return setError("Please tick the box to confirm.");
    setError(null);
    await onConfirm(policy !== "none" && checked && hash ? { accepted: true, textSha256: hash } : undefined);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) { setChecked(false); setError(null); onCancel(); } }}
      title={`Submit and lock “${stage.customerLabel}”?`}
      description="After you submit, this phase is locked for changes."
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={() => void confirm()} loading={busy}>Submit and lock</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="whitespace-pre-line break-words text-body">{ackText(stage)}</p>
        {policy !== "none" ? (
          <Checkbox
            label={policy === "required" ? "I have read and accept this" : "I have read this (optional)"}
            checked={checked}
            onCheckedChange={(v) => { setChecked(v === true); setError(null); }}
            required={policy === "required"}
            error={error ?? undefined}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
