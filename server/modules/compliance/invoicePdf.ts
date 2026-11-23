import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import type { InvoiceStatus, ReceiptNoteRefundState, ReceiptSettlementKind } from "./schema.js";
import { DOCUMENT_LOGO_ALLOWLIST, type IssuerLogoSetting } from "./settings.js";

export interface InvoicePdfInput {
  invoicePublicId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  orderReference: string;
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

/**
 * Loads and decodes a reviewed, self-hosted brand PNG from `client/public/brand/...`.
 * Strictly rejects any path not in `DOCUMENT_LOGO_ALLOWLIST` or escaping `client/public/brand`.
 */
export function loadAllowlistedBrandLogo(brandPath: string | null | undefined): DecodedPdfLogoImage | null {
  if (!brandPath || !(DOCUMENT_LOGO_ALLOWLIST as readonly string[]).includes(brandPath)) {
    return null;
  }
  if (parsedLogoCache.has(brandPath)) {
    return parsedLogoCache.get(brandPath) ?? null;
  }

  try {
    const brandRoot = path.resolve(process.cwd(), "client/public/brand");
    const candidate = path.resolve(process.cwd(), "client/public", brandPath.replace(/^\/+/u, ""));
    if (!candidate.startsWith(`${brandRoot}${path.sep}`)) {
      parsedLogoCache.set(brandPath, null);
      return null;
    }
    const stat = statSync(candidate);
    if (!stat.isFile() || stat.size > MAX_LOGO_PNG_BYTES) {
      parsedLogoCache.set(brandPath, null);
      return null;
    }
    const decoded = parsePngForPdf(readFileSync(candidate));
    parsedLogoCache.set(brandPath, decoded);
    return decoded;
  } catch {
    parsedLogoCache.set(brandPath, null);
    return null;
  }
}

function resolveLogoImage(opts?: {
  logoPng?: Buffer | null | undefined;
  issuerLogo?: IssuerLogoSetting | null | undefined;
  logoMode?: "brand" | "none" | undefined;
  logoBrandPath?: string | null | undefined;
}): DecodedPdfLogoImage | null {
  if (opts?.logoPng) {
    return parsePngForPdf(opts.logoPng);
  }
  if (opts?.issuerLogo) {
    if (opts.issuerLogo.mode === "none") return null;
    return loadAllowlistedBrandLogo(opts.issuerLogo.brandPath);
  }
  if (opts?.logoMode === "brand" && opts.logoBrandPath) {
    return loadAllowlistedBrandLogo(opts.logoBrandPath);
  }
  return null;
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
 * Sanitizes text to printable ASCII/Latin-1 and escapes PDF string delimiters `\`, `(`, `)`.
 * Control characters and raw PDF operators cannot break out of a literal string.
 */
function escapePdfText(raw: string): string {
  const normalized = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/—|–/g, "-")
    .replace(/[^\x20-\x7e]/g, "?");
  return normalized.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapText(text: string, maxChars: number): string[] {
  const cleaned = text.replace(/\r\n?/g, "\n").trim();
  if (!cleaned) return [];
  const out: string[] = [];
  for (const paragraph of cleaned.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        if (current) out.push(current);
        current = word.length > maxChars ? word.slice(0, maxChars) : word;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

interface PageStreamBuilder {
  ops: string[];
  hasLogo: boolean;
}

function drawText(
  page: PageStreamBuilder,
  x: number,
  y: number,
  text: string,
  opts?: { bold?: boolean; size?: number; gray?: number },
): void {
  const font = opts?.bold ? "/F2" : "/F1";
  const size = opts?.size ?? 10;
  const gray = opts?.gray ?? 0.08;
  page.ops.push(`/P BMC BT ${gray.toFixed(2)} g ${font} ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET EMC`);
}

function drawRule(page: PageStreamBuilder, x1: number, x2: number, y: number, gray = 0.82): void {
  page.ops.push(`/Artifact BMC ${gray.toFixed(2)} G 0.6 w ${x1} ${y} m ${x2} ${y} l S EMC`);
}

function drawLogo(
  page: PageStreamBuilder,
  logo: DecodedPdfLogoImage,
  x: number,
  topY: number,
  maxWidthPt = 110,
  maxHeightPt = 28,
): { drawWidth: number; drawHeight: number } {
  const scale = Math.min(maxWidthPt / logo.width, maxHeightPt / logo.height, 1);
  const drawWidth = Math.max(12, Math.round(logo.width * scale * 100) / 100);
  const drawHeight = Math.max(12, Math.round(logo.height * scale * 100) / 100);
  const bottomY = Math.round((topY - drawHeight + 12) * 100) / 100;
  page.hasLogo = true;
  page.ops.push(`/Artifact BMC q ${drawWidth} 0 0 ${drawHeight} ${x} ${bottomY} cm /ImLogo Do Q EMC`);
  return { drawWidth, drawHeight };
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
}): Buffer {
  // Object numbering:
  // 1: Catalog (/Lang (en), /MarkInfo << /Marked true >>, /StructTreeRoot 5 0 R)
  // 2: Pages
  // 3: Font Helvetica (/F1)
  // 4: Font Helvetica-Bold (/F2)
  // 5: StructTreeRoot
  // 6: StructElem (/S /Document)
  // 7: Info (/Title (...) /Producer (ReadyPackets))
  // Optional 8 (+ 9): /ImLogo (+ /ImLogoMask)
  const objects: Buffer[] = [];
  const pushStrObj = (s: string) => {
    objects.push(Buffer.from(s, "latin1"));
  };

  pushStrObj(
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Lang (en) /MarkInfo << /Marked true >> /StructTreeRoot 5 0 R >>\nendobj\n",
  );
  pushStrObj(""); // Placeholder index 1 for Object 2 (Pages)
  pushStrObj(
    "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n",
  );
  pushStrObj(
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n",
  );
  pushStrObj("5 0 obj\n<< /Type /StructTreeRoot /K [6 0 R] >>\nendobj\n");
  pushStrObj("6 0 obj\n<< /Type /StructElem /S /Document /P 5 0 R >>\nendobj\n");
  pushStrObj(
    `7 0 obj\n<< /Title (${escapePdfText(args.title)}) /Producer (ReadyPackets) >>\nendobj\n`,
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
    const xObjectRes =
      pageBuilder.hasLogo && logoObjNum !== null ? ` /XObject << /ImLogo ${logoObjNum} 0 R >>` : "";
    pushStrObj(
      `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Tabs /S /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xObjectRes} >> /Contents ${contentObjNum} 0 R >>\nendobj\n`,
    );
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

function drawCompanyBlock(
  page: PageStreamBuilder,
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
  let nameX = 50;
  if (logo) {
    const dims = drawLogo(page, logo, 50, y);
    if (dims.drawWidth <= 36) {
      nameX = Math.round(50 + dims.drawWidth + 10);
    } else {
      y -= Math.ceil(dims.drawHeight) + 6;
    }
  }
  drawText(page, nameX, y, company.name, { bold: true, size: 16 });
  y -= 18;

  for (const addrLine of wrapText(company.address, 54).slice(0, 3)) {
    drawText(page, 50, y, addrLine, { size: 9, gray: 0.35 });
    y -= 13;
  }
  if (company.contact?.trim()) {
    for (const contactLine of wrapText(company.contact, 54).slice(0, 2)) {
      drawText(page, 50, y, contactLine, { size: 9, gray: 0.35 });
      y -= 13;
    }
  }
  if (company.taxId?.trim()) {
    drawText(page, 50, y, `Tax / Reg ID: ${company.taxId.trim()}`, { size: 9, gray: 0.35 });
    y -= 13;
  }
  return y;
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
  const last4 = input.paymentMethodLast4 && /^[0-9]{4}$/u.test(input.paymentMethodLast4)
    ? input.paymentMethodLast4
    : null;
  const brandLabel = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "Card";

  if (brand || last4) {
    const ending = last4 ? ` ending in ${last4}` : "";
    const via = input.provider ? ` via ${input.provider.charAt(0).toUpperCase() + input.provider.slice(1)}` : "";
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
 * Generates a self-contained, dependency-free PDF 1.4 invoice document with exact byte offsets,
 * document title + language metadata, tagged content markers, and optional embedded brand logo.
 */
export function renderInvoicePdf(input: InvoicePdfInput): Buffer {
  const logo = resolveLogoImage({ logoPng: input.logoPng, issuerLogo: input.issuerLogo });
  const pages: PageStreamBuilder[] = [];
  const startPage = (): PageStreamBuilder => {
    const p: PageStreamBuilder = { ops: [], hasLogo: false };
    pages.push(p);
    return p;
  };

  let page = startPage();
  let y = 742;

  const ensureSpace = (needed: number) => {
    if (y - needed < 64) {
      drawText(page, 50, 40, `Continued - Invoice ${input.invoiceNumber}`, { size: 8, gray: 0.45 });
      page = startPage();
      y = 742;
      drawText(page, 50, y, `${input.issuerName} - Invoice ${input.invoiceNumber}`, { bold: true, size: 11 });
      y -= 24;
      drawRule(page, 50, 562, y);
      y -= 18;
    }
  };

  // Header band
  drawText(page, 420, y, "INVOICE", { bold: true, size: 16 });
  y = drawCompanyBlock(
    page,
    y,
    {
      name: input.issuerName,
      address: input.issuerAddress,
      contact: input.issuerContact,
      taxId: input.issuerTaxId,
    },
    logo,
  );

  const metaTop = 724;
  drawText(page, 370, metaTop, `Invoice #: ${input.invoiceNumber}`, { bold: true, size: 10 });
  drawText(page, 370, metaTop - 14, `Status: ${input.status.toUpperCase()}`, { bold: true, size: 10 });
  drawText(page, 370, metaTop - 28, `Order Ref: ${input.orderReference}`, { size: 9, gray: 0.25 });
  drawText(page, 370, metaTop - 42, `Issued: ${formatUtcDate(input.issuedAt)}`, { size: 9, gray: 0.25 });
  drawText(page, 370, metaTop - 56, `Due: ${formatUtcDate(input.dueAt)}`, { size: 9, gray: 0.25 });

