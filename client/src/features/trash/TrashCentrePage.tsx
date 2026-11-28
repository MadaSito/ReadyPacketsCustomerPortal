/**
 * Trash centre `/admin/trash` (increment 09 D2.7). Owner: audit_engineer.
 * Tabs Orders and Customers; filters (text, date range, moved by, due within N days), sort, cursor pages, row and
 * bulk restore / delete permanently (explicit list of public ids ≤ 100, D2.8), the retention panel and the last
 * clean-up run. Desktop: a table; phones: labelled cards (DataTable), no horizontal scroll at 240 px.
 * Results are announced in one polite live region; after a row leaves the list, focus goes to the list heading.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge, Button, DataTable, DateTime, EmptyState, Field, FilterBar, Input, PageHeader, Pagination, Select, Tabs, type Column, type SortState } from "@/ui";
import { useTrashApi, type TrashKind, type TrashListInput, type TrashRow } from "./api";
import { EXTERNAL_COPIES_UNREACHABLE, STATE_META, dueText, restoreBlockedText, unreachableCopiesText } from "./model";
import { RetentionPanel } from "./RetentionPanel";
import { FinishLeavingCopiesDialog, PurgeDialog, RestoreDialog, type TrashTarget } from "./TrashDialogs";

export const PAGE_SIZE = 25;

/** D2.8: bulk actions carry at most this many public ids. */
export const BULK_MAX = 100;

const DUE_OPTIONS = [
  { value: "", label: "Any time" },
  { value: "1", label: "Within 1 day" },
  { value: "7", label: "Within 7 days" },
  { value: "30", label: "Within 30 days" },
];

interface Filters { q: string; movedFrom: string; movedTo: string; movedBy: string; dueWithin: string }
const NO_FILTERS: Filters = { q: "", movedFrom: "", movedTo: "", movedBy: "", dueWithin: "" };

export function toListInput(kind: TrashKind, f: Filters, sort: SortState, cursor: string | null): TrashListInput {
  return {
    kind,
    q: f.q.trim() || undefined,
    movedFrom: f.movedFrom ? new Date(`${f.movedFrom}T00:00:00`).toISOString() : undefined,
    movedTo: f.movedTo ? new Date(`${f.movedTo}T23:59:59.999`).toISOString() : undefined,
    movedByPublicId: f.movedBy || undefined,
    dueWithinDays: f.dueWithin ? Number(f.dueWithin) : undefined,
    sort: sort.key === "dueAt" ? "dueAt" : "movedAt",
    dir: sort.direction,
    cursor,
    limit: PAGE_SIZE,
  };
}

const target = (r: TrashRow): TrashTarget => ({ kind: r.kind, publicId: r.publicId, batchId: r.batchId, label: r.label, reference: r.reference, runId: r.failedRunId ?? undefined, copies: r.unreachableExternalCopies ?? undefined, targetOrderPublicId: r.failedTargetPublicId ?? undefined, targetReference: r.failedTargetReference ?? undefined });

const finishLabel = (n: number) => `Finish and leave ${n} external ${n === 1 ? "copy" : "copies"} in place`;

/** Row buttons; one instance per rendering (table and phone card), so the reason id is unique (useId). */
function RowActions({ row: r, onRestore, onPurge, onFinish }: { row: TrashRow; onRestore: () => void; onPurge: () => void; onFinish: () => void }) {
  const reasonId = useId();
  return (
    <span className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={onRestore} disabled={!r.canRestore} aria-label={`Restore ${r.label}`} aria-describedby={r.restoreBlockedReason ? reasonId : undefined}>
        Restore
      </Button>
      <Button size="sm" variant="danger" onClick={onPurge} aria-label={`Delete permanently ${r.label}`} disabled={r.state === "deleting"}>
        Delete permanently
      </Button>
      {r.failureCode === EXTERNAL_COPIES_UNREACHABLE && r.failedRunId ? (
        <Button size="sm" variant="danger" onClick={onFinish} aria-label={`${finishLabel(r.unreachableExternalCopies ?? 0)}, ${r.label}`}>
          {finishLabel(r.unreachableExternalCopies ?? 0)}
        </Button>
      ) : null}
      {r.restoreBlockedReason ? <span id={reasonId} className="w-full text-xs break-words text-body">{restoreBlockedText(r.restoreBlockedReason)}</span> : null}
    </span>
  );
}

