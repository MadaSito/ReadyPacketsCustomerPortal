import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, DataTable, DateTime, EmptyState, ErrorState, PageHeader, Skeleton } from "@/ui";
import { HEALTH_META, type HealthReport } from "../model";
import { PlatformNav } from "../PlatformNav";

const metricLabel = (key: string) => key.replace(/_/g, " ");

export function HealthView({ report }: { report: HealthReport }) {
  const overall = HEALTH_META[report.state];
  return (
    <div className="space-y-6">
      <Callout tone={report.state === "ok" ? "success" : report.state === "failing" ? "danger" : "warning"} title={`Overall: ${overall.label}`}>
        Checked <DateTime value={report.checkedAt} format="datetime" />. Summaries never include addresses, paths or secrets.
      </Callout>
      <DataTable
        caption="Component health"
        rows={report.components}
        rowKey={(c) => c.component}
        empty={<EmptyState icon={Activity} title="No components reported" description="Modules report health here once they start." headingLevel={2} />}
        columns={[
          { key: "component", header: "Component", primary: true, cell: (c) => <span className="break-all font-mono text-sm text-ink">{c.component}</span> },
          { key: "state", header: "State", cell: (c) => <Badge tone={HEALTH_META[c.state].tone}>{HEALTH_META[c.state].label}</Badge> },
          { key: "summary", header: "Summary", cell: (c) => <span className="break-words text-body">{c.summary}</span> },
          {
            key: "metrics",
            header: "Metrics",
            hideOnMobile: true,
            cell: (c) =>
              c.metrics && Object.keys(c.metrics).length > 0 ? (
                <dl className="grid gap-x-3 text-sm sm:grid-cols-[auto_1fr]">
                  {Object.entries(c.metrics).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted">{metricLabel(k)}</dt>
                      <dd className="text-body">{v.toLocaleString()}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <span className="text-muted">None</span>
              ),
          },
        ]}
      />
    </div>
  );
}

export default function HealthPage() {
  const trpc = useTRPC();
  const report = useQuery(trpc.platform.admin.health.queryOptions());
  return (
    <>
      <PageHeader
        title="System health"
        description="Live status of the database, keys, schema and every module."
        actions={<Button variant="secondary" leadingIcon={<RefreshCw aria-hidden className="size-4" />} loading={report.isFetching} onClick={() => void report.refetch()}>Refresh</Button>}
      />
      <PlatformNav />
      {report.isPending ? (
        <div aria-busy="true"><Skeleton lines={6} /></div>
      ) : report.error ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <HealthView report={report.data as HealthReport} />
      )}
    </>
  );
}
