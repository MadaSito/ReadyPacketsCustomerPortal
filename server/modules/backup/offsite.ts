/**
 * Off-site backup copies, per-destination state, 3-2-1 strategy evaluation, and automation triggers
 * (Increment 03, Package L). Owner: recovery_ops_engineer.
 *
 * Security & operational invariants:
 *  1. Shipped disabled by default (`autoCopyAfterVerify: false`, no assigned destinations).
 *  2. Only archives with `state === "completed"`, `verificationStatus === "verified"`, `purgedAt === null`,
 *     a recorded `archiveSha256`, AND an on-disk `RPBK0001` encrypted envelope header are ever streamed off-host.
 *  3. The backup encryption key (`rp_backup_key`) NEVER leaves the host through this module.
 *  4. Remote copies are NEVER deleted by ReadyPackets (neither on retention prune nor on unassignment).
 *  5. Provider `remoteId`, bucket names, paths, URLs, and credentials are NEVER stored, logged, audited, or returned.
 *  6. 3-2-1 compliance is computed strictly from real verified copies within `windowDays`, never from configuration alone.
 */
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { OperationState } from "../../../shared/domain.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { ClaimedJob, DbOrTx, JobResult, ObjectStorage, SessionPrincipal, Tx } from "../../core/types.js";
import {
  registerAutomationTrigger,
  type AutomationTriggerRegistration,
  type TriggerField,
} from "../automations/contracts.js";
import { readSetting, writeSetting } from "../platform/index.js";
import {
  STORAGE_PROVIDER_KINDS,
  type StorageAssignedDestination,
  type StorageModule,
  type StorageProviderKind,
} from "../storage/contracts.js";
import { recordCopyAttempt } from "../storage/copyLogWriter.js";

export type OffsiteConnectionReadiness = "ready" | "untested" | "failed" | "missing_credentials";
import { assertBackupActorInTx, assertBackupPrincipalPrecheck } from "./actorGuard.js";
import { RPBK_MAGIC } from "./crypto.js";
import {
  backupArchives,
  backupRemoteCopies,
  type BackupArchiveRow,
  type BackupRemoteCopyRow,
  type VerifiedDigestKind,
} from "./schema.js";
import { BACKUP_OFFHOST_ENABLED, BACKUP_OFFSITE_POLICY, type StoredBackupOffsitePolicy } from "./settings.js";

export const BACKUP_JOB_REMOTE_COPY = "backup.remote_copy";
export const BACKUP_JOB_REMOTE_SWEEP = "backup.remote_copy.sweep";
export const MAX_BACKUP_DESTINATIONS = 8;

const BACKUP_CAPABLE_KINDS = new Set<string>(STORAGE_PROVIDER_KINDS);

export const BACKUP_KEY_CUSTODY_REMINDER =
  "Only verified encrypted .rpbk archives are copied off-site; the backup encryption key never leaves this host. Keep an independent off-host copy of rp_backup_key so off-site archives remain recoverable if this server is lost.";

export interface BackupRemoteCopySummary {
  publicId: string;
  backupPublicId: string;
  connectionPublicId: string;
  providerKind: StorageProviderKind;
  connectionName: string;
  state: OperationState;
  objectName: string;
  verifiedBytes: number | null;
  archiveSha256: string;
  digestVerified: boolean;
  verifiedDigestKind: VerifiedDigestKind | null;
  attemptCount: number;
  reasonCode: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface OffsiteDestinationOption {
  connectionPublicId: string;
  name: string;
  kind: StorageProviderKind;
  connectionEnabled: boolean;
  connectionStatus: OffsiteConnectionReadiness;
  assigned: boolean;
  enabled: boolean;
  retentionNote: string;
}

export interface Backup321Status {
  windowDays: number;
  evaluatedAt: Date;
  evaluatedArchivePublicId: string | null;
  verifiedArchivesInWindow: number;
  verifiedCopies: number;
  localVerifiedCopies: number;
  offsiteVerifiedCopies: number;
  storageSystems: number;
  storageSystemKinds: readonly string[];
  threeCopiesMet: boolean;
  twoSystemsMet: boolean;
  oneOffsiteMet: boolean;
  overallMet: boolean;
  sharedProviderKindWarning: boolean;
  configuredOffsiteDestinations: number;
  enabledOffsiteDestinations: number;
  autoCopyAfterVerify: boolean;
  backupKeySeparateReminder: string;
}

export interface OffsiteBackupConfigView {
  autoCopyAfterVerify: boolean;
  windowDays: number;
  destinations: readonly OffsiteDestinationOption[];
  status321: Backup321Status;
}

export interface UpdateOffsiteBackupConfigInput {
  autoCopyAfterVerify: boolean;
  windowDays: number;
  destinations: readonly {
    connectionPublicId: string;
    assigned: boolean;
    enabled: boolean;
    retentionNote?: string;
  }[];
}

export interface RemoteCopyJobPayload {
  remoteCopyPublicId: string;
  backupPublicId: string;
  connectionPublicId: string;
}

const ARCHIVE_CONTEXT_FIELDS: readonly TriggerField[] = [
  { key: "backup_public_id", label: "Backup ID", type: "public_id", from: "context" },
  { key: "backup_link", label: "Link to backup", type: "string", from: "context" },
];

const BACKUP_TRIGGER_REGISTRATIONS: readonly AutomationTriggerRegistration[] = (
  [
    "backup.completed",
    "backup.failed",
    "backup.verify_failed",
    "backup.remote_copy_completed",
    "backup.remote_copy_failed",
  ] as const
)
  .map(
    (key): AutomationTriggerRegistration => ({
      key,
      entry: { fields: ARCHIVE_CONTEXT_FIELDS },
      resolveContext: async ({ event }) => {
        const publicId = event.resource?.type === "backup_archive" ? (event.resource.publicId ?? null) : null;
        return {
          fields: {
            backup_public_id: publicId,
            backup_link: publicId ? `/admin/backups/${encodeURIComponent(publicId)}` : "/admin/backups",
          },
        };
      },
    }),
  )
  .concat([{ key: "backup.policy_unmet" }]);

let moduleTriggersRegistered = false;
export function registerBackupAutomationTriggers(deps?: Pick<ModuleDeps, "services">): void {
  if (!moduleTriggersRegistered) {
    for (const reg of BACKUP_TRIGGER_REGISTRATIONS) {
      registerAutomationTrigger(reg);
    }
    moduleTriggersRegistered = true;
  }
  const automations = (
    deps?.services as unknown as {
      automations?: { registerAutomationTrigger?: (r: AutomationTriggerRegistration) => void };
    }
  )?.automations;
  if (automations?.registerAutomationTrigger) {
    for (const reg of BACKUP_TRIGGER_REGISTRATIONS) {
      automations.registerAutomationTrigger(reg);
    }
  }
}

registerBackupAutomationTriggers();

function getStorageModule(deps: Pick<ModuleDeps, "services">): StorageModule | null {
  const candidate = (deps.services as unknown as { storageConnections?: StorageModule | undefined })?.storageConnections;
  return candidate ?? null;
}

function asProviderKind(raw: string): StorageProviderKind {
  return BACKUP_CAPABLE_KINDS.has(raw) ? (raw as StorageProviderKind) : "s3";
}

export function toRemoteCopySummary(row: BackupRemoteCopyRow, backupPublicId: string): BackupRemoteCopySummary {
  return {
    publicId: row.publicId,
    backupPublicId,
    connectionPublicId: row.connectionPublicId,
    providerKind: asProviderKind(row.providerKind),
    connectionName: row.connectionName,
    state: row.state,
    objectName: row.objectName,
    verifiedBytes: row.verifiedBytes,
    archiveSha256: row.archiveSha256,
    digestVerified: row.digestVerified,
    verifiedDigestKind: row.verifiedDigestKind ?? null,
    attemptCount: row.attemptCount,
    reasonCode: row.reasonCode,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadRemoteCopiesByBackupIds(
  db: DbOrTx,
  archives: readonly { id: number; publicId: string }[],
): Promise<Map<number, BackupRemoteCopySummary[]>> {
  const map = new Map<number, BackupRemoteCopySummary[]>();
  if (archives.length === 0) return map;
  const publicIdById = new Map(archives.map((a) => [a.id, a.publicId]));
  let rows: BackupRemoteCopyRow[];
  try {
    rows = await db
      .select()
      .from(backupRemoteCopies)
      .where(
        inArray(
          backupRemoteCopies.backupId,
          archives.map((a) => a.id),
        ),
      )
      .orderBy(backupRemoteCopies.connectionName, backupRemoteCopies.id);
  } catch {
    // Graceful fallback when running under scoped CLI DB credentials (`rp_backup`) without `backup_remote_copies` grant.
    return map;
  }
  for (const row of rows) {
    const backupPublicId = publicIdById.get(row.backupId);
    if (!backupPublicId) continue;
    const existing = map.get(row.backupId) ?? [];
    existing.push(toRemoteCopySummary(row, backupPublicId));
    map.set(row.backupId, existing);
  }
  return map;
}

/**
 * Inspects the first 12 bytes of the stored backup object before opening any remote transfer stream.
 * Guarantees at the wire level that only `RPBK0001` encrypted envelopes can ever be uploaded off-host.
 */
export async function assertStoredObjectHasEncryptedEnvelopeHeader(
  storage: ObjectStorage,
  storageKey: string,
): Promise<void> {
  const stream = await storage.get(storageKey);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buf);
      total += buf.length;
      if (total >= 12) {
        stream.destroy();
        break;
      }
    }
  } finally {
    stream.destroy();
  }
  if (total < 12) {
    throw new DomainError(
      "CONFLICT",
      "UNENCRYPTED_OR_INVALID_ARCHIVE",
      "Backup object is too short to be a valid RPBK0001 encrypted archive.",
    );
  }
  const head = Buffer.concat(chunks, total);
  if (!head.subarray(0, 8).equals(RPBK_MAGIC)) {
    throw new DomainError(
      "CONFLICT",
      "UNENCRYPTED_OR_INVALID_ARCHIVE",
      "Refusing off-site copy: object does not carry the RPBK0001 encrypted archive header.",
    );
  }
  const headerLen = head.readUInt32BE(8);
  if (headerLen < 2 || headerLen > 4096) {
    throw new DomainError(
      "CONFLICT",
      "UNENCRYPTED_OR_INVALID_ARCHIVE",
      "Refusing off-site copy: invalid RPBK0001 encrypted envelope header length.",
    );
  }
}

