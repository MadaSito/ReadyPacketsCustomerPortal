import type { InvoiceStatus } from "./schema.js";

export interface InvoicePdfInput {
  invoicePublicId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  orderReference: string;
  issuerName: string;
  issuerAddress: string;
  customerName: string;
  customerEmail: string;
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

function formatUtcDate(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
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
  page.ops.push(`BT ${gray.toFixed(2)} g ${font} ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`);
}

function drawRule(page: PageStreamBuilder, x1: number, x2: number, y: number, gray = 0.82): void {
  page.ops.push(`${gray.toFixed(2)} G 0.6 w ${x1} ${y} m ${x2} ${y} l S`);
}

/**
 * Generates a self-contained, dependency-free PDF 1.4 invoice document with exact byte offsets.
 */
export function renderInvoicePdf(input: InvoicePdfInput): Buffer {
  const pages: PageStreamBuilder[] = [];
  const startPage = (): PageStreamBuilder => {
    const p: PageStreamBuilder = { ops: [] };
    pages.push(p);
    return p;
  };

  let page = startPage();
  let y = 742;

  const ensureSpace = (needed: number) => {
    if (y - needed < 64) {
      drawText(page, 50, 40, `Continued — Invoice ${input.invoiceNumber}`, { size: 8, gray: 0.45 });
      page = startPage();
      y = 742;
      drawText(page, 50, y, `${input.issuerName} — Invoice ${input.invoiceNumber}`, { bold: true, size: 11 });
      y -= 24;
      drawRule(page, 50, 562, y);
      y -= 18;
    }
  };

  // Header band
  drawText(page, 50, y, input.issuerName, { bold: true, size: 16 });
  drawText(page, 420, y, "INVOICE", { bold: true, size: 16 });
  y -= 18;

  for (const addrLine of wrapText(input.issuerAddress, 56).slice(0, 3)) {
    drawText(page, 50, y, addrLine, { size: 9, gray: 0.35 });
    y -= 13;
  }

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
  drawText(page, 50, y, input.customerEmail, { size: 9, gray: 0.25 });
  y -= 22;

  if (input.status === "void") {
    drawText(
      page,
      50,
      y,
      `VOIDED on ${formatUtcDate(input.voidedAt)}${input.voidReason ? ` — Reason: ${input.voidReason}` : ""}`,
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
        `Payment (${pmt.method}) on ${formatUtcDate(pmt.receivedAt)} — Ref: ${pmt.reference} — ${formatMinorUnitsPlain(pmt.amountMinor, input.currency)}`,
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
        `Refund (${rfd.reasonCode}) on ${formatUtcDate(rfd.refundedAt)} — Ref: ${rfd.reference} — -${formatMinorUnitsPlain(rfd.amountMinor, input.currency)}`,
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

  // Assemble valid PDF 1.4 objects
  // Object 1: Catalog, Object 2: Pages, Object 3: Helvetica, Object 4: Helvetica-Bold
  // For each page i: content object (5 + i*2), page object (6 + i*2)
  const objects: string[] = [];
  const pageObjectNums: number[] = [];

  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push(""); // Placeholder for Pages (object 2)
  objects.push("3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n");
  objects.push("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n");

  for (let i = 0; i < pages.length; i++) {
    const contentObjNum = 5 + i * 2;
    const pageObjNum = 6 + i * 2;
    pageObjectNums.push(pageObjNum);

    const streamBody = pages[i]!.ops.join("\n") + "\n";
    const streamByteLen = Buffer.byteLength(streamBody, "latin1");
    objects.push(
      `${contentObjNum} 0 obj\n<< /Length ${streamByteLen} >>\nstream\n${streamBody}endstream\nendobj\n`,
    );
    objects.push(
      `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjNum} 0 R >>\nendobj\n`,
    );
  }

  const kidsRefs = pageObjectNums.map((n) => `${n} 0 R`).join(" ");
  objects[1] = `2 0 obj\n<< /Type /Pages /Kids [${kidsRefs}] /Count ${pages.length} >>\nendobj\n`;

  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const chunks: Buffer[] = [Buffer.from(header, "latin1")];
  const offsets: number[] = [0];
  let bytePos = chunks[0]!.length;

  for (const objStr of objects) {
    offsets.push(bytePos);
    const buf = Buffer.from(objStr, "latin1");
    chunks.push(buf);
    bytePos += buf.length;
  }

  const xrefStart = bytePos;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
  for (let i = 1; i < offsets.length; i++) {
    xrefLines.push(`${String(offsets[i]!).padStart(10, "0")} 00000 n \n`);
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xrefLines.join("") + trailer, "latin1"));

  return Buffer.concat(chunks);
}
