/**
 * Validated image path for sign-in slideshow uploads. Owner: platform engineer.
 *
 * Accepts only PNG, JPEG and WebP identified by their actual structure (not the filename or the declared
 * content type), bounded size and dimensions. Metadata that commonly carries personal data (EXIF/XMP/text
 * chunks, incl. GPS) is removed from PNG and JPEG; WebP files carrying EXIF/XMP are refused.
 * This is structural validation, NOT a malware scan; images are only ever served with nosniff and a
 * `default-src 'none'` CSP from a non-HTML content type.
 */

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;
export const MIN_IMAGE_DIMENSION = 16;

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export type ImageRejection =
  | "EMPTY"
  | "TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "MALFORMED"
  | "DIMENSIONS_OUT_OF_RANGE"
  | "METADATA_NOT_ALLOWED";

export type ImageValidation =
  | { ok: true; mime: ImageMime; width: number; height: number; bytes: Buffer }
  | { ok: false; reason: ImageRejection };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

function bounded(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= MIN_IMAGE_DIMENSION &&
    height >= MIN_IMAGE_DIMENSION &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION
  );
}

function validatePng(input: Buffer): ImageValidation {
  if (input.length < 33) return { ok: false, reason: "MALFORMED" };
  const kept: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIend = false;
  let sawIdat = false;
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || length > input.length || end > input.length) return { ok: false, reason: "MALFORMED" };
    if (!sawIhdr) {
      if (type !== "IHDR" || length !== 13) return { ok: false, reason: "MALFORMED" };
      width = input.readUInt32BE(offset + 8);
      height = input.readUInt32BE(offset + 12);
      sawIhdr = true;
    }
    if (type === "IDAT") sawIdat = true;
    if (!PNG_DROP.has(type)) kept.push(input.subarray(offset, end));
    offset = end;
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }
  if (!sawIhdr || !sawIend || !sawIdat) return { ok: false, reason: "MALFORMED" };
  if (!bounded(width, height)) return { ok: false, reason: "DIMENSIONS_OUT_OF_RANGE" };
  return { ok: true, mime: "image/png", width, height, bytes: Buffer.concat(kept) };
}

/** Markers without a length field. */
const isStandalone = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

/**
 * Walks the WHOLE marker sequence (including segments between progressive scans) and rebuilds the file:
 * APP1..APP15 and COM are dropped wherever they appear, entropy-coded data is copied, anything after EOI
 * is discarded. Requires SOI, a frame header (SOF) before the first scan, at least one SOS and an EOI.
 */
function validateJpeg(input: Buffer): ImageValidation {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return { ok: false, reason: "MALFORMED" };
  const kept: Buffer[] = [input.subarray(0, 2)];
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawSof = false;
  let scans = 0;
  let segments = 0;
  while (offset + 2 <= input.length) {
    if (++segments > 4096) return { ok: false, reason: "MALFORMED" };
    if (input[offset] !== 0xff) return { ok: false, reason: "MALFORMED" };
    const marker = input[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      if (!sawSof || scans === 0) return { ok: false, reason: "MALFORMED" };
      kept.push(input.subarray(offset, offset + 2)); // EOI; trailing bytes are dropped
      if (!bounded(width, height)) return { ok: false, reason: "DIMENSIONS_OUT_OF_RANGE" };
      return { ok: true, mime: "image/jpeg", width, height, bytes: Buffer.concat(kept) };
    }
    if (marker === 0xd8 || isStandalone(marker) || marker === 0x00) return { ok: false, reason: "MALFORMED" };
    if (offset + 4 > input.length) return { ok: false, reason: "MALFORMED" };
    const length = input.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > input.length) return { ok: false, reason: "MALFORMED" };
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (sawSof || length < 8) return { ok: false, reason: "MALFORMED" };
      height = input.readUInt16BE(offset + 5);
      width = input.readUInt16BE(offset + 7);
      sawSof = true;
    }
    // Drop APP1..APP15 (EXIF, XMP, ICC, vendor blobs) and COM comments. Keep APP0 (JFIF).
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) kept.push(input.subarray(offset, end));
    offset = end;
    if (marker === 0xda) {
      if (!sawSof) return { ok: false, reason: "MALFORMED" };
      scans += 1;
      // Entropy-coded data runs until a marker other than stuffing (FF00), restart (FFD0-D7) or fill.
      let scan = offset;
      while (scan + 1 < input.length) {
        if (input[scan] === 0xff) {
          const next = input[scan + 1]!;
          if (next === 0x00 || isStandalone(next)) {
            scan += 2;
            continue;
          }
          if (next === 0xff) {
            scan += 1;
            continue;
          }
          break;
        }
        scan += 1;
      }
      if (scan + 1 >= input.length) return { ok: false, reason: "MALFORMED" };
      kept.push(input.subarray(offset, scan));
      offset = scan;
    }
  }
  return { ok: false, reason: "MALFORMED" };
}