function isDestinationEnabledInPolicy(policy: StoredBackupOffsitePolicy, connectionPublicId: string): boolean {
  const entry = policy.destinations[connectionPublicId];
  return entry ? entry.enabled : true;
}

async function listActiveEnabledDestinations(
  deps: Pick<ModuleDeps, "services">,
  policy: StoredBackupOffsitePolicy,
  tx?: DbOrTx,
): Promise<StorageAssignedDestination[]> {
  const storageModule = getStorageModule(deps);
  if (!storageModule) return [];
  const assigned = await storageModule.listAssigned("backups", tx);
  return assigned.filter((dest) => isDestinationEnabledInPolicy(policy, dest.connectionPublicId));
}

export async function compute321Status(
  deps: Pick<ModuleDeps, "db" | "clock" | "settings" | "services">,
  policyOverride?: StoredBackupOffsitePolicy,
): Promise<Backup321Status> {
  const evaluatedAt = deps.clock.now();
  const policy = policyOverride ?? (await readSetting(deps.settings, BACKUP_OFFSITE_POLICY));
  const windowDays = Math.min(90, Math.max(1, policy.windowDays));
  const cutoff = new Date(evaluatedAt.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const storageModule = getStorageModule(deps);
  const assignedActive = storageModule ? await storageModule.listAssigned("backups").catch(() => []) : [];
  const configuredOffsiteDestinations = assignedActive.length;
  const enabledOffsiteDestinations = assignedActive.filter((d) =>
    isDestinationEnabledInPolicy(policy, d.connectionPublicId),
  ).length;

  const verifiedArchives = await deps.db
    .select({
      id: backupArchives.id,
      publicId: backupArchives.publicId,
      storageKey: backupArchives.storageKey,
      purgedAt: backupArchives.purgedAt,
      createdAt: backupArchives.createdAt,
    })
    .from(backupArchives)
    .where(
      and(
        eq(backupArchives.state, "completed"),
        eq(backupArchives.verificationStatus, "verified"),
        gte(backupArchives.createdAt, cutoff),
      ),
    )
    .orderBy(desc(backupArchives.createdAt), desc(backupArchives.id))
    .limit(200);

  if (verifiedArchives.length === 0) {
    return {
      windowDays,
      evaluatedAt,
      evaluatedArchivePublicId: null,
      verifiedArchivesInWindow: 0,
      verifiedCopies: 0,
      localVerifiedCopies: 0,
      offsiteVerifiedCopies: 0,
      storageSystems: 0,
      storageSystemKinds: [],
      threeCopiesMet: false,
      twoSystemsMet: false,
      oneOffsiteMet: false,
      overallMet: false,
      sharedProviderKindWarning: false,
      configuredOffsiteDestinations,
      enabledOffsiteDestinations,
      autoCopyAfterVerify: policy.autoCopyAfterVerify,
      backupKeySeparateReminder: BACKUP_KEY_CUSTODY_REMINDER,
    };
  }

  const copyRows = await deps.db
    .select({
      backupId: backupRemoteCopies.backupId,
      providerKind: backupRemoteCopies.providerKind,
      state: backupRemoteCopies.state,
    })
    .from(backupRemoteCopies)
    .where(
      and(
        inArray(
          backupRemoteCopies.backupId,
          verifiedArchives.map((a) => a.id),
        ),
        eq(backupRemoteCopies.state, "completed"),
      ),
    );

  const completedByBackupId = new Map<number, string[]>();
  for (const row of copyRows) {
    const list = completedByBackupId.get(row.backupId) ?? [];
    list.push(row.providerKind);
    completedByBackupId.set(row.backupId, list);
  }

  interface CandidateScore {
    publicId: string;
    localCopies: number;
    offsiteCopies: number;
    totalCopies: number;
    systemKinds: string[];
    conditionsMetCount: number;
    sharedKind: boolean;
  }

  let best: CandidateScore | null = null;
  for (const archive of verifiedArchives) {
    const localCopies = archive.purgedAt === null && archive.storageKey !== null ? 1 : 0;
    const remoteKinds = completedByBackupId.get(archive.id) ?? [];
    const offsiteCopies = remoteKinds.length;
    const totalCopies = localCopies + offsiteCopies;
    const systemsSet = new Set<string>();
    if (localCopies > 0) systemsSet.add("local_disk");
    for (const kind of remoteKinds) systemsSet.add(kind);

    const distinctRemoteKinds = new Set(remoteKinds);
    const sharedKind = remoteKinds.length > 1 && distinctRemoteKinds.size < remoteKinds.length;

    const threeMet = totalCopies >= 3;
    const twoMet = systemsSet.size >= 2;
    const oneMet = offsiteCopies >= 1;
    const conditionsMetCount = (threeMet ? 1 : 0) + (twoMet ? 1 : 0) + (oneMet ? 1 : 0);

    const candidate: CandidateScore = {
      publicId: archive.publicId,
      localCopies,
      offsiteCopies,
      totalCopies,
      systemKinds: [...systemsSet],
      conditionsMetCount,
      sharedKind,
    };

    if (
      !best ||
      candidate.conditionsMetCount > best.conditionsMetCount ||
      (candidate.conditionsMetCount === best.conditionsMetCount && candidate.totalCopies > best.totalCopies)
    ) {
      best = candidate;
    }
  }

  const chosen = best!;
  const threeCopiesMet = chosen.totalCopies >= 3;
  const twoSystemsMet = chosen.systemKinds.length >= 2;
  const oneOffsiteMet = chosen.offsiteCopies >= 1;

  return {
    windowDays,
    evaluatedAt,
    evaluatedArchivePublicId: chosen.publicId,
    verifiedArchivesInWindow: verifiedArchives.length,
    verifiedCopies: chosen.totalCopies,
    localVerifiedCopies: chosen.localCopies,
    offsiteVerifiedCopies: chosen.offsiteCopies,
    storageSystems: chosen.systemKinds.length,
    storageSystemKinds: chosen.systemKinds,
    threeCopiesMet,
    twoSystemsMet,
    oneOffsiteMet,
    overallMet: threeCopiesMet && twoSystemsMet && oneOffsiteMet,
    sharedProviderKindWarning: chosen.sharedKind,
    configuredOffsiteDestinations,
    enabledOffsiteDestinations,
    autoCopyAfterVerify: policy.autoCopyAfterVerify,
    backupKeySeparateReminder: BACKUP_KEY_CUSTODY_REMINDER,
  };
}

export async function evaluateAndRecordPolicyTransition(
  deps: Pick<ModuleDeps, "db" | "clock" | "settings" | "audit" | "services">,
  correlationId?: string,
): Promise<Backup321Status> {
  const policy = await readSetting(deps.settings, BACKUP_OFFSITE_POLICY);
  const status = await compute321Status(deps, policy);
  const policyActive = policy.autoCopyAfterVerify || status.enabledOffsiteDestinations > 0;
  if (!policyActive) {
    if (policy.lastPolicyUnmetSignaled) {
      await writeSetting(deps.settings, BACKUP_OFFSITE_POLICY, { ...policy, lastPolicyUnmetSignaled: false });
    }
    return status;
  }

  if (!status.overallMet && !policy.lastPolicyUnmetSignaled) {
    await deps.db.transaction(async (tx) => {
      const freshPolicy = await readSetting(deps.settings, BACKUP_OFFSITE_POLICY, tx);
      if (freshPolicy.lastPolicyUnmetSignaled) return;
      await writeSetting(deps.settings, BACKUP_OFFSITE_POLICY, { ...freshPolicy, lastPolicyUnmetSignaled: true }, tx);
      await deps.audit.record(
        {
          category: "backup",
          eventName: "backup.policy.unmet",
          action: "evaluate",
          outcome: "failed",
          severity: "WARN",
          reasonCode: "BACKUP_321_NOT_MET",
          actor: { role: "system" },
          resource: { type: "backup_policy" },
          ...(correlationId ? { correlationId } : {}),
          safeCounts: {
            verified_copies: status.verifiedCopies,
            storage_systems: status.storageSystems,
            offsite_copies: status.offsiteVerifiedCopies,
            window_days: status.windowDays,
          },
          attributes: {
            three_copies_met: status.threeCopiesMet,
            two_systems_met: status.twoSystemsMet,
            one_offsite_met: status.oneOffsiteMet,
          },
        },
        tx,
      );
    });
  } else if (status.overallMet && policy.lastPolicyUnmetSignaled) {
    await writeSetting(deps.settings, BACKUP_OFFSITE_POLICY, { ...policy, lastPolicyUnmetSignaled: false });
  }
  return status;
}

export async function getOffsiteBackupConfig(
  deps: Pick<ModuleDeps, "db" | "clock" | "settings" | "services">,
  principal: SessionPrincipal,
): Promise<OffsiteBackupConfigView> {
  const now = deps.clock.now();
  assertBackupPrincipalPrecheck(principal, "backup.read", now);

  const policy = await readSetting(deps.settings, BACKUP_OFFSITE_POLICY);
  const storageModule = getStorageModule(deps);
  let destinations: OffsiteDestinationOption[] = [];

  if (storageModule) {
    const [connectionsPage, assignments] = await Promise.all([
      storageModule.connections.list(principal, { limit: 50 }),
      storageModule.assignments.list(principal),
    ]);
    const assignedSet = new Set(
      assignments.filter((a) => a.purpose === "backups").map((a) => a.connectionPublicId),
    );

    destinations = connectionsPage.items
      .filter((conn) => BACKUP_CAPABLE_KINDS.has(conn.kind))
      .map((conn) => {
        const assigned = assignedSet.has(conn.publicId);
        const policyEntry = policy.destinations[conn.publicId];
        const connectionStatus: OffsiteConnectionReadiness =
          !conn.credentialsConfigured && !conn.oauthConnected
            ? "missing_credentials"
            : conn.lastTest
              ? conn.lastTest.ok
                ? "ready"
                : "failed"
              : "untested";
        return {
          connectionPublicId: conn.publicId,
          name: conn.name,
          kind: conn.kind,
          connectionEnabled: conn.enabled,
          connectionStatus,
          assigned,
          enabled: policyEntry ? policyEntry.enabled : assigned,
          retentionNote: policyEntry?.retentionNote ?? "",
        };
      });
  }

  const status321 = await compute321Status(deps, policy);
  return {
    autoCopyAfterVerify: policy.autoCopyAfterVerify,
    windowDays: policy.windowDays,
    destinations,
    status321,
  };
}

export async function updateOffsiteBackupConfig(
  deps: Pick<ModuleDeps, "db" | "clock" | "settings" | "audit" | "services">,
  principal: SessionPrincipal,
  input: UpdateOffsiteBackupConfigInput,
): Promise<OffsiteBackupConfigView> {
  const now = deps.clock.now();
  assertBackupPrincipalPrecheck(principal, "backup.retention.manage", now);
  assertBackupPrincipalPrecheck(principal, "storage.manage", now);

  const storageModule = getStorageModule(deps);
  if (!storageModule) {
    throw new DomainError(
      "UNAVAILABLE",
      "STORAGE_MODULE_UNAVAILABLE",
      "Cloud storage connections are not available in this runtime.",
    );
  }

  const seen = new Set<string>();
  const assignedIds: string[] = [];
  const nextDestinations: Record<string, { enabled: boolean; retentionNote: string }> = {};

  for (const item of input.destinations) {
    if (seen.has(item.connectionPublicId)) {
      throw validation("DUPLICATE_DESTINATION", "Each storage connection may appear at most once.");
    }
    seen.add(item.connectionPublicId);
    const trimmedNote = (item.retentionNote ?? "").trim();
    if (trimmedNote.length > 240) {
      throw validation("RETENTION_NOTE_TOO_LONG", "Remote retention notes must be 240 characters or fewer.");
    }
    if (item.assigned) {
      assignedIds.push(item.connectionPublicId);
    }
    if (item.assigned || trimmedNote.length > 0 || !item.enabled) {
      nextDestinations[item.connectionPublicId] = {
        enabled: item.assigned ? item.enabled : false,
        retentionNote: trimmedNote,
      };
    }
  }

  if (assignedIds.length > MAX_BACKUP_DESTINATIONS) {
    throw validation(
      "TOO_MANY_DESTINATIONS",
      `At most ${String(MAX_BACKUP_DESTINATIONS)} off-site backup destinations may be assigned.`,
    );
  }

  // Update the storage `backups` purpose assignment first (enforces live step-up, provider capability, and max 8).
  await storageModule.assignments.set(principal, {
    purpose: "backups",
    connectionPublicIds: assignedIds,
  });

  const enabledCount = assignedIds.filter((id) => nextDestinations[id]?.enabled !== false).length;

  await deps.db.transaction(async (tx) => {
    await assertBackupActorInTx(deps.services, deps.clock, principal, "backup.retention.manage", tx);
    const existing = await readSetting(deps.settings, BACKUP_OFFSITE_POLICY, tx);
    const nextPolicy: StoredBackupOffsitePolicy = {
      autoCopyAfterVerify: input.autoCopyAfterVerify,
      windowDays: input.windowDays,
      destinations: nextDestinations,
      lastPolicyUnmetSignaled: existing.lastPolicyUnmetSignaled ?? false,
    };
    await writeSetting(deps.settings, BACKUP_OFFSITE_POLICY, nextPolicy, tx);
    await deps.settings.set(BACKUP_OFFHOST_ENABLED.key, input.autoCopyAfterVerify && enabledCount > 0, tx);
    await deps.audit.record(
      {
        category: "backup",
        eventName: "backup.offsite_policy.updated",
        action: "configure",
        outcome: "completed",
        severity: "INFO",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "backup_policy" },
        safeCounts: {
          assigned_destinations: assignedIds.length,
          enabled_destinations: enabledCount,
          window_days: input.windowDays,
        },
        attributes: {
          auto_copy_after_verify: input.autoCopyAfterVerify,
        },
      },
      tx,
    );
  });

  return getOffsiteBackupConfig(deps, principal);
}

