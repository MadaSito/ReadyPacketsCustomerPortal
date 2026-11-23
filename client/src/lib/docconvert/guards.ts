/**
 * Browser-side input guards: byte ceiling, canonical ZIP Central-Directory + Local-Header coherence,
 * non-overlapping member bounds, actual bounded deflate-stream inflation (defeating spoofed CD sizes),
 * OOXML unsupported-feature detection, PDF header check, and wall-clock timeout wrapper (Increment 06 D9).
 */
import {
  DEFAULT_CONVERT_TIMEOUT_MS,
  DocConvertError,
  MAX_DOCCONVERT_BYTES,
  MAX_ZIP_COMPRESSION_RATIO,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_SINGLE_ENTRY_BYTES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
  type DocxUnsupportedFeature,
  type DocxUnsupportedFeatureKey,
} from "./types";

export interface ZipGuardOptions {
  readonly maxEntries?: number;
  readonly maxTotalUncompressedBytes?: number;
  readonly maxSingleEntryBytes?: number;
  readonly maxCompressionRatio?: number;
}

export interface ZipEntryMeta {
  readonly name: string;
  readonly compressionMethod: number;
  readonly generalPurposeFlags: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly dataStart: number;
  readonly dataEnd: number;
}

export interface ZipInspectionResult {
  readonly entryCount: number;
  readonly totalCompressedBytes: number;
  readonly totalUncompressedBytes: number;
  readonly entries: readonly ZipEntryMeta[];
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const RATIO_MIN_UNCOMPRESSED_BYTES = 64 * 1024;

export function effectiveMaxBytes(maxBytes?: number): number {
  if (maxBytes === undefined || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return MAX_DOCCONVERT_BYTES;
  }
  return Math.min(Math.floor(maxBytes), MAX_DOCCONVERT_BYTES);
}

export function assertInputSize(byteLength: number, maxBytes?: number): void {
  const limit = effectiveMaxBytes(maxBytes);
  if (byteLength <= 0) {
    throw new DocConvertError("FILE_EMPTY", "The selected file is empty.");
  }
  if (byteLength > limit) {
    const limitMb = (limit / (1024 * 1024)).toFixed(limit % (1024 * 1024) === 0 ? 0 : 1);
    throw new DocConvertError(
      "FILE_TOO_LARGE",
      `This file exceeds the ${limitMb} MB browser document limit.`,
    );
  }
}

export async function toUint8Array(
  input: ArrayBuffer | Uint8Array | Blob,
  maxBytes?: number,
): Promise<Uint8Array> {
  if (input instanceof Blob) {
    assertInputSize(input.size, maxBytes);
    const buffer = await input.arrayBuffer();
    assertInputSize(buffer.byteLength, maxBytes);
    return new Uint8Array(buffer);
  }
  if (input instanceof Uint8Array) {
    assertInputSize(input.byteLength, maxBytes);
    const copy = new Uint8Array(input.byteLength);
    copy.set(input);
    return copy;
  }
  assertInputSize(input.byteLength, maxBytes);
  const copy = new Uint8Array(input.byteLength);
  copy.set(new Uint8Array(input));
  return copy;
}

export function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function isUnsafeZipPath(name: string): boolean {
  if (!name || name.length > 512) return true;
  if (name.startsWith("/") || name.startsWith("\\")) return true;
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  const normalized = name.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments.some((seg) => seg === ".." || seg === ".");
}

/**
 * Synchronously validates ZIP structure, Central Directory <-> Local File Header coherence,
 * unique canonical entry names, allowed compression methods (0 stored / 8 deflate), and
 * non-overlapping member byte bounds before any decompression runs.
 */
export function inspectZipArchive(bytes: Uint8Array, options?: ZipGuardOptions): ZipInspectionResult {
  const maxEntries = options?.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxTotalUncompressed = options?.maxTotalUncompressedBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;
  const maxSingleEntry = options?.maxSingleEntryBytes ?? MAX_ZIP_SINGLE_ENTRY_BYTES;
  const maxRatio = options?.maxCompressionRatio ?? MAX_ZIP_COMPRESSION_RATIO;

  if (bytes.byteLength < 22) {
    throw new DocConvertError("INVALID_DOCX_ARCHIVE", "This file is not a valid Word (.docx) document.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== LOCAL_FILE_HEADER_SIG) {
    throw new DocConvertError("INVALID_DOCX_ARCHIVE", "This file is not a valid Word (.docx) document.");
  }

  const minEocdOffset = Math.max(0, bytes.byteLength - 65_557);
  let eocdOffset = -1;
  for (let pos = bytes.byteLength - 22; pos >= minEocdOffset; pos -= 1) {
    if (view.getUint32(pos, true) === EOCD_SIG) {
      const commentLen = view.getUint16(pos + 20, true);
      if (pos + 22 + commentLen === bytes.byteLength) {
        eocdOffset = pos;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw new DocConvertError(
      "INVALID_DOCX_ARCHIVE",
      "This Word (.docx) archive structure is incomplete or corrupted.",
    );
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const cdDiskNumber = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (diskNumber !== 0 || cdDiskNumber !== 0 || diskEntries !== totalEntries) {
    throw new DocConvertError("INVALID_DOCX_ARCHIVE", "Multi-disk ZIP archives are not permitted.");
  }
  if (totalEntries === 0xffff || centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
    throw new DocConvertError(
      "ZIP_UNCOMPRESSED_TOO_LARGE",
      "ZIP64 Word archives are not supported in browser editing.",
    );
  }
  if (totalEntries === 0) {
    throw new DocConvertError("INVALID_DOCX_ARCHIVE", "This Word (.docx) archive contains no entries.");
  }
  if (totalEntries > maxEntries) {
    throw new DocConvertError(
      "ZIP_TOO_MANY_ENTRIES",
      `This document contains ${totalEntries} archive entries, exceeding the ${maxEntries}-entry safety limit.`,
    );
  }
  if (centralDirOffset > eocdOffset || centralDirSize > eocdOffset - centralDirOffset) {
    throw new DocConvertError("INVALID_DOCX_ARCHIVE", "This Word (.docx) archive directory is out of bounds.");
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: ZipEntryMeta[] = [];
  const seenCanonicalNames = new Set<string>();
  const cdEnd = centralDirOffset + centralDirSize;
  let cursor = centralDirOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let hasWordDocumentXml = false;

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > cdEnd || view.getUint32(cursor, true) !== CENTRAL_DIR_HEADER_SIG) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "This Word (.docx) archive contains an invalid directory entry.",
      );
    }
    const flags = view.getUint16(cursor + 8, true);
    if ((flags & 0x01) !== 0 || (flags & 0x40) !== 0) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "Password-protected or encrypted Word archives cannot be opened in the browser.",
      );
    }
    const compressionMethod = view.getUint16(cursor + 10, true);
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "This Word (.docx) archive uses an unsupported compression method.",
      );
    }
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const fileNameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const headerEnd = cursor + 46 + fileNameLen + extraLen + commentLen;
    if (headerEnd > cdEnd) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "This Word (.docx) archive contains a truncated directory entry.",
      );
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new DocConvertError("ZIP_UNCOMPRESSED_TOO_LARGE", "Oversized ZIP64 entries are not permitted.");
    }
    if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "Stored ZIP entry has mismatched compressed and uncompressed sizes.",
      );
    }

    const rawName = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + fileNameLen));
    if (isUnsafeZipPath(rawName)) {
      throw new DocConvertError(
        "ZIP_UNSAFE_ENTRY_PATH",
        "This archive contains an unsafe entry path and was blocked.",
      );
    }
    const canonicalName = rawName.replace(/\\/g, "/");
    const canonicalKey = canonicalName.toLowerCase();
    if (seenCanonicalNames.has(canonicalKey)) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "This Word (.docx) archive contains duplicate entry names and was blocked.",
      );
    }
    seenCanonicalNames.add(canonicalKey);

    // Local File Header coherence and bounds check against Central Directory.
    if (
      localHeaderOffset >= centralDirOffset ||
      localHeaderOffset + 30 > centralDirOffset ||
      view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIG
    ) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "This Word (.docx) archive has an out-of-bounds or invalid local file header.",
      );
    }
    const localFlags = view.getUint16(localHeaderOffset + 6, true);
    const localMethod = view.getUint16(localHeaderOffset + 8, true);
    const localCompressed = view.getUint32(localHeaderOffset + 18, true);
    const localUncompressed = view.getUint32(localHeaderOffset + 22, true);
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);

    if ((localFlags & 0x01) !== 0 || (localFlags & 0x40) !== 0 || localMethod !== compressionMethod) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "This Word (.docx) archive has inconsistent local and central header flags.",
      );
    }
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > centralDirOffset || dataEnd > centralDirOffset || localNameLen !== fileNameLen) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "This Word (.docx) archive contains an entry whose payload exceeds member bounds.",
      );
    }
    const localName = decoder.decode(bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLen));
    if (localName !== rawName) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "This Word (.docx) archive has mismatched local and central entry names.",
      );
    }
    const hasDataDescriptor = (localFlags & 0x08) !== 0;
    if (
      !hasDataDescriptor &&
      (localCompressed !== compressedSize || localUncompressed !== uncompressedSize)
    ) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "This Word (.docx) archive has mismatched local and central entry sizes.",
      );
    }

    if (uncompressedSize > maxSingleEntry) {
      throw new DocConvertError(
        "ZIP_UNCOMPRESSED_TOO_LARGE",
        "An entry inside this Word document exceeds the safe uncompressed size limit.",
      );
    }
    if (
      uncompressedSize > RATIO_MIN_UNCOMPRESSED_BYTES &&
      (compressedSize === 0 || uncompressedSize / compressedSize > maxRatio)
    ) {
      throw new DocConvertError(
        "ZIP_COMPRESSION_RATIO_EXCEEDED",
        "This document's compression ratio exceeds safe expansion limits and cannot be opened in the browser.",
      );
    }

    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxTotalUncompressed) {
      throw new DocConvertError(
        "ZIP_UNCOMPRESSED_TOO_LARGE",
        "This Word document expands beyond the 50 MB safety limit.",
      );
    }

    if (canonicalName === "word/document.xml") {
      hasWordDocumentXml = true;
    }

    entries.push({
      name: canonicalName,
      compressionMethod,
      generalPurposeFlags: flags,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataStart,
      dataEnd,
    });
    cursor = headerEnd;
  }

  if (cursor !== cdEnd) {
    throw new DocConvertError(
      "INVALID_DOCX_ARCHIVE",
      "This Word (.docx) archive directory size does not match its entries.",
    );
  }

  // Verify member spans [localHeaderOffset, memberEnd) do not overlap and stay within [0, centralDirOffset].
  const sortedByOffset = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  let previousEnd = 0;
  for (const entry of sortedByOffset) {
    if (entry.localHeaderOffset < previousEnd) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "This Word (.docx) archive contains overlapping member spans.",
      );
    }
    let memberEnd = entry.dataEnd;
    if ((entry.generalPurposeFlags & 0x08) !== 0 && memberEnd + 12 <= centralDirOffset) {
      const maybeSig = view.getUint32(memberEnd, true);
      memberEnd += maybeSig === DATA_DESCRIPTOR_SIG && memberEnd + 16 <= centralDirOffset ? 16 : 12;
    }
    if (memberEnd > centralDirOffset) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "This Word (.docx) archive member extends into the central directory.",
      );
    }
    previousEnd = memberEnd;
  }

  if (
    totalUncompressed > RATIO_MIN_UNCOMPRESSED_BYTES &&
    (totalCompressed === 0 || totalUncompressed / Math.max(1, totalCompressed) > maxRatio)
  ) {
    throw new DocConvertError(
      "ZIP_COMPRESSION_RATIO_EXCEEDED",
      "This document's overall compression ratio exceeds safe expansion limits.",
    );
  }

  if (!hasWordDocumentXml) {
    throw new DocConvertError(
      "INVALID_DOCX_ARCHIVE",
      "This archive does not contain a Word document body (word/document.xml).",
    );
  }

  return {
    entryCount: entries.length,
    totalCompressedBytes: totalCompressed,
    totalUncompressedBytes: totalUncompressed,
    entries,
  };
}