function TrashList({ kind, onAnnounce }: { kind: TrashKind; onAnnounce: (text: string) => void }) {
  const api = useTrashApi();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "movedAt", direction: "desc" });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ action: "restore" | "purge" | "finish"; items: TrashTarget[] } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Result sentence waiting for the dialog to close (the modal hides the page live region until then). */
  const pendingResult = useRef<string | null>(null);
  /** Where the closing dialog puts focus: the heading after a success (the row is gone), else the opener. */
  const returnFocus = useRef<HTMLElement | null>(null);
  const cursor = cursors[cursors.length - 1] ?? null;
  const list = useQuery({ ...api.list.queryOptions(toListInput(kind, filters, sort, cursor)), placeholderData: keepPreviousData });
  const people = useQuery(api.movedByOptions.queryOptions());
  const rows = list.data?.items;
  const noun = kind === "order" ? "orders" : "customer accounts";
  const title = kind === "order" ? "Orders in the trash" : "Customer accounts in the trash";

  const reset = (next: Partial<Filters>) => { setFilters((f) => ({ ...f, ...next })); setCursors([null]); setSelected(new Set()); };
  const active = Object.entries(filters).filter(([, v]) => v !== "").length;
  const chosen = (rows ?? []).filter((r) => selected.has(r.publicId));

  // After a restore or purge the row (and its button) is gone: move focus to the list heading, not the body.
  // Announce once the modal (which hides the page live region) has closed.
  useEffect(() => {
    if (dialog || pendingResult.current === null) return;
    const sentence = pendingResult.current;
    pendingResult.current = null;
    const timer = setTimeout(() => onAnnounce(sentence), 0);
    return () => clearTimeout(timer);
  }, [dialog, onAnnounce]);

  const openDialog = (next: { action: "restore" | "purge" | "finish"; items: TrashTarget[] }) => {
    returnFocus.current = null;
    setDialog(next);
  };
  const done = (sentence: string) => {
    pendingResult.current = sentence;
    returnFocus.current = headingRef.current;
    setSelected(new Set());
  };

  const columns: Column<TrashRow>[] = [
    { key: "item", header: "Item", primary: true, cell: (r) => <span className="font-medium break-words text-ink">{r.label}</span> },
    ...(kind === "order" ? [{ key: "owner", header: "Customer ID", cell: (r: TrashRow) => <span className="font-mono text-sm break-all">{r.ownerCustomerId ?? "—"}</span> }] : []),
    { key: "movedBy", header: "Moved by", cell: (r) => <span className="break-words">{r.movedBy?.displayName ?? "System"}</span> },
    { key: "movedAt", header: "Moved on", sortable: true, cell: (r) => <DateTime value={r.movedAt} /> },
    { key: "reason", header: "Reason", cell: (r) => (r.reason ? <span className="break-words" data-clarity-mask="true">{r.reason}</span> : <span className="text-muted">None given</span>) },
    { key: "dueAt", header: "Deletes on", sortable: true, cell: (r) => <span className="break-words">{dueText(r.dueAt)}</span> },
    {
      key: "state", header: "State", cell: (r) => (
        <span className="flex flex-col items-start gap-1">
          <Badge tone={STATE_META[r.state].tone}>{STATE_META[r.state].label}</Badge>
          {r.state === "failed" ? (
            <span className="text-xs break-words text-body">
              {r.failureCode === EXTERNAL_COPIES_UNREACHABLE ? unreachableCopiesText(r.unreachableExternalCopies ?? 0) : "Retried at the next clean-up."}
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <section aria-labelledby={`trash-${kind}-h`} className="flex min-w-0 flex-col gap-4">
      <h2 id={`trash-${kind}-h`} ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-ink outline-none">
        {title}{list.data ? ` (${list.data.total})` : ""}
      </h2>
      <FilterBar
        search={search}
        onSearchChange={setSearch}
        onSearchSubmit={(v) => reset({ q: v })}
        searchLabel={kind === "order" ? "Search by order number or project" : "Search by customer ID"}
        activeCount={active}
        onReset={() => { setSearch(""); reset(NO_FILTERS); }}
      >
        <Field label="Moved from">
          <Input type="date" value={filters.movedFrom} onChange={(e) => reset({ movedFrom: e.target.value })} />
        </Field>
        <Field label="Moved until">
          <Input type="date" value={filters.movedTo} onChange={(e) => reset({ movedTo: e.target.value })} />
        </Field>
        <Field label="Moved by">
          <Select value={filters.movedBy} onChange={(e) => reset({ movedBy: e.target.value })}
            options={[{ value: "", label: "Anyone" }, ...(people.data ?? []).map((p) => ({ value: p.publicId, label: p.displayName }))]} />
        </Field>
        <Field label="Deletes">
          <Select value={filters.dueWithin} onChange={(e) => reset({ dueWithin: e.target.value })} options={DUE_OPTIONS} />
        </Field>
      </FilterBar>

      {chosen.length ? (
        <div role="group" aria-label="Actions for the selected items" className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => openDialog({ action: "restore", items: chosen.filter((r) => r.canRestore).map(target) })} disabled={!chosen.some((r) => r.canRestore)}>
            Restore selected ({chosen.filter((r) => r.canRestore).length})
          </Button>
          <Button variant="danger" onClick={() => openDialog({ action: "purge", items: chosen.filter((r) => r.state !== "deleting").map(target) })} disabled={!chosen.some((r) => r.state !== "deleting")}>
            Delete selected permanently ({chosen.filter((r) => r.state !== "deleting").length})
          </Button>
        </div>
      ) : null}

      <DataTable<TrashRow>
        caption={title}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.publicId}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        sort={sort}
        onSortChange={(s) => { setSort(s); setCursors([null]); }}
        selection={{
          selectedKeys: selected,
          onSelectedKeysChange: (next) => setSelected(new Set([...next].slice(0, BULK_MAX))),
          rowLabel: (r) => `Select ${r.label}`,
          isSelectable: (r) => r.state !== "deleting",
          noun,
        }}
        empty={
          <EmptyState
            variant={active ? "filtered" : "default"}
            headingLevel={3}
            title={active ? `No ${noun} match these filters` : `No ${noun} in the trash`}
            description={active ? "Change or clear the filters." : `${kind === "order" ? "Orders" : "Suspended customer accounts"} moved to the trash appear here until they are restored or deleted permanently.`}
            onClearFilters={active ? () => { setSearch(""); reset(NO_FILTERS); } : undefined}
          />
        }
        rowActions={(r) => (
          <RowActions row={r} onRestore={() => openDialog({ action: "restore", items: [target(r)] })} onPurge={() => openDialog({ action: "purge", items: [target(r)] })} onFinish={() => openDialog({ action: "finish", items: [target(r)] })} />
        )}
      />

      {rows && rows.length ? (
        <Pagination
          label={`${title} pages`}
          summary={`Page ${cursors.length}, ${rows.length} of ${list.data?.total ?? rows.length} shown`}
          loading={list.isFetching}
          hasPrevious={cursors.length > 1}
          hasNext={Boolean(list.data?.nextCursor)}
          onPrevious={() => { setCursors((c) => c.slice(0, -1)); setSelected(new Set()); }}
          onNext={() => { const next = list.data?.nextCursor; if (next) { setCursors((c) => [...c, next]); setSelected(new Set()); } }}
        />
      ) : null}

      <RestoreDialog open={dialog?.action === "restore"} onOpenChange={(o) => { if (!o) setDialog(null); }} kind={kind} items={dialog?.action === "restore" ? dialog.items : []} onDone={done} returnFocusRef={returnFocus} />
      <FinishLeavingCopiesDialog open={dialog?.action === "finish"} onOpenChange={(o) => { if (!o) setDialog(null); }} item={dialog?.action === "finish" ? dialog.items[0] ?? null : null} onDone={done} returnFocusRef={returnFocus} />
      <PurgeDialog open={dialog?.action === "purge"} onOpenChange={(o) => { if (!o) setDialog(null); }} kind={kind} items={dialog?.action === "purge" ? dialog.items : []} onDone={done} returnFocusRef={returnFocus} />
    </section>
  );
}

export default function TrashCentrePage() {
  const api = useTrashApi();
  const counts = useQuery(api.counts.queryOptions());
  const [tab, setTab] = useState<TrashKind>("order");
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((text: string) => setAnnouncement((prev) => (prev === text ? `${text}\u00a0` : text)), []);
  return (
    <>
      <PageHeader
        title="Trash"
        description="Orders and suspended customer accounts moved to the trash. Restore them, or delete them permanently. Permanent deletion cannot be undone."
      />
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      <div className="flex min-w-0 flex-col gap-6">
        <Tabs
          label="Trash sections"
          value={tab}
          onValueChange={(v) => setTab(v === "customer" ? "customer" : "order")}
          items={[
            { value: "order", label: "Orders", badge: counts.data ? <Badge>{counts.data.orders}</Badge> : undefined, content: <TrashList kind="order" onAnnounce={announce} /> },
            { value: "customer", label: "Customers", badge: counts.data ? <Badge>{counts.data.customers}</Badge> : undefined, content: <TrashList kind="customer" onAnnounce={announce} /> },
          ]}
        />
        <RetentionPanel onAnnounce={announce} />
      </div>
    </>
  );
}

