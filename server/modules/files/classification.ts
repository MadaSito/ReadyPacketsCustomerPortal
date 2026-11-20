import { fileTypeFromBuffer } from "file-type";
import { validation } from "../../core/errors.js";

export type FileReader = (offset: number, length: number) => Promise<Buffer>;
export type FileClassification = { extension: string; mime: string };
export const allowedExtensions = ["pdf", "png", "jpg", "wav", "webm", "mp4", "m4a", "ogg"] as const;
export type FileExtension = (typeof allowedExtensions)[number];

const signature = (input: Buffer, offset: number, text: string) =>
  input.subarray(offset, offset + text.length).equals(Buffer.from(text, "latin1"));

/** Canonicalizes only recognized aliases, never inferred MIME supplied by a client. */
export function displayExtension(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

export function sanitizeDisplayName(value: string): string {
  const text = value.normalize("NFC")
    .replace(/[\p{C}\\/:*?"<>|]/gu, "_")
    .trim()
    .replace(/^[. ]+|[. ]+$/gu, "");
  const unixName = Array.from(text).slice(0, 180).join("");
  if (!unixName || !unixName.includes(".")) throw validation("INVALID_FILE_NAME", "Choose a file with a supported extension.");
  return unixName;
}

function vint(buf: Buffer, offset: number, id: boolean): { value: number; width: number; unknown: boolean } | null {
  const first = buf[offset];
  if (!first) return null;
  let width = 1;
  let mask = 128;
  while (!(first & mask)) {
    mask >>= 1;
    width++;
  }
  if (width > (id ? 4 : 8) || offset + width > buf.length) return null;
  let value = BigInt(id ? first : first & (mask - 1));
  for (let i = 1; i < width; i++) value = (value << 8n) | BigInt(buf[offset + i]!);
  const unknown = !id && value === (1n << BigInt(width * 7)) - 1n;
  return value > BigInt(Number.MAX_SAFE_INTEGER) && !unknown ? null : { value: Number(value), width, unknown };
}

async function webm(read: FileReader, size: number): Promise<FileClassification | null> {
  let iterations = 0;
  async function* children(start: number, end: number, streamRoot = false) {
    while (start < end) {
      if (++iterations > 50_000) throw new MalformedMedia();
      const head = await read(start, Math.min(12, end - start));
      const id = vint(head, 0, true);
      const length = id && vint(head, id.width, false);
      if (!id || !length) throw new MalformedMedia();
      const dataStart = start + id.width + length.width;
      if (length.unknown && (!streamRoot || ![0x18538067, 0x1f43b675].includes(id.value))) throw new MalformedMedia();
      const dataEnd = length.unknown ? end : dataStart + length.value;
      if (dataEnd > end || dataEnd <= start) throw new MalformedMedia();
      yield { id: id.value, start: dataStart, end: dataEnd };
      start = dataEnd;
    }
  }
  let header = false;
  let segment = false;
  let audio = false;
  let video = false;
  let cluster = false;
  for await (const root of children(0, size, true)) {
    if (!header && root.id === 0x1a45dfa3) {
      for await (const entry of children(root.start, root.end)) {
        if (entry.id === 0x4282 && entry.end - entry.start === 4) header = signature(await read(entry.start, 4), 0, "webm");
      }
    } else if (header && !segment && root.id === 0x18538067) {
      segment = true;
      for await (const part of children(root.start, root.end, true)) {
        if (part.id === 0x1f43b675) {
          const permitted = new Set([0xe7, 0x5854, 0xa7, 0xab, 0xa3, 0xa0, 0xec, 0xbf]);
          for await (const entry of children(part.start, part.end)) {
            if (!permitted.has(entry.id)) throw new MalformedMedia();
            if (entry.id === 0xa3 || entry.id === 0xa0) cluster ||= entry.end - entry.start > 3;
          }
        }
        if (part.id !== 0x1654ae6b) {
          if (![0x114d9b74, 0x1549a966, 0x1f43b675, 0x1c53bb6b, 0x1254c367, 0xec, 0xbf].includes(part.id)) {
            throw new MalformedMedia();
          }
          continue;
        }
        if (cluster) throw new MalformedMedia();
        for await (const track of children(part.start, part.end)) {
          if (track.id !== 0xae) continue;
          let type: number | undefined;
          let codec = "";
          for await (const field of children(track.start, track.end)) {
            const len = field.end - field.start;
            if (field.id === 0x83 && len === 1) type = (await read(field.start, 1))[0];
            if (field.id === 0x86 && len > 0 && len <= 32) codec = (await read(field.start, len)).toString("ascii");
          }
          if (type === 1 && ["V_VP8", "V_VP9", "V_AV1"].includes(codec)) video = true;
          else if (type === 2 && ["A_OPUS", "A_VORBIS"].includes(codec)) audio = true;
          else throw new MalformedMedia();
        }
      }
    } else throw new MalformedMedia();
  }
  return header && segment && cluster && (video || audio) ? { extension: "webm", mime: video ? "video/webm" : "audio/webm" } : null;
}

class MalformedMedia extends Error {}

async function mp4(read: FileReader, size: number, head: Buffer): Promise<FileClassification | null> {
  let iterations = 0;
  async function* boxes(start: number, end: number) {
    while (start < end) {
      if (++iterations > 4096 || end - start < 8) throw new MalformedMedia();
      const header = await read(start, Math.min(16, end - start));
      let bytes = header.readUInt32BE(0);
      const name = header.toString("latin1", 4, 8);
      let length = 8;
      if (bytes === 1) {
        if (header.length < 16) throw new MalformedMedia();
        const extended = header.readBigUInt64BE(8);
        if (extended > BigInt(end - start)) throw new MalformedMedia();
        bytes = Number(extended);
        length = 16;
      }
      if (bytes < length || bytes > end - start || !/^[\x20-\x7e]{4}$/u.test(name)) throw new MalformedMedia();
      yield { name, start: start + length, end: start + bytes };
      start += bytes;
    }
  }
  const brand = head.toString("ascii", 8, 12);
  if (!/^(isom|iso[2-9]|mp4[12]|avc1|dash|M4A |M4V |MSNV|3gp[456])/u.test(brand)) return null;
  let audio = false;
  let video = false;
  let media = false;
  let movie = false;
  let fileType = false;
  for await (const top of boxes(0, size)) {
    if (!["ftyp", "moov", "mdat", "moof", "free", "skip", "wide", "sidx", "mfra", "styp", "prft", "emsg", "pdin"].includes(top.name)) return null;
    if (top.name === "ftyp") {
      if (fileType || top.start !== 8 || top.end - top.start < 8 || (top.end - top.start) % 4 !== 0) return null;
      fileType = true;
    }
    if (top.name === "mdat") media ||= top.end > top.start;
    if (top.name !== "moov") continue;
    if (movie) return null;
    movie = true;
    for await (const track of boxes(top.start, top.end)) {
      if (track.name !== "trak") continue;
      for await (const mdia of boxes(track.start, track.end)) {
        if (mdia.name !== "mdia") continue;
        for await (const handler of boxes(mdia.start, mdia.end)) {
          if (handler.name !== "hdlr") continue;
          if (handler.end - handler.start < 12) return null;
          const body = await read(handler.start + 8, 4);
          audio ||= signature(body, 0, "soun");
          video ||= signature(body, 0, "vide");
        }
      }
    }
  }
  if (!fileType || !media || !movie || (!audio && !video) || (brand === "M4A " && video)) return null;
  return video ? { extension: "mp4", mime: "video/mp4" } : { extension: "m4a", mime: "audio/mp4" };
}

async function ogg(read: FileReader, size: number): Promise<FileClassification | null> {
  let offset = 0;
  let pages = 0;
  let audio = false;
  let video = false;
  const serials = new Map<number, { index: number; ended: boolean }>();
  while (offset < size) {
    if (++pages > 12000 || size - offset < 27) return null;
    const header = await read(offset, 27);
    if (!signature(header, 0, "OggS") || header[4] !== 0 || header[5]! > 7) return null;
    const flags = header[5]!;
    const lacingSize = header[26]!;
    const serial = header.readUInt32LE(14);
    const index = header.readUInt32LE(18);
    const dataOffset = offset + 27 + lacingSize;
    if (dataOffset > size || lacingSize === 0) return null;
    const lacing = await read(offset + 27, lacingSize);
    const dataSize = lacing.reduce((total, length) => total + length, 0);
    if (dataOffset + dataSize > size) return null;
    const existing = serials.get(serial);
    if (flags & 2) {
      if (existing || index !== 0 || flags & 1 || serials.size >= 16) return null;
      const magic = await read(dataOffset, Math.min(12, lacing[0]!));
      if (signature(magic, 0, "OpusHead") || signature(magic, 0, "\x01vorbis") ||
          signature(magic, 0, "\x7fFLAC") || signature(magic, 0, "Speex   ")) audio = true;
      else if (signature(magic, 0, "\x80theora")) video = true;
      else return null;
    } else if (!existing || existing.ended || index !== existing.index + 1) return null;
    serials.set(serial, { index, ended: Boolean(flags & 4) });
    offset = dataOffset + dataSize;
  }
  return (audio || video) && [...serials.values()].every((stream) => stream.ended)
    ? { extension: "ogg", mime: video ? "video/ogg" : "audio/ogg" } : null;
}

async function png(read: FileReader, size: number): Promise<boolean> {
  let offset = 8;
  let count = 0;
  let image = false;
  const allow = new Set(["IHDR", "PLTE", "IDAT", "IEND", "sRGB", "cHRM", "gAMA", "pHYs", "tRNS", "iCCP", "sBIT", "bKGD"]);
  while (offset + 12 <= size && ++count <= 8192) {
    const header = await read(offset, 8);
    const bytes = header.readUInt32BE(0);
    const name = header.toString("ascii", 4);
    offset += bytes + 12;
    if (offset > size || !allow.has(name) || ((count === 1) !== (name === "IHDR"))) return false;
    if (name === "IHDR" && bytes !== 13) return false;
    if (name === "IDAT" && bytes > 0) image = true;
    if (name === "IEND") return image && bytes === 0 && offset === size;
  }
  return false;
}

async function jpeg(read: FileReader, size: number, head: Buffer): Promise<boolean> {
  if (head.length < 4 || !(await read(size - 2, 2)).equals(Buffer.from([255, 217]))) return false;
  // Read through the stream to ensure there is only one end-of-image marker after the first scan.
  let pos = 2;
  let headers = 0;
  while (pos + 4 <= size && ++headers <= 1024) {
    const marker = await read(pos, 4);
    if (marker[0] !== 255 || marker[1] === 217 || marker[1] === 216) return false;
    const length = marker.readUInt16BE(2);
    if (length < 2 || pos + 2 + length >= size) return false;
    const start = marker[1] === 218;
    pos += 2 + length;
    if (start) {
      let ff = false;
      while (pos < size) {
        const chunk = await read(pos, Math.min(32768, size - pos));
        for (const [index, byte] of chunk.entries()) {
          if (ff && byte === 217) return pos + index === size - 1;
          ff = byte === 255;
        }
        pos += chunk.length;
      }
      break;
    }
  }
  return false;
}

async function wav(read: FileReader, size: number, head: Buffer): Promise<boolean> {
  if (head.length < 12 || head.readUInt32LE(4) + 8 !== size || !signature(head, 8, "WAVE")) return false;
  let offset = 12;
  let count = 0;
  let fmt = false;
  let data = false;
  while (offset + 8 <= size && ++count <= 1024) {
    const header = await read(offset, 8);
    const label = header.toString("ascii", 0, 4);
    const bytes = header.readUInt32LE(4);
    if (label === "fmt " && !fmt && [16, 18, 40].includes(bytes)) fmt = true;
    else if (label === "data" && fmt && !data && bytes > 0) data = true;
    else if (!["fact", "LIST", "JUNK", "bext", "cue "].includes(label)) return false;
    offset += 8 + bytes + (bytes % 2);
  }
  return fmt && data && offset === size;
}

// These conservative PDF gates are not content disarm, a renderer, or a malware scanner.
async function passivePdf(read: FileReader, size: number): Promise<boolean> {
  const tail = (await read(Math.max(0, size - 1024), Math.min(1024, size))).toString("latin1");
  const trailer = /startxref\s+(\d{1,10})\s+%%EOF[\t\n\f\r ]*$/u.exec(tail);
  if (!trailer) return false;
  const xref = Number(trailer[1]);
  if (xref < 8 || xref + 5 >= size || !/^xref[\r\n \t]$/u.test((await read(xref, 5)).toString("ascii"))) return false;
  let overlap = "";
  for (let offset = 0; offset < size;) {
    const bytes = await read(offset, Math.min(32768, size - offset));
    const sample = overlap + bytes.toString("latin1");
    const decoded = sample.replace(/#([0-9a-f]{2})/giu, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
    if (/\/(?:JavaScript|JS|AA|OpenAction|Launch|EmbeddedFile|Filespec|Encrypt|ObjStm|RichMedia|XFA)\b|<\s*(?:script|html|svg)\b/iu.test(decoded)) return false;
    overlap = sample.slice(-96);
    offset += bytes.length;
  }
  return true;
}

/** Used for all admissions, including portable imports. Baseline rejects unknown/signature-less types. */
export async function classifyFile(reader: FileReader, size: number): Promise<FileClassification | null> {
  if (!Number.isSafeInteger(size) || size < 4 || size > 512 * 1024 * 1024) return null;
  const read: FileReader = async (offset, length) => {
    if (offset < 0 || length < 0 || offset + length > size) throw new MalformedMedia();
    if (length === 0) return Buffer.alloc(0);
    const result = await reader(offset, length);
    if (result.length !== length) throw new MalformedMedia();
    return result;
  };
  try {
    const head = await read(0, Math.min(size, 8192));
    if (signature(head, 0, "\x1a\x45\xdf\xa3")) return await webm(read, size);
    if (head.length >= 16 && signature(head, 4, "ftyp")) return await mp4(read, size, head);
    if (signature(head, 0, "OggS")) return await ogg(read, size);
    const kind = await fileTypeFromBuffer(head).catch(() => undefined);
    if (!kind) return null;
    if (kind.ext === "pdf" && signature(head, 0, "%PDF-") && await passivePdf(read, size)) return { extension: "pdf", mime: kind.mime };
    if (kind.ext === "png" && await png(read, size)) return { extension: "png", mime: kind.mime };
    if (kind.ext === "jpg" && await jpeg(read, size, head)) return { extension: "jpg", mime: kind.mime };
    if (kind.ext === "wav" && await wav(read, size, head)) return { extension: "wav", mime: kind.mime };
    return null;
  } catch (error) {
    if (error instanceof MalformedMedia) return null;
    throw error;
  }
}

export function acceptsDeclaredType(actual: FileClassification, mime: string): boolean {
  if (actual.mime === mime) return true;
  // Legacy declared aliases are trusted only after bytes have been independently classified.
  if (actual.extension === "webm") return mime === "audio/webm" || mime === "video/webm";
  if (actual.extension === "m4a") return mime === "audio/x-m4a";
  if (actual.extension === "ogg") return mime === "application/ogg";
  return false;
}