async function inflateDeflateRawBounded(
  compressedSlice: Uint8Array,
  maxBytes: number,
  retainBytes: boolean,
  signal?: AbortSignal,
): Promise<{ actualLength: number; bytes: Uint8Array | null }> {
  if (typeof DecompressionStream === "undefined") {
    throw new DocConvertError(
      "INVALID_DOCX_ARCHIVE",
      "Browser decompression support (DecompressionStream) is unavailable.",
    );
  }

  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const writePromise = writer
    .write(new Uint8Array(toOwnedArrayBuffer(compressedSlice)))
    .then(() => writer.close())
    .catch(() => {
      // Handled on the readable side when stream aborts or corrupts
    });

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        await writer.abort().catch(() => {});
        throw new DocConvertError(
          "CONVERSION_TIMEOUT",
          "Converting this document took too long and was stopped.",
        );
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          await writer.abort().catch(() => {});
          throw new DocConvertError(
            "ZIP_UNCOMPRESSED_TOO_LARGE",
            "Actual decompressed size exceeds safe browser limits.",
          );
        }
        if (retainBytes) {
          chunks.push(value);
        }
      }
    }
    await writePromise;
  } catch (err) {
    if (err instanceof DocConvertError) throw err;
    throw new DocConvertError(
      "INVALID_DOCX_ARCHIVE",
      "This Word (.docx) archive contains a corrupted compressed stream.",
    );
  }

  if (!retainBytes) {
    return { actualLength: total, bytes: null };
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { actualLength: total, bytes: merged };
}

