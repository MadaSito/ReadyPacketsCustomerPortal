import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Button, Callout, Checkbox, ConfirmDialog, DataTable, DateTime, Dialog, EmptyState, ErrorState, Field, Input,
  KeyValueList, PageHeader, Section, Skeleton, StatusBadge, StepUpCancelledError, useStepUp, useToast,
} from "@/ui";
import { AuditNav } from "./AuditNav";
import { CATEGORIES, label, type Category, type RetentionState } from "./model";

const MIN_DAYS = 30;
const MAX_DAYS = 3650;
type Policy = RetentionState["policies"][number];
type Hold = RetentionState["holds"][number];
type Run = RetentionState["runs"][number];

const runState = (status: string) => (status === "completed" ? "completed" : status === "failed" ? "failed" : status === "running" ? "running" : "unknown") as "completed" | "failed" | "running" | "unknown";
const sumCounts = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

export function RetentionView({ state, onEditPolicy, onReleaseHold }: { state: RetentionState; onEditPolicy: (p: Policy) => void; onReleaseHold: (h: Hold) => void }) {
  return (
    <div className="space-y-8">
      <Section title="Retention policies" description={`Events older than the policy are removed by the daily job and replaced by a verifiable retention record. Allowed range: ${MIN_DAYS} to ${MAX_DAYS} days.`}>
        <DataTable
          caption="Retention policies"
          rows={state.policies}
          rowKey={(p) => p.category}
          columns={[
            { key: "category", header: "Category", primary: true, cell: (p) => label(p.category) },
            { key: "days", header: "Keep for", cell: (p) => (p.retainDays === null ? <Badge tone="info">Forever</Badge> : `${p.retainDays.toLocaleString()} days`) },
            { key: "updated", header: "Last changed", cell: (p) => (p.updatedAt ? <DateTime value={p.updatedAt} format="date" /> : "Default") },
          ]}
          rowActions={(p) => <Button size="sm" variant="ghost" onClick={() => onEditPolicy(p)} aria-label={`Edit retention for ${label(p.category)}`}>Edit</Button>}
        />
      </Section>
      <Section title="Legal holds" description="Events covered by an active hold are never removed, whatever the policy says.">
        <DataTable
          caption="Legal holds"
          rows={state.holds}
          rowKey={(h) => h.id}
          empty={<EmptyState title="No legal holds" description="Create a hold to preserve events for an investigation or legal request." headingLevel={3} />}
          columns={[
            { key: "label", header: "Label", primary: true, cell: (h) => <span className="break-words">{h.label}</span> },
            { key: "status", header: "Status", cell: (h) => (h.active ? <Badge tone="warning">Active</Badge> : <Badge>Released</Badge>) },
            { key: "scope", header: "Categories", cell: (h) => (h.categories ? h.categories.map(label).join(", ") : "All categories") },
            { key: "range", header: "Covers", cell: (h) => <span><DateTime value={h.from} format="date" /> to <DateTime value={h.to} format="date" /></span> },
          ]}
          rowActions={(h) => (h.active ? <Button size="sm" variant="ghost" onClick={() => onReleaseHold(h)} aria-label={`Release hold ${h.label}`}>Release</Button> : null)}
        />
      </Section>
      <Section title="Recent runs">
        <DataTable
          caption="Retention runs"
          rows={state.runs}
          rowKey={(r: Run) => r.id}
          empty={<EmptyState title="No runs yet" description="The retention job runs daily. You can also preview or run it now." headingLevel={3} />}
          columns={[
            { key: "started", header: "Started", primary: true, cell: (r) => <DateTime value={r.startedAt} format="datetime" /> },
            { key: "kind", header: "Type", cell: (r) => (r.dryRun ? "Preview" : "Removal") },
            { key: "status", header: "Status", cell: (r) => <StatusBadge state={runState(r.status)} /> },
            { key: "count", header: "Events", align: "end", cell: (r) => `${sumCounts(r.counts).toLocaleString()} ${r.dryRun ? "eligible" : "removed"}` },
          ]}
        />
      </Section>
    </div>
  );
}

