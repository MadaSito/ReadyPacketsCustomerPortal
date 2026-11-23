/** D7: security incidents list and correlation rules. Admins with `security.incidents.read`; the server re-checks every action. */
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { ShieldAlert } from "lucide-react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Button, Callout, DataTable, DateTime, EmptyState, ErrorState, Field, FilterBar, Input, LoadMore, PageHeader, Section, Select,
  Skeleton, StatCard, StatGrid, StepUpCancelledError, Switch, useStepUp, useToast,
} from "@/ui";
import { AuditNav } from "./AuditNav";
import {
  boundError, INCIDENT_SEVERITY_LIST, INCIDENT_STATUS_LIST, SEVERITY_META, STATUS_META, SUBJECT_LABELS,
  type CorrelationConfig, type IncidentPage, type IncidentSeverity, type IncidentStatus, type IncidentSummary, type RuleKey, type RuleParams, type RulesView,
} from "./model";

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  const m = STATUS_META[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}
export function IncidentSeverityBadge({ severity }: { severity: IncidentSeverity }) {
  const m = SEVERITY_META[severity];
  return <Badge tone={m.tone} icon={severity === "critical" ? <ShieldAlert aria-hidden /> : undefined}>{m.label}</Badge>;
}

export function IncidentsTable({ rows, loading, error, onRetry, filtered }: { rows: readonly IncidentSummary[] | undefined; loading: boolean; error: unknown; onRetry: () => void; filtered: boolean }) {
  return (
    <DataTable
      caption="Security incidents"
      rows={rows}
      loading={loading}
      error={error}
      onRetry={onRetry}
      rowKey={(r) => r.publicId}
      empty={<EmptyState icon={ShieldAlert} headingLevel={3} title="No incidents" description={filtered ? "No incidents match these filters." : "Nothing has crossed a correlation rule threshold. The rules run every minute."} />}
      columns={[
        { key: "rule", header: "Incident", primary: true, cell: (r) => <Link href={`/admin/audit/incidents/${r.publicId}`} className="inline-flex min-h-11 items-center font-medium text-brand underline-offset-2 hover:underline break-words">{r.ruleLabel}</Link> },
        { key: "severity", header: "Severity", cell: (r) => <IncidentSeverityBadge severity={r.severity} /> },
        { key: "status", header: "Status", cell: (r) => <IncidentStatusBadge status={r.status} /> },
        { key: "subject", header: "Subject", cell: (r) => SUBJECT_LABELS[r.subjectKind] ?? r.subjectKind },
        { key: "events", header: "Events", align: "end", cell: (r) => r.eventCount.toLocaleString() },
        { key: "last", header: "Last activity", cell: (r) => <DateTime value={r.lastEventAt} format="relative" /> },
      ]}
    />
  );
}

type Draft = Record<RuleKey, { enabled: boolean; severity: IncidentSeverity; threshold: string; windowMinutes: string; distinct: string }>;
const toDraft = (c: CorrelationConfig): Draft =>
  Object.fromEntries(Object.entries(c.rules).map(([k, r]) => [k, { enabled: r.enabled, severity: r.severity, threshold: String(r.threshold), windowMinutes: String(r.windowMinutes), distinct: String(r.distinct) }])) as Draft;

/** Validates the draft; returns per-field errors keyed `${rule}.${field}` (or `mergeMinutes`). */
export function draftErrors(draft: Draft, merge: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const m = boundError("mergeMinutes", merge);
  if (m) errors.mergeMinutes = m;
  for (const [key, r] of Object.entries(draft)) {
    for (const f of ["threshold", "windowMinutes", "distinct"] as const) {
      if (f === "distinct" && key !== "credential_stuffing") continue;
      const e = boundError(f, r[f]);
      if (e) errors[`${key}.${f}`] = e;
    }
  }
  return errors;
}

