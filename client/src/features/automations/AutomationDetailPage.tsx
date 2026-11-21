/** /admin/automations/:automationId — summary, controls and run history with per-step results. Owner: audit engineer. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { errorMessage } from "@/lib/trpc";
import {
  Breadcrumbs, Button, Callout, ConfirmDialog, DataTable, DateTime, Drawer, EmptyState, ErrorState, KeyValueList, PageHeader, Section, Skeleton,
  StepUpCancelledError, useStepUp, useToast,
} from "@/ui";
import { useAutomationsApi } from "./api";
import { BASE, TRIGGER_MODE_LABEL, draftFromDetail, formatDuration, type AutomationRunView, type Catalogue } from "./model";
import { DraftSummary, EnabledBadge, RunStateBadge, RunSteps } from "./parts";

export default function AutomationDetailPage() {
  const { automationId = "" } = useParams<{ automationId: string }>();
  const api = useAutomationsApi();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const [, navigate] = useLocation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const catalogue = useQuery(api.catalogue.queryOptions());
  const detail = useQuery(api.get.queryOptions({ publicId: automationId }));
  const runs = useQuery({
    ...api.runs.list.queryOptions({ automationPublicId: automationId, limit: 50 }),
    refetchInterval: (q: { state: { data?: { items: AutomationRunView[] } } }) => (q.state.data?.items.some((r) => r.state === "queued" || r.state === "running") ? 5000 : false),
  });
  const setEnabled = useMutation(api.setEnabled.mutationOptions());
  const duplicate = useMutation(api.duplicate.mutationOptions());
  const remove = useMutation(api.delete.mutationOptions());
  const manual = useMutation(api.triggerManual.mutationOptions());

  const a = detail.data;
  const crumbs = <Breadcrumbs items={[{ label: "Console", href: "/admin" }, { label: "Automations", href: BASE }, { label: a?.name ?? "Automation" }]} />;
  if (detail.isPending || catalogue.isPending) return <><PageHeader breadcrumbs={crumbs} title="Automation" /><Skeleton lines={6} /></>;
  if (detail.error || catalogue.error || !a) {
    return <><PageHeader breadcrumbs={crumbs} title="Automation" /><ErrorState error={detail.error ?? catalogue.error} onRetry={() => { void detail.refetch(); void catalogue.refetch(); }} /></>;
  }
  const cat = catalogue.data as Catalogue;

  const act = async <T,>(fn: () => Promise<T>, done: string, fail: string): Promise<T | undefined> => {
    try {
      const result = await stepUp.run(fn, { reason: "Changing an automation requires a fresh confirmation." });
      toast.show({ title: done, tone: "success" });
      return result;
    } catch (error) {
      if (error instanceof StepUpCancelledError) return undefined;
      toast.show({ title: fail, description: errorMessage(error), tone: "danger" });
      return undefined;
    } finally {
      await qc.invalidateQueries(api.get.pathFilter());
      await qc.invalidateQueries(api.list.pathFilter());
      await qc.invalidateQueries(api.runs.list.pathFilter());
    }
  };

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={a.name}
        meta={<EnabledBadge enabled={a.enabled} />}
        description={a.description ?? undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant={a.enabled ? "secondary" : "primary"} loading={setEnabled.isPending}
              onClick={() => void act(() => setEnabled.mutateAsync({ publicId: a.publicId, expectedVersion: a.version, enabled: !a.enabled }), a.enabled ? "Turned off" : "Turned on", "Not changed")}>
              {a.enabled ? "Turn off" : "Turn on"}
            </Button>
            {a.trigger.kind === "manual" && !a.trigger.requireOrderPublicId ? (
              <Button variant="secondary" loading={manual.isPending} disabled={!a.enabled || !cat.globallyEnabled}
                onClick={() => void act(() => manual.mutateAsync({ publicId: a.publicId }), "Run started", "Run not started")}>Run now</Button>
            ) : null}
            <Button asChild variant="secondary"><Link href={`${BASE}/${a.publicId}/edit`}>Edit</Link></Button>
            <Button variant="ghost" loading={duplicate.isPending}
              onClick={async () => { const copy = await act(() => duplicate.mutateAsync({ publicId: a.publicId }), "Copy created (turned off)", "Not copied"); if (copy) navigate(`${BASE}/${copy.publicId}`); }}>Duplicate</Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete</Button>
          </div>
        }
      />
      <div className="space-y-8">
        {!cat.globallyEnabled ? <Callout tone="warning" title="Automations are switched off for the whole portal">This automation will not run until automations are turned on in platform settings.</Callout> : null}
        {a.trigger.kind === "manual" && a.trigger.requireOrderPublicId ? <Callout tone="info" title="Started from an order">This automation needs an order. Start it from the order's page.</Callout> : null}
        <Section title="How it works">
          <DraftSummary draft={draftFromDetail(a, cat)} catalogue={cat} />
          <KeyValueList className="mt-4" items={[
            { label: "Version", value: String(a.version) },
            { label: "Last changed", value: <DateTime value={a.updatedAt} /> },
            { label: "Runs per hour (limit)", value: String(a.maxRunsPerHour) },
          ]} />
        </Section>
        <Section title="Run history" description="Each run records what was checked and what every step did. Personal data and message bodies are never shown here.">
          <DataTable
            caption="Run history"
            rows={runs.data?.items}
            rowKey={(r) => r.publicId}
            loading={runs.isPending}
            error={runs.error}
            onRetry={() => runs.refetch()}
            empty={<EmptyState headingLevel={3} title="No runs yet" description={a.enabled ? "Runs appear here when the trigger fires." : "Turn the automation on to start recording runs."} />}
            columns={[
              { key: "when", header: "Queued", primary: true, cell: (r) => <DateTime value={r.queuedAt} /> },
              { key: "state", header: "Result", cell: (r) => <RunStateBadge state={r.state} /> },
              { key: "mode", header: "Started by", cell: (r) => `${TRIGGER_MODE_LABEL[r.triggerMode]}${r.isTest ? " (test)" : ""}` },
              { key: "steps", header: "Steps", cell: (r) => `${r.steps.filter((s) => s.state === "completed").length} of ${r.steps.length} completed` },
              { key: "duration", header: "Duration", cell: (r) => formatDuration(r.durationMs) },
            ]}
            rowActions={(r) => <Button size="sm" variant="secondary" onClick={() => setOpenRun(r.publicId)} aria-label={`Details for run queued ${new Date(r.queuedAt).toLocaleString()}`}>Details</Button>}
          />
        </Section>
      </div>
      <RunDrawer runPublicId={openRun} onClose={() => setOpenRun(null)} />
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} destructive title={`Delete "${a.name}"?`}
        description="It stops immediately. Run history is kept for the retention period." confirmLabel="Delete automation"
        onConfirm={async () => {
          try {
            await stepUp.run(() => remove.mutateAsync({ publicId: a.publicId, expectedVersion: a.version }), { reason: "Deleting an automation requires a fresh confirmation." });
            toast.show({ title: "Automation deleted", tone: "success" });
            await qc.invalidateQueries(api.list.pathFilter());
            navigate(BASE);
          } catch (error) {
            if (error instanceof StepUpCancelledError) return;
            toast.show({ title: "Not deleted", description: errorMessage(error), tone: "danger" });
            throw error;
          }
        }} />
    </>
  );
}

export function RunDrawer({ runPublicId, onClose }: { runPublicId: string | null; onClose: () => void }) {
  const api = useAutomationsApi();
  const run = useQuery({ ...api.runs.get.queryOptions({ runPublicId: runPublicId ?? "" }), enabled: Boolean(runPublicId) });
  const r = run.data;
  return (
    <Drawer open={Boolean(runPublicId)} onOpenChange={(open) => { if (!open) onClose(); }} title="Run details">
      {run.isPending ? <Skeleton lines={4} /> : run.error ? <ErrorState error={run.error} onRetry={() => run.refetch()} /> : r ? (
        <div className="flex flex-col gap-4">
          <KeyValueList columns={1} items={[
            { label: "Result", value: <RunStateBadge state={r.state} /> },
            { label: "Reason", value: r.reasonCode ? <code>{r.reasonCode}</code> : "—" },
            { label: "Started by", value: `${TRIGGER_MODE_LABEL[r.triggerMode]}${r.isTest ? " (test)" : ""}` },
            { label: "Automation version", value: String(r.automationVersion) },
            { label: "Queued", value: <DateTime value={r.queuedAt} /> },
            { label: "Duration", value: formatDuration(r.durationMs) },
            { label: "Correlation id", value: <code className="break-all">{r.correlationId}</code> },
          ]} />
          {Object.keys(r.evaluatedFields).length > 0 ? (
            <div>
              <h3 className="mb-1 text-base font-semibold text-ink">Values checked</h3>
              <KeyValueList columns={1} items={Object.entries(r.evaluatedFields).map(([k, v]) => ({ label: k, value: v === null ? "—" : String(v) }))} />
            </div>
          ) : null}
          <div>
            <h3 className="mb-2 text-base font-semibold text-ink">Steps</h3>
            {r.steps.length === 0 ? <p className="text-sm text-muted">No steps ran.</p> : <RunSteps run={r} />}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
