/**
 * Backup encryption keyring parsing and validation.
 *
 * Rules:
 *  - Fail closed when missing, malformed, weak, or in an unsafe file.
 *  - Supports host secret file (`RP_BACKUP_KEY_FILE` mode 0600/0640 via `readSecretEnv`),
 *    `RP_BACKUP_KEY` env var, test/CLI explicit env, or fallback `SettingsStore` secret.
 *  - Supports JSON keyring (`{"current":"bk1","keys":{"bk1":"..."}}`) for zero-downtime key rotation,
 *    raw 32-byte base64/base64url keys (`raw:<keyId>:<base64>` or bare base64), and high-entropy
 *    passphrases (`passphrase:<keyId>:<secret>`) derived via scrypt.
 *  - Never echoes secret values in errors or logs.
 */
import { z } from "zod";
import { ConfigError, decodeKey, MIN_DISTINCT_KEY_BYTES, readSecretEnv } from "../../config/env.js";
import type { SecretFileOptions } from "../../config/secretFiles.js";
import { DomainError } from "../../core/errors.js";
import type { SettingsStore } from "../../core/types.js";
import { countCodePoints } from "../../../shared/domain.js";
import { readSecret } from "../platform/index.js";
import type { BackupKeyCustodyMode } from "./schema.js";
import { BACKUP_ENCRYPTION_KEY } from "./settings.js";

const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const BASE64_32_PATTERN = /^[A-Za-z0-9+/_-]{43}=?$/;
const PLACEHOLDER_PATTERN = /(change.?me|placeholder|replace.?me|example|dummy|sample|todo|xxxx|password123)/i;

export type BackupKeyMaterial =
  | { readonly kind: "raw"; readonly keyId: string; readonly rawKey: Buffer }
  | { readonly kind: "scrypt"; readonly keyId: string; readonly passphrase: string };

export interface ResolvedBackupKeyring {
  readonly currentKeyId: string;
  readonly keys: ReadonlyMap<string, BackupKeyMaterial>;
  readonly custodyMode: BackupKeyCustodyMode;
}

const keyringJsonSchema = z
  .object({
    current: z.string().regex(KEY_ID_PATTERN),
    keys: z.record(z.string().regex(KEY_ID_PATTERN), z.string().min(1).max(1024)),
  })
  .strict();

function assertKeyId(keyId: string): string {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new DomainError(
      "NOT_CONFIGURED",
      "BACKUP_KEY_INVALID",
      "Backup encryption key identifier is invalid.",
    );
  }
  return keyId;
}

function parseSingleEntry(defaultKeyId: string, rawSpec: string): BackupKeyMaterial {
  const trimmed = rawSpec.trim();
  if (trimmed.length === 0) {
    throw new DomainError("NOT_CONFIGURED", "BACKUP_KEY_MISSING", "Backup encryption key is not configured.");
  }

  if (trimmed.startsWith("raw:")) {
    const rest = trimmed.slice(4);
    const sepIdx = rest.indexOf(":");
    if (sepIdx <= 0) {
      throw new DomainError("NOT_CONFIGURED", "BACKUP_KEY_INVALID", "Backup raw key specification is malformed.");
    }
    const keyId = assertKeyId(rest.slice(0, sepIdx));
    return parseRaw32(keyId, rest.slice(sepIdx + 1));
  }

  if (trimmed.startsWith("passphrase:") || trimmed.startsWith("scrypt:")) {
    const prefixLen = trimmed.startsWith("passphrase:") ? "passphrase:".length : "scrypt:".length;
    const rest = trimmed.slice(prefixLen);
    const sepIdx = rest.indexOf(":");
    if (sepIdx <= 0) {
      throw new DomainError("NOT_CONFIGURED", "BACKUP_KEY_INVALID", "Backup passphrase specification is malformed.");
    }
    const keyId = assertKeyId(rest.slice(0, sepIdx));
    return parsePassphrase(keyId, rest.slice(sepIdx + 1));
  }

  if (BASE64_32_PATTERN.test(trimmed)) {
    return parseRaw32(assertKeyId(defaultKeyId), trimmed);
  }

  return parsePassphrase(assertKeyId(defaultKeyId), trimmed);
}

function parseRaw32(keyId: string, encoded: string): BackupKeyMaterial {
  if (!BASE64_32_PATTERN.test(encoded)) {
    throw new DomainError(
      "NOT_CONFIGURED",
      "BACKUP_KEY_INVALID",
      "Backup raw key must be 32 random bytes encoded as base64 or base64url.",
    );
  }
  const buf = decodeKey(encoded);
  if (buf.length !== 32 || new Set(buf).size < MIN_DISTINCT_KEY_BYTES) {
    throw new DomainError(
      "NOT_CONFIGURED",
      "BACKUP_KEY_WEAK",
      "Backup encryption key does not meet minimum entropy requirements.",
    );
  }
  return { kind: "raw", keyId, rawKey: buf };
}

