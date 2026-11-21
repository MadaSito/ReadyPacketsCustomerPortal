/** /admin/backups/:backupId — archive facts, verification ledger, restore drill records, holds, verify and download. Owner: audit engineer. */
import { useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Lock, RotateCcw, ShieldCheck } from "lucide-react";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Breadcrumbs, Button, Callout, ConfirmDialog, DataTable, DateTime, Dialog, EmptyState, ErrorState, Field, PageHeader, Select, Section, Skeleton, StatusBadge,
  StepUpCancelledError, useStepUp, useToast,
} from "@/ui";
import { ArchiveFacts, DrillReport, HoldDialog, useCan, VerificationsTable } from "./BackupParts";
import { RemoteCopiesSection } from "./OffsiteParts";
import { BASE, CONTINUITY_LABELS, RELEASE_REASONS, formatDuration, PUBLIC_ID, type Archive, type BackupDetail, type Hold, type RestoreDrill } from "./model";

/** Archives above this size are better copied with the host CLI; the browser holds the whole file in memory. */
const BROWSER_DOWNLOAD_LIMIT = 2 * 1024 * 1024 * 1024;

async function isStepUpResponse(response: Response): Promise<boolean> {
  if (response.status !== 403 && response.status !== 401) return false;
  const body = (await response.clone().json().catch(() => null)) as { safe?: { domainCode?: unknown } } | null;
  return body?.safe?.domainCode === "STEP_UP_REQUIRED";
}

export const canDownload = (a: Archive) => a.state === "completed" && a.purgedAt === null && a.encryptedSizeBytes !== null && a.encryptedSizeBytes <= BROWSER_DOWNLOAD_LIMIT;

export function DrillsTable({ rows, onOpen }: { rows: readonly RestoreDrill[]; onOpen: (d: RestoreDrill) => void }) {
  return (
    <DataTable
      caption="Restore drills"
      rows={rows}
      rowKey={(r) => r.publicId}
      empty={<EmptyState icon={RotateCcw} title="No restore drills yet" description="A drill restores this backup into an isolated empty database and checks it, without touching the live system." headingLevel={3} />}
      columns={[
        { key: "when", header: "When", primary: true, cell: (r) => <DateTime value={r.createdAt} format="datetime" /> },
        { key: "state", header: "Outcome", cell: (r) => <StatusBadge state={r.state} /> },
        { key: "target", header: "Target database", hideOnMobile: true, cell: (r) => <code className="text-xs break-all">{r.targetDatabaseName}</code> },
        { key: "mode", header: "Continuity", hideOnMobile: true, cell: (r) => CONTINUITY_LABELS[r.continuityMode].label },
        { key: "integrity", header: "Integrity", cell: (r) => (r.integrity === null ? "Not checked" : r.integrity.passed ? <Badge tone="success">Passed</Badge> : <Badge tone="danger">Did not pass</Badge>) },
        { key: "duration", header: "Duration", align: "end", hideOnMobile: true, cell: (r) => formatDuration(r.durationMs) ?? "—" },
      ]}
      rowActions={(r) => <Button size="sm" variant="ghost" onClick={() => onOpen(r)} aria-label={`Report for restore drill ${new Date(r.createdAt).toISOString()}`}>Report</Button>}
    />
  );
}

export function HoldsList({ holds, onRelease }: { holds: BackupDetail["holds"]; onRelease?: (h: Hold) => void }) {
  const active = holds.filter((h) => h.releasedAt === null);
  if (active.length === 0) return <p className="text-sm text-muted">No active legal holds. This backup follows the retention policy.</p>;
  return (
    <ul className="space-y-2">
      {active.map((h) => (
        <li key={h.publicId} className="rounded-[var(--radius-card)] border border-line p-3 text-sm text-body">
          <span className="flex flex-wrap items-center gap-2"><Badge tone="brand">Legal hold</Badge><code className="text-xs break-all">{h.reasonCode}</code><DateTime value={h.createdAt} format="date" /></span>
          <p className="mt-1 break-words">{h.note}</p>
          {onRelease ? <Button className="mt-2" size="sm" variant="ghost" onClick={() => onRelease(h)} aria-label={`Release legal hold ${h.reasonCode}`}>Release</Button> : null}
        </li>
      ))}
    </ul>
  );
}

