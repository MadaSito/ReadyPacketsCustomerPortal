import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useId, useRef, useState, type ComponentType, type FormEvent, type ReactNode, type RefObject } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Checkbox, DateTime, Dialog, Field, Select, Skeleton, Textarea, useStepUp, useToast } from "@/ui";
import { WorkflowRulesPanel } from "../WorkflowRulesPanel";
import { AdminPhaseChecklist, StaffPhaseQuestions } from "./PhaseConsoleWork";

type Workspace = inferRouterOutputs<AppRouter>["orders"]["stages"]["workspace"];
type Phase = Workspace["stages"][number];
type Command = "accept" | "request_changes" | "reopen";
type ActionsProps = { orderId: string; stageKey: string };
const loaders = import.meta.glob<{ default: ComponentType<ActionsProps> }>("../../automations/OrderWorkflowStageActionsPanel.tsx");
const loader = loaders["../../automations/OrderWorkflowStageActionsPanel.tsx"];
const PhaseActions = loader ? lazy(loader) : null;

const COMMAND_LABELS: Record<Command, string> = {
  accept: "Accept submission",
  request_changes: "Request changes",
  reopen: "Reopen phase",
};

function stateLabel(phase: Phase) {
  if (phase.state === "future") return "Not reached";
  if (phase.state === "reopened") return "Reopened";
  if (phase.review?.outcome === "changes_requested") return "Changes requested";
  if (phase.state === "submitted") return "Submitted";
  if (phase.state === "in_review") return "In review";
  if (phase.state === "accepted" || phase.completed) return "Complete";
  return "Open";
}

function PhaseDecisionDialog({ command, orderId, stageKey, expectedVersion, onClose, refresh, returnFocusRef }: {
  command: Command; orderId: string; stageKey: string; expectedVersion: number;
  onClose: () => void; refresh: () => Promise<unknown>;
  returnFocusRef: RefObject<HTMLHeadingElement | null>;
}) {
  const trpc = useTRPC();
  const stepUp = useStepUp();
  const toast = useToast();
  const reopen = useMutation(trpc.orders.stages.reopen.mutationOptions());
  const review = useMutation(trpc.orders.stages.review.mutationOptions());
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [textError, setTextError] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [requestError, setRequestError] = useState("");
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const confirmId = useId();
  const formId = useId();
  const busy = useRef(false);
  const reasonNeeded = command === "reopen";
  const changes = command === "request_changes";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const text = note.trim();
    setRequestError("");
    setConfirmError("");
    setTextError("");
    if ((reasonNeeded && text.length < 10) || (changes && !text)) {
      setTextError(reasonNeeded ? "Enter a reason of at least 10 characters." : "Explain what the customer needs to change.");
      noteRef.current?.focus();
      return;
    }
    if (reasonNeeded && !confirmed) {
      setConfirmError("Confirm that you want to return this phase to the customer.");
      document.getElementById(confirmId)?.focus();
      return;
    }
    busy.current = true;
    setWorking(true);
    try {
      const ref = { orderId, stageKey, expectedVersion };
      if (reasonNeeded) {
        await stepUp.run(() => reopen.mutateAsync({ ...ref, reason: text, confirm: true }), { reason: "Confirm your identity before reopening this phase." });
      } else {
        await review.mutateAsync({ ...ref, outcome: changes ? "changes_requested" : "accepted", ...(text ? { note: text } : {}) });
      }
      toast.show({ tone: "success", title: reasonNeeded ? "Phase reopened" : changes ? "Changes requested" : "Submission accepted" });
      onClose();
      await refresh();
    } catch (cause) {
      setRequestError(errorMessage(cause));
      if (safeError(cause)?.reasonCode === "STALE_VERSION") await refresh();
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !working) onClose(); }} title={COMMAND_LABELS[command]}
      initialFocusRef={noteRef} returnFocusRef={returnFocusRef} dismissible={!working}
      description={reasonNeeded ? "The customer can edit this phase again. The reason is recorded for staff." : changes
        ? "Record what needs to change. An administrator must reopen the phase before the customer can edit it."
        : "Record your review of the submitted phase."}
      footer={<div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={working} onClick={onClose}>Cancel</Button>
        <Button form={formId} type="submit" loading={working}>{COMMAND_LABELS[command]}</Button>
      </div>}>
      <form id={formId} onSubmit={(event) => void submit(event)} noValidate
        className="ph-no-capture space-y-4" data-clarity-mask="true">
        <Field label={reasonNeeded ? "Reason for reopening" : changes ? "What needs to change?" : "Review note (optional)"}
          hint={reasonNeeded ? "10–500 characters." : "Up to 2,000 characters."} required={reasonNeeded || changes} error={textError}>
          <Textarea ref={noteRef} maxLength={reasonNeeded ? 500 : 2_000} value={note} readOnly={working}
            onChange={(event) => { setNote(event.target.value); setTextError(""); }} />
        </Field>
        {reasonNeeded ? <Checkbox id={confirmId} label="I confirm that the customer can edit this phase again"
          checked={confirmed} disabled={working} required error={confirmError}
          onCheckedChange={(checked) => { setConfirmed(checked); setConfirmError(""); }} /> : null}
        <p role="alert" className="sr-only">{textError || confirmError}</p>
        {requestError ? <Callout tone="danger" live="assertive">{requestError}</Callout> : null}
      </form>
    </Dialog>
  );
}

