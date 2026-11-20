/**
 * Streaming package writer. Records and objects are validated and spooled into a private work directory,
 * then `finalize()` builds the deterministic archive and streams it through the AEAD envelope into a
 * temporary file that is atomically renamed onto `output`.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PortableError } from "./errors.js";
import { canonicalJson } from "./json.js";
import { resolveLimits, type PortableLimits } from "./limits.js";
import { newUlid, ULID_RE } from "./ulid.js";
import {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  HARD_EXCLUSIONS,
  ManifestSchema,
  PACKAGE_FORMAT,
  type Manifest,
  type ScopeProfile,
} from "./contract/manifest.js";
import { RECORD_MODULE, RECORD_SCHEMAS, RECORD_TYPE_ORDER, referencesOf, type RecordOf, type RecordType } from "./contract/records.js";
import { scanExclusions } from "./contract/exclusions.js";
import { DEFAULT_CHUNK_SIZE, DEFAULT_KDF, EncryptStream, MAX_CHUNK_SIZE, assertPassphrase, checkKdfParams, deriveKeys, encodeHeader, newHeader } from "./crypto/envelope.js";
import { newZip, zipAdd } from "./archive/zip.js";
import { computeContentDigest } from "./digest.js";

export const PRODUCER = { name: "readypackets-portable", version: "3.0.0" } as const;

export interface WriterManifestInput {
  packageId?: string;
  exportId?: string | null;
  sourceSystem: { pseudonym: string };
  sourceRelease: string | null;
  producer?: { name: string; version: string };
  generatedAt?: string;
  snapshot?: { kind: "repeatable-read" | "point-in-time" | "none"; takenAt: string; identity?: string | null };
  scope: { profile: ScopeProfile; description: string; selection?: { mode: "fixed" | "dynamic-all"; count?: number | null } | null };
  exclusions?: Array<{ category: string; reason: string }>;
  limitations?: string[];
}

export interface CreateWriterOptions {
  output: string;
  passphrase: string | Uint8Array;
  manifest: WriterManifestInput;
  kdf?: { N?: number; r?: number; p?: number };
  chunkSize?: number;
  limits?: Partial<PortableLimits>;
  workDir?: string;
  /** Allow references to records outside the package (declared in dependencyClosure.external). */
  allowExternalReferences?: boolean;
  /** Clock + randomness injection (tests / deterministic fixtures). */
  now?: () => Date;
  randomBytes?: (n: number) => Uint8Array;
}

export interface FinalizeResult {
  packageId: string;
  manifest: Manifest;
  manifestSha256: string;
  bytes: number;
  ciphertextSha256: string;
}

export interface PackageWriter {
  addRecord<T extends RecordType>(type: T, record: RecordOf<T>): Promise<void>;
  addObject(input: { source: Buffer | Uint8Array | AsyncIterable<Uint8Array> | NodeJS.ReadableStream; expectedSha256?: string; expectedSize?: number }): Promise<{ sha256: string; size: number }>;
  finalize(): Promise<FinalizeResult>;
  abort(): Promise<void>;
}

interface Spool {
  stream: WriteStream;
  hash: ReturnType<typeof createHash>;
  count: number;
  bytes: number;
  file: string;
}

const DEFAULT_EXCLUSION_REASONS: Record<(typeof HARD_EXCLUSIONS)[number], string> = {
  "password-hashes": "Credentials never travel in a business package.",
  "mfa-secrets": "MFA factors are re-enrolled locally on the target.",
  "recovery-codes": "Recovery codes are installation-local security state.",
  sessions: "Sessions are installation-local security state.",
  tokens: "Reset, verification, API and refresh tokens are never exported.",
  "saml-bindings": "SSO bindings are configured on the target by an administrator.",
  "provider-secrets": "Integration credentials are never exported.",
  "encryption-keys": "Field/key material stays in the source key custody.",
  "storage-keys": "Original object storage keys are replaced by content addresses.",
  "audit-chain-keys": "Audit chain keys are installation-local.",
  "executable-content": "Hooks, scripts and code are never carried.",
};

