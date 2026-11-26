/**
 * D4 customer phase wizard — container (package E, audit_engineer). Mounted on the customer order page at the
 * "increment 07 customer phase mount" anchor of OrderDetailView. Reads `orders.stages.workspace` and calls
 * `next` / `submit`; the action panels belong to assurance (questions) and files_engineer (uploads, team files).
 * If the workspace cannot be read, the previous checklist (`fallback`) is shown so the page keeps working.
 * The workspace is read again on window focus and every 30 s while the page is visible; changes made elsewhere
 * are announced politely (lead QA ruling 9).
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { StageActionKey } from "@shared/workflowStages";
import { safeError, useTRPC } from "@/lib/trpc";
import { Link } from "wouter";
import { Skeleton, buttonClasses } from "@/ui";
import { PhaseArchiveAction } from "../../files/archives/ArchiveAction";
import { PhaseTeamFiles, PhaseUploadPanel, PhaseUploadedFiles } from "../../files/PhaseFiles";
import { DerivedOrderWizard } from "./DerivedOrderWizard";
import { PhaseWizard, type UnansweredQuestion } from "./PhaseWizard";
import { StageQuestions } from "./StageQuestions";
import {
  INVOICE_PREPARING_MESSAGE, REFRESH_CODES, currentStage, describeWorkspaceChange, isWritable, wizardErrorMessage, type WaitingKind, type WizardStage, type WizardWorkspace,
} from "./wizardModel";

export const WORKSPACE_REFRESH_MS = 30_000;
export const AUDIO_LISTED_BELOW = "Recordings are listed under Upload audio.";
type UploadIntent = "document" | "recording" | "prerecorded_audio";

export function CustomerPhaseWizard({ orderId, fallback, waitingAction, completion }: {
  orderId: string; fallback?: ReactNode;
  /** The single useful action on a waiting screen (other than payment), supplied by the page. */
  waitingAction?: (kind: WaitingKind) => ReactNode;
  /** Shown when every phase is complete (for example the deliverables link). */
  completion?: ReactNode;
}) {
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
    (stageKey: string, kind?: "document" | "audio") => Object.entries(pending).reduce((sum, [key, n]) => {
      if (!key.startsWith(`${stageKey}:`)) return sum;
      const intent = key.slice(stageKey.length + 1);
      const matches = !kind || (kind === "document" ? intent === "document" : intent !== "document");
      return matches ? sum + n : sum;
    }, 0),
    [pending],
  );

  // Each read of the workspace (30 s, focus, after an action) also refreshes the phase file lists.
  const readAt = workspaceQuery.dataUpdatedAt;
  const firstRead = useRef(true);
  useEffect(() => {
    if (!readAt) return;
    if (firstRead.current) { firstRead.current = false; return; }
    void client.invalidateQueries({ queryKey: trpc.files.list.pathKey() });
  }, [readAt, client, trpc]);

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
  // Questions configured or assigned to the current phase; null while unknown (the step stays until it is known).
  const questionCount = (stage: WizardStage): number | null =>
    questionsOn && stage.key === current?.key && questions.data ? questions.data.questions.length : null;

  // Files already uploaded in the current writable phase (same queries as "Uploaded in this phase").
  const writableCurrent = Boolean(data && current && isWritable(data, current));
  const docsOn = writableCurrent && Boolean(current?.actions.uploadDocuments);
  const audioOn = writableCurrent && Boolean(current && (current.actions.recordAudio || current.actions.uploadAudio));
  const listOptions = { getNextPageParam: (page: { nextCursor: string | null }) => page.nextCursor, retry: false } as const;
  const docFiles = useInfiniteQuery({
    ...trpc.files.list.infiniteQueryOptions({ orderId, stageKey: current?.key ?? "", phaseUploadKind: "document", limit: 25 }, listOptions),
    enabled: docsOn,
  });
  const audioFiles = useInfiniteQuery({
    ...trpc.files.list.infiniteQueryOptions({ orderId, stageKey: current?.key ?? "", phaseUploadKind: "audio", limit: 25 }, listOptions),
    enabled: audioOn,
  });
  const countOf = (pages: readonly { items: readonly UploadedFileLike[] }[] | undefined, audio: boolean) =>
    (pages ?? []).flatMap((p) => p.items).filter((f) => isCustomerUpload(f, audio)).length;
  const uploadCounts = (stageKey: string) =>
    stageKey === current?.key
      ? { documents: countOf(docFiles.data?.pages, false), audio: countOf(audioFiles.data?.pages, true) }
      : { documents: 0, audio: 0 };
  // A list that failed once does not hold the steps back (they show what is known; the server checks again).
  const settled = (q: { isPending: boolean; failureCount: number }) => !q.isPending || q.failureCount > 0;
  const factsReady = (stage: WizardStage) =>
    stage.key !== current?.key ||
    ((!questionsOn || settled(questions)) && (!docsOn || settled(docFiles)) && (!audioOn || settled(audioFiles)));

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
    const changed = () => {
      void client.invalidateQueries({ queryKey: trpc.orders.stages.workspace.queryKey({ orderId }) });
      void client.invalidateQueries({ queryKey: trpc.files.list.pathKey() });
    };
    // Editable: the upload form, then "Uploaded in this phase". Locked: PhaseUploadPanel(readOnly) is that list alone.
    // Recordings and uploaded audio share one list (files keeps the media type, not the intent), shown once.
    const upload = (intent: UploadIntent, list: boolean) => (
      <div className="flex min-w-0 flex-col gap-4">
        {readOnly
          ? (list ? <PhaseUploadPanel {...scope} intent={intent} readOnly /> : null)
          : <PhaseUploadPanel {...scope} intent={intent} onChanged={changed} onPendingChange={onPendingFor(stage.key, intent)} />}
        {!readOnly && list ? <PhaseUploadedFiles {...scope} intent={intent} headingLevel={5} /> : null}
        {!list ? <p className="text-sm text-body">{AUDIO_LISTED_BELOW}</p> : null}
      </div>
    );
    const audioListHere = (intent: UploadIntent) => intent === "prerecorded_audio" || !stage.actions.uploadAudio;
    switch (action) {
      case "answerQuestions": return <StageQuestions {...scope} readOnly={readOnly} headingLevel={4} />;
      case "uploadDocuments": return upload("document", true);
      case "recordAudio": return upload("recording", audioListHere("recording"));
      case "uploadAudio": return upload("prerecorded_audio", true);
      case "teamFileReview": return <PhaseTeamFiles {...scope} />;
    }
  };

  const paymentAction = payable ? (
    // The primary action of the payment waiting screen; the invoice number sits beside it (and is in the name).
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Link
        href={`/invoices/${encodeURIComponent(payable.invoicePublicId)}`}
        className={buttonClasses("primary")}
        aria-label={payable.invoiceNumber ? `Pay now, invoice ${payable.invoiceNumber}` : undefined}
      >
        Pay now
      </Link>
      {payable.invoiceNumber ? <span aria-hidden="true" className="min-w-0 break-words text-sm text-muted">Invoice {payable.invoiceNumber}</span> : null}
    </div>
  ) : invoices.isSuccess && waitsForPayment ? <p>{INVOICE_PREPARING_MESSAGE}</p> : null;
  // Derived workflows (formats 1/2) have no phase actions: the order-level wizard offers what the server allows.
  const derivedKind = derivedWaitingKind(workspace);
  const derivedBody = workspace.derived ? (
    <DerivedOrderWizard
      orderId={orderId}
      waitingKind={derivedKind}
      waitingAction={derivedKind === "payment" ? paymentAction : derivedKind === "delivered" ? completion : waitingAction?.(derivedKind)}
    />
  ) : undefined;

  return (
    <PhaseWizard
      workspace={workspace}
      currentBody={derivedBody}
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
      questionCount={questionCount}
      uploadCounts={uploadCounts}
      factsReady={factsReady}
      waitingAction={waitingAction}
      completion={completion}
      announcement={announcement}
      paymentAction={paymentAction}
      onNext={(stage) => run(() => next.mutateAsync({ orderId, stageKey: stage.key, expectedVersion: workspace.version }))}
      onSubmit={(stage, ack) => run(() => submit.mutateAsync({ orderId, stageKey: stage.key, expectedVersion: workspace.version, ...(ack ? { ack } : {}) }))}
    />
  );
}

/** What a derived order waits for when the customer has nothing to do there. */
export function derivedWaitingKind(workspace: WizardWorkspace): WaitingKind {
  if (workspace.progress.canceled) return "canceled";
  const current = currentStage(workspace);
  if (!current) return "delivered";
  return current.waitingOn ?? "team";
}

/** The phase ZIP is offered where the phase lists files; the server decides what it may contain. */
export function hasFileActions(stage: WizardStage): boolean {
  return stage.actions.uploadDocuments || stage.actions.recordAudio || stage.actions.uploadAudio || stage.actions.teamFileReview;
}

interface UploadedFileLike { visibility: string; deletedAt: unknown; supersededAt: unknown; category: string; contentType: string }

/** A customer's own upload in a phase list, as "Uploaded in this phase" shows it. */
export function isCustomerUpload(file: UploadedFileLike, audio: boolean): boolean {
  return file.visibility === "customer_visible" && !file.deletedAt && !file.supersededAt &&
    file.category !== "deliverable" && file.contentType.startsWith("audio/") === audio;
}
