/**
 * Typed, safe errors for the portable contract tooling. Messages never contain record content,
 * passphrases or host paths — only fixed sentences and archive entry names.
 */
export const PORTABLE_ERROR_CODES = [
  "HEADER_INVALID",
  "UNSUPPORTED_ENVELOPE",
  "KDF_PARAMS_REJECTED",
  "PASSPHRASE_REJECTED",
  "CHUNK_AUTH_FAILED",
  "TRUNCATED",
  "TRAILING_DATA",
  "SIZE_LIMIT",
  "ARCHIVE_INVALID",
  "ENTRY_NAME_REJECTED",
  "ENTRY_LIMIT",
  "RATIO_LIMIT",
  "DUPLICATE_ENTRY",
  "MANIFEST_INVALID",
  "UNSUPPORTED_CONTRACT",
  "UNSUPPORTED_EXTENSION",
  "DIGEST_MISMATCH",
  "COUNT_MISMATCH",
  "RECORD_INVALID",
  "EXCLUDED_FIELD",
  "DUPLICATE_ID",
  "REFERENCE_UNRESOLVED",
  "OBJECT_MISSING",
  "NOT_VERIFIED",
  "WRITER_STATE",
  "INPUT_INVALID",
  "LEGACY_INVALID",
  "IO_ERROR",
] as const;
export type PortableErrorCode = (typeof PORTABLE_ERROR_CODES)[number];

export class PortableError extends Error {
  override readonly name = "PortableError";
  constructor(
    readonly code: PortableErrorCode,
    message: string,
    readonly detail?: { recordType?: string; line?: number; entry?: string; path?: string },
  ) {
    super(message);
  }
}

export function isPortableError(value: unknown): value is PortableError {
  return value instanceof PortableError;
}
