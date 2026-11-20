/** Presentational pieces of the audit event list and detail view (no data fetching; unit-tested directly). */
import type { ReactNode } from "react";
import { Eye, FolderPlus, Search } from "lucide-react";
import {
  Badge, Button, Callout, CodeBlock, CopyButton, DataTable, DateTime, EmptyState, KeyValueList, Section, StatusBadge,
} from "@/ui";
import { label, outcomeState, PIVOT_LABELS, severityTone, type AuditEnvelope, type EventDetail } from "./model";

export function SeverityBadge({ severity }: { severity: string }) {
  return <Badge tone={severityTone(severity)}>{severity}</Badge>;
}

export function OutcomeBadge({ outcome }: { outcome: string }) {
  return <StatusBadge state={outcomeState(outcome)} label={label(outcome)} />;
}

export function EventsTable({ rows, loading, error, onRetry, onOpen, empty }: {
  rows: readonly AuditEnvelope[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Omit for read-only lists (rendered as text, not a dead button). */
  onOpen?: (event: AuditEnvelope) => void;
  empty?: ReactNode;
}) {
  return (
    <DataTable
      caption="Audit events"
      rows={rows}
      loading={loading}
      error={error}
      onRetry={onRetry}
      rowKey={(e) => e.event_id}
      empty={empty ?? <EmptyState icon={Search} title="No events match" description="Widen the time range or remove a filter. Events appear here within seconds of being recorded." />}
      columns={[
        { key: "time", header: "Time", cell: (e) => <DateTime value={e.occurred_at} format="datetime" />, className: "w-48" },
        {
          key: "event",
          header: "Event",
          primary: true,
          cell: (e) => !onOpen ? <code className="text-sm break-all">{e.event_name}</code> : (
            <Button variant="link" className="h-auto min-h-11 px-0 text-left font-mono text-sm break-all" onClick={() => onOpen(e)} aria-label={`Open event ${e.event_name} at ${e.occurred_at}`}>
              {e.event_name}
            </Button>
          ),
        },
        { key: "category", header: "Category", cell: (e) => label(e.category) },
        { key: "severity", header: "Severity", cell: (e) => <SeverityBadge severity={e.severity_text} /> },
        { key: "outcome", header: "Outcome", cell: (e) => <OutcomeBadge outcome={e.outcome} /> },
        { key: "actor", header: "Actor", cell: (e) => label(e.actor_role), hideOnMobile: true },
        { key: "reason", header: "Reason", cell: (e) => (e.reason_code ? <code className="text-xs break-all">{e.reason_code}</code> : <span className="text-muted">None</span>), hideOnMobile: true },
      ]}
    />
  );
}

function Id({ value, name }: { value: string | null; name: string }) {
  if (!value) return null;
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="min-w-0 text-sm break-all">{value}</code>
      <CopyButton value={value} label={`Copy ${name}`} iconOnly />
    </span>
  );
}

export function EventDetailPanel({ detail, revealed, onReveal, revealing, onPivot, pivoting, onAddToCase }: {
  detail: EventDetail;
  revealed: string | null | undefined;
  onReveal: () => void;
  revealing: boolean;
  onPivot: (kind: string) => void;
  pivoting: string | null;
  onAddToCase: () => void;
}) {
  const e = detail.event;
  const counts = Object.entries(e.safe_counts);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={e.severity_text} />
        <OutcomeBadge outcome={e.outcome} />
        <Badge>{label(e.category)}</Badge>
        {e.durability === "best_effort" ? <Badge tone="warning">Best effort</Badge> : null}
        {detail.chain ? <Badge tone="success">Sealed #{detail.chain.seq}</Badge> : <Badge tone="warning">Not yet sealed</Badge>}
      </div>
      <KeyValueList
        columns={1}
        items={[
          { label: "Event", value: <code className="break-all">{e.event_name}</code> },
          { label: "Occurred", value: <DateTime value={e.occurred_at} format="datetime" /> },
          { label: "Action", value: e.action },
          { label: "Reason code", value: e.reason_code ? <code>{e.reason_code}</code> : null },
          { label: "Actor", value: `${label(e.actor_role)}${detail.actorUserPublicId ? ` · ${detail.actorUserPublicId}` : ""}` },
          { label: "Resource", value: e.resource_type ? `${e.resource_type}${e.resource_public_id ? ` · ${e.resource_public_id}` : ""}` : null },
          { label: "Request ID", value: <Id value={e.request_id} name="request ID" /> },
          { label: "Trace ID", value: <Id value={e.trace_id} name="trace ID" /> },
          { label: "Correlation ID", value: <Id value={e.correlation_id} name="correlation ID" /> },
          { label: "Job ID", value: <Id value={e.job_id} name="job ID" /> },
          { label: "Event ID", value: <Id value={e.event_id} name="event ID" /> },
          { label: "Origin", value: `${e.origin} · ${e.service}` },
          { label: "Duration", value: e.duration_ms === null ? null : `${e.duration_ms} ms` },
          {
            label: "Source address",
            value: (
              <span className="flex flex-wrap items-center gap-2">
                <span>{label(e.source_address_class)}</span>
                {revealed !== undefined ? (
                  <code className="break-all">{revealed ?? "Not recorded"}</code>
                ) : e.source_address_ref ? (
                  <Button size="sm" variant="secondary" loading={revealing} leadingIcon={<Eye aria-hidden className="size-4" />} onClick={onReveal}>
                    Reveal address
                  </Button>
                ) : null}
              </span>
            ),
          },
        ]}
      />
      {revealed !== undefined ? <Callout tone="info" title="Reveal recorded">Revealing a source address is itself recorded in the audit log.</Callout> : null}
      {counts.length > 0 ? (
        <Section title="Counts" headingLevel={3}>
          <KeyValueList columns={2} items={counts.map(([k, v]) => ({ label: k.replace(/_/g, " "), value: v.toLocaleString() }))} />
        </Section>
      ) : null}
      <Section title="Related events" headingLevel={3} description="Search for events that share a value with this one.">
        {detail.availablePivots.length === 0 ? (
          <p className="text-sm text-muted">This event has no shared identifiers to follow.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {detail.availablePivots.map((kind) => (
              <Button key={kind} size="sm" variant="secondary" loading={pivoting === kind} onClick={() => onPivot(kind)}>
                {PIVOT_LABELS[kind] ?? kind}
              </Button>
            ))}
          </div>
        )}
      </Section>
      <Section title="Investigation" headingLevel={3}>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" leadingIcon={<FolderPlus aria-hidden className="size-4" />} onClick={onAddToCase}>
            Add to case
          </Button>
          {detail.caseIds.length > 0 ? <span className="text-sm text-muted">Already in {detail.caseIds.length} case{detail.caseIds.length === 1 ? "" : "s"}.</span> : null}
        </div>
      </Section>
      {detail.chain ? (
        <Section title="Chain link" headingLevel={3}>
          <KeyValueList columns={1} items={[{ label: "Link hash", value: <code className="text-xs break-all">{detail.chain.linkHash}</code> }, { label: "Sealed", value: <DateTime value={detail.chain.sealedAt} format="datetime" /> }]} />
        </Section>
      ) : null}
      <CodeBlock label="Event record as JSON" copyable wrap>
        {JSON.stringify(e, null, 2)}
      </CodeBlock>
    </div>
  );
}