function PhaseContent({ phase, workspace, renderActions }: { phase: Phase; workspace: Workspace; renderActions?: (stageKey: string) => ReactNode }) {
  const trpc = useTRPC();
  const cache = useQueryClient();
  const phaseHeading = useRef<HTMLHeadingElement>(null);
  const [decision, setDecision] = useState<{ command: Command; expectedVersion: number } | null>(null);
  const { orderId } = workspace;
  const stageKey = phase.key;
  const refresh = () => Promise.all([
    cache.invalidateQueries({ queryKey: trpc.orders.stages.workspace.queryKey({ orderId }) }),
    cache.invalidateQueries({ queryKey: trpc.orders.questions.list.queryKey({ orderId, stageKey }) }),
    cache.invalidateQueries({ queryKey: trpc.orders.admin.get.queryKey({ orderId }) }),
  ]);
  function open(command: Command) {
    setDecision({ command, expectedVersion: workspace.version });
  }
  const actions = renderActions ? renderActions(stageKey) : PhaseActions
    ? <Suspense fallback={<><p role="status" className="sr-only">Loading phase actions</p><Skeleton lines={2} /></>}>
        <PhaseActions orderId={orderId} stageKey={stageKey} />
      </Suspense>
    : null;
  return (
    <div className="min-w-0 space-y-5">
      <div className="space-y-3">
        <div className="flex flex-wrap items-start gap-2">
          <h3 ref={phaseHeading} tabIndex={-1} className="min-w-0 font-semibold break-words text-ink">{phase.staffLabel ?? phase.customerLabel}</h3>
          <Badge tone={phase.review?.outcome === "changes_requested" ? "warning" : "neutral"}>{stateLabel(phase)}</Badge>
          {phase.locked ? <Badge tone="neutral">Locked</Badge> : null}
        </div>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="font-medium text-ink">Submission</dt>
            <dd className="text-muted">{phase.submittedAt ? <DateTime value={phase.submittedAt} /> : "No submission recorded."}</dd>
          </div>
          {phase.review ? (
            <div className="ph-no-capture" data-clarity-mask="true">
              <dt className="font-medium text-ink">Last review</dt>
              <dd className="text-muted">
                {phase.review.outcome === "accepted" ? "Accepted" : "Changes requested"} · <DateTime value={phase.review.at} />
                {phase.review.note ? <p className="mt-1 whitespace-pre-wrap break-words text-body">{phase.review.note}</p> : null}
              </dd>
            </div>
          ) : null}
        </dl>
        {phase.canReview || phase.canReopen ? <div className="flex flex-wrap gap-2">
          {phase.canReview ? <>
            <Button onClick={() => open("accept")}>Accept submission</Button>
            <Button variant="secondary" onClick={() => open("request_changes")}>Request changes</Button>
          </> : null}
          {phase.canReopen ? <Button variant="secondary" onClick={() => open("reopen")}>Reopen phase</Button> : null}
        </div> : null}
      </div>
      {phase.actions.answerQuestions ? <StaffPhaseQuestions orderId={orderId} stageKey={stageKey} /> : null}
      {phase.adminTasks?.length ? <AdminPhaseChecklist orderId={orderId} stageKey={stageKey} /> : null}
      {actions}
      {decision ? <PhaseDecisionDialog {...decision} orderId={orderId} stageKey={stageKey}
        onClose={() => setDecision(null)} refresh={refresh} returnFocusRef={phaseHeading} /> : null}
    </div>
  );
}

export function OrderPhaseConsolePanel({ orderId, renderActions }: { orderId: string; renderActions?: (stageKey: string) => ReactNode }) {
  const trpc = useTRPC();
  const workspace = useQuery(trpc.orders.stages.workspace.queryOptions({ orderId }));
  const [selection, setSelection] = useState<string | null>(null);
  if (workspace.isPending) return <><p role="status" className="sr-only">Loading order phases</p><Skeleton className="h-28" /></>;
  if (workspace.isError) return <Callout tone="danger" live="assertive" title="Could not load order phases"
    actions={<Button variant="secondary" onClick={() => void workspace.refetch()}>Retry</Button>}>{errorMessage(workspace.error)}</Callout>;
  const { stages, currentStageKey } = workspace.data;
  const phase = stages.find((candidate) => candidate.key === (selection ?? currentStageKey)) ?? stages[0];
  return (
    <div className="min-w-0 space-y-4">
      <Card title="Order phases" headingLevel={2}>
        {phase ? (
          <div className="min-w-0 space-y-5">
            <Field label="Select a phase">
              <Select value={phase.key} onChange={(event) => setSelection(event.target.value)}
                options={stages.map((stage) => ({
                  value: stage.key, label: `${stage.index + 1}. ${stage.staffLabel ?? stage.customerLabel}${stage.key === currentStageKey ? " (current)" : ""}`,
                }))} />
            </Field>
            <PhaseContent key={phase.key} phase={phase} workspace={workspace.data} renderActions={renderActions} />
          </div>
        ) : <p className="text-sm text-muted">No phases are associated with this order.</p>}
      </Card>
      {workspace.data.derived ? <WorkflowRulesPanel orderId={orderId} area="console" /> : null}
    </div>
  );
}
