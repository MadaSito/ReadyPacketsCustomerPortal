/** backup feature — shared types and pure helpers. Owner: audit engineer (UI); server contract: server/modules/backup/API.md. */
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";

type Inputs = inferRouterInputs<AppRouter>;
type Outputs = inferRouterOutputs<AppRouter>;
export type BackupList = Outputs["backup"]["admin"]["list"];
export type Archive = BackupList["items"][number];
export type BackupDetail = Outputs["backup"]["admin"]["detail"];
export type Verification = BackupDetail["verifications"][number];
export type RestoreDrill = BackupDetail["restores"][number];
export type Hold = BackupDetail["holds"][number];
export type RetentionPolicy = Outputs["backup"]["admin"]["retentionPolicy"];
export type ContinuityMode = RestoreDrill["continuityMode"];
export type RetentionInput = Inputs["backup"]["admin"]["updateRetentionPolicy"];
export type RetentionPlan = Outputs["backup"]["admin"]["previewRetention"];
export type OffsiteConfig = Outputs["backup"]["admin"]["offsiteConfig"];
export type OffsiteDestination = OffsiteConfig["destinations"][number];
export type Backup321 = OffsiteConfig["status321"];
export type RemoteCopy = Archive["remoteCopies"][number];

export const BASE = "/admin/backups";
export const PUBLIC_ID = /^[A-Za-z0-9_-]{10,64}$/;
/** API.md §9: the backup health check degrades when the newest backup is older than 26 hours with the schedule on. */
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

/** Exact phrase the restore CLI demands (server/modules/backup/index.ts expectedRestoreConfirmationText). */
export const confirmationPhrase = (backupPublicId: string, targetDatabaseName: string) => `RESTORE ${backupPublicId} TO ${targetDatabaseName}`;

export const TRIGGER_LABELS: Record<Archive["trigger"], string> = {
  manual: "Manual", scheduled: "Scheduled", pre_upgrade: "Before upgrade", cli: "Command line",
};
export const CUSTODY_LABELS: Record<NonNullable<Archive["keyCustodyMode"]>, string> = {
  host_file: "Host key file", env_var: "Host environment variable", settings_secret: "Database secret (weakest)",
};
export const CONTINUITY_LABELS: Record<ContinuityMode, { label: string; description: string }> = {
  preserve_continuity: {
    label: "Preserve continuity",
    description: "Keeps restored accounts usable: sessions and single-use links are retired, MFA counters are advanced so codes cannot be replayed.",
  },
  quarantine_credentials: {
    label: "Quarantine credentials",
    description: "Use after a suspected compromise: restored passwords, MFA secrets, recovery codes and passkeys are cleared, and every account must be re-activated.",
  },
};
export const KEEP_REASON_LABELS: Record<string, string> = {
  last_known_good: "Last verified good copy",
  legal_hold: "Legal hold",
  within_retention_count: "Within keep count",
  within_retention_age: "Within maximum age",
  non_terminal_or_unknown: "Not finished or outcome unknown",
};

export const PROVIDER_KIND_LABELS: Record<string, string> = {
  local_disk: "Local disk",
  s3: "S3-compatible object storage",
  azure_blob: "Azure Blob Storage",
  dropbox: "Dropbox",
  google_drive: "Google Drive",
  sharepoint: "Microsoft SharePoint",
  onedrive: "Microsoft OneDrive",
};

export const DIGEST_KIND_LABELS: Record<string, string> = {
  sha256: "SHA-256 verified",
  md5: "MD5 transport digest verified",
  quickxor: "QuickXOR digest verified",
  size_only: "Byte size verified",
};

export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

const toMs = (value: Date | string | null | undefined) => (value === null || value === undefined ? null : new Date(value).getTime());

/** Newest archive that completed (the server only lists encrypted archives; there is no plaintext mode). */
export function lastSuccessful(items: readonly Archive[]): Archive | null {
  let best: Archive | null = null;
  for (const item of items) {
    if (item.state !== "completed") continue;
    const at = toMs(item.completedAt ?? item.createdAt) ?? 0;
    if (!best || at > (toMs(best.completedAt ?? best.createdAt) ?? 0)) best = item;
  }
  return best;
}

export type Freshness =
  | { kind: "none" }
  | { kind: "fresh"; ageMs: number; at: Date }
  | { kind: "stale"; ageMs: number; at: Date };

export function freshness(items: readonly Archive[], now: number): Freshness {
  const last = lastSuccessful(items);
  if (!last) return { kind: "none" };
  const at = new Date(last.completedAt ?? last.createdAt);
  const ageMs = Math.max(0, now - at.getTime());
  return { kind: ageMs > STALE_AFTER_MS ? "stale" : "fresh", ageMs, at };
}

export const HOLD_REASONS = [
  { value: "LITIGATION", label: "Litigation or legal claim" },
  { value: "REGULATORY_INQUIRY", label: "Regulatory inquiry" },
  { value: "SECURITY_INVESTIGATION", label: "Security investigation" },
  { value: "CONTRACTUAL_OBLIGATION", label: "Contractual obligation" },
] as const;
export const RELEASE_REASONS = [
  { value: "MATTER_CLOSED", label: "The matter is closed" },
  { value: "NO_LONGER_REQUIRED", label: "No longer required" },
  { value: "CREATED_IN_ERROR", label: "Placed in error" },
] as const;
export const REASON_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const RETENTION_LIMITS = { keepMin: 1, keepMax: 365, ageMin: 1, ageMax: 3650 } as const;

/**
 * Operator CLI restore command (scripts/ops/restore/restore-isolated.ts), usage confirmed by recovery_ops_engineer.
 * Secrets are passed only as *_FILE paths, never on argv. Placeholders stay in angle brackets.
 */
export function restoreCommand(backupPublicId: string | null): string {
  const id = backupPublicId ?? "<BACKUP_PUBLIC_ID>";
  const db = "rp_restore_<YYYYMMDD>";
  return [
    "RP_RECOVERY_DATABASE_URL_FILE=/etc/readypackets/secrets/recovery_database_url \\",
    "RP_BACKUP_KEY_FILE=/etc/readypackets/secrets/backup_key \\",
    "RP_AUDIT_CHAIN_KEY_FILE=/etc/readypackets/secrets/audit_chain_key \\",
    "pnpm tsx scripts/ops/restore/restore-isolated.ts \\",
    "  --archive-file <PATH_TO_DOWNLOADED_OR_STORED_.rpbk> \\",
    `  --target-db ${db} \\`,
    "  --target-storage /var/lib/readypackets-recovery/restore-<YYYYMMDD> \\",
    `  --confirm "${confirmationPhrase(id, db)}"`,
  ].join("\n");
}

/** Newest completed + verified archive, preferring the server's last-known-good marker. */
export function recommendedArchive(items: readonly Archive[]): Archive | null {
  return items.find((a) => a.isLastKnownGood && a.state === "completed")
    ?? items.find((a) => a.state === "completed" && a.verificationStatus === "verified")
    ?? null;
}
