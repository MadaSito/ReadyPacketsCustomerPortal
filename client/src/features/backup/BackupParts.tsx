/** backup feature — shared presentational pieces. Owner: audit engineer. All server data is rendered as text; nothing is trusted. */
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, KeyRound } from "lucide-react";
import { roleHasCapability, type Capability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge, Button, Callout, DataTable, DateTime, Dialog, EmptyState, Field, KeyValueList, Section, Select, StatusBadge,
  StepUpCancelledError, Textarea, useStepUp, useToast,
} from "@/ui";
import {
  BASE, CONTINUITY_LABELS, CUSTODY_LABELS, HOLD_REASONS, TRIGGER_LABELS, formatBytes, formatDuration,
  type Archive, type RestoreDrill, type Verification,
} from "./model";

/** UI hint only — every procedure re-checks the capability (and step-up) on the server. */
export function useCan(capability: Capability): boolean {
  const role = useSession().me?.user.role;
  return role === "admin" && roleHasCapability(role, capability);
}

/** jobs.maintenanceBanner: while draining the server refuses new backups and restores (MAINTENANCE_DRAINING). */
export function useMaintenance() {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.jobs.maintenanceBanner.queryOptions(), staleTime: 15_000, retry: false });
  return { draining: q.data?.active === true, message: q.data?.message ?? null, unknown: q.isError, loading: q.isPending };
}

export function MaintenanceNotice() {
  const m = useMaintenance();
  if (m.loading) return null;
  if (m.draining) {
    return (
      <Callout tone="warning" title="Maintenance in progress" live="polite">
        The system is draining for maintenance, so new backups are refused until it finishes.
        {m.message ? ` Notice: ${m.message}` : ""}
      </Callout>
    );
  }
  if (m.unknown) {
    return <Callout tone="info" title="Maintenance status unavailable">The maintenance status could not be read. The server still refuses work while draining.</Callout>;
  }
  return null;
}

export function VerificationBadge({ status }: { status: Archive["verificationStatus"] }) {
  if (status === "verified") return <Badge tone="success">Verified</Badge>;
  if (status === "failed") return <Badge tone="danger">Verification failed</Badge>;
  return <Badge tone="warning">Not verified</Badge>;
}

export function OffHostBadge({
  status,
  remoteCopies = [],
}: {
  status: Archive["offHostCopyStatus"];
  remoteCopies?: Archive["remoteCopies"];
}) {
  const completed = remoteCopies.filter((c) => c.state === "completed").length;
  const inFlight = remoteCopies.filter((c) => c.state === "queued" || c.state === "running").length;
  const failed = remoteCopies.filter((c) => c.state === "failed").length;
  if (completed > 0 || inFlight > 0 || failed > 0) {
    return (
      <span className="flex flex-wrap items-center gap-1">
        {completed > 0 ? <Badge tone="success">{`${completed} off-site verified`}</Badge> : null}
        {inFlight > 0 ? <Badge tone="info">{`${inFlight} copying`}</Badge> : null}
        {failed > 0 ? <Badge tone="danger">{`${failed} failed`}</Badge> : null}
      </span>
    );
  }
  return <Badge tone="warning">{status === "disabled" ? "Off-host copy not configured" : "Local copy only"}</Badge>;
}

export function KeyCustodyNotice({ keyConfigured, warning }: { keyConfigured: boolean; warning: string | null }) {
  return (
    <Section title="Encryption key custody" description="Every backup is encrypted. The backup key is never shown in this console and cannot be downloaded from it.">
      <div className="min-w-0 space-y-3">
        {!keyConfigured ? (
          <Callout tone="danger" title="No backup key configured">
            <span className="break-words [overflow-wrap:anywhere]">
              Backups are refused until an encryption key is configured on the host (RP_BACKUP_KEY_FILE, a 0600 file readable only by the service).
              There is no unencrypted mode.
            </span>
          </Callout>
        ) : null}
        {warning ? <Callout tone="warning" title="Key custody warning"><span className="break-words [overflow-wrap:anywhere]">{warning}</span></Callout> : null}
        <Callout tone="info" title="Where the key must be kept">
          <p className="mb-2 break-words [overflow-wrap:anywhere]">Keep a copy of the backup key outside this server — for example in an offline password vault or a sealed escrow envelope held by two named custodians.</p>
          <p className="break-words [overflow-wrap:anywhere]">A backup cannot be restored without the key that encrypted it. If the server is lost together with its only key copy, every backup is unrecoverable. See the key runbook in scripts/ops/keys/RUNBOOK.md.</p>
        </Callout>
      </div>
    </Section>
  );
}

