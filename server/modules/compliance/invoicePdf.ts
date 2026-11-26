import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { InvoiceStatus, ReceiptNoteRefundState, ReceiptSettlementKind } from "./schema.js";
import {
  DEFAULT_ISSUER_LOGO_SETTING,
  DOCUMENT_LOGO_ALLOWLIST,
  type IssuerLogoSetting,
} from "./settings.js";

export type PdfPageSize = "LETTER" | "A4";

export const PDF_BRAND_SHORT_NAME = "ReadyPackets";
export const PDF_BRAND_LEGAL_NAME = "Ready Packets Consulting LLC";
export const PDF_BRAND_TAGLINE = "Your Business, Professionally Packeted!";
export const PDF_BRAND_PORTAL_HOST = "my.readypackets.com";
export const PDF_LOGO_ALT_TEXT = "ReadyPackets company logo";

export interface InvoicePdfInput {
  invoicePublicId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  orderReference: string;
  projectName?: string | null | undefined;
  pageSize?: PdfPageSize | undefined;
  issuerName: string;
  issuerAddress: string;
  issuerContact?: string | undefined;
  issuerTaxId?: string | undefined;
  issuerLogo?: IssuerLogoSetting | null | undefined;
  logoPng?: Buffer | null | undefined;
  customerName: string;
  customerEmail: string;
  customerRef?: string | null | undefined;
  currency: string;
  issuedAt: Date | null;
  dueAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  memo: string | null;
  paymentInstructions: string;
  lines: readonly {
    position: number;
    description: string;
    quantity: number;
    unitAmountMinor: number;
    lineTotalMinor: number;
  }[];
  subtotalMinor: number;
  discountMinor: number;
  bundleDiscountMinor?: number | undefined;
  discountLabel?: string | null | undefined;
  promoDiscountMinor?: number | undefined;
  promoLabel?: string | null | undefined;
  taxMinor: number;
  totalMinor: number;
  grossPaidMinor: number;
  waivedMinor?: number | undefined;
  refundedMinor: number;
  netPaidMinor: number;
  balanceDueMinor: number;
  payments: readonly {
    method: string;
    reference: string;
    amountMinor: number;
    receivedAt: Date;
  }[];
  refunds: readonly {
    reasonCode: string;
    reference: string;
    amountMinor: number;
    refundedAt: Date;
  }[];
}

export interface ReceiptLineSnapshot {
  position: number;
  description: string;
  quantity: number;
  unitAmountMinor: number;
  lineTotalMinor: number;
}

export interface ReceiptSnapshot {
  schemaVersion: 1;
  receiptPublicId: string;
  receiptNumber: string;
  settlementKind: ReceiptSettlementKind;
  issuedAt: string; // ISO-8601 UTC timestamp
  invoicePublicId: string;
  invoiceNumber: string;
  paymentPublicId: string | null;
  orderPublicId: string;
  orderReference: string;
  projectName?: string | null | undefined;
  company: {
    legalName: string;
    address: string;
    contact: string;
    taxId: string;
    logoMode: "brand" | "none";
    logoBrandPath: string | null;
  };
  customer: {
    name: string;
    customerRef: string | null;
    email: string;
  };
  currency: string;
  lines: ReceiptLineSnapshot[];
  subtotalMinor: number;
  discountMinor: number;
  bundleDiscountMinor: number;
  discountLabel: string | null;
  promoDiscountMinor: number;
  promoLabel: string | null;
  taxMinor: number;
  amountWaivedMinor: number;
  amountPaidMinor: number;
  paymentMethod: string;
  paymentMethodBrand: string | null;
  paymentMethodLast4: string | null;
  provider: string | null;
  providerReference: string | null;
  footerText: string;
}

export interface RefundNoteSnapshot {
  schemaVersion: 1;
  notePublicId: string;
  noteNumber: string;
  issuedAt: string; // ISO-8601 UTC timestamp
  receiptPublicId: string;
  receiptNumber: string;
  invoicePublicId: string;
  invoiceNumber: string;
  refundPublicId: string;
  orderPublicId: string;
  orderReference: string;
  projectName?: string | null | undefined;
  company: {
    legalName: string;
    address: string;
    contact: string;
    taxId: string;
    logoMode: "brand" | "none";
    logoBrandPath: string | null;
  };
  customer: {
    name: string;
    customerRef: string | null;
    email: string;
  };
  currency: string;
  originalAmountPaidMinor: number;
  refundAmountMinor: number;
  cumulativeRefundedMinor: number;
  resultingRefundState: ReceiptNoteRefundState;
  reasonCode: string;
  reference: string;
}

export interface DecodedPdfLogoImage {
  width: number;
  height: number;
  rgbFlate: Buffer;
  alphaFlate: Buffer | null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_LOGO_PNG_BYTES = 256 * 1024;
const MAX_INFLATED_PNG_BYTES = 16 * 1024 * 1024;
const parsedLogoCache = new Map<string, DecodedPdfLogoImage | null>();

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Pure TypeScript PNG decoder converting an 8-bit non-interlaced PNG into Flate-compressed
 * PDF `/DeviceRGB` + optional `/DeviceGray` `/SMask` streams. Returns `null` on unsupported/corrupt input.
 */
export function parsePngForPdf(pngBytes: Buffer): DecodedPdfLogoImage | null {
  if (pngBytes.byteLength < 33 || pngBytes.byteLength > MAX_LOGO_PNG_BYTES) return null;
  if (!pngBytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idatChunks: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= pngBytes.byteLength) {
    const length = pngBytes.readUInt32BE(offset);
    const chunkType = pngBytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > pngBytes.byteLength) return null;
    const chunkData = pngBytes.subarray(dataStart, dataEnd);

    if (chunkType === "IHDR") {
      if (length < 13) return null;
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      const bitDepth = chunkData[8] ?? 0;
      colorType = chunkData[9] ?? -1;
      const compression = chunkData[10] ?? 1;
      const filter = chunkData[11] ?? 1;
      const interlace = chunkData[12] ?? 1;
      if (
        width < 1 ||
        width > 2048 ||
        height < 1 ||
        height > 2048 ||
        bitDepth !== 8 ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        return null;
      }
    } else if (chunkType === "PLTE") {
      palette = chunkData;
    } else if (chunkType === "tRNS") {
      trns = chunkData;
    } else if (chunkType === "IDAT") {
      idatChunks.push(chunkData);
    } else if (chunkType === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  if (width < 1 || height < 1 || idatChunks.length === 0) return null;

  const channels =
    colorType === 6
      ? 4
      : colorType === 2
        ? 3
        : colorType === 4
          ? 2
          : colorType === 0 || colorType === 3
            ? 1
            : 0;
  if (channels === 0) return null;
  if (colorType === 3 && (!palette || palette.byteLength < 3 || palette.byteLength % 3 !== 0)) {
    return null;
  }

  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: MAX_INFLATED_PNG_BYTES });
  } catch {
    return null;
  }

  const bpp = channels;
  const stride = width * bpp;
  if (inflated.byteLength < height * (1 + stride)) return null;

  const unfiltered = Buffer.alloc(height * stride);
  for (let row = 0; row < height; row++) {
    const srcRowStart = row * (1 + stride);
    const filterType = inflated[srcRowStart] ?? 0;
    const dstRowStart = row * stride;
    const prevRowStart = (row - 1) * stride;

    for (let i = 0; i < stride; i++) {
      const raw = inflated[srcRowStart + 1 + i] ?? 0;
      const left = i >= bpp ? (unfiltered[dstRowStart + i - bpp] ?? 0) : 0;
      const up = row > 0 ? (unfiltered[prevRowStart + i] ?? 0) : 0;
      const upLeft = row > 0 && i >= bpp ? (unfiltered[prevRowStart + i - bpp] ?? 0) : 0;

      let val = raw;
      if (filterType === 1) val = (raw + left) & 0xff;
      else if (filterType === 2) val = (raw + up) & 0xff;
      else if (filterType === 3) val = (raw + Math.floor((left + up) / 2)) & 0xff;
      else if (filterType === 4) val = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      else if (filterType !== 0) return null;

      unfiltered[dstRowStart + i] = val;
    }
  }

  const pixelCount = width * height;
  const rgb = Buffer.alloc(pixelCount * 3);
  const alpha = Buffer.alloc(pixelCount, 255);
  let hasAlpha = false;

  for (let px = 0; px < pixelCount; px++) {
    const srcIdx = px * bpp;
    const rgbIdx = px * 3;
    if (colorType === 6) {
      rgb[rgbIdx] = unfiltered[srcIdx] ?? 0;
      rgb[rgbIdx + 1] = unfiltered[srcIdx + 1] ?? 0;
      rgb[rgbIdx + 2] = unfiltered[srcIdx + 2] ?? 0;
      const a = unfiltered[srcIdx + 3] ?? 255;
      alpha[px] = a;
      if (a < 255) hasAlpha = true;
    } else if (colorType === 2) {
      rgb[rgbIdx] = unfiltered[srcIdx] ?? 0;
      rgb[rgbIdx + 1] = unfiltered[srcIdx + 1] ?? 0;
      rgb[rgbIdx + 2] = unfiltered[srcIdx + 2] ?? 0;
    } else if (colorType === 4) {
      const g = unfiltered[srcIdx] ?? 0;
      rgb[rgbIdx] = g;
      rgb[rgbIdx + 1] = g;
      rgb[rgbIdx + 2] = g;
      const a = unfiltered[srcIdx + 1] ?? 255;
      alpha[px] = a;
      if (a < 255) hasAlpha = true;
    } else if (colorType === 0) {
      const g = unfiltered[srcIdx] ?? 0;
      rgb[rgbIdx] = g;
      rgb[rgbIdx + 1] = g;
      rgb[rgbIdx + 2] = g;
    } else if (colorType === 3 && palette) {
      const palIdx = unfiltered[srcIdx] ?? 0;
      const palOffset = palIdx * 3;
      rgb[rgbIdx] = palette[palOffset] ?? 0;
      rgb[rgbIdx + 1] = palette[palOffset + 1] ?? 0;
      rgb[rgbIdx + 2] = palette[palOffset + 2] ?? 0;
      if (trns && palIdx < trns.byteLength) {
        const a = trns[palIdx] ?? 255;
        alpha[px] = a;
        if (a < 255) hasAlpha = true;
      }
    }
  }

  return {
    width,
    height,
    rgbFlate: deflateSync(rgb),
    alphaFlate: hasAlpha ? deflateSync(alpha) : null,
  };
}

