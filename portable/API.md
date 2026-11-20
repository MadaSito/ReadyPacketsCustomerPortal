# portable — API (v1.0, contract 3.0)

Independent library: imports only Node built-ins, `zod`, `yazl`, `yauzl`. **Never imports `server/**`.**
Entry point: `portable/src/index.ts` (import as `../../../portable/src/index.js` from server code).

## Writer

```ts
createPackageWriter(opts: {
  output: string;                        // destination file path (written via temp + rename)
  passphrase: string | Uint8Array;       // >= 12 chars; never logged/stored
  manifest: {
    packageId?: string;                  // ULID; generated if omitted
    exportId?: string | null;            // caller operation id (opaque, <=64 chars)
    sourceSystem: { pseudonym: string }; // e.g. "rp-src-7f3a" — no hostnames
    sourceRelease: string | null;        // e.g. "2026.11.0"
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
  allowExternalReferences?: boolean;     // references outside the package → manifest.dependencyClosure.external
  now?: () => Date; randomBytes?: (n: number) => Uint8Array; // injection for deterministic fixtures only
}): Promise<PackageWriter>

interface PackageWriter {
  addRecord<T extends RecordType>(type: T, record: RecordOf<T>): Promise<void>; // Zod-validated + exclusion scan; throws PortableError
  addObject(input: { source: Buffer | Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream;
                     expectedSha256?: string; expectedSize?: number }): Promise<{ sha256: string; size: number }>;
  finalize(): Promise<{ packageId: string; manifest: Manifest; manifestSha256: string; bytes: number; ciphertextSha256: string }>;
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
  readonly manifestSha256: string;        // v3: SHA-256 of manifest.json bytes; legacy: of the decrypted payload
  readonly ciphertextSha256: string;      // SHA-256 of exactly the input bytes that were authenticated
  verify(): Promise<VerificationReport>;  // integrity + schema + exclusions + counts + references; never throws for content problems
  records<T extends RecordType>(type: T): AsyncIterable<RecordOf<T>>;  // requires verify() ok, else PortableError NOT_VERIFIED
  allRecords(): AsyncIterable<{ type: RecordType; record: AnyRecord; line: number }>; // RECORD_TYPE_ORDER (dependency order)
  openObject(sha256: string): Promise<Readable>; // re-opens independently; errors with DIGEST_MISMATCH at end if bytes differ
  listObjects(): ReadonlyArray<{ sha256: string; size: number }>; // sorted by sha256
  heldExtension(name: string): AsyncIterable<string>; // raw inert lines of an optional unknown extension
  verbatimEntries?(): ReadonlyArray<string>;          // v3 only, after verify: archive entry names
  openVerbatimEntry?(name: string): Promise<Readable>; // v3 only: exact verified entry bytes
  close(): Promise<void>;                 // deletes decrypted spool
}

interface VerificationReport {
  ok: boolean; packageId: string; sourceFormat: "v3" | "v1" | "v2"; contractVersion: string;
  counts: Record<RecordType, number>; objects: { count: number; bytes: number };
  manifestSha256: string; ciphertextSha256: string;
  issues: Array<{ code: PortableErrorCode; message: string; recordType?: string; line?: number; path?: string }>; // capped at 100
  issueCount: number;
  warnings: Array<{ code: string; message: string }>;
  losses: Array<{ code: string; message: string; count?: number }>;  // legacy adapters: what could not be carried
  heldUnknown: number;                    // fields preserved as held-unknown
  heldExtensions: Array<{ name: string; version: string; count: number }>;
}
```

## Errors

`class PortableError extends Error { code: PortableErrorCode; detail?: {recordType?, path?, entry?, line?} }` — messages are safe (no record content,
no passphrase, no paths beyond entry names). Codes:
`HEADER_INVALID, UNSUPPORTED_ENVELOPE, KDF_PARAMS_REJECTED, PASSPHRASE_REJECTED (wrong passphrase OR header
tamper — indistinguishable by design), CHUNK_AUTH_FAILED (incl. reordered/duplicated chunks), TRUNCATED, TRAILING_DATA, SIZE_LIMIT,
ARCHIVE_INVALID, ENTRY_NAME_REJECTED, ENTRY_LIMIT, RATIO_LIMIT, DUPLICATE_ENTRY, MANIFEST_INVALID,
UNSUPPORTED_CONTRACT, UNSUPPORTED_EXTENSION, DIGEST_MISMATCH, COUNT_MISMATCH, RECORD_INVALID, EXCLUDED_FIELD,
DUPLICATE_ID, REFERENCE_UNRESOLVED, OBJECT_MISSING, NOT_VERIFIED, WRITER_STATE, INPUT_INVALID, LEGACY_INVALID,
IO_ERROR`.