function parsePassphrase(keyId: string, secret: string): BackupKeyMaterial {
  const normalized = secret.normalize("NFC");
  const cpLen = countCodePoints(normalized);
  if (cpLen < 16 || cpLen > 512) {
    throw new DomainError(
      "NOT_CONFIGURED",
      "BACKUP_KEY_WEAK",
      "Backup encryption passphrase must be between 16 and 512 characters.",
    );
  }
  if (PLACEHOLDER_PATTERN.test(normalized) || new Set(normalized).size < 8) {
    throw new DomainError(
      "NOT_CONFIGURED",
      "BACKUP_KEY_WEAK",
      "Backup encryption passphrase has insufficient entropy or uses a placeholder.",
    );
  }
  return { kind: "scrypt", keyId, passphrase: normalized };
}

export function parseBackupKeySpec(
  rawSpec: string,
  defaultKeyId = "bk-default",
  custodyMode: BackupKeyCustodyMode = "host_file",
): ResolvedBackupKeyring {
  const trimmed = rawSpec.trim();
  if (trimmed.startsWith("{")) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch {
      throw new DomainError("NOT_CONFIGURED", "BACKUP_KEY_INVALID", "Backup keyring JSON could not be parsed.");
    }
    const validated = keyringJsonSchema.safeParse(parsedJson);
    if (!validated.success) {
      throw new DomainError("NOT_CONFIGURED", "BACKUP_KEY_INVALID", "Backup keyring JSON does not match required schema.");
    }
    const ring = validated.data;
    if (!(ring.current in ring.keys) || Object.keys(ring.keys).length > 16) {
      throw new DomainError("NOT_CONFIGURED", "BACKUP_KEY_INVALID", "Backup keyring current key ID must exist in keys (max 16).");
    }
    const map = new Map<string, BackupKeyMaterial>();
    for (const [id, spec] of Object.entries(ring.keys)) {
      const entry = spec.includes(":") ? parseSingleEntry(id, spec) : BASE64_32_PATTERN.test(spec.trim()) ? parseRaw32(id, spec.trim()) : parsePassphrase(id, spec);
      map.set(id, { ...entry, keyId: id });
    }
    return { currentKeyId: ring.current, keys: map, custodyMode };
  }

  const single = parseSingleEntry(defaultKeyId, trimmed);
  return {
    currentKeyId: single.keyId,
    keys: new Map([[single.keyId, single]]),
    custodyMode,
  };
}

export interface BackupKeySourceOptions {
  /** Optional isolated env map (used by tests and CLI tools instead of mutating process.env). */
  env?: Record<string, string | undefined>;
  secretFileOptions?: SecretFileOptions;
}

/**
 * Resolves the configured backup keyring, or returns `null` when unconfigured.
 * Throws DomainError (fail closed, never echoing secret material) if configured improperly or weak.
 */
export async function resolveBackupKeyring(
  settings: SettingsStore,
  options: BackupKeySourceOptions = {},
): Promise<ResolvedBackupKeyring | null> {
  const env = options.env ?? process.env;
  const defaultKeyId = (env.RP_BACKUP_KEY_ID ?? "bk-default").trim() || "bk-default";

  let envValue: string | undefined;
  try {
    envValue = readSecretEnv("RP_BACKUP_KEY", env, options.secretFileOptions);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new DomainError(
        "NOT_CONFIGURED",
        "BACKUP_KEY_UNSAFE_FILE",
        "Backup encryption key configuration or secret file permissions are invalid.",
      );
    }
    throw error;
  }

  if (envValue !== undefined) {
    const custodyMode: BackupKeyCustodyMode = env.RP_BACKUP_KEY_FILE ? "host_file" : "env_var";
    return parseBackupKeySpec(envValue, defaultKeyId, custodyMode);
  }

  const fallbackSecret = await readSecret(settings, BACKUP_ENCRYPTION_KEY);
  if (fallbackSecret !== null && fallbackSecret.trim().length > 0) {
    return parseBackupKeySpec(fallbackSecret, defaultKeyId, "settings_secret");
  }

  return null;
}

/** Requires a valid backup keyring; throws NOT_CONFIGURED / BACKUP_KEY_MISSING if absent (no silent plaintext). */
export async function requireBackupKeyring(
  settings: SettingsStore,
  options: BackupKeySourceOptions = {},
): Promise<ResolvedBackupKeyring> {
  const keyring = await resolveBackupKeyring(settings, options);
  if (!keyring) {
    throw new DomainError(
      "NOT_CONFIGURED",
      "BACKUP_KEY_MISSING",
      "Backup encryption key is not configured; unencrypted backups are refused.",
    );
  }
  return keyring;
}