function candidatePublicDirs(explicitStaticDir?: string | null): string[] {
  const dirs: string[] = [];
  const pushUnique = (dir: string | undefined | null) => {
    if (!dir?.trim()) return;
    const resolved = path.resolve(dir);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  };

  pushUnique(explicitStaticDir);
  pushUnique(process.env.RP_STATIC_DIR);
  pushUnique(path.resolve(process.cwd(), "dist/public"));
  pushUnique(path.resolve(process.cwd(), "client/public"));
  pushUnique(path.resolve(import.meta.dirname, "../public"));
  pushUnique(path.resolve(import.meta.dirname, "../../../public"));
  pushUnique(path.resolve(import.meta.dirname, "../../../../client/public"));
  return dirs;
}

/**
 * Loads and decodes a reviewed, self-hosted brand PNG from `<publicDir>/brand/...`
 * across both production (`dist/public/brand`) and source (`client/public/brand`) layouts.
 * Strictly rejects any path not in `DOCUMENT_LOGO_ALLOWLIST` or escaping `<publicDir>/brand`.
 */
export function loadAllowlistedBrandLogo(
  brandPath: string | null | undefined,
  opts?: { staticDir?: string | null | undefined },
): DecodedPdfLogoImage | null {
  if (!brandPath || !(DOCUMENT_LOGO_ALLOWLIST as readonly string[]).includes(brandPath)) {
    return null;
  }
  const cacheKey = opts?.staticDir ? `${path.resolve(opts.staticDir)}::${brandPath}` : brandPath;
  if (!opts?.staticDir && parsedLogoCache.has(cacheKey)) {
    return parsedLogoCache.get(cacheKey) ?? null;
  }

  const relativeBrandFile = brandPath.replace(/^\/+/u, "");
  const publicDirs = opts?.staticDir ? [path.resolve(opts.staticDir)] : candidatePublicDirs();

  for (const publicDir of publicDirs) {
    try {
      const brandRoot = path.resolve(publicDir, "brand");
      const candidate = path.resolve(publicDir, relativeBrandFile);
      if (!candidate.startsWith(`${brandRoot}${path.sep}`)) {
        continue;
      }
      // Check and read through one descriptor so the file cannot change between the size check and the read.
      const fd = openSync(candidate, "r");
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_LOGO_PNG_BYTES) {
          continue;
        }
        const decoded = parsePngForPdf(readFileSync(fd));
        if (decoded) {
          if (!opts?.staticDir) parsedLogoCache.set(cacheKey, decoded);
          return decoded;
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // Try next candidate static root (for example dist/public -> client/public).
    }
  }

  if (!opts?.staticDir) {
    parsedLogoCache.set(cacheKey, null);
  }
  return null;
}

