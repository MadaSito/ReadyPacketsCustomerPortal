import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Card, DataTable, DateTime, EmptyState, ErrorState, KeyValueList, PageHeader, Section, Spinner } from "@/ui";
import { BASE, FORMATS, formatSiemMetric, SIEM_HEALTH_META, siemComponentTitle, type Destination } from "./model";

export function DestinationStatus({ value }: { value: Destination }) {
  if (!value.enabled) return <Badge tone="neutral">Paused</Badge>;
  if (value.delivery.circuitState === "open") return <Badge tone="danger">Circuit open</Badge>;
  if (value.delivery.circuitState === "half_open") return <Badge tone="warning">Recovering</Badge>;
  return <Badge tone="success">Enabled</Badge>;
}

export default function Console() {
  const trpc = useTRPC();
  const destinations = useQuery(trpc.siem.admin.destinations.list.queryOptions());
  const health = useQuery(trpc.siem.admin.health.queryOptions());
  return (
    <>
      <PageHeader title="SIEM forwarding" description="Manage encrypted audit forwarding and investigate delivery exceptions."
        actions={<Button asChild><Link href={`${BASE}/new`}>Add destination</Link></Button>} />
      <div className="space-y-6">
        <Section title="Forwarding health">
          {health.isPending ? <Spinner label="Loading forwarding health" /> : health.isError
            ? <ErrorState error={health.error} onRetry={() => void health.refetch()} />
            : health.data.components.length === 0 ? <EmptyState title="No health checks reported" headingLevel={3} />
            : <div className="grid gap-3 md:grid-cols-2">
                {health.data.components.map((item) => {
                  const meta = SIEM_HEALTH_META[item.state];
                  return (
                    <Card key={item.component} title={siemComponentTitle(item.component)} headingLevel={3}
                      actions={<Badge tone={meta.tone}>{meta.label}</Badge>}>
                      <p className="mb-2 text-sm text-body">{item.summary}</p>
                      <KeyValueList columns={2} items={[{ label: "Checked", value: <DateTime value={item.checkedAt} /> },
                        ...Object.entries(item.metrics ?? {}).map(([key, value]) => {
                          const metric = formatSiemMetric(key, value);
                          return { label: metric.label, value: <span className="tabular-nums">{metric.display}</span> };
                        })]} />
                    </Card>
                  );
                })}
              </div>}
        </Section>
        <Section title="Destinations">
          <DataTable caption="SIEM destinations" rows={destinations.data} loading={destinations.isPending} error={destinations.error}
            onRetry={() => void destinations.refetch()} rowKey={(row) => row.publicId}
            empty={<EmptyState title="No destinations configured" description="Add a destination to set up encrypted audit forwarding. New destinations stay paused until you enable them." />}
            columns={[
              { key: "destination", header: "Destination", primary: true, cell: (row) => <><Button variant="link" asChild><Link href={`${BASE}/${row.publicId}`}><span className="min-w-0 whitespace-normal break-words text-left">{row.name}</span></Link></Button><div className="break-all text-xs text-muted">{row.host}:{row.port}</div></> },
              { key: "status", header: "Status", cell: (row) => <><DestinationStatus value={row} /><div className="mt-1 text-xs text-muted">{FORMATS[row.format]}</div></> },
              { key: "success", header: "Last success", cell: (row) => <DateTime value={row.delivery.lastSuccessAt} /> },
              { key: "failure", header: "Last failure", cell: (row) => <><DateTime value={row.delivery.lastFailureAt} />{row.delivery.lastFailureReason ? <div className="mt-1 break-all text-xs">{row.delivery.lastFailureReason}</div> : null}</> },
              { key: "backlog", header: "Backlog", cell: (row) => <span className="tabular-nums">{row.delivery.queuedCount.toLocaleString()} queued · {row.delivery.deadLetterCount.toLocaleString()} quarantined</span> },
              { key: "lag", header: "Sequence lag", align: "end", cell: (row) => <span className="tabular-nums">{row.delivery.lagSeq.toLocaleString()}</span> },
              { key: "uncertain", header: "Uncertain deliveries", align: "end", cell: (row) => <span className="tabular-nums">{row.delivery.uncertainCount.toLocaleString()}</span> },
            ]} />
        </Section>
      </div>
    </>
  );
}
