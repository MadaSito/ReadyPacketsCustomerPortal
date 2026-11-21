/**
 * Off-site backup copies configuration form, 3-2-1 strategy status card, and per-backup destination table.
 * All server values are rendered strictly as plain React text (never raw HTML).
 */
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CloudUpload, HardDrive, ShieldAlert, XCircle } from "lucide-react";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  DateTime,
  EmptyState,
  Field,
  Input,
  Section,
  StatusBadge,
  StepUpCancelledError,
  Switch,
  useStepUp,
  useToast,
} from "@/ui";
import { useCan, useMaintenance } from "./BackupParts";
import {
  DIGEST_KIND_LABELS,
  PROVIDER_KIND_LABELS,
  formatBytes,
  type Archive,
  type Backup321,
  type OffsiteConfig,
  type OffsiteDestination,
  type RemoteCopy,
} from "./model";

const MAX_ASSIGNED = 8;

function ConditionRow({
  met,
  title,
  detail,
}: {
  met: boolean;
  title: string;
  detail: string;
}) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-3">
      <div className="flex items-start gap-2.5 min-w-0">
        {met ? (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <XCircle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{title}</p>
          <p className="text-sm text-muted">{detail}</p>
        </div>
      </div>
      <Badge tone={met ? "success" : "danger"}>{met ? "Met" : "Not met"}</Badge>
    </li>
  );
}

export function Status321Card({ status }: { status: Backup321 }) {
  const systemsText =
    status.storageSystemKinds.length > 0
      ? status.storageSystemKinds.map((k) => PROVIDER_KIND_LABELS[k] ?? k).join(", ")
      : "None";

  return (
    <Section
      title="3-2-1 backup strategy status"
      description={`Computed strictly from real verified backup copies created in the last ${status.windowDays} day(s) — never from configuration alone.`}
    >
      <div className="space-y-4">
        {status.overallMet ? (
          <Callout tone="success" title="3-2-1 backup policy met">
            At least one verified backup in the last {status.windowDays} day(s) has {status.verifiedCopies} verified
            copies across {status.storageSystems} storage systems, including {status.offsiteVerifiedCopies} off-site
            copy(ies).
          </Callout>
        ) : status.enabledOffsiteDestinations > 0 || status.autoCopyAfterVerify ? (
          <Callout tone="warning" title="3-2-1 backup policy not yet met" live="polite">
            {status.verifiedArchivesInWindow === 0
              ? `No verified backup exists in the last ${status.windowDays} day(s). Configuration alone does not satisfy 3-2-1 until a backup is verified and copied.`
              : `Recent verified backups satisfy ${[status.threeCopiesMet, status.twoSystemsMet, status.oneOffsiteMet].filter(Boolean).length} of 3 conditions. Assign at least two enabled off-site destinations and copy a verified backup to reach 3 total copies.`}
          </Callout>
        ) : (
          <Callout tone="info" title="Off-site replication is currently disabled">
            Assign and enable cloud storage connections below (or copy a verified backup manually) to establish a 3-2-1
            backup posture.
          </Callout>
        )}

        <ul className="grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="3-2-1 backup conditions">
          <ConditionRow
            met={status.threeCopiesMet}
            title="Three verified copies"
            detail={`${status.verifiedCopies} of 3 required (${status.localVerifiedCopies} local, ${status.offsiteVerifiedCopies} off-site)`}
          />
          <ConditionRow
            met={status.twoSystemsMet}
            title="Two different storage systems"
            detail={`${status.storageSystems} of 2 required (${systemsText})`}
          />
          <ConditionRow
            met={status.oneOffsiteMet}
            title="At least one copy off-site"
            detail={`${status.offsiteVerifiedCopies} verified off-site copy(ies) in ${status.windowDays}-day window`}
          />
        </ul>

        {status.sharedProviderKindWarning ? (
          <Callout tone="warning" title="Shared provider type detected">
            Multiple verified off-site copies use the same storage provider type. Confirm those connections belong to
            separate cloud accounts or independent fault domains.
          </Callout>
        ) : null}

        <Callout tone="info" title="Separate encryption key custody required">
          {status.backupKeySeparateReminder}
        </Callout>
      </div>
    </Section>
  );
}

interface DraftDestination {
  connectionPublicId: string;
  name: string;
  kind: OffsiteDestination["kind"];
  connectionEnabled: boolean;
  connectionStatus: OffsiteDestination["connectionStatus"];
  assigned: boolean;
  enabled: boolean;
  retentionNote: string;
}

