/** D7: one security incident — summary, correlated events, timeline and response actions. The server re-checks every action. */
import { useState, type FormEvent } from "react";
import { Link, useParams } from "wouter";
import { Ban, CheckCircle2, LogOut, Search } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Breadcrumbs, Button, Callout, ConfirmDialog, DataTable, DateTime, Dialog, ErrorState, Field, KeyValueList, PageHeader, Section, Select,
  Skeleton, StepUpCancelledError, Timeline, useStepUp, useToast, type TimelineItem,
} from "@/ui";
import { AuditNav } from "./AuditNav";
import { BanDialog } from "./BanDialog";
import { IncidentSeverityBadge, IncidentStatusBadge } from "./IncidentsPage";
import {
  CLOSE_REASON_OPTIONS, closeReasonLabel, SEVERITY_META, SUBJECT_LABELS, TIMELINE_LABELS,
  type IncidentDetail, type IncidentTimelineItem,
} from "./model";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const BAN_UNAVAILABLE: Record<string, string> = {
  NO_ADDRESS: "No client address was recorded for this incident's events.",
  ADDRESS_UNDETERMINABLE: "Client addresses cannot be determined behind the current proxy setup, so bans are paused.",
  INCIDENT_CLOSED: "The incident is closed.",
};
const END_UNAVAILABLE: Record<string, string> = {
  NO_USER: "This incident is not tied to a known person.",
  INCIDENT_CLOSED: "The incident is closed.",
};

function timelineDescription(t: IncidentTimelineItem): string | undefined {
  const d = t.detail;
  if (t.kind === "events_added" && typeof d.added === "number") return `${d.added.toLocaleString()} events added.`;
  if (t.kind === "escalated" && typeof d.from === "string" && typeof d.to === "string") {
    const label = (s: string) => SEVERITY_META[s as keyof typeof SEVERITY_META]?.label ?? s;
    return `From ${label(d.from)} to ${label(d.to)}.`;
  }
  if (t.kind === "closed" && typeof d.reason === "string") return `Reason: ${closeReasonLabel(d.reason)}.`;
  if (t.kind === "action_ban_ip") return d.permanent === true ? "Permanent ban." : typeof d.duration_minutes === "number" ? `Ban for ${d.duration_minutes.toLocaleString()} minutes.` : undefined;
  if (t.kind === "action_end_sessions" && typeof d.sessions_ended === "number") return `${d.sessions_ended.toLocaleString()} sessions ended.`;
  return undefined;
}

export function timelineItems(detail: IncidentDetail): TimelineItem[] {
  return [...detail.timeline].reverse().map((t, i) => ({
    key: `${t.at}-${i}`,
    title: TIMELINE_LABELS[t.kind] ?? t.kind.replace(/_/g, " "),
    time: t.at,
    description: timelineDescription(t),
    actor: t.byMe ? "You" : t.byPerson ? "Another administrator" : "Correlation engine",
    tone: t.kind === "escalated" ? "danger" : t.kind === "closed" ? "success" : t.kind.startsWith("action_") ? "warning" : "neutral",
  }));
}