function resolveLogoImage(opts?: {
  logoPng?: Buffer | null | undefined;
  issuerLogo?: IssuerLogoSetting | null | undefined;
  logoMode?: "brand" | "none" | undefined;
  logoBrandPath?: string | null | undefined;
  staticDir?: string | null | undefined;
}): DecodedPdfLogoImage | null {
  if (opts?.logoPng) {
    return parsePngForPdf(opts.logoPng);
  }
  const loaderOpts = opts?.staticDir ? { staticDir: opts.staticDir } : undefined;
  if (opts?.issuerLogo) {
    if (opts.issuerLogo.mode === "none") return null;
    return (
      loadAllowlistedBrandLogo(opts.issuerLogo.brandPath, loaderOpts) ??
      loadAllowlistedBrandLogo(DEFAULT_ISSUER_LOGO_SETTING.brandPath, loaderOpts)
    );
  }
  if (opts?.logoMode !== undefined) {
    if (opts.logoMode === "none") return null;
    return (
      loadAllowlistedBrandLogo(opts.logoBrandPath ?? DEFAULT_ISSUER_LOGO_SETTING.brandPath, loaderOpts) ??
      loadAllowlistedBrandLogo(DEFAULT_ISSUER_LOGO_SETTING.brandPath, loaderOpts)
    );
  }
  return loadAllowlistedBrandLogo(DEFAULT_ISSUER_LOGO_SETTING.brandPath, loaderOpts);
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/**
 * Pure integer minor-unit currency formatter (no floating point division).
 */
export function formatMinorUnitsPlain(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase();
  const negative = amountMinor < 0;
  const abs = Math.abs(Math.trunc(amountMinor));

  let decimals = 2;
  if (ZERO_DECIMAL_CURRENCIES.has(code)) decimals = 0;
  else if (THREE_DECIMAL_CURRENCIES.has(code)) decimals = 3;

  if (decimals === 0) {
    const whole = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${negative ? "-" : ""}${code} ${whole}`;
  }

  const divisor = 10 ** decimals;
  const major = Math.floor(abs / divisor);
  const minor = abs % divisor;
  const majorStr = major.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const minorStr = String(minor).padStart(decimals, "0");
  return `${negative ? "-" : ""}${code} ${majorStr}.${minorStr}`;
}

function formatUtcDate(d: Date | string | null): string {
  if (!d) return "-";
  const iso = typeof d === "string" ? d : d.toISOString();
  return iso.slice(0, 10);
}

function formatUtcTimestamp(d: Date | string | null): string {
  if (!d) return "-";
  const iso = typeof d === "string" ? d : d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/**
 * PDF 1.4 `/WinAnsiEncoding` (Windows-1252) special code points in range `0x80..0x9F`.
 * Code points `0xA1..0xFF` (except soft hyphen `0xAD`) map 1:1 to their Unicode code point.
 */
const WINANSI_UNICODE_TO_BYTE = new Map<number, number>([
  [0x20ac, 0x80], // €
  [0x201a, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201e, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02c6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8a], // Š
  [0x2039, 0x8b], // ‹
  [0x0152, 0x8c], // Œ
  [0x017d, 0x8e], // Ž
  [0x2018, 0x91], // ‘
  [0x2019, 0x92], // ’
  [0x201c, 0x93], // “
  [0x201d, 0x94], // ”
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9a], // š
  [0x203a, 0x9b], // ›
  [0x0153, 0x9c], // œ
  [0x017e, 0x9e], // ž
  [0x0178, 0x9f], // Ÿ
]);

const WINANSI_BYTE_TO_UNICODE = new Map<number, string>(
  [...WINANSI_UNICODE_TO_BYTE.entries()].map(([cp, byte]) => [byte, String.fromCodePoint(cp)]),
);

const UNICODE_TRANSLITERATION_MAP: Readonly<Record<string, string>> = {
  // Spaces & invisible joiners
  "\u00a0": " ",
  "\u1680": " ",
  "\u2000": " ",
  "\u2001": " ",
  "\u2002": " ",
  "\u2003": " ",
  "\u2004": " ",
  "\u2005": " ",
  "\u2006": " ",
  "\u2007": " ",
  "\u2008": " ",
  "\u2009": " ",
  "\u200a": " ",
  "\u202f": " ",
  "\u205f": " ",
  "\u3000": " ",
  "\u00ad": "",
  "\u200b": "",
  "\u200c": "",
  "\u200d": "",
  "\ufeff": "",
  // Dashes & minus
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2015": "\u2014", // ― -> — (WinAnsi)
  "\u2212": "-",
  // Bullets & middle-dot variants -> WinAnsi • or ·
  "\u2023": "\u2022",
  "\u2043": "\u2022",
  "\u2219": "\u2022",
  "\u25aa": "\u2022",
  "\u25cf": "\u2022",
  "\u25e6": "\u2022",
  "\u22c5": "\u00b7",
  "\u30fb": "\u00b7",
  // Arrows
  "\u2192": "->",
  "\u2794": "->",
  "\u279c": "->",
  "\u27f6": "->",
  "\u2190": "<-",
  "\u27f5": "<-",
  "\u2194": "<->",
  "\u27f7": "<->",
  "\u21d2": "=>",
  "\u27f9": "=>",
  "\u21d0": "<=",
  "\u2191": "^",
  "\u2193": "v",
  // Quotes / primes
  "\u2032": "'",
  "\u2033": '"',
  "\u02bc": "\u2019",
  // Symbols & math
  "\u2120": "SM",
  "\u2117": "(P)",
  "\u2116": "No.",
  "\u2713": "[x]",
  "\u2714": "[x]",
  "\u2717": "[ ]",
  "\u2718": "[ ]",
  "\u2248": "~",
  "\u2260": "!=",
  "\u2264": "<=",
  "\u2265": ">=",
  // Non-decomposing Latin letters outside WinAnsi
  "\u0141": "L", // Ł
  "\u0142": "l", // ł
  "\u0110": "D", // Đ
  "\u0111": "d", // đ
  "\u0126": "H", // Ħ
  "\u0127": "h", // ħ
  "\u0131": "i", // ı
  "\u0132": "IJ",
  "\u0133": "ij",
  "\u0138": "k", // ĸ
  "\u013f": "L",
  "\u0140": "l",
  "\u014a": "NG",
  "\u014b": "ng",
  "\u0166": "T",
  "\u0167": "t",
  "\u017f": "s",
  "\u1e9e": "SS", // ẞ
};

function winAnsiByteForCodePoint(cp: number): number | null {
  if (cp >= 0x20 && cp <= 0x7e) return cp;
  const mapped = WINANSI_UNICODE_TO_BYTE.get(cp);
  if (mapped !== undefined) return mapped;
  if (cp >= 0xa1 && cp <= 0xff && cp !== 0xad) return cp;
  return null;
}

/**
 * Normalizes and transliterates arbitrary Unicode into characters representable in PDF
 * `/WinAnsiEncoding` (preserving native glyphs like `·`, `•`, `–`, `—`, curly quotes, `™`,
 * `€`, and accented Western European Latin while transliterating arrows and Central/Eastern
 * European Latin cleanly — never emitting `?` as a replacement glyph).
 */
export function sanitizePdfTextToWinAnsi(raw: string, opts?: { preserveNewlines?: boolean }): string {
  const nfc = raw.replace(/\r\n?/g, "\n").normalize("NFC");
  let out = "";

  for (const ch of nfc) {
    if (ch === "\n") {
      out += opts?.preserveNewlines ? "\n" : " ";
      continue;
    }
    if (ch === "\t") {
      out += " ";
      continue;
    }
    const directReplacement = UNICODE_TRANSLITERATION_MAP[ch];
    if (directReplacement !== undefined) {
      out += directReplacement;
      continue;
    }

    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) {
      continue;
    }
    if (winAnsiByteForCodePoint(cp) !== null) {
      out += ch;
      continue;
    }

    // Attempt compatibility decomposition + combining-mark strip (for example č -> c, ř -> r, ā -> a).
    const decomposed = ch.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    let resolved = "";
    for (const sub of decomposed) {
      const subMapped = UNICODE_TRANSLITERATION_MAP[sub];
      if (subMapped !== undefined) {
        resolved += subMapped;
        continue;
      }
      const subCp = sub.codePointAt(0) ?? 0;
      if (winAnsiByteForCodePoint(subCp) !== null) {
        resolved += sub;
      }
    }
    out += resolved.length > 0 ? resolved : "-";
  }

  return out;
}

/**
 * Encodes text as a safe 7-bit ASCII PDF 1.4 literal string body using `/WinAnsiEncoding`
 * 3-digit octal escapes (`\ooo`) for bytes `0x80..0xFF` and escaping `\`, `(`, `)`.
 * Control characters and raw PDF operators cannot break out of a literal string, and
 * non-ASCII characters never degrade into `?`.
 */
export function escapePdfText(raw: string): string {
  const clean = sanitizePdfTextToWinAnsi(raw);
  let out = "";
  for (const ch of clean) {
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === "(") {
      out += "\\(";
    } else if (ch === ")") {
      out += "\\)";
    } else {
      const cp = ch.codePointAt(0) ?? 0x20;
      const byte = winAnsiByteForCodePoint(cp);
      if (byte === null) {
        out += "-";
      } else if (byte >= 0x20 && byte <= 0x7e) {
        out += ch;
      } else {
        out += `\\${byte.toString(8).padStart(3, "0")}`;
      }
    }
  }
  return out;
}

/**
 * Decodes `(...) Tj` text runs from a generated PDF 1.4 buffer back to Unicode using
 * `/WinAnsiEncoding` so tests can inspect exact rendered text (including non-ASCII glyphs).
 */
export function decodePdfLiteralText(pdfBuffer: Buffer): string {
  const raw = pdfBuffer.toString("latin1");
  const lines: string[] = [];
  const pattern = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const body = match[1] ?? "";
    let decoded = "";
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!;
      if (c !== "\\") {
        decoded += c;
        continue;
      }
      const next = body[i + 1];
      if (next === undefined) break;
      if (next >= "0" && next <= "7") {
        const oct = body.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? next;
        const byte = Number.parseInt(oct, 8) & 0xff;
        decoded += WINANSI_BYTE_TO_UNICODE.get(byte) ?? String.fromCharCode(byte);
        i += oct.length;
      } else if (next === "n") {
        decoded += "\n";
        i += 1;
      } else if (next === "r") {
        decoded += "\r";
        i += 1;
      } else if (next === "t") {
        decoded += "\t";
        i += 1;
      } else {
        decoded += next;
        i += 1;
      }
    }
    lines.push(decoded);
  }
  return lines.join("\n");
}

function wrapText(text: string, maxChars: number): string[] {
  const safeMax = Math.max(8, Math.trunc(maxChars));
  const cleaned = sanitizePdfTextToWinAnsi(text, { preserveNewlines: true }).trim();
  if (!cleaned) return [];
  const out: string[] = [];

  for (const paragraph of cleaned.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let current = "";

    for (const word of words) {
      if (word.length > safeMax) {
        if (current) {
          out.push(current);
          current = "";
        }
        for (let offset = 0; offset < word.length; offset += safeMax) {
          const slice = word.slice(offset, offset + safeMax);
          if (slice.length === safeMax && offset + safeMax < word.length) {
            out.push(slice);
          } else {
            current = slice;
          }
        }
        continue;
      }

      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= safeMax) {
        current = candidate;
      } else {
        if (current) out.push(current);
        current = word;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

type RgbColor = readonly [number, number, number];

// ReadyPackets brand palette (shared/brand.ts & docs/brand/BRAND_GUIDE.md), verified >= 4.5:1 for text on light surfaces
const BRAND_COLORS = {
  navy: [0.051, 0.106, 0.165] as RgbColor, // #0D1B2A (17.2:1 on white)
  slateBody: [0.118, 0.161, 0.231] as RgbColor, // #1E293B (14.6:1 on white)
  slateMuted: [0.2, 0.255, 0.333] as RgbColor, // #334155 (10.3:1 on white)
  tealText: [0.075, 0.369, 0.333] as RgbColor, // #135E55 (7.6:1 on white)
  tealAccent: [0.102, 0.478, 0.431] as RgbColor, // #1A7A6E
  tealBright: [0.125, 0.627, 0.565] as RgbColor, // #20A090 (decorative rules)
  goldRule: [0.788, 0.659, 0.298] as RgbColor, // #C9A84C (decorative hairline only)
  calloutBg: [0.957, 0.973, 0.98] as RgbColor, // #F4F8FA
  tableHeaderBg: [0.933, 0.953, 0.973] as RgbColor, // #EEF3F8
  totalsBg: [0.941, 0.969, 0.965] as RgbColor, // #F0F7F6
  badgeBg: [0.945, 0.961, 0.976] as RgbColor, // #F1F5F9
  voidBg: [0.996, 0.949, 0.949] as RgbColor, // #FEF2F2
  voidBorder: [0.725, 0.11, 0.11] as RgbColor, // #B91C1C
  borderStrong: [0.58, 0.639, 0.722] as RgbColor, // #94A3B8
  borderSubtle: [0.796, 0.835, 0.882] as RgbColor, // #CBD5E1
  borderRow: [0.886, 0.91, 0.941] as RgbColor, // #E2E8F0
} as const;

interface PageGeometry {
  size: PdfPageSize;
  width: number;
  height: number;
  leftX: number;
  rightX: number;
  contentWidth: number;
  topStartY: number;
  bottomSafeY: number;
  colPosX: number;
  colDescX: number;
  colQtyX: number;
  colUnitX: number;
  colTotalX: number;
  descWrapChars: number;
  bodyWrapChars: number;
  metaX: number;
}

function resolvePageGeometry(pageSize: PdfPageSize = "LETTER"): PageGeometry {
  const width = pageSize === "A4" ? 595.28 : 612;
  const height = pageSize === "A4" ? 841.89 : 792;
  const leftX = 48;
  const rightX = Math.round((width - 48) * 100) / 100;
  const contentWidth = Math.round((rightX - leftX) * 100) / 100;
  const colPosX = leftX + 6;
  const colDescX = leftX + 28;
  const colQtyX = Math.round(rightX - 216);
  const colUnitX = Math.round(rightX - 176);
  const colTotalX = Math.round(rightX - 88);
  const descWrapChars = pageSize === "A4" ? 42 : 45;
  const bodyWrapChars = pageSize === "A4" ? 78 : 82;
  const metaX = Math.round(rightX - 196);

  return {
    size: pageSize,
    width,
    height,
    leftX,
    rightX,
    contentWidth,
    topStartY: Math.round(height - 54),
    bottomSafeY: 64,
    colPosX,
    colDescX,
    colQtyX,
    colUnitX,
    colTotalX,
    descWrapChars,
    bodyWrapChars,
    metaX,
  };
}

interface PageStreamBuilder {
  ops: string[];
  hasLogo: boolean;
  hasTaggedLogoFigure: boolean;
}

function fmtRgb(rgb: RgbColor): string {
  return `${rgb[0].toFixed(3)} ${rgb[1].toFixed(3)} ${rgb[2].toFixed(3)}`;
}

function drawText(
  page: PageStreamBuilder,
  x: number,
  y: number,
  text: string,
  opts?: {
    bold?: boolean;
    size?: number;
    gray?: number;
    color?: RgbColor;
    tag?: "P" | "H1" | "H2";
  },
): void {
  const font = opts?.bold ? "/F2" : "/F1";
  const size = opts?.size ?? 10;
  const tag = opts?.tag ?? "P";
  const colorOp = opts?.color
    ? `${fmtRgb(opts.color)} rg`
    : `${(opts?.gray ?? 0.08).toFixed(2)} g`;
  const rx = Math.round(x * 100) / 100;
  const ry = Math.round(y * 100) / 100;
  page.ops.push(`/${tag} BMC BT ${colorOp} ${font} ${size} Tf ${rx} ${ry} Td (${escapePdfText(text)}) Tj ET EMC`);
}

function drawRule(
  page: PageStreamBuilder,
  x1: number,
  x2: number,
  y: number,
  opts?: { color?: RgbColor; width?: number },
): void {
  const strokeColor = opts?.color ?? BRAND_COLORS.borderSubtle;
  const lineWidth = opts?.width ?? 0.7;
  const ry = Math.round(y * 100) / 100;
  page.ops.push(
    `/Artifact BMC q ${fmtRgb(strokeColor)} RG ${lineWidth.toFixed(2)} w ${x1} ${ry} m ${x2} ${ry} l S Q EMC`,
  );
}

function drawRect(
  page: PageStreamBuilder,
  x: number,
  y: number,
  width: number,
  height: number,
  opts: { fill?: RgbColor; stroke?: RgbColor; strokeWidth?: number },
): void {
  const rx = Math.round(x * 100) / 100;
  const ry = Math.round(y * 100) / 100;
  const rw = Math.round(width * 100) / 100;
  const rh = Math.round(height * 100) / 100;
  const cmds: string[] = ["q"];
  if (opts.fill) cmds.push(`${fmtRgb(opts.fill)} rg`);
  if (opts.stroke) {
    cmds.push(`${fmtRgb(opts.stroke)} RG`);
    cmds.push(`${(opts.strokeWidth ?? 0.75).toFixed(2)} w`);
  }
  const paintOp = opts.fill && opts.stroke ? "B" : opts.fill ? "f" : "S";
  cmds.push(`${rx} ${ry} ${rw} ${rh} re ${paintOp} Q`);
  page.ops.push(`/Artifact BMC ${cmds.join(" ")} EMC`);
}

function drawTopBrandBand(page: PageStreamBuilder, geo: PageGeometry): void {
  const barY = Math.round((geo.height - 28) * 100) / 100;
  drawRect(page, geo.leftX, barY, geo.contentWidth, 5, { fill: BRAND_COLORS.navy });
  drawRect(page, geo.leftX, barY - 2, Math.round(geo.contentWidth * 0.72), 1.6, {
    fill: BRAND_COLORS.tealBright,
  });
  drawRect(
    page,
    Math.round(geo.leftX + geo.contentWidth * 0.72),
    barY - 2,
    Math.round(geo.contentWidth * 0.28),
    1.6,
    { fill: BRAND_COLORS.goldRule },
  );
}

function drawLogo(
  page: PageStreamBuilder,
  logo: DecodedPdfLogoImage,
  x: number,
  topY: number,
  maxWidthPt = 136,
  maxHeightPt = 34,
  taggedFigure = true,
): { drawWidth: number; drawHeight: number } {
  const scale = Math.min(maxWidthPt / logo.width, maxHeightPt / logo.height, 1);
  const drawWidth = Math.max(14, Math.round(logo.width * scale * 100) / 100);
  const drawHeight = Math.max(14, Math.round(logo.height * scale * 100) / 100);
  const bottomY = Math.round((topY - drawHeight + 12) * 100) / 100;
  page.hasLogo = true;
  if (taggedFigure) {
    page.hasTaggedLogoFigure = true;
    page.ops.push(
      `/Figure << /MCID 0 /Alt (${escapePdfText(PDF_LOGO_ALT_TEXT)}) >> BDC q ${drawWidth} 0 0 ${drawHeight} ${x} ${bottomY} cm /ImLogo Do Q EMC`,
    );
  } else {
    page.ops.push(`/Artifact BMC q ${drawWidth} 0 0 ${drawHeight} ${x} ${bottomY} cm /ImLogo Do Q EMC`);
  }
  return { drawWidth, drawHeight };
}

function stampPageFooters(pages: readonly PageStreamBuilder[], geo: PageGeometry): void {
  const totalPages = pages.length;
  for (let idx = 0; idx < totalPages; idx++) {
    const page = pages[idx]!;
    drawRule(page, geo.leftX, geo.rightX, 44, { color: BRAND_COLORS.borderSubtle, width: 0.6 });
    drawText(page, geo.leftX, 30, `${PDF_BRAND_LEGAL_NAME} · ${PDF_BRAND_PORTAL_HOST}`, {
      size: 8.5,
      color: BRAND_COLORS.slateMuted,
    });
    const pageLabel = `Page ${idx + 1} of ${totalPages}`;
    drawText(page, geo.rightX - 64, 30, pageLabel, {
      bold: true,
      size: 8.5,
      color: BRAND_COLORS.navy,
    });
  }
}

function buildBinaryStreamObject(objNum: number, dictEntries: string, streamBytes: Buffer): Buffer {
  const prefix = Buffer.from(
    `${objNum} 0 obj\n<< ${dictEntries} /Length ${streamBytes.byteLength} >>\nstream\n`,
    "latin1",
  );
  const suffix = Buffer.from("\nendstream\nendobj\n", "latin1");
  return Buffer.concat([prefix, streamBytes, suffix]);
}

function assembleTaggedPdf14(args: {
  title: string;
  pages: readonly PageStreamBuilder[];
  logo: DecodedPdfLogoImage | null;
  geo: PageGeometry;
}): Buffer {
  stampPageFooters(args.pages, args.geo);

  // Object numbering:
  // 1: Catalog (/Lang (en), /ViewerPreferences << /DisplayDocTitle true >>, /MarkInfo << /Marked true >>, /StructTreeRoot 5 0 R)
  // 2: Pages
  // 3: Font Helvetica (/F1)
  // 4: Font Helvetica-Bold (/F2)
  // 5: StructTreeRoot (filled once optional Figure StructElem object number is known)
  // 6: StructElem (/S /Document)
  // 7: Info (/Title (...) /Author (...) /Producer (ReadyPackets))
  const objects: Buffer[] = [];
  const pushStrObj = (s: string) => {
    objects.push(Buffer.from(s, "latin1"));
  };

  pushStrObj(
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Lang (en) /ViewerPreferences << /DisplayDocTitle true >> /MarkInfo << /Marked true >> /StructTreeRoot 5 0 R >>\nendobj\n",
  );
  pushStrObj(""); // Placeholder index 1 for Object 2 (Pages)
  pushStrObj(
    "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n",
  );
  pushStrObj(
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n",
  );
  pushStrObj(""); // Placeholder index 4 for Object 5 (StructTreeRoot)
  pushStrObj(""); // Placeholder index 5 for Object 6 (Document StructElem)
  pushStrObj(
    `7 0 obj\n<< /Title (${escapePdfText(args.title)}) /Author (${escapePdfText(PDF_BRAND_LEGAL_NAME)}) /Producer (ReadyPackets) >>\nendobj\n`,
  );

  let logoObjNum: number | null = null;
  if (args.logo) {
    let smaskRef = "";
    if (args.logo.alphaFlate) {
      const maskObjNum = objects.length + 1;
      objects.push(
        buildBinaryStreamObject(
          maskObjNum,
          `/Type /XObject /Subtype /Image /Width ${args.logo.width} /Height ${args.logo.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
          args.logo.alphaFlate,
        ),
      );
      smaskRef = ` /SMask ${maskObjNum} 0 R`;
    }
    logoObjNum = objects.length + 1;
    objects.push(
      buildBinaryStreamObject(
        logoObjNum,
        `/Type /XObject /Subtype /Image /Width ${args.logo.width} /Height ${args.logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smaskRef}`,
        args.logo.rgbFlate,
      ),
    );
  }

  const pageObjectNums: number[] = [];
  let taggedLogoPageObjNum: number | null = null;
  for (let i = 0; i < args.pages.length; i++) {
    const pageBuilder = args.pages[i]!;
    const contentObjNum = objects.length + 1;
    const streamBody = `${pageBuilder.ops.join("\n")}\n`;
    const streamBuf = Buffer.from(streamBody, "latin1");
    pushStrObj(
      `${contentObjNum} 0 obj\n<< /Length ${streamBuf.byteLength} >>\nstream\n${streamBody}endstream\nendobj\n`,
    );

    const pageObjNum = objects.length + 1;
    pageObjectNums.push(pageObjNum);
    if (pageBuilder.hasTaggedLogoFigure && taggedLogoPageObjNum === null) {
      taggedLogoPageObjNum = pageObjNum;
    }
    const xObjectRes =
      pageBuilder.hasLogo && logoObjNum !== null ? ` /XObject << /ImLogo ${logoObjNum} 0 R >>` : "";
    const structParents = pageBuilder.hasTaggedLogoFigure ? " /StructParents 0" : "";
    pushStrObj(
      `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${args.geo.width} ${args.geo.height}] /Tabs /S${structParents} /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xObjectRes} >> /Contents ${contentObjNum} 0 R >>\nendobj\n`,
    );
  }

  if (taggedLogoPageObjNum !== null) {
    const figureElemObjNum = objects.length + 1;
    pushStrObj(
      `${figureElemObjNum} 0 obj\n<< /Type /StructElem /S /Figure /P 6 0 R /Pg ${taggedLogoPageObjNum} 0 R /K 0 /Alt (${escapePdfText(PDF_LOGO_ALT_TEXT)}) >>\nendobj\n`,
    );
    objects[4] = Buffer.from(
      `5 0 obj\n<< /Type /StructTreeRoot /K [6 0 R] /ParentTree << /Nums [0 [${figureElemObjNum} 0 R]] >> >>\nendobj\n`,
      "latin1",
    );
    objects[5] = Buffer.from(
      `6 0 obj\n<< /Type /StructElem /S /Document /P 5 0 R /K [${figureElemObjNum} 0 R] >>\nendobj\n`,
      "latin1",
    );
  } else {
    objects[4] = Buffer.from("5 0 obj\n<< /Type /StructTreeRoot /K [6 0 R] >>\nendobj\n", "latin1");
    objects[5] = Buffer.from("6 0 obj\n<< /Type /StructElem /S /Document /P 5 0 R >>\nendobj\n", "latin1");
  }

  const kidsRefs = pageObjectNums.map((n) => `${n} 0 R`).join(" ");
  objects[1] = Buffer.from(
    `2 0 obj\n<< /Type /Pages /Kids [${kidsRefs}] /Count ${args.pages.length} >>\nendobj\n`,
    "latin1",
  );

  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const chunks: Buffer[] = [header];
  const offsets: number[] = [0];
  let bytePos = header.byteLength;

  for (const objBuf of objects) {
    offsets.push(bytePos);
    chunks.push(objBuf);
    bytePos += objBuf.byteLength;
  }

  const xrefStart = bytePos;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
  for (let i = 1; i < offsets.length; i++) {
    xrefLines.push(`${String(offsets[i]!).padStart(10, "0")} 00000 n \n`);
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xrefLines.join("") + trailer, "latin1"));

  return Buffer.concat(chunks);
}