export function OffsiteCopiesForm({ config }: { config: OffsiteConfig }) {
  const formKey = JSON.stringify({
    auto: config.autoCopyAfterVerify,
    win: config.windowDays,
    dests: config.destinations.map((d) => [d.connectionPublicId, d.assigned, d.enabled, d.retentionNote]),
  });
  return <OffsiteCopiesFormBody key={formKey} config={config} />;
}

function OffsiteCopiesFormBody({ config }: { config: OffsiteConfig }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const canManageRetention = useCan("backup.retention.manage");
  const canManageStorage = useCan("storage.manage");
  const canManage = canManageRetention && canManageStorage;
  const update = useMutation(trpc.backup.admin.updateOffsiteConfig.mutationOptions());

  const [autoCopy, setAutoCopy] = useState(config.autoCopyAfterVerify);
  const [windowDays, setWindowDays] = useState(String(config.windowDays));
  const [rows, setRows] = useState<DraftDestination[]>(() =>
    config.destinations.map((d) => ({ ...d })),
  );

  const assignedCount = rows.filter((r) => r.assigned).length;
  const parsedWindow = Number.parseInt(windowDays, 10);
  const windowInvalid = !Number.isInteger(parsedWindow) || parsedWindow < 1 || parsedWindow > 90;
  const overLimit = assignedCount > MAX_ASSIGNED;

  const updateRow = (connectionPublicId: string, patch: Partial<DraftDestination>) => {
    setRows((prev) =>
      prev.map((r) => (r.connectionPublicId === connectionPublicId ? { ...r, ...patch } : r)),
    );
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canManage || windowInvalid || overLimit) return;
    try {
      await stepUp.run(
        () =>
          update.mutateAsync({
            autoCopyAfterVerify: autoCopy,
            windowDays: parsedWindow,
            destinations: rows.map((r) => ({
              connectionPublicId: r.connectionPublicId,
              assigned: r.assigned,
              enabled: r.assigned ? r.enabled : false,
              retentionNote: r.retentionNote.trim(),
            })),
          }),
        { reason: "Updating off-site backup destinations requires a fresh confirmation." },
      );
      toast.show({
        title: "Off-site backup settings saved",
        description: "Destination assignments and replication rules have been updated.",
        tone: "success",
      });
      await qc.invalidateQueries(trpc.backup.admin.pathFilter());
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({
        title: "Off-site settings not saved",
        description: errorMessage(error),
        tone: "danger",
      });
    }
  };

  return (
    <Section
      title="Off-site copies"
      description="Select up to eight cloud storage connections to receive verified encrypted .rpbk archives. ReadyPackets never deletes remote copies automatically."
      actions={
        <Button asChild size="sm" variant="secondary">
          <Link href="/admin/storage">Manage storage connections</Link>
        </Button>
      }
    >
      <form className="space-y-5" onSubmit={onSubmit} noValidate>
        <Card className="space-y-4 p-4">
          <Switch
            label="Copy after verification automatically"
            description="When on, every newly verified local backup is queued for upload to all assigned and enabled off-site destinations."
            checked={autoCopy}
            onCheckedChange={setAutoCopy}
            disabled={!canManage}
          />
          <div className="max-w-xs">
            <Field
              label="3-2-1 evaluation window (days)"
              hint="Verified copies must be newer than this window (1 to 90 days) to satisfy the 3-2-1 check."
              error={windowInvalid ? "Enter a whole number between 1 and 90." : undefined}
            >
              <Input
                type="number"
                min={1}
                max={90}
                value={windowDays}
                onChange={(ev) => setWindowDays(ev.target.value)}
                disabled={!canManage}
              />
            </Field>
          </div>
        </Card>

        {rows.length === 0 ? (
          <EmptyState
            icon={HardDrive}
            title="No cloud storage connections configured"
            description="Add an S3, Azure Blob, SharePoint, OneDrive, Google Drive, or Dropbox connection in Storage first, then assign it here."
            headingLevel={3}
          />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
              <span>
                Assigned destinations: <strong className="text-ink">{assignedCount}</strong> of {MAX_ASSIGNED} maximum
              </span>
              {overLimit ? (
                <span className="font-medium text-danger">Select at most {MAX_ASSIGNED} destinations.</span>
              ) : null}
            </div>
            <ul className="space-y-3" aria-label="Available storage connections">
              {rows.map((row) => {
                const disableNewAssign = !row.assigned && assignedCount >= MAX_ASSIGNED;
                return (
                  <li
                    key={row.connectionPublicId}
                    className="rounded-[var(--radius-card)] border border-line bg-surface p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <Checkbox
                        label={
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <span>{row.name}</span>
                            <Badge>{PROVIDER_KIND_LABELS[row.kind] ?? row.kind}</Badge>
                            {!row.connectionEnabled ? (
                              <Badge tone="warning">Connection disabled in Storage</Badge>
                            ) : row.connectionStatus === "ready" ? (
                              <Badge tone="success">Connection ready</Badge>
                            ) : (
                              <Badge tone="warning">{row.connectionStatus}</Badge>
                            )}
                          </span>
                        }
                        description="Assign this connection to purpose: backups."
                        checked={row.assigned}
                        onCheckedChange={(checked) =>
                          updateRow(row.connectionPublicId, {
                            assigned: checked,
                            enabled: checked ? row.enabled || !row.assigned : false,
                          })
                        }
                        disabled={!canManage || disableNewAssign}
                      />
                      {row.assigned ? (
                        <Switch
                          label="Destination active"
                          checked={row.enabled}
                          onCheckedChange={(checked) => updateRow(row.connectionPublicId, { enabled: checked })}
                          disabled={!canManage}
                        />
                      ) : null}
                    </div>
                    {row.assigned ? (
                      <Field
                        label={`Remote retention note for ${row.name} (optional)`}
                        hint="Operator reminder only (for example, S3 Object Lock 90 days). ReadyPackets never deletes remote copies."
                      >
                        <Input
                          value={row.retentionNote}
                          maxLength={240}
                          placeholder="e.g. Bucket lifecycle retains archives for 180 days with Object Lock"
                          onChange={(ev) => updateRow(row.connectionPublicId, { retentionNote: ev.target.value })}
                          disabled={!canManage}
                        />
                      </Field>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <Callout tone="info" title="Remote copies are never deleted by this portal">
          Pruning local backups or unassigning a destination never removes objects already written to your cloud
          storage. Manage remote retention and immutability directly in each storage provider.
        </Callout>

        {canManage && rows.length > 0 ? (
          <div className="flex justify-end">
            <Button type="submit" loading={update.isPending} disabled={windowInvalid || overLimit}>
              Save off-site settings
            </Button>
          </div>
        ) : null}
      </form>
    </Section>
  );
}

export function OffsiteSummaryCell({ copies }: { copies: readonly RemoteCopy[] }) {
  if (copies.length === 0) {
    return <Badge tone="warning">Local copy only</Badge>;
  }
  const completed = copies.filter((c) => c.state === "completed").length;
  const failed = copies.filter((c) => c.state === "failed").length;
  const inFlight = copies.filter((c) => c.state === "queued" || c.state === "running").length;

  return (
    <span className="flex flex-wrap items-center gap-1">
      {completed > 0 ? <Badge tone="success">{`${completed} off-site verified`}</Badge> : null}
      {inFlight > 0 ? <Badge tone="info">{`${inFlight} copying`}</Badge> : null}
      {failed > 0 ? <Badge tone="danger">{`${failed} failed`}</Badge> : null}
    </span>
  );
}

export function DigestBadge({ copy }: { copy: RemoteCopy }) {
  if (copy.state !== "completed") return <span className="text-sm text-muted">—</span>;
  const label = copy.verifiedDigestKind ? (DIGEST_KIND_LABELS[copy.verifiedDigestKind] ?? "Verified") : "Verified";
  return <Badge tone={copy.digestVerified ? "success" : "info"}>{label}</Badge>;
}

export function RemoteCopiesSection({
  archive,
  copies,
  offsiteConfig,
}: {
  archive: Archive;
  copies: readonly RemoteCopy[];
  offsiteConfig: OffsiteConfig | undefined;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const canRun = useCan("backup.run");
  const maintenance = useMaintenance();
  const copyMutation = useMutation(trpc.backup.admin.copyOffsiteNow.mutationOptions());
  const [busyTarget, setBusyTarget] = useState<string | null>(null);

  const canCopyArchive =
    archive.state === "completed" && archive.verificationStatus === "verified" && archive.purgedAt === null;

  const activeEnabledDestinations =
    offsiteConfig?.destinations.filter((d) => d.assigned && d.enabled && d.connectionEnabled) ?? [];

  const copyByConnection = new Map(copies.map((c) => [c.connectionPublicId, c]));
  const uncopiedActiveDestinations = activeEnabledDestinations.filter((d) => {
    const existing = copyByConnection.get(d.connectionPublicId);
    return !existing || existing.state === "failed";
  });

  const triggerCopy = async (connectionPublicId?: string) => {
    const key = connectionPublicId ?? "__all__";
    setBusyTarget(key);
    try {
      const res = await stepUp.run(
        () =>
          copyMutation.mutateAsync({
            backupPublicId: archive.publicId,
            ...(connectionPublicId ? { connectionPublicId } : {}),
          }),
        { reason: "Copying an encrypted backup off-site requires a fresh confirmation." },
      );
      toast.show({
        title: "Off-site copy queued",
        description: `${res.queued.length} destination copy job(s) queued for background transfer.`,
        tone: "success",
      });
      await qc.invalidateQueries(trpc.backup.admin.pathFilter());
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({
        title: "Off-site copy not started",
        description: errorMessage(error),
        tone: "danger",
      });
    } finally {
      setBusyTarget(null);
    }
  };

  return (
    <Section
      title="Off-site copies"
      description="Per-destination transfer status and cryptographic/transport digest verification. Only verified encrypted .rpbk archives are sent; the backup key never leaves this host."
      actions={
        canRun && canCopyArchive && uncopiedActiveDestinations.length > 0 ? (
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<CloudUpload className="size-4" aria-hidden="true" />}
            disabled={maintenance.draining || busyTarget !== null}
            loading={busyTarget === "__all__"}
            onClick={() => triggerCopy()}
          >
            Copy now
          </Button>
        ) : null
      }
    >
      <div className="space-y-4">
        {!canCopyArchive && archive.purgedAt === null ? (
          <Callout tone="info" title="Verify this backup before copying off-site">
            Only backups that have passed local cryptographic and manifest verification can be copied to cloud storage.
          </Callout>
        ) : null}

        <DataTable
          caption="Off-site destination copies"
          rows={copies}
          rowKey={(r) => r.publicId}
          empty={
            <EmptyState
              icon={ShieldAlert}
              title="No off-site copies for this backup"
              description={
                activeEnabledDestinations.length > 0
                  ? "Use Copy now to upload this verified encrypted archive to your enabled off-site destinations."
                  : "Assign and enable cloud storage destinations on the Backups page to copy verified archives off-site."
              }
              headingLevel={3}
            />
          }
          columns={[
            {
              key: "dest",
              header: "Destination",
              primary: true,
              cell: (r) => (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{r.connectionName}</span>
                  <Badge>{PROVIDER_KIND_LABELS[r.providerKind] ?? r.providerKind}</Badge>
                </span>
              ),
            },
            {
              key: "state",
              header: "Status",
              cell: (r) => (
                <span className="flex flex-wrap items-center gap-1">
                  <StatusBadge state={r.state} />
                  {r.reasonCode ? <code className="text-xs break-all">{r.reasonCode}</code> : null}
                </span>
              ),
            },
            {
              key: "digest",
              header: "Digest verification",
              cell: (r) => <DigestBadge copy={r} />,
            },
            {
              key: "bytes",
              header: "Verified size",
              align: "end",
              hideOnMobile: true,
              cell: (r) => formatBytes(r.verifiedBytes) ?? "—",
            },
            {
              key: "attempts",
              header: "Attempts",
              align: "end",
              hideOnMobile: true,
              cell: (r) => r.attemptCount.toLocaleString(),
            },
            {
              key: "when",
              header: "Completed",
              hideOnMobile: true,
              cell: (r) => (r.completedAt ? <DateTime value={r.completedAt} format="datetime" /> : "—"),
            },
          ]}
          rowActions={(r) =>
            canRun && canCopyArchive && r.state === "failed" ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={maintenance.draining || busyTarget !== null}
                loading={busyTarget === r.connectionPublicId}
                onClick={() => triggerCopy(r.connectionPublicId)}
                aria-label={`Retry off-site copy to ${r.connectionName}`}
              >
                Retry
              </Button>
            ) : null
          }
        />

        {canRun &&
        canCopyArchive &&
        activeEnabledDestinations.some((d) => !copyByConnection.has(d.connectionPublicId)) ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-sm text-muted">Copy to individual destination:</span>
            {activeEnabledDestinations
              .filter((d) => !copyByConnection.has(d.connectionPublicId))
              .map((d) => (
                <Button
                  key={d.connectionPublicId}
                  size="sm"
                  variant="ghost"
                  disabled={maintenance.draining || busyTarget !== null}
                  loading={busyTarget === d.connectionPublicId}
                  onClick={() => triggerCopy(d.connectionPublicId)}
                >
                  {`Copy now to ${d.name}`}
                </Button>
              ))}
          </div>
        ) : null}
      </div>
    </Section>
  );
}
