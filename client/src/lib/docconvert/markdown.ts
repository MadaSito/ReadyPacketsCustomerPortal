/**
 * Safe Markdown <-> sanitised HTML conversion for document import and `safe_markdown` policies (D9 & D12).
 * Neutralises raw HTML tags in source Markdown before parsing, then runs `sanitizeDocumentHtml`.
 */
import { DocConvertError, type DocConvertOptions, type MarkdownImportResult } from "./types";
import { assertInputSize, toUint8Array } from "./guards";
import {
  htmlToPlainText,
  isAllowedDocumentHref,
  sanitizeDocumentHtmlWithWarnings,
} from "./sanitize";
import { splitPipeRow } from "../pipeTable";

const MAX_MARKDOWN_LINES = 25_000;

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMarkdown(escapedLine: string, warnings: Set<string>): string {
  const codeTokens: string[] = [];
  let text = escapedLine.replace(/`([^`]+)`/g, (_m, code: string) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code>${code}</code>`);
    return `\uE000CODE_${idx}\uE001`;
  });

  // Images in markdown: keep alt text if non-HTTPS, allow https:// images
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, rawUrl: string) => {
    const url = rawUrl.replace(/&amp;/g, "&").trim();
    if (/^https:\/\//i.test(url)) {
      return `<img src="${escapeHtml(url)}" alt="${alt || "Image"}">`;
    }
    warnings.add("Markdown images without HTTPS URLs were omitted.");
    return alt ? `[Image: ${alt}]` : "";
  });

  // Links: [label](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, rawUrl: string) => {
    const decodedUrl = rawUrl.replace(/&amp;/g, "&").trim();
    if (isAllowedDocumentHref(decodedUrl)) {
      return `<a href="${escapeHtml(decodedUrl)}">${label}</a>`;
    }
    warnings.add("Unsupported or non-HTTPS Markdown links were converted to plain text.");
    return label;
  });

  // Bold + italic, bold, italic, strikethrough
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1<em>$2</em>");
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1<em>$2</em>");

  return text.replace(/\uE000CODE_(\d+)\uE001/g, (_m, idxStr: string) => {
    const idx = Number.parseInt(idxStr, 10);
    return codeTokens[idx] ?? "";
  });
}

const splitTableRow = splitPipeRow;

function parseTableSeparator(line: string): Array<"left" | "center" | "right" | null> | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|") && !/^:?-{3,}:?$/.test(trimmed)) return null;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return null;
  const aligns: Array<"left" | "center" | "right" | null> = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) aligns.push("center");
    else if (right) aligns.push("right");
    else if (left) aligns.push("left");
    else aligns.push(null);
  }
  return aligns;
}

