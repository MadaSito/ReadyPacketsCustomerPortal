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

function validateJpeg(input: Buffer): ImageValidation {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return { ok: false, reason: "MALFORMED" };
  const kept: Buffer[] = [input.subarray(0, 2)];
  let offset = 2;
  let width = 0;
  let height = 0;
  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) return { ok: false, reason: "MALFORMED" };
    const marker = input[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9) return { ok: false, reason: "MALFORMED" }; // EOI before SOS
    const length = input.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > input.length) return { ok: false, reason: "MALFORMED" };
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 7) return { ok: false, reason: "MALFORMED" };
      height = input.readUInt16BE(offset + 5);
      width = input.readUInt16BE(offset + 7);
    }
    // Drop APP1..APP15 (EXIF, XMP, ICC, vendor blobs) and COM comments. Keep APP0 (JFIF).
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) kept.push(input.subarray(offset, end));
    offset = end;
    if (marker === 0xda) {
      // Start of scan: the rest is entropy-coded data up to and including EOI.
      const rest = input.subarray(offset);
      if (rest.length < 2 || rest[rest.length - 2] !== 0xff || rest[rest.length - 1] !== 0xd9) return { ok: false, reason: "MALFORMED" };
      kept.push(rest);
      if (!bounded(width, height)) return { ok: false, reason: "DIMENSIONS_OUT_OF_RANGE" };
      return { ok: true, mime: "image/jpeg", width, height, bytes: Buffer.concat(kept) };
    }
  }
  return { ok: false, reason: "MALFORMED" };
}

function validateWebp(input: Buffer): ImageValidation {
  if (input.length < 30) return { ok: false, reason: "MALFORMED" };
  const riffSize = input.readUInt32LE(4);
  if (riffSize + 8 !== input.length) return { ok: false, reason: "MALFORMED" };
  let offset = 12;
  let width = 0;
  let height = 0;
  let first = true;
  while (offset + 8 <= input.length) {
    const type = input.toString("latin1", offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const data = offset + 8;
    const end = data + size + (size % 2);
    if (end > input.length) return { ok: false, reason: "MALFORMED" };
    if (type === "EXIF" || type === "XMP ") return { ok: false, reason: "METADATA_NOT_ALLOWED" };
    if (first) {
      if (type === "VP8X" && size >= 10) {
        width = 1 + input.readUIntLE(data + 4, 3);
        height = 1 + input.readUIntLE(data + 7, 3);
      } else if (type === "VP8 " && size >= 10) {
        if (input[data + 3] !== 0x9d || input[data + 4] !== 0x01 || input[data + 5] !== 0x2a) return { ok: false, reason: "MALFORMED" };
        width = input.readUInt16LE(data + 6) & 0x3fff;
        height = input.readUInt16LE(data + 8) & 0x3fff;
      } else if (type === "VP8L" && size >= 5) {
        if (input[data] !== 0x2f) return { ok: false, reason: "MALFORMED" };
        const bits = input.readUInt32LE(data + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >> 14) & 0x3fff) + 1;
      } else return { ok: false, reason: "MALFORMED" };
      first = false;
    }
    offset = end;
  }
  if (first) return { ok: false, reason: "MALFORMED" };
  if (!bounded(width, height)) return { ok: false, reason: "DIMENSIONS_OUT_OF_RANGE" };
  return { ok: true, mime: "image/webp", width, height, bytes: input };
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