async function stageCopiesInTx(
  deps: Pick<ModuleDeps, "clock" | "jobs" | "audit">,
  tx: Tx,
  archive: Pick<
    BackupArchiveRow,
    "id" | "publicId" | "state" | "verificationStatus" | "purgedAt" | "storageKey" | "archiveSha256" | "encryptedSizeBytes"
  >,
  destinations: readonly StorageAssignedDestination[],
  options: { correlationId: string; allowRetryCompleted?: boolean },
): Promise<BackupRemoteCopySummary[]> {
  if (
    archive.state !== "completed" ||
    archive.verificationStatus !== "verified" ||
    archive.purgedAt !== null ||
    !archive.storageKey ||
    !archive.archiveSha256 ||
    archive.encryptedSizeBytes === null
  ) {
    throw conflict("ARCHIVE_NOT_VERIFIED", "Only verified, unpurged encrypted local backups can be copied off-site.");
  }

  const now = deps.clock.now();
  const objectName = `readypackets-backup-${archive.publicId}.rpbk`;
  const existingRows = await tx
    .select()
    .from(backupRemoteCopies)
    .where(eq(backupRemoteCopies.backupId, archive.id))
    .for("update");
  const existingByConn = new Map(existingRows.map((r) => [r.connectionPublicId, r]));

  const staged: BackupRemoteCopySummary[] = [];
  for (const dest of destinations) {
    const existing = existingByConn.get(dest.connectionPublicId);
    if (existing) {
      if (existing.state === "completed" && !options.allowRetryCompleted) {
        staged.push(toRemoteCopySummary(existing, archive.publicId));
        continue;
      }
      if (existing.state === "queued" || existing.state === "running") {
        staged.push(toRemoteCopySummary(existing, archive.publicId));
        continue;
      }
      const idempotencyKey = `backup-remote:${existing.publicId}:attempt:${String(existing.attemptCount + 1)}`;
      const enqueued = await deps.jobs.enqueue(
        BACKUP_JOB_REMOTE_COPY,
        {
          remoteCopyPublicId: existing.publicId,
          backupPublicId: archive.publicId,
          connectionPublicId: dest.connectionPublicId,
        } satisfies RemoteCopyJobPayload,
        { idempotencyKey, correlationId: options.correlationId },
        tx,
      );
      await recordCopyAttempt(
        deps,
        {
          kind: "backup_archive",
          sourcePublicId: archive.publicId,
          connectionPublicId: dest.connectionPublicId,
          jobPublicId: enqueued.jobId,
          attempt: 1,
          correlationId: options.correlationId,
          bytes: archive.encryptedSizeBytes,
          phase: "queued",
        },
        tx,
      );
      await tx
        .update(backupRemoteCopies)
        .set({
          providerKind: dest.kind,
          connectionName: dest.name,
          destinationVersion: dest.destinationVersion,
          state: "queued",
          objectName,
          archiveSha256: archive.archiveSha256,
          jobPublicId: enqueued.jobId,
          reasonCode: null,
          updatedAt: now,
        })
        .where(eq(backupRemoteCopies.id, existing.id));
      const [updated] = await tx
        .select()
        .from(backupRemoteCopies)
        .where(eq(backupRemoteCopies.id, existing.id))
        .limit(1);
      if (updated) staged.push(toRemoteCopySummary(updated, archive.publicId));
      continue;
    }

    const remoteCopyPublicId = ulid(now.getTime());
    const idempotencyKey = `backup-remote:${remoteCopyPublicId}:attempt:1`;
    const enqueued = await deps.jobs.enqueue(
      BACKUP_JOB_REMOTE_COPY,
      {
        remoteCopyPublicId,
        backupPublicId: archive.publicId,
        connectionPublicId: dest.connectionPublicId,
      } satisfies RemoteCopyJobPayload,
      { idempotencyKey, correlationId: options.correlationId },
      tx,
    );
    await recordCopyAttempt(
      deps,
      {
        kind: "backup_archive",
        sourcePublicId: archive.publicId,
        connectionPublicId: dest.connectionPublicId,
        jobPublicId: enqueued.jobId,
        attempt: 1,
        correlationId: options.correlationId,
        bytes: archive.encryptedSizeBytes,
        phase: "queued",
      },
      tx,
    );
    await tx.insert(backupRemoteCopies).values({
      publicId: remoteCopyPublicId,
      backupId: archive.id,
      connectionPublicId: dest.connectionPublicId,
      providerKind: dest.kind,
      connectionName: dest.name,
      destinationVersion: dest.destinationVersion,
      state: "queued",
      objectName,
      verifiedBytes: null,
      archiveSha256: archive.archiveSha256,
      digestVerified: false,
      verifiedDigestKind: null,
      attemptCount: 0,
      jobPublicId: enqueued.jobId,
      reasonCode: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const [inserted] = await tx
      .select()
      .from(backupRemoteCopies)
      .where(eq(backupRemoteCopies.publicId, remoteCopyPublicId))
      .limit(1);
    if (inserted) staged.push(toRemoteCopySummary(inserted, archive.publicId));
  }

  return staged;
}

/**
 * Invoked after `verifyBackupDirect` succeeds when running in the application/worker container (`rp_app`).
 * No-op in standalone `run-backup.js` CLI (`storageConnections` absent), where the worker sweep picks up verified rows.
 */
export async function maybeStageAutomaticOffsiteCopies(
  deps: Pick<ModuleDeps, "db" | "clock" | "settings" | "jobs" | "audit" | "services" | "logger">,
  backupPublicId: string,
  correlationId: string,
): Promise<void> {
  if (!getStorageModule(deps)) return;
  const policy = await readSetting(deps.settings, BACKUP_OFFSITE_POLICY);
  if (!policy.autoCopyAfterVerify) return;

  const activeDestinations = await listActiveEnabledDestinations(deps, policy);
  if (activeDestinations.length === 0) return;

  await deps.db.transaction(async (tx) => {
    const [archive] = await tx
      .select()
      .from(backupArchives)
      .where(eq(backupArchives.publicId, backupPublicId))
      .limit(1)
      .for("update");
    if (
      !archive ||
      archive.state !== "completed" ||
      archive.verificationStatus !== "verified" ||
      archive.purgedAt !== null ||
      !archive.storageKey ||
      !archive.archiveSha256
    ) {
      return;
    }
    await stageCopiesInTx(deps, tx, archive, activeDestinations, { correlationId });
  });
}

export async function mayRetryBackupOffsiteCopy(
  deps: Pick<ModuleDeps, "settings" | "services">,
  input: { backupPublicId: string; connectionPublicId: string; jobPublicId: string },
  tx: Tx,
): Promise<boolean> {
  if (!getStorageModule(deps)) return false;
  const policy = await readSetting(deps.settings, BACKUP_OFFSITE_POLICY, tx);
  const activeEnabled = await listActiveEnabledDestinations(deps, policy, tx);
  if (!activeEnabled.some((d) => d.connectionPublicId === input.connectionPublicId)) {
    return false;
  }

  const [archive] = await tx
    .select({
      id: backupArchives.id,
      state: backupArchives.state,
      verificationStatus: backupArchives.verificationStatus,
      purgedAt: backupArchives.purgedAt,
      storageKey: backupArchives.storageKey,
      archiveSha256: backupArchives.archiveSha256,
      encryptedSizeBytes: backupArchives.encryptedSizeBytes,
    })
    .from(backupArchives)
    .where(eq(backupArchives.publicId, input.backupPublicId))
    .limit(1);
  if (
    !archive ||
    archive.state !== "completed" ||
    archive.verificationStatus !== "verified" ||
    archive.purgedAt !== null ||
    !archive.storageKey ||
    !archive.archiveSha256 ||
    archive.encryptedSizeBytes === null
  ) {
    return false;
  }

  const [copyRow] = await tx
    .select({
      state: backupRemoteCopies.state,
      jobPublicId: backupRemoteCopies.jobPublicId,
    })
    .from(backupRemoteCopies)
    .where(
      and(
        eq(backupRemoteCopies.backupId, archive.id),
        eq(backupRemoteCopies.connectionPublicId, input.connectionPublicId),
      ),
    )
    .limit(1);

  return Boolean(copyRow && copyRow.state === "failed" && copyRow.jobPublicId === input.jobPublicId);
}

export async function copyBackupOffsiteNow(
  deps: Pick<ModuleDeps, "db" | "clock" | "settings" | "jobs" | "audit" | "services">,
  isMaintenanceDraining: () => Promise<boolean>,
  principal: SessionPrincipal,
  input: { backupPublicId: string; connectionPublicId?: string; expectedFailedJobId?: string },
): Promise<{ queued: BackupRemoteCopySummary[] }> {
  const now = deps.clock.now();
  assertBackupPrincipalPrecheck(principal, "backup.run", now);
  if (input.expectedFailedJobId !== undefined && !input.connectionPublicId) {
    throw validation("CONNECTION_REQUIRED", "A specific destination is required when retrying a failed copy attempt.");
  }
  if (await isMaintenanceDraining()) {
    throw new DomainError(
      "MAINTENANCE",
      "MAINTENANCE_DRAINING",
      "Off-site backup copies cannot be started while maintenance is draining.",
    );
  }

  const storageModule = getStorageModule(deps);
  if (!storageModule) {
    throw new DomainError(
      "UNAVAILABLE",
      "STORAGE_MODULE_UNAVAILABLE",
      "Cloud storage connections are not available in this runtime.",
    );
  }

  const policy = await readSetting(deps.settings, BACKUP_OFFSITE_POLICY);
  const activeEnabled = await listActiveEnabledDestinations(deps, policy);

  let targetDestinations: StorageAssignedDestination[];
  if (input.connectionPublicId) {
    const match = activeEnabled.find((d) => d.connectionPublicId === input.connectionPublicId);
    if (!match) {
      throw conflict(
        "DESTINATION_NOT_ACTIVE",
        "The selected storage destination is not currently assigned and enabled for off-site backups.",
      );
    }
    targetDestinations = [match];
  } else {
    if (activeEnabled.length === 0) {
      throw conflict(
        "NO_ACTIVE_OFFSITE_DESTINATIONS",
        "Assign and enable at least one off-site backup destination before copying.",
      );
    }
    targetDestinations = activeEnabled;
  }

  const correlationId = getRequestContext()?.correlationId ?? ulid(now.getTime());
  const staged = await deps.db.transaction(async (tx) => {
    await assertBackupActorInTx(deps.services, deps.clock, principal, "backup.run", tx);
    const [archive] = await tx
      .select()
      .from(backupArchives)
      .where(eq(backupArchives.publicId, input.backupPublicId))
      .limit(1)
      .for("update");
    if (!archive || archive.purgedAt !== null) {
      throw notFound("BACKUP_NOT_FOUND");
    }
    if (
      archive.state !== "completed" ||
      archive.verificationStatus !== "verified" ||
      !archive.storageKey ||
      !archive.archiveSha256 ||
      archive.encryptedSizeBytes === null
    ) {
      throw conflict("ARCHIVE_NOT_VERIFIED", "Verify the encrypted local backup before copying it off-site.");
    }

    if (input.connectionPublicId) {
      const [existing] = await tx
        .select({ state: backupRemoteCopies.state, jobPublicId: backupRemoteCopies.jobPublicId })
        .from(backupRemoteCopies)
        .where(
          and(
            eq(backupRemoteCopies.backupId, archive.id),
            eq(backupRemoteCopies.connectionPublicId, input.connectionPublicId),
          ),
        )
        .limit(1)
        .for("update");
      if (existing?.state === "completed") {
        throw conflict(
          "REMOTE_COPY_ALREADY_COMPLETED",
          "This verified backup has already been copied and digest-verified at that destination.",
        );
      }
      if (input.expectedFailedJobId !== undefined) {
        if (!existing || existing.state !== "failed" || existing.jobPublicId !== input.expectedFailedJobId) {
          throw conflict(
            "COPY_RETRY_STALE",
            "That failed copy attempt is no longer the latest retryable state for this destination.",
          );
        }
      }
    }

    const rows = await stageCopiesInTx(deps, tx, archive, targetDestinations, { correlationId });
    await deps.audit.record(
      {
        category: "backup",
        eventName: "backup.remote_copy.queued",
        action: "enqueue",
        outcome: "completed",
        severity: "INFO",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "backup_archive", publicId: archive.publicId },
        correlationId,
        safeCounts: { destinations: rows.length },
        ...(input.connectionPublicId ? { attributes: { connection_public_id: input.connectionPublicId } } : {}),
      },
      tx,
    );
    return rows;
  });

  return { queued: staged };
}

export async function executeRemoteCopyJob(
  deps: Pick<ModuleDeps, "config" | "db" | "clock" | "settings" | "storage" | "audit" | "logger" | "services">,
  isMaintenanceDraining: () => Promise<boolean>,
  isJobLeaseLostError: (err: unknown) => boolean,
  job: ClaimedJob<RemoteCopyJobPayload>,
): Promise<JobResult> {
  if (await isMaintenanceDraining()) {
    return { outcome: "canceled", reasonCode: "MAINTENANCE_DRAINING" };
  }

  const storageModule = getStorageModule(deps);
  if (!storageModule) {
    return { outcome: "failed", reasonCode: "STORAGE_MODULE_UNAVAILABLE", retryable: false };
  }

  const payload = job.payload;
  if (!payload?.remoteCopyPublicId || !payload.backupPublicId || !payload.connectionPublicId) {
    return { outcome: "failed", reasonCode: "INVALID_JOB_PAYLOAD", retryable: false };
  }

  let copyId = 0;
  let attemptNumber = 1;
  let storageKey = "";
  let archivePublicId = payload.backupPublicId;
  let archiveId = 0;
  let expectedSize = 0;
  let expectedSha256 = "";
  let objectName = "";
  let destinationVersion = 1;

  try {
    const policy = await readSetting(deps.settings, BACKUP_OFFSITE_POLICY);
    const activeDestinations = await listActiveEnabledDestinations(deps, policy);
    const liveDest = activeDestinations.find((d) => d.connectionPublicId === payload.connectionPublicId);

    const preflight = await deps.db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      const [copyRow] = await tx
        .select()
        .from(backupRemoteCopies)
        .where(eq(backupRemoteCopies.publicId, payload.remoteCopyPublicId))
        .limit(1)
        .for("update");
      if (!copyRow) {
        await recordCopyAttempt(
          deps,
          {
            kind: "backup_archive",
            sourcePublicId: payload.backupPublicId,
            connectionPublicId: payload.connectionPublicId,
            jobPublicId: job.jobId,
            attempt: job.attempt,
            correlationId: job.correlationId,
            phase: "finished",
            result: "not_written",
            errorCode: "REMOTE_COPY_MISSING",
          },
          tx,
        );
        return { status: "missing" as const };
      }
      if (copyRow.state === "completed") {
        await recordCopyAttempt(
          deps,
          {
            kind: "backup_archive",
            sourcePublicId: payload.backupPublicId,
            connectionPublicId: copyRow.connectionPublicId,
            jobPublicId: job.jobId,
            attempt: job.attempt,
            correlationId: job.correlationId,
            bytes: copyRow.verifiedBytes,
            phase: "finished",
            result: "not_written",
            errorCode: "ALREADY_COMPLETED",
          },
          tx,
        );
        return { status: "already_completed" as const, size: copyRow.verifiedBytes ?? 0 };
      }

      const [archive] = await tx
        .select()
        .from(backupArchives)
        .where(eq(backupArchives.id, copyRow.backupId))
        .limit(1)
        .for("update");

      copyId = copyRow.id;
      archiveId = copyRow.backupId;
      archivePublicId = archive?.publicId ?? payload.backupPublicId;
      attemptNumber = copyRow.attemptCount + 1;

      if (!liveDest) {
        const failNow = deps.clock.now();
        await tx
          .update(backupRemoteCopies)
          .set({
            state: "failed",
            attemptCount: attemptNumber,
            reasonCode: "DESTINATION_NOT_ACTIVE",
            completedAt: failNow,
            updatedAt: failNow,
          })
          .where(eq(backupRemoteCopies.id, copyRow.id));
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.remote_copy.failed",
            action: "replicate",
            outcome: "failed",
            severity: "ERROR",
            reasonCode: "DESTINATION_NOT_ACTIVE",
            actor: { role: "system" },
            resource: { type: "backup_archive", publicId: archivePublicId },
            correlationId: job.correlationId,
            attributes: { connection_public_id: copyRow.connectionPublicId },
            safeCounts: { attempt_count: attemptNumber },
          },
          tx,
        );
        await recordCopyAttempt(
          deps,
          {
            kind: "backup_archive",
            sourcePublicId: archivePublicId,
            connectionPublicId: copyRow.connectionPublicId,
            jobPublicId: job.jobId,
            attempt: job.attempt,
            correlationId: job.correlationId,
            bytes: archive?.encryptedSizeBytes ?? null,
            phase: "finished",
            result: "not_written",
            errorCode: "DESTINATION_NOT_ACTIVE",
            alreadyAudited: true,
          },
          tx,
        );
        return { status: "inactive" as const };
      }

      if (
        !archive ||
        archive.state !== "completed" ||
        archive.verificationStatus !== "verified" ||
        archive.purgedAt !== null ||
        !archive.storageKey ||
        !archive.archiveSha256 ||
        archive.encryptedSizeBytes === null
      ) {
        const failNow = deps.clock.now();
        const reason = !archive || archive.purgedAt !== null ? "ARCHIVE_PURGED_OR_MISSING" : "ARCHIVE_NOT_VERIFIED";
        await tx
          .update(backupRemoteCopies)
          .set({
            state: "failed",
            attemptCount: attemptNumber,
            reasonCode: reason,
            completedAt: failNow,
            updatedAt: failNow,
          })
          .where(eq(backupRemoteCopies.id, copyRow.id));
        await deps.audit.record(
          {
            category: "backup",
            eventName: "backup.remote_copy.failed",
            action: "replicate",
            outcome: "failed",
            severity: "ERROR",
            reasonCode: reason,
            actor: { role: "system" },
            resource: { type: "backup_archive", publicId: archivePublicId },
            correlationId: job.correlationId,
            attributes: { connection_public_id: copyRow.connectionPublicId },
            safeCounts: { attempt_count: attemptNumber },
          },
          tx,
        );
        await recordCopyAttempt(
          deps,
          {
            kind: "backup_archive",
            sourcePublicId: archivePublicId,
            connectionPublicId: copyRow.connectionPublicId,
            jobPublicId: job.jobId,
            attempt: job.attempt,
            correlationId: job.correlationId,
            bytes: archive?.encryptedSizeBytes ?? null,
            phase: "finished",
            result: "not_written",
            errorCode: reason,
            alreadyAudited: true,
          },
          tx,
        );
        return { status: "unverified" as const, reason };
      }

      const startedAt = deps.clock.now();
      storageKey = archive.storageKey;
      expectedSize = archive.encryptedSizeBytes;
      expectedSha256 = archive.archiveSha256;
      objectName = copyRow.objectName;
      destinationVersion = liveDest.destinationVersion;

      await tx
        .update(backupRemoteCopies)
        .set({
          providerKind: liveDest.kind,
          connectionName: liveDest.name,
          destinationVersion,
          state: "running",
          attemptCount: attemptNumber,
          reasonCode: null,
          startedAt,
          updatedAt: startedAt,
        })
        .where(eq(backupRemoteCopies.id, copyRow.id));
      await recordCopyAttempt(
        deps,
        {
          kind: "backup_archive",
          sourcePublicId: archivePublicId,
          connectionPublicId: copyRow.connectionPublicId,
          jobPublicId: job.jobId,
          attempt: job.attempt,
          correlationId: job.correlationId,
          bytes: expectedSize,
          phase: "started",
        },
        tx,
      );

      return { status: "ready" as const };
    });

    if (preflight.status === "missing") {
      return { outcome: "completed", safeCounts: { skipped_missing: 1 } };
    }
    if (preflight.status === "already_completed") {
      return { outcome: "completed", safeCounts: { verified_bytes: preflight.size } };
    }
    if (preflight.status === "inactive") {
      await evaluateAndRecordPolicyTransition(deps, job.correlationId);
      return { outcome: "failed", reasonCode: "DESTINATION_NOT_ACTIVE", retryable: false };
    }
    if (preflight.status === "unverified") {
      await evaluateAndRecordPolicyTransition(deps, job.correlationId);
      return { outcome: "failed", reasonCode: preflight.reason, retryable: false };
    }

    // Wire-level encryption gate: verify RPBK0001 magic bytes on disk BEFORE opening transfer stream!
    await assertStoredObjectHasEncryptedEnvelopeHeader(deps.storage, storageKey);

    const bodyStream = await deps.storage.get(storageKey);
    let putResult;
    try {
      putResult = await storageModule.copy({
        purpose: "backups",
        connectionPublicId: payload.connectionPublicId,
        expectedDestinationVersion: destinationVersion,
        path: ["backups", deps.config.installationId],
        name: objectName,
        size: expectedSize,
        sha256: expectedSha256,
        contentType: "application/octet-stream",
        body: bodyStream,
        signal: job.signal,
        correlationId: job.correlationId,
        assertStillOwned: (tx) => job.assertStillOwned(tx),
        assertSourceCurrent: async (tx) => {
          const [liveArchive] = await tx
            .select({
              state: backupArchives.state,
              verificationStatus: backupArchives.verificationStatus,
              purgedAt: backupArchives.purgedAt,
              archiveSha256: backupArchives.archiveSha256,
              encryptedSizeBytes: backupArchives.encryptedSizeBytes,
            })
            .from(backupArchives)
            .where(eq(backupArchives.id, archiveId))
            .limit(1);
          if (
            !liveArchive ||
            liveArchive.state !== "completed" ||
            liveArchive.verificationStatus !== "verified" ||
            liveArchive.purgedAt !== null ||
            liveArchive.archiveSha256 !== expectedSha256 ||
            liveArchive.encryptedSizeBytes !== expectedSize
          ) {
            throw conflict("ARCHIVE_SOURCE_CHANGED", "Backup source state changed before off-site transfer.");
          }
        },
      });
    } catch (err) {
      bodyStream.destroy();
      throw err;
    }

    if (
      putResult.size !== expectedSize ||
      (putResult.sha256 !== undefined && putResult.sha256.toLowerCase() !== expectedSha256.toLowerCase())
    ) {
      throw new DomainError(
        "UNAVAILABLE",
        "STORAGE_INTEGRITY_MISMATCH",
        "Remote destination reported a size or SHA-256 mismatch for the encrypted backup archive.",
      );
    }

    const verifiedDigestKind: VerifiedDigestKind = putResult.sha256
      ? "sha256"
      : (putResult.verifiedTransportDigest ?? "size_only");
    const digestVerified = Boolean(putResult.sha256 || putResult.verifiedTransportDigest);
    const completedAt = deps.clock.now();

    await deps.db.transaction(async (tx) => {
      await job.assertStillOwned(tx);
      await tx
        .update(backupRemoteCopies)
        .set({
          state: "completed",
          verifiedBytes: putResult.size,
          digestVerified,
          verifiedDigestKind,
          reasonCode: null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(backupRemoteCopies.id, copyId));

      await deps.audit.record(
        {
          category: "backup",
          eventName: "backup.remote_copy.completed",
          action: "replicate",
          outcome: "completed",
          severity: "INFO",
          reasonCode: "BACKUP_REMOTE_COPY_COMPLETED",
          actor: { role: "system" },
          resource: { type: "backup_archive", publicId: archivePublicId },
          correlationId: job.correlationId,
          attributes: {
            connection_public_id: payload.connectionPublicId,
            digest_verified: digestVerified,
            digest_kind: verifiedDigestKind,
          },
          safeCounts: {
            verified_bytes: putResult.size,
            attempt_count: attemptNumber,
          },
        },
        tx,
      );
      await recordCopyAttempt(
        deps,
        digestVerified
          ? {
              kind: "backup_archive",
              sourcePublicId: archivePublicId,
              connectionPublicId: payload.connectionPublicId,
              jobPublicId: job.jobId,
              attempt: job.attempt,
              correlationId: job.correlationId,
              bytes: putResult.size,
              phase: "finished",
              result: "verified",
              verification: putResult.sha256 ? "checksum" : "provider_readback",
              alreadyAudited: true,
            }
          : {
              kind: "backup_archive",
              sourcePublicId: archivePublicId,
              connectionPublicId: payload.connectionPublicId,
              jobPublicId: job.jobId,
              attempt: job.attempt,
              correlationId: job.correlationId,
              bytes: putResult.size,
              phase: "finished",
              result: "written",
              alreadyAudited: true,
            },
        tx,
      );
    });

    await evaluateAndRecordPolicyTransition(deps, job.correlationId);
    return {
      outcome: "completed",
      safeCounts: { verified_bytes: putResult.size },
    };
  } catch (error) {
    if (isJobLeaseLostError(error)) {
      throw error;
    }
    const reasonCode = error instanceof DomainError ? error.reasonCode : "REMOTE_COPY_FAILED";
    const retryable = error instanceof DomainError ? error.code === "UNAVAILABLE" || error.code === "RATE_LIMITED" : false;

    if (copyId > 0) {
      const failedAt = deps.clock.now();
      await deps.db
        .transaction(async (tx) => {
          await job.assertStillOwned(tx);
          await tx
            .update(backupRemoteCopies)
            .set({
              state: "failed",
              reasonCode,
              completedAt: failedAt,
              updatedAt: failedAt,
            })
            .where(eq(backupRemoteCopies.id, copyId));
          await deps.audit.record(
            {
              category: "backup",
              eventName: "backup.remote_copy.failed",
              action: "replicate",
              outcome: "failed",
              severity: "ERROR",
              reasonCode,
              actor: { role: "system" },
              resource: { type: "backup_archive", publicId: archivePublicId },
              correlationId: job.correlationId,
              attributes: { connection_public_id: payload.connectionPublicId },
              safeCounts: { attempt_count: attemptNumber },
            },
            tx,
          );
          await recordCopyAttempt(
            deps,
            {
              kind: "backup_archive",
              sourcePublicId: archivePublicId,
              connectionPublicId: payload.connectionPublicId,
              jobPublicId: job.jobId,
              attempt: job.attempt,
              correlationId: job.correlationId,
              bytes: expectedSize > 0 ? expectedSize : null,
              phase: "finished",
              result: "failed",
              errorCode: reasonCode,
              alreadyAudited: true,
            },
            tx,
          );
        })
        .catch(() => undefined);
    }

    await evaluateAndRecordPolicyTransition(deps, job.correlationId).catch(() => undefined);
    return { outcome: "failed", reasonCode, retryable };
  }
}