export function IncidentDetailView({ detail, onAcknowledge, onClose, onBan, onEndSessions, busy }: {
  detail: IncidentDetail; onAcknowledge: () => void; onClose: () => void; onBan: () => void; onEndSessions: () => void; busy: boolean;
}) {
  const open = detail.status !== "closed";
  return (
    <div className="space-y-8">
      <Section title="Summary">
        <KeyValueList columns={2} items={[
          { label: "Severity", value: <IncidentSeverityBadge severity={detail.severity} /> },
          { label: "Status", value: <IncidentStatusBadge status={detail.status} /> },
          { label: "Subject", value: SUBJECT_LABELS[detail.subjectKind] ?? detail.subjectKind },
          { label: "Events", value: detail.eventCount.toLocaleString() },
          { label: "Accounts", value: detail.accountCount.toLocaleString() },
          { label: "Addresses", value: detail.addressCount.toLocaleString() },
          { label: "First event", value: <DateTime value={detail.firstEventAt} format="datetime" /> },
          { label: "Last event", value: <DateTime value={detail.lastEventAt} format="datetime" /> },
          { label: "Acknowledged", value: detail.acknowledgedAt ? <DateTime value={detail.acknowledgedAt} format="datetime" /> : null },
          { label: "Closed", value: detail.closedAt ? <><DateTime value={detail.closedAt} format="datetime" /> ({closeReasonLabel(detail.closeReason)})</> : null },
        ]} />
      </Section>
      <Section title="Actions" description="Banning an address and ending sessions take effect immediately and ask you to confirm your identity.">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {detail.status === "open" ? <Button variant="secondary" leadingIcon={<CheckCircle2 aria-hidden className="size-4" />} onClick={onAcknowledge} loading={busy}>Acknowledge</Button> : null}
          {open ? <Button variant="secondary" onClick={onClose}>Close incident</Button> : null}
          <Button variant="danger" leadingIcon={<Ban aria-hidden className="size-4" />} onClick={onBan} disabled={!detail.actions.banIp.available}>Ban IP address</Button>
          <Button variant="danger" leadingIcon={<LogOut aria-hidden className="size-4" />} onClick={onEndSessions} disabled={!detail.actions.endSessions.available}>End sessions</Button>
          <Link href={`/admin/audit?incident=${detail.publicId}`} className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-3 text-sm font-medium text-brand underline-offset-2 hover:underline">
            <Search aria-hidden className="size-4" />Open in audit search
          </Link>
        </div>
        <ul className="mt-3 space-y-1 text-sm text-muted">
          {!detail.actions.banIp.available && detail.actions.banIp.reason ? <li>Ban IP address: {BAN_UNAVAILABLE[detail.actions.banIp.reason]}</li> : null}
          {!detail.actions.endSessions.available && detail.actions.endSessions.reason ? <li>End sessions: {END_UNAVAILABLE[detail.actions.endSessions.reason]}</li> : null}
        </ul>
      </Section>
      <Section title={`Correlated events (${detail.events.length.toLocaleString()})`} description={detail.linkedEventsCapped ? "Only the most recent linked events are kept. Open the audit search to see all of them." : undefined}>
        <DataTable
          caption="Correlated events"
          rows={detail.events}
          rowKey={(e) => e.eventId}
          columns={[
            { key: "name", header: "Event", primary: true, cell: (e) => <Link href={`/admin/audit?event=${e.eventId}`} className="inline-flex min-h-11 items-center font-mono text-sm text-brand underline-offset-2 hover:underline break-all">{e.eventName}</Link> },
            { key: "at", header: "Occurred", cell: (e) => <DateTime value={e.occurredAt} format="datetime" /> },
          ]}
        />
      </Section>
      <Section title="Timeline">
        <Timeline label="Incident timeline" items={timelineItems(detail)} />
      </Section>
    </div>
  );
}