function resolveDisplayLegalName(configuredName: string): string {
  const trimmed = configuredName.trim();
  if (!trimmed || trimmed.toLowerCase() === "readypackets") {
    return PDF_BRAND_LEGAL_NAME;
  }
  return trimmed;
}

function drawCompanyBlock(
  page: PageStreamBuilder,
  geo: PageGeometry,
  startY: number,
  company: {
    name: string;
    address: string;
    contact?: string | undefined;
    taxId?: string | undefined;
  },
  logo: DecodedPdfLogoImage | null,
): number {
  let y = startY;
  let textX = geo.leftX;
  let minHeaderBottomY = y;

  if (logo) {
    const isSquareMark = logo.width / Math.max(1, logo.height) <= 2.2;
    const dims = drawLogo(
      page,
      logo,
      geo.leftX,
      y,
      isSquareMark ? 36 : 148,
      isSquareMark ? 36 : 28,
      true,
    );
    if (isSquareMark) {
      textX = Math.round(geo.leftX + dims.drawWidth + 10);
      minHeaderBottomY = Math.round(y - dims.drawHeight + 6);
    } else {
      y -= Math.ceil(dims.drawHeight) + 6;
    }
  }

  drawText(page, textX, y, PDF_BRAND_SHORT_NAME, {
    bold: true,
    size: 16,
    color: BRAND_COLORS.navy,
    tag: "H1",
  });
  y -= 14;

  drawText(page, textX, y, PDF_BRAND_TAGLINE, {
    bold: true,
    size: 8.5,
    color: BRAND_COLORS.tealText,
  });
  y -= 13;

  const legalName = resolveDisplayLegalName(company.name);
  for (const nameLine of wrapText(legalName, 44).slice(0, 2)) {
    drawText(page, textX, y, nameLine, {
      bold: true,
      size: 9.5,
      color: BRAND_COLORS.slateBody,
    });
    y -= 12;
  }

  y = Math.min(y, minHeaderBottomY - 4);

  for (const addrLine of wrapText(company.address, 48).slice(0, 3)) {
    drawText(page, geo.leftX, y, addrLine, { size: 8.5, color: BRAND_COLORS.slateMuted });
    y -= 12;
  }
  if (company.contact?.trim()) {
    for (const contactLine of wrapText(company.contact, 48).slice(0, 2)) {
      drawText(page, geo.leftX, y, contactLine, { size: 8.5, color: BRAND_COLORS.slateMuted });
      y -= 12;
    }
  }
  if (company.taxId?.trim()) {
    drawText(page, geo.leftX, y, `Tax / Reg ID: ${company.taxId.trim()}`, {
      size: 8.5,
      color: BRAND_COLORS.slateMuted,
    });
    y -= 12;
  }
  return y;
}

