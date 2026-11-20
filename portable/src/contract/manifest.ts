import { z } from "zod";
import { PublicId, Sha256Hex, Token, UtcTime, text } from "./primitives.js";
import { RecordTypeSchema } from "./records.js";

export const PACKAGE_FORMAT = "readypackets.portable-package" as const;
export const CONTRACT_NAME = "readypackets.portable-contract" as const;
export const CONTRACT_MAJOR = 3;
export const CONTRACT_MINOR = 0;
export const CONTRACT_VERSION = `${CONTRACT_MAJOR}.${CONTRACT_MINOR}` as const;

export const SCOPE_PROFILES = [
  "customer-only",
  "complete-order-with-files",
  "selected-files",
  "all-core",
  "custom",
] as const;
export type ScopeProfile = (typeof SCOPE_PROFILES)[number];

/** Categories that are ALWAYS excluded from a business package (enforced, not just declared). */
export const HARD_EXCLUSIONS = [
  "password-hashes",
  "mfa-secrets",
  "recovery-codes",
  "sessions",
  "tokens",
  "saml-bindings",
  "provider-secrets",
  "encryption-keys",
  "storage-keys",
  "audit-chain-keys",
  "executable-content",
] as const;

const VersionString = z.string().regex(/^\d{1,4}\.\d{1,4}$/);

export const ManifestSchema = z.strictObject({
  format: z.literal(PACKAGE_FORMAT),
  formatVersion: z.literal(3),
  contract: z.strictObject({ name: z.literal(CONTRACT_NAME), version: VersionString }),
  compatibility: z.strictObject({
    /** Lowest contract version a reader must implement to read this package. */
    minReaderVersion: VersionString,
    /** Contract modules the reader must implement; unknown required module ⇒ refuse. */
    requiredModules: z.array(Token).max(32),
  }),
  packageId: PublicId,
  exportId: text(64, 1).nullable(),
  producer: z.strictObject({ name: text(64, 1), version: text(64, 1) }),
  sourceSystem: z.strictObject({ pseudonym: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) }),
  sourceRelease: text(64, 1).nullable(),
  generatedAt: UtcTime,
  snapshot: z.strictObject({
    kind: z.enum(["repeatable-read", "point-in-time", "none"]),
    takenAt: UtcTime,
    identity: text(128).nullable(),
  }),
  scope: z.strictObject({
    profile: z.enum(SCOPE_PROFILES),
    description: text(1000),
    selection: z.strictObject({ mode: z.enum(["fixed", "dynamic-all"]), count: z.int().min(0).nullable() }).nullable(),
  }),
  modules: z.array(z.strictObject({ name: Token, version: VersionString })).max(32),
  records: z
    .array(
      z.strictObject({
        type: RecordTypeSchema,
        file: z.string().regex(/^records\/[a-z-]+\.jsonl$/),
        count: z.int().min(0),
        bytes: z.int().min(0),
        sha256: Sha256Hex,
      }),
    )
    .max(64),
  objects: z.array(z.strictObject({ sha256: Sha256Hex, size: z.int().min(0) })),
  extensions: z
    .array(
      z.strictObject({
        name: Token,
        version: VersionString,
        required: z.boolean(),
        file: z.string().regex(/^extensions\/[a-z0-9-]{1,64}\.jsonl$/),
        count: z.int().min(0),
        bytes: z.int().min(0),
        sha256: Sha256Hex,
      }),
    )
    .max(32),
  dependencyClosure: z.strictObject({
    /** References that intentionally point outside the package (e.g. selected-files → target order). */
    external: z.array(z.strictObject({ type: RecordTypeSchema, publicId: PublicId })).max(100_000),
  }),
  exclusions: z.array(z.strictObject({ category: Token, reason: text(500) })).max(100),
  limitations: z.array(text(500)).max(100),
  /** SHA-256 over canonical JSON of {records:[{type,sha256,count,bytes}], objects, extensions}. Recomputed by readers. */
  contentDigest: Sha256Hex,
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** Loose pre-check used to decide the unknown-field policy before strict validation. */
export function parseVersion(v: string): { major: number; minor: number } {
  const [a, b] = v.split(".");
  return { major: Number(a), minor: Number(b) };
}
