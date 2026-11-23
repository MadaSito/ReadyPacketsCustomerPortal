/**
 * Browser-only sanitised editor HTML -> `.docx` exporter via `docx` (Increment 06 D9).
 * Lazily imports `docx`, sanitises editor HTML first, and preserves headings (h1..h4), paragraph & cell
 * alignment, bold/italic/underline/strikethrough/inline code, HTTPS/mailto links, bullet & numbered lists,
 * blockquotes, horizontal rules, tables (`colspan`/`rowspan`), and bounded embedded PNG/JPEG/GIF images.
 */
import type {
  FileChild,
  Paragraph as DocxParagraph,
  ParagraphChild,
  Table as DocxTable,
} from "docx";
import {
  DOCX_MIME,
  DocConvertError,
  type DocConvertOptions,
  type EditorToDocxResult,
} from "./types";
import { withConversionTimeout } from "./guards";
import {
  isAllowedDocumentHref,
  sanitizeDocumentHtml,
  type DocumentTextAlignment,
} from "./sanitize";

interface InlineRunStyle {
  readonly bold?: boolean;
  readonly italics?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly code?: boolean;
  readonly linkHref?: string;
}

interface ParsedDataImage {
  readonly type: "png" | "jpg" | "gif";
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

const MAX_DOCX_IMAGE_WIDTH_PX = 520;
const DEFAULT_IMAGE_WIDTH_PX = 320;
const DEFAULT_IMAGE_HEIGHT_PX = 200;

function decodeBase64ToBytes(base64: string): Uint8Array | null {
  try {
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function readRasterDimensions(
  type: "png" | "jpg" | "gif",
  bytes: Uint8Array,
): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "png" && bytes.byteLength >= 24) {
    const w = view.getUint32(16, false);
    const h = view.getUint32(20, false);
    if (w > 0 && h > 0 && w <= 10_000 && h <= 10_000) return { width: w, height: h };
  }
  if (type === "gif" && bytes.byteLength >= 10) {
    const w = view.getUint16(6, true);
    const h = view.getUint16(8, true);
    if (w > 0 && h > 0 && w <= 10_000 && h <= 10_000) return { width: w, height: h };
  }
  if (type === "jpg" && bytes.byteLength > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const segLen = view.getUint16(offset + 2, false);
      if (segLen < 2 || offset + 2 + segLen > bytes.byteLength) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const h = view.getUint16(offset + 5, false);
        const w = view.getUint16(offset + 7, false);
        if (w > 0 && h > 0 && w <= 10_000 && h <= 10_000) return { width: w, height: h };
        break;
      }
      offset += 2 + segLen;
    }
  }
  return { width: DEFAULT_IMAGE_WIDTH_PX, height: DEFAULT_IMAGE_HEIGHT_PX };
}

function parseEmbeddedDataImage(src: string): ParsedDataImage | null {
  const match = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(src.trim());
  if (!match?.[1] || !match[2]) return null;
  const rawKind = match[1].toLowerCase();
  const type: "png" | "jpg" | "gif" = rawKind === "jpeg" ? "jpg" : (rawKind as "png" | "gif");
  const bytes = decodeBase64ToBytes(match[2]);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) return null;

  const dims = readRasterDimensions(type, bytes);
  let width = dims.width;
  let height = dims.height;
  if (width > MAX_DOCX_IMAGE_WIDTH_PX) {
    const scale = MAX_DOCX_IMAGE_WIDTH_PX / width;
    width = MAX_DOCX_IMAGE_WIDTH_PX;
    height = Math.max(1, Math.round(height * scale));
  }
  return { type, data: bytes, width, height };
}