function drawDocumentMetaPanel(
  page: PageStreamBuilder,
  geo: PageGeometry,
  topY: number,
  docHeading: string,
  badgeLabel: string,
  rows: readonly { label: string; value: string; bold?: boolean }[],
): number {
  let y = topY;
  drawText(page, geo.metaX, y, docHeading, {
    bold: true,
    size: 15,
    color: BRAND_COLORS.navy,
    tag: "H1",
  });
  y -= 20;

  // Accessible status/type badge: high-contrast dark text + explicit label + visible border (never color-only)
  const pillWidth = Math.min(188, Math.max(108, badgeLabel.length * 5.6 + 18));
  drawRect(page, geo.metaX, y - 4, pillWidth, 16, {
    fill: BRAND_COLORS.badgeBg,
    stroke: BRAND_COLORS.tealAccent,
    strokeWidth: 0.8,
  });
  drawText(page, geo.metaX + 7, y, badgeLabel, {
    bold: true,
    size: 8.5,
    color: BRAND_COLORS.navy,
  });
  y -= 18;

  for (const row of rows) {
    drawText(page, geo.metaX, y, `${row.label}: ${row.value}`, {
      bold: Boolean(row.bold),
      size: row.bold ? 9.5 : 8.5,
      color: row.bold ? BRAND_COLORS.navy : BRAND_COLORS.slateMuted,
    });
    y -= 13;
  }
  return y;
}

/**
 * Draws the prominent `Order` & `Project` identification block near the top of every
 * invoice, payment receipt, and refund note. Wraps long order references and up to 160-char
 * project names cleanly inside both Letter and A4 page margins.
 */
function drawOrderProjectBanner(
  page: PageStreamBuilder,
  geo: PageGeometry,
  startY: number,
  orderReference: string,
  projectName: string | null | undefined,
): number {
  const orderColWidth = 172;
  const projectX = geo.leftX + orderColWidth + 16;
  const projectWrapChars = geo.size === "A4" ? 48 : 52;
  const orderWrapChars = 24;

  const cleanOrderRef = orderReference.trim() || "-";
  const cleanProject = projectName?.trim() ? projectName.trim() : "Not specified";

  const orderLines = wrapText(cleanOrderRef, orderWrapChars).slice(0, 3);
  const projectLines = wrapText(cleanProject, projectWrapChars).slice(0, 4);
  const contentLineCount = Math.max(1, orderLines.length, projectLines.length);
  const boxHeight = 24 + contentLineCount * 13;
  const boxBottomY = startY - boxHeight;

  drawRect(page, geo.leftX, boxBottomY, geo.contentWidth, boxHeight, {
    fill: BRAND_COLORS.calloutBg,
    stroke: BRAND_COLORS.borderSubtle,
    strokeWidth: 0.8,
  });
  drawRect(page, geo.leftX, boxBottomY, 3.5, boxHeight, {
    fill: BRAND_COLORS.tealAccent,
  });

  const labelY = startY - 12;
  drawText(page, geo.leftX + 12, labelY, "Order", {
    bold: true,
    size: 8,
    color: BRAND_COLORS.tealText,
    tag: "H2",
  });
  drawText(page, projectX, labelY, "Project", {
    bold: true,
    size: 8,
    color: BRAND_COLORS.tealText,
    tag: "H2",
  });

  for (let i = 0; i < orderLines.length; i++) {
    drawText(page, geo.leftX + 12, labelY - 13 - i * 13, orderLines[i]!, {
      bold: true,
      size: 10.5,
      color: BRAND_COLORS.navy,
    });
  }
  for (let i = 0; i < projectLines.length; i++) {
    drawText(page, projectX, labelY - 13 - i * 13, projectLines[i]!, {
      bold: true,
      size: 10,
      color: BRAND_COLORS.navy,
    });
  }

  return boxBottomY - 18;
}

function drawTableHeaderBand(
  page: PageStreamBuilder,
  geo: PageGeometry,
  y: number,
  descriptionHeading: string,
): number {
  const bandHeight = 20;
  const bandBottomY = y - 14;
  drawRect(page, geo.leftX, bandBottomY, geo.contentWidth, bandHeight, {
    fill: BRAND_COLORS.tableHeaderBg,
  });
  drawRule(page, geo.leftX, geo.rightX, bandBottomY + bandHeight, {
    color: BRAND_COLORS.borderStrong,
    width: 0.7,
  });
  drawRule(page, geo.leftX, geo.rightX, bandBottomY, {
    color: BRAND_COLORS.tealAccent,
    width: 1.1,
  });

  const textY = y - 7;
  drawText(page, geo.colPosX, textY, "#", { bold: true, size: 8.5, color: BRAND_COLORS.navy });
  drawText(page, geo.colDescX, textY, descriptionHeading, {
    bold: true,
    size: 8.5,
    color: BRAND_COLORS.navy,
  });
  drawText(page, geo.colQtyX, textY, "Qty", { bold: true, size: 8.5, color: BRAND_COLORS.navy });
  drawText(page, geo.colUnitX, textY, "Unit Price", {
    bold: true,
    size: 8.5,
    color: BRAND_COLORS.navy,
  });
  drawText(page, geo.colTotalX, textY, "Line Total", {
    bold: true,
    size: 8.5,
    color: BRAND_COLORS.navy,
  });

  return bandBottomY - 14;
}

function drawHighlightedTotalRow(
  page: PageStreamBuilder,
  geo: PageGeometry,
  y: number,
  label: string,
  formattedAmount: string,
): number {
  const boxX = geo.rightX - 256;
  const boxWidth = 256;
  const boxHeight = 20;
  const boxBottomY = y - 6;
  drawRect(page, boxX, boxBottomY, boxWidth, boxHeight, {
    fill: BRAND_COLORS.totalsBg,
    stroke: BRAND_COLORS.tealAccent,
    strokeWidth: 0.85,
  });
  drawText(page, boxX + 8, y, label, { bold: true, size: 10, color: BRAND_COLORS.navy });
  drawText(page, geo.colTotalX - 4, y, formattedAmount, {
    bold: true,
    size: 10,
    color: BRAND_COLORS.navy,
  });
  return boxBottomY - 10;
}

