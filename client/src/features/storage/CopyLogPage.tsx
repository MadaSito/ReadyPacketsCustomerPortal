import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, HardDriveDownload } from "lucide-react";
import { Link, useSearch } from "wouter";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Button, Callout, DataTable, DateTime, Drawer, EmptyState, ErrorState, Field, Input, KeyValueList,
  LoadMore, PageHeader, Select, Skeleton, StepUpCancelledError, useStepUp, useToast,
} from "@/ui";

const kinds = {
  order_file: "Order file",
  backup_archive: "Backup archive",
  sharepoint_order: "SharePoint order data",
} as const;
const states = {
  queued: "Queued",
  written: "Written",
  verified: "Verified",
  failed: "Failed",
  not_written: "Not written",
} as const;
type Kind = keyof typeof kinds;
type State = keyof typeof states;
type Filters = { kind?: Kind; state?: State; connectionPublicId?: string; text?: string; from?: string; through?: string };
type Draft = { kind: Kind | ""; state: State | ""; connection: string; text: string; from: string; through: string };
const emptyDraft: Draft = { kind: "", state: "", connection: "", text: "", from: "", through: "" };
const stateTones = { queued: "info", written: "info", verified: "success", failed: "danger", not_written: "neutral" } as const;
const options = (labels: Readonly<Record<string, string>>) => Object.entries(labels).map(([value, label]) => ({ value, label }));
const bytesLabel = (bytes: number | null) => bytes === null ? "Not recorded" : `${bytes.toLocaleString()} bytes`;
const orderIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

function filtersFrom(draft: Draft): Filters {
  if (draft.from && draft.through && draft.from > draft.through) throw new Error("The start date must be on or before the end date.");
  return {
    ...(draft.kind ? { kind: draft.kind } : {}),
    ...(draft.state ? { state: draft.state } : {}),
    ...(draft.connection ? { connectionPublicId: draft.connection } : {}),
    ...(draft.text.trim() ? { text: draft.text.trim() } : {}),
    ...(draft.from ? { from: `${draft.from}T00:00:00.000Z` } : {}),
    ...(draft.through ? { through: `${draft.through}T23:59:59.999Z` } : {}),
  };
}

