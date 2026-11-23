// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mammoth from "mammoth";
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
} from "docx";
import { deflateRawSync } from "node:zlib";
import type { DocxWorkerRequest, DocxWorkerResponse } from "./docxWorker";
import {
  DocConvertError,
  DocumentImportButton,
  docxToHtml,
  editorToDocx,
  htmlToMarkdown,
  inspectZipArchive,
  markdownToHtml,
  MAX_DOCCONVERT_BYTES,
  orderDocumentEditHref,
  pdfToText,
  sanitizeDocumentHtml,
  verifyZipActualInflation,
} from "./index";

class TestMammothWorker {
  onmessage: ((event: MessageEvent<DocxWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;

  postMessage(data: DocxWorkerRequest): void {
    const { id, arrayBuffer, styleMap } = data;
    void mammoth
      .convertToHtml(
        { buffer: Buffer.from(arrayBuffer) },
        {
          styleMap,
          includeDefaultStyleMap: true,
          ...({ externalFileAccess: false } as Record<string, unknown>),
        },
      )
      .then((res) => {
        if (this.terminated || !this.onmessage) return;
        this.onmessage({
          data: {
            id,
            ok: true,
            rawHtml: res.value,
            messages: res.messages.map((m) => ({ type: m.type, message: m.message })),
          },
        } as MessageEvent<DocxWorkerResponse>);
      })
      .catch((err: unknown) => {
        if (this.terminated || !this.onmessage) return;
        this.onmessage({
          data: {
            id,
            ok: false,
            errorMessage: err instanceof Error ? err.message : "Mammoth worker failed",
          },
        } as MessageEvent<DocxWorkerResponse>);
      });
  }

  terminate(): void {
    this.terminated = true;
  }
}

beforeEach(() => {
  vi.stubGlobal("Worker", TestMammothWorker);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function base64ToUint8(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.byteLength; i += 1) {
    c ^= data[i] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface SyntheticZipEntry {
  readonly name: string;
  readonly localName?: string;
  readonly content: Uint8Array;
  readonly deflate?: boolean;
  readonly declaredUncompressedSize?: number;
  readonly cdOnlyUncompressedSize?: number;
  readonly cdLocalOffsetOverride?: number;
}

function buildSyntheticZip(entries: readonly SyntheticZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const cdParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const cdNameBytes = encoder.encode(entry.name);
    const localNameBytes = encoder.encode(entry.localName ?? entry.name);
    const method = entry.deflate ? 8 : 0;
    const payload = entry.deflate ? new Uint8Array(deflateRawSync(entry.content)) : entry.content;
    const crc = crc32(entry.content);
    const localUncompressed = entry.declaredUncompressedSize ?? entry.content.byteLength;
    const cdUncompressed = entry.cdOnlyUncompressedSize ?? localUncompressed;

    const localHeader = new Uint8Array(30 + localNameBytes.byteLength);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.byteLength, true);
    lv.setUint32(22, localUncompressed, true);
    lv.setUint16(26, localNameBytes.byteLength, true);
    lv.setUint16(28, 0, true);
    localHeader.set(localNameBytes, 30);

    const cdHeader = new Uint8Array(46 + cdNameBytes.byteLength);
    const cv = new DataView(cdHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.byteLength, true);
    cv.setUint32(24, cdUncompressed, true);
    cv.setUint16(28, cdNameBytes.byteLength, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint32(42, entry.cdLocalOffsetOverride ?? offset, true);
    cdHeader.set(cdNameBytes, 46);

    localParts.push(localHeader, payload);
    cdParts.push(cdHeader);
    offset += localHeader.byteLength + payload.byteLength;
  }

  const cdSize = cdParts.reduce((sum, p) => sum + p.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdSize + eocd.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of [...localParts, ...cdParts, eocd]) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

function buildMinimalPdf(pageTexts: readonly string[]): Uint8Array {
  const objects: Map<number, string> = new Map();
  const pageIds: number[] = [];
  let nextId = 4;

  for (const text of pageTexts) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const streamBody = escaped ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : "";
    objects.set(
      contentId,
      `<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream`,
    );
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
  }

  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
  );
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const maxObjId = nextId - 1;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];

  for (let id = 1; id <= maxObjId; id += 1) {
    offsets[id] = pdf.length;
    const body = objects.get(id) ?? "<<>>";
    pdf += `${id} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${maxObjId + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let id = 1; id <= maxObjId; id += 1) {
    const off = String(offsets[id] ?? 0).padStart(10, "0");
    pdf += `${off} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxObjId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

describe("orderDocumentEditHref", () => {
  it("builds customer and staff console routes with optional taskKey query", () => {
    const orderId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const fileId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
    expect(orderDocumentEditHref(orderId, fileId)).toBe(
      `/orders/${orderId}/documents/${fileId}/edit`,
    );
    expect(orderDocumentEditHref(orderId, fileId, { taskKey: "nda_review" })).toBe(
      `/orders/${orderId}/documents/${fileId}/edit?taskKey=nda_review`,
    );
    expect(
      orderDocumentEditHref(orderId, fileId, { area: "console", taskKey: "nda_review" }),
    ).toBe(`/admin/orders/${orderId}/documents/${fileId}/edit?taskKey=nda_review`);
    expect(
      orderDocumentEditHref(orderId, fileId, { consoleView: true, taskKey: "nda_review" }),
    ).toBe(`/admin/orders/${orderId}/documents/${fileId}/edit?taskKey=nda_review`);
  });
});

describe("docxToHtml and editorToDocx round-trip", () => {
  it("converts a rich generated .docx (headings, formatting, link, image, table) and round-trips back to .docx", async () => {
    const pngBytes = base64ToUint8(ONE_PX_PNG_BASE64);
    const fixtureDoc = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              children: [new TextRun("Mutual Non-Disclosure Agreement")],
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: "Confidential ", bold: true }),
                new TextRun({ text: "draft ", italics: true }),
                new TextRun({ text: "clause ", underline: { type: UnderlineType.SINGLE } }),
                new TextRun({ text: "obsolete", strike: true }),
              ],
            }),
            new Paragraph({
              children: [
                new ExternalHyperlink({
                  link: "https://portal.example.test/terms",
                  children: [new TextRun({ text: "Portal Terms" })],
                }),
                new TextRun(" "),
                new ImageRun({
                  type: "png",
                  data: pngBytes,
                  transformation: { width: 16, height: 16 },
                  altText: { title: "Seal", description: "Seal", name: "Seal" },
                }),
              ],
            }),
            new Table({
              rows: [
                new TableRow({
                  tableHeader: true,
                  children: [
                    new TableCell({ children: [new Paragraph("Party")] }),
                    new TableCell({ children: [new Paragraph("Obligation")] }),
                  ],
                }),
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Customer")] }),
                    new TableCell({ children: [new Paragraph("Return materials within 30 days")] }),
                  ],
                }),
              ],
            }),
          ],
        },
      ],
    });

    const packedBuffer = await Packer.toBuffer(fixtureDoc);
    const imported = await docxToHtml(new Uint8Array(packedBuffer));

    expect(imported.sanitizedHtml).toContain("<h1>Mutual Non-Disclosure Agreement</h1>");
    expect(imported.sanitizedHtml).toContain("<strong>Confidential");
    expect(imported.sanitizedHtml).toContain("<em>draft");
    expect(imported.sanitizedHtml).toContain("<u>clause");
    expect(imported.sanitizedHtml).toContain("<s>obsolete");
    expect(imported.sanitizedHtml).toContain('href="https://portal.example.test/terms"');
    expect(imported.sanitizedHtml).toContain("<table>");
    expect(imported.sanitizedHtml).toContain("Return materials within 30 days");
    expect(imported.sanitizedHtml).toContain("data:image/png;base64,");
    expect(imported.sanitizedHtml).not.toContain("style=");
    expect(imported.markdown).toContain("# Mutual Non-Disclosure Agreement");
    expect(imported.markdown).toContain("| Party | Obligation |");

    const editedHtml = `${imported.sanitizedHtml}<h2 data-text-align="right">Addendum A</h2><p data-text-align="justify">Signed in counterpart.</p>`;
    const exported = await editorToDocx(editedHtml);
    expect(exported.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(exported.bytes.byteLength).toBeGreaterThan(500);

    const reimported = await docxToHtml(exported.bytes);
    expect(reimported.sanitizedHtml).toContain("<h2>Addendum A</h2>");
    expect(reimported.plainText).toContain("Signed in counterpart.");
    expect(reimported.plainText).toContain("Return materials within 30 days");
  });

  it("detects unsupported OOXML structures (headers/footers, tracked changes, comments, footnotes, fields)", async () => {
    const encoder = new TextEncoder();
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Agreement text</w:t></w:r><w:ins w:id="1"><w:r><w:t> added</w:t></w:r></w:ins></w:p>
          <w:p><w:commentRangeStart w:id="0"/><w:r><w:footnoteReference w:id="2"/></w:r><w:fldSimple w:instr="PAGE"/></w:p>
          <w:sectPr><w:headerReference w:id="rId4"/></w:sectPr>
        </w:body>
      </w:document>`;
    const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`;
    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
      </Types>`;

    const zipBytes = buildSyntheticZip([
      { name: "[Content_Types].xml", content: encoder.encode(contentTypesXml), deflate: true },
      { name: "_rels/.rels", content: encoder.encode(relsXml), deflate: true },
      { name: "word/document.xml", content: encoder.encode(docXml), deflate: true },
      {
        name: "word/header1.xml",
        content: encoder.encode(
          `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>`,
        ),
        deflate: true,
      },
      {
        name: "word/comments.xml",
        content: encoder.encode(
          `<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0"><w:p><w:r><w:t>Margin note</w:t></w:r></w:p></w:comment></w:comments>`,
        ),
        deflate: true,
      },
      {
        name: "word/footnotes.xml",
        content: encoder.encode(
          `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="2"><w:p><w:r><w:t>Footnote body</w:t></w:r></w:p></w:footnote></w:footnotes>`,
        ),
        deflate: true,
      },
    ]);

    const res = await docxToHtml(zipBytes);
    const keys = res.detectedUnsupported.map((u) => u.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "headers_footers",
        "tracked_changes",
        "comments",
        "footnotes_endnotes",
        "complex_fields",
      ]),
    );
    expect(res.warnings.some((w) => w.includes("Tracked changes"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("Headers and footers"))).toBe(true);
  });
});