  y = Math.min(y, metaTop - 72);
  drawRule(page, 50, 562, y);
  y -= 20;

  // Bill To
  drawText(page, 50, y, "BILL TO", { bold: true, size: 9, gray: 0.35 });
  y -= 14;
  drawText(page, 50, y, input.customerName, { bold: true, size: 10 });
  y -= 13;
  if (input.customerRef?.trim()) {
    drawText(page, 50, y, `Customer ID: ${input.customerRef.trim()}`, { size: 9, gray: 0.25 });
    y -= 13;
  }
  drawText(page, 50, y, input.customerEmail, { size: 9, gray: 0.25 });
  y -= 22;

  if (input.status === "void") {
    drawText(
      page,
      50,
      y,
      `VOIDED on ${formatUtcDate(input.voidedAt)}${input.voidReason ? ` - Reason: ${input.voidReason}` : ""}`,
      { bold: true, size: 10 },
    );
    y -= 20;
  }

  // Table header
  drawRule(page, 50, 562, y + 6, 0.55);
  drawText(page, 50, y - 6, "#", { bold: true, size: 9 });
  drawText(page, 72, y - 6, "Description", { bold: true, size: 9 });
  drawText(page, 340, y - 6, "Qty", { bold: true, size: 9 });
  drawText(page, 385, y - 6, "Unit Price", { bold: true, size: 9 });
  drawText(page, 475, y - 6, "Line Total", { bold: true, size: 9 });
  drawRule(page, 50, 562, y - 12, 0.55);
  y -= 26;