export function ArchivesTable({
  rows,
  loading,
  error,
  onRetry,
  canCopyArchive,
  onCopyNow,
  copyingBackupId,
}: {
  rows: readonly Archive[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  canCopyArchive?: (row: Archive) => boolean;
  onCopyNow?: (row: Archive) => void;
  copyingBackupId?: string | null;
}) {
  return (
    <DataTable
      caption="Backups"
      rows={rows}
      loading={loading}
      error={error}
      onRetry={onRetry}
      rowKey={(r) => r.publicId}
      empty={<EmptyState icon={DatabaseBackup} title="No backups yet" description="Run a backup now, or turn on the daily schedule in retention settings." />}
      columns={[
        { key: "when", header: "Started", primary: true, cell: (r) => <DateTime value={r.createdAt} format="datetime" /> },
        { key: "state", header: "Status", cell: (r) => <StatusBadge state={r.state} /> },
        { key: "type", header: "Type", cell: (r) => TRIGGER_LABELS[r.trigger] },
        { key: "size", header: "Size", align: "end", cell: (r) => formatBytes(r.encryptedSizeBytes) ?? "—" },
        { key: "key", header: "Encryption key", hideOnMobile: true, cell: (r) => (r.backupKeyId ? <code className="text-xs break-all">{r.backupKeyId}</code> : "—") },
        {
          key: "verify", header: "Verification", cell: (r) => (
            <span className="flex flex-wrap items-center gap-1">
              <VerificationBadge status={r.verificationStatus} />
              {r.isLastKnownGood ? <Badge tone="info">Last known good</Badge> : null}
            </span>
          ),
        },
        {
          key: "offsite",
          header: "Off-site",
          cell: (r) => <OffHostBadge status={r.offHostCopyStatus} remoteCopies={r.remoteCopies ?? []} />,
        },
        {
          key: "retention", header: "Retention", hideOnMobile: true, cell: (r) => (
            r.purgedAt ? <Badge>Removed by retention</Badge>
              : r.activeHoldCount > 0 ? <Badge tone="brand">{r.activeHoldCount === 1 ? "On legal hold" : `${r.activeHoldCount} legal holds`}</Badge>
              : r.isLastKnownGood ? "Kept (last known good)" : "Per retention policy"
          ),
        },
      ]}
      rowActions={(r) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          {onCopyNow && canCopyArchive?.(r) ? (
            <Button
              size="sm"
              variant="ghost"
              loading={copyingBackupId === r.publicId}
              disabled={Boolean(copyingBackupId)}
              onClick={() => onCopyNow(r)}
              aria-label={`Copy now: verified backup ${r.publicId} off-site`}
            >
              Copy now
            </Button>
          ) : null}
          <Button asChild size="sm" variant="secondary">
            <Link href={`${BASE}/${encodeURIComponent(r.publicId)}`} aria-label={`Open backup started ${new Date(r.createdAt).toISOString()}`}>Open</Link>
          </Button>
        </span>
      )}
    />
  );
}