describe("ZIP, size, coherence, inflation, and Worker isolation/cancellation guards", () => {
  it("rejects files over 10 MB before reading", async () => {
    const oversizedBlob = {
      size: MAX_DOCCONVERT_BYTES + 1,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Blob;
    Object.setPrototypeOf(oversizedBlob, Blob.prototype);

    await expect(docxToHtml(oversizedBlob)).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  it("rejects high compression ratio archives, traversal paths, duplicate entries, and incoherent local headers", () => {
    const encoder = new TextEncoder();
    const highlyCompressible = new Uint8Array(200 * 1024);
    const ratioZip = buildSyntheticZip([
      { name: "word/document.xml", content: highlyCompressible, deflate: true },
    ]);
    expect(() => inspectZipArchive(ratioZip)).toThrowError(DocConvertError);
    try {
      inspectZipArchive(ratioZip);
    } catch (err) {
      expect((err as DocConvertError).code).toBe("ZIP_COMPRESSION_RATIO_EXCEEDED");
    }

    const traversalZip = buildSyntheticZip([
      { name: "../evil.xml", content: encoder.encode("<x/>") },
      { name: "word/document.xml", content: encoder.encode("<w:document/>") },
    ]);
    expect(() => inspectZipArchive(traversalZip)).toThrow(/unsafe entry path/i);

    const duplicateZip = buildSyntheticZip([
      { name: "word/document.xml", content: encoder.encode("<a/>") },
      { name: "WORD/document.xml", content: encoder.encode("<b/>") },
    ]);
    expect(() => inspectZipArchive(duplicateZip)).toThrow(/duplicate entry names/i);

    const mismatchedSizeZip = buildSyntheticZip([
      {
        name: "word/document.xml",
        content: encoder.encode("<w:document/>"),
        deflate: true,
        cdOnlyUncompressedSize: 999,
      },
    ]);
    expect(() => inspectZipArchive(mismatchedSizeZip)).toThrow(/mismatched local and central/i);

    const overlappingZip = buildSyntheticZip([
      { name: "word/document.xml", content: encoder.encode("<w:document/>") },
      { name: "word/styles.xml", content: encoder.encode("<w:styles/>"), cdLocalOffsetOverride: 0 },
    ]);
    expect(() => inspectZipArchive(overlappingZip)).toThrow(
      /mismatched local|overlapping|exceeds member bounds/i,
    );
  });

  it("defeats spoofed uncompressed sizes via actual bounded stream inflation", async () => {
    const actualPayload = new Uint8Array(128 * 1024);
    actualPayload.fill(65);
    const spoofedZip = buildSyntheticZip([
      {
        name: "word/document.xml",
        content: actualPayload,
        deflate: true,
        declaredUncompressedSize: 64,
      },
    ]);

    const inspection = inspectZipArchive(spoofedZip);
    await expect(
      verifyZipActualInflation(spoofedZip, inspection, { maxSingleEntryBytes: 16 * 1024 }),
    ).rejects.toMatchObject({
      code: "ZIP_UNCOMPRESSED_TOO_LARGE",
    });
  });

  it("fails closed when Worker is unavailable or throws rather than falling back to UI-thread Mammoth, and terminates stalled Workers", async () => {
    const doc = new Document({ sections: [{ children: [new Paragraph("Hello")] }] });
    const bytes = new Uint8Array(await Packer.toBuffer(doc));

    vi.stubGlobal("Worker", undefined);
    await expect(docxToHtml(bytes)).rejects.toMatchObject({
      code: "WORKER_UNAVAILABLE",
    });

    class ThrowingWorker {
      constructor() {
        throw new Error("CSP blocked worker");
      }
    }
    vi.stubGlobal("Worker", ThrowingWorker);
    await expect(docxToHtml(bytes)).rejects.toMatchObject({
      code: "WORKER_UNAVAILABLE",
    });

    let terminated = false;
    class HangingWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(): void {
        // Simulates a synchronous parser stall in the worker
      }
      terminate(): void {
        terminated = true;
      }
    }
    vi.stubGlobal("Worker", HangingWorker);

    await expect(docxToHtml(bytes, { timeoutMs: 40 })).rejects.toMatchObject({
      code: "CONVERSION_TIMEOUT",
    });
    expect(terminated).toBe(true);
  });
});

describe("pdfToText", () => {
  it("extracts multi-page text with strict CSP options, clamps maxPages to 200, and bounds extracted text size", async () => {
    const twoPagePdf = buildMinimalPdf([
      "Page One Policy Scope",
      "Page Two Customer Responsibilities",
    ]);
    const extracted = await pdfToText(twoPagePdf);
    expect(extracted.pageCount).toBe(2);
    expect(extracted.plainText).toContain("Page One Policy Scope");
    expect(extracted.plainText).toContain("Page Two Customer Responsibilities");
    expect(extracted.sanitizedHtml).toContain("<p>Page One Policy Scope</p>");
    expect(extracted.warnings[0]).toMatch(/extracts text only/i);

    // Caller passing maxPages: 999 must still be clamped to MAX_PDF_PAGES (200)
    const tooManyPagesPdf = buildMinimalPdf(Array.from({ length: 201 }, (_, i) => `P${i + 1}`));
    await expect(pdfToText(tooManyPagesPdf, { maxPages: 999 })).rejects.toMatchObject({
      code: "PDF_TOO_MANY_PAGES",
    });

    // Cumulative extracted-text cap prevents unbounded text expansion
    await expect(pdfToText(twoPagePdf, { maxExtractedChars: 10 })).rejects.toMatchObject({
      code: "PDF_TEXT_TOO_LARGE",
    });
  });
});

describe("markdownToHtml and sanitizeDocumentHtml", () => {
  it("strips scripts, event handlers, javascript: links, SVG data URIs, and inline styles", async () => {
    const dirtyHtml = `
      <h1 style="text-align: center; color: red" onclick="alert(1)">Title</h1>
      <script>window.__xss = true;</script>
      <p><a href="javascript:alert(1)">Bad Link</a> and <a href="https://example.com/safe">Safe Link</a></p>
      <img src="data:image/svg+xml;base64,PHN2Zy8+" alt="svg" />
      <svg><onload>alert(1)</onload></svg>
    `;
    const clean = sanitizeDocumentHtml(dirtyHtml);
    expect(clean).toContain('<h1 data-text-align="center">Title</h1>');
    expect(clean).not.toContain("style=");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("javascript:");
    expect(clean).toContain('href="https://example.com/safe"');
    expect(clean).not.toContain("image/svg+xml");
    expect(clean).not.toContain("<svg");

    const md = await markdownToHtml(
      `# Acceptable Use\n\n<script>alert(1)</script>\n\n- **Zero trust** access\n- Visit [Docs](https://docs.example.test)\n\n| Control | Status |\n| :--- | :---: |\n| MFA | Active |`,
    );
    expect(md.sanitizedHtml).toContain("<h1>Acceptable Use</h1>");
    expect(md.sanitizedHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(md.sanitizedHtml).not.toContain("<script>");
    expect(md.sanitizedHtml).toContain("<table>");
    expect(md.warnings.some((w) => w.includes("Raw HTML tags"))).toBe(true);
    expect(htmlToMarkdown(md.sanitizedHtml)).toContain("| Control | Status |");
  });
});

describe("DocumentImportButton", () => {
  it("imports .md and .pdf files via accessible button + file input and surfaces PDF text-only warnings", async () => {
    const onImport = vi.fn();
    render(<DocumentImportButton onImport={onImport} />);

    const trigger = screen.getByRole("button", { name: /import from file/i });
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();

    const input = screen.getByTestId("document-import-file-input") as HTMLInputElement;
    const mdFile = new File(["# Privacy Notice\n\nWe protect customer data."], "privacy.md", {
      type: "text/markdown",
    });
    fireEvent.change(input, { target: { files: [mdFile] } });

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledTimes(1);
    });
    expect(onImport.mock.calls[0]?.[0]).toMatchObject({
      sourceFormat: "markdown",
      sourceKind: "markdown",
      suggestedPolicyFormat: "safe_markdown",
      fileName: "privacy.md",
      sanitizedHtml: "<h1>Privacy Notice</h1><p>We protect customer data.</p>",
    });

    const pdfBytes = buildMinimalPdf(["Terms Section 1"]);
    const ab = new ArrayBuffer(pdfBytes.byteLength);
    new Uint8Array(ab).set(pdfBytes);
    const pdfFile = new File([ab], "terms.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [pdfFile] } });

    await waitFor(() => {
      expect(onImport).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText(/PDF import extracts text only/i)).toBeTruthy();
  });
});