  // Line items
  for (const line of input.lines) {
    const descLines = wrapText(line.description, 44);
    const rowHeight = Math.max(1, descLines.length) * 13 + 6;
    ensureSpace(rowHeight + 16);

    drawText(page, 50, y, String(line.position), { size: 9 });
    drawText(page, 72, y, descLines[0] ?? line.description, { size: 9 });
    drawText(page, 340, y, String(line.quantity), { size: 9 });
    drawText(page, 385, y, formatMinorUnitsPlain(line.unitAmountMinor, input.currency), { size: 9 });
    drawText(page, 475, y, formatMinorUnitsPlain(line.lineTotalMinor, input.currency), { bold: true, size: 9 });
    y -= 13;

    for (let i = 1; i < descLines.length; i++) {
      drawText(page, 72, y, descLines[i]!, { size: 9, gray: 0.25 });
      y -= 13;
    }
    drawRule(page, 50, 562, y + 4, 0.9);
    y -= 8;
  }

  // Totals summary
  ensureSpace(120);
  y -= 6;
  const drawSummaryRow = (label: string, amountMinor: number, bold = false) => {
    drawText(page, 355, y, label, { bold, size: bold ? 10 : 9 });
    drawText(page, 470, y, formatMinorUnitsPlain(amountMinor, input.currency), { bold, size: bold ? 10 : 9 });
    y -= 15;
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
    drawSummaryRow(input.discountLabel ? `Discount (${input.discountLabel})` : "Discount", -input.discountMinor);
  }
  if (input.taxMinor > 0) {
    drawSummaryRow("Tax", input.taxMinor);
  }
  drawRule(page, 355, 562, y + 6, 0.55);
  y -= 4;
  drawSummaryRow("Invoice Total", input.totalMinor, true);
  if (input.grossPaidMinor > 0) {
    drawSummaryRow("Payments Recorded", input.grossPaidMinor);
  }
  if (input.refundedMinor > 0) {
    drawSummaryRow("Refunds Recorded", -input.refundedMinor);
  }
  drawSummaryRow("Balance Due", input.balanceDueMinor, true);

