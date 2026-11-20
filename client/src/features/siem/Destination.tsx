import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge, Breadcrumbs, Button, Callout, Card, ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState, KeyValueList,
  LoadMore, PageHeader, Spinner, StatusBadge, StepUpCancelledError, Tabs, useStepUp, useToast,
} from "@/ui";
import { DestinationStatus } from "./Console";
import { auditLink, BASE, CATEGORIES, FORMATS, ID, receipt, type AuditItem, type Destination, type Quarantined, type TestResult } from "./model";

function Correlation({ id }: { id: string | null | undefined }) {
  return id
    ? <Button asChild variant="link"><Link href={auditLink(id)} aria-label={`Open audit correlation ${id}`}>Audit correlation</Link></Button>
    : <span className="text-muted">Not recorded</span>;
}

export default function DestinationPage() {
  const [, route] = useRoute(`${BASE}/:id`);
  const id = route?.id ?? "";
  const trpc = useTRPC();
  const detail = useQuery({ ...trpc.siem.admin.destinations.get.queryOptions({ publicId: id }), enabled: ID.test(id) });
  if (!ID.test(id) || detail.isError || detail.isPending) {
    return <>
      <PageHeader title="SIEM destination" breadcrumbs={<Breadcrumbs items={[{ label: "SIEM forwarding", href: BASE }, { label: "Destination" }]} />} />
      {!ID.test(id) ? <ErrorState title="Destination not found" />
        : detail.isError ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        : <Spinner label="Loading destination" />}
    </>;
  }
  return <DestinationDetails key={id} destination={detail.data} />;
}

type Action = { kind: "toggle" | "delete" | "replayAll" | "test" } | { kind: "replay" | "purge"; item: Quarantined };

