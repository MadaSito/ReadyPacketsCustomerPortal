/**
 * Strict browser HTML sanitiser for imported and edited documents (Increment 06 D9 & D12).
 * Builds on `@/ui`'s inert `DOMParser` + `isAllowedMailHref` / `isAllowedMailImageSrc` rules, extending the
 * structural allow-list for rich documents (headings h1..h4, underline, strike, blockquote, code, tables,
 * `data-text-align`, and bounded raster `data:image/*` from `.docx`) while emitting zero `style` attributes
 * so strict `style-src 'self'` CSP holds without warnings.
 */
import { isAllowedMailHref, isAllowedMailImageSrc } from "@/ui";
import { DocConvertError } from "./types";

export const MAX_DOCUMENT_HTML_NODES = 15_000;
export const MAX_DOCUMENT_HTML_DEPTH = 48;
export const MAX_INLINE_IMAGE_DATA_URI_CHARS = 2_800_000;

export type DocumentTextAlignment = "left" | "center" | "right" | "justify";

const DROPPED_SUBTREE_TAGS = new Set<string>([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "template",
  "svg",
  "math",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "meta",
  "link",
  "base",
  "noscript",
  "audio",
  "video",
  "canvas",
]);

const TAG_SYNONYMS = new Map<string, string>([
  ["b", "strong"],
  ["i", "em"],
  ["del", "s"],
  ["strike", "s"],
  ["h5", "h4"],
  ["h6", "h4"],
]);

const ALIGNABLE_TAGS = new Set<string>(["p", "h1", "h2", "h3", "h4", "th", "td"]);
const VALID_ALIGNMENTS = new Set<string>(["left", "center", "right", "justify"]);

const ALLOWED_ATTRS = new Map<string, ReadonlySet<string>>([
  ["p", new Set(["data-text-align"])],
  ["h1", new Set(["data-text-align"])],
  ["h2", new Set(["data-text-align"])],
  ["h3", new Set(["data-text-align"])],
  ["h4", new Set(["data-text-align"])],
  ["blockquote", new Set()],
  ["ul", new Set()],
  ["ol", new Set()],
  ["li", new Set()],
  ["hr", new Set()],
  ["br", new Set()],
  ["table", new Set()],
  ["thead", new Set()],
  ["tbody", new Set()],
  ["tr", new Set()],
  ["th", new Set(["colspan", "rowspan", "data-text-align"])],
  ["td", new Set(["colspan", "rowspan", "data-text-align"])],
  ["strong", new Set()],
  ["em", new Set()],
  ["u", new Set()],
  ["s", new Set()],
  ["code", new Set()],
  ["a", new Set(["href"])],
  ["img", new Set(["src", "alt"])],
]);

