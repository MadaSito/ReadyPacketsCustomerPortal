/** /admin/backups — inventory, schedule and freshness posture, run-now. Owner: audit engineer. */
import { useState } from "react";
import { Link } from "wouter";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive as ArchiveIcon, RotateCcw } from "lucide-react";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Button, Callout, ConfirmDialog, DateTime, ErrorState, KeyValueList, LoadMore, PageHeader, Section, Skeleton,
  StepUpCancelledError, useStepUp, useToast,
} from "@/ui";
import { ArchivesTable, KeyCustodyNotice, MaintenanceNotice, useCan, useMaintenance } from "./BackupParts";
import { OffsiteCopiesForm, Status321Card } from "./OffsiteParts";
import { BASE, freshness, formatDuration, STALE_AFTER_MS, type Archive, type Backup321, type RetentionPolicy } from "./model";

export function Posture({ items, keyConfigured, offHostStatusNote, policy, status321, now }: {
  items: readonly Archive[];
  keyConfigured: boolean;
  offHostStatusNote: string;
  policy: RetentionPolicy | undefined;
  status321?: Backup321 | undefined;
  now: number;
}) {
  const f = freshness(items, now);
  const scheduleOn = policy?.scheduleEnabled === true;
  const targetHours = STALE_AFTER_MS / 3_600_000;
  const offsiteBadge = status321?.overallMet ? (
    <Badge tone="success">3-2-1 met</Badge>
  ) : status321 && status321.offsiteVerifiedCopies > 0 ? (
    <Badge tone="info">{`${status321.offsiteVerifiedCopies} off-site verified`}</Badge>
  ) : (
    <Badge tone="warning">Not configured</Badge>
  );
  return (
    <Section title="Protection status">
      <div className="space-y-3">
        {f.kind === "none" ? (
          <Callout tone="danger" title="No successful backup">There is no completed backup on record. Run one now before relying on recovery.</Callout>
        ) : f.kind === "stale" ? (
          <Callout tone="warning" title="Latest backup is out of date" live="polite">
            The newest successful backup is {formatDuration(f.ageMs)} old, beyond the {targetHours}-hour target.
            {scheduleOn ? " The daily schedule may be failing — check Jobs." : " The daily schedule is off."}
          </Callout>
        ) : null}
        <KeyValueList columns={2} items={[
          {
            label: "Last successful backup",
            value: f.kind === "none" ? "None" : <span><DateTime value={f.at} format="relative" /> ({formatDuration(f.ageMs)} old, target {targetHours} h)</span>,
          },
          {
            label: "Daily schedule",
            value: policy === undefined ? "Unknown" : scheduleOn ? <Badge tone="success">On</Badge> : <Badge tone="warning">Off</Badge>,
          },
          { label: "Encryption key", value: keyConfigured ? <Badge tone="success">Configured</Badge> : <Badge tone="danger">Not configured</Badge> },
          { label: "Retention", value: policy ? `Keep last ${policy.keepLastCount}, at most ${policy.maxAgeDays} days` : "Unknown" },
          { label: "Off-host copy", value: <span className="flex flex-col gap-1">{offsiteBadge}<span className="text-sm text-muted">{offHostStatusNote}</span></span>, wide: true },
        ]} />
      </div>
    </Section>
  );
}

