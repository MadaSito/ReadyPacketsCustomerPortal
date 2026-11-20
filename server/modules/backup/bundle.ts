/**
 * RPBUND01 — Deterministic, streaming inner archive bundle and manifest contract.
 *
 * Designed specifically to avoid tar/zip path-traversal, symlink, zip-bomb, and duplicate-member
 * vulnerabilities while streaming arbitrarily large SQL dumps and private objects in constant memory
 * with zero unencrypted temporary files on disk.
 *
 * Wire format (inside RPBK0001 ciphertext):
 *   [8B]  Magic "RPBUND01"
 *   Repeated members:
 *     [1B]  memberKind (0x01 = sql_gz, 0x02 = object, 0x03 = manifest_json)
 *     [2B]  nameLen (uint16 BE, 1..256)
 *     [NB]  name (UTF-8, strict allowlist)
 *     Repeated data frames:
 *       [4B]  frameLen (uint32 BE, 1..1048576; 0x00000000 terminates frames)
 *       [FB]  frameBytes
 *     [8B]  totalMemberBytes (BigUInt64 BE)
 *     [32B] memberSha256 (raw 32-byte digest)
 *   [1B]  End sentinel 0xFF (immediately following the single manifest_json member)
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { CryptoError } from "../../core/errors.js";

export const RPBUND_MAGIC = Buffer.from("RPBUND01", "ascii");
const KIND_SQL_GZ = 0x01;
const KIND_OBJECT = 0x02;
const KIND_MANIFEST = 0x03;
const KIND_END = 0xff;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const OBJECT_KEY_PATTERN = /^(files|staging|exports|backups|quarantine)\/[0-9a-f]{32}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

export const backupManifestBodySchema = z
  .object({
    manifestVersion: z.literal("rp.backup.manifest/1"),
    backupPublicId: z.string().min(10).max(64),
    installationId: z.string().min(3).max(64),
    releaseRef: z.string().min(1).max(80),
    createdAt: z.string().datetime(),
    snapshotBoundary: z
      .object({
        isolationMode: z.literal("mysqldump-single-transaction"),
        dbDumpStartedAt: z.string().datetime(),
        dbDumpCompletedAt: z.string().datetime(),
        objectCaptureStartedAt: z.string().datetime(),
        objectCaptureCompletedAt: z.string().datetime(),
        activeWriterJobsAtCapture: z.number().int().min(0),
      })
      .strict(),
    schema: z
      .object({
        migrationCount: z.number().int().min(0),
        lastMigrationHash: z.string().max(128).nullable(),
        lastMigrationCreatedAt: z.number().int().nullable(),
      })
      .strict(),
    requiredKeys: z
      .object({
        backupKeyId: z.string().min(1).max(32),
        dataKeyringCurrentId: z.string().min(1).max(32),
        dataKeyringAllIds: z.array(z.string().min(1).max(32)).min(1).max(32),
        purposeKeysRequired: z.array(z.string().min(1).max(40)).max(16),
      })
      .strict(),
    databaseDump: z
      .object({
        memberName: z.literal("sql/database.sql.gz"),
        uncompressedBytes: z.number().int().min(1),
        uncompressedSha256: z.string().regex(HEX64_PATTERN),
        compressedBytes: z.number().int().min(1),
        compressedSha256: z.string().regex(HEX64_PATTERN),
        tableNames: z.array(z.string().min(1).max(64)).max(500),
        tableRowCounts: z.record(z.string().min(1).max(64), z.number().int().min(0)),
      })
      .strict(),
    objectInventory: z
      .object({
        totalObjects: z.number().int().min(0).max(500_000),
        totalBytes: z.number().int().min(0),
        items: z
          .array(
            z
              .object({
                storageKey: z.string().regex(OBJECT_KEY_PATTERN),
                size: z.number().int().min(0),
                sha256: z.string().regex(HEX64_PATTERN),
                sourceTable: z.enum(["order_files", "platform_presentation_images", "storage_scan"]),
                recordPublicId: z.string().max(64).optional(),
              })
              .strict(),
          )
          .max(500_000),
      })
      .strict(),
    offHostCopy: z
      .object({
        configured: z.boolean(),
        notice: z.literal("local_only_not_independent_copy"),
      })
      .strict(),
  })
  .strict();

export type BackupManifestBody = z.infer<typeof backupManifestBodySchema>;

export const backupManifestSchema = backupManifestBodySchema
  .extend({
    manifestContentSha256: z.string().regex(HEX64_PATTERN),
  })
  .strict();

export type BackupManifest = z.infer<typeof backupManifestSchema>;

export function computeManifestContentSha256(body: BackupManifestBody): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

export function sealManifest(body: BackupManifestBody): BackupManifest {
  return {
    ...body,
    manifestContentSha256: computeManifestContentSha256(body),
  };
}

export interface BundleObjectSource {
  storageKey: string;
  expectedSize: number;
  expectedSha256: string;
  sourceTable: "order_files" | "platform_presentation_images" | "storage_scan";
  recordPublicId?: string;
  open(): Promise<Readable>;
}

async function* writeFramedMember(
  kind: number,
  name: string,
  source: AsyncIterable<Buffer>,
): AsyncGenerator<Buffer, { size: number; sha256: string }> {
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length === 0 || nameBytes.length > 256) {
    throw new Error(`Invalid bundle member name length for ${name}`);
  }
  const head = Buffer.allocUnsafe(3 + nameBytes.length);
  head.writeUInt8(kind, 0);
  head.writeUInt16BE(nameBytes.length, 1);
  nameBytes.copy(head, 3);
  yield head;

  const hash = createHash("sha256");
  let total = 0;

  for await (const rawChunk of source) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    if (chunk.length === 0) continue;
    let offset = 0;
    while (offset < chunk.length) {
      const slice = chunk.subarray(offset, offset + 65536);
      offset += slice.length;
      total += slice.length;
      hash.update(slice);
      const lenPrefix = Buffer.allocUnsafe(4);
      lenPrefix.writeUInt32BE(slice.length, 0);
      yield lenPrefix;
      yield slice;
    }
  }

  const trailer = Buffer.allocUnsafe(4 + 8 + 32);
  trailer.writeUInt32BE(0, 0);
  trailer.writeBigUInt64BE(BigInt(total), 4);
  const digest = hash.digest();
  digest.copy(trailer, 12);
  yield trailer;

  return { size: total, sha256: digest.toString("hex") };
}

/**
 * Produces an `RPBUND01` plaintext stream from a gzipped SQL stream, private objects, and a manifest builder
 * invoked once SQL and object digests are finalized.
 */
