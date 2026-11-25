/**
 * D4 customer phase wizard — container (package E, audit_engineer). Mounted on the customer order page at the
 * "increment 07 customer phase mount" anchor of OrderDetailView. Reads `orders.stages.workspace` and calls
 * `next` / `submit`; the action panels belong to assurance (questions) and files_engineer (uploads, team files).
 * If the workspace cannot be read, the previous checklist (`fallback`) is shown so the page keeps working.
 * The workspace is read again on window focus and every 30 s while the page is visible; changes made elsewhere
 * are announced politely (lead QA ruling 9).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { StageActionKey } from "@shared/workflowStages";
import { safeError, useTRPC } from "@/lib/trpc";
import { Link } from "wouter";
import { Skeleton } from "@/ui";
import { PhaseArchiveAction } from "../../files/archives/ArchiveAction";
import { PhaseTeamFiles, PhaseUploadPanel } from "../../files/PhaseFiles";
import { PhaseWizard, type UnansweredQuestion } from "./PhaseWizard";
import { StageQuestions } from "./StageQuestions";
import {
  INVOICE_PREPARING_MESSAGE, REFRESH_CODES, currentStage, describeWorkspaceChange, isWritable, wizardErrorMessage, type WizardStage, type WizardWorkspace,
} from "./wizardModel";

export const WORKSPACE_REFRESH_MS = 30_000;
type UploadIntent = "document" | "recording" | "prerecorded_audio";

export function CustomerPhaseWizard({ orderId, fallback }: { orderId: string; fallback?: ReactNode }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const workspaceQuery = useQuery({
    ...trpc.orders.stages.workspace.queryOptions({ orderId }),
    refetchOnWindowFocus: true,
    refetchInterval: WORKSPACE_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
  const next = useMutation(trpc.orders.stages.next.mutationOptions());
  const submit = useMutation(trpc.orders.stages.submit.mutationOptions());
  const [error, setError] = useState<string | null>(null);

  // Upload panels report files that are selected, in flight or unknown; keyed by phase and intent.
  const [pending, setPending] = useState<Record<string, number>>({});
  const pendingCallbacks = useRef(new Map<string, (count: number) => void>());
  const onPendingFor = useCallback((stageKey: string, intent: UploadIntent) => {
    const key = `${stageKey}:${intent}`;
    let cb = pendingCallbacks.current.get(key);
    if (!cb) {
      cb = (count: number) => setPending((prev) => (prev[key] === count ? prev : { ...prev, [key]: count }));
      pendingCallbacks.current.set(key, cb);
    }
    return cb;
  }, []);
  const pendingUploads = useCallback(
    (stageKey: string) => Object.entries(pending).reduce((sum, [key, n]) => (key.startsWith(`${stageKey}:`) ? sum + n : sum), 0),
    [pending],
  );

  // Changes found by a later read (not caused by this page's own Next / Submit) are announced politely.
  const data: WizardWorkspace | undefined = workspaceQuery.data;
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const previous = useRef<WizardWorkspace | undefined>(undefined);
  const ownVersion = useRef<number | null>(null);
  useEffect(() => {
    if (!data) return;
    const before = previous.current;
    previous.current = data;
    if (!before || before.version === data.version) return;
    // The order row moved on (staff accept, payment, …): the page header and lists read the same row, so read them again.
    void client.invalidateQueries({ queryKey: trpc.orders.get.queryKey({ orderId }) });
    void client.invalidateQueries({ queryKey: trpc.orders.list.queryKey() });
    if (ownVersion.current === data.version) return;
    const change = describeWorkspaceChange(before, data);
    if (change) setAnnouncement(change);
  }, [data, client, trpc, orderId]);

  // Required questions of the current writable phase (same cache as the questions panel).
  const current = data ? currentStage(data) : null;
  const questionsOn = Boolean(data && current && current.actions.answerQuestions && isWritable(data, current));
  const questions = useQuery({
    ...trpc.orders.questions.customerList.queryOptions({ orderId, stageKey: current?.key ?? "" }),
    enabled: questionsOn,
  });
  const unansweredRequired = (stage: WizardStage): readonly UnansweredQuestion[] =>
    questionsOn && stage.key === current?.key && questions.data
      ? questions.data.questions.filter((q) => q.required && !q.latestAnswer).map((q) => ({ questionId: q.questionId, prompt: q.prompt }))
      : [];

  // A phase that waits for payment links to the first payable invoice (its page has "Pay online").
  const waitsForPayment = current?.waitingOn === "payment";
  const invoices = useQuery({ ...trpc.compliance.invoices.listForOrder.queryOptions({ orderPublicId: orderId }), enabled: waitsForPayment });
  const payable = waitsForPayment
    ? invoices.data?.items.find((inv) => inv.status === "issued" && inv.issuedAt !== null && inv.balanceDueMinor > 0)
    : undefined;

  if (workspaceQuery.isPending) return <div role="status" aria-label="Loading order phases" className="mb-6"><Skeleton lines={4} /></div>;
  if (workspaceQuery.error || !workspaceQuery.data) return <>{fallback ?? null}</>;
  const workspace = workspaceQuery.data;

  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: trpc.orders.stages.workspace.queryKey({ orderId }) }),
      client.invalidateQueries({ queryKey: trpc.orders.get.queryKey({ orderId }) }),
      client.invalidateQueries({ queryKey: trpc.orders.list.queryKey() }),
    ]);
  };
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      const result = await action();
      if (result && typeof result === "object" && "version" in result && typeof result.version === "number") ownVersion.current = result.version;
      await refresh();
    } catch (e) {
      const safe = safeError(e);
      setError(wizardErrorMessage(safe?.reasonCode, safe?.safeMessage));
      if (safe?.reasonCode && REFRESH_CODES.has(safe.reasonCode)) await refresh();
      throw e;
    }
  };

  const renderAction = (action: StageActionKey, stage: WizardStage, readOnly: boolean): ReactNode => {
    const scope = { orderId, stageKey: stage.key };
    const changed = () => void client.invalidateQueries({ queryKey: trpc.orders.stages.workspace.queryKey({ orderId }) });
    switch (action) {
      case "answerQuestions": return <StageQuestions {...scope} readOnly={readOnly} headingLevel={4} />;
      case "uploadDocuments": return <PhaseUploadPanel {...scope} intent="document" readOnly={readOnly} onChanged={changed} onPendingChange={onPendingFor(stage.key, "document")} />;
      case "recordAudio": return <PhaseUploadPanel {...scope} intent="recording" readOnly={readOnly} onChanged={changed} onPendingChange={onPendingFor(stage.key, "recording")} />;
      case "uploadAudio": return <PhaseUploadPanel {...scope} intent="prerecorded_audio" readOnly={readOnly} onChanged={changed} onPendingChange={onPendingFor(stage.key, "prerecorded_audio")} />;
      case "teamFileReview": return <PhaseTeamFiles {...scope} />;
    }
  };

  return (
    <PhaseWizard
      workspace={workspace}
      renderAction={renderAction}
      renderStageExtras={(stage) =>
        hasFileActions(stage) ? (
          <div className="border-t border-line pt-4">
            <PhaseArchiveAction orderId={orderId} stageKey={stage.key} phaseName={stage.customerLabel} />
          </div>
        ) : null}
      busy={next.isPending || submit.isPending}
      error={error}
      pendingUploads={pendingUploads}
      unansweredRequired={unansweredRequired}
      announcement={announcement}
      paymentAction={payable ? (
        <Link href={`/invoices/${encodeURIComponent(payable.invoicePublicId)}`} className="inline-flex min-h-11 items-center font-semibold text-action underline underline-offset-2">
          {payable.invoiceNumber ? `Pay invoice ${payable.invoiceNumber}` : "Pay the outstanding invoice"}
        </Link>
      ) : invoices.isSuccess && waitsForPayment ? <p>{INVOICE_PREPARING_MESSAGE}</p> : null}
      onNext={(stage) => run(() => next.mutateAsync({ orderId, stageKey: stage.key, expectedVersion: workspace.version }))}
      onSubmit={(stage, ack) => run(() => submit.mutateAsync({ orderId, stageKey: stage.key, expectedVersion: workspace.version, ...(ack ? { ack } : {}) }))}
    />
  );
}

/** The phase ZIP is offered where the phase lists files; the server decides what it may contain. */
export function hasFileActions(stage: WizardStage): boolean {
  return stage.actions.uploadDocuments || stage.actions.recordAudio || stage.actions.uploadAudio || stage.actions.teamFileReview;
}