/**
 * Performs actual bounded stream inflation across every entry in the archive so a spoofed Central Directory
 * cannot lie about uncompressed byte count or compression ratio. Returns decoded `word/document.xml` text.
 */
export async function verifyZipActualInflation(
  archive: Uint8Array,
  inspection: ZipInspectionResult,
  options?: ZipGuardOptions,
  signal?: AbortSignal,
): Promise<{ documentXml: string | null }> {
  const maxTotalUncompressed = options?.maxTotalUncompressedBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;
  const maxSingleEntry = options?.maxSingleEntryBytes ?? MAX_ZIP_SINGLE_ENTRY_BYTES;
  const maxRatio = options?.maxCompressionRatio ?? MAX_ZIP_COMPRESSION_RATIO;

  let cumulativeActual = 0;
  let documentXml: string | null = null;

  for (const entry of inspection.entries) {
    if (signal?.aborted) {
      throw new DocConvertError(
        "CONVERSION_TIMEOUT",
        "Converting this document took too long and was stopped.",
      );
    }
    const remainingBudget = maxTotalUncompressed - cumulativeActual;
    if (remainingBudget < 0) {
      throw new DocConvertError(
        "ZIP_UNCOMPRESSED_TOO_LARGE",
        "This Word document expands beyond the 50 MB safety limit.",
      );
    }
    const entryBudget = Math.min(maxSingleEntry, remainingBudget);
    const slice = archive.subarray(entry.dataStart, entry.dataEnd);
    const isDocXml = entry.name === "word/document.xml";

    let actualLength: number;
    let rawXmlBytes: Uint8Array | null = null;

    if (entry.compressionMethod === 0) {
      actualLength = slice.byteLength;
      if (actualLength > entryBudget) {
        throw new DocConvertError(
          "ZIP_UNCOMPRESSED_TOO_LARGE",
          "An entry inside this Word document exceeds the safe uncompressed size limit.",
        );
      }
      if (isDocXml) rawXmlBytes = slice;
    } else {
      const inflated = await inflateDeflateRawBounded(slice, entryBudget, isDocXml, signal);
      actualLength = inflated.actualLength;
      rawXmlBytes = inflated.bytes;
    }

    if (actualLength !== entry.uncompressedSize) {
      throw new DocConvertError(
        "INVALID_DOCX_ARCHIVE",
        "This Word (.docx) archive declared an uncompressed size that does not match its actual stream.",
      );
    }
    if (
      actualLength > RATIO_MIN_UNCOMPRESSED_BYTES &&
      (entry.compressedSize === 0 || actualLength / entry.compressedSize > maxRatio)
    ) {
      throw new DocConvertError(
        "ZIP_COMPRESSION_RATIO_EXCEEDED",
        "This document's actual compression ratio exceeds safe expansion limits.",
      );
    }

    cumulativeActual += actualLength;
    if (cumulativeActual > maxTotalUncompressed) {
      throw new DocConvertError(
        "ZIP_UNCOMPRESSED_TOO_LARGE",
        "This Word document expands beyond the 50 MB safety limit.",
      );
    }

    if (isDocXml && rawXmlBytes && rawXmlBytes.byteLength <= 8 * 1024 * 1024) {
      documentXml = new TextDecoder("utf-8", { fatal: false }).decode(rawXmlBytes);
    }
  }

  if (
    cumulativeActual > RATIO_MIN_UNCOMPRESSED_BYTES &&
    (inspection.totalCompressedBytes === 0 ||
      cumulativeActual / Math.max(1, inspection.totalCompressedBytes) > maxRatio)
  ) {
    throw new DocConvertError(
      "ZIP_COMPRESSION_RATIO_EXCEEDED",
      "This document's overall compression ratio exceeds safe expansion limits.",
    );
  }

  return { documentXml };
}