export async function markdownToHtml(
  input: string | ArrayBuffer | Uint8Array | Blob,
  options?: DocConvertOptions,
): Promise<MarkdownImportResult> {
  let rawMarkdown: string;
  if (typeof input === "string") {
    const byteLength = new TextEncoder().encode(input).byteLength;
    assertInputSize(byteLength, options?.maxBytes);
    rawMarkdown = input;
  } else {
    const bytes = await toUint8Array(input, options?.maxBytes);
    try {
      rawMarkdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new DocConvertError(
        "INVALID_UTF8_TEXT",
        "This Markdown file is not valid UTF-8 text.",
      );
    }
  }

  const normalized = rawMarkdown.replace(/\r\n?/g, "\n").split("\0").join("");
  const lines = normalized.split("\n");
  if (lines.length > MAX_MARKDOWN_LINES) {
    throw new DocConvertError(
      "DOCUMENT_HTML_TOO_COMPLEX",
      `This Markdown file exceeds the ${MAX_MARKDOWN_LINES}-line limit.`,
    );
  }

  const warnings = new Set<string>();
  if (/<[a-z!/][^>]*>/i.test(normalized)) {
    warnings.add("Raw HTML tags in Markdown were escaped as literal text for safety.");
  }

  const htmlBlocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block
    if (/^```/.test(trimmed)) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test((lines[i] ?? "").trim())) {
        codeLines.push(escapeHtml(lines[i] ?? ""));
        i += 1;
      }
      if (i < lines.length) i += 1;
      const body = codeLines.join("<br>");
      htmlBlocks.push(`<p><code>${body}</code></p>`);
      continue;
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      htmlBlocks.push("<hr>");
      i += 1;
      continue;
    }

    // ATX Heading (# .. ######, clamped to h1..h4)
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
    if (headingMatch?.[1] && headingMatch[2]) {
      const level = Math.min(4, headingMatch[1].length);
      const inline = renderInlineMarkdown(escapeHtml(headingMatch[2]), warnings);
      htmlBlocks.push(`<h${level}>${inline}</h${level}>`);
      i += 1;
      continue;
    }

    // GFM Pipe Table
    const nextLine = lines[i + 1];
    if (trimmed.includes("|") && nextLine !== undefined) {
      const colAligns = parseTableSeparator(nextLine);
      if (colAligns) {
        const headerCells = splitTableRow(line);
        if (headerCells.length === colAligns.length) {
          const thHtml = headerCells
            .map((cell, colIdx) => {
              const align = colAligns[colIdx];
              const attr = align && align !== "left" ? ` data-text-align="${align}"` : "";
              return `<th${attr}><p>${renderInlineMarkdown(escapeHtml(cell), warnings)}</p></th>`;
            })
            .join("");
          i += 2;
          const bodyRows: string[] = [];
          while (i < lines.length) {
            const rowLine = (lines[i] ?? "").trim();
            if (!rowLine || !rowLine.includes("|")) break;
            const cells = splitTableRow(rowLine);
            const tdHtml = colAligns
              .map((align, colIdx) => {
                const rawCell = cells[colIdx] ?? "";
                const attr = align && align !== "left" ? ` data-text-align="${align}"` : "";
                return `<td${attr}><p>${renderInlineMarkdown(escapeHtml(rawCell), warnings)}</p></td>`;
              })
              .join("");
            bodyRows.push(`<tr>${tdHtml}</tr>`);
            i += 1;
          }
          htmlBlocks.push(
            `<table><tbody><tr>${thHtml}</tr>${bodyRows.join("")}</tbody></table>`,
          );
          continue;
        }
      }
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test((lines[i] ?? "").trim())) {
        quoteLines.push((lines[i] ?? "").trim().replace(/^>\s?/, ""));
        i += 1;
      }
      const quoteContent = quoteLines
        .map((ql) => renderInlineMarkdown(escapeHtml(ql), warnings))
        .join("<br>");
      htmlBlocks.push(`<blockquote><p>${quoteContent}</p></blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test((lines[i] ?? "").trim())) {
        const itemText = (lines[i] ?? "").trim().replace(/^[-*+]\s+/, "");
        items.push(`<li><p>${renderInlineMarkdown(escapeHtml(itemText), warnings)}</p></li>`);
        i += 1;
      }
      htmlBlocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test((lines[i] ?? "").trim())) {
        const itemText = (lines[i] ?? "").trim().replace(/^\d+\.\s+/, "");
        items.push(`<li><p>${renderInlineMarkdown(escapeHtml(itemText), warnings)}</p></li>`);
        i += 1;
      }
      htmlBlocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Paragraph (collect consecutive non-special lines)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = (lines[i] ?? "").trim();
      if (
        !cur ||
        /^```/.test(cur) ||
        /^(?:-{3,}|\*{3,}|_{3,})$/.test(cur) ||
        /^#{1,6}\s+/.test(cur) ||
        /^>\s?/.test(cur) ||
        /^[-*+]\s+/.test(cur) ||
        /^\d+\.\s+/.test(cur)
      ) {
        break;
      }
      const peekNext = lines[i + 1];
      if (cur.includes("|") && peekNext !== undefined && parseTableSeparator(peekNext)) {
        break;
      }
      paraLines.push(renderInlineMarkdown(escapeHtml(cur), warnings));
      i += 1;
    }
    if (paraLines.length > 0) {
      htmlBlocks.push(`<p>${paraLines.join("<br>")}</p>`);
    }
  }

  const sanitized = sanitizeDocumentHtmlWithWarnings(htmlBlocks.join(""));
  for (const w of sanitized.warnings) warnings.add(w);
  const sanitizedHtml = sanitized.html;
  const plainText = htmlToPlainText(sanitizedHtml);
  const canonicalMarkdown = htmlToMarkdown(sanitizedHtml);

  return {
    sanitizedHtml,
    markdown: canonicalMarkdown || normalized.trim(),
    plainText,
    warnings: Array.from(warnings),
  };
}

function serializeInlineToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/\s+/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === "br") return "  \n";
  if (tag === "img") {
    const src = (el.getAttribute("src") ?? "").trim();
    const alt = (el.getAttribute("alt") ?? "Image").replace(/[[\]]/g, "");
    if (/^https:\/\//i.test(src)) {
      return `![${alt}](${src})`;
    }
    return alt ? `[${alt}]` : "";
  }
  const inner = Array.from(el.childNodes).map(serializeInlineToMarkdown).join("");
  if (!inner.trim()) return inner;

  switch (tag) {
    case "strong":
    case "b":
      return `**${inner.trim()}**`;
    case "em":
    case "i":
      return `*${inner.trim()}*`;
    case "s":
    case "del":
      return `~~${inner.trim()}~~`;
    case "code":
      return `\`${inner.replace(/`/g, "'").trim()}\``;
    case "a": {
      const href = (el.getAttribute("href") ?? "").trim();
      if (isAllowedDocumentHref(href)) {
        return `[${inner.trim()}](${href})`;
      }
      return inner;
    }
    default:
      return inner;
  }
}

