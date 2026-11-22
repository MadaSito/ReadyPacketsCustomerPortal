import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import type { ListWebhookDeliveriesInput, WebhookDeliveryDetailView, WebhookDeliveryStatus } from "@server/modules/integrations/webhooks/types";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Checkbox, CodeBlock, DataTable, DateTime, Dialog, EmptyState, ErrorState, Field, Input, KeyValueList, LoadMore, Select, Skeleton } from "@/ui";
import { WebhooksHeader, useWebhookAction } from "./common";

const statusLabels = {
  queued: "Queued", delivering: "Delivering", delivered: "Delivered", retrying: "Retry scheduled", failed: "Failed",
  dead: "Retries exhausted", unknown: "Outcome unknown", processed: "Processed", duplicate: "Duplicate", rejected: "Rejected",
} satisfies Record<WebhookDeliveryStatus, string>;
const statusOptions = [{ value: "", label: "All statuses" }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))];
const directions = [{ value: "", label: "Both directions" }, { value: "outbound", label: "Outbound" }, { value: "inbound", label: "Inbound" }];
const baseFilters = { direction: "", subscriptionPublicId: "", inboundEndpointPublicId: "", eventKey: "", status: "", from: "", to: "", correlationId: "", search: "" };
const ulidPattern = "[0-9A-HJKMNP-TV-Z]{26}";

function Direction({ value }: { value: "inbound" | "outbound" }) { return value === "inbound" ? "Inbound" : "Outbound"; }
function DeliveryStatus({ status }: { status: WebhookDeliveryStatus }) {
  return <Badge tone={["delivered", "processed"].includes(status) ? "success" : ["failed", "dead", "rejected"].includes(status) ? "danger"
    : ["retrying", "unknown"].includes(status) ? "warning" : "neutral"}>{statusLabels[status]}</Badge>;
}

