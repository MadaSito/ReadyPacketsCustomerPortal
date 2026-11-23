import { useMemo, useState, type FormEvent } from "react";
import { Link, useSearch } from "wouter";
import { Download, Save } from "lucide-react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Button, Callout, Checkbox, Dialog, Drawer, ErrorState, Field, FilterBar, Input, LoadMore, PageHeader, RadioGroup,
  Select, Skeleton, StepUpCancelledError, useStepUp, useToast,
} from "@/ui";
import { AuditNav } from "./AuditNav";
import { EventDetailPanel, EventsTable } from "./EventParts";
import { QueryBuilder } from "./QueryBuilder";
import {
  buildQuery, CATEGORIES, countActive, DEFAULT_FILTERS, invalidIdentifier, label, OUTCOMES, RANGES, readParam, SEVERITIES,
  type AuditQuery, type Filters,
} from "./model";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const REF_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Where the active search came from, when it is not the filter form. */
type Override = { query: AuditQuery; source: string };

export default function AuditCenterPage() {
  const trpc = useTRPC();
  const api = useTRPCClient();
  const toast = useToast();
  const search = useSearch();
  const [draft, setDraft] = useState<Filters>(() => {
    const correlation = readParam(search, "correlationId");
    return correlation && REF_ID.test(correlation) ? { ...DEFAULT_FILTERS, range: "30d", ids: correlation } : DEFAULT_FILTERS;
  });
  const [applied, setApplied] = useState(() => ({ filters: draft, query: buildQuery(draft) }));
  const [actorId, setActorId] = useState("");
  const [appliedActor, setAppliedActor] = useState<string | undefined>(undefined);
  const [override, setOverride] = useState<Override | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => {
    // `?event=<id>`: open one event's drawer (links from security incidents).
    const id = readParam(search, "event");
    return id && ULID.test(id) ? id : null;
  });
  const [dialog, setDialog] = useState<"save" | "export" | "case" | null>(null);

  // `?saved=<id>`: load a saved search once the list is available.
  const savedId = readParam(search, "saved");
  const saved = useQuery({ ...trpc.audit.savedQueries.list.queryOptions(), enabled: Boolean(savedId && ULID.test(savedId)) });
  const [savedHandled, setSavedHandled] = useState<string | null>(null);
  const [savedMissing, setSavedMissing] = useState(false);
  if (savedId && savedHandled !== savedId && (saved.data || !ULID.test(savedId))) {
    // Adjust state during render (not in an effect): apply the saved search exactly once per id.
    setSavedHandled(savedId);
    const found = saved.data?.find((q) => q.id === savedId);
    if (found) setOverride({ query: found.query, source: `Saved search “${found.name}”` });
    else setSavedMissing(true);
  }

  // `?incident=<id>`: show the ready-made search of one security incident (D7), once.
  const incidentId = readParam(search, "incident");
  const incidentOk = Boolean(incidentId && ULID.test(incidentId));
  const incident = useQuery({ ...trpc.audit.incidents.get.queryOptions({ publicId: incidentOk && incidentId ? incidentId : "" }), enabled: incidentOk, retry: false });
  const [incidentHandled, setIncidentHandled] = useState<string | null>(null);
  if (incidentOk && incidentId && incidentHandled !== incidentId && (incident.data || incident.error)) {
    setIncidentHandled(incidentId);
    if (incident.data) setOverride({ query: incident.data.auditQuery, source: `Events of incident “${incident.data.ruleLabel}”` });
  }

  const query = override?.query ?? applied.query;
  const input = { query, limit: 50, ...(appliedActor ? { actorUserPublicId: appliedActor } : {}) };
  const list = useInfiniteQuery(trpc.audit.search.infiniteQueryOptions(input, { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items), [list.data]);
  const freshness = list.data?.pages[0]?.freshness;

  const apply = (next: Filters = draft) => {
    const problem = invalidIdentifier(next);
    const actor = actorId.trim();
    if (problem) return setFormError(problem);
    if (actor && !ULID.test(actor)) return setFormError("The user ID is the 26-character account reference shown on the user's profile.");
    setFormError(null);
    setOverride(null);
    setAppliedActor(actor || undefined);
    setApplied({ filters: next, query: buildQuery(next) });
  };
  const reset = () => {
    setDraft(DEFAULT_FILTERS);
    setActorId("");
    setOverride(null);
    setFormError(null);
    setAppliedActor(undefined);
    setApplied({ filters: DEFAULT_FILTERS, query: buildQuery(DEFAULT_FILTERS) });
  };

  const [pivoting, setPivoting] = useState<string | null>(null);
  const pivot = async (eventId: string, kind: string) => {
    setPivoting(kind);
    try {
      const result = await api.audit.pivot.query({ eventId, kind: kind as never });
      setOverride({ query: result.query, source: "Related events" });
      setSelected(null);
    } catch (error) {
      toast.show({ title: "Could not follow this event", description: errorMessage(error), tone: "danger" });
    } finally {
      setPivoting(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Audit center"
        description="Search the tamper-evident record of security, administrative and business activity."
        actions={
          <>
            <Button variant="secondary" leadingIcon={<Save aria-hidden className="size-4" />} onClick={() => setDialog("save")}>Save search</Button>
            <Button leadingIcon={<Download aria-hidden className="size-4" />} onClick={() => setDialog("export")}>Export</Button>
          </>
        }
      />
      <AuditNav />
      <div className="space-y-4">
        <FilterBar
          search={draft.ids}
          onSearchChange={(ids) => setDraft({ ...draft, ids })}
          onSearchSubmit={(ids) => apply({ ...draft, ids })}
          searchLabel="Find by ID"
          searchPlaceholder="Request, trace, correlation, job or resource ID"
          activeCount={countActive(applied.filters) + (appliedActor ? 1 : 0)}
          onReset={reset}
        >
          <Field label="Time range">
            <Select value={draft.range} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} onChange={(e) => setDraft({ ...draft, range: e.target.value as Filters["range"] })} />
          </Field>
          <Field label="Category">
            <Select value={draft.category} placeholder="All categories" options={CATEGORIES.map((c) => ({ value: c, label: label(c) }))} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
          </Field>
          <Field label="Outcome">
            <Select value={draft.outcome} placeholder="All outcomes" options={OUTCOMES.map((o) => ({ value: o, label: label(o) }))} onChange={(e) => setDraft({ ...draft, outcome: e.target.value })} />
          </Field>
          <Field label="Minimum severity">
            <Select value={draft.minSeverity} placeholder="Any severity" options={SEVERITIES.map((s) => ({ value: s, label: s }))} onChange={(e) => setDraft({ ...draft, minSeverity: e.target.value })} />
          </Field>
          <Field label="Actor user ID">
            <Input value={actorId} maxLength={26} autoComplete="off" spellCheck={false} onChange={(e) => setActorId(e.target.value)} />
          </Field>
        </FilterBar>
        <details className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <summary className="min-h-11 cursor-pointer content-center font-medium text-ink">Advanced conditions{draft.conditions.length ? ` (${draft.conditions.length})` : ""}</summary>
          <div className="mt-4 space-y-4">
            <QueryBuilder filters={draft} onChange={setDraft} />
          </div>
        </details>
        {savedMissing ? <Callout tone="warning" title="Saved search not found" actions={<Button size="sm" variant="secondary" onClick={() => setSavedMissing(false)}>Dismiss</Button>}>It may have been deleted or is no longer shared.</Callout> : null}
        {formError ? <Callout tone="danger" title="Check the filters" live="assertive">{formError}</Callout> : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => apply()}>Apply filters</Button>
        </div>
      </div>

      <div className="mt-6 space-y-4">
        {override ? (
          <Callout tone="info" title={override.source} actions={<Button size="sm" variant="secondary" onClick={() => setOverride(null)}>Back to my filters</Button>}>
            Showing events from <time dateTime={override.query.from}>{new Date(override.query.from).toLocaleString()}</time> to <time dateTime={override.query.to}>{new Date(override.query.to).toLocaleString()}</time>.
          </Callout>
        ) : null}
        {freshness ? (
          <p className="text-sm text-muted">
            Sealed through record #{freshness.headSeq.toLocaleString()}. Events from the last few seconds may not be sealed yet; <Link href="/admin/audit/integrity" className="text-action underline">check integrity</Link>.
          </p>
        ) : null}
        <EventsTable rows={rows} loading={list.isPending} error={list.error} onRetry={() => list.refetch()} onOpen={(e) => setSelected(e.event_id)} />
        {rows && rows.length > 0 ? (
          <LoadMore hasMore={Boolean(list.hasNextPage)} loading={list.isFetchingNextPage} onLoadMore={() => list.fetchNextPage()} summary={`Showing ${rows.length} event${rows.length === 1 ? "" : "s"}, newest first`} label="Load more events" />
        ) : null}
      </div>

      <EventDrawer eventId={selected} onClose={() => setSelected(null)} onPivot={pivot} pivoting={pivoting} onAddToCase={() => setDialog("case")} />
      <SaveSearchDialog open={dialog === "save"} onClose={() => setDialog(null)} query={query} />
      <ExportDialog open={dialog === "export"} onClose={() => setDialog(null)} query={query} />
      <AddToCaseDialog open={dialog === "case"} onClose={() => setDialog(null)} eventId={selected} />
    </>
  );
}

function EventDrawer({ eventId, onClose, onPivot, pivoting, onAddToCase }: {
  eventId: string | null; onClose: () => void; onPivot: (eventId: string, kind: string) => void; pivoting: string | null; onAddToCase: () => void;
}) {
  const trpc = useTRPC();
  const detail = useQuery({ ...trpc.audit.event.queryOptions({ eventId: eventId ?? "" }), enabled: Boolean(eventId) });
  const reveal = useMutation(trpc.audit.revealSourceAddress.mutationOptions());
  const [revealed, setRevealed] = useState<{ id: string; address: string | null } | null>(null);
  return (
    <Drawer open={Boolean(eventId)} onOpenChange={(open) => !open && onClose()} title="Event details" width="lg">
      {detail.isPending ? (
        <div role="status" aria-label="Loading event" className="space-y-3"><Skeleton className="h-8" /><Skeleton className="h-40" /></div>
      ) : detail.error ? (
        <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
      ) : detail.data ? (
        <>
          {reveal.error ? <ErrorState error={reveal.error} title="The address could not be revealed" className="mb-4" /> : null}
          <EventDetailPanel
            detail={detail.data}
            revealed={revealed && revealed.id === eventId ? revealed.address : undefined}
            revealing={reveal.isPending}
            onReveal={async () => {
              if (!eventId) return;
              const result = await reveal.mutateAsync({ eventId }).catch(() => null);
              if (result) setRevealed({ id: eventId, address: result.address });
            }}
            onPivot={(kind) => eventId && onPivot(eventId, kind)}
            pivoting={pivoting}
            onAddToCase={onAddToCase}
          />
        </>
      ) : null}
    </Drawer>
  );
}

function SaveSearchDialog({ open, onClose, query }: { open: boolean; onClose: () => void; query: AuditQuery }) {
  const trpc = useTRPC();
  const toast = useToast();
  const client = useQueryClient();
  const save = useMutation(trpc.audit.savedQueries.save.mutationOptions());
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Give the search a name.");
    setError(null);
    try {
      await save.mutateAsync({ name: name.trim(), shared, query });
      await client.invalidateQueries({ queryKey: trpc.audit.savedQueries.list.queryKey() });
      toast.show({ title: "Search saved", tone: "success" });
      setName("");
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "The search could not be saved."));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Save this search" description="Saves the filters and the exact time window currently shown." dismissible={!save.isPending}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Name" error={error ?? undefined}>
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Checkbox label="Share with other administrators" checked={shared} onCheckedChange={setShared} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>Save search</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ExportDialog({ open, onClose, query }: { open: boolean; onClose: () => void; query: AuditQuery }) {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const client = useQueryClient();
  const request = useMutation(trpc.audit.exports.request.mutationOptions());
  const [format, setFormat] = useState<"jsonl" | "csv" | "cef">("jsonl");
  const [profile, setProfile] = useState<"external" | "local">("external");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await stepUp.run(() => request.mutateAsync({ format, profile, query }), { reason: "Exporting audit evidence requires a fresh confirmation." });
      await client.invalidateQueries({ queryKey: trpc.audit.exports.list.queryKey() });
      toast.show({ title: "Export queued", description: "Follow its progress on the Exports page.", tone: "success" });
      onClose();
    } catch (cause) {
      if (!(cause instanceof StepUpCancelledError)) setError(errorMessage(cause, "The export could not be started."));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Export these events" description="The export includes only sealed events in the current search, up to 100,000 rows." dismissible={!request.isPending}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Format">
          <Select value={format} onChange={(e) => setFormat(e.target.value as typeof format)} options={[
            { value: "jsonl", label: "JSON Lines (.jsonl)" },
            { value: "csv", label: "Spreadsheet (.csv)" },
            { value: "cef", label: "Common Event Format (.cef)" },
          ]} />
        </Field>
        <RadioGroup legend="Privacy profile" value={profile} onValueChange={(v) => setProfile(v === "local" ? "local" : "external")} options={[
          { value: "external", label: "For sharing", description: "Pseudonymous references only; safe to hand to a SIEM or auditor." },
          { value: "local", label: "Internal only", description: "Adds installation-local identifiers. Keep it inside your organisation." },
        ]} />
        {error ? <Callout tone="danger" title="Export not started" live="assertive">{error}</Callout> : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={request.isPending}>Start export</Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddToCaseDialog({ open, onClose, eventId }: { open: boolean; onClose: () => void; eventId: string | null }) {
  const trpc = useTRPC();
  const toast = useToast();
  const client = useQueryClient();
  const cases = useQuery({ ...trpc.audit.cases.list.queryOptions({ status: "open", limit: 100 }), enabled: open });
  const attach = useMutation(trpc.audit.cases.attachEvents.mutationOptions());
  const create = useMutation(trpc.audit.cases.create.mutationOptions());
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [caseId, setCaseId] = useState("");
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<"INFO" | "WARN" | "ERROR" | "FATAL">("WARN");
  const [error, setError] = useState<string | null>(null);
  const busy = attach.isPending || create.isPending;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!eventId) return;
    setError(null);
    try {
      if (mode === "existing") {
        if (!caseId) return setError("Choose a case.");
        await attach.mutateAsync({ id: caseId, eventIds: [eventId] });
      } else {
        if (!title.trim()) return setError("Give the case a title.");
        await create.mutateAsync({ title: title.trim(), severity, eventIds: [eventId] });
      }
      await client.invalidateQueries({ queryKey: trpc.audit.cases.pathKey() });
      await client.invalidateQueries({ queryKey: trpc.audit.event.queryKey({ eventId }) });
      toast.show({ title: "Event added to case", tone: "success" });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "The event could not be added."));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Add event to a case" dismissible={!busy}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <RadioGroup legend="Case" value={mode} onValueChange={(v) => setMode(v === "new" ? "new" : "existing")} orientation="horizontal" options={[
          { value: "existing", label: "Existing open case" },
          { value: "new", label: "New case" },
        ]} />
        {mode === "existing" ? (
          cases.error ? <ErrorState error={cases.error} onRetry={() => cases.refetch()} /> : (
            <Field label="Open case" hint={cases.data && cases.data.items.length === 0 ? "There are no open cases. Create a new one instead." : undefined}>
              <Select value={caseId} placeholder={cases.isPending ? "Loading cases…" : "Choose a case"} disabled={cases.isPending} options={(cases.data?.items ?? []).map((c) => ({ value: c.id, label: c.title }))} onChange={(e) => setCaseId(e.target.value)} />
            </Field>
          )
        ) : (
          <>
            <Field label="Title"><Input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label="Severity">
              <Select value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)} options={["INFO", "WARN", "ERROR", "FATAL"].map((s) => ({ value: s, label: s }))} />
            </Field>
          </>
        )}
        {error ? <Callout tone="danger" title="Not added" live="assertive">{error}</Callout> : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Add to case</Button>
        </div>
      </form>
    </Dialog>
  );
}
