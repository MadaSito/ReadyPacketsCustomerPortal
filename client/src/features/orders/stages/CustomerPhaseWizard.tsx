/**
 * D4 customer phase wizard — container (package E, audit_engineer). Mounted on the customer order page at the
 * "increment 07 customer phase mount" anchor of OrderDetailView. Reads `orders.stages.workspace` and calls
 * `next` / `submit`; the action panels belong to assurance (questions) and files_engineer (uploads, team files).
 * If the workspace cannot be read, the previous checklist (`fallback`) is shown so the page keeps working.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { StageActionKey } from "@shared/workflowStages";
import { safeError, useTRPC } from "@/lib/trpc";
import { Skeleton } from "@/ui";
import { PhaseArchiveAction } from "../../files/archives/ArchiveAction";
import { PhaseTeamFiles, PhaseUploadPanel } from "../../files/PhaseFiles";
import { PhaseWizard } from "./PhaseWizard";
import { StageQuestions } from "./StageQuestions";
import { REFRESH_CODES, wizardErrorMessage, type WizardStage, type WizardWorkspace } from "./wizardModel";

export function CustomerPhaseWizard({ orderId, fallback }: { orderId: string; fallback?: ReactNode }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const workspaceQuery = useQuery(trpc.orders.stages.workspace.queryOptions({ orderId }));
  const next = useMutation(trpc.orders.stages.next.mutationOptions());
  const submit = useMutation(trpc.orders.stages.submit.mutationOptions());
  const [error, setError] = useState<string | null>(null);

  if (workspaceQuery.isPending) return <div role="status" aria-label="Loading order phases" className="mb-6"><Skeleton lines={4} /></div>;
  if (workspaceQuery.error || !workspaceQuery.data) return <>{fallback ?? null}</>;
  // Structural check against the server's published shape (orders API.md, increment 07).
  const workspace: WizardWorkspace = workspaceQuery.data;

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
      await action();
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
      case "uploadDocuments": return <PhaseUploadPanel {...scope} intent="document" readOnly={readOnly} onChanged={changed} />;
      case "recordAudio": return <PhaseUploadPanel {...scope} intent="recording" readOnly={readOnly} onChanged={changed} />;
      case "uploadAudio": return <PhaseUploadPanel {...scope} intent="prerecorded_audio" readOnly={readOnly} onChanged={changed} />;
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
      onNext={(stage) => run(() => next.mutateAsync({ orderId, stageKey: stage.key, expectedVersion: workspace.version }))}
      onSubmit={(stage, ack) => run(() => submit.mutateAsync({ orderId, stageKey: stage.key, expectedVersion: workspace.version, ...(ack ? { ack } : {}) }))}
    />
  );
}

/** The phase ZIP is offered where the phase lists files; the server decides what it may contain. */
export function hasFileActions(stage: WizardStage): boolean {
  return stage.actions.uploadDocuments || stage.actions.recordAudio || stage.actions.uploadAudio || stage.actions.teamFileReview;
}
