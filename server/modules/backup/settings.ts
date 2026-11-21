/**
 * Declared settings, secrets and feature flags for the backup module.
 * All flags default OFF so no background timer or destructive pruning activates unconfigured.
 */
import { z } from "zod";
import { defineFeatureFlag, defineSecret, defineSetting } from "../platform/index.js";

export const BACKUP_RETENTION_KEEP_COUNT = defineSetting({
  key: "backup.retention.keep_count",
  owner: "backup",
  group: "backup",
  label: "Minimum retained backups",
  description: "Minimum number of recent completed encrypted backups retained before age-based pruning.",
  schema: z.number().int().min(1).max(365),
  default: 14,
  sensitivity: "internal",
  exportable: true,
});

export const BACKUP_RETENTION_MAX_AGE_DAYS = defineSetting({
  key: "backup.retention.max_age_days",
  owner: "backup",
  group: "backup",
  label: "Maximum backup retention age (days)",
  description: "Backups older than this age and beyond the minimum retained count become eligible for pruning unless held or last-known-good.",
  schema: z.number().int().min(1).max(3650),
  default: 90,
  sensitivity: "internal",
  exportable: true,
});

export const BACKUP_RECOVERY_SANDBOX_ROOT = defineSetting({
  key: "backup.recovery.sandbox_root",
  owner: "backup",
  group: "backup",
  label: "Isolated restore sandbox directory",
  description: "Absolute host path under which isolated restore drills place recovered object storage.",
  schema: z
    .string()
    .min(1)
    .max(255)
    .regex(/^\/[A-Za-z0-9._/-]+$/, "must be a clean absolute path"),
  default: "/var/lib/readypackets-recovery",
  sensitivity: "internal",
  exportable: true,
});

export const BACKUP_ENCRYPTION_KEY = defineSecret({
  key: "backup.encryption.key",
  owner: "backup",
  group: "backup",
  label: "Fallback backup encryption key",
  description: "Optional backup key spec when RP_BACKUP_KEY_FILE is not set on the host. Must be backed up off-host separately.",
  schema: z.string().min(16).max(4096),
  exportable: false,
});

export const BACKUP_SCHEDULE_ENABLED = defineFeatureFlag({
  flag: "backup.schedule.enabled",
  owner: "backup",
  group: "backup",
  label: "Scheduled daily backups and verification",
  description: "Enable recurring daily encrypted backup creation and verification jobs.",
});

export const BACKUP_RETENTION_AUTO_PRUNE = defineFeatureFlag({
  flag: "backup.retention.auto_prune",
  owner: "backup",
  group: "backup",
  label: "Automated scheduled retention pruning",
  description: "Allow the daily retention schedule to prune eligible expired archives (otherwise dry-run only).",
});

export const BACKUP_OFFHOST_ENABLED = defineFeatureFlag({
  flag: "backup.offhost.enabled",
  owner: "backup",
  group: "backup",
  label: "Off-host backup replication",
  description: "Replicate verified encrypted archives to assigned off-site storage connections.",
});

export const OffsiteDestinationPolicySchema = z.strictObject({
  enabled: z.boolean(),
  retentionNote: z.string().max(240),
});

export const BackupOffsitePolicySchema = z.strictObject({
  autoCopyAfterVerify: z.boolean(),
  windowDays: z.number().int().min(1).max(90),
  destinations: z.record(z.string().regex(/^[A-Za-z0-9_-]{10,64}$/), OffsiteDestinationPolicySchema),
  lastPolicyUnmetSignaled: z.boolean().optional(),
});

export type StoredBackupOffsitePolicy = z.infer<typeof BackupOffsitePolicySchema>;

export const BACKUP_OFFSITE_POLICY = defineSetting({
  key: "backup.offsite.policy",
  owner: "backup",
  group: "backup",
  label: "Off-site backup replication and 3-2-1 evaluation policy",
  description:
    "Per-destination enablement, optional remote retention notes, automatic copy after verification, and 3-2-1 evaluation window.",
  schema: BackupOffsitePolicySchema,
  default: {
    autoCopyAfterVerify: false,
    windowDays: 7,
    destinations: {},
    lastPolicyUnmetSignaled: false,
  },
  sensitivity: "internal",
  exportable: true,
});