export function ArchiveFacts({ archive }: { archive: Archive }) {
  return (
    <KeyValueList columns={2} items={[
      { label: "Status", value: <span className="flex flex-wrap gap-1"><StatusBadge state={archive.state} />{archive.reasonCode ? <code className="text-xs break-all">{archive.reasonCode}</code> : null}</span> },
      { label: "Verification", value: <span className="flex flex-wrap gap-1"><VerificationBadge status={archive.verificationStatus} />{archive.lastVerifiedAt ? <DateTime value={archive.lastVerifiedAt} format="relative" /> : null}</span> },
      { label: "Type", value: TRIGGER_LABELS[archive.trigger] },
      { label: "Encrypted size", value: formatBytes(archive.encryptedSizeBytes) },
      { label: "Started", value: <DateTime value={archive.createdAt} format="datetime" /> },
      { label: "Finished", value: archive.completedAt ? <DateTime value={archive.completedAt} format="datetime" /> : null },
      { label: "Encryption key id", value: archive.backupKeyId ? <code className="text-xs break-all">{archive.backupKeyId}</code> : null },
      { label: "Key custody", value: archive.keyCustodyMode ? CUSTODY_LABELS[archive.keyCustodyMode] : null },
      { label: "Files included", value: archive.objectCount === null ? null : `${archive.objectCount.toLocaleString()} (${formatBytes(archive.objectTotalBytes) ?? "size unknown"})` },
      { label: "Schema migrations", value: archive.schemaMigrationCount?.toLocaleString() ?? null },
      { label: "Release", value: <code className="text-xs break-all">{archive.releaseRef}</code> },
      { label: "Off-host copy", value: <OffHostBadge status={archive.offHostCopyStatus} remoteCopies={archive.remoteCopies ?? []} /> },
      { label: "Archive SHA-256", value: archive.archiveSha256 ? <code className="text-xs break-all">{archive.archiveSha256}</code> : null, wide: true },
    ]} />
  );
}

const yesNo = (v: boolean | null) => (v === null ? "Not checked" : v ? "Yes" : "No");

export function VerificationsTable({ rows }: { rows: readonly Verification[] }) {
  return (
    <DataTable
      caption="Verification history"
      rows={rows}
      rowKey={(r) => r.publicId}
      empty={<EmptyState icon={KeyRound} title="Never verified" description="Verification decrypts and checks every chunk, the database dump and every file without restoring anything." headingLevel={3} />}
      columns={[
        { key: "when", header: "When", primary: true, cell: (r) => <DateTime value={r.createdAt} format="datetime" /> },
        { key: "state", header: "Result", cell: (r) => <span className="flex flex-wrap gap-1"><StatusBadge state={r.state} />{r.reasonCode ? <code className="text-xs break-all">{r.reasonCode}</code> : null}</span> },
        { key: "chunks", header: "Chunks", align: "end", hideOnMobile: true, cell: (r) => r.chunksVerified?.toLocaleString() ?? "—" },
        { key: "sql", header: "Database dump matches", cell: (r) => yesNo(r.sqlSha256Matched) },
        { key: "files", header: "Files checked", align: "end", cell: (r) => r.objectsVerified?.toLocaleString() ?? "—" },
        { key: "manifest", header: "Manifest valid", hideOnMobile: true, cell: (r) => yesNo(r.manifestValid) },
        {
          key: "keys", header: "Keys", cell: (r) => (
            r.keyReadiness === "ready" ? <Badge tone="success">All keys present</Badge>
              : r.keyReadiness === "missing_data_keys" ? <Badge tone="danger">{`${r.missingDataKeyIds.length} key(s) missing`}</Badge>
                : <Badge>Unknown</Badge>
          ),
        },
        { key: "duration", header: "Duration", align: "end", hideOnMobile: true, cell: (r) => formatDuration(r.durationMs) ?? "—" },
      ]}
    />
  );
}