const UNSUPPORTED_CATALOG: Record<DocxUnsupportedFeatureKey, DocxUnsupportedFeature> = {
  headers_footers: {
    key: "headers_footers",
    label: "Headers and footers",
    detail: "Running page headers and footers are not shown in the editor and will not be included in a saved version.",
  },
  tracked_changes: {
    key: "tracked_changes",
    label: "Tracked changes",
    detail: "Word revision marks (insertions, deletions, and formatting changes) are flattened rather than kept as reviewable revisions.",
  },
  comments: {
    key: "comments",
    label: "Comments",
    detail: "Margin comments and reply threads are not preserved when saving a new version.",
  },
  text_boxes: {
    key: "text_boxes",
    label: "Text boxes and shapes",
    detail: "Floating text boxes and drawing shapes are not preserved in their positioned layout.",
  },
  footnotes_endnotes: {
    key: "footnotes_endnotes",
    label: "Footnotes and endnotes",
    detail: "Footnote and endnote references are simplified and will not round-trip as native Word notes.",
  },
  complex_fields: {
    key: "complex_fields",
    label: "Complex fields and content controls",
    detail: "Dynamic Word fields (such as page numbers, tables of contents, or form controls) become static text.",
  },
  embedded_objects: {
    key: "embedded_objects",
    label: "Charts, SmartArt, or embedded objects",
    detail: "Embedded charts, SmartArt diagrams, and OLE objects are not preserved.",
  },
};