export function formatPaymentMethodSummaryPlain(input: {
  settlementKind: ReceiptSettlementKind;
  paymentMethod: string;
  paymentMethodBrand: string | null;
  paymentMethodLast4: string | null;
  provider: string | null;
}): string {
  if (input.settlementKind === "zero_total") {
    return "Covered in full by discount (no charge)";
  }
  if (input.settlementKind === "waived_small_total" || input.paymentMethod === "waiver") {
    return "Small remaining balance waived at checkout (no charge)";
  }

  const brand = input.paymentMethodBrand?.trim();
  const last4 =
    input.paymentMethodLast4 && /^[0-9]{4}$/u.test(input.paymentMethodLast4)
      ? input.paymentMethodLast4
      : null;
  const brandLabel = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "Card";

  if (brand || last4) {
    const ending = last4 ? ` ending in ${last4}` : "";
    const via = input.provider
      ? ` via ${input.provider.charAt(0).toUpperCase() + input.provider.slice(1)}`
      : "";
    return `${brandLabel}${ending}${via}`;
  }

  if (input.paymentMethod === "provider_online") {
    return input.provider
      ? `Online payment (${input.provider.charAt(0).toUpperCase() + input.provider.slice(1)})`
      : "Online payment";
  }

  const manualLabels: Record<string, string> = {
    bank_transfer: "Bank transfer",
    wire: "Wire transfer",
    ach: "ACH transfer",
    check: "Check",
    card_manual: "Card (manual)",
    cash: "Cash",
    waiver: "Waived",
    other: "Recorded payment",
  };
  return manualLabels[input.paymentMethod] ?? input.paymentMethod;
}

/**
 * Generates a self-contained, dependency-free branded PDF 1.4 invoice document with exact byte offsets,
 * document title + language + DisplayDocTitle metadata, tagged `/Figure` alt text for the ReadyPackets logo,
 * prominent Order + Project callout, and full `/WinAnsiEncoding` glyph support.
 */
export function renderInvoicePdf(
  input: InvoicePdfInput,
  opts?: { staticDir?: string | null | undefined },
): Buffer {
  const geo = resolvePageGeometry(input.pageSize ?? "LETTER");
  const logo = resolveLogoImage({
    logoPng: input.logoPng,
    issuerLogo: input.issuerLogo,
    staticDir: opts?.staticDir,
  });
  const pages: PageStreamBuilder[] = [];

  const startPage = (): PageStreamBuilder => {
    const p: PageStreamBuilder = { ops: [], hasLogo: false, hasTaggedLogoFigure: false };
    drawTopBrandBand(p, geo);
    pages.push(p);
    return p;
  };

  let page = startPage();
  let y = geo.topStartY;

  const ensureSpace = (needed: number) => {
    if (y - needed < geo.bottomSafeY) {
      page = startPage();
      y = geo.topStartY;
      drawText(
        page,
        geo.leftX,
        y,
        `${PDF_BRAND_SHORT_NAME} · Invoice ${input.invoiceNumber} (Order ${input.orderReference})`,
        { bold: true, size: 10, color: BRAND_COLORS.navy, tag: "H2" },
      );
      y -= 16;
      drawRule(page, geo.leftX, geo.rightX, y, { color: BRAND_COLORS.tealAccent, width: 0.9 });
      y -= 18;
    }
  };

  const leftBottomY = drawCompanyBlock(
    page,
    geo,
    y,
    {
      name: input.issuerName,
      address: input.issuerAddress,
      contact: input.issuerContact,
      taxId: input.issuerTaxId,
    },
    logo,
  );

  const rightBottomY = drawDocumentMetaPanel(
    page,
    geo,
    y,
    "INVOICE",
    `Status: ${input.status.toUpperCase()}`,
    [
      { label: "Invoice #", value: input.invoiceNumber, bold: true },
      { label: "Issued", value: formatUtcDate(input.issuedAt) },
      { label: "Due", value: formatUtcDate(input.dueAt) },
      { label: "Currency", value: input.currency.toUpperCase() },
    ],
  );

  y = Math.min(leftBottomY, rightBottomY) - 6;
  drawRule(page, geo.leftX, geo.rightX, y, { color: BRAND_COLORS.tealAccent, width: 1.0 });
  y -= 14;

  // Prominent Order & Project block
  y = drawOrderProjectBanner(page, geo, y, input.orderReference, input.projectName);

  // Bill To
  drawText(page, geo.leftX, y, "BILL TO", {
    bold: true,
    size: 8.5,
    color: BRAND_COLORS.tealText,
    tag: "H2",
  });
  y -= 13;
  for (const custLine of wrapText(input.customerName, geo.bodyWrapChars).slice(0, 2)) {
    drawText(page, geo.leftX, y, custLine, { bold: true, size: 10, color: BRAND_COLORS.navy });
    y -= 13;
  }
  if (input.customerRef?.trim()) {
    drawText(page, geo.leftX, y, `Customer ID: ${input.customerRef.trim()}`, {
      size: 8.5,
      color: BRAND_COLORS.slateMuted,
    });
    y -= 12;
  }
  drawText(page, geo.leftX, y, input.customerEmail, { size: 8.5, color: BRAND_COLORS.slateMuted });
  y -= 18;

  if (input.status === "void") {
    const voidNotice = `VOIDED on ${formatUtcDate(input.voidedAt)}${input.voidReason ? ` - Reason: ${input.voidReason}` : ""}`;
    const voidLines = wrapText(voidNotice, geo.bodyWrapChars - 4);
    const voidBoxH = 10 + Math.max(1, voidLines.length) * 12;
    ensureSpace(voidBoxH + 12);
    drawRect(page, geo.leftX, y - voidBoxH + 8, geo.contentWidth, voidBoxH, {
      fill: BRAND_COLORS.voidBg,
      stroke: BRAND_COLORS.voidBorder,
      strokeWidth: 0.9,
    });
    for (const vLine of voidLines) {
      drawText(page, geo.leftX + 8, y - 2, vLine, {
        bold: true,
        size: 9,
        color: BRAND_COLORS.voidBorder,
      });
      y -= 12;
    }
    y -= 12;
  }

  // Line items table
  ensureSpace(48);
  y = drawTableHeaderBand(page, geo, y, "Description");

  for (const line of input.lines) {
    const descLines = wrapText(line.description, geo.descWrapChars);
    const rowHeight = Math.max(1, descLines.length) * 13 + 6;
    ensureSpace(rowHeight + 16);

    drawText(page, geo.colPosX, y, String(line.position), {
      size: 9,
      color: BRAND_COLORS.slateMuted,
    });
    drawText(page, geo.colDescX, y, descLines[0] ?? line.description, {
      size: 9,
      color: BRAND_COLORS.navy,
    });
    drawText(page, geo.colQtyX, y, String(line.quantity), {
      size: 9,
      color: BRAND_COLORS.slateBody,
    });
    drawText(page, geo.colUnitX, y, formatMinorUnitsPlain(line.unitAmountMinor, input.currency), {
      size: 9,
      color: BRAND_COLORS.slateBody,
    });
    drawText(page, geo.colTotalX, y, formatMinorUnitsPlain(line.lineTotalMinor, input.currency), {
      bold: true,
      size: 9,
      color: BRAND_COLORS.navy,
    });
    y -= 13;

    for (let i = 1; i < descLines.length; i++) {
      drawText(page, geo.colDescX, y, descLines[i]!, {
        size: 8.5,
        color: BRAND_COLORS.slateMuted,
      });
      y -= 12;
    }
    drawRule(page, geo.leftX, geo.rightX, y + 4, { color: BRAND_COLORS.borderRow, width: 0.5 });
    y -= 8;
  }

  // Totals summary
  ensureSpace(136);
  y -= 4;
  const summaryLabelX = geo.rightX - 248;
  const summaryAmountX = geo.colTotalX - 4;
  const drawSummaryRow = (label: string, amountMinor: number, bold = false) => {
    const wrappedLines = wrapText(label, 34).slice(0, 2);
    drawText(page, summaryAmountX, y, formatMinorUnitsPlain(amountMinor, input.currency), {
      bold,
      size: bold ? 9.5 : 9,
      color: bold ? BRAND_COLORS.navy : BRAND_COLORS.slateBody,
    });
    for (let i = 0; i < wrappedLines.length; i++) {
      drawText(page, summaryLabelX, y - i * 12, wrappedLines[i]!, {
        bold,
        size: bold ? 9.5 : 9,
        color: bold ? BRAND_COLORS.navy : BRAND_COLORS.slateBody,
      });
    }
    y -= 14 + Math.max(0, wrappedLines.length - 1) * 12;
  };

  drawSummaryRow("Subtotal", input.subtotalMinor);
  const promoMinor = Math.max(0, input.promoDiscountMinor ?? 0);
  if (promoMinor > 0) {
    const bundleMinor = Math.max(0, input.bundleDiscountMinor ?? input.discountMinor - promoMinor);
    if (bundleMinor > 0) {
      drawSummaryRow(input.discountLabel ?? "Bundle discount", -bundleMinor);
    }
    drawSummaryRow(input.promoLabel ? `Discount (${input.promoLabel})` : "Code discount", -promoMinor);
  } else if (input.discountMinor > 0) {
    drawSummaryRow(
      input.discountLabel ? `Discount (${input.discountLabel})` : "Discount",
      -input.discountMinor,
    );
  }
  if (input.taxMinor > 0) {
    drawSummaryRow("Tax", input.taxMinor);
  }
  drawRule(page, summaryLabelX, geo.rightX, y + 6, { color: BRAND_COLORS.borderStrong, width: 0.7 });
  y -= 4;
  drawSummaryRow("Invoice Total", input.totalMinor, true);
  if (input.grossPaidMinor > 0) {
    drawSummaryRow("Payments Recorded", input.grossPaidMinor);
  }
  if ((input.waivedMinor ?? 0) > 0) {
    drawSummaryRow("Small-Balance Waiver", -(input.waivedMinor ?? 0));
  }
  if (input.refundedMinor > 0) {
    drawSummaryRow("Refunds Recorded", -input.refundedMinor);
  }
  y -= 2;
  y = drawHighlightedTotalRow(
    page,
    geo,
    y,
    "Balance Due",
    formatMinorUnitsPlain(input.balanceDueMinor, input.currency),
  );

  // Payment & refund ledger
  if (input.payments.length > 0 || input.refunds.length > 0) {
    ensureSpace(56);
    y -= 6;
    drawRule(page, geo.leftX, geo.rightX, y + 4, { color: BRAND_COLORS.borderSubtle });
    y -= 12;
    drawText(page, geo.leftX, y, "RECORDED PAYMENT & REFUND EVIDENCE", {
      bold: true,
      size: 8.5,
      color: BRAND_COLORS.tealText,
      tag: "H2",
    });
    y -= 14;
    for (const pmt of input.payments) {
      const pmtText = `Payment (${pmt.method}) on ${formatUtcDate(pmt.receivedAt)} · Ref: ${pmt.reference} · ${formatMinorUnitsPlain(pmt.amountMinor, input.currency)}`;
      for (const line of wrapText(pmtText, geo.bodyWrapChars)) {
        ensureSpace(16);
        drawText(page, geo.leftX, y, line, { size: 8.5, color: BRAND_COLORS.slateBody });
        y -= 12;
      }
    }
    for (const rfd of input.refunds) {
      const rfdText = `Refund (${rfd.reasonCode}) on ${formatUtcDate(rfd.refundedAt)} · Ref: ${rfd.reference} · -${formatMinorUnitsPlain(rfd.amountMinor, input.currency)}`;
      for (const line of wrapText(rfdText, geo.bodyWrapChars)) {
        ensureSpace(16);
        drawText(page, geo.leftX, y, line, { size: 8.5, color: BRAND_COLORS.slateBody });
        y -= 12;
      }
    }
  }

  // Memo & payment instructions
  if (input.memo?.trim()) {
    ensureSpace(44);
    y -= 8;
    drawText(page, geo.leftX, y, "MEMO", {
      bold: true,
      size: 8.5,
      color: BRAND_COLORS.tealText,
      tag: "H2",
    });
    y -= 13;
    for (const line of wrapText(input.memo, geo.bodyWrapChars)) {
      ensureSpace(16);
      drawText(page, geo.leftX, y, line, { size: 9, color: BRAND_COLORS.slateBody });
      y -= 12;
    }
  }

  if (input.status === "issued" && input.balanceDueMinor > 0 && input.paymentInstructions.trim()) {
    ensureSpace(44);
    y -= 8;
    drawText(page, geo.leftX, y, "PAYMENT INSTRUCTIONS", {
      bold: true,
      size: 8.5,
      color: BRAND_COLORS.tealText,
      tag: "H2",
    });
    y -= 13;
    for (const line of wrapText(input.paymentInstructions, geo.bodyWrapChars)) {
      ensureSpace(16);
      drawText(page, geo.leftX, y, line, { size: 9, color: BRAND_COLORS.slateBody });
      y -= 12;
    }
  }

  return assembleTaggedPdf14({
    title: `Invoice ${input.invoiceNumber}`,
    pages,
    logo,
    geo,
  });
}