export async function editorToDocx(
  editorHtml: string,
  options?: DocConvertOptions,
): Promise<EditorToDocxResult> {
  return withConversionTimeout(async () => {
    const sanitizedHtml = sanitizeDocumentHtml(editorHtml);
    const docx = await import("docx");
    const {
      AlignmentType,
      BorderStyle,
      Document,
      ExternalHyperlink,
      HeadingLevel,
      ImageRun,
      LevelFormat,
      Packer,
      Paragraph,
      ShadingType,
      Table,
      TableCell,
      TableRow,
      TextRun,
      UnderlineType,
      WidthType,
    } = docx;

    const mapAlignment = (value: string | null) => {
      const normalized = (value ?? "").trim().toLowerCase() as DocumentTextAlignment;
      switch (normalized) {
        case "center":
          return AlignmentType.CENTER;
        case "right":
          return AlignmentType.RIGHT;
        case "justify":
          return AlignmentType.JUSTIFIED;
        default:
          return undefined;
      }
    };

    const buildTextRun = (text: string, style: InlineRunStyle, breakBefore = false) =>
      new TextRun({
        text,
        bold: style.bold,
        italics: style.italics,
        strike: style.strike,
        underline:
          style.underline || style.linkHref
            ? { type: UnderlineType.SINGLE }
            : undefined,
        color: style.linkHref ? "1D4ED8" : undefined,
        font: style.code ? "Courier New" : undefined,
        break: breakBefore ? 1 : undefined,
      });

    const collectInlineRuns = (nodes: Iterable<Node>, style: InlineRunStyle): ParagraphChild[] => {
      const out: ParagraphChild[] = [];
      for (const node of nodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? "";
          if (text.length > 0) {
            out.push(buildTextRun(text, style));
          }
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        const tag = el.tagName.toLowerCase();

        if (tag === "br") {
          out.push(new TextRun({ text: "", break: 1 }));
          continue;
        }
        if (tag === "img") {
          const src = (el.getAttribute("src") ?? "").trim();
          const alt = (el.getAttribute("alt") ?? "Image").trim();
          const parsed = parseEmbeddedDataImage(src);
          if (parsed) {
            out.push(
              new ImageRun({
                type: parsed.type,
                data: parsed.data,
                transformation: { width: parsed.width, height: parsed.height },
                altText: {
                  title: alt || "Image",
                  description: alt || "Embedded document image",
                  name: alt || "Image",
                },
              }),
            );
          } else if (/^https:\/\//i.test(src) && isAllowedDocumentHref(src)) {
            out.push(
              new ExternalHyperlink({
                link: src,
                children: [buildTextRun(`[Image: ${alt || src}]`, { ...style, linkHref: src })],
              }),
            );
          }
          continue;
        }
        if (tag === "a") {
          const href = (el.getAttribute("href") ?? "").trim();
          if (isAllowedDocumentHref(href)) {
            const linkChildren = collectInlineRuns(el.childNodes, {
              ...style,
              linkHref: href,
            });
            if (linkChildren.length > 0) {
              out.push(
                new ExternalHyperlink({
                  link: href,
                  children: linkChildren,
                }),
              );
            }
          } else {
            out.push(...collectInlineRuns(el.childNodes, style));
          }
          continue;
        }

        const nextStyle: InlineRunStyle = {
          ...style,
          bold: style.bold || tag === "strong" || tag === "b",
          italics: style.italics || tag === "em" || tag === "i",
          underline: style.underline || tag === "u",
          strike: style.strike || tag === "s" || tag === "del",
          code: style.code || tag === "code",
        };
        out.push(...collectInlineRuns(el.childNodes, nextStyle));
      }
      return out;
    };

    const headingLevelForTag = (tag: string) => {
      switch (tag) {
        case "h1":
          return HeadingLevel.HEADING_1;
        case "h2":
          return HeadingLevel.HEADING_2;
        case "h3":
          return HeadingLevel.HEADING_3;
        case "h4":
          return HeadingLevel.HEADING_4;
        default:
          return undefined;
      }
    };

    let numberedListInstance = 0;

    const convertList = (
      listEl: Element,
      ordered: boolean,
      level: number,
      instanceId: number,
    ): DocxParagraph[] => {
      const paragraphs: DocxParagraph[] = [];
      const clampedLevel = Math.min(2, Math.max(0, level));

      for (const li of Array.from(listEl.children)) {
        if (li.tagName.toLowerCase() !== "li") continue;

        const inlineSources: Node[] = [];
        const nestedLists: Array<{ el: Element; ordered: boolean }> = [];

        for (const child of Array.from(li.childNodes)) {
          if (child.nodeType === Node.ELEMENT_NODE) {
            const childEl = child as Element;
            const childTag = childEl.tagName.toLowerCase();
            if (childTag === "ul" || childTag === "ol") {
              nestedLists.push({ el: childEl, ordered: childTag === "ol" });
              continue;
            }
            if (childTag === "p") {
              if (inlineSources.length > 0) {
                inlineSources.push(listEl.ownerDocument.createElement("br"));
              }
              inlineSources.push(...Array.from(childEl.childNodes));
              continue;
            }
          }
          inlineSources.push(child);
        }

        const children = collectInlineRuns(inlineSources, {});
        paragraphs.push(
          new Paragraph({
            children: children.length > 0 ? children : [new TextRun({ text: "" })],
            bullet: ordered ? undefined : { level: clampedLevel },
            numbering: ordered
              ? { reference: "rp-decimal-list", level: clampedLevel, instance: instanceId }
              : undefined,
            spacing: { after: 80 },
          }),
        );

        for (const nested of nestedLists) {
          const nextInstance = nested.ordered ? ++numberedListInstance : instanceId;
          paragraphs.push(...convertList(nested.el, nested.ordered, clampedLevel + 1, nextInstance));
        }
      }
      return paragraphs;
    };

    const convertTable = (tableEl: Element): DocxTable | null => {
      const trElements = Array.from(tableEl.querySelectorAll("tr"));
      if (trElements.length === 0) return null;

      const cellBorder = {
        style: BorderStyle.SINGLE,
        size: 4,
        color: "CBD5E1",
      };

      const rows = trElements
        .map((tr) => {
          const cellEls = Array.from(tr.children).filter((c) =>
            ["th", "td"].includes(c.tagName.toLowerCase()),
          );
          if (cellEls.length === 0) return null;

          const cells = cellEls.map((cellEl) => {
            const isHeader = cellEl.tagName.toLowerCase() === "th";
            const cellAlign = mapAlignment(cellEl.getAttribute("data-text-align"));
            const colSpan = Number.parseInt(cellEl.getAttribute("colspan") ?? "1", 10);
            const rowSpan = Number.parseInt(cellEl.getAttribute("rowspan") ?? "1", 10);

            const cellParagraphs: DocxParagraph[] = [];
            for (const block of Array.from(cellEl.children)) {
              const blockTag = block.tagName.toLowerCase();
              if (blockTag === "ul" || blockTag === "ol") {
                const inst = blockTag === "ol" ? ++numberedListInstance : 0;
                cellParagraphs.push(...convertList(block, blockTag === "ol", 0, inst));
              } else {
                const blockAlign = mapAlignment(block.getAttribute("data-text-align")) ?? cellAlign;
                const runs = collectInlineRuns(block.childNodes, isHeader ? { bold: true } : {});
                cellParagraphs.push(
                  new Paragraph({
                    alignment: blockAlign,
                    heading: headingLevelForTag(blockTag),
                    children: runs.length > 0 ? runs : [new TextRun({ text: "" })],
                    spacing: { after: 60 },
                  }),
                );
              }
            }
            if (cellParagraphs.length === 0) {
              cellParagraphs.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
            }

            return new TableCell({
              children: cellParagraphs,
              columnSpan: Number.isInteger(colSpan) && colSpan > 1 ? colSpan : undefined,
              rowSpan: Number.isInteger(rowSpan) && rowSpan > 1 ? rowSpan : undefined,
              shading: isHeader
                ? { type: ShadingType.CLEAR, color: "auto", fill: "F1F5F9" }
                : undefined,
              borders: {
                top: cellBorder,
                bottom: cellBorder,
                left: cellBorder,
                right: cellBorder,
              },
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
            });
          });

          return new TableRow({
            tableHeader: cellEls.every((c) => c.tagName.toLowerCase() === "th"),
            children: cells,
          });
        })
        .filter((r): r is InstanceType<typeof TableRow> => r !== null);

      if (rows.length === 0) return null;
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows,
      });
    };

    const dom = new DOMParser().parseFromString(
      `<!doctype html><body>${sanitizedHtml}</body>`,
      "text/html",
    );
    const docChildren: FileChild[] = [];

    for (const block of Array.from(dom.body.children)) {
      const tag = block.tagName.toLowerCase();
      if (tag === "hr") {
        docChildren.push(
          new Paragraph({
            border: {
              bottom: { color: "CBD5E1", space: 1, style: BorderStyle.SINGLE, size: 6 },
            },
            spacing: { before: 120, after: 120 },
          }),
        );
        continue;
      }
      if (tag === "ul" || tag === "ol") {
        const ordered = tag === "ol";
        const inst = ordered ? ++numberedListInstance : 0;
        docChildren.push(...convertList(block, ordered, 0, inst));
        continue;
      }
      if (tag === "table") {
        const tbl = convertTable(block);
        if (tbl) {
          docChildren.push(tbl);
          docChildren.push(new Paragraph({ children: [new TextRun({ text: "" })], spacing: { after: 80 } }));
        }
        continue;
      }
      if (tag === "blockquote") {
        const innerBlocks = Array.from(block.children);
        const sources = innerBlocks.length > 0 ? innerBlocks : [block];
        for (const src of sources) {
          const runs = collectInlineRuns(src.childNodes, { italics: true });
          docChildren.push(
            new Paragraph({
              children: runs.length > 0 ? runs : [new TextRun({ text: "" })],
              indent: { left: 480 },
              border: {
                left: { color: "94A3B8", space: 8, style: BorderStyle.SINGLE, size: 12 },
              },
              spacing: { before: 80, after: 120 },
            }),
          );
        }
        continue;
      }

      const runs = collectInlineRuns(block.childNodes, {});
      docChildren.push(
        new Paragraph({
          heading: headingLevelForTag(tag),
          alignment: mapAlignment(block.getAttribute("data-text-align")),
          children: runs.length > 0 ? runs : [new TextRun({ text: "" })],
          spacing: { after: 140 },
        }),
      );
    }

    if (docChildren.length === 0) {
      docChildren.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
    }

    const doc = new Document({
      numbering: {
        config: [
          {
            reference: "rp-decimal-list",
            levels: [0, 1, 2].map((lvl) => ({
              level: lvl,
              format: LevelFormat.DECIMAL,
              text: `%${lvl + 1}.`,
              alignment: AlignmentType.START,
              style: {
                paragraph: {
                  indent: { left: 360 * (lvl + 1), hanging: 260 },
                },
              },
            })),
          },
        ],
      },
      sections: [
        {
          properties: {},
          children: docChildren,
        },
      ],
    });

    try {
      const rawBlob = await Packer.toBlob(doc);
      const buffer = await rawBlob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (options?.maxBytes && bytes.byteLength > options.maxBytes) {
        throw new DocConvertError(
          "FILE_TOO_LARGE",
          "The exported Word document exceeds the configured file size limit.",
        );
      }
      const blob = new Blob([buffer], { type: DOCX_MIME });
      return {
        blob,
        bytes,
        mimeType: DOCX_MIME,
      };
    } catch (err) {
      if (err instanceof DocConvertError) throw err;
      throw new DocConvertError(
        "DOCX_EXPORT_FAILED",
        "Unable to generate the updated Word (.docx) document.",
      );
    }
  }, options?.timeoutMs);
}