export default function RetentionPage() {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const client = useQueryClient();
  const state = useQuery(trpc.audit.retention.get.queryOptions());
  const run = useMutation(trpc.audit.retention.run.mutationOptions());
  const release = useMutation(trpc.audit.retention.releaseHold.mutationOptions());
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [releasing, setReleasing] = useState<Hold | null>(null);
  const [holdOpen, setHoldOpen] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);
  const [preview, setPreview] = useState<Run | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: trpc.audit.retention.pathKey() });

  const guarded = async <T,>(action: () => Promise<T>, failTitle: string): Promise<T> => {
    try {
      const result = await stepUp.run(action, { reason: "Changing audit retention requires a fresh confirmation." });
      await refresh();
      return result;
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) toast.show({ title: failTitle, description: errorMessage(error), tone: "danger" });
      throw error;
    }
  };

  return (
    <>
      <PageHeader title="Audit retention" description="Decide how long audit events are kept, and preserve evidence with legal holds."
        actions={
          <>
            <Button variant="secondary" onClick={() => setHoldOpen(true)}>New legal hold</Button>
            <Button variant="secondary" loading={run.isPending && run.variables?.dryRun === true} onClick={() => guarded(() => run.mutateAsync({ dryRun: true }), "Preview failed").then(setPreview, () => undefined)}>Preview removal</Button>
            <Button variant="danger" onClick={() => setConfirmRun(true)}>Run retention now</Button>
          </>
        } />
      <AuditNav />
      {preview ? (
        <Callout tone="info" title="Preview complete" live="polite" className="mb-6" actions={<Button size="sm" variant="secondary" onClick={() => setPreview(null)}>Dismiss</Button>}>
          {sumCounts(preview.counts).toLocaleString()} events are eligible for removal. Nothing was deleted.
          {Object.keys(preview.counts).length > 0 ? <KeyValueList className="mt-3" columns={3} items={Object.entries(preview.counts).map(([k, v]) => ({ label: label(k), value: v.toLocaleString() }))} /> : null}
        </Callout>
      ) : null}
      {state.isPending ? <div role="status" aria-label="Loading retention settings" className="space-y-3"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
        : state.error ? <ErrorState error={state.error} onRetry={() => state.refetch()} />
        : <RetentionView state={state.data} onEditPolicy={setPolicy} onReleaseHold={setReleasing} />}
      <PolicyDialog policy={policy} onClose={() => setPolicy(null)} guarded={guarded} />
      <HoldDialog open={holdOpen} onClose={() => setHoldOpen(false)} guarded={guarded} />
      <ConfirmDialog
        open={releasing !== null}
        onOpenChange={(o) => !o && setReleasing(null)}
        title="Release this legal hold?"
        description="Events it protected become subject to the retention policy again and may be removed at the next run."
        confirmLabel="Release hold"
        destructive
        onConfirm={async () => {
          if (!releasing) return;
          await guarded(() => release.mutateAsync({ id: releasing.id }), "Hold not released");
          toast.show({ title: "Legal hold released", tone: "success" });
        }}
      />
      <ConfirmDialog
        open={confirmRun}
        onOpenChange={setConfirmRun}
        title="Remove expired audit events now?"
        description="Events older than their policy and not under a legal hold are permanently removed. A signed retention record replaces each one. This cannot be undone."
        confirmLabel="Remove events"
        confirmText="REMOVE"
        destructive
        onConfirm={async () => {
          const result = await guarded(() => run.mutateAsync({ dryRun: false }), "Retention did not run");
          toast.show({ title: result.status === "completed" ? "Retention complete" : "Retention did not finish", description: `${sumCounts(result.counts).toLocaleString()} events removed.`, tone: result.status === "completed" ? "success" : "warning" });
        }}
      />
    </>
  );
}