export function createBackupBundleStream(input: {
  openSqlGzStream: () => Promise<{
    gzStream: Readable;
    finalizeSqlStats: () => Promise<{ uncompressedBytes: number; uncompressedSha256: string; tableNames: string[]; tableRowCounts: Record<string, number> }>;
  }>;
  objects: readonly BundleObjectSource[];
  buildManifest: (facts: {
    sql: {
      uncompressedBytes: number;
      uncompressedSha256: string;
      compressedBytes: number;
      compressedSha256: string;
      tableNames: string[];
      tableRowCounts: Record<string, number>;
    };
    objects: {
      storageKey: string;
      size: number;
      sha256: string;
      sourceTable: "order_files" | "platform_presentation_images" | "storage_scan";
      recordPublicId?: string;
    }[];
    objectCaptureStartedAt: Date;
    objectCaptureCompletedAt: Date;
  }) => BackupManifest;
  now: () => Date;
}): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    yield RPBUND_MAGIC;

    const sqlHandle = await input.openSqlGzStream();
    const sqlWritten = yield* writeFramedMember(KIND_SQL_GZ, "sql/database.sql.gz", sqlHandle.gzStream);
    const sqlRawStats = await sqlHandle.finalizeSqlStats();

    const objectCaptureStartedAt = input.now();
    const capturedObjects: {
      storageKey: string;
      size: number;
      sha256: string;
      sourceTable: "order_files" | "platform_presentation_images" | "storage_scan";
      recordPublicId?: string;
    }[] = [];

    const seenKeys = new Set<string>();
    for (const obj of input.objects) {
      if (!OBJECT_KEY_PATTERN.test(obj.storageKey) || seenKeys.has(obj.storageKey)) {
        throw new Error(`Invalid or duplicate backup object key: ${obj.storageKey}`);
      }
      seenKeys.add(obj.storageKey);
      const stream = await obj.open();
      const written = yield* writeFramedMember(KIND_OBJECT, `objects/${obj.storageKey}`, stream);
      if (written.size !== obj.expectedSize || written.sha256 !== obj.expectedSha256) {
        throw new CryptoError("TAMPERED");
      }
      capturedObjects.push({
        storageKey: obj.storageKey,
        size: written.size,
        sha256: written.sha256,
        sourceTable: obj.sourceTable,
        ...(obj.recordPublicId ? { recordPublicId: obj.recordPublicId } : {}),
      });
    }
    const objectCaptureCompletedAt = input.now();

    const manifest = input.buildManifest({
      sql: {
        uncompressedBytes: sqlRawStats.uncompressedBytes,
        uncompressedSha256: sqlRawStats.uncompressedSha256,
        compressedBytes: sqlWritten.size,
        compressedSha256: sqlWritten.sha256,
        tableNames: sqlRawStats.tableNames,
        tableRowCounts: sqlRawStats.tableRowCounts,
      },
      objects: capturedObjects,
      objectCaptureStartedAt,
      objectCaptureCompletedAt,
    });

    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    yield* writeFramedMember(KIND_MANIFEST, "manifest.json", Readable.from([manifestBytes]));
    yield Buffer.from([KIND_END]);
  }

  return Readable.from(generate());
}