/**
 * Inspects OOXML archive entries and verified `word/document.xml` text to report unsupported Word features (D9).
 */
export function detectDocxUnsupportedFeaturesFromXml(
  inspection: ZipInspectionResult,
  documentXml: string | null,
): DocxUnsupportedFeature[] {
  const found = new Set<DocxUnsupportedFeatureKey>();

  for (const entry of inspection.entries) {
    const lower = entry.name.toLowerCase();
    if (/^word\/(?:header|footer)\d*\.xml$/.test(lower)) {
      found.add("headers_footers");
    }
    if (/^word\/comments(?:extended|ids)?\.xml$/.test(lower)) {
      found.add("comments");
    }
    if (
      lower.startsWith("word/charts/") ||
      lower.startsWith("word/diagrams/") ||
      lower.startsWith("word/embeddings/")
    ) {
      found.add("embedded_objects");
    }
  }

  if (documentXml) {
    if (/<w:(?:headerReference|footerReference)\b/.test(documentXml)) {
      found.add("headers_footers");
    }
    if (/<w:(?:ins|del|moveFrom|moveTo|rPrChange|pPrChange|tblPrChange)\b/.test(documentXml)) {
      found.add("tracked_changes");
    }
    if (/<w:(?:commentRangeStart|commentReference)\b/.test(documentXml)) {
      found.add("comments");
    }
    if (/<(?:w:txbxContent|v:textbox|wps:txbx)\b/.test(documentXml)) {
      found.add("text_boxes");
    }
    if (/<w:(?:footnoteReference|endnoteReference)\b/.test(documentXml)) {
      found.add("footnotes_endnotes");
    }
    if (/<w:(?:fldSimple|fldChar|sdt)\b/.test(documentXml)) {
      found.add("complex_fields");
    }
    if (/<(?:w:object|c:chart|dgm:relIds)\b/.test(documentXml)) {
      found.add("embedded_objects");
    }
  }

  const order: DocxUnsupportedFeatureKey[] = [
    "headers_footers",
    "tracked_changes",
    "comments",
    "text_boxes",
    "footnotes_endnotes",
    "complex_fields",
    "embedded_objects",
  ];
  return order.filter((k) => found.has(k)).map((k) => UNSUPPORTED_CATALOG[k]);
}

export function assertPdfHeader(bytes: Uint8Array): void {
  const limit = Math.min(bytes.byteLength, 1024);
  for (let i = 0; i <= limit - 5; i += 1) {
    if (
      bytes[i] === 0x25 && // %
      bytes[i + 1] === 0x50 && // P
      bytes[i + 2] === 0x44 && // D
      bytes[i + 3] === 0x46 && // F
      bytes[i + 4] === 0x2d // -
    ) {
      return;
    }
  }
  throw new DocConvertError("INVALID_PDF_HEADER", "This file is not a valid PDF document.");
}

export async function withConversionTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_CONVERT_TIMEOUT_MS,
  onTimeout?: () => void,
): Promise<T> {
  const effectiveMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(Math.floor(timeoutMs), 60_000)
      : DEFAULT_CONVERT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      try {
        onTimeout?.();
      } catch {
        // ignore cleanup errors
      }
      reject(
        new DocConvertError(
          "CONVERSION_TIMEOUT",
          "Converting this document took too long and was stopped. Try a smaller or simpler file.",
        ),
      );
    }, effectiveMs);
  });

  try {
    return await Promise.race([work(controller.signal), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