/**
 * Converts sanitised HTML (from `.docx`, `.md`, or `.pdf`) into clean safe Markdown
 * suitable for `safe_markdown` compliance policies.
 */
export function htmlToMarkdown(sanitizedHtml: string): string {
  if (!sanitizedHtml.trim()) return "";
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body>${sanitizedHtml}</body>`,
    "text/html",
  );
  const blocks: string[] = [];

  for (const child of Array.from(doc.body.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "hr") {
      blocks.push("---");
      continue;
    }
    if (/^h[1-4]$/.test(tag)) {
      const level = Number.parseInt(tag.slice(1), 10);
      const text = Array.from(child.childNodes).map(serializeInlineToMarkdown).join("").trim();
      if (text) blocks.push(`${"#".repeat(level)} ${text}`);
      continue;
    }
    if (tag === "blockquote") {
      const text = Array.from(child.childNodes)
        .map(serializeInlineToMarkdown)
        .join("")
        .trim()
        .split("\n")
        .map((l) => `> ${l.trim()}`)
        .join("\n");
      if (text) blocks.push(text);
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      const ordered = tag === "ol";
      const lines = Array.from(child.children)
        .filter((li) => li.tagName.toLowerCase() === "li")
        .map((li, idx) => {
          const itemText = Array.from(li.childNodes)
            .map(serializeInlineToMarkdown)
            .join("")
            .replace(/\s*\n\s*/g, " ")
            .trim();
          return `${ordered ? `${idx + 1}.` : "-"} ${itemText}`;
        })
        .filter((line) => line.trim().length > 2);
      if (lines.length > 0) blocks.push(lines.join("\n"));
      continue;
    }
    if (tag === "table") {
      const rows = Array.from(child.querySelectorAll("tr")).map((tr) =>
        Array.from(tr.children)
          .filter((c) => ["th", "td"].includes(c.tagName.toLowerCase()))
          .map((c) =>
            Array.from(c.childNodes)
              .map(serializeInlineToMarkdown)
              .join("")
              // Escape backslashes before pipes so an existing backslash cannot cancel the pipe escape.
              .replace(/\\/g, "\\\\")
              .replace(/\|/g, "\\|")
              .replace(/\s*\n\s*/g, " ")
              .trim(),
          ),
      );
      const firstRow = rows[0];
      if (firstRow && firstRow.length > 0) {
        const colCount = Math.max(...rows.map((r) => r.length));
        const padRow = (r: string[]) =>
          `| ${Array.from({ length: colCount }, (_, idx) => r[idx] ?? "").join(" | ")} |`;
        const sep = `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`;
        const bodyLines = rows.slice(1).map(padRow);
        blocks.push([padRow(firstRow), sep, ...bodyLines].join("\n"));
      }
      continue;
    }
    const para = Array.from(child.childNodes).map(serializeInlineToMarkdown).join("").trim();
    if (para) blocks.push(para);
  }

  return blocks.join("\n\n").trim();
}