/** Reader byte buffer across decrypted chunks. */
class ReaderBuffer {
  private chunks: Buffer[] = [];
  private total = 0;

  constructor(private readonly iter: AsyncIterator<Buffer>) {}

  get buffered(): number {
    return this.total;
  }

  async readExact(count: number): Promise<Buffer> {
    while (this.total < count) {
      const next = await this.iter.next();
      if (next.done) throw new CryptoError("MALFORMED");
      if (next.value.length > 0) {
        this.chunks.push(next.value);
        this.total += next.value.length;
      }
    }
    if (count === 0) return Buffer.alloc(0);
    if (this.chunks[0]!.length === count) {
      this.total -= count;
      return this.chunks.shift()!;
    }
    if (this.chunks[0]!.length > count) {
      const out = this.chunks[0]!.subarray(0, count);
      this.chunks[0] = this.chunks[0]!.subarray(count);
      this.total -= count;
      return out;
    }
    const merged = Buffer.concat(this.chunks, this.total);
    const out = merged.subarray(0, count);
    const rem = merged.subarray(count);
    this.chunks = rem.length > 0 ? [rem] : [];
    this.total = rem.length;
    return out;
  }

  async assertExhausted(): Promise<void> {
    if (this.total > 0) throw new CryptoError("MALFORMED");
    const next = await this.iter.next();
    if (!next.done && next.value.length > 0) {
      throw new CryptoError("MALFORMED");
    }
  }
}

export interface BundleReadHandlers {
  onSqlGz?: (stream: AsyncIterable<Buffer>) => Promise<void>;
  onObject?: (storageKey: string, stream: AsyncIterable<Buffer>) => Promise<void>;
}

export interface ParsedBundleSummary {
  manifest: BackupManifest;
  sqlCompressedBytes: number;
  sqlCompressedSha256: string;
  objectsRead: Map<string, { size: number; sha256: string }>;
}

/**
 * Streams and validates an `RPBUND01` bundle, invoking optional streaming callbacks on SQL and object members
 * while recomputing every member's SHA-256 and cross-checking against `manifest.json`.
 */
