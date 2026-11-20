/**
 * Deterministic ZIP container (yazl) and a defensive reader (yauzl) for the authenticated plaintext.
 *
 * Determinism: entries are added in a fixed order, timestamps are pinned to 1980-01-01 00:00 (DOS, no
 * extended UTC field), file mode is 0644, records/manifest are deflated, objects stored.
 * Reader defences: name allowlist, no directories/links/special files, no encryption flag, only
 * store/deflate, duplicate detection, entry-count, per-entry and total size limits, ratio limit, and
 * yauzl's declared-vs-actual size validation.
 */
import yazl from "yazl";
import yauzl from "yauzl";
import type { Readable } from "node:stream";
import { PortableError } from "../errors.js";
import type { PortableLimits } from "../limits.js";

/** Local-time constructor on purpose: yazl encodes DOS time from local fields, so this is TZ-independent. */
const FIXED_MTIME = new Date(1980, 0, 1, 0, 0, 0);

export const ENTRY_NAME_RE = /^(manifest\.json|records\/[a-z-]{1,40}\.jsonl|extensions\/[a-z0-9-]{1,64}\.jsonl|objects\/[a-f0-9]{64})$/;

export function newZip(): yazl.ZipFile {
  return new yazl.ZipFile();
}

export function zipAdd(zip: yazl.ZipFile, name: string, source: Buffer | (() => Readable), size: number, compress: boolean): void {
  const opts = { mtime: FIXED_MTIME, mode: 0o100644, compress, forceDosTimestamp: true };
  if (Buffer.isBuffer(source)) zip.addBuffer(source, name, opts);
  else zip.addReadStreamLazy(name, { ...opts, size }, (cb: (err: Error | null, stream: Readable) => void) => cb(null, source()));
}

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  entry: yauzl.Entry;
}

export interface OpenedZip {
  zip: yauzl.ZipFile;
  entries: Map<string, ZipEntryInfo>;
  totalUncompressed: number;
}

export async function openZip(path: string, limits: PortableLimits): Promise<OpenedZip> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true, decodeStrings: true }, (err, z) =>
      err || !z ? reject(new PortableError("ARCHIVE_INVALID", "The package archive structure is invalid.")) : resolve(z),
    ),
  );
  const entries = new Map<string, ZipEntryInfo>();
  let total = 0;
  try {
    if (zip.entryCount > limits.maxEntries) throw new PortableError("ENTRY_LIMIT", "The package has too many archive entries.");
    await new Promise<void>((resolve, reject) => {
      zip.on("error", () => reject(new PortableError("ARCHIVE_INVALID", "The package archive structure is invalid.")));
      zip.on("end", () => resolve());
      zip.on("entry", (entry: yauzl.Entry) => {
        try {
          const name = entry.fileName;
          if (!ENTRY_NAME_RE.test(name)) throw new PortableError("ENTRY_NAME_REJECTED", "The package contains a disallowed entry name.", { entry: name.slice(0, 120).replace(/[^\x20-\x7e]/g, "?") });
          if (entries.has(name)) throw new PortableError("DUPLICATE_ENTRY", "The package contains a duplicate entry.", { entry: name });
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new PortableError("ARCHIVE_INVALID", "Encrypted archive members are not allowed.", { entry: name });
          if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new PortableError("ARCHIVE_INVALID", "Unsupported archive compression.", { entry: name });
          const madeBy = entry.versionMadeBy >> 8;
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const fileType = unixMode & 0o170000;
          if (madeBy === 3 && fileType !== 0 && fileType !== 0o100000) throw new PortableError("ARCHIVE_INVALID", "Links and special files are not allowed.", { entry: name });
          if ((entry.externalFileAttributes & 0x10) !== 0) throw new PortableError("ARCHIVE_INVALID", "Directory entries are not allowed.", { entry: name });
          const limit = name.startsWith("objects/") ? limits.maxObjectBytes : name === "manifest.json" ? limits.maxManifestBytes : limits.maxTotalUncompressed;
          if (entry.uncompressedSize > limit) throw new PortableError("SIZE_LIMIT", "An archive entry exceeds the size limit.", { entry: name });
          if (entry.compressionMethod === 8 && entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.maxCompressionRatio) {
            throw new PortableError("RATIO_LIMIT", "An archive entry exceeds the compression ratio limit.", { entry: name });
          }
          total += entry.uncompressedSize;
          if (total > limits.maxTotalUncompressed) throw new PortableError("SIZE_LIMIT", "The archive exceeds the total size limit.");
          entries.set(name, { name, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, entry });
          zip.readEntry();
        } catch (e) {
          reject(e);
        }
      });
      zip.readEntry();
    });
  } catch (e) {
    zip.close();
    throw e;
  }
  return { zip, entries, totalUncompressed: total };
}

export function openEntryStream(opened: OpenedZip, name: string): Promise<Readable> {
  const info = opened.entries.get(name);
  if (!info) return Promise.reject(new PortableError("ARCHIVE_INVALID", "A required archive entry is missing.", { entry: name }));
  return new Promise((resolve, reject) =>
    opened.zip.openReadStream(info.entry, (err, stream) =>
      err || !stream ? reject(new PortableError("ARCHIVE_INVALID", "An archive entry could not be read.", { entry: name })) : resolve(stream),
    ),
  );
}

export async function readEntryBuffer(opened: OpenedZip, name: string, max: number): Promise<Buffer> {
  const stream = await openEntryStream(opened, name);
  const parts: Buffer[] = [];
  let len = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    len += chunk.length;
    if (len > max) {
      stream.destroy();
      throw new PortableError("SIZE_LIMIT", "An archive entry exceeds the size limit.", { entry: name });
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