export function RulesCard({ view, onSave, saving }: { view: RulesView; onSave: (c: CorrelationConfig) => Promise<void>; saving: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(view.config));
  const [enabled, setEnabled] = useState(view.config.enabled);
  const [merge, setMerge] = useState(String(view.config.mergeMinutes));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [baseline, setBaseline] = useState(view.config);
  if (baseline !== view.config) {
    // Server state changed (saved elsewhere or refetched): re-seed the form during render.
    setBaseline(view.config);
    setDraft(toDraft(view.config));
    setEnabled(view.config.enabled);
    setMerge(String(view.config.mergeMinutes));
  }
  const set = (key: RuleKey, patch: Partial<Draft[RuleKey]>) => setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = draftErrors(draft, merge);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const rules = Object.fromEntries(Object.entries(draft).map(([k, r]) => [k, { enabled: r.enabled, severity: r.severity, threshold: Number(r.threshold), windowMinutes: Number(r.windowMinutes), distinct: Number(r.distinct) } satisfies RuleParams])) as CorrelationConfig["rules"];
    await onSave({ enabled, mergeMinutes: Number(merge), rules });
  };
  const ro = !view.canEdit;
  return (
    <Section title="Correlation rules" description="Rules run every minute over recent sign-in, MFA, rate-limit, ban, role and export events. Thresholds count events inside the window.">
      {ro ? <Callout tone="info" title="Read only" className="mb-4">Changing rules needs the firewall management permission.</Callout> : null}
      <form onSubmit={submit} noValidate className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Switch label="Correlation is on" description="When off, no new incidents are opened. Existing incidents stay." checked={enabled} onCheckedChange={setEnabled} disabled={ro} />
          <Field label="Merge window (minutes)" hint="New evidence this close to an open incident joins it instead of opening another." error={errors.mergeMinutes}>
            <Input type="number" inputMode="numeric" value={merge} onChange={(e) => setMerge(e.target.value)} disabled={ro} />
          </Field>
        </div>
        <ul className="space-y-4">
          {(Object.keys(draft) as RuleKey[]).map((key) => {
            const r = draft[key];
            const info = view.info[key];
            return (
              <li key={key} className="rounded-[var(--radius-card)] border border-line p-4">
                <fieldset className="min-w-0 space-y-3">
                  <legend className="text-base font-semibold text-ink break-words">{info.label}</legend>
                  <p className="text-sm text-body">{info.description}</p>
                  <Switch label={`Rule on: ${info.label}`} checked={r.enabled} onCheckedChange={(v) => set(key, { enabled: v })} disabled={ro} />
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="Severity">
                      <Select value={r.severity} disabled={ro} onChange={(e) => set(key, { severity: e.target.value as IncidentSeverity })} options={INCIDENT_SEVERITY_LIST.map((s) => ({ value: s, label: SEVERITY_META[s].label }))} />
                    </Field>
                    <Field label={`${info.threshold} (at least)`} error={errors[`${key}.threshold`]}>
                      <Input type="number" inputMode="numeric" value={r.threshold} disabled={ro} onChange={(e) => set(key, { threshold: e.target.value })} />
                    </Field>
                    <Field label="Window (minutes)" error={errors[`${key}.windowMinutes`]}>
                      <Input type="number" inputMode="numeric" value={r.windowMinutes} disabled={ro} onChange={(e) => set(key, { windowMinutes: e.target.value })} />
                    </Field>
                    {key === "credential_stuffing" ? (
                      <Field label="Different accounts and addresses (at least)" error={errors[`${key}.distinct`]}>
                        <Input type="number" inputMode="numeric" value={r.distinct} disabled={ro} onChange={(e) => set(key, { distinct: e.target.value })} />
                      </Field>
                    ) : null}
                  </div>
                </fieldset>
              </li>
            );
          })}
        </ul>
        {Object.keys(errors).length > 0 ? <Callout tone="danger" title="Rules not saved" live="assertive">Fix the highlighted values.</Callout> : null}
        {!ro ? <Button type="submit" loading={saving}>Save rules</Button> : null}
      </form>
    </Section>
  );
}

export function RunStatus({ view }: { view: RulesView }) {
  return (
    <div className="space-y-3">
      {!view.addressesDeterminable ? (
        <Callout tone="warning" title="Client addresses cannot be determined">
          The proxy settings do not identify client addresses reliably, so address-based rules may miss activity and banning an address is paused. Review the trusted proxy settings.
        </Callout>
      ) : null}
      {view.lastRun.truncated ? <Callout tone="warning" title="Last run reached its event budget">The newest events were evaluated first. Consider shorter windows.</Callout> : null}
      <p className="text-sm text-muted" role="status">
        {view.lastRun.at ? <>Last run <DateTime value={view.lastRun.at} format="relative" />: {view.lastRun.events.toLocaleString()} events, {view.lastRun.findings.toLocaleString()} findings.</> : "Correlation has not run yet."}
        {view.lastRun.reason === "DISABLED" ? " Correlation is off." : ""}
      </p>
    </div>
  );
}