export default function BackupsPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const canRun = useCan("backup.run");
  const canRead = useCan("backup.read");
  const maintenance = useMaintenance();
  const [confirm, setConfirm] = useState(false);
  const [copyingId, setCopyingId] = useState<string | null>(null);

  const list = useInfiniteQuery({
    ...trpc.backup.admin.list.infiniteQueryOptions({ limit: 25 }, { getNextPageParam: (p) => p.nextCursor ?? undefined }),
    refetchInterval: (q) =>
      q.state.data?.pages.some((p) =>
        p.items.some(
          (i) =>
            i.state === "queued" ||
            i.state === "running" ||
            (i.remoteCopies ?? []).some((c) => c.state === "queued" || c.state === "running"),
        ),
      )
        ? 5000
        : 60_000,
  });
  const policy = useQuery(trpc.backup.admin.retentionPolicy.queryOptions());
  const offsite = useQuery(trpc.backup.admin.offsiteConfig.queryOptions());
  const run = useMutation(trpc.backup.admin.runNow.mutationOptions());
  const copyNowMutation = useMutation(trpc.backup.admin.copyOffsiteNow.mutationOptions());

  const first = list.data?.pages[0];
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const activeDestinations =
    offsite.data?.destinations.filter((d) => d.assigned && d.enabled && d.connectionEnabled) ?? [];

  const canCopyArchiveRow = (row: Archive) => {
    if (!canRun || maintenance.draining || activeDestinations.length === 0) return false;
    if (row.state !== "completed" || row.verificationStatus !== "verified" || row.purgedAt !== null) return false;
    const copiesByConn = new Map((row.remoteCopies ?? []).map((c) => [c.connectionPublicId, c]));
    return activeDestinations.some((d) => {
      const existing = copiesByConn.get(d.connectionPublicId);
      return !existing || existing.state === "failed";
    });
  };

  const handleCopyNow = async (row: Archive) => {
    setCopyingId(row.publicId);
    try {
      const res = await stepUp.run(
        () => copyNowMutation.mutateAsync({ backupPublicId: row.publicId }),
        { reason: "Copying an encrypted backup off-site requires a fresh confirmation." },
      );
      toast.show({
        title: "Off-site copy queued",
        description: `${res.queued.length} destination copy job(s) queued.`,
        tone: "success",
      });
      await qc.invalidateQueries(trpc.backup.admin.pathFilter());
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ title: "Off-site copy not started", description: errorMessage(error), tone: "danger" });
    } finally {
      setCopyingId(null);
    }
  };

  const runNow = async () => {
    try {
      await stepUp.run(() => run.mutateAsync({ trigger: "manual" }), { reason: "Starting a backup requires a fresh confirmation." });
      toast.show({ title: "Backup queued", description: "It appears in the list below and updates automatically.", tone: "success" });
      await qc.invalidateQueries(trpc.backup.admin.list.pathFilter());
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ title: "Backup not started", description: errorMessage(error), tone: "danger" });
      throw error;
    }
  };

  return (
    <>
      <PageHeader
        title="Backups"
        description="Encrypted backups of the database and stored files, with verification and isolated restore drills."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="ghost" leadingIcon={<RotateCcw className="size-4" aria-hidden />}><Link href={`${BASE}/restore`}>How to restore</Link></Button>
            {canRead ? <Button asChild variant="secondary" leadingIcon={<ArchiveIcon className="size-4" aria-hidden />}><Link href={`${BASE}/retention`}>Retention</Link></Button> : null}
            {canRun ? (
              <Button onClick={() => setConfirm(true)} disabled={first?.keyConfigured === false || maintenance.draining} loading={run.isPending}>Run backup now</Button>
            ) : null}
          </div>
        }
      />
      <div className="space-y-8">
        <MaintenanceNotice />
        {list.isPending ? <Skeleton lines={4} /> : list.error && !first ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : first ? (
          <Posture
            items={items}
            keyConfigured={first.keyConfigured}
            offHostStatusNote={first.offHostStatusNote}
            policy={policy.data}
            status321={offsite.data?.status321}
            now={list.dataUpdatedAt}
          />
        ) : null}
        {offsite.data ? <Status321Card status={offsite.data.status321} /> : null}
        <Section title="Backup history">
          <ArchivesTable
            rows={list.data ? items : undefined}
            loading={list.isPending}
            error={list.error}
            onRetry={() => list.refetch()}
            canCopyArchive={canCopyArchiveRow}
            onCopyNow={canRun ? handleCopyNow : undefined}
            copyingBackupId={copyingId}
          />
          <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => list.fetchNextPage()} summary={`${items.length} backups shown`} />
        </Section>
        {offsite.data ? <OffsiteCopiesForm config={offsite.data} /> : null}
        {first ? <KeyCustodyNotice keyConfigured={first.keyConfigured} warning={first.keyCustodyWarning} /> : null}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Run a backup now?"
        description="The backup runs in the background and is encrypted with the configured backup key. You will be asked to confirm your identity."
        confirmLabel="Run backup"
        onConfirm={runNow}
      />
    </>
  );
}