function DestinationDetails({ destination: d }: { destination: Destination }) {
  const trpc = useTRPC();
  const api = useTRPCClient();
  const query = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const [, navigate] = useLocation();
  const [confirm, setConfirm] = useState<{ action: Action; enabled: boolean; version: number }>();
  const [test, setTest] = useState<TestResult>();
  const [logRevision, setLogRevision] = useState(0);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const { publicId } = d;
  const request = (action: Action) => {
    setError(undefined);
    setConfirm({ action, enabled: d.enabled, version: d.version });
  };
  const execute = async () => {
    if (!confirm || inFlight.current) return;
    const { action, enabled, version: expectedVersion } = confirm;
    inFlight.current = true;
    setError(undefined);
    try {
      const message = await stepUp.run(async () => {
        switch (action.kind) {
          case "toggle": {
            const updated = await api.siem.admin.destinations.setEnabled.mutate({ publicId, expectedVersion, enabled: !enabled });
            query.setQueryData(trpc.siem.admin.destinations.get.queryKey({ publicId }), updated);
            return updated.enabled ? "Forwarding resumed" : "Forwarding paused";
          }
          case "delete":
            await api.siem.admin.destinations.delete.mutate({ publicId, expectedVersion });
            return "Destination deleted";
          case "test": {
            const result = await api.siem.admin.destinations.test.mutate({ publicId, expectedVersion });
            setTest(result);
            return "";
          }
          case "replay":
          case "replayAll": {
            const result = await api.siem.admin.deadLetters.replay.mutate(action.kind === "replay"
              ? { publicIds: [action.item.publicId], destinationPublicId: publicId }
              : { destinationPublicId: publicId, limit: 100 });
            return `${result.replayedCount} quarantined event${result.replayedCount === 1 ? "" : "s"} requeued`;
          }
          case "purge": {
            const result = await api.siem.admin.deadLetters.purge.mutate({ publicIds: [action.item.publicId] });
            return `${result.purgedCount} quarantined event${result.purgedCount === 1 ? "" : "s"} purged`;
          }
        }
      }, { reason: "This SIEM action requires verification." });
      if (message) toast.show({ tone: "success", title: message });
      setConfirm(undefined);
      void query.invalidateQueries({ queryKey: trpc.siem.admin.pathKey() });
      setLogRevision((n) => n + 1);
      if (action.kind === "delete") navigate(BASE);
    } catch (failure) {
      setConfirm(undefined);
      if (!(failure instanceof StepUpCancelledError)) setError(errorMessage(failure, "The SIEM action could not be completed."));
      void query.invalidateQueries({ queryKey: trpc.siem.admin.pathKey() });
    } finally {
      inFlight.current = false;
    }
  };
  const confirmations = {
    toggle: confirm?.enabled
      ? { title: "Pause forwarding?", label: "Pause forwarding", description: "Stops forwarding for this destination. Queued events remain available to resume." }
      : { title: "Resume forwarding?", label: "Resume forwarding", description: "The saved receiver can receive queued and newly eligible audit events." },
    delete: { title: "Delete this destination?", label: "Delete destination", description: "Removes the destination, saved credentials, and its delivery spool. The original audit events are not deleted." },
    test: { title: "Send a test event?", label: "Send test event", description: "Sends a synthetic connectivity event to the saved receiver. A transport receipt does not prove that it was indexed." },
    replayAll: { title: "Replay quarantined backlog?", label: "Replay up to 100 events", description: "Requeues up to 100 quarantined events for the current receiver. Continue only if it is authorized to receive this backlog. The receiver may see duplicates." },
    replay: { title: "Replay quarantined event?", label: "Replay event", description: "Requeues this event for the current authorized receiver. The receiver may already have a copy." },
    purge: { title: "Purge quarantined event?", label: "Purge event", description: "Permanently removes this item from the forwarding spool. The original audit event is not deleted." },
  };
  const selected = confirm ? confirmations[confirm.action.kind] : undefined;
  const delivery = d.delivery;
  return (
    <>
      <PageHeader title={d.name} description={FORMATS[d.format]} meta={<DestinationStatus value={d} />}
        breadcrumbs={<Breadcrumbs items={[{ label: "SIEM forwarding", href: BASE }, { label: d.name }]} />}
        actions={<div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary"><Link href={`${BASE}/${publicId}/edit`}>Edit destination</Link></Button>
          <Button variant="secondary" onClick={() => request({ kind: "test" })}>Send test event</Button>
          <Button onClick={() => request({ kind: "toggle" })}>{d.enabled ? "Pause" : "Resume"} forwarding</Button>
        </div>} />
      <div className="space-y-5">
        {error ? <Callout tone="danger" title="Action not completed" live="assertive">{error}</Callout> : null}
        {test ? <Callout tone={test.outcome === "completed" ? "success" : test.outcome === "unknown" ? "warning" : "danger"} title="Latest test result" live="polite">
          <div className="space-y-1">
            <StatusBadge state={test.outcome} />
            <p>{receipt[test.receiptConfirmation]}. {test.reasonCode ? `Reason: ${test.reasonCode}.` : ""}</p>
            <p className="break-all text-xs">Test reference: {test.eventId}</p>
          </div>
        </Callout> : null}
        <Tabs label="Destination sections" items={[
          { value: "summary", label: "Summary", content: <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Delivery health">
              <KeyValueList columns={2} items={[
                { label: "Queued events", value: delivery.queuedCount.toLocaleString() }, { label: "Quarantined", value: delivery.deadLetterCount.toLocaleString() },
                { label: "Sequence lag", value: delivery.lagSeq.toLocaleString() }, { label: "Uncertain deliveries", value: delivery.uncertainCount.toLocaleString() },
                { label: "Pruned audit events", value: delivery.prunedAuditCount.toLocaleString() }, { label: "Missing audit gaps", value: delivery.missingAuditGapCount.toLocaleString() },
                { label: "Oldest queued", value: delivery.oldestQueuedAgeSeconds === null ? "None reported" : `${delivery.oldestQueuedAgeSeconds.toLocaleString()} seconds` },
                { label: "Deliveries accepted", value: delivery.deliveredCount.toLocaleString() },
                { label: "Last success", value: <DateTime value={delivery.lastSuccessAt} /> }, { label: "Last failure", value: <DateTime value={delivery.lastFailureAt} /> },
                { label: "Last failure reason", value: delivery.lastFailureReason ?? "None reported" },
                { label: "Last test", value: <><DateTime value={delivery.lastTestAt} /> {delivery.lastTestOutcome ? <StatusBadge state={delivery.lastTestOutcome} /> : null}</> },
                { label: "Receipt meaning", value: receipt[delivery.receiptConfirmation], wide: true },
              ]} />
            </Card>
            <Card title="Receiver and filters" footer={<Button variant="danger" onClick={() => request({ kind: "delete" })}>Delete destination</Button>}>
              <KeyValueList columns={2} items={[
                { label: "Receiver", value: <span className="break-all">{d.host}:{d.port}{d.otlpPath}</span>, wide: true },
                { label: "TLS verification", value: "Required" }, { label: "Minimum severity", value: d.minSeverity },
                { label: "Custom CA", value: d.secrets.hasCustomCa ? "Configured" : "Not set for this destination" },
                { label: "Client credentials", value: d.secrets.hasClientCert && d.secrets.hasClientKey ? "Configured" : "Not set for this destination" },
                ...(d.format === "otlp_https" ? [{ label: "OTLP authentication", value: d.secrets.hasAuthSecret ? "Configured" : "Not configured" }] : []),
                { label: "Audit categories", value: d.categories.map((item) => CATEGORIES[item]).join(", "), wide: true },
              ]} />
            </Card>
          </div> },
          { value: "quarantine", label: "Quarantine", content: <Quarantine publicId={publicId} request={request} /> },
          { value: "log", label: "Delivery log", content: <DeliveryLog key={logRevision} publicId={publicId} /> },
        ]} />
      </div>
      {selected ? <ConfirmDialog open onOpenChange={(open) => { if (!open) setConfirm(undefined); }}
        title={selected.title} description={selected.description} confirmLabel={selected.label}
        destructive={confirm?.action.kind === "delete" || confirm?.action.kind === "purge"} onConfirm={execute} /> : null}
    </>
  );
}

