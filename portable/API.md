# portable — API (v0.1, signatures first)

Independent library: imports only Node built-ins, `zod`, `yazl`, `yauzl`. **Never imports `server/**`.**
Entry point: `portable/src/index.ts` (import as `../../../portable/src/index.js` from server code).

## Writer

```ts
createPackageWriter(opts: {
  output: string;                        // destination file path (written via temp + rename)
  passphrase: string | Uint8Array;       // >= 12 chars; never logged/stored
  manifest: {
    packageId?: string;                  // ULID; generated if omitted
    exportId?: string;                   // caller operation id (opaque, <=64 chars)
    sourceSystem: { pseudonym: string }; // e.g. "rp-src-7f3a" — no hostnames
    sourceRelease: string;               // e.g. "2026.11.0"
    producer?: { name: string; version: string };
    generatedAt?: string;                // RFC 3339 UTC; default now
    snapshot?: { kind: "repeatable-read" | "point-in-time" | "none"; takenAt: string; identity?: string };
    scope: { profile: "customer-only" | "complete-order-with-files" | "selected-files" | "all-core" | "custom";
             description: string; selection?: { mode: "fixed" | "dynamic-all"; count?: number } };
    exclusions?: Array<{ category: string; reason: string }>; // declared extra exclusions (hard ones are always added)
    limitations?: string[];
  };
  kdf?: { N?: number; r?: number; p?: number }; // default N=2^17,r=8,p=1 (min N=2^14 for tests only)
  chunkSize?: number;                    // default 64 KiB plaintext per AEAD chunk
  limits?: Partial<PortableLimits>;
  workDir?: string;                      // private spool dir (mode 0700); default os.tmpdir()
}): Promise<PackageWriter>

interface PackageWriter {
  addRecord<T extends RecordType>(type: T, record: RecordOf<T>): Promise<void>; // Zod-validated + exclusion scan; throws PortableError
  addObject(input: { source: Buffer | Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream;
                     expectedSha256?: string; expectedSize?: number }): Promise<{ sha256: string; size: number }>;
  finalize(): Promise<{ packageId: string; manifest: Manifest; bytes: number; ciphertextSha256: string }>;
  abort(): Promise<void>;                // removes spool + partial output
}
```

Records reference objects through `file-versions.objectSha256` (objects stored as `objects/<sha256>`).
Order of `addRecord` calls is free; output is deterministic for identical inputs (records per type keep
insertion order; types and objects in fixed/sorted order; fixed zip timestamps).

## Reader / verifier

```ts
openPackage(opts: { input: string; passphrase: string | Uint8Array; limits?: Partial<PortableLimits>; workDir?: string })
  : Promise<PortablePackage>   // auto-detects v3 (.rpkg binary) or legacy v1/v2 (.rptransfer JSON envelope)

interface PortablePackage {
  readonly sourceFormat: "v3" | "v1" | "v2";
  readonly manifest: Manifest;            // available after open (v3: after full AEAD authentication of the archive)
  verify(): Promise<VerificationReport>;  // integrity + schema + exclusions + counts + references; never throws for content problems
  records<T extends RecordType>(type: T): AsyncIterable<RecordOf<T>>;  // requires verify() ok, else PortableError NOT_VERIFIED
  allRecords(): AsyncIterable<{ type: RecordType; record: AnyRecord }>;
  openObject(sha256: string): Promise<NodeJS.ReadableStream>; // re-opens independently; errors with DIGEST_MISMATCH at end if bytes differ
  listObjects(): ReadonlyArray<{ sha256: string; size: number }>;
  close(): Promise<void>;                 // deletes decrypted spool
}

interface VerificationReport {
  ok: boolean; packageId: string; sourceFormat: "v3" | "v1" | "v2"; contractVersion: string;
  counts: Record<RecordType, number>; objects: { count: number; bytes: number };
  issues: Array<{ code: PortableErrorCode; message: string; recordType?: string; line?: number; path?: string }>;
  warnings: Array<{ code: string; message: string }>;
  losses: Array<{ code: string; message: string; count?: number }>;  // legacy adapters: what could not be carried
  heldUnknown: number;                    // fields preserved as held-unknown
}
```

## Errors

`class PortableError extends Error { code: PortableErrorCode }` — messages are safe (no record content,
no passphrase, no paths beyond entry names). Codes:
`HEADER_INVALID, UNSUPPORTED_ENVELOPE, KDF_PARAMS_REJECTED, PASSPHRASE_REJECTED (wrong passphrase OR header
tamper — indistinguishable by design), CHUNK_AUTH_FAILED, TRUNCATED, REORDERED, TRAILING_DATA, SIZE_LIMIT,
ARCHIVE_INVALID, ENTRY_NAME_REJECTED, ENTRY_LIMIT, RATIO_LIMIT, DUPLICATE_ENTRY, MANIFEST_INVALID,
UNSUPPORTED_CONTRACT, DIGEST_MISMATCH, COUNT_MISMATCH, RECORD_INVALID, EXCLUDED_FIELD, DUPLICATE_ID,
REFERENCE_UNRESOLVED, OBJECT_MISSING, NOT_VERIFIED, WRITER_STATE, LEGACY_INVALID`.

## Record types (contract 3.0) — file `records/<type>.jsonl`

`customers, orders, order-items, order-status-history, order-shares, files, file-versions,
message-threads, messages, tickets, ticket-comments, policy-versions, policy-acceptances,
intake-definitions, intake-submissions, invoices, payments, refunds, provenance`.
Every record: `publicId` (ULID), references are `<x>PublicId` ULIDs, money = `{ amountMinor: integer, currency: "USD" }`,
times RFC 3339 UTC (`...Z`), optional `heldUnknown: Record<string, JSON>` (bounded) for unmapped source fields.
Full field lists: `portable/src/contract/records.ts` and `portable/docs/CONTRACT.md`; JSON Schemas in `portable/schemas/v3/`.

## Default limits (`PortableLimits`)

maxPackageBytes 4 GiB, maxEntries 200 000, maxRecordsPerType 1 000 000, maxRecordLineBytes 1 MiB,
maxObjectBytes 1 GiB, maxTotalUncompressed 8 GiB, maxCompressionRatio 200, maxHeldUnknownBytes 16 KiB/record,
kdf N ≤ 2^20, r ≤ 16, p ≤ 4.

## Hard exclusions (writer refuses, verifier fails)

Keys (normalized, any depth incl. heldUnknown) matching password*, *secret*, *token*, mfa seed/totp,
recovery codes, session ids, SAML bindings/assertions, api/private/encryption/storage keys, audit chain keys;
values that look like PEM private keys, argon2/bcrypt/scrypt hashes, otpauth:// URIs.

## CLI

`tsx portable/cli/verify.ts verify <pkg> [--passphrase-file f | --passphrase-env VAR] [--json]`
`tsx portable/cli/verify.ts extract <pkg> <empty-dir> ...` · `tsx portable/cli/verify.ts plan <pkg> ...` (reference importer)
Exit codes: 0 ok, 1 verification failed, 2 usage, 3 passphrase rejected, 4 unsupported format, 5 I/O error.