/**
 * Generates an immutable branded PDF 1.4 Payment Receipt (`RPR-<year>-<6 digits>`) from a stored `ReceiptSnapshot`.
 */
export function renderPaymentReceiptPdf(
  snapshot: ReceiptSnapshot,
  opts?: {
    logoPng?: Buffer | null | undefined;
    pageSize?: PdfPageSize | undefined;
    projectName?: string | null | undefined;
  },
): Buffer {
  const geo = resolvePageGeometry(opts?.pageSize ?? "LETTER");
  const logo = resolveLogoImage({
    logoPng: opts?.logoPng,
    logoMode: snapshot.company.logoMode,
    logoBrandPath: snapshot.company.logoBrandPath,
  });
  const resolvedProjectName = opts?.projectName ?? snapshot.projectName;

  const pages: PageStreamBuilder[] = [];
  const startPage = (): PageStreamBuilder => {
    const p: PageStreamBuilder = { ops: [], hasLogo: false, hasTaggedLogoFigure: false };
    drawTopBrandBand(p, geo);
    pages.push(p);
    return p;
  };

  let page = startPage();
  let y = geo.topStartY;

  const ensureSpace = (needed: number) => {
    if (y - needed < geo.bottomSafeY) {
      page = startPage();
      y = geo.topStartY;
      drawText(
        page,
        geo.leftX,
        y,
        `${PDF_BRAND_SHORT_NAME} · Receipt ${snapshot.receiptNumber} (Order ${snapshot.orderReference})`,
        { bold: true, size: 10, color: BRAND_COLORS.navy, tag: "H2" },
      );
      y -= 16;
      drawRule(page, geo.leftX, geo.rightX, y, { color: BRAND_COLORS.tealAccent, width: 0.9 });
      y -= 18;
    }
  };

  const leftBottomY = drawCompanyBlock(
    page,
    geo,
    y,
    {
      name: snapshot.company.legalName,
      address: snapshot.company.address,
      contact: snapshot.company.contact,
      taxId: snapshot.company.taxId,
    },
    logo,
  );

  const settlementBadge =
    snapshot.settlementKind === "zero_total"
      ? "Status: SETTLED (NO CHARGE)"
      : snapshot.settlementKind === "waived_small_total"
        ? "Status: WAIVED"
        : "Status: PAID";

  const rightBottomY = drawDocumentMetaPanel(page, geo, y, "PAYMENT RECEIPT", settlementBadge, [
    { label: "Receipt #", value: snapshot.receiptNumber, bold: true },
    { label: "Issued", value: formatUtcTimestamp(snapshot.issuedAt) },
    { label: "Invoice #", value: snapshot.invoiceNumber },
    { label: "Currency", value: snapshot.currency.toUpperCase() },
  ]);

  y = Math.min(leftBottomY, rightBottomY) - 6;
  drawRule(page, geo.leftX, geo.rightX, y, { color: BRAND_COLORS.tealAccent, width: 1.0 });
  y -= 14;

  // Prominent Order & Project block
  y = drawOrderProjectBanner(page, geo, y, snapshot.orderReference, resolvedProjectName);

  // Customer block
  drawText(page, geo.leftX, y, "RECEIPT FOR", {
    bold: true,
    size: 8.5,
    color: BRAND_COLORS.tealText,
    tag: "H2",
  });
  y -= 13;
  for (const custLine of wrapText(snapshot.customer.name, geo.bodyWrapChars).slice(0, 2)) {
    drawText(page, geo.leftX, y, custLine, { bold: true, size: 10, color: BRAND_COLORS.navy });
    y -= 13;
  }
  if (snapshot.customer.customerRef?.trim()) {
    drawText(page, geo.leftX, y, `Customer ID: ${snapshot.customer.customerRef.trim()}`, {
      size: 8.5,
      color: BRAND_COLORS.slateMuted,
    });
    y -= 12;
  }
  if (snapshot.customer.email.trim()) {
    drawText(page, geo.leftX, y, snapshot.customer.email.trim(), {
      size: 8.5,
      color: BRAND_COLORS.slateMuted,
    });
    y -= 12;
  }
  y -= 10;

  // Line items table
  ensureSpace(48);
  y = drawTableHeaderBand(page, geo, y, "Item / Tier");

  for (const line of snapshot.lines) {
    const descLines = wrapText(line.description, geo.descWrapChars);
    const rowHeight = Math.max(1, descLines.length) * 13 + 6;
    ensureSpace(rowHeight + 16);

    drawText(page, geo.colPosX, y, String(line.position), {
      size: 9,
      color: BRAND_COLORS.slateMuted,
    });
    drawText(page, geo.colDescX, y, descLines[0] ?? line.description, {
      size: 9,
      color: BRAND_COLORS.navy,
    });
    drawText(page, geo.colQtyX, y, String(line.quantity), {
      size: 9,
      color: BRAND_COLORS.slateBody,
    });
    drawText(page, geo.colUnitX, y, formatMinorUnitsPlain(line.unitAmountMinor, snapshot.currency), {
      size: 9,
      color: BRAND_COLORS.slateBody,
    });
    drawText(page, geo.colTotalX, y, formatMinorUnitsPlain(line.lineTotalMinor, snapshot.currency), {
      bold: true,
      size: 9,
      color: BRAND_COLORS.navy,
    });
    y -= 13;

    for (let i = 1; i < descLines.length; i++) {
      drawText(page, geo.colDescX, y, descLines[i]!, {
        size: 8.5,
        color: BRAND_COLORS.slateMuted,
      });
      y -= 12;
    }
    drawRule(page, geo.leftX, geo.rightX, y + 4, { color: BRAND_COLORS.borderRow, width: 0.5 });
    y -= 8;
  }

  // Totals breakdown
  ensureSpace(136);
  y -= 4;
  const summaryLabelX = geo.rightX - 248;
  const summaryAmountX = geo.colTotalX - 4;
  const drawSummaryRow = (label: string, amountMinor: number, bold = false) => {
    const wrappedLines = wrapText(label, 34).slice(0, 2);
    drawText(page, summaryAmountX, y, formatMinorUnitsPlain(amountMinor, snapshot.currency), {
      bold,
      size: bold ? 9.5 : 9,
      color: bold ? BRAND_COLORS.navy : BRAND_COLORS.slateBody,
    });
    for (let i = 0; i < wrappedLines.length; i++) {
      drawText(page, summaryLabelX, y - i * 12, wrappedLines[i]!, {
        bold,
        size: bold ? 9.5 : 9,
        color: bold ? BRAND_COLORS.navy : BRAND_COLORS.slateBody,
      });
    }
    y -= 14 + Math.max(0, wrappedLines.length - 1) * 12;
  };

  drawSummaryRow("Subtotal", snapshot.subtotalMinor);
  if (snapshot.bundleDiscountMinor > 0) {
    drawSummaryRow(snapshot.discountLabel ?? "Bundle discount", -snapshot.bundleDiscountMinor);
  }
  if (snapshot.promoDiscountMinor > 0) {
    drawSummaryRow(
      snapshot.promoLabel ? `Discount (${snapshot.promoLabel})` : "Code discount",
      -snapshot.promoDiscountMinor,
    );
  } else if (snapshot.discountMinor > 0 && snapshot.bundleDiscountMinor === 0) {
    drawSummaryRow(
      snapshot.discountLabel ? `Discount (${snapshot.discountLabel})` : "Discount",
      -snapshot.discountMinor,
    );
  }
  if (snapshot.taxMinor > 0) {
    drawSummaryRow("Tax", snapshot.taxMinor);
  }
  if (snapshot.amountWaivedMinor > 0) {
    drawSummaryRow("Amount waived", -snapshot.amountWaivedMinor);
  }
  y -= 2;
  y = drawHighlightedTotalRow(
    page,
    geo,
    y,
    "Amount paid",
    formatMinorUnitsPlain(snapshot.amountPaidMinor, snapshot.currency),
  );

  // Payment method & reference block
  ensureSpace(76);
  y -= 8;
  drawRule(page, geo.leftX, geo.rightX, y + 4, { color: BRAND_COLORS.borderSubtle });
  y -= 13;
  drawText(page, geo.leftX, y, "PAYMENT SUMMARY", {
    bold: true,
    size: 8.5,
    color: BRAND_COLORS.tealText,
    tag: "H2",
  });
  y -= 14;

  const methodSummary = formatPaymentMethodSummaryPlain({
    settlementKind: snapshot.settlementKind,
    paymentMethod: snapshot.paymentMethod,
    paymentMethodBrand: snapshot.paymentMethodBrand,
    paymentMethodLast4: snapshot.paymentMethodLast4,
    provider: snapshot.provider,
  });
  for (const line of wrapText(`Payment method: ${methodSummary}`, geo.bodyWrapChars)) {
    ensureSpace(16);
    drawText(page, geo.leftX, y, line, { size: 9, color: BRAND_COLORS.slateBody });
    y -= 12;
  }

  if (snapshot.providerReference?.trim()) {
    for (const line of wrapText(`Reference: ${snapshot.providerReference.trim()}`, geo.bodyWrapChars)) {
      ensureSpace(16);
      drawText(page, geo.leftX, y, line, { size: 8.5, color: BRAND_COLORS.slateMuted });
      y -= 12;
    }
  }

  if (snapshot.footerText.trim()) {
    ensureSpace(40);
    y -= 8;
    for (const line of wrapText(snapshot.footerText, geo.bodyWrapChars)) {
      ensureSpace(15);
      drawText(page, geo.leftX, y, line, { size: 8.5, color: BRAND_COLORS.slateMuted });
      y -= 12;
    }
  }

  return assembleTaggedPdf14({
    title: `Payment Receipt ${snapshot.receiptNumber}`,
    pages,
    logo,
    geo,
  });
}