export function DrillReport({ drill }: { drill: RestoreDrill }) {
  const c = drill.continuity;
  const i = drill.integrity;
  return (
    <div className="space-y-4">
      <KeyValueList columns={2} items={[
        { label: "Outcome", value: <span className="flex flex-wrap gap-1"><StatusBadge state={drill.state} />{drill.reasonCode ? <code className="text-xs break-all">{drill.reasonCode}</code> : null}</span> },
        { label: "Target database", value: <code className="text-xs break-all">{drill.targetDatabaseName}</code> },
        { label: "Continuity mode", value: CONTINUITY_LABELS[drill.continuityMode].label },
        { label: "Duration", value: formatDuration(drill.durationMs) },
        { label: "Data age at restore", value: formatDuration(drill.achievedDataAgeMs), wide: true },
      ]} />
      {i ? (
        <Section title="Integrity checks" headingLevel={3}>
          {i.passed ? <Callout tone="success" title="Integrity checks passed">Schema, table row counts and file hashes match the backup manifest.</Callout>
            : <Callout tone="danger" title="Integrity checks did not pass">Do not promote this restored copy. Review the mismatches below.</Callout>}
          <KeyValueList columns={2} items={[
            { label: "Schema migrations", value: `${i.restoredMigrationCount} of ${i.expectedMigrationCount}${i.schemaMigrationsMatched ? " (match)" : " (mismatch)"}` },
            { label: "Tables checked", value: i.tablesChecked.toLocaleString() },
            { label: "Row count mismatches", value: i.tableRowMismatches.length === 0 ? "None" : i.tableRowMismatches.map((m) => `${m.table}: expected ${m.expected}, got ${m.actual}`).join("; "), wide: true },
            { label: "Files checked", value: i.objectsChecked.toLocaleString() },
            { label: "File hash mismatches", value: i.objectHashMismatches.toLocaleString() },
          ]} />
        </Section>
      ) : null}
      {c ? (
        <Section title="Security continuity" description="Applied to the restored copy only, so restored data cannot be used to replay sessions, links or MFA codes." headingLevel={3}>
          <KeyValueList columns={2} items={[
            { label: "Sessions revoked", value: c.sessionsRevoked.toLocaleString() },
            { label: "Single-use links retired", value: c.singleUseTokensRetired.toLocaleString() },
            { label: "MFA challenges cleared", value: c.ephemeralChallengesCleared.toLocaleString() },
            { label: "Download tickets cleared", value: c.downloadTicketsCleared.toLocaleString() },
            { label: "Authenticator watermarks advanced", value: c.totpWatermarksAdvanced.toLocaleString() },
            { label: "Passkey counters reconciled", value: c.passkeyCountersReconciled.toLocaleString() },
            { label: "Recovery codes reconciled", value: c.recoveryCodesReconciled.toLocaleString() },
            { label: "Queued jobs quarantined", value: c.queuedJobsQuarantined.toLocaleString() },
            { label: "Queued e-mails quarantined", value: c.queuedMailQuarantined.toLocaleString() },
            { label: "External integrations disabled", value: c.externalFlagsDisabled.toLocaleString() },
            {
              label: "Audit chain", value: c.auditChainVerified === "verified" ? <Badge tone="success">Verified</Badge>
                : c.auditChainVerified === "failed" ? <Badge tone="danger">Verification failed</Badge> : <Badge>Not present</Badge>,
            },
            { label: "Continuity marker written", value: c.auditContinuityMarkerAppended ? "Yes" : "No" },
          ]} />
        </Section>
      ) : null}
    </div>
  );
}

const NOTE_MIN = 3;
const NOTE_MAX = 500;

/** Place a legal hold (backup.retention.manage + step-up). The note is an internal reference — no personal data. */
export function HoldDialog({ open, onOpenChange, backupPublicId }: { open: boolean; onOpenChange: (o: boolean) => void; backupPublicId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const create = useMutation(trpc.backup.admin.createHold.mutationOptions());
  const [reasonCode, setReasonCode] = useState<string>(HOLD_REASONS[0].value);
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const noteError = note.trim().length < NOTE_MIN ? `Enter at least ${NOTE_MIN} characters.` : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (noteError) return;
    try {
      await stepUp.run(() => create.mutateAsync({ backupPublicId, reasonCode, note: note.trim() }), { reason: "Placing a legal hold requires a fresh confirmation." });
      toast.show({ title: "Legal hold placed", description: "Retention will not remove this backup while the hold is active.", tone: "success" });
      setNote(""); setTouched(false); onOpenChange(false);
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ title: "Hold not placed", description: errorMessage(error), tone: "danger" });
    } finally {
      await qc.invalidateQueries(trpc.backup.admin.pathFilter());
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Place a legal hold" description="A held backup is kept regardless of the retention policy until the hold is released."
      footer={<div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" form="backup-hold-form" loading={create.isPending}>Place hold</Button></div>}>
      <form id="backup-hold-form" className="space-y-4" onSubmit={submit} noValidate>
        <Field label="Reason" required>
          <Select options={[...HOLD_REASONS]} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} />
        </Field>
        <Field label="Reference note" required hint="An internal reference such as a matter or ticket number. Do not enter personal data." error={touched ? noteError : undefined}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX} rows={3} />
        </Field>
      </form>
    </Dialog>
  );
}