type Guarded = <T>(action: () => Promise<T>, failTitle: string) => Promise<T>;

function PolicyDialog({ policy, onClose, guarded }: { policy: Policy | null; onClose: () => void; guarded: Guarded }) {
  const trpc = useTRPC();
  const toast = useToast();
  const set = useMutation(trpc.audit.retention.setPolicy.mutationOptions());
  const [forever, setForever] = useState(false);
  const [days, setDays] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  if (policy && current !== policy.category) {
    setCurrent(policy.category);
    setForever(policy.retainDays === null);
    setDays(policy.retainDays === null ? "365" : String(policy.retainDays));
    setError(null);
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!policy) return;
    const n = Number(days);
    if (!forever && (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS)) return setError(`Enter a whole number of days from ${MIN_DAYS} to ${MAX_DAYS}.`);
    setError(null);
    try {
      await guarded(() => set.mutateAsync({ category: policy.category, retainDays: forever ? null : n }), "Policy not saved");
      toast.show({ title: "Retention policy saved", tone: "success" });
      setCurrent(null);
      onClose();
    } catch {
      /* toast already shown */
    }
  };
  return (
    <Dialog open={policy !== null} onOpenChange={(o) => { if (!o) { setCurrent(null); onClose(); } }} title={policy ? `Retention for ${label(policy.category)}` : "Retention"} dismissible={!set.isPending}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Checkbox label="Keep forever" checked={forever} onCheckedChange={setForever} />
        {!forever ? (
          <Field label="Keep for (days)" error={error ?? undefined} hint={`${MIN_DAYS} to ${MAX_DAYS} days.`}>
            <Input type="number" inputMode="numeric" min={MIN_DAYS} max={MAX_DAYS} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={() => { setCurrent(null); onClose(); }}>Cancel</Button>
          <Button type="submit" loading={set.isPending}>Save policy</Button>
        </div>
      </form>
    </Dialog>
  );
}

function HoldDialog({ open, onClose, guarded }: { open: boolean; onClose: () => void; guarded: Guarded }) {
  const trpc = useTRPC();
  const toast = useToast();
  const create = useMutation(trpc.audit.retention.createHold.mutationOptions());
  const [holdLabel, setHoldLabel] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [all, setAll] = useState(true);
  const [cats, setCats] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const start = from ? new Date(`${from}T00:00:00Z`) : null;
    const end = to ? new Date(`${to}T23:59:59.999Z`) : null;
    if (!holdLabel.trim()) return setError("Give the hold a label.");
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return setError("Choose a start date and a later end date.");
    if (!all && cats.length === 0) return setError("Choose at least one category, or cover all categories.");
    setError(null);
    try {
      await guarded(() => create.mutateAsync({ label: holdLabel.trim(), categories: all ? null : cats, from: start.toISOString(), to: end.toISOString() }), "Hold not created");
      toast.show({ title: "Legal hold created", tone: "success" });
      setHoldLabel("");
      onClose();
    } catch {
      /* toast already shown */
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="New legal hold" description="Events in the date range (UTC) are preserved until the hold is released." dismissible={!create.isPending} size="lg">
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Label" hint="A case or matter reference. Avoid personal data."><Input value={holdLabel} maxLength={120} onChange={(e) => setHoldLabel(e.target.value)} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From (UTC)"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To (UTC)"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <Checkbox label="Cover all categories" checked={all} onCheckedChange={setAll} />
        {!all ? (
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium text-ink">Categories</legend>
            {CATEGORIES.map((c) => (
              <Checkbox key={c} label={label(c)} checked={cats.includes(c)} onCheckedChange={(v) => setCats(v ? [...cats, c] : cats.filter((x) => x !== c))} />
            ))}
          </fieldset>
        ) : null}
        {error ? <Callout tone="danger" title="Hold not created" live="assertive">{error}</Callout> : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={create.isPending}>Create hold</Button>
        </div>
      </form>
    </Dialog>
  );
}