export default function IncidentsPage() {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const client = useQueryClient();
  const [status, setStatus] = useState<IncidentStatus | "">("open");
  const [severity, setSeverity] = useState<IncidentSeverity | "">("");
  const [ruleKey, setRuleKey] = useState<RuleKey | "">("");
  const input = { limit: 25, ...(status ? { status } : {}), ...(severity ? { severity } : {}), ...(ruleKey ? { ruleKey } : {}) };
  const list = useInfiniteQuery(trpc.audit.incidents.list.infiniteQueryOptions(input, { getNextPageParam: (p: IncidentPage) => p.nextCursor ?? undefined }));
  const rules = useQuery(trpc.audit.incidents.rules.queryOptions());
  const save = useMutation(trpc.audit.incidents.updateRules.mutationOptions());
  const rows = list.data?.pages.flatMap((p) => p.items);
  const counts = list.data?.pages[0]?.counts;
  const ruleOptions = rules.data ? (Object.keys(rules.data.info) as RuleKey[]).map((k) => ({ value: k, label: rules.data.info[k].label })) : [];
  const activeCount = (status !== "open" ? 1 : 0) + (severity ? 1 : 0) + (ruleKey ? 1 : 0);

  const onSave = async (config: CorrelationConfig) => {
    try {
      await stepUp.run(() => save.mutateAsync(config), { reason: "Changing correlation rules requires a fresh confirmation." });
      await client.invalidateQueries({ queryKey: trpc.audit.incidents.pathKey() });
      toast.show({ title: "Correlation rules saved", tone: "success" });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) toast.show({ title: "Rules not saved", description: errorMessage(error), tone: "danger" });
    }
  };

  return (
    <>
      <PageHeader title="Security incidents" description="Incidents are opened when related security events cross a rule threshold. Review them, act, and close them with a reason." />
      <AuditNav />
      <div className="space-y-8">
        <StatGrid label="Incidents by status">
          {INCIDENT_STATUS_LIST.map((s) => <StatCard key={s} label={STATUS_META[s].label} value={counts ? counts[s].toLocaleString() : "—"} loading={list.isPending} />)}
        </StatGrid>
        {rules.data ? <RunStatus view={rules.data} /> : null}
        <Section title="Incidents">
          <FilterBar activeCount={activeCount} onReset={() => { setStatus("open"); setSeverity(""); setRuleKey(""); }}>
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus | "")} options={[{ value: "", label: "All statuses" }, ...INCIDENT_STATUS_LIST.map((s) => ({ value: s, label: STATUS_META[s].label }))]} />
            </Field>
            <Field label="Severity">
              <Select value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity | "")} options={[{ value: "", label: "All severities" }, ...INCIDENT_SEVERITY_LIST.map((s) => ({ value: s, label: SEVERITY_META[s].label }))]} />
            </Field>
            <Field label="Rule">
              <Select value={ruleKey} onChange={(e) => setRuleKey(e.target.value as RuleKey | "")} options={[{ value: "", label: "All rules" }, ...ruleOptions]} />
            </Field>
          </FilterBar>
          <IncidentsTable rows={rows} loading={list.isPending} error={list.error} onRetry={() => list.refetch()} filtered={activeCount > 0} />
          <LoadMore hasMore={Boolean(list.hasNextPage)} loading={list.isFetchingNextPage} onLoadMore={() => list.fetchNextPage()} summary={rows ? `Showing ${rows.length.toLocaleString()} incidents` : undefined} />
        </Section>
        {rules.isPending ? <Skeleton className="h-64" /> : rules.error ? <ErrorState error={rules.error} onRetry={() => rules.refetch()} /> : <RulesCard view={rules.data} onSave={onSave} saving={save.isPending} />}
      </div>
    </>
  );
}