const SAFE_RASTER_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isAllowedDocumentHref(value: string): boolean {
  const href = value.trim();
  if (!href) return false;
  if (!/^https:\/\//i.test(href) && !/^mailto:/i.test(href)) return false;
  return isAllowedMailHref(href);
}

export function isAllowedDocumentImageSrc(value: string): boolean {
  const src = value.trim();
  if (!src) return false;
  if (isAllowedMailImageSrc(src)) return true;
  if (src.length > MAX_INLINE_IMAGE_DATA_URI_CHARS) return false;
  return SAFE_RASTER_DATA_IMAGE_RE.test(src);
}

function extractAlignment(element: Element): DocumentTextAlignment | null {
  const dataAttr = (element.getAttribute("data-text-align") ?? "").trim().toLowerCase();
  if (VALID_ALIGNMENTS.has(dataAttr)) return dataAttr as DocumentTextAlignment;

  const alignAttr = (element.getAttribute("align") ?? "").trim().toLowerCase();
  if (VALID_ALIGNMENTS.has(alignAttr)) return alignAttr as DocumentTextAlignment;

  const rawStyle = element.getAttribute("style") ?? "";
  const match = /(?:^|;)\s*text-align\s*:\s*(left|center|right|justify)\b/i.exec(rawStyle);
  if (match?.[1]) {
    const candidate = match[1].toLowerCase();
    if (VALID_ALIGNMENTS.has(candidate)) return candidate as DocumentTextAlignment;
  }
  return null;
}

export interface SanitizeDocumentResult {
  readonly html: string;
  readonly warnings: string[];
}

export function sanitizeDocumentHtmlWithWarnings(rawHtml: string): SanitizeDocumentResult {
  if (!rawHtml.trim()) {
    return { html: "", warnings: [] };
  }

  const doc = new DOMParser().parseFromString(`<!doctype html><body>${rawHtml}</body>`, "text/html");
  const warnings = new Set<string>();
  let nodeCount = 0;

  function renameElement(el: Element, newTag: string): Element {
    const replacement = doc.createElement(newTag);
    for (const attr of Array.from(el.attributes)) {
      replacement.setAttribute(attr.name, attr.value);
    }
    while (el.firstChild) {
      replacement.appendChild(el.firstChild);
    }
    el.replaceWith(replacement);
    return replacement;
  }

  function cleanChildren(parent: Element, depth: number, insideTable: boolean): void {
    if (depth > MAX_DOCUMENT_HTML_DEPTH) {
      throw new DocConvertError(
        "DOCUMENT_HTML_TOO_COMPLEX",
        "This document's structure is too deeply nested to open safely in the browser.",
      );
    }

    for (const node of Array.from(parent.childNodes)) {
      nodeCount += 1;
      if (nodeCount > MAX_DOCUMENT_HTML_NODES) {
        throw new DocConvertError(
          "DOCUMENT_HTML_TOO_COMPLEX",
          "This document contains too many formatting elements to open safely in the browser.",
        );
      }

      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove();
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        node.remove();
        continue;
      }

      let el = node as Element;
      let tag = el.tagName.toLowerCase();

      if (DROPPED_SUBTREE_TAGS.has(tag)) {
        el.remove();
        continue;
      }

      const mapped = TAG_SYNONYMS.get(tag);
      if (mapped) {
        el = renameElement(el, mapped);
        tag = mapped;
      }

      if (tag === "tfoot") {
        el = renameElement(el, "tbody");
        tag = "tbody";
      }

      if (tag === "table" && insideTable) {
        warnings.add("Nested tables were simplified into paragraphs so they can be edited safely.");
        cleanChildren(el, depth + 1, true);
        const paragraphs: Node[] = [];
        for (const cell of Array.from(el.querySelectorAll("th, td"))) {
          const p = doc.createElement("p");
          p.textContent = (cell.textContent ?? "").trim();
          if (p.textContent) paragraphs.push(p);
        }
        el.replaceWith(...paragraphs);
        continue;
      }

      const allowedAttrs = ALLOWED_ATTRS.get(tag);
      if (!allowedAttrs) {
        cleanChildren(el, depth + 1, insideTable);
        el.replaceWith(...Array.from(el.childNodes));
        continue;
      }

      const align = ALIGNABLE_TAGS.has(tag) ? extractAlignment(el) : null;
      const colSpanRaw = tag === "th" || tag === "td" ? Number.parseInt(el.getAttribute("colspan") ?? "", 10) : NaN;
      const rowSpanRaw = tag === "th" || tag === "td" ? Number.parseInt(el.getAttribute("rowspan") ?? "", 10) : NaN;
      const rawHref = tag === "a" ? (el.getAttribute("href") ?? "").trim() : "";
      const rawSrc = tag === "img" ? (el.getAttribute("src") ?? "").trim() : "";
      const rawAlt = tag === "img" ? (el.getAttribute("alt") ?? "").trim() : "";

      for (const attr of Array.from(el.attributes)) {
        el.removeAttribute(attr.name);
      }

      if (align && align !== "left" && allowedAttrs.has("data-text-align")) {
        el.setAttribute("data-text-align", align);
      }

      if (tag === "th" || tag === "td") {
        if (Number.isInteger(colSpanRaw) && colSpanRaw >= 2 && colSpanRaw <= 20) {
          el.setAttribute("colspan", String(colSpanRaw));
        }
        if (Number.isInteger(rowSpanRaw) && rowSpanRaw >= 2 && rowSpanRaw <= 20) {
          el.setAttribute("rowspan", String(rowSpanRaw));
        }
      }

      if (tag === "a") {
        if (!isAllowedDocumentHref(rawHref)) {
          if (rawHref && !rawHref.startsWith("#")) {
            warnings.add("Unsupported or non-HTTPS links were converted to plain text.");
          }
          cleanChildren(el, depth + 1, insideTable);
          el.replaceWith(...Array.from(el.childNodes));
          continue;
        }
        el.setAttribute("href", rawHref);
      }

      if (tag === "img") {
        if (!isAllowedDocumentImageSrc(rawSrc)) {
          warnings.add("Unsupported or oversized embedded images were omitted.");
          el.remove();
          continue;
        }
        el.setAttribute("src", rawSrc);
        el.setAttribute("alt", rawAlt || "Document image");
        continue;
      }

      cleanChildren(el, depth + 1, insideTable || tag === "table");

      if (tag === "th" || tag === "td") {
        ensureBlockChildrenInCell(doc, el);
      }
      if (tag === "table") {
        normalizeTableStructure(doc, el);
        if (!el.querySelector("tr")) {
          el.remove();
        }
      }
    }
  }

  cleanChildren(doc.body, 0, false);
  wrapTopLevelInlineNodes(doc, doc.body);

  while (
    doc.body.lastElementChild?.tagName === "P" &&
    !doc.body.lastElementChild.hasChildNodes() &&
    doc.body.children.length > 1
  ) {
    doc.body.lastElementChild.remove();
  }

  return {
    html: doc.body.innerHTML,
    warnings: Array.from(warnings),
  };
}

export function sanitizeDocumentHtml(rawHtml: string): string {
  return sanitizeDocumentHtmlWithWarnings(rawHtml).html;
}

const BLOCK_TAG_SET = new Set<string>([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "blockquote",
  "ul",
  "ol",
  "hr",
  "table",
]);

