import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "wouter";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Breadcrumbs, Button, Callout, Card, ConfirmDialog, DateTime, EmptyState, ErrorState,
  DataTable, KeyValueList, PageHeader, Section, Skeleton, StatusBadge, StepUpCancelledError, useStepUp,
} from "@/ui";
import { AuditLink, Id } from "../controls";

type Action = "cancel" | "retry" | "reconcile";
const actions: Record<Action, { title: string; copy: string; label: string }> = {
  cancel: { title: "Cancel this job?", copy: "The worker will not start it. A job that has already started cannot be canceled here.", label: "Cancel job" },
  retry: { title: "Retry this job?", copy: "Queue one additional attempt. The preceding result remains in the attempt history.", label: "Retry job" },
  reconcile: { title: "Record reconciliation?", copy: "Only continue after independently confirming this attempt and its external effects have stopped or been contained. Its recorded outcome remains unknown. This does not authorize a retry.", label: "Record reconciliation" },
};

export default function JobDetailPage() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const detail = useQuery(trpc.jobs.admin.detail.queryOptions({ publicId: jobId }));
  const cancel = useMutation(trpc.jobs.admin.cancel.mutationOptions());
  const retry = useMutation(trpc.jobs.admin.retry.mutationOptions());
  const reconcile = useMutation(trpc.jobs.admin.acknowledgeUnknown.mutationOptions());
  const [action, setAction] = useState<Action | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = detail.data;
  const selected = action ? actions[action] : null;
  const handle = async () => {
    if (!action) return;
    setError(null);
    setMessage(null);
    const input = { publicId: jobId };
    try {
      if (action === "cancel") await cancel.mutateAsync(input);
      if (action === "retry") await retry.mutateAsync(input);
      if (action === "reconcile") await stepUp.run(() => reconcile.mutateAsync({ ...input, confirmation: "RECONCILED" }),
        { reason: "Recording job reconciliation requires fresh verification." });
      setMessage(action === "cancel" ? "The queued job was canceled." : action === "retry" ? "An additional attempt was queued." : "Reconciliation was recorded. The outcome remains unknown.");
      void qc.invalidateQueries(trpc.jobs.admin.pathFilter());
    } catch (failure) {
      if (failure instanceof StepUpCancelledError) return;
      setError(errorMessage(failure));
      throw failure;
    }
  };
  return <>
    <PageHeader title="Job details" description={job ? <Id value={job.type} /> : undefined}
      breadcrumbs={<Breadcrumbs items={[{ label: "Jobs", href: "/admin/jobs" }, { label: "Job details" }]} />}
      meta={job ? <StatusBadge state={job.state} /> : undefined}
      actions={job ? <AuditLink correlationId={job.correlationId} /> : undefined} />
    {detail.isError ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : null}
    {detail.isPending ? <Skeleton lines={5} /> : null}
    {message ? <Callout tone="success" live="polite">{message}</Callout> : null}
    {job ? <div className="grid min-w-0 gap-5">
      {job.state === "unknown" && !job.reconciledAt ? <Callout title="Outcome unknown" tone="warning">
        Check the affected provider or system for evidence before recording reconciliation. Never replay an uncertain effect.
      </Callout> : null}
      <Card title="Summary">
        <KeyValueList columns={2} items={[
          { label: "Job ID", value: <Id value={job.publicId} /> },
          { label: "Correlation ID", value: <Id value={job.correlationId} /> },
          { label: "Reason", value: <Id value={job.reasonCode} /> },
          { label: "Attempts used", value: `${job.attempt} of ${job.maxAttempts}` },
          { label: "Queued", value: <DateTime value={job.createdAt} /> },
          { label: "Updated", value: <DateTime value={job.updatedAt} /> },
          { label: "Scheduled", value: <DateTime value={job.runAt} /> },
          { label: "Reconciliation recorded", value: <DateTime value={job.reconciledAt} /> },
        ]} />
        <div className="mt-3 flex flex-wrap gap-2">
          {job.state === "queued" ? <Button variant="danger" onClick={() => setAction("cancel")}>Cancel queued job</Button> : null}
          {job.state === "failed" && job.allowRetry ? <Button onClick={() => setAction("retry")}>Retry job</Button> : null}
          {job.state === "unknown" && !job.reconciledAt ? <Button variant="secondary" onClick={() => setAction("reconcile")}>Record reconciliation</Button> : null}
        </div>
      </Card>
      <Section title="Attempts" description="The most recent attempt appears first.">
        <DataTable caption="Job attempt history" rows={job.attempts} rowKey={(row) => String(row.attempt)}
          empty={<EmptyState title="No attempts yet" description="Attempts appear after a worker claims the job." />}
          columns={[
            { key: "attempt", header: "Attempt", primary: true, cell: (row) => <span className="tabular-nums">{row.attempt}</span> },
            { key: "state", header: "Outcome", cell: (row) => row.state === "interrupted"
              ? <StatusBadge state="unknown" label="Interrupted" /> : <StatusBadge state={row.state} /> },
            { key: "reason", header: "Reason", cell: (row) => <Id value={row.reasonCode} /> },
            { key: "started", header: "Started", cell: (row) => <DateTime value={row.startedAt} /> },
            { key: "finished", header: "Finished", cell: (row) => <DateTime value={row.finishedAt} /> },
          ]} />
      </Section>
    </div> : null}
    {selected ? <ConfirmDialog open onOpenChange={(open) => { if (!open) { setAction(null); setError(null); } }}
      title={selected.title} description={selected.copy} confirmLabel={selected.label}
      confirmText={action === "reconcile" ? "RECONCILED" : undefined} destructive={action === "cancel"} onConfirm={handle}>
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
    </ConfirmDialog> : null}
  </>;
}
