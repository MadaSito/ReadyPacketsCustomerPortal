/**
 * Package reader + verifier. `openPackage` authenticates the ENTIRE ciphertext (header MAC + every chunk
 * tag + final-chunk marker) into a private spool before any archive member or record is parsed. `verify()`
 * then checks archive inventory, manifest, hashes, counts, contract schemas, exclusions, duplicate ids and
 * the reference graph. Records/objects are only served after a successful verify().
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { PortableError, isPortableError } from "./errors.js";
import { canonicalJson, jsonDepth, safeJsonParse } from "./json.js";
import { MAX_JSON_DEPTH } from "./validate.js";
import { resolveLimits, type PortableLimits } from "./limits.js";
import { CONTRACT_MAJOR, CONTRACT_MINOR, ManifestSchema, parseVersion, type Manifest } from "./contract/manifest.js";
import { RECORD_TYPE_ORDER, referencesOf, type RecordOf, type RecordType } from "./contract/records.js";
import { scanExclusions } from "./contract/exclusions.js";
import { checkRecord } from "./validate.js";
import { MAGIC, decryptBody, openEnvelopeHeader, readExact } from "./crypto/envelope.js";
import { openEntryStream, openZip, readEntryBuffer, type OpenedZip } from "./archive/zip.js";
import { splitLines } from "./lines.js";
import { computeContentDigest } from "./digest.js";
import type { PortablePackage, RecordEnvelope, VerificationIssue, VerificationReport } from "./types.js";
import { openLegacyPackage } from "./legacy/adapter.js";

export const KNOWN_MODULES = new Set(["core", "engagement", "compliance", "billing"]);
const MAX_ISSUES = 100;

export interface OpenPackageOptions {
  input: string;
  passphrase: string | Uint8Array;
  limits?: Partial<PortableLimits>;
  workDir?: string;
}

async function openNoFollow(input: string): Promise<FileHandle> {
  if (!path.isAbsolute(input)) throw new PortableError("INPUT_INVALID", "The package path must be absolute.");
  try {
    return await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new PortableError("IO_ERROR", "The package file could not be opened.");
  }
}

export async function openPackage(opts: OpenPackageOptions): Promise<PortablePackage> {
  const limits = resolveLimits(opts.limits);
  const fh = await openNoFollow(opts.input);
  let spoolDir: string | null = null;
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new PortableError("INPUT_INVALID", "The package path is not a regular file.");
    if (st.size === 0) throw new PortableError("TRUNCATED", "The package file is empty.");
    const peek = Buffer.alloc(8);
    await fh.read(peek, 0, 8, 0);
    if (peek[0] === 0x7b /* { */) {
      if (st.size > limits.maxLegacyPackageBytes) throw new PortableError("SIZE_LIMIT", "The legacy package exceeds its size limit.");
      const bytes = await readExact(fh, 0, st.size); // full read loop (short reads are retried)
      if (bytes.length !== st.size || (await fh.stat()).size !== st.size) throw new PortableError("IO_ERROR", "The package changed while being read.");
      await fh.close();
      return await openLegacyPackage(bytes, opts.passphrase, limits);
    }
    if (!peek.equals(MAGIC)) throw new PortableError("UNSUPPORTED_ENVELOPE", "The file is not a ReadyPackets portable package.");
    if (st.size > limits.maxPackageBytes) throw new PortableError("SIZE_LIMIT", "The package exceeds the configured size limit.");
    const env = await openEnvelopeHeader(fh, opts.passphrase, limits);
    // Single pass: the ciphertext hash covers exactly the bytes that were authenticated and decrypted.
    const cipherHash = createHash("sha256").update(env.headerBytes).update(env.mac);
    spoolDir = await mkdtemp(path.join(opts.workDir ?? os.tmpdir(), "rp-portable-r-"));
    const plainPath = path.join(spoolDir, "archive.zip");
    const out = await open(plainPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      let pos = 0;
      await decryptBody(
        fh,
        env,
        st.size,
        async (plain) => {
          await out.write(plain, 0, plain.length, pos);
          pos += plain.length;
        },
        limits.maxPackageBytes,
        (b) => void cipherHash.update(b),
      );
    } finally {
      await out.close();
      env.keys.encKey.fill(0);
      env.keys.macKey.fill(0);
    }
    if ((await fh.stat()).size !== st.size) throw new PortableError("IO_ERROR", "The package changed while being read.");
    const ciphertextSha256 = cipherHash.digest("hex");
    await fh.close();
    // Every byte is authenticated from here on; parsing may begin.
    const zip = await openZip(plainPath, limits);
    const pkg = await V3Package.create(zip, spoolDir, limits, ciphertextSha256, env.header.packageId);
    return pkg;
  } catch (e) {
    await fh.close().catch(() => undefined);
    if (spoolDir) await rm(spoolDir, { recursive: true, force: true });
    if (isPortableError(e)) throw e;
    throw new PortableError("IO_ERROR", "The package could not be read.");
  }
}