/**
 * Generates an immutable branded PDF 1.4 Refund Note (`RPRN-<year>-<6 digits>`) linked to a Payment Receipt.
 */
export function renderRefundNotePdf(
  snapshot: RefundNoteSnapshot,
  opts?: {
    logoPng?: Buffer | null | undefined;
    pageSize?: PdfPageSize | undefined;
    projectName?: string | null | undefined;
  },
): Buffer {
  const geo = resolvePageGeometry(opts?.pageSize ?? "LETTER");
  const logo = resolveLogoImage({
    logoPng: opts?.logoPng,
    logoMode: snapshot.company.logoMode,
    logoBrandPath: snapshot.company.logoBrandPath,
  });
  const resolvedProjectName = opts?.projectName ?? snapshot.projectName;

  const pages: PageStreamBuilder[] = [];
  const startPage = (): PageStreamBuilder => {
    const p: PageStreamBuilder = { ops: [], hasLogo: false, hasTaggedLogoFigure: false };
    drawTopBrandBand(p, geo);
    pages.push(p);
    return p;
  };

  let page = startPage();
  let y = geo.topStartY;

  const ensureSpace = (needed: number) => {
    if (y - needed < geo.bottomSafeY) {
      page = startPage();
      y = geo.topStartY;
      drawText(
        page,
        geo.leftX,
        y,
        `${PDF_BRAND_SHORT_NAME} · Refund Note ${snapshot.noteNumber} (Order ${snapshot.orderReference})`,
        { bold: true, size: 10, color: BRAND_COLORS.navy, tag: "H2" },
      );
      y -= 16;
      drawRule(page, geo.leftX, geo.rightX, y, { color: BRAND_COLORS.tealAccent, width: 0.9 });
      y -= 18;
    }
  };

  const stateLabel =
    snapshot.resultingRefundState === "refunded" ? "Refunded in full" : "Partially refunded";

  const leftBottomY = drawCompanyBlock(
    page,
    geo,
    y,
    {
      name: snapshot.company.legalName,
      address: snapshot.company.address,
      contact: snapshot.company.contact,
      taxId: snapshot.company.taxId,
    },
    logo,
  );

  const rightBottomY = drawDocumentMetaPanel(
    page,
    geo,
    y,
    "REFUND NOTE",
    `Status: ${stateLabel.toUpperCase()}`,
    [
      { label: "Refund Note #", value: snapshot.noteNumber, bold: true },
      { label: "Original Receipt #", value: snapshot.receiptNumber, bold: true },
      { label: "Issued", value: formatUtcTimestamp(snapshot.issuedAt) },
      { label: "Invoice #", value: snapshot.invoiceNumber },
    ],
  );

  y = Math.min(leftBottomY, rightBottomY) - 6;
  drawRule(page, geo.leftX, geo.rightX, y, { color: BRAND_COLORS.tealAccent, width: 1.0 });
  y -= 14;

  // Prominent Order & Project block
  y = drawOrderProjectBanner(page, geo, y, snapshot.orderReference, resolvedProjectName);

  drawText(page, geo.leftX, y, "CUSTOMER", {
    bold: true,
    size: 8.5,
    color: BRAND_COLORS.tealText,
    tag: "H2",
  });
  y -= 13;
  for (const custLine of wrapText(snapshot.customer.name, geo.bodyWrapChars).slice(0, 2)) {
    drawText(page, geo.leftX, y, custLine, { bold: true, size: 10, color: BRAND_COLORS.navy });
    y -= 13;
  }
  if (snapshot.customer.customerRef?.trim()) {
    drawText(page, geo.leftX, y, `Customer ID: ${snapshot.customer.customerRef.trim()}`, {
      size: 8.5,
      color: BRAND_COLORS.slateMuted,
    });
    y -= 12;
  }
  if (snapshot.customer.email.trim()) {
    drawText(page, geo.leftX, y, snapshot.customer.email.trim(), {
      size: 8.5,
      color: BRAND_COLORS.slateMuted,
    });
    y -= 12;
  }
  y -= 10;

  ensureSpace(120);
  drawRule(page, geo.leftX, geo.rightX, y + 4, { color: BRAND_COLORS.borderStrong, width: 0.7 });
  y -= 14;
  drawText(page, geo.leftX, y, "REFUND DETAILS", {
    bold: true,
    size: 9.5,
    color: BRAND_COLORS.navy,
    tag: "H2",
  });
  y -= 18;

  const valueColX = geo.rightX - 180;
  drawText(page, geo.leftX, y, "Original receipt amount paid:", {
    size: 9,
    color: BRAND_COLORS.slateBody,
  });
  drawText(
    page,
    valueColX,
    y,
    formatMinorUnitsPlain(snapshot.originalAmountPaidMinor, snapshot.currency),
    { size: 9, color: BRAND_COLORS.slateBody },
  );
  y -= 15;

  drawText(page, geo.leftX, y, "Cumulative refunded against receipt:", {
    size: 9,
    color: BRAND_COLORS.slateBody,
  });
  drawText(
    page,
    valueColX,
    y,
    formatMinorUnitsPlain(snapshot.cumulativeRefundedMinor, snapshot.currency),
    { size: 9, color: BRAND_COLORS.slateBody },
  );
  y -= 15;

  drawText(page, geo.leftX, y, "Receipt status after refund:", {
    size: 9,
    color: BRAND_COLORS.slateBody,
  });
  drawText(page, valueColX, y, stateLabel, { bold: true, size: 9, color: BRAND_COLORS.navy });
  y -= 20;

  y = drawHighlightedTotalRow(
    page,
    geo,
    y,
    "Refund amount (this note)",
    formatMinorUnitsPlain(snapshot.refundAmountMinor, snapshot.currency),
  );

  for (const line of wrapText(`Reason code: ${snapshot.reasonCode}`, geo.bodyWrapChars)) {
    ensureSpace(15);
    drawText(page, geo.leftX, y, line, { size: 8.5, color: BRAND_COLORS.slateMuted });
    y -= 12;
  }
  for (const line of wrapText(`Reference: ${snapshot.reference}`, geo.bodyWrapChars)) {
    ensureSpace(15);
    drawText(page, geo.leftX, y, line, { size: 8.5, color: BRAND_COLORS.slateMuted });
    y -= 12;
  }
  y -= 8;

  ensureSpace(32);
  drawRule(page, geo.leftX, geo.rightX, y + 4, { color: BRAND_COLORS.borderSubtle });
  y -= 14;
  for (const line of wrapText(
    `This refund note supplements original receipt ${snapshot.receiptNumber}, which remains unchanged.`,
    geo.bodyWrapChars,
  )) {
    drawText(page, geo.leftX, y, line, { size: 8.5, color: BRAND_COLORS.slateMuted });
    y -= 12;
  }

  return assembleTaggedPdf14({
    title: `Refund Note ${snapshot.noteNumber}`,
    pages,
    logo,
    geo,
  });
}