function saveCsv(csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "readypackets-copy-log.csv";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function CopyLogPage() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const orderParams = new URLSearchParams(useSearch()).getAll("orderPublicId");
  const orderPublicId = orderParams.length === 1 && orderIdPattern.test(orderParams[0] ?? "") ? orderParams[0] : undefined;
  const invalidOrderFilter = orderParams.length > 0 && orderPublicId === undefined;
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [applied, setApplied] = useState<Filters>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const effective = { ...applied, ...(orderPublicId ? { orderPublicId } : {}) };
  const list = useInfiniteQuery(trpc.storage.copies.list.infiniteQueryOptions(effective, {
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !invalidOrderFilter,
  }));
  const connections = useInfiniteQuery(trpc.storage.copies.connections.infiniteQueryOptions({}, {
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  }));
  const detail = useQuery(trpc.storage.copies.detail.queryOptions({ publicId: selected ?? "" }, { enabled: selected !== null }));
  const exportCsv = useMutation(trpc.storage.copies.exportCsv.mutationOptions());
  const retry = useMutation(trpc.storage.copies.retry.mutationOptions());
  const rows = list.data?.pages.flatMap((page) => page.items);
  const totals = list.data?.pages[0]?.totals;
  const connectionItems = connections.data?.pages.flatMap((page) => page.items) ?? [];
  const attempt = detail.data;

  function clear() {
    setDraft(emptyDraft);
    setApplied({});
    setFormError(null);
  }

  async function exportMatches() {
    try {
      const result = await exportCsv.mutateAsync(effective);
      saveCsv(result.csv);
      toast.show({
        title: "CSV downloaded",
        description: result.truncated ? "The most recent 1,000 matches were exported. Narrow the filters for a smaller set." :
          `${result.count.toLocaleString()} attempts exported.`,
        tone: result.truncated ? "warning" : "success",
      });
    } catch (error) {
      toast.show({ title: "Could not export copies", description: errorMessage(error), tone: "danger" });
    }
  }

  async function retryCopy(publicId: string) {
    try {
      const result = await stepUp.run(() => retry.mutateAsync({ publicId }), {
        reason: "Confirm your identity to queue a new off-site backup copy.",
      });
      await client.invalidateQueries({ queryKey: trpc.storage.copies.pathKey() });
      toast.show({
        title: result.queued ? "New copy attempt queued" : "No new copy was queued",
        description: "This attempt remains in the log. Check the destination and refresh for the new attempt.",
        tone: result.queued ? "success" : "warning",
      });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) {
        toast.show({ title: "Could not queue a retry", description: errorMessage(error), tone: "danger" });
      }
    }
  }

  return (
    <>
      <PageHeader title="Copy log"
        description="See which order files, backups, and SharePoint order records were copied to storage connections."
        actions={<Button variant="secondary" leadingIcon={<Download className="size-4" aria-hidden="true" />}
          loading={exportCsv.isPending} disabled={list.isPending || list.isError} onClick={() => void exportMatches()}>Export CSV</Button>} />
      <div className="space-y-5">
        {invalidOrderFilter && <Callout tone="warning" title="Invalid order filter">
          <Link href="/admin/storage/copies" className="text-link underline">View the unfiltered Copy log</Link>
        </Callout>}
        {orderPublicId && <Callout tone="info" title="Filtered to one order">
          <code className="break-all text-xs">{orderPublicId}</code>{" "}
          <Link href="/admin/storage/copies" className="text-link underline">Clear order filter</Link>
        </Callout>}
        <form className="space-y-4 rounded-[var(--radius-card)] border border-line bg-surface p-4"
          aria-label="Filter copy attempts" onSubmit={(event) => {
            event.preventDefault();
            try {
              setApplied(filtersFrom(draft));
              setFormError(null);
            } catch (error) {
              setFormError(error instanceof Error ? error.message : "Check the date range.");
            }
          }}>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Source kind">
              <Select value={draft.kind} options={[{ value: "", label: "All source kinds" }, ...options(kinds)]}
                onChange={(event) => setDraft({ ...draft, kind: event.target.value as Draft["kind"] })} />
            </Field>
            <Field label="Connection">
              <Select value={draft.connection} options={[{ value: "", label: "All connections" },
                ...connectionItems.map(({ publicId, name }) => ({ value: publicId, label: name }))]}
                onChange={(event) => setDraft({ ...draft, connection: event.target.value })} />
            </Field>
            <Field label="State">
              <Select value={draft.state} options={[{ value: "", label: "All states" }, ...options(states)]}
                onChange={(event) => setDraft({ ...draft, state: event.target.value as Draft["state"] })} />
            </Field>
            <Field label="From date (UTC)">
              <Input type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
            </Field>
            <Field label="Through date (UTC)">
              <Input type="date" value={draft.through} onChange={(event) => setDraft({ ...draft, through: event.target.value })} />
            </Field>
            <Field label="Search" hint="Source ID, destination, correlation ID, or error code.">
              <Input type="search" maxLength={96} value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
            </Field>
          </div>
          <p className="text-sm text-muted">{orderPublicId ? "Showing this order’s full history unless a date range is set." :
            "Default: last seven days."} Select a range of up to 90 days.</p>
          {formError && <Callout tone="danger" title="Check the date range" live="assertive">{formError}</Callout>}
          {connections.isError && <Callout tone="warning" title="Connection choices could not be loaded">
            You can still search by destination ID. <Button variant="ghost" onClick={() => void connections.refetch()}>Reload connections</Button>
          </Callout>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit">Apply filters</Button>
            <Button type="button" variant="ghost" onClick={clear}>Clear filters</Button>
            {connections.hasNextPage && <Button type="button" variant="ghost" loading={connections.isFetchingNextPage}
              onClick={() => void connections.fetchNextPage()}>Load more connections</Button>}
          </div>
        </form>
        {totals && <section aria-label="Copy attempt counters" className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <p className="mb-3 text-sm font-semibold text-ink">Attempts matching these filters</p>
          <KeyValueList columns={3} items={Object.entries(states).map(([key, label]) => ({
            label, value: totals[key as State].toLocaleString(),
          }))} />
        </section>}
        <div aria-live="polite" className="sr-only">{rows ? `${rows.length.toLocaleString()} attempts shown` : ""}</div>
        {!invalidOrderFilter && <DataTable caption="Storage copy attempts" rows={rows} rowKey={(row) => row.publicId} loading={list.isPending}
          error={list.isError && !list.data ? list.error : undefined} onRetry={() => void list.refetch()}
          empty={<EmptyState icon={HardDriveDownload} title="No matching copy attempts"
            description="Try different filters. Attempts are recorded from the Copy log rollout onward."
            onClearFilters={clear} />}
          columns={[
            { key: "source", header: "Source", primary: true, cell: (row) => <div>
              <span className="block font-semibold">{kinds[row.kind]}</span>
              <code className="break-all text-xs text-muted">{row.sourcePublicId}</code>
            </div> },
            { key: "time", header: "Time", cell: (row) => <DateTime value={row.createdAt} /> },
            { key: "destination", header: "Destination", cell: (row) => <span className="break-words">{row.connectionName ?? row.connectionPublicId}</span> },
            { key: "target", header: "Target path", cell: (row) => row.targetPath ?
              <code className="break-all text-xs">{row.targetPath}</code> : "Not recorded" },
            { key: "state", header: "State", cell: (row) => <div>
              <Badge tone={stateTones[row.state]}>{states[row.state]}</Badge>
              <span className="mt-1 block text-xs text-muted">Attempt {row.attempt.toLocaleString()}</span>
            </div> },
          ]}
          rowActions={(row) => <Button variant="ghost" aria-label={`Details for ${kinds[row.kind]} copy attempt ${row.publicId}`}
            onClick={() => setSelected(row.publicId)}>Details</Button>} />}
        {list.isFetchNextPageError && <ErrorState error={list.error} onRetry={() => void list.fetchNextPage()} />}
        <LoadMore loading={list.isFetchingNextPage} hasMore={list.hasNextPage} onLoadMore={() => void list.fetchNextPage()} />
      </div>
      <Drawer open={selected !== null} onOpenChange={(open) => !open && setSelected(null)} title="Copy attempt details"
        description="A provider accepting a write does not by itself verify the copy." width="lg">
        {detail.isPending && <div role="status" aria-label="Loading copy attempt"><Skeleton className="h-32" /></div>}
        {detail.isError && <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />}
        {attempt && <div className="space-y-5">
          <KeyValueList items={[
            { label: "State", value: <Badge tone={stateTones[attempt.state]}>{states[attempt.state]}</Badge> },
            { label: "Verification", value: attempt.verification === "checksum" ? "Matched checksum" :
              attempt.verification === "provider_readback" ? "Confirmed by provider read-back" : "Not verified" },
            { label: "Source kind", value: kinds[attempt.kind] },
            { label: "Source ID", value: <code className="break-all text-xs">{attempt.sourcePublicId}</code> },
            { label: "Order ID", value: attempt.orderPublicId ? <code className="break-all text-xs">{attempt.orderPublicId}</code> : "Not recorded" },
            { label: "Connection", value: attempt.connectionName ?? "Connection not available" },
            { label: "Connection ID", value: <code className="break-all text-xs">{attempt.connectionPublicId}</code> },
            { label: "Target path", value: attempt.targetPath ? <code className="break-all text-xs">{attempt.targetPath}</code> : "Not recorded", wide: true },
            { label: "Size", value: bytesLabel(attempt.bytes) },
            { label: "Attempt", value: attempt.attempt.toLocaleString() },
            { label: "Job ID", value: <code className="break-all text-xs">{attempt.jobPublicId}</code> },
            { label: "Recorded", value: <DateTime value={attempt.createdAt} /> },
            { label: "Started", value: attempt.startedAt ? <DateTime value={attempt.startedAt} /> : "Not recorded" },
            { label: "Finished", value: attempt.finishedAt ? <DateTime value={attempt.finishedAt} /> : "Not recorded" },
            { label: "Error class", value: attempt.errorCode ? <code className="break-all text-xs">{attempt.errorCode}</code> : "None recorded" },
            { label: "Correlation ID", value: attempt.correlationId ? <code className="break-all text-xs">{attempt.correlationId}</code> : "Not recorded", wide: true },
          ]} />
          <div className="flex flex-wrap gap-2">
            {attempt.correlationId && <Button asChild variant="secondary">
              <Link href={`/admin/audit?correlationId=${encodeURIComponent(attempt.correlationId)}`}>View audit trail</Link>
            </Button>}
            {attempt.canRetry && <Button loading={retry.isPending} onClick={() => void retryCopy(attempt.publicId)}>Retry backup copy</Button>}
          </div>
          {!attempt.canRetry && attempt.state === "failed" &&
            <p className="text-sm text-muted">This attempt has no direct retry here. Check the source module and correlated audit events before taking action.</p>}
        </div>}
      </Drawer>
    </>
  );
}
