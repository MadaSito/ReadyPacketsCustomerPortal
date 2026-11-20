/** Public entry point of the independent portable contract library (no server imports). */
export { PortableError, PORTABLE_ERROR_CODES, isPortableError, type PortableErrorCode } from "./errors.js";
export { DEFAULT_LIMITS, resolveLimits, type PortableLimits } from "./limits.js";
export { newUlid, ULID_RE } from "./ulid.js";
export { canonicalJson } from "./json.js";
export * from "./contract/primitives.js";
export * from "./contract/records.js";
export * from "./contract/manifest.js";
export { scanExclusions, isExcludedKey, type ExclusionHit } from "./contract/exclusions.js";
export { applyUnknownFieldPolicy } from "./contract/policy.js";
export { createPackageWriter, PRODUCER, type CreateWriterOptions, type FinalizeResult, type PackageWriter, type WriterManifestInput } from "./writer.js";
export { openPackage, KNOWN_MODULES, type OpenPackageOptions } from "./reader.js";
export { computeContentDigest } from "./digest.js";
export { LEGACY_ADAPTER, convertLegacyPayload } from "./legacy/adapter.js";
export type { PortablePackage, RecordEnvelope, SourceFormat, VerificationIssue, VerificationReport } from "./types.js";