  // Payment & refund ledger
  if (input.payments.length > 0 || input.refunds.length > 0) {
    ensureSpace(60);
    y -= 10;
    drawRule(page, 50, 562, y + 4);
    y -= 12;
    drawText(page, 50, y, "RECORDED PAYMENT & REFUND EVIDENCE", { bold: true, size: 9, gray: 0.35 });
    y -= 14;
    for (const pmt of input.payments) {
      ensureSpace(18);
      drawText(
        page,
        50,
        y,
        `Payment (${pmt.method}) on ${formatUtcDate(pmt.receivedAt)} - Ref: ${pmt.reference} - ${formatMinorUnitsPlain(pmt.amountMinor, input.currency)}`,
        { size: 9 },
      );
      y -= 13;
    }
    for (const rfd of input.refunds) {
      ensureSpace(18);
      drawText(
        page,
        50,
        y,
        `Refund (${rfd.reasonCode}) on ${formatUtcDate(rfd.refundedAt)} - Ref: ${rfd.reference} - -${formatMinorUnitsPlain(rfd.amountMinor, input.currency)}`,
        { size: 9 },
      );
      y -= 13;
    }
  }

  // Memo & payment instructions
  if (input.memo) {
    ensureSpace(50);
    y -= 10;
    drawText(page, 50, y, "MEMO", { bold: true, size: 9, gray: 0.35 });
    y -= 13;
    for (const line of wrapText(input.memo, 82)) {
      ensureSpace(16);
      drawText(page, 50, y, line, { size: 9, gray: 0.2 });
      y -= 12;
    }
  }

