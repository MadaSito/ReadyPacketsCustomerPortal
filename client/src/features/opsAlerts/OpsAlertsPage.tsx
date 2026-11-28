import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearch } from "wouter";
import { roleHasCapability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, DataTable, DateTime, EmptyState, Field, FilterBar, LoadMore, PageHeader, Select } from "@/ui";
import AttentionReminders from "./AttentionReminders";

const severities = ["critical", "error", "warning"] as const;
const states = ["open", "acknowledged", "resolved"] as const;
const sources = ["stage_bundle", "completion_job", "automation", "webhook", "graph", "file_sync", "payment", "certificate", "attention", "trash"] as const;
const titles: Record<string, string> = {
  critical: "Critical", error: "Error", warning: "Warning", open: "Open", acknowledged: "Acknowledged", resolved: "Resolved",
  stage_bundle: "Phase actions", completion_job: "Completion update", automation: "Automation", webhook: "Webhook",
  graph: "Microsoft Graph", file_sync: "File sync", payment: "Payment", certificate: "Certificate", attention: "Waiting order", trash: "Trash retention",
};
const options = (values: readonly string[], blank: string) => [{ value: "", label: blank }, ...values.map((value) => ({ value, label: titles[value]! }))];

export default function OpsAlertsPage() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const { me } = useSession();
  const query = new URLSearchParams(useSearch());
  const role = me?.user?.role;
  const canManage = role !== undefined && roleHasCapability(role, "ops.alerts.manage");
  const canReadOrders = role !== undefined && roleHasCapability(role, "orders.read_all");
  const [severity, setSeverity] = useState(() => severities.find((value) => value === query.get("severity")));
  const [state, setState] = useState(() => states.find((value) => value === query.get("state")));
  const [source, setSource] = useState(() => sources.find((value) => value === query.get("source")));
  const [notice, setNotice] = useState("");
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const [previousAction, setPreviousAction] = useState<HTMLButtonElement | null>(null);
  const result = useInfiniteQuery(trpc.opsAlerts.list.infiniteQueryOptions({ severity, state, source }, {
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  }));
  useEffect(() => {
    if (notice && previousAction && !previousAction.isConnected && document.activeElement === document.body) {
      noticeRef.current?.focus();
    }
  }, [notice, previousAction, result.data]);
  async function changed(message: string) {
    setNotice(message);
    await Promise.all([
      client.invalidateQueries({ queryKey: trpc.opsAlerts.list.pathKey() }),
      client.invalidateQueries({ queryKey: trpc.opsAlerts.summary.queryKey() }),
    ]);
  }
  const acknowledge = useMutation(trpc.opsAlerts.acknowledge.mutationOptions({ onSuccess: (r) => changed(r.changed ? "Alert acknowledged." : "Alert already updated.") }));
  const resolve = useMutation(trpc.opsAlerts.resolve.mutationOptions({ onSuccess: (r) => changed(r.changed ? "Alert resolved." : "Alert already resolved.") }));
  const changing = acknowledge.isPending || resolve.isPending;
  const rows = result.data?.pages.flatMap(({ items }) => items) ?? [];
  return <>
    <PageHeader title="Operational alerts" description="Review and track issues from order workflows and connected services." />
    <FilterBar activeCount={Number(Boolean(severity)) + Number(Boolean(state)) + Number(Boolean(source))}
      onReset={() => { setSeverity(undefined); setState(undefined); setSource(undefined); }}>
      <Field label="Severity"><Select options={options(severities, "All severities")} value={severity ?? ""}
        onChange={(e) => setSeverity(severities.find((value) => value === e.target.value))} /></Field>
      <Field label="State"><Select options={options(states, "All states")} value={state ?? ""}
        onChange={(e) => setState(states.find((value) => value === e.target.value))} /></Field>
      <Field label="Source"><Select options={options(sources, "All sources")} value={source ?? ""}
        onChange={(e) => setSource(sources.find((value) => value === e.target.value))} /></Field>
    </FilterBar>
    {acknowledge.isError || resolve.isError ? <Callout tone="danger" live="assertive" title="The alert could not be updated">Refresh the list and try again.</Callout> : null}
    <p ref={noticeRef} tabIndex={-1} role="status" className="text-sm text-muted">{notice}</p>
    <DataTable caption="Operational alerts" rows={result.isPending ? undefined : rows} rowKey={(row) => row.publicId} loading={result.isPending}
      error={result.error} onRetry={() => void result.refetch()} empty={<EmptyState icon={BellRing} title="No matching alerts"
        description="Choose different filters or check back when work needs your attention." />}
      columns={[
        { key: "title", header: "Alert", primary: true, cell: (row) => <div className="min-w-0 break-words">
          <p className="font-medium">{row.title}</p>{row.text ? <p className="text-sm text-muted">{row.text}</p> : null}
          {row.orderPublicId && canReadOrders ? <Link href={`/admin/orders/${row.orderPublicId}`} className="underline underline-offset-2">View order</Link> : null}
        </div> },
        { key: "severity", header: "Severity", cell: (row) => <Badge tone={row.severity === "warning" ? "warning" : "danger"}>{titles[row.severity]}</Badge> },
        { key: "state", header: "State", cell: (row) => <Badge tone={row.state === "resolved" ? "success" : "neutral"}>{titles[row.state]}</Badge> },
        { key: "source", header: "Source", cell: (row) => titles[row.source] },
        { key: "time", header: "Opened", cell: (row) => <DateTime value={row.createdAt} format="relative" /> },
      ]}
      rowActions={canManage ? (row) => <div className="flex flex-wrap gap-2">
        {row.state === "open" ? <Button variant="secondary" aria-label={`Acknowledge: ${row.title}`} aria-disabled={changing}
          onClick={(event) => {
            if (changing) return;
            setPreviousAction(event.currentTarget);
            setNotice(""); resolve.reset(); acknowledge.mutate({ publicId: row.publicId });
          }}>Acknowledge</Button> : null}
        {row.state !== "resolved" ? <Button variant="secondary" aria-label={`Resolve: ${row.title}`} aria-disabled={changing}
          onClick={(event) => {
            if (changing) return;
            setPreviousAction(event.currentTarget);
            setNotice(""); acknowledge.reset(); resolve.mutate({ publicId: row.publicId });
          }}>Resolve</Button> : null}
      </div> : undefined} />
    <LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoadMore={() => void result.fetchNextPage()}
      summary={result.isSuccess ? `Showing ${rows.length} alerts` : undefined} />
    {role === "admin" && roleHasCapability(role, "platform.settings.manage") ? <AttentionReminders /> : null}
  </>;
}