export default function IncidentDetailPage() {
  const { publicId = "" } = useParams<{ publicId: string }>();
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const client = useQueryClient();
  const valid = ULID.test(publicId);
  const detail = useQuery({ ...trpc.audit.incidents.get.queryOptions({ publicId }), enabled: valid });
  const ack = useMutation(trpc.audit.incidents.acknowledge.mutationOptions());
  const close = useMutation(trpc.audit.incidents.close.mutationOptions());
  const ban = useMutation(trpc.audit.incidents.banAddress.mutationOptions());
  const end = useMutation(trpc.audit.incidents.endSessions.mutationOptions());
  const [dialog, setDialog] = useState<"close" | "ban" | "end" | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: trpc.audit.incidents.pathKey() });
  const fail = (title: string) => (error: unknown) => {
    if (!(error instanceof StepUpCancelledError)) toast.show({ title, description: errorMessage(error), tone: "danger" });
    void refresh();
    throw error;
  };
  const d = detail.data;

  return (
    <>
      <Breadcrumbs items={[{ label: "Security incidents", href: "/admin/audit/incidents" }, { label: d?.ruleLabel ?? "Incident" }]} />
      <PageHeader title={d?.ruleLabel ?? "Security incident"} description={d ? undefined : "Loading the incident."} />
      <AuditNav />
      {!valid ? <Callout tone="danger" title="Incident not found">Check the link and try again.</Callout>
        : detail.isPending ? <div role="status" aria-label="Loading incident" className="space-y-3"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>
        : detail.error ? <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
        : !d ? null : (
          <>
            {d.severity === "critical" && d.status !== "closed" ? <Callout tone="danger" title="Critical incident" className="mb-6">Review the events and act quickly. Possible account compromise or a large attack.</Callout> : null}
            <IncidentDetailView
              detail={d}
              busy={ack.isPending}
              onAcknowledge={() => ack.mutateAsync({ publicId, expectedVersion: d.version }).then(async () => { await refresh(); toast.show({ title: "Incident acknowledged", tone: "success" }); }, fail("Not acknowledged")).catch(() => undefined)}
              onClose={() => setDialog("close")}
              onBan={() => setDialog("ban")}
              onEndSessions={() => setDialog("end")}
            />
            <CloseDialog open={dialog === "close"} onCancel={() => setDialog(null)} busy={close.isPending}
              onSubmit={async (reason) => {
                await close.mutateAsync({ publicId, expectedVersion: d.version, reason }).catch(fail("Incident not closed"));
                await refresh();
                setDialog(null);
                toast.show({ title: "Incident closed", tone: "success" });
              }} />
            <BanDialog open={dialog === "ban"} onCancel={() => setDialog(null)} busy={ban.isPending}
              onSubmit={async (durationMinutes, reason) => {
                await stepUp.run(() => ban.mutateAsync({ publicId, durationMinutes, reason }), { reason: "Banning an address requires a fresh confirmation." }).catch(fail("Address not banned"));
                await refresh();
                setDialog(null);
                toast.show({ title: "Address banned", description: "Sign-ins from this address are refused. Release the ban from the firewall page.", tone: "success" });
              }} />
            <ConfirmDialog
              open={dialog === "end"}
              onOpenChange={(o) => !o && setDialog(null)}
              title="End all sessions for this person?"
              description="They are signed out on every device and must sign in again with their password and second factor."
              confirmLabel="End sessions"
              destructive
              onConfirm={async () => {
                const r = await stepUp.run(() => end.mutateAsync({ publicId }), { reason: "Ending another person's sessions requires a fresh confirmation." }).catch(fail("Sessions not ended"));
                await refresh();
                toast.show({ title: "Sessions ended", description: `${r.ended.toLocaleString()} sessions ended.`, tone: "success" });
              }}
            />
          </>
        )}
    </>
  );
}

type CloseReasonValue = (typeof CLOSE_REASON_OPTIONS)[number]["value"];

export function CloseDialog({ open, onCancel, onSubmit, busy }: { open: boolean; onCancel: () => void; onSubmit: (reason: CloseReasonValue) => Promise<void>; busy: boolean }) {
  const [reason, setReason] = useState<CloseReasonValue | "">("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reason) return setError("Choose why the incident is closed.");
    setError(null);
    await onSubmit(reason).catch(() => undefined);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()} title="Close incident" description="Events up to now stay with this incident. New activity opens a new incident." dismissible={!busy}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Reason" error={error ?? undefined} required>
          <Select value={reason} placeholder="Choose a reason" onChange={(e) => setReason(e.target.value as CloseReasonValue)} options={CLOSE_REASON_OPTIONS} />
        </Field>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" loading={busy}>Close incident</Button>
        </div>
      </form>
    </Dialog>
  );
}