function DeliveryFilters({ apply }: { apply: (input: ListWebhookDeliveriesInput) => void }) {
  const [form, setForm] = useState(baseFilters);
  const [timeError, setTimeError] = useState<string | undefined>();
  const update = (key: keyof typeof baseFilters, value: string) => setForm((previous) => ({ ...previous, [key]: value }));
  return <Card title="Filter deliveries">
    <form className="grid min-w-0 gap-4" onSubmit={(event) => {
      event.preventDefault();
      if (form.from && form.to && form.from > form.to) { setTimeError("Choose an end date on or after the start date."); return; }
      setTimeError(undefined);
      apply({
        direction: form.direction === "outbound" || form.direction === "inbound" ? form.direction : undefined,
        subscriptionPublicId: form.subscriptionPublicId || undefined,
        inboundEndpointPublicId: form.inboundEndpointPublicId || undefined,
        eventKey: form.eventKey.trim() || undefined,
        status: form.status && Object.hasOwn(statusLabels, form.status) ? form.status as WebhookDeliveryStatus : undefined,
        from: form.from ? new Date(`${form.from}T00:00:00.000Z`) : undefined,
        to: form.to ? new Date(`${form.to}T23:59:59.999Z`) : undefined,
        correlationId: form.correlationId.trim() || undefined,
        search: form.search.trim() || undefined,
      });
    }}>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Search"><Input type="search" value={form.search} maxLength={120} onChange={(event) => update("search", event.target.value)} /></Field>
        <Field label="Direction"><Select options={directions} value={form.direction} onChange={(event) => update("direction", event.target.value)} /></Field>
        <Field label="Status"><Select options={statusOptions} value={form.status} onChange={(event) => update("status", event.target.value)} /></Field>
        <Field label="Event key"><Input value={form.eventKey} maxLength={120} onChange={(event) => update("eventKey", event.target.value)} /></Field>
        <Field label="Subscription ID"><Input value={form.subscriptionPublicId} maxLength={26} pattern={ulidPattern} onChange={(event) => update("subscriptionPublicId", event.target.value)} /></Field>
        <Field label="Inbound endpoint ID"><Input value={form.inboundEndpointPublicId} maxLength={26} pattern={ulidPattern} onChange={(event) => update("inboundEndpointPublicId", event.target.value)} /></Field>
        <Field label="Start date (UTC)"><Input type="date" value={form.from} onChange={(event) => { update("from", event.target.value); setTimeError(undefined); }} /></Field>
        <Field label="End date (UTC)" error={timeError}><Input type="date" value={form.to} onChange={(event) => { update("to", event.target.value); setTimeError(undefined); }} /></Field>
        <Field label="Correlation ID"><Input value={form.correlationId} maxLength={64} onChange={(event) => update("correlationId", event.target.value)} /></Field>
      </div>
      {timeError ? <p role="alert" className="sr-only">{timeError}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit">Apply filters</Button>
        <Button variant="secondary" onClick={() => { setForm(baseFilters); setTimeError(undefined); apply({}); }}>Clear filters</Button>
      </div>
    </form>
  </Card>;
}

function Payload({ label, value }: { label: string; value: string | Record<string, string> | null }) {
  return <details className="min-w-0 rounded-lg border border-line bg-surface p-3">
    <summary className="min-h-8 cursor-pointer py-1 text-sm font-semibold">{label}</summary>
    <div className="mt-2 ph-no-capture" data-clarity-mask="true">
      {value === null ? <p className="text-sm text-muted">Not retained.</p>
        : <CodeBlock label={label} wrap>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</CodeBlock>}
    </div>
  </details>;
}

function DeliveryDetails({ id, close, onReplay }: { id: string; close: () => void; onReplay: (publicId: string) => void }) {
  const client = useTRPCClient();
  const rpc = client.integrations.admin.webhooks.deliveries;
  const trpc = useTRPC().integrations.admin.webhooks;
  const settings = useQuery(trpc.settings.get.queryOptions());
  const act = useWebhookAction();
  const qc = useQueryClient();
  const [result, setResult] = useState<WebhookDeliveryDetailView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    // Avoid caching decrypted trace content in React Query or fetching it before the operator opens this detail.
    void client.integrations.admin.webhooks.deliveries.get.query({ publicId: id }, { signal: controller.signal }).then(
      (detail) => { if (!controller.signal.aborted) setResult(detail); },
      (failure: unknown) => { if (!controller.signal.aborted) setError(failure); },
    );
    return () => controller.abort();
  }, [client, id, revision]);
  const inbound = result?.direction === "inbound";
  const replayAction = inbound ? "Reprocess inbound event" : "Redeliver webhook";
  const replayBlocked = result && (result.bodyTruncated || result.bodyPurged || !result.canReplay);

  async function replay() {
    if (!agreed || busy || replayBlocked || !result || !settings.data?.enabled) return;
    setReplayError(null);
    setBusy(true);
    try {
      const next = await act(() => inbound ? rpc.reprocessInbound.mutate({ publicId: id }) : rpc.redeliver.mutate({ publicId: id }),
        { reason: "Re-running a webhook requires fresh verification." });
      if (next) {
        void qc.invalidateQueries(trpc.deliveries.list.pathFilter());
        onReplay(next.publicId);
      }
    } catch (failure) {
      setReplayError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open size="xl" title="Webhook delivery detail"
    description="Inspect delivery evidence and redacted content. A rerun creates a separate delivery record."
    dismissible={!busy} onOpenChange={(open) => { if (!open && !busy) close(); }}
    footer={<Button variant="secondary" disabled={busy} onClick={close}>Close</Button>}>
    {error ? <ErrorState error={error} onRetry={() => { setError(null); setRevision((value) => value + 1); }} /> : null}
    {!error && !result ? <Skeleton lines={6} /> : null}
    {result ? <div className="grid min-w-0 gap-4">
      <KeyValueList columns={2} items={[
        { label: "Delivery ID", value: <code className="break-all">{result.publicId}</code> },
        { label: "Status", value: <DeliveryStatus status={result.status} /> },
        { label: "Event", value: <code className="break-all">{result.eventKey}</code> },
        { label: "Direction", value: <Direction value={result.direction} /> },
        { label: "Subscription or endpoint", value: <code className="break-all">{result.subscriptionPublicId ?? result.inboundEndpointPublicId ?? "Not recorded"}</code> },
        { label: "Method and path", value: <code className="break-all">{result.httpMethod} {result.httpPath}</code> },
        { label: "HTTP status", value: result.httpStatus ?? "Not recorded" },
        { label: "Duration", value: result.durationMs === null ? "Not recorded" : `${result.durationMs} ms` },
        { label: "Request / response", value: `${result.requestBytes} / ${result.responseBytes} bytes` },
        { label: "Attempts", value: `${result.attemptCount} of ${result.maxAttempts}` },
        { label: "Source", value: result.isReplay ? "Rerun" : result.isTest ? "Test" : result.actorLabel },
        { label: "External event ID", value: <code className="break-all">{result.externalEventId ?? "Not recorded"}</code> },
        { label: "Original delivery", value: <code className="break-all">{result.replayOfPublicId ?? "Not a rerun"}</code> },
        { label: "Created", value: <DateTime value={result.createdAt} /> },
        { label: "Payload expiry", value: <DateTime value={result.expiresAt} /> },
        { label: "Reason", value: <code className="break-all">{result.reasonCode ?? "Not recorded"}</code> },
        { label: "Correlation ID", value: <Link className="break-all text-action underline" href={`/admin/audit?correlationId=${encodeURIComponent(result.correlationId)}`}>{result.correlationId}</Link> },
        { label: "Payload SHA-256", value: <code className="break-all">{result.payloadSha256}</code> },
      ]} />
      {replayBlocked ? <Callout tone="info">{result.bodyTruncated ? "The stored body was truncated and cannot be rerun."
        : result.bodyPurged ? "The stored body was removed and cannot be rerun." : "This delivery is not eligible for a rerun."}</Callout>
        : settings.isError ? <ErrorState title="Could not check webhook settings" error={settings.error} onRetry={() => void settings.refetch()} />
        : settings.isPending ? <Skeleton lines={2} />
        : !settings.data.enabled ? <Callout tone="info">Enable webhooks under Subscriptions → Settings to rerun this delivery.</Callout>
        : <Card title={replayAction} headingLevel={3}>
          <div className="grid min-w-0 gap-3">
            <Checkbox label={inbound ? "I understand this may start automations again." : "I understand the destination may receive this event again."}
              checked={agreed} onCheckedChange={setAgreed} disabled={busy} />
            <Button className="justify-self-start" variant="danger" disabled={!agreed} loading={busy} onClick={() => void replay()}>{replayAction}</Button>
            {replayError ? <Callout tone="danger" live="assertive">{replayError}</Callout> : null}
          </div>
        </Card>}
      <div className="grid min-w-0 gap-2">
        <Payload label="Request headers (redacted)" value={result.requestHeaders} />
        <Payload label="Request body (redacted)" value={result.requestBody} />
        <Payload label="Response headers (redacted)" value={result.responseHeaders} />
        <Payload label="Response body (redacted)" value={result.responseBody} />
      </div>
      <DataTable caption="Delivery attempts" rows={result.attempts} rowKey={(row) => row.publicId}
        empty={<EmptyState title="No attempts recorded" headingLevel={3} />}
        columns={[
          { key: "attempt", header: "Attempt", primary: true, cell: (row) => row.attemptNumber },
          { key: "outcome", header: "Outcome", cell: (row) => <Badge tone={row.outcome === "succeeded" ? "success" : row.outcome === "unknown" ? "warning" : "danger"}>{row.outcome}</Badge> },
          { key: "status", header: "HTTP status", cell: (row) => row.httpStatus ?? "Not recorded" },
          { key: "duration", header: "Duration", cell: (row) => `${row.durationMs} ms` },
          { key: "bytes", header: "Response", cell: (row) => `${row.responseBytes} bytes` },
          { key: "reason", header: "Reason", cell: (row) => <code className="break-all">{row.reasonCode ?? "Not recorded"}</code> },
          { key: "time", header: "Recorded at", cell: (row) => <DateTime value={row.occurredAt} /> },
        ]} />
      {result.attempts.some((row) => row.responseHeaders !== null || row.responseBody !== null) ? (
        <section aria-label="Per-attempt redacted responses" className="grid min-w-0 gap-2">
          {result.attempts.map((row) => row.responseHeaders !== null || row.responseBody !== null ? <div key={row.publicId} className="grid min-w-0 gap-2">
            <Payload label={`Attempt ${row.attemptNumber} response headers (redacted)`} value={row.responseHeaders} />
            <Payload label={`Attempt ${row.attemptNumber} response body (redacted)`} value={row.responseBody} />
          </div> : null)}
        </section>
      ) : null}
    </div> : null}
  </Dialog>;
}

export default function DeliveriesPage() {
  const trpc = useTRPC().integrations.admin.webhooks.deliveries;
  const rpc = useTRPCClient().integrations.admin.webhooks.deliveries;
  const [filters, setFilters] = useState<ListWebhookDeliveriesInput>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [replayed, setReplayed] = useState<string | null>(null);
  // The tRPC infinite helper reserves `direction` for pagination. Use an explicit cursor
  // query function so this API's inbound/outbound direction filter survives every page.
  const list = useInfiniteQuery({
    queryKey: trpc.list.infiniteQueryKey({ ...filters, limit: 25 }),
    queryFn: ({ pageParam, signal }) => rpc.list.query({ ...filters, cursor: pageParam, limit: 25 }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return <>
    <WebhooksHeader page="deliveries" title="Webhook deliveries"
      description="Find outbound and inbound records by event, target, time, or correlation ID." />
    <div className="grid min-w-0 gap-4">
      <DeliveryFilters apply={setFilters} />
      {replayed ? <Callout tone="success" live="polite" actions={<Button variant="secondary" onClick={() => setSelected(replayed)}>View rerun</Button>}>
        A separate rerun record was created. Review its status to see the outcome.
      </Callout> : null}
      <DataTable caption="Webhook delivery records" rows={rows} rowKey={(row) => row.publicId} loading={list.isPending}
        error={list.error} onRetry={() => void list.refetch()}
        empty={<EmptyState title="No deliveries found" description="Try clearing filters or look again after there is webhook activity." />}
        columns={[
          { key: "event", header: "Event", primary: true, cell: (row) => <code className="break-all">{row.eventKey}</code> },
          { key: "direction", header: "Direction", cell: (row) => <Direction value={row.direction} /> },
          { key: "target", header: "Target", cell: (row) => <span className="break-words">{row.targetLabel}</span> },
          { key: "status", header: "Status", cell: (row) => <DeliveryStatus status={row.status} /> },
          { key: "attempts", header: "Attempts", cell: (row) => row.attemptCount },
          { key: "created", header: "Created", cell: (row) => <DateTime value={row.createdAt} /> },
          { key: "correlation", header: "Correlation ID", cell: (row) => <code className="break-all">{row.correlationId}</code> },
        ]} rowActions={(row) => <Button variant="secondary" aria-label={`Details for delivery ${row.publicId}`} onClick={() => setSelected(row.publicId)}>Details</Button>} />
      <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()}
        summary={!list.isPending && !list.isError ? `Showing ${rows.length} deliveries` : undefined} />
    </div>
    {selected ? <DeliveryDetails key={selected} id={selected} close={() => setSelected(null)} onReplay={(publicId) => {
      setSelected(null);
      setReplayed(publicId);
    }} /> : null}
  </>;
}