## Record types (contract 3.0) — file `records/<type>.jsonl`

`customers, orders, order-items, order-status-history, order-shares, files, file-versions,
message-threads, messages, tickets, ticket-comments, policy-versions, policy-acceptances,
intake-definitions, intake-submissions, invoices, payments, refunds, provenance`.
Every record: `publicId` (ULID), references are `<x>PublicId` ULIDs, money = `{ amountMinor: integer, currency: "USD" }`,
times RFC 3339 UTC (`...Z`), optional `heldUnknown: Record<string, JSON>` (bounded) for unmapped source fields.
Full field lists: `portable/src/contract/records.ts` and `portable/docs/CONTRACT.md`; JSON Schemas in `portable/schemas/v3/`.

## Default limits (`PortableLimits`)

maxPackageBytes 4 GiB, maxEntries 200 000, maxRecordsPerType 1 000 000, maxRecordLineBytes 1 MiB,
maxObjectBytes 1 GiB, maxTotalUncompressed 8 GiB, maxCompressionRatio 200, maxManifestBytes 64 MiB,
maxHeldUnknownBytes 16 KiB/record, maxExtensionBytes 16 MiB, maxLegacyPackageBytes 192 MiB,
kdf 2^14 ≤ N ≤ 2^20, r ≤ 16, p ≤ 4, kdfMaxMemoryBytes 256 MiB (128·N·r·p), kdfMaxWork 2^21 (N·r·p).

## Hard exclusions (writer refuses, verifier fails)

Keys (normalized, any depth incl. heldUnknown) matching password*, *secret*, *token*, mfa seed/totp,
recovery codes, session ids, SAML bindings/assertions, api/private/encryption/storage keys, audit chain keys;
values that look like PEM private keys, argon2/bcrypt/scrypt/pbkdf2 hashes, otpauth:// URIs, JWTs; branches too
deep to scan fail closed. Full list: `docs/CONTRACT.md` §7.

## CLI

`tsx portable/cli/verify.ts verify <pkg> (--passphrase-file f | --passphrase-env VAR) [--json]`
`tsx portable/cli/verify.ts extract <pkg> <empty-dir> ...` · `tsx portable/cli/verify.ts plan <pkg> ...` (reference importer)
Exit codes: 0 ok, 1 verification failed (incl. archive/integrity), 2 usage, 3 passphrase rejected, 4 unsupported
format/contract/KDF/required feature, 5 local I/O error. In-process: `runCli(argv, io)` from `portable/cli/verify.ts`.

## Reference importer

`buildPlan(pkg, report?) → ImportPlan` (`portable/reference-importer/plan.ts`): target `reference-crm-model.v1`,
no writes; refuses unknown enum values (`UNKNOWN_ENUM`) and unmapped record types (`UNSUPPORTED_RECORD_TYPE`);
`applicable` only with zero refusals; `planSha256` over the canonical plan.

## Other exports (`portable/src/index.ts`)

`RECORD_TYPE_ORDER, RECORD_SCHEMAS, RECORD_MODULE, referencesOf, knownKeys, ManifestSchema, HARD_EXCLUSIONS,
SCOPE_PROFILES, CONTRACT_VERSION, scanExclusions, isExcludedKey, applyUnknownFieldPolicy, computeContentDigest,
canonicalJson, newUlid, ULID_RE, DEFAULT_LIMITS, resolveLimits, convertLegacyPayload, LEGACY_ADAPTER, KNOWN_MODULES`.

## Contract changes since v0.1 (for consumers)

`customers.createdAt` nullable; `orders.lock` nullable (null = unknown → import read-only);
`orders.submittedAt` optional+nullable; phone/suffix ≤ 255; `allRecords()` yields `line`; manifest inventories
must be unique and canonical; verbatim entry API added.