class V3Package implements PortablePackage {
  readonly sourceFormat = "v3" as const;
  private verified = false;
  private report: VerificationReport | null = null;
  private constructor(
    private readonly zip: OpenedZip,
    private readonly spoolDir: string,
    private readonly limits: PortableLimits,
    readonly manifest: Manifest,
    readonly manifestSha256: string,
    readonly ciphertextSha256: string,
    private readonly newerMinor: boolean,
    private readonly manifestWarnings: Array<{ code: string; message: string }>,
  ) {}

  static async create(zip: OpenedZip, spoolDir: string, limits: PortableLimits, ciphertextSha256: string, headerPackageId: string): Promise<V3Package> {
    try {
      const bytes = await readEntryBuffer(zip, "manifest.json", limits.maxManifestBytes);
      let raw: unknown;
      try {
        raw = safeJsonParse(bytes.toString("utf8"));
      } catch {
        throw new PortableError("MANIFEST_INVALID", "The manifest is not valid JSON.");
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PortableError("MANIFEST_INVALID", "The manifest is not a JSON object.");
      const r = raw as Record<string, unknown>;
      const contract = r.contract as { version?: unknown } | undefined;
      const compat = r.compatibility as { minReaderVersion?: unknown } | undefined;
      if (typeof contract?.version !== "string" || typeof compat?.minReaderVersion !== "string") throw new PortableError("MANIFEST_INVALID", "The manifest has no contract version.");
      const v = parseVersion(contract.version);
      const min = parseVersion(compat.minReaderVersion);
      if (v.major !== CONTRACT_MAJOR || min.major !== CONTRACT_MAJOR || min.minor > CONTRACT_MINOR) {
        throw new PortableError("UNSUPPORTED_CONTRACT", "This reader does not support the package contract version.");
      }
      const newerMinor = v.minor > CONTRACT_MINOR;
      const warnings: Array<{ code: string; message: string }> = [];
      if (newerMinor) {
        warnings.push({ code: "NEWER_MINOR_VERSION", message: "The package uses a newer minor contract version; unknown fields are preserved as held-unknown." });
        const known = new Set(Object.keys(ManifestSchema.shape));
        const unknownKeys = Object.keys(r).filter((k) => !known.has(k));
        for (const k of unknownKeys) delete r[k];
        // Manifest-level additions cannot be held per record; they are reported (never dropped silently).
        if (unknownKeys.length) {
          warnings.push({ code: "NEWER_MINOR_MANIFEST_FIELDS", message: `The manifest has ${unknownKeys.length} newer top-level field(s) this reader does not model: ${unknownKeys.slice(0, 10).map((k) => k.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)).join(", ")}.` });
        }
      }
      const parsed = ManifestSchema.safeParse(r);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new PortableError("MANIFEST_INVALID", "The manifest does not match the contract.", { path: issue ? `/${issue.path.map(String).join("/")}` : "" });
      }
      const recordTypes = new Set<string>();
      for (const r of parsed.data.records) {
        if (recordTypes.has(r.type) || r.file !== `records/${r.type}.jsonl`) throw new PortableError("MANIFEST_INVALID", "The manifest record inventory has duplicate or non-canonical entries.", { path: r.file });
        recordTypes.add(r.type);
      }
      const extNames = new Set<string>();
      for (const x of parsed.data.extensions) {
        if (extNames.has(x.name) || x.file !== `extensions/${x.name}.jsonl`) throw new PortableError("MANIFEST_INVALID", "The manifest extension inventory has duplicate or non-canonical entries.", { path: x.file });
        extNames.add(x.name);
      }
      const objectIds = new Set<string>();
      for (const o of parsed.data.objects) {
        if (objectIds.has(o.sha256)) throw new PortableError("MANIFEST_INVALID", "The manifest object inventory has duplicate entries.");
        objectIds.add(o.sha256);
      }
      if (parsed.data.packageId !== headerPackageId) throw new PortableError("MANIFEST_INVALID", "The manifest package id does not match the envelope.");
      if (!newerMinor && canonicalJson(parsed.data) + "\n" !== bytes.toString("utf8")) throw new PortableError("MANIFEST_INVALID", "The manifest is not in canonical form.");
      const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
      return new V3Package(zip, spoolDir, limits, parsed.data, manifestSha256, ciphertextSha256, newerMinor, warnings);
    } catch (e) {
      zip.zip.close();
      throw e;
    }
  }