export async function readAndValidateBackupBundle(
  plaintextStream: AsyncIterable<Buffer>,
  handlers: BundleReadHandlers = {},
): Promise<ParsedBundleSummary> {
  const reader = new ReaderBuffer(plaintextStream[Symbol.asyncIterator]());
  const magic = await reader.readExact(8);
  if (!magic.equals(RPBUND_MAGIC)) {
    throw new CryptoError("MALFORMED");
  }

  let sawSql = false;
  let sqlCompressedBytes = 0;
  let sqlCompressedSha256 = "";
  const objectsRead = new Map<string, { size: number; sha256: string }>();
  let manifest: BackupManifest | null = null;

  async function consumeMemberStream(
    onStream?: (chunks: AsyncIterable<Buffer>) => Promise<void>,
    maxBytes?: number,
  ): Promise<{ size: number; sha256: string; collected?: Buffer }> {
    const hash = createHash("sha256");
    let size = 0;
    const collectedChunks: Buffer[] = [];

    async function* memberFrames(): AsyncGenerator<Buffer> {
      while (true) {
        const frameLenBuf = await reader.readExact(4);
        const frameLen = frameLenBuf.readUInt32BE(0);
        if (frameLen === 0) break;
        if (frameLen > MAX_FRAME_BYTES) throw new CryptoError("MALFORMED");
        size += frameLen;
        if (maxBytes !== undefined && size > maxBytes) throw new CryptoError("MALFORMED");
        const data = await reader.readExact(frameLen);
        hash.update(data);
        yield data;
      }
    }

    if (onStream) {
      await onStream(memberFrames());
    } else {
      for await (const chunk of memberFrames()) {
        if (maxBytes !== undefined) collectedChunks.push(chunk);
      }
    }

    const trailer = await reader.readExact(8 + 32);
    const declaredSize = Number(trailer.readBigUInt64BE(0));
    const declaredSha = trailer.subarray(8, 40).toString("hex");
    const actualSha = hash.digest("hex");

    if (declaredSize !== size || declaredSha !== actualSha) {
      throw new CryptoError("TAMPERED");
    }

    return {
      size,
      sha256: actualSha,
      ...(maxBytes !== undefined ? { collected: Buffer.concat(collectedChunks, size) } : {}),
    };
  }

  while (true) {
    const kindBuf = await reader.readExact(1);
    const kind = kindBuf.readUInt8(0);
    if (kind === KIND_END) {
      break;
    }
    const nameLen = (await reader.readExact(2)).readUInt16BE(0);
    if (nameLen === 0 || nameLen > 256) throw new CryptoError("MALFORMED");
    const name = (await reader.readExact(nameLen)).toString("utf8");

    if (kind === KIND_SQL_GZ) {
      if (sawSql || manifest !== null || name !== "sql/database.sql.gz") {
        throw new CryptoError("MALFORMED");
      }
      const res = await consumeMemberStream(handlers.onSqlGz);
      sawSql = true;
      sqlCompressedBytes = res.size;
      sqlCompressedSha256 = res.sha256;
    } else if (kind === KIND_OBJECT) {
      if (!sawSql || manifest !== null || !name.startsWith("objects/")) {
        throw new CryptoError("MALFORMED");
      }
      const storageKey = name.slice("objects/".length);
      if (!OBJECT_KEY_PATTERN.test(storageKey) || objectsRead.has(storageKey)) {
        throw new CryptoError("MALFORMED");
      }
      const res = await consumeMemberStream(
        handlers.onObject ? (stream) => handlers.onObject!(storageKey, stream) : undefined,
      );
      objectsRead.set(storageKey, { size: res.size, sha256: res.sha256 });
    } else if (kind === KIND_MANIFEST) {
      if (!sawSql || manifest !== null || name !== "manifest.json") {
        throw new CryptoError("MALFORMED");
      }
      const res = await consumeMemberStream(undefined, MAX_MANIFEST_BYTES);
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(res.collected!.toString("utf8"));
      } catch {
        throw new CryptoError("MALFORMED");
      }
      const parsed = backupManifestSchema.safeParse(rawJson);
      if (!parsed.success) {
        throw new CryptoError("MALFORMED");
      }
      const { manifestContentSha256, ...body } = parsed.data;
      if (computeManifestContentSha256(body) !== manifestContentSha256) {
        throw new CryptoError("TAMPERED");
      }
      manifest = parsed.data;
    } else {
      throw new CryptoError("MALFORMED");
    }
  }

  await reader.assertExhausted();

  if (!sawSql || !manifest) {
    throw new CryptoError("MALFORMED");
  }

  // Cross-check SQL compressed digest & size against manifest
  if (
    manifest.databaseDump.compressedBytes !== sqlCompressedBytes ||
    manifest.databaseDump.compressedSha256 !== sqlCompressedSha256
  ) {
    throw new CryptoError("TAMPERED");
  }

  // Cross-check exact 1-to-1 object inventory match
  if (
    manifest.objectInventory.totalObjects !== manifest.objectInventory.items.length ||
    objectsRead.size !== manifest.objectInventory.items.length
  ) {
    throw new CryptoError("TAMPERED");
  }
  let sumBytes = 0;
  for (const item of manifest.objectInventory.items) {
    const actual = objectsRead.get(item.storageKey);
    if (!actual || actual.size !== item.size || actual.sha256 !== item.sha256) {
      throw new CryptoError("TAMPERED");
    }
    sumBytes += item.size;
  }
  if (sumBytes !== manifest.objectInventory.totalBytes) {
    throw new CryptoError("TAMPERED");
  }

  return {
    manifest,
    sqlCompressedBytes,
    sqlCompressedSha256,
    objectsRead,
  };
}