/**
 * Periodic worker sweep:
 *  1. Picks up verified encrypted backups created via host CLI / `readypackets-backup.timer` when `autoCopyAfterVerify` is enabled.
 *  2. Evaluates 3-2-1 backup policy compliance across the configured window and records `backup.policy.unmet` when unmet.
 */
export async function executeRemoteCopySweepJob(
  deps: Pick<ModuleDeps, "db" | "clock" | "settings" | "jobs" | "audit" | "logger" | "services">,
  isMaintenanceDraining: () => Promise<boolean>,
  isJobLeaseLostError: (err: unknown) => boolean,
  job: ClaimedJob<unknown>,
): Promise<JobResult> {
  if (await isMaintenanceDraining()) {
    return { outcome: "canceled", reasonCode: "MAINTENANCE_DRAINING" };
  }
  if (!getStorageModule(deps)) {
    return { outcome: "completed", safeCounts: { skipped_no_storage: 1 } };
  }

  try {
    await job.assertStillOwned();
    const policy = await readSetting(deps.settings, BACKUP_OFFSITE_POLICY);
    let stagedCount = 0;

    if (policy.autoCopyAfterVerify) {
      const activeDestinations = await listActiveEnabledDestinations(deps, policy);
      if (activeDestinations.length > 0) {
        const cutoff = new Date(deps.clock.now().getTime() - policy.windowDays * 24 * 60 * 60 * 1000);
        const candidates = await deps.db
          .select()
          .from(backupArchives)
          .where(
            and(
              eq(backupArchives.state, "completed"),
              eq(backupArchives.verificationStatus, "verified"),
              gte(backupArchives.createdAt, cutoff),
            ),
          )
          .orderBy(desc(backupArchives.createdAt), desc(backupArchives.id))
          .limit(20);

        for (const candidate of candidates) {
          if (candidate.purgedAt !== null || !candidate.storageKey || !candidate.archiveSha256) continue;
          await deps.db.transaction(async (tx) => {
            await job.assertStillOwned(tx);
            const [locked] = await tx
              .select()
              .from(backupArchives)
              .where(eq(backupArchives.id, candidate.id))
              .limit(1)
              .for("update");
            if (
              !locked ||
              locked.purgedAt !== null ||
              locked.state !== "completed" ||
              locked.verificationStatus !== "verified" ||
              !locked.storageKey ||
              !locked.archiveSha256
            ) {
              return;
            }
            const staged = await stageCopiesInTx(deps, tx, locked, activeDestinations, {
              correlationId: job.correlationId,
            });
            stagedCount += staged.filter((s) => s.state === "queued").length;
          });
        }
      }
    }

    const status = await evaluateAndRecordPolicyTransition(deps, job.correlationId);
    return {
      outcome: "completed",
      safeCounts: {
        staged: stagedCount,
        verified_copies: status.verifiedCopies,
        overall_met: status.overallMet ? 1 : 0,
      },
    };
  } catch (error) {
    if (isJobLeaseLostError(error)) throw error;
    const reasonCode = error instanceof DomainError ? error.reasonCode : "REMOTE_SWEEP_FAILED";
    return { outcome: "failed", reasonCode, retryable: true };
  }
}