  if (input.status === "issued" && input.balanceDueMinor > 0 && input.paymentInstructions.trim()) {
    ensureSpace(50);
    y -= 10;
    drawText(page, 50, y, "PAYMENT INSTRUCTIONS", { bold: true, size: 9, gray: 0.35 });
    y -= 13;
    for (const line of wrapText(input.paymentInstructions, 82)) {
      ensureSpace(16);
      drawText(page, 50, y, line, { size: 9, gray: 0.2 });
      y -= 12;
    }
  }

  return assembleTaggedPdf14({
    title: `Invoice ${input.invoiceNumber}`,
    pages,
    logo,
  });
}

/**
 * Generates an immutable branded PDF 1.4 Payment Receipt (`RPR-<year>-<6 digits>`) from a stored `ReceiptSnapshot`.
 */
export function renderPaymentReceiptPdf(
  snapshot: ReceiptSnapshot,
  opts?: { logoPng?: Buffer | null | undefined },
): Buffer {
  const logo = resolveLogoImage({
    logoPng: opts?.logoPng,
    logoMode: snapshot.company.logoMode,
    logoBrandPath: snapshot.company.logoBrandPath,
  });

  const pages: PageStreamBuilder[] = [];
  const startPage = (): PageStreamBuilder => {
    const p: PageStreamBuilder = { ops: [], hasLogo: false };
    pages.push(p);
    return p;
  };

  let page = startPage();
  let y = 742;

  const ensureSpace = (needed: number) => {
    if (y - needed < 64) {
      drawText(page, 50, 40, `Continued - Receipt ${snapshot.receiptNumber}`, { size: 8, gray: 0.45 });
      page = startPage();
      y = 742;
      drawText(page, 50, y, `${snapshot.company.legalName} - Receipt ${snapshot.receiptNumber}`, {
        bold: true,
        size: 11,
      });
      y -= 24;
      drawRule(page, 50, 562, y);
      y -= 18;
    }
  };

  drawText(page, 370, y, "PAYMENT RECEIPT", { bold: true, size: 15 });
  y = drawCompanyBlock(
    page,
    y,
    {
      name: snapshot.company.legalName,
      address: snapshot.company.address,
      contact: snapshot.company.contact,
      taxId: snapshot.company.taxId,
    },
    logo,
  );

  const metaTop = 724;
  drawText(page, 370, metaTop, `Receipt #: ${snapshot.receiptNumber}`, { bold: true, size: 10 });
  drawText(page, 370, metaTop - 14, `Issued: ${formatUtcTimestamp(snapshot.issuedAt)}`, { size: 9, gray: 0.25 });
  drawText(page, 370, metaTop - 28, `Order Ref: ${snapshot.orderReference}`, { size: 9, gray: 0.25 });
  drawText(page, 370, metaTop - 42, `Invoice #: ${snapshot.invoiceNumber}`, { size: 9, gray: 0.25 });
  drawText(page, 370, metaTop - 56, `Currency: ${snapshot.currency.toUpperCase()}`, { size: 9, gray: 0.25 });

  y = Math.min(y, metaTop - 72);
  drawRule(page, 50, 562, y);
  y -= 20;

  // Customer block
  drawText(page, 50, y, "RECEIPT FOR", { bold: true, size: 9, gray: 0.35 });
  y -= 14;
  drawText(page, 50, y, snapshot.customer.name, { bold: true, size: 10 });
  y -= 13;
  if (snapshot.customer.customerRef?.trim()) {
    drawText(page, 50, y, `Customer ID: ${snapshot.customer.customerRef.trim()}`, { size: 9, gray: 0.25 });
    y -= 13;
  }
  if (snapshot.customer.email.trim()) {
    drawText(page, 50, y, snapshot.customer.email.trim(), { size: 9, gray: 0.25 });
    y -= 13;
  }
  y -= 10;

  // Line items table
  drawRule(page, 50, 562, y + 6, 0.55);
  drawText(page, 50, y - 6, "#", { bold: true, size: 9 });
  drawText(page, 72, y - 6, "Item / Tier", { bold: true, size: 9 });
  drawText(page, 340, y - 6, "Qty", { bold: true, size: 9 });
  drawText(page, 385, y - 6, "Unit Price", { bold: true, size: 9 });
  drawText(page, 475, y - 6, "Line Total", { bold: true, size: 9 });
  drawRule(page, 50, 562, y - 12, 0.55);
  y -= 26;

  for (const line of snapshot.lines) {
    const descLines = wrapText(line.description, 44);
    const rowHeight = Math.max(1, descLines.length) * 13 + 6;
    ensureSpace(rowHeight + 16);

    drawText(page, 50, y, String(line.position), { size: 9 });
    drawText(page, 72, y, descLines[0] ?? line.description, { size: 9 });
    drawText(page, 340, y, String(line.quantity), { size: 9 });
    drawText(page, 385, y, formatMinorUnitsPlain(line.unitAmountMinor, snapshot.currency), { size: 9 });
    drawText(page, 475, y, formatMinorUnitsPlain(line.lineTotalMinor, snapshot.currency), { bold: true, size: 9 });
    y -= 13;

    for (let i = 1; i < descLines.length; i++) {
      drawText(page, 72, y, descLines[i]!, { size: 9, gray: 0.25 });
      y -= 13;
    }
    drawRule(page, 50, 562, y + 4, 0.9);
    y -= 8;
  }

  // Totals breakdown
  ensureSpace(140);
  y -= 6;
  const drawSummaryRow = (label: string, amountMinor: number, bold = false) => {
    drawText(page, 330, y, label, { bold, size: bold ? 10 : 9 });
    drawText(page, 470, y, formatMinorUnitsPlain(amountMinor, snapshot.currency), { bold, size: bold ? 10 : 9 });
    y -= 15;
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
  drawRule(page, 330, 562, y + 6, 0.55);
  y -= 4;
  drawSummaryRow("Amount paid", snapshot.amountPaidMinor, true);

  // Payment method & reference block
  ensureSpace(80);
  y -= 12;
  drawRule(page, 50, 562, y + 4);
  y -= 14;
  drawText(page, 50, y, "PAYMENT SUMMARY", { bold: true, size: 9, gray: 0.35 });
  y -= 14;

  const methodSummary = formatPaymentMethodSummaryPlain({
    settlementKind: snapshot.settlementKind,
    paymentMethod: snapshot.paymentMethod,
    paymentMethodBrand: snapshot.paymentMethodBrand,
    paymentMethodLast4: snapshot.paymentMethodLast4,
    provider: snapshot.provider,
  });
  drawText(page, 50, y, `Payment method: ${methodSummary}`, { size: 9 });
  y -= 13;

  if (snapshot.providerReference?.trim()) {
    drawText(page, 50, y, `Reference: ${snapshot.providerReference.trim()}`, { size: 9, gray: 0.25 });
    y -= 13;
  }

  if (snapshot.footerText.trim()) {
    ensureSpace(45);
    y -= 10;
    for (const line of wrapText(snapshot.footerText, 82)) {
      ensureSpace(15);
      drawText(page, 50, y, line, { size: 9, gray: 0.3 });
      y -= 12;
    }
  }

  return assembleTaggedPdf14({
    title: `Payment Receipt ${snapshot.receiptNumber}`,
    pages,
    logo,
  });
}

/**
 * Generates an immutable branded PDF 1.4 Refund Note (`RPRN-<year>-<6 digits>`) linked to a Payment Receipt.
 */
export function renderRefundNotePdf(
  snapshot: RefundNoteSnapshot,
  opts?: { logoPng?: Buffer | null | undefined },
): Buffer {
  const logo = resolveLogoImage({
    logoPng: opts?.logoPng,
    logoMode: snapshot.company.logoMode,
    logoBrandPath: snapshot.company.logoBrandPath,
  });

  const page: PageStreamBuilder = { ops: [], hasLogo: false };
  const pages: PageStreamBuilder[] = [page];
  let y = 742;

  drawText(page, 390, y, "REFUND NOTE", { bold: true, size: 15 });
  y = drawCompanyBlock(
    page,
    y,
    {
      name: snapshot.company.legalName,
      address: snapshot.company.address,
      contact: snapshot.company.contact,
      taxId: snapshot.company.taxId,
    },
    logo,
  );

  const metaTop = 724;
  drawText(page, 370, metaTop, `Refund Note #: ${snapshot.noteNumber}`, { bold: true, size: 10 });
  drawText(page, 370, metaTop - 14, `Original Receipt #: ${snapshot.receiptNumber}`, { bold: true, size: 9 });
  drawText(page, 370, metaTop - 28, `Issued: ${formatUtcTimestamp(snapshot.issuedAt)}`, { size: 9, gray: 0.25 });
  drawText(page, 370, metaTop - 42, `Order Ref: ${snapshot.orderReference}`, { size: 9, gray: 0.25 });
  drawText(page, 370, metaTop - 56, `Invoice #: ${snapshot.invoiceNumber}`, { size: 9, gray: 0.25 });

  y = Math.min(y, metaTop - 72);
  drawRule(page, 50, 562, y);
  y -= 20;

  drawText(page, 50, y, "CUSTOMER", { bold: true, size: 9, gray: 0.35 });
  y -= 14;
  drawText(page, 50, y, snapshot.customer.name, { bold: true, size: 10 });
  y -= 13;
  if (snapshot.customer.customerRef?.trim()) {
    drawText(page, 50, y, `Customer ID: ${snapshot.customer.customerRef.trim()}`, { size: 9, gray: 0.25 });
    y -= 13;
  }
  if (snapshot.customer.email.trim()) {
    drawText(page, 50, y, snapshot.customer.email.trim(), { size: 9, gray: 0.25 });
    y -= 13;
  }
  y -= 14;

  drawRule(page, 50, 562, y + 4, 0.55);
  y -= 14;
  drawText(page, 50, y, "REFUND DETAILS", { bold: true, size: 10 });
  y -= 18;

  const stateLabel =
    snapshot.resultingRefundState === "refunded" ? "Refunded in full" : "Partially refunded";
  drawText(page, 50, y, `Original receipt amount paid:`, { size: 9 });
  drawText(page, 320, y, formatMinorUnitsPlain(snapshot.originalAmountPaidMinor, snapshot.currency), { size: 9 });
  y -= 15;

  drawText(page, 50, y, `Refund amount (this note):`, { bold: true, size: 10 });
  drawText(page, 320, y, formatMinorUnitsPlain(snapshot.refundAmountMinor, snapshot.currency), {
    bold: true,
    size: 10,
  });
  y -= 15;

  drawText(page, 50, y, `Cumulative refunded against receipt:`, { size: 9 });
  drawText(page, 320, y, formatMinorUnitsPlain(snapshot.cumulativeRefundedMinor, snapshot.currency), { size: 9 });
  y -= 15;

  drawText(page, 50, y, `Receipt status after refund:`, { size: 9 });
  drawText(page, 320, y, stateLabel, { bold: true, size: 9 });
  y -= 15;

  drawText(page, 50, y, `Reason code: ${snapshot.reasonCode}`, { size: 9, gray: 0.25 });
  y -= 13;
  drawText(page, 50, y, `Reference: ${snapshot.reference}`, { size: 9, gray: 0.25 });
  y -= 18;

  drawRule(page, 50, 562, y + 4);
  y -= 14;
  drawText(
    page,
    50,
    y,
    `This refund note supplements original receipt ${snapshot.receiptNumber}, which remains unchanged.`,
    { size: 9, gray: 0.3 },
  );

  return assembleTaggedPdf14({
    title: `Refund Note ${snapshot.noteNumber}`,
    pages,
    logo,
  });
}