const WEBP_ALLOWED = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ICCP"]);

function webpChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "latin1");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/**
 * Still images only: exactly one VP8/VP8L frame, optional VP8X/ALPH. Animation, EXIF/XMP and unknown
 * chunks are refused; ICC profiles are dropped. The container is rebuilt from the accepted chunks.
 */
function validateWebp(input: Buffer): ImageValidation {
  if (input.length < 25) return { ok: false, reason: "MALFORMED" };
  const riffSize = input.readUInt32LE(4);
  if (riffSize + 8 !== input.length) return { ok: false, reason: "MALFORMED" };
  let offset = 12;
  let width = 0;
  let height = 0;
  let index = 0;
  let frames = 0;
  let vp8x: Buffer | null = null;
  const kept: Buffer[] = [];
  while (offset + 8 <= input.length) {
    if (index > 16) return { ok: false, reason: "MALFORMED" };
    const type = input.toString("latin1", offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const data = offset + 8;
    const end = data + size + (size % 2);
    if (end > input.length) return { ok: false, reason: "MALFORMED" };
    if (type === "EXIF" || type === "XMP ") return { ok: false, reason: "METADATA_NOT_ALLOWED" };
    if (!WEBP_ALLOWED.has(type)) return { ok: false, reason: type === "ANIM" || type === "ANMF" ? "UNSUPPORTED_TYPE" : "MALFORMED" };
    const payload = input.subarray(data, data + size);
    if (type === "VP8X") {
      if (index !== 0 || size < 10) return { ok: false, reason: "MALFORMED" };
      if (payload[0]! & 0x02) return { ok: false, reason: "UNSUPPORTED_TYPE" }; // animation
      if (payload[0]! & 0x0c) return { ok: false, reason: "METADATA_NOT_ALLOWED" };
      width = 1 + payload.readUIntLE(4, 3);
      height = 1 + payload.readUIntLE(7, 3);
      vp8x = Buffer.from(payload);
      vp8x[0] = vp8x[0]! & 0x10; // keep only the alpha flag (ICC dropped)
    } else if (type === "VP8 " || type === "VP8L") {
      frames += 1;
      if (frames > 1) return { ok: false, reason: "UNSUPPORTED_TYPE" };
      let w: number;
      let h: number;
      if (type === "VP8 ") {
        if (size < 10 || payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) return { ok: false, reason: "MALFORMED" };
        w = payload.readUInt16LE(6) & 0x3fff;
        h = payload.readUInt16LE(8) & 0x3fff;
      } else {
        if (size < 5 || payload[0] !== 0x2f) return { ok: false, reason: "MALFORMED" };
        const bits = payload.readUInt32LE(1);
        w = (bits & 0x3fff) + 1;
        h = ((bits >> 14) & 0x3fff) + 1;
      }
      if (vp8x && (w !== width || h !== height)) return { ok: false, reason: "MALFORMED" };
      width = w;
      height = h;
      kept.push(webpChunk(type, payload));
    } else if (type === "ALPH") {
      if (!vp8x || frames > 0) return { ok: false, reason: "MALFORMED" };
      kept.push(webpChunk(type, payload));
    }
    // ICCP: dropped
    offset = end;
    index += 1;
  }
  if (offset !== input.length || frames !== 1) return { ok: false, reason: "MALFORMED" };
  if (!bounded(width, height)) return { ok: false, reason: "DIMENSIONS_OUT_OF_RANGE" };
  const chunks = vp8x ? [webpChunk("VP8X", vp8x), ...kept] : kept;
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length, 4);
  return { ok: true, mime: "image/webp", width, height, bytes: Buffer.concat([header, body]) };
}

export function validateImage(input: Buffer): ImageValidation {
  if (input.length === 0) return { ok: false, reason: "EMPTY" };
  if (input.length > MAX_IMAGE_BYTES) return { ok: false, reason: "TOO_LARGE" };
  try {
    if (input.subarray(0, 8).equals(PNG_SIGNATURE)) return validatePng(input);
    if (input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return validateJpeg(input);
    if (input.toString("latin1", 0, 4) === "RIFF" && input.toString("latin1", 8, 12) === "WEBP") return validateWebp(input);
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  return { ok: false, reason: "UNSUPPORTED_TYPE" };
}
