import { useInfiniteQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Button, DataTable, DateTime, EmptyState, Field, FilterBar, LoadMore, PageHeader, Select, StatusBadge } from "@/ui";
import { Id, jobStates } from "../controls";

const jobType = /^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/;
const stateOptions = [{ value: "", label: "All states" }, ...jobStates.map((state) => ({
  value: state, label: state === "unknown" ? "Unknown outcome" : state[0]!.toUpperCase() + state.slice(1),
}))];

export default function JobsPage() {
  const trpc = useTRPC();
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [state, setState] = useState<(typeof jobStates)[number] | "">("");
  const result = useInfiniteQuery(trpc.jobs.admin.list.infiniteQueryOptions({
    type: kind || undefined, state: state || undefined, limit: 25,
  }, { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const rows = result.data?.pages.flatMap((page) => page.items) ?? [];
  return <>
    <PageHeader title="Jobs" description="Inspect background work, attempts, and unknown outcomes."
      actions={<Button asChild variant="secondary"><Link href="/admin/schedules">View schedules</Link></Button>} />
    <FilterBar search={draft} onSearchChange={setDraft} onSearchSubmit={(value) => {
      const normalized = value.trim();
      const valid = !normalized || (jobType.test(normalized) && normalized.length <= 100);
      setInvalid(!valid);
      if (valid) setKind(normalized);
    }} searchLabel="Filter by exact job type" searchPlaceholder="Job type, e.g. jobs.mail.deliver"
      activeCount={Number(Boolean(kind)) + Number(Boolean(state))}
      onReset={() => { setDraft(""); setKind(""); setState(""); setInvalid(false); }}>
      <Field label="Job status"><Select options={stateOptions} value={state} onChange={(event) =>
        setState(jobStates.find((value) => value === event.target.value) ?? "")} /></Field>
    </FilterBar>
    {invalid ? <p role="alert" className="mb-4 text-sm text-danger">Enter a job type using lowercase letters, digits, dots, hyphens or underscores.</p> : null}
    {kind ? <p className="mb-4 text-sm text-muted">Job type: <Id value={kind} /></p> : null}
    <DataTable caption="Background jobs" rows={rows} rowKey={(row) => row.publicId} loading={result.isPending}
      error={result.error} onRetry={() => void result.refetch()}
      columns={[
        { key: "type", header: "Job type", primary: true, cell: (row) => <Id value={row.type} /> },
        { key: "status", header: "Status", cell: (row) => <StatusBadge state={row.state} /> },
        { key: "attempts", header: "Attempts", align: "end", cell: (row) => <span className="tabular-nums">{row.attempt}/{row.maxAttempts}</span> },
        { key: "updated", header: "Updated", cell: (row) => <DateTime value={row.updatedAt} format="relative" /> },
      ]}
      rowActions={(row) => <Button asChild variant="secondary" className="shrink-0"><Link aria-label={`Details for job ${row.publicId}`} href={`/admin/jobs/${row.publicId}`}>Details</Link></Button>}
      empty={<EmptyState icon={ListChecks} title="No matching jobs" description="Change the filters or check back when work has been queued." />} />
    <LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoadMore={() => void result.fetchNextPage()}
      summary={!result.isPending && !result.isError ? `Showing ${rows.length} jobs` : undefined} />
  </>;
}