  async verify(): Promise<VerificationReport> {
    if (this.report) return this.report;
    const m = this.manifest;
    const issues: VerificationIssue[] = [];
    let issueCount = 0;
    const add = (i: VerificationIssue) => {
      issueCount += 1;
      if (issues.length < MAX_ISSUES) issues.push(i);
    };
    const warnings = [...this.manifestWarnings];
    const counts: Partial<Record<RecordType, number>> = {};
    let heldUnknown = 0;

    // 1. Inventory: archive entries must be exactly manifest + listed files.
    const expected = new Set<string>(["manifest.json"]);
    const seenTypes = new Set<string>();
    let lastOrder = -1;
    for (const r of m.records) {
      if (seenTypes.has(r.type)) add({ code: "MANIFEST_INVALID", message: "A record type is listed twice.", recordType: r.type });
      seenTypes.add(r.type);
      if (r.file !== `records/${r.type}.jsonl`) add({ code: "MANIFEST_INVALID", message: "A record file name does not match its type.", recordType: r.type });
      const order = RECORD_TYPE_ORDER.indexOf(r.type);
      if (order < lastOrder) add({ code: "MANIFEST_INVALID", message: "Record types are not in contract order.", recordType: r.type });
      lastOrder = order;
      expected.add(r.file);
    }
    let prevSha = "";
    for (const o of m.objects) {
      if (o.sha256 <= prevSha) add({ code: "MANIFEST_INVALID", message: "Objects are not sorted/unique." });
      prevSha = o.sha256;
      expected.add(`objects/${o.sha256}`);
    }
    for (const x of m.extensions) expected.add(x.file);
    for (const name of this.zip.entries.keys()) if (!expected.has(name)) add({ code: "ARCHIVE_INVALID", message: "The archive contains an entry not listed in the manifest.", path: name });
    for (const name of expected) if (!this.zip.entries.has(name)) add({ code: "OBJECT_MISSING", message: "An entry listed in the manifest is missing from the archive.", path: name });
    for (const mod of m.compatibility.requiredModules) if (!KNOWN_MODULES.has(mod)) add({ code: "UNSUPPORTED_EXTENSION", message: "The package requires a contract module this reader does not implement.", path: mod });
    if (scanExclusions(m).length) add({ code: "EXCLUDED_FIELD", message: "The manifest contains a forbidden field or value." });

    // 2. Records: hash, count, schema, exclusions, ids, references.
    const ids = new Set<string>();
    const refs: Array<[RecordType, string, RecordType, number]> = [];
    const objectRefs: Array<[string, number, number]> = [];
    const actualRecords: Array<{ type: string; sha256: string; count: number; bytes: number }> = [];
    for (const entry of m.records) {
      if (!this.zip.entries.has(entry.file)) continue;
      const hash = createHash("sha256");
      let bytes = 0;
      let count = 0;
      try {
        const stream = await openEntryStream(this.zip, entry.file);
        for await (const { text, unterminated } of splitLines(stream as AsyncIterable<Buffer>, this.limits.maxRecordLineBytes, hash, (n) => (bytes += n))) {
          count += 1;
          if (count > this.limits.maxRecordsPerType) throw new PortableError("SIZE_LIMIT", "Too many records of one type.");
          if (unterminated) add({ code: "RECORD_INVALID", message: "The last record line is not newline-terminated.", recordType: entry.type, line: count });
          let raw: unknown;
          try {
            raw = safeJsonParse(text);
          } catch {
            add({ code: "RECORD_INVALID", message: "A record line is not valid JSON.", recordType: entry.type, line: count });
            continue;
          }
          const res = checkRecord(entry.type, raw, this.newerMinor, this.limits);
          if (!res.ok) {
            add({ ...res.issue, line: count });
            continue;
          }
          heldUnknown += res.held;
          const key = `${entry.type}:${String(res.value.publicId)}`;
          if (ids.has(key)) add({ code: "DUPLICATE_ID", message: "A publicId appears twice for one record type.", recordType: entry.type, line: count });
          ids.add(key);
          for (const [t, id] of referencesOf(entry.type, res.value)) refs.push([t, id, entry.type, count]);
          if (entry.type === "file-versions") objectRefs.push([String(res.value.sha256), Number(res.value.sizeBytes), count]);
        }
      } catch (e) {
        add({ code: isPortableError(e) ? e.code : "ARCHIVE_INVALID", message: isPortableError(e) ? e.message : "A record file could not be read.", recordType: entry.type });
      }
      const sha256 = hash.digest("hex");
      actualRecords.push({ type: entry.type, sha256, count, bytes });
      counts[entry.type] = count;
      if (sha256 !== entry.sha256 || bytes !== entry.bytes) add({ code: "DIGEST_MISMATCH", message: "A record file does not match its manifest digest.", recordType: entry.type });
      if (count !== entry.count) add({ code: "COUNT_MISMATCH", message: "A record file count does not match the manifest.", recordType: entry.type });
    }

    const external = new Set(m.dependencyClosure.external.map((x) => `${x.type}:${x.publicId}`));
    for (const [t, id, from, line] of refs) {
      if (!ids.has(`${t}:${id}`) && !external.has(`${t}:${id}`)) add({ code: "REFERENCE_UNRESOLVED", message: `A ${from} record references a ${t} record that is not in the package.`, recordType: from, line });
    }
    if (external.size) warnings.push({ code: "EXTERNAL_REFERENCES", message: `${external.size} reference(s) point to records outside the package; a target must resolve them to verified existing records.` });

    // 3. Objects: bytes must hash to their name and declared size.
    const objectSizes = new Map(m.objects.map((o) => [o.sha256, o.size]));
    let objectBytes = 0;
    for (const o of m.objects) {
      const name = `objects/${o.sha256}`;
      if (!this.zip.entries.has(name)) continue;
      try {
        const h = createHash("sha256");
        let size = 0;
        const stream = await openEntryStream(this.zip, name);
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > this.limits.maxObjectBytes) throw new PortableError("SIZE_LIMIT", "An object exceeds the size limit.");
          h.update(chunk);
        }
        objectBytes += size;
        if (h.digest("hex") !== o.sha256 || size !== o.size) add({ code: "DIGEST_MISMATCH", message: "An object does not match its SHA-256 or size.", path: name });
      } catch (e) {
        add({ code: isPortableError(e) ? e.code : "ARCHIVE_INVALID", message: "An object could not be read.", path: name });
      }
    }
    const referenced = new Set<string>();
    for (const [sha, size, line] of objectRefs) {
      referenced.add(sha);
      const actual = objectSizes.get(sha);
      if (actual === undefined) add({ code: "OBJECT_MISSING", message: "A file version references bytes that are not in the package.", recordType: "file-versions", line });
      else if (actual !== size) add({ code: "DIGEST_MISMATCH", message: "A file version size does not match its object.", recordType: "file-versions", line });
    }
    const unreferenced = m.objects.filter((o) => !referenced.has(o.sha256)).length;
    if (unreferenced) warnings.push({ code: "UNREFERENCED_OBJECTS", message: `${unreferenced} object(s) are not referenced by any file version.` });

    // 4. Extensions: required unknown ⇒ refuse; optional ⇒ hash-check and hold as inert evidence.
    const heldExtensions: VerificationReport["heldExtensions"] = [];
    const actualExt: Array<{ name: string; sha256: string; count: number; bytes: number }> = [];
    for (const x of m.extensions) {
      if (x.required) add({ code: "UNSUPPORTED_EXTENSION", message: "The package requires an extension this reader does not implement.", path: x.name });
      if (!this.zip.entries.has(x.file)) continue;
      const hash = createHash("sha256");
      let bytes = 0;
      let count = 0;
      try {
        const stream = await openEntryStream(this.zip, x.file);
        for await (const { text } of splitLines(stream as AsyncIterable<Buffer>, this.limits.maxRecordLineBytes, hash, (n) => (bytes += n))) {
          count += 1;
          if (bytes > this.limits.maxExtensionBytes) throw new PortableError("SIZE_LIMIT", "An extension exceeds its size limit.");
          try {
            const value = safeJsonParse(text);
            // Same nesting budget as records: anything deeper is rejected, never partially scanned.
            if (jsonDepth(value, MAX_JSON_DEPTH) > MAX_JSON_DEPTH) add({ code: "RECORD_INVALID", message: "An extension line is nested too deeply.", path: x.name, line: count });
            else if (scanExclusions(value).length) add({ code: "EXCLUDED_FIELD", message: "An extension contains a forbidden field or value.", path: x.name, line: count });
          } catch {
            add({ code: "RECORD_INVALID", message: "An extension line is not valid JSON.", path: x.name, line: count });
          }
        }
      } catch (e) {
        add({ code: isPortableError(e) ? e.code : "ARCHIVE_INVALID", message: "An extension could not be read.", path: x.name });
      }
      const sha256 = hash.digest("hex");
      actualExt.push({ name: x.name, sha256, count, bytes });
      if (sha256 !== x.sha256 || bytes !== x.bytes || count !== x.count) add({ code: "DIGEST_MISMATCH", message: "An extension does not match its manifest digest.", path: x.name });
      heldExtensions.push({ name: x.name, version: x.version, count });
    }

    // 5. Content digest recomputed from what was actually hashed.
    if (computeContentDigest(actualRecords, m.objects, actualExt) !== m.contentDigest) add({ code: "DIGEST_MISMATCH", message: "The package content digest does not match its contents." });

    this.verified = issueCount === 0;
    this.report = {
      ok: this.verified,
      packageId: m.packageId,
      sourceFormat: "v3",
      contractVersion: m.contract.version,
      manifestSha256: this.manifestSha256,
      ciphertextSha256: this.ciphertextSha256,
      counts,
      objects: { count: m.objects.length, bytes: objectBytes },
      issues,
      issueCount,
      warnings,
      losses: [],
      heldUnknown,
      heldExtensions,
    };
    return this.report;
  }

  private assertVerified(): void {
    if (!this.verified) throw new PortableError("NOT_VERIFIED", "The package must pass verification before records or objects are read.");
  }

  async *records<T extends RecordType>(type: T): AsyncGenerator<RecordOf<T>> {
    for await (const env of this.iterate(type)) yield env.record as RecordOf<T>;
  }

  private async *iterate(type: RecordType): AsyncGenerator<RecordEnvelope> {
    this.assertVerified();
    const entry = this.manifest.records.find((r) => r.type === type);
    if (!entry) return;
    const stream = await openEntryStream(this.zip, entry.file);
    let line = 0;
    for await (const { text } of splitLines(stream as AsyncIterable<Buffer>, this.limits.maxRecordLineBytes)) {
      line += 1;
      const res = checkRecord(type, safeJsonParse(text), this.newerMinor, this.limits);
      if (!res.ok) throw new PortableError(res.issue.code, res.issue.message, { recordType: type, line });
      yield { type, record: res.value as RecordEnvelope["record"], line };
    }
  }

  async *allRecords(): AsyncGenerator<RecordEnvelope> {
    this.assertVerified();
    for (const t of RECORD_TYPE_ORDER) yield* this.iterate(t);
  }

  listObjects(): ReadonlyArray<{ sha256: string; size: number }> {
    return this.manifest.objects.map((o) => ({ sha256: o.sha256, size: o.size }));
  }

  async openObject(sha256: string): Promise<Readable> {
    this.assertVerified();
    const o = this.manifest.objects.find((x) => x.sha256 === sha256);
    if (!o) throw new PortableError("OBJECT_MISSING", "The object is not in the package.");
    const source = await openEntryStream(this.zip, `objects/${sha256}`);
    const h = createHash("sha256");
    let size = 0;
    const check = new Transform({
      transform(chunk: Buffer, _e, cb) {
        size += chunk.length;
        h.update(chunk);
        cb(null, chunk);
      },
      flush(cb) {
        if (size !== o.size || h.digest("hex") !== o.sha256) cb(new PortableError("DIGEST_MISMATCH", "Object bytes do not match the manifest."));
        else cb();
      },
    });
    source.on("error", (e) => check.destroy(e));
    return source.pipe(check);
  }

  verbatimEntries(): ReadonlyArray<string> {
    this.assertVerified();
    return [...this.zip.entries.keys()].sort();
  }

  async openVerbatimEntry(name: string): Promise<Readable> {
    this.assertVerified();
    // Names come from the allowlisted archive inventory only (no caller-supplied paths reach the zip).
    if (!this.zip.entries.has(name)) throw new PortableError("INPUT_INVALID", "The entry is not in the package.");
    return openEntryStream(this.zip, name);
  }

  async *heldExtension(name: string): AsyncGenerator<string> {
    this.assertVerified();
    const x = this.manifest.extensions.find((e) => e.name === name);
    if (!x) return;
    const stream = await openEntryStream(this.zip, x.file);
    for await (const { text } of splitLines(stream as AsyncIterable<Buffer>, this.limits.maxRecordLineBytes)) yield text;
  }

  async close(): Promise<void> {
    this.zip.zip.close();
    await rm(this.spoolDir, { recursive: true, force: true });
  }
}
