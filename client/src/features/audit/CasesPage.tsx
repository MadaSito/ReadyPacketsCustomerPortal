import { useState, type FormEvent } from "react";
import { FolderSearch, Plus } from "lucide-react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Button, Callout, DataTable, DateTime, Dialog, Drawer, EmptyState, ErrorState, Field, FilterBar, Input, KeyValueList,
  LoadMore, PageHeader, Section, Select, Skeleton, Textarea, useToast,
} from "@/ui";
import { AuditNav } from "./AuditNav";
import { EventsTable, SeverityBadge } from "./EventParts";
import { label, type CaseDetail, type CaseSummary } from "./model";

const STATUSES = ["open", "investigating", "closed"] as const;
type Status = (typeof STATUSES)[number];
const statusTone = { open: "info", investigating: "warning", closed: "neutral" } as const;

export function CaseStatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone[status as Status] ?? "neutral"}>{label(status)}</Badge>;
}

export function CasesTable({ rows, loading, error, onRetry, onOpen }: {
  rows: readonly CaseSummary[] | undefined; loading: boolean; error: unknown; onRetry: () => void; onOpen: (row: CaseSummary) => void;
}) {
  return (
    <DataTable
      caption="Investigation cases"
      rows={rows}
      loading={loading}
      error={error}
      onRetry={onRetry}
      rowKey={(r) => r.id}
      empty={<EmptyState icon={FolderSearch} title="No cases" description="Create a case to group related audit events and keep investigation notes." />}
      columns={[
        { key: "title", header: "Title", primary: true, cell: (r) => <Button variant="link" className="min-h-11 text-left break-words" onClick={() => onOpen(r)}>{r.title}</Button> },
        { key: "status", header: "Status", cell: (r) => <CaseStatusBadge status={r.status} /> },
        { key: "severity", header: "Severity", cell: (r) => <SeverityBadge severity={r.severity} /> },
        { key: "events", header: "Events", align: "end", cell: (r) => r.eventCount.toLocaleString() },
        { key: "updated", header: "Updated", cell: (r) => <DateTime value={r.updatedAt} format="relative" /> },
      ]}
    />
  );
}

export function CaseDetailView({ detail, onStatus, statusBusy, onAddNote, noteBusy }: {
  detail: CaseDetail; onStatus: (status: Status) => void; statusBusy: boolean; onAddNote: (body: string) => Promise<boolean>; noteBusy: boolean;
}) {
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return setNoteError("Write a note first.");
    setNoteError(null);
    if (await onAddNote(note.trim())) setNote("");
  };
  return (
    <div className="space-y-6">
      <KeyValueList columns={2} items={[
        { label: "Status", value: <CaseStatusBadge status={detail.status} /> },
        { label: "Severity", value: <SeverityBadge severity={detail.severity} /> },
        { label: "Opened", value: <DateTime value={detail.createdAt} format="datetime" /> },
        { label: "Closed", value: detail.closedAt ? <DateTime value={detail.closedAt} format="datetime" /> : null },
      ]} />
      <Field label="Change status">
        <Select value={detail.status} disabled={statusBusy} options={STATUSES.map((s) => ({ value: s, label: label(s) }))} onChange={(e) => onStatus(e.target.value as Status)} />
      </Field>
      <Section title={`Events (${detail.events.length})`} headingLevel={3}>
        <EventsTable rows={detail.events} loading={false} error={null} onRetry={() => undefined}
          empty={<p className="text-sm text-muted">No events are attached. Use Add to case from an event on the Events page.</p>} />
      </Section>
      <Section title="Notes" headingLevel={3} description="Notes are encrypted at rest. Do not paste passwords or secrets.">
        {detail.notes.length === 0 ? <p className="text-sm text-muted">No notes yet.</p> : (
          <ol className="space-y-3">
            {detail.notes.map((n) => (
              <li key={n.id} className="rounded-[var(--radius-card)] border border-line p-3">
                <p className="text-xs text-muted">{n.authorIsMe ? "You" : "Another administrator"} · <DateTime value={n.createdAt} format="datetime" /></p>
                <p className="mt-1 whitespace-pre-wrap break-words text-ink">{n.body}</p>
              </li>
            ))}
          </ol>
        )}
        <form onSubmit={submit} noValidate className="mt-4 space-y-3">
          <Field label="Add a note" error={noteError ?? undefined}>
            <Textarea value={note} maxLength={4000} rows={4} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button type="submit" size="sm" loading={noteBusy}>Add note</Button>
        </form>
      </Section>
    </div>
  );
}