export default function BackupDetailPage() {
  const { backupId = "" } = useParams<{ backupId: string }>();
  const valid = PUBLIC_ID.test(backupId);
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const canVerify = useCan("backup.verify");
  const canRestore = useCan("backup.restore");
  const canHold = useCan("backup.retention.manage");
  const release = useMutation(trpc.backup.admin.releaseHold.mutationOptions());
  const [holdOpen, setHoldOpen] = useState(false);
  const [releasing, setReleasing] = useState<Hold | null>(null);
  const [releaseReason, setReleaseReason] = useState<string>(RELEASE_REASONS[0].value);
  const detail = useQuery({
    ...trpc.backup.admin.detail.queryOptions({ backupPublicId: backupId }),
    enabled: valid,
    refetchInterval: (q) =>
      q.state.data?.archive.state === "queued" ||
      q.state.data?.archive.state === "running" ||
      (q.state.data?.remoteCopies ?? []).some((c) => c.state === "queued" || c.state === "running")
        ? 5000
        : false,
  });
  const offsite = useQuery({ ...trpc.backup.admin.offsiteConfig.queryOptions(), enabled: valid });
  const verify = useMutation(trpc.backup.admin.verify.mutationOptions());
  const [report, setReport] = useState<RestoreDrill | null>(null);
  const [downloading, setDownloading] = useState(false);

  const crumbs = <Breadcrumbs items={[{ label: "Backups", href: BASE }, { label: "Backup" }]} />;
  if (!valid) return (<><PageHeader title="Backup" breadcrumbs={crumbs} /><ErrorState title="Backup not found" message="The link is not a valid backup identifier." /></>);
  if (detail.isPending) return (<><PageHeader title="Backup" breadcrumbs={crumbs} /><Skeleton lines={8} /></>);
  if (detail.error || !detail.data) return (<><PageHeader title="Backup" breadcrumbs={crumbs} /><ErrorState error={detail.error} onRetry={() => detail.refetch()} /></>);

  const { archive, verifications, restores, holds, remoteCopies = [] } = detail.data;

  const runVerify = async () => {
    try {
      const result = await stepUp.run(() => verify.mutateAsync({ backupPublicId: archive.publicId }), { reason: "Verifying a backup requires a fresh confirmation." });
      toast.show(result.state === "completed"
        ? { title: "Backup verified", description: "Every chunk, the database dump and every file checked out.", tone: "success" }
        : { title: "Verification did not pass", description: result.reasonCode ? `Reason: ${result.reasonCode}` : "See the verification history.", tone: "danger" });
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ title: "Verification not completed", description: errorMessage(error, "The outcome is unknown. Refresh to see whether a verification was recorded."), tone: "danger" });
    } finally {
      await qc.invalidateQueries(trpc.backup.admin.pathFilter());
    }
  };

  const releaseHold = async () => {
    if (!releasing) return;
    try {
      await stepUp.run(() => release.mutateAsync({ holdPublicId: releasing.publicId, releaseReasonCode: releaseReason }), { reason: "Releasing a legal hold requires a fresh confirmation." });
      toast.show({ title: "Legal hold released", tone: "success" });
      setReleasing(null);
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ title: "Hold not released", description: errorMessage(error), tone: "danger" });
      throw error;
    } finally {
      await qc.invalidateQueries(trpc.backup.admin.pathFilter());
    }
  };

  const download = async () => {
    setDownloading(true);
    try {
      const url = apiUrl(`/api/backup/archives/${encodeURIComponent(archive.publicId)}/download`);
      let response = await sessionFetch(url, { cache: "no-store" });
      if (await isStepUpResponse(response)) {
        const ok = await stepUp.request({ reason: "Downloading an encrypted backup requires a fresh confirmation." });
        if (!ok) throw new StepUpCancelledError();
        response = await sessionFetch(url, { cache: "no-store" });
      }
      if (!response.ok || !/^attachment[;\s]/iu.test(response.headers.get("content-disposition") ?? "")) {
        toast.show({ title: "Download not available", description: "The backup could not be authorized for download. Refresh and try again.", tone: "danger" });
        return;
      }
      const blob = await response.blob();
      if (blob.size !== archive.encryptedSizeBytes) {
        toast.show({ title: "Incomplete download", description: "The file size does not match the backup record. Do not rely on this copy.", tone: "danger" });
        return;
      }
      const href = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = href;
        a.download = `readypackets-backup-${archive.publicId}.rpbk`;
        document.body.append(a);
        try { a.click(); } finally { a.remove(); }
      } finally {
        setTimeout(() => URL.revokeObjectURL(href), 0);
      }
      toast.show({ title: "Download started", description: "The file stays encrypted. Compare its SHA-256 with the value on this page.", tone: "success" });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) toast.show({ title: "Download failed", description: "The connection was interrupted. Try again.", tone: "danger" });
    } finally {
      setDownloading(false);
    }
  };

  const tooLarge = archive.state === "completed" && archive.purgedAt === null && archive.encryptedSizeBytes !== null && !canDownload(archive);
  return (
    <>
      <PageHeader
        title="Backup"
        breadcrumbs={crumbs}
        meta={<DateTime value={archive.createdAt} format="datetime" />}
        actions={
          <div className="flex flex-wrap gap-2">
            {canVerify && archive.state === "completed" && archive.purgedAt === null ? <Button variant="secondary" leadingIcon={<ShieldCheck className="size-4" aria-hidden />} loading={verify.isPending} onClick={runVerify}>Verify now</Button> : null}
            {canRestore && canDownload(archive) ? <Button variant="secondary" leadingIcon={<Download className="size-4" aria-hidden />} loading={downloading} onClick={download}>Download encrypted copy</Button> : null}
            {canHold && archive.purgedAt === null ? <Button variant="secondary" leadingIcon={<Lock className="size-4" aria-hidden />} onClick={() => setHoldOpen(true)}>Place legal hold</Button> : null}
            <Button asChild variant="ghost" leadingIcon={<RotateCcw className="size-4" aria-hidden />}><Link href={`${BASE}/restore`}>How to restore</Link></Button>
          </div>
        }
      />
      <div className="space-y-8">
        {archive.purgedAt ? <Callout tone="info" title="Removed by retention">The encrypted file was removed <DateTime value={archive.purgedAt} format="date" />. Its record and verification history are kept.</Callout> : null}
        {archive.state === "unknown" ? <Callout tone="warning" title="Outcome unknown">The backup job stopped without a definite result. Do not rely on this backup; run a new one.</Callout> : null}
        {tooLarge ? <Callout tone="info" title="Copy with the host tools">This backup is too large to download in a browser. Copy the encrypted file from the server with the backup scripts in scripts/ops/backup.</Callout> : null}
        <Section title="Details"><ArchiveFacts archive={archive} /></Section>
        <RemoteCopiesSection archive={archive} copies={remoteCopies} offsiteConfig={offsite.data} />
        <Section title="Verification history"><VerificationsTable rows={verifications} /></Section>
        <Section title="Restore drills" description="Continuity record from operator restores: each drill proves this backup can be restored, and how long it took."><DrillsTable rows={restores} onOpen={setReport} /></Section>
        <Section title="Legal holds" description="A held backup is never removed by retention."><HoldsList holds={holds} onRelease={canHold && archive.purgedAt === null ? setReleasing : undefined} /></Section>
      </div>
      <HoldDialog open={holdOpen} onOpenChange={setHoldOpen} backupPublicId={archive.publicId} />
      <ConfirmDialog
        open={releasing !== null}
        onOpenChange={(o) => !o && setReleasing(null)}
        title="Release this legal hold?"
        description="Once released, retention may remove the backup when it falls outside the policy. You will be asked to confirm your identity."
        confirmLabel="Release hold"
        destructive
        onConfirm={releaseHold}
      >
        <Field label="Reason for release" required>
          <Select options={[...RELEASE_REASONS]} value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
      <Dialog open={report !== null} onOpenChange={(o) => !o && setReport(null)} title="Restore drill report" size="lg">
        {report ? <DrillReport drill={report} /> : null}
      </Dialog>
    </>
  );
}
