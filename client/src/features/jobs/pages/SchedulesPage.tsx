import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Button, Callout, DataTable, DateTime, EmptyState, PageHeader, StatusBadge } from "@/ui";
import { Id } from "../controls";

function intervalLabel(ms: number) {
  for (const [unit, size] of [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000], ["second", 1_000]] as const) {
    if (ms % size === 0) {
      const count = ms / size;
      return `Every ${count} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return `Every ${ms} ms`;
}

export default function SchedulesPage() {
  const trpc = useTRPC();
  const result = useQuery(trpc.jobs.admin.schedules.queryOptions());
  return <>
    <PageHeader title="Schedules" description="Recurring jobs run at most once per slot. Missed slots are not replayed."
      actions={<Button asChild variant="secondary"><Link href="/admin/jobs">View jobs</Link></Button>} />
    {result.data?.paused ? <Callout title="Schedules paused" tone="warning" actions={
      <Button asChild variant="secondary"><Link href="/admin/maintenance">View maintenance</Link></Button>
    }>The worker skips new slots while maintenance is active.</Callout> : null}
    <DataTable caption="Recurring work" rows={result.data?.items ?? []} rowKey={(row) => row.name}
      loading={result.isPending} error={result.error} onRetry={() => void result.refetch()}
      empty={<EmptyState icon={CalendarClock} title="No schedules registered" description="Schedules appear as modules register recurring work." />}
      columns={[
        { key: "name", header: "Schedule", primary: true, cell: (row) => <div><Id value={row.name} /><p className="text-sm text-muted">{intervalLabel(row.everyMs)}</p></div> },
        { key: "last", header: "Last queued slot", cell: (row) => <DateTime value={row.last?.slot ?? null} /> },
        { key: "outcome", header: "Last job", cell: (row) => row.last ? <StatusBadge state={row.last.state} /> : "Not yet queued" },
        { key: "next", header: "Next slot", cell: (row) => result.data?.paused ? "Paused" : <DateTime value={row.nextSlot} /> },
      ]}
      rowActions={(row) => row.last ? <Button asChild variant="secondary"><Link aria-label={`View job for ${row.name}`} href={`/admin/jobs/${row.last.jobId}`}>View job</Link></Button> : null} />
  </>;
}
