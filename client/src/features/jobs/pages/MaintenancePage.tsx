import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, ConfirmDialog, ErrorState, KeyValueList, PageHeader,
  Skeleton, StepUpCancelledError, useStepUp,
} from "@/ui";

export default function MaintenancePage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const query = useQuery(trpc.jobs.admin.maintenance.queryOptions(undefined, { refetchInterval: 5_000 }));
  const setMaintenance = useMutation(trpc.jobs.admin.setMaintenance.mutationOptions());
  const [expectedActive, setExpectedActive] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = query.data;
  const blocked = Boolean(status?.active && (status.running || status.unresolved));
  const confirm = async () => {
    if (expectedActive === null) return;
    setError(null);
    setMessage(null);
    try {
      const updated = await stepUp.run(() => setMaintenance.mutateAsync({ active: !expectedActive, expectedActive }),
        { reason: "Changing maintenance mode requires fresh verification." });
      setMessage(updated.active ? "Maintenance is on. Workers will not start new jobs." : "Maintenance is off. Workers can start queued jobs.");
      void qc.invalidateQueries(trpc.jobs.admin.pathFilter());
      void qc.invalidateQueries(trpc.jobs.maintenanceBanner.pathFilter());
    } catch (failure) {
      if (failure instanceof StepUpCancelledError) return;
      setError(errorMessage(failure));
      throw failure;
    }
  };
  return <>
    <PageHeader title="Maintenance" description="Pause new worker claims and review what is still running." />
    {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
    {query.isPending ? <Skeleton lines={5} /> : null}
    {message ? <Callout tone="success" live="polite">{message}</Callout> : null}
    {status ? <div className="grid min-w-0 gap-4">
      <Card title="Queue admission" actions={<Badge tone={status.active ? "warning" : "success"}>{status.active ? "Maintenance on" : "Open"}</Badge>}>
        <KeyValueList columns={2} items={[
          { label: "Running jobs", value: <span className="tabular-nums">{status.running}</span> },
          { label: "Unresolved outcomes", value: <span className="tabular-nums">{status.unresolved}</span> },
          { label: "Drain status", value: status.state === "queue_drained" ? "Queue drained" : status.state === "unproved"
            ? "Needs reconciliation" : status.state === "draining" ? "Waiting for active jobs" : "Accepting claims" },
        ]} />
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant={status.active ? "secondary" : "danger"} disabled={blocked} onClick={() => setExpectedActive(status.active)}>
            {status.active ? "End maintenance" : "Start maintenance"}
          </Button>
          <Button asChild variant="ghost"><Link href="/admin/jobs">Inspect jobs</Link></Button>
        </div>
      </Card>
      {blocked ? <Callout title="Maintenance remains on" tone="warning">
        Wait for running jobs and resolve uncertain outcomes before reopening. If an interrupted job has a retry waiting, cancel the retry and reconcile its earlier attempt.
      </Callout> : null}
      <Callout title="Scope of this status" tone="info">
        Queue drained means no running jobs or unresolved outcomes are recorded here. Confirm all other writers and remote systems have stopped before a backup or deployment that requires a full drain.
      </Callout>
    </div> : null}
    {expectedActive !== null ? <ConfirmDialog open
      onOpenChange={(open) => { if (!open) { setExpectedActive(null); setError(null); } }}
      title={expectedActive ? "End maintenance?" : "Start maintenance?"}
      confirmLabel={expectedActive ? "End maintenance" : "Start maintenance"}
      description={expectedActive ? "Workers can resume claiming queued jobs and processing current schedule slots."
        : "Workers stop starting new jobs. Running jobs can finish, and the portal shows a maintenance notice."}
      destructive={!expectedActive} onConfirm={confirm}>
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
    </ConfirmDialog> : null}
  </>;
}