function Quarantine({ publicId, request }: { publicId: string; request: (value: Action) => void }) {
  const trpc = useTRPC();
  const list = useInfiniteQuery(trpc.siem.admin.deadLetters.list.infiniteQueryOptions({ destinationPublicId: publicId, limit: 25 },
    { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const items = list.data?.pages.flatMap((page) => page.items);
  return (
    <Card title="Quarantined deliveries" description="Review attempts that cannot be sent automatically."
      actions={items?.length ? <Button variant="secondary" onClick={() => request({ kind: "replayAll" })}>Replay backlog</Button> : null}>
      <DataTable caption="Quarantined SIEM events" rows={items} rowKey={(row) => row.publicId}
        loading={list.isPending} error={list.error} onRetry={() => void list.refetch()}
        empty={<EmptyState title="No quarantined events" description="If events are quarantined, they will appear here." />} columns={[
          { key: "event", header: "Event", primary: true, cell: (row) => <><div className="break-all font-medium">{row.eventName}</div><div className="break-all text-xs text-muted">{row.eventId}</div></> },
          { key: "severity", header: "Severity", cell: (row) => row.severity },
          { key: "held", header: "Quarantined at", cell: (row) => <DateTime value={row.deadLetteredAt} /> },
          { key: "reason", header: "Delivery outcome", cell: (row) => <><StatusBadge state={row.uncertainDelivery ? "unknown" : "failed"} label={row.uncertainDelivery ? "Uncertain delivery" : "Quarantined"} /><div className="mt-1 break-all text-xs">{row.lastReasonCode ?? "No reason recorded"}</div></> },
          { key: "attempts", header: "Attempts", cell: (row) => `${row.attempts} of ${row.maxAttempts}` },
          { key: "audit", header: "Audit", cell: (row) => <Correlation id={row.correlationId} /> },
        ]} rowActions={(row) => <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => request({ kind: "replay", item: row })}>Replay</Button>
          <Button variant="ghost" onClick={() => request({ kind: "purge", item: row })}>Purge</Button>
        </div>} />
      <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} />
    </Card>
  );
}

function DeliveryLog({ publicId }: { publicId: string }) {
  const trpc = useTRPC();
  const [window] = useState(() => {
    const now = Date.now();
    return { from: new Date(now - 7 * 24 * 60 * 60 * 1_000).toISOString(), to: new Date(now).toISOString() };
  });
  const log = useInfiniteQuery(trpc.audit.search.infiniteQueryOptions({
    query: { ...window, where: { kind: "group", op: "and", terms: [
      { field: "resource_public_id", op: "eq", value: publicId },
      { field: "event_name", op: "in", value: [
        "siem.destination.test", "siem.delivery.uncertain_outcome", "siem.delivery.dead_lettered", "siem.delivery.circuit_opened",
        "siem.spool.saturated", "siem.cursor.audit_gap_detected", "siem.cursor.retention_pruned",
      ] },
    ] } }, limit: 25,
  }, { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const items = log.data?.pages.flatMap((page) => page.items);
  return (
    <Card title="Delivery log" description="Seven days of recorded tests and exceptions. The log is not a per-event receipt history.">
      <DataTable<AuditItem> caption="Recorded SIEM delivery activity" rows={items} rowKey={(row) => row.event_id}
        loading={log.isPending} error={log.error} onRetry={() => void log.refetch()}
        empty={<EmptyState title="No delivery activity recorded" description="Recorded test results and delivery exceptions will appear here." />}
        columns={[
          { key: "event", header: "Event", primary: true, cell: (row) => <span className="break-all">{row.event_name}</span> },
          { key: "time", header: "Time", cell: (row) => <DateTime value={row.occurred_at} /> },
          { key: "outcome", header: "Outcome", cell: (row) => <Badge tone={row.outcome === "failed" ? "danger" : row.outcome === "unknown" ? "warning" : "neutral"}>{row.outcome.replaceAll("_", " ")}</Badge> },
          { key: "reason", header: "Reason", cell: (row) => <span className="break-all">{row.reason_code ?? "Not recorded"}</span> },
          { key: "audit", header: "Audit", cell: (row) => <Correlation id={row.correlation_id} /> },
        ]} />
      <LoadMore hasMore={log.hasNextPage} loading={log.isFetchingNextPage} onLoadMore={() => void log.fetchNextPage()} />
    </Card>
  );
}