function writeLine(s: Spool, line: string): Promise<void> {
  const buf = Buffer.from(line + "\n", "utf8");
  s.hash.update(buf);
  s.bytes += buf.length;
  s.count += 1;
  return new Promise((resolve, reject) => {
    if (s.stream.write(buf)) resolve();
    else {
      s.stream.once("drain", resolve);
      s.stream.once("error", reject);
    }
  });
}

function closeSpool(s: Spool): Promise<void> {
  return new Promise((resolve, reject) => s.stream.end((err?: Error | null) => (err ? reject(err) : resolve())));
}

export async function createPackageWriter(opts: CreateWriterOptions): Promise<PackageWriter> {
  const limits = resolveLimits(opts.limits);
  assertPassphrase(opts.passphrase);
  const kdf = { N: opts.kdf?.N ?? DEFAULT_KDF.N, r: opts.kdf?.r ?? DEFAULT_KDF.r, p: opts.kdf?.p ?? DEFAULT_KDF.p };
  checkKdfParams(kdf, limits);
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1024 || chunkSize > MAX_CHUNK_SIZE) throw new PortableError("INPUT_INVALID", "Chunk size is out of range.");
  if (!path.isAbsolute(opts.output)) throw new PortableError("INPUT_INVALID", "The output path must be absolute.");
  const now = opts.now ?? (() => new Date());
  const random = opts.randomBytes ?? randomBytes;
  const packageId = opts.manifest.packageId ?? newUlid(now().getTime(), random);
  if (!ULID_RE.test(packageId)) throw new PortableError("INPUT_INVALID", "The package id must be a ULID.");

  const work = await mkdtemp(path.join(opts.workDir ?? os.tmpdir(), "rp-portable-w-"));
  const spools = new Map<RecordType, Spool>();
  const ids = new Set<string>(); // `${type}:${publicId}`
  const pendingRefs: Array<[RecordType, string]> = [];
  const objects = new Map<string, number>();
  let state: "open" | "finalizing" | "done" | "aborted" = "open";
  const assertOpen = () => {
    if (state !== "open") throw new PortableError("WRITER_STATE", "The package writer is no longer open.");
  };

  const spoolFor = (type: RecordType): Spool => {
    let s = spools.get(type);
    if (!s) {
      const file = path.join(work, `${type}.jsonl`);
      s = { stream: createWriteStream(file, { mode: 0o600, flags: "wx" }), hash: createHash("sha256"), count: 0, bytes: 0, file };
      spools.set(type, s);
    }
    return s;
  };

  const writer: PackageWriter = {
    async addRecord(type, record) {
      assertOpen();
      const schema = RECORD_SCHEMAS[type];
      if (!schema) throw new PortableError("INPUT_INVALID", "Unknown record type.");
      const hits = scanExclusions(record);
      if (hits.length) {
        throw new PortableError("EXCLUDED_FIELD", "A record contains a field or value that must never be exported.", { recordType: type, path: hits[0]!.path });
      }
      const parsed = schema.safeParse(record);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new PortableError("RECORD_INVALID", "A record does not match the portable contract.", { recordType: type, path: issue ? `/${issue.path.join("/")}` : "" });
      }
      const value = parsed.data as Record<string, unknown>;
      if (value.heldUnknown && Buffer.byteLength(JSON.stringify(value.heldUnknown)) > limits.maxHeldUnknownBytes) {
        throw new PortableError("RECORD_INVALID", "Held-unknown content exceeds its size limit.", { recordType: type, path: "/heldUnknown" });
      }
      const key = `${type}:${String(value.publicId)}`;
      if (ids.has(key)) throw new PortableError("DUPLICATE_ID", "A record publicId was added twice.", { recordType: type });
      const s = spoolFor(type);
      if (s.count >= limits.maxRecordsPerType) throw new PortableError("SIZE_LIMIT", "Too many records of one type.", { recordType: type });
      const line = canonicalJson(value);
      if (Buffer.byteLength(line) > limits.maxRecordLineBytes) throw new PortableError("SIZE_LIMIT", "A record exceeds the line size limit.", { recordType: type });
      ids.add(key);
      for (const ref of referencesOf(type, value)) pendingRefs.push(ref);
      if (type === "file-versions") pendingRefs.push(["__object" as RecordType, `${String(value.sha256)}:${String(value.sizeBytes)}`]);
      await writeLine(s, line);
    },

    async addObject(input) {
      assertOpen();
      const tmp = path.join(work, `obj-${randomBytes(12).toString("hex")}`);
      const hash = createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _e, cb) {
          size += chunk.length;
          if (size > limits.maxObjectBytes) return cb(new PortableError("SIZE_LIMIT", "An object exceeds the size limit."));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      const src = Buffer.isBuffer(input.source) || input.source instanceof Uint8Array ? Readable.from([Buffer.from(input.source)]) : Readable.from(input.source as AsyncIterable<Uint8Array>);
      try {
        await pipeline(src, meter, createWriteStream(tmp, { mode: 0o600, flags: "wx" }));
      } catch (e) {
        await rm(tmp, { force: true });
        if (e instanceof PortableError) throw e;
        throw new PortableError("IO_ERROR", "An object could not be read.");
      }
      const sha256 = hash.digest("hex");
      if ((input.expectedSha256 && input.expectedSha256 !== sha256) || (input.expectedSize !== undefined && input.expectedSize !== size)) {
        await rm(tmp, { force: true });
        throw new PortableError("DIGEST_MISMATCH", "Object bytes do not match the expected size or SHA-256.");
      }
      if (objects.has(sha256)) await rm(tmp, { force: true });
      else {
        await rename(tmp, path.join(work, `o-${sha256}`));
        objects.set(sha256, size);
      }
      return { sha256, size };
    },

    async finalize() {
      assertOpen();
      state = "finalizing";
      try {
        // Reference closure.
        const external: Array<{ type: RecordType; publicId: string }> = [];
        const seenExternal = new Set<string>();
        for (const [type, id] of pendingRefs) {
          if ((type as string) === "__object") {
            const [sha, sz] = id.split(":");
            if (objects.get(sha!) !== Number(sz)) throw new PortableError("OBJECT_MISSING", "A file version references bytes that were not added (or with a different size).", { recordType: "file-versions" });
            continue;
          }
          if (ids.has(`${type}:${id}`)) continue;
          if (!opts.allowExternalReferences) throw new PortableError("REFERENCE_UNRESOLVED", "A record references another record that is not in the package.", { recordType: type });
          const k = `${type}:${id}`;
          if (!seenExternal.has(k)) {
            seenExternal.add(k);
            external.push({ type, publicId: id });
          }
        }
        external.sort((a, b) => (a.type === b.type ? (a.publicId < b.publicId ? -1 : 1) : RECORD_TYPE_ORDER.indexOf(a.type) - RECORD_TYPE_ORDER.indexOf(b.type)));

        for (const s of spools.values()) await closeSpool(s);
        const recordEntries = RECORD_TYPE_ORDER.filter((t) => spools.has(t)).map((t) => {
          const s = spools.get(t)!;
          return { type: t, file: `records/${t}.jsonl`, count: s.count, bytes: s.bytes, sha256: s.hash.digest("hex") };
        });
        const objectEntries = [...objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([sha256, size]) => ({ sha256, size }));
        const modules = [...new Set(recordEntries.map((r) => RECORD_MODULE[r.type]).concat("core"))].sort().map((name) => ({ name, version: CONTRACT_VERSION }));
        const generatedAt = opts.manifest.generatedAt ?? now().toISOString();
        const hard = HARD_EXCLUSIONS.map((category) => ({ category, reason: DEFAULT_EXCLUSION_REASONS[category] }));
        const manifestDraft: Manifest = {
          format: PACKAGE_FORMAT,
          formatVersion: 3,
          contract: { name: CONTRACT_NAME, version: CONTRACT_VERSION },
          compatibility: { minReaderVersion: CONTRACT_VERSION, requiredModules: modules.map((m) => m.name) },
          packageId,
          exportId: opts.manifest.exportId ?? null,
          producer: opts.manifest.producer ?? { ...PRODUCER },
          sourceSystem: { pseudonym: opts.manifest.sourceSystem.pseudonym },
          sourceRelease: opts.manifest.sourceRelease,
          generatedAt,
          snapshot: opts.manifest.snapshot
            ? { kind: opts.manifest.snapshot.kind, takenAt: opts.manifest.snapshot.takenAt, identity: opts.manifest.snapshot.identity ?? null }
            : { kind: "none", takenAt: generatedAt, identity: null },
          scope: {
            profile: opts.manifest.scope.profile,
            description: opts.manifest.scope.description,
            selection: opts.manifest.scope.selection ? { mode: opts.manifest.scope.selection.mode, count: opts.manifest.scope.selection.count ?? null } : null,
          },
          modules,
          records: recordEntries,
          objects: objectEntries,
          extensions: [],
          dependencyClosure: { external },
          exclusions: [...hard, ...(opts.manifest.exclusions ?? []).filter((e) => !hard.some((h) => h.category === e.category))],
          limitations: opts.manifest.limitations ?? [],
          contentDigest: "",
        };
        manifestDraft.contentDigest = computeContentDigest(recordEntries, objectEntries, []);
        const checked = ManifestSchema.safeParse(manifestDraft);
        if (!checked.success) {
          const issue = checked.error.issues[0];
          throw new PortableError("MANIFEST_INVALID", "The package manifest input is invalid.", { path: issue ? `/${issue.path.join("/")}` : "" });
        }
        if (scanExclusions(checked.data).length) throw new PortableError("EXCLUDED_FIELD", "The manifest contains a forbidden field or value.");
        const manifestBytes = Buffer.from(canonicalJson(checked.data) + "\n", "utf8");
        const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");

        const zip = newZip();
        zipAdd(zip, "manifest.json", manifestBytes, manifestBytes.length, true);
        for (const r of recordEntries) {
          const file = spools.get(r.type)!.file;
          zipAdd(zip, r.file, () => createReadStream(file), r.bytes, true);
        }
        for (const o of objectEntries) {
          const file = path.join(work, `o-${o.sha256}`);
          zipAdd(zip, `objects/${o.sha256}`, () => createReadStream(file), o.size, false);
        }
        zip.end();

        const header = newHeader(packageId, kdf, chunkSize, random);
        const keys = await deriveKeys(opts.passphrase, header.kdf);
        const tmpOut = path.join(path.dirname(opts.output), `.${path.basename(opts.output)}.${randomBytes(6).toString("hex")}.partial`);
        const ctHash = createHash("sha256");
        let bytes = 0;
        const tap = new Transform({
          transform(chunk: Buffer, _e, cb) {
            ctHash.update(chunk);
            bytes += chunk.length;
            if (bytes > limits.maxPackageBytes) return cb(new PortableError("SIZE_LIMIT", "The package exceeds the configured size limit."));
            cb(null, chunk);
          },
        });
        try {
          await pipeline(zip.outputStream, new EncryptStream(keys, encodeHeader(header), chunkSize), tap, createWriteStream(tmpOut, { mode: 0o600, flags: "wx" }));
          const fh = await open(tmpOut, "r");
          await fh.sync();
          await fh.close();
          await rename(tmpOut, opts.output);
        } catch (e) {
          await rm(tmpOut, { force: true });
          throw e;
        } finally {
          keys.encKey.fill(0);
          keys.macKey.fill(0);
        }
        const size = (await stat(opts.output)).size;
        state = "done";
        return { packageId, manifest: checked.data, manifestSha256, bytes: size, ciphertextSha256: ctHash.digest("hex") };
      } catch (e) {
        state = "aborted";
        throw e instanceof PortableError ? e : new PortableError("IO_ERROR", "The package could not be written.");
      } finally {
        for (const s of spools.values()) s.stream.destroy();
        await rm(work, { recursive: true, force: true });
      }
    },

    async abort() {
      if (state === "done") return;
      state = "aborted";
      for (const s of spools.values()) s.stream.destroy();
      await rm(work, { recursive: true, force: true });
    },
  };
  return writer;
}