function ensureBlockChildrenInCell(doc: Document, cell: Element): void {
  const hasBlock = Array.from(cell.children).some((c) => BLOCK_TAG_SET.has(c.tagName.toLowerCase()));
  if (!hasBlock) {
    const p = doc.createElement("p");
    while (cell.firstChild) {
      p.appendChild(cell.firstChild);
    }
    cell.appendChild(p);
    return;
  }

  let inlineRun: Node[] = [];
  const flushInline = (beforeNode: Node | null) => {
    const hasMeaningful = inlineRun.some(
      (n) => n.nodeType !== Node.TEXT_NODE || (n.textContent ?? "").trim().length > 0,
    );
    if (hasMeaningful) {
      const p = doc.createElement("p");
      for (const item of inlineRun) p.appendChild(item);
      cell.insertBefore(p, beforeNode);
    } else {
      for (const item of inlineRun) item.parentNode?.removeChild(item);
    }
    inlineRun = [];
  };

  for (const child of Array.from(cell.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE && BLOCK_TAG_SET.has((child as Element).tagName.toLowerCase())) {
      if (inlineRun.length > 0) flushInline(child);
    } else {
      inlineRun.push(child);
    }
  }
  if (inlineRun.length > 0) flushInline(null);
}

function normalizeTableStructure(doc: Document, table: Element): void {
  const rows: Element[] = [];
  for (const child of Array.from(table.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "tr") {
      rows.push(child);
    } else if (tag === "thead" || tag === "tbody") {
      for (const sub of Array.from(child.children)) {
        if (sub.tagName.toLowerCase() === "tr") {
          if (tag === "thead") {
            for (const cell of Array.from(sub.children)) {
              if (cell.tagName.toLowerCase() === "td") {
                const th = doc.createElement("th");
                for (const attr of Array.from(cell.attributes)) th.setAttribute(attr.name, attr.value);
                while (cell.firstChild) th.appendChild(cell.firstChild);
                cell.replaceWith(th);
              }
            }
          }
          rows.push(sub);
        }
      }
    }
  }

  while (table.firstChild) table.removeChild(table.firstChild);
  if (rows.length === 0) return;

  const tbody = doc.createElement("tbody");
  for (const row of rows) {
    for (const child of Array.from(row.childNodes)) {
      if (
        child.nodeType !== Node.ELEMENT_NODE ||
        !["th", "td"].includes((child as Element).tagName.toLowerCase())
      ) {
        child.parentNode?.removeChild(child);
      }
    }
    if (row.children.length > 0) {
      tbody.appendChild(row);
    }
  }
  if (tbody.children.length > 0) {
    table.appendChild(tbody);
  }
}

function wrapTopLevelInlineNodes(doc: Document, body: Element): void {
  let inlineBuffer: Node[] = [];
  const flush = (before: Node | null) => {
    const nonEmpty = inlineBuffer.some(
      (n) => n.nodeType !== Node.TEXT_NODE || (n.textContent ?? "").trim().length > 0,
    );
    if (nonEmpty) {
      const p = doc.createElement("p");
      for (const n of inlineBuffer) p.appendChild(n);
      body.insertBefore(p, before);
    } else {
      for (const n of inlineBuffer) n.parentNode?.removeChild(n);
    }
    inlineBuffer = [];
  };

  for (const child of Array.from(body.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE && BLOCK_TAG_SET.has((child as Element).tagName.toLowerCase())) {
      if (inlineBuffer.length > 0) flush(child);
    } else {
      inlineBuffer.push(child);
    }
  }
  if (inlineBuffer.length > 0) flush(null);
}

/**
 * Extracts readable paragraph-separated plain text from sanitised HTML.
 */
export function htmlToPlainText(html: string): string {
  if (!html.trim()) return "";
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
  const blocks: string[] = [];

  function walkBlock(el: Element): void {
    const tag = el.tagName.toLowerCase();
    if (tag === "hr") {
      blocks.push("---");
      return;
    }
    if (tag === "ul" || tag === "ol") {
      const ordered = tag === "ol";
      const items = Array.from(el.children)
        .filter((c) => c.tagName.toLowerCase() === "li")
        .map((li, idx) => `${ordered ? `${idx + 1}.` : "-"} ${(li.textContent ?? "").replace(/\s+/g, " ").trim()}`)
        .filter((line) => line.length > 2);
      if (items.length > 0) blocks.push(items.join("\n"));
      return;
    }
    if (tag === "table") {
      const rowLines: string[] = [];
      for (const tr of Array.from(el.querySelectorAll("tr"))) {
        const cells = Array.from(tr.children)
          .filter((c) => ["th", "td"].includes(c.tagName.toLowerCase()))
          .map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim());
        if (cells.length > 0) rowLines.push(cells.join("\t"));
      }
      if (rowLines.length > 0) blocks.push(rowLines.join("\n"));
      return;
    }
    const clone = el.cloneNode(true) as Element;
    for (const br of Array.from(clone.querySelectorAll("br"))) {
      br.replaceWith("\n");
    }
    const text = (clone.textContent ?? "")
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .trim();
    if (text) blocks.push(text);
  }

  for (const child of Array.from(doc.body.children)) {
    walkBlock(child);
  }
  if (blocks.length === 0) {
    return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  return blocks.join("\n\n");
}