export default function CasesPage() {
  const trpc = useTRPC();
  const toast = useToast();
  const client = useQueryClient();
  const [status, setStatus] = useState<Status | "">("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useInfiniteQuery(trpc.audit.cases.list.infiniteQueryOptions({ limit: 25, ...(status ? { status } : {}) }, { getNextPageParam: (p) => p.nextCursor ?? undefined }));
  const rows = list.data?.pages.flatMap((p) => p.items);
  const detail = useQuery({ ...trpc.audit.cases.get.queryOptions({ id: openId ?? "" }), enabled: Boolean(openId) });
  const setCaseStatus = useMutation(trpc.audit.cases.setStatus.mutationOptions());
  const addNote = useMutation(trpc.audit.cases.addNote.mutationOptions());
  const refresh = () => client.invalidateQueries({ queryKey: trpc.audit.cases.pathKey() });

  return (
    <>
      <PageHeader title="Investigation cases" description="Group related audit events, track status and keep encrypted notes."
        actions={<Button leadingIcon={<Plus aria-hidden className="size-4" />} onClick={() => setCreating(true)}>New case</Button>} />
      <AuditNav />
      <FilterBar activeCount={status ? 1 : 0} onReset={() => setStatus("")}>
        <Field label="Status">
          <Select value={status} placeholder="All statuses" options={STATUSES.map((s) => ({ value: s, label: label(s) }))} onChange={(e) => setStatus(e.target.value as Status | "")} />
        </Field>
      </FilterBar>
      <div className="mt-4">
        <CasesTable rows={rows} loading={list.isPending} error={list.error} onRetry={() => list.refetch()} onOpen={(r) => setOpenId(r.id)} />
        {rows && rows.length > 0 ? <LoadMore hasMore={Boolean(list.hasNextPage)} loading={list.isFetchingNextPage} onLoadMore={() => list.fetchNextPage()} summary={`Showing ${rows.length} case${rows.length === 1 ? "" : "s"}`} /> : null}
      </div>
      <Drawer open={Boolean(openId)} onOpenChange={(o) => !o && setOpenId(null)} title={detail.data?.title ?? "Case"} width="lg">
        {detail.isPending ? <div role="status" aria-label="Loading case" className="space-y-3"><Skeleton className="h-8" /><Skeleton className="h-40" /></div>
          : detail.error ? <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
          : detail.data ? (
            <CaseDetailView
              detail={detail.data}
              statusBusy={setCaseStatus.isPending}
              onStatus={async (next) => {
                try {
                  await setCaseStatus.mutateAsync({ id: detail.data.id, status: next });
                  await refresh();
                  toast.show({ title: `Case marked ${label(next).toLowerCase()}`, tone: "success" });
                } catch (error) {
                  toast.show({ title: "Status not changed", description: errorMessage(error), tone: "danger" });
                }
              }}
              noteBusy={addNote.isPending}
              onAddNote={async (body) => {
                try {
                  await addNote.mutateAsync({ id: detail.data.id, body });
                  await refresh();
                  return true;
                } catch (error) {
                  toast.show({ title: "Note not added", description: errorMessage(error), tone: "danger" });
                  return false;
                }
              }}
            />
          ) : null}
      </Drawer>
      <CreateCaseDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); void refresh(); }} />
    </>
  );
}

function CreateCaseDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const trpc = useTRPC();
  const create = useMutation(trpc.audit.cases.create.mutationOptions());
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<"INFO" | "WARN" | "ERROR" | "FATAL">("WARN");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError("Give the case a title.");
    setError(null);
    try {
      const { id } = await create.mutateAsync({ title: title.trim(), severity });
      setTitle("");
      onCreated(id);
    } catch (cause) {
      setError(errorMessage(cause, "The case could not be created."));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="New investigation case" dismissible={!create.isPending}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Title" hint="Avoid names, e-mail addresses or secrets; titles are encrypted but shown to all administrators.">
          <Input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Severity">
          <Select value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)} options={["INFO", "WARN", "ERROR", "FATAL"].map((s) => ({ value: s, label: s }))} />
        </Field>
        {error ? <Callout tone="danger" title="Case not created" live="assertive">{error}</Callout> : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={create.isPending}>Create case</Button>
        </div>
      </form>
    </Dialog>
  );
}
