import { PortableError } from "./errors.js";

export interface PortableLimits {
  /** Maximum ciphertext package size in bytes. */
  maxPackageBytes: number;
  maxEntries: number;
  maxRecordsPerType: number;
  maxRecordLineBytes: number;
  maxObjectBytes: number;
  maxTotalUncompressed: number;
  maxCompressionRatio: number;
  maxManifestBytes: number;
  maxHeldUnknownBytes: number;
  maxExtensionBytes: number;
  kdfMaxN: number;
  kdfMaxR: number;
  kdfMaxP: number;
  /** Lowest scrypt N a reader accepts (2^14). Writers default to 2^17. */
  kdfMinN: number;
  /** Legacy v1/v2 envelopes (single JSON document) — source limit was 192 MiB. */
  maxLegacyPackageBytes: number;
}

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export const DEFAULT_LIMITS: Readonly<PortableLimits> = Object.freeze({
  maxPackageBytes: 4 * GiB,
  maxEntries: 200_000,
  maxRecordsPerType: 1_000_000,
  maxRecordLineBytes: 1 * MiB,
  maxObjectBytes: 1 * GiB,
  maxTotalUncompressed: 8 * GiB,
  maxCompressionRatio: 200,
  maxManifestBytes: 64 * MiB,
  maxHeldUnknownBytes: 16 * 1024,
  maxExtensionBytes: 16 * MiB,
  kdfMaxN: 2 ** 20,
  kdfMaxR: 16,
  kdfMaxP: 4,
  kdfMinN: 2 ** 14,
  maxLegacyPackageBytes: 192 * MiB,
});

export function resolveLimits(partial?: Partial<PortableLimits>): PortableLimits {
  const merged = { ...DEFAULT_LIMITS, ...(partial ?? {}) };
  for (const [k, v] of Object.entries(merged)) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new PortableError("INPUT_INVALID", `Limit ${k} must be a positive integer.`);
  }
  return merged;
}
