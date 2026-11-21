/**
 * Knowledge Base — deterministic HTML allow-list sanitiser, plain-text extractor,
 * Table-of-Contents generator, and typed `KnowledgeRichBlock[]` AST projector (Package F).
 *
 * Security & accessibility invariants (Decision 7, §4, §4.2):
 *  - Zero pass-through markup: input HTML is tokenised into a bounded AST of allow-listed literal
 *    tags (`Map` lookup, immune to `Object.prototype` keys) with bounded depth (16) and node count
 *    (3,000), then re-serialised from scratch with HTML entity escaping on every text/attribute value.
 *  - Dangerous elements (`script`, `style`, `svg`, `math`, `iframe`, `object`, `embed`, `form`,
 *    `input`, `button`, `meta`, `link`, `base`, etc.) and event/style/srcdoc attributes are rejected
 *    with `VALIDATION_ERROR` on write.
 *  - URLs in `a[href]` allow only `https://` (no credentials), `mailto:`, `#fragment`, or safe
 *    same-origin relative paths (`/...`, never `//` or backslash); `img[src]` allows `https://` only.
 *  - Any `<h1>` inside an article body is normalised to `<h2>` so the article page always preserves
 *    a single page-level `<h1>` (WCAG 2.2 AA §4.2).
 *  - Client pages render `KnowledgeRichBlock[]` directly as React elements — zero `dangerouslySetInnerHTML`.
 */
import { validation } from "../../core/errors.js";
import type {
  KnowledgeInlineNode,
  KnowledgeListItemNode,
  KnowledgeRichBlock,
  KnowledgeTocEntry,
} from "./types.js";

export const MAX_ARTICLE_HTML_BYTES = 128 * 1024;
const MAX_AST_DEPTH = 16;
const MAX_AST_NODES = 3_000;
const MAX_URL_LENGTH = 2_048;
const MAX_ALT_LENGTH = 240;

// eslint-disable-next-line no-control-regex
const UNSAFE_URL_CONTROL_RE = /[\u0000-\u001F\u007F\u2028\u2029\s]/u;
const MAILBOX_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const RELATIVE_PATH_RE = /^\/(?![/\\])[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]{0,500}$/;
const FRAGMENT_RE = /^#[a-z0-9][a-z0-9-]{0,119}$/;

type CanonicalTag =
  | "p"
  | "h2"
  | "h3"
  | "h4"
  | "strong"
  | "em"
  | "ul"
  | "ol"
  | "li"
  | "blockquote"
  | "pre"
  | "code"
  | "br"
  | "hr"
  | "a"
  | "img"
  | "table"
  | "thead"
  | "tbody"
  | "tr"
  | "th"
  | "td"
  | "span";

const ALLOWED_TAG_MAP = new Map<string, CanonicalTag>([
  ["p", "p"],
  ["h1", "h2"], // Promote body h1 -> h2 so page keeps sole h1
  ["h2", "h2"],
  ["h3", "h3"],
  ["h4", "h4"],
  ["h5", "h4"],
  ["h6", "h4"],
  ["strong", "strong"],
  ["b", "strong"],
  ["em", "em"],
  ["i", "em"],
  ["ul", "ul"],
  ["ol", "ol"],
  ["li", "li"],
  ["blockquote", "blockquote"],
  ["pre", "pre"],
  ["code", "code"],
  ["br", "br"],
  ["hr", "hr"],
  ["a", "a"],
  ["img", "img"],
  ["table", "table"],
  ["thead", "thead"],
  ["tbody", "tbody"],
  ["tr", "tr"],
  ["th", "th"],
  ["td", "td"],
  ["span", "span"],
]);

const NEUTRAL_WRAPPER_TAGS = new Set<string>([
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "figure",
  "figcaption",
]);

const FORBIDDEN_TAGS = new Set<string>([
  "script",
  "style",
  "svg",
  "math",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "meta",
  "link",
  "base",
  "title",
  "head",
  "template",
  "noscript",
  "portal",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
]);

const VOID_TAGS = new Set<string>(["br", "hr", "img"]);

const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["ndash", "\u2013"],
  ["mdash", "\u2014"],
  ["hellip", "\u2026"],
  ["rsquo", "\u2019"],
  ["lsquo", "\u2018"],
  ["rdquo", "\u201D"],
  ["ldquo", "\u201C"],
  ["bull", "\u2022"],
  ["copy", "\u00A9"],
  ["reg", "\u00AE"],
]);

interface RawAstElement {
  kind: "element";
  tag: CanonicalTag;
  attrs: {
    href?: string;
    external?: boolean;
    src?: string;
    alt?: string;
  };
  children: RawAstNode[];
}

type RawAstNode = { kind: "text"; text: string } | RawAstElement;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function decodeEntities(raw: string): string {
  const decoded = raw.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,12});/g, (full, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return full;
      }
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return "";
      return String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return full;
      }
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return "";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? full;
  });
  // Strip C0 control chars except \t and \n
  // eslint-disable-next-line no-control-regex
  return decoded.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").normalize("NFC");
}

export function validateSafeArticleHref(rawHref: string): { href: string; external: boolean } | null {
  const decoded = decodeEntities(rawHref).trim();
  if (!decoded || decoded.length > MAX_URL_LENGTH || UNSAFE_URL_CONTROL_RE.test(decoded)) {
    return null;
  }
  if (FRAGMENT_RE.test(decoded)) {
    return { href: decoded, external: false };
  }
  if (RELATIVE_PATH_RE.test(decoded) && !decoded.includes("\\")) {
    return { href: decoded, external: false };
  }
  if (decoded.toLowerCase().startsWith("mailto:")) {
    const addr = decoded.slice(7);
    if (MAILBOX_RE.test(addr)) {
      return { href: `mailto:${addr}`, external: true };
    }
    return null;
  }
  try {
    const parsed = new URL(decoded);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return { href: parsed.toString(), external: true };
  } catch {
    return null;
  }
}

export function validateSafeArticleImgSrc(rawSrc: string): string | null {
  const decoded = decodeEntities(rawSrc).trim();
  if (!decoded || decoded.length > MAX_URL_LENGTH || UNSAFE_URL_CONTROL_RE.test(decoded)) {
    return null;
  }
  try {
    const parsed = new URL(decoded);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseStartTagAttributes(attrSource: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attrSource)) !== null) {
    const name = match[1]!.toLowerCase();
    if (name.startsWith("on") || name === "style" || name === "srcdoc" || name === "formaction") {
      throw validation("UNSAFE_ARTICLE_HTML", `Disallowed HTML attribute '${name}' in article body.`);
    }
    const val = match[2] ?? match[3] ?? match[4] ?? "";
    attrs.set(name, val);
  }
  return attrs;
}

function parseSanitizedRawAst(rawHtml: string, strict: boolean): RawAstNode[] {
  if (rawHtml.includes("\0")) {
    if (strict) throw validation("UNSAFE_ARTICLE_HTML", "Article HTML cannot contain null bytes.");
    return [];
  }
  if (Buffer.byteLength(rawHtml, "utf8") > MAX_ARTICLE_HTML_BYTES) {
    if (strict) {
      throw validation("ARTICLE_HTML_TOO_LARGE", "Article body exceeds maximum size of 128 KB.");
    }
    return [];
  }

  const rootChildren: RawAstNode[] = [];
  const stack: Array<{ wrapper: boolean; node?: RawAstElement; rawTag: string }> = [];
  let nodeCount = 0;

  const currentChildren = (): RawAstNode[] => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const entry = stack[i]!;
      if (!entry.wrapper && entry.node) return entry.node.children;
    }
    return rootChildren;
  };

  const appendText = (raw: string) => {
    if (!raw) return;
    const text = decodeEntities(raw);
    if (!text) return;
    const target = currentChildren();
    const prev = target[target.length - 1];
    if (prev && prev.kind === "text") {
      prev.text += text;
    } else {
      nodeCount += 1;
      if (nodeCount > MAX_AST_NODES) {
        if (strict) throw validation("ARTICLE_HTML_TOO_COMPLEX", "Article HTML exceeds maximum element count.");
        return;
      }
      target.push({ kind: "text", text });
    }
  };

  let cursor = 0;
  while (cursor < rawHtml.length) {
    const lt = rawHtml.indexOf("<", cursor);
    if (lt === -1) {
      appendText(rawHtml.slice(cursor));
      break;
    }
    if (lt > cursor) {
      appendText(rawHtml.slice(cursor, lt));
    }

    // HTML comments are stripped cleanly
    if (rawHtml.startsWith("<!--", lt)) {
      const endComment = rawHtml.indexOf("-->", lt + 4);
      if (endComment === -1) {
        if (strict) throw validation("UNSAFE_ARTICLE_HTML", "Unclosed HTML comment in article body.");
        break;
      }
      cursor = endComment + 3;
      continue;
    }

    if (rawHtml.startsWith("<!", lt) || rawHtml.startsWith("<?", lt)) {
      if (strict) throw validation("UNSAFE_ARTICLE_HTML", "HTML declarations are not permitted in article bodies.");
      const gtDecl = rawHtml.indexOf(">", lt + 2);
      if (gtDecl === -1) break;
      cursor = gtDecl + 1;
      continue;
    }

    const gt = rawHtml.indexOf(">", lt + 1);
    if (gt === -1) {
      if (strict) throw validation("UNSAFE_ARTICLE_HTML", "Malformed unclosed HTML tag in article body.");
      break;
    }

    const inside = rawHtml.slice(lt + 1, gt).trim();
    cursor = gt + 1;
    if (!inside) continue;

    if (inside.startsWith("/")) {
      const closeName = inside.slice(1).trim().toLowerCase();
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]!.rawTag === closeName) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const selfClosing = inside.endsWith("/");
    const tagBody = selfClosing ? inside.slice(0, -1).trim() : inside;
    const spaceIdx = tagBody.search(/\s/);
    const rawTag = (spaceIdx === -1 ? tagBody : tagBody.slice(0, spaceIdx)).toLowerCase();
    const attrPart = spaceIdx === -1 ? "" : tagBody.slice(spaceIdx + 1);

    if (FORBIDDEN_TAGS.has(rawTag)) {
      if (strict) {
        throw validation("UNSAFE_ARTICLE_HTML", `Disallowed HTML tag <${rawTag}> in article body.`);
      }
      // Skip subtree in lenient mode
      const closeSeq = `</${rawTag}`;
      const closePos = rawHtml.toLowerCase().indexOf(closeSeq, cursor);
      if (closePos === -1) break;
      const closeGt = rawHtml.indexOf(">", closePos);
      cursor = closeGt === -1 ? rawHtml.length : closeGt + 1;
      continue;
    }

    if (NEUTRAL_WRAPPER_TAGS.has(rawTag)) {
      if (strict) parseStartTagAttributes(attrPart);
      if (!selfClosing) {
        if (stack.length >= MAX_AST_DEPTH) {
          if (strict) throw validation("ARTICLE_HTML_TOO_COMPLEX", "Article HTML nesting is too deep.");
          continue;
        }
        stack.push({ wrapper: true, rawTag });
      }
      continue;
    }

    const canonical = ALLOWED_TAG_MAP.get(rawTag);
    if (!canonical) {
      if (strict) {
        throw validation("UNSAFE_ARTICLE_HTML", `Unsupported HTML tag <${rawTag}> in article body.`);
      }
      continue;
    }

    const parsedAttrs = strict
      ? parseStartTagAttributes(attrPart)
      : (() => {
          try {
            return parseStartTagAttributes(attrPart);
          } catch {
            return new Map<string, string>();
          }
        })();

    const elemAttrs: RawAstElement["attrs"] = {};
    if (canonical === "a") {
      // Disallow nested <a>
      if (stack.some((s) => s.node?.tag === "a")) {
        if (strict) throw validation("UNSAFE_ARTICLE_HTML", "Nested <a> links are not permitted.");
        continue;
      }
      const rawHref = parsedAttrs.get("href") ?? "";
      const safeHref = validateSafeArticleHref(rawHref);
      if (!safeHref) {
        if (strict) {
          throw validation(
            "UNSAFE_ARTICLE_URL",
            "Links must use https://, mailto:, #anchor, or a relative /path.",
          );
        }
        continue;
      }
      elemAttrs.href = safeHref.href;
      elemAttrs.external = safeHref.external;
    } else if (canonical === "img") {
      const rawSrc = parsedAttrs.get("src") ?? "";
      const safeSrc = validateSafeArticleImgSrc(rawSrc);
      if (!safeSrc) {
        if (strict) {
          throw validation("UNSAFE_ARTICLE_IMAGE", "Images must use an https:// URL.");
        }
        continue;
      }
      const rawAlt = decodeEntities(parsedAttrs.get("alt") ?? "").trim().slice(0, MAX_ALT_LENGTH);
      elemAttrs.src = safeSrc;
      elemAttrs.alt = rawAlt || "Article illustration";
    }

    nodeCount += 1;
    if (nodeCount > MAX_AST_NODES) {
      if (strict) throw validation("ARTICLE_HTML_TOO_COMPLEX", "Article HTML exceeds maximum element count.");
      break;
    }

    const elem: RawAstElement = {
      kind: "element",
      tag: canonical,
      attrs: elemAttrs,
      children: [],
    };
    currentChildren().push(elem);

    if (!selfClosing && !VOID_TAGS.has(canonical)) {
      if (stack.length >= MAX_AST_DEPTH) {
        if (strict) throw validation("ARTICLE_HTML_TOO_COMPLEX", "Article HTML nesting is too deep.");
        continue;
      }
      stack.push({ wrapper: false, node: elem, rawTag });
    }
  }

  return rootChildren;
}

function extractNodeText(nodes: readonly RawAstNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") {
      out += n.text;
    } else if (n.tag === "br") {
      out += "\n";
    } else {
      const inner = extractNodeText(n.children);
      const isBlock =
        n.tag === "p" ||
        n.tag === "h2" ||
        n.tag === "h3" ||
        n.tag === "h4" ||
        n.tag === "li" ||
        n.tag === "blockquote" ||
        n.tag === "pre" ||
        n.tag === "tr";
      out += isBlock ? `${inner.trim()}\n\n` : inner;
    }
  }
  return out;
}

function slugifyHeading(text: string, used: Set<string>): string {
  const base =
    text
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/[\s-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "section";
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

function toInlineNodes(nodes: readonly RawAstNode[]): KnowledgeInlineNode[] {
  const out: KnowledgeInlineNode[] = [];
  const pushText = (txt: string) => {
    if (!txt) return;
    const prev = out[out.length - 1];
    if (prev && prev.kind === "text") {
      prev.text += txt;
    } else {
      out.push({ kind: "text", text: txt });
    }
  };

  for (const node of nodes) {
    if (node.kind === "text") {
      pushText(node.text);
      continue;
    }
    switch (node.tag) {
      case "br":
        out.push({ kind: "br" });
        break;
      case "strong":
        out.push({ kind: "strong", children: toInlineNodes(node.children) });
        break;
      case "em":
        out.push({ kind: "em", children: toInlineNodes(node.children) });
        break;
      case "code":
        out.push({ kind: "code", text: extractNodeText(node.children) });
        break;
      case "a":
        if (node.attrs.href) {
          out.push({
            kind: "link",
            href: node.attrs.href,
            external: Boolean(node.attrs.external),
            children: toInlineNodes(node.children),
          });
        } else {
          out.push(...toInlineNodes(node.children));
        }
        break;
      default:
        out.push(...toInlineNodes(node.children));
        break;
    }
  }
  return out;
}

function toListItems(listChildren: readonly RawAstNode[]): KnowledgeListItemNode[] {
  const items: KnowledgeListItemNode[] = [];
  for (const child of listChildren) {
    if (child.kind === "element" && child.tag === "li") {
      const inlineSource: RawAstNode[] = [];
      const sublists: Array<{ ordered: boolean; items: KnowledgeListItemNode[] }> = [];
      for (const liChild of child.children) {
        if (liChild.kind === "element" && (liChild.tag === "ul" || liChild.tag === "ol")) {
          sublists.push({
            ordered: liChild.tag === "ol",
            items: toListItems(liChild.children),
          });
        } else {
          inlineSource.push(liChild);
        }
      }
      items.push({
        inlines: toInlineNodes(inlineSource),
        ...(sublists.length > 0 ? { sublists } : {}),
      });
    }
  }
  return items;
}

function toTableBlock(tableElem: RawAstElement): Extract<KnowledgeRichBlock, { kind: "table" }> | null {
  const headers: KnowledgeInlineNode[][] = [];
  const rows: KnowledgeInlineNode[][][] = [];

  const collectRow = (tr: RawAstElement, forceHeader: boolean) => {
    const cells: KnowledgeInlineNode[][] = [];
    let allHeader = forceHeader;
    let sawCell = false;
    for (const c of tr.children) {
      if (c.kind === "element" && (c.tag === "th" || c.tag === "td")) {
        sawCell = true;
        if (c.tag === "td") allHeader = false;
        if (c.tag === "th" && !forceHeader && cells.length === 0) {
          allHeader = true;
        }
        cells.push(toInlineNodes(c.children));
      }
    }
    if (!sawCell) return;
    if (allHeader && headers.length === 0 && rows.length === 0) {
      headers.push(...cells);
    } else {
      rows.push(cells);
    }
  };

  for (const child of tableElem.children) {
    if (child.kind !== "element") continue;
    if (child.tag === "thead") {
      for (const tr of child.children) {
        if (tr.kind === "element" && tr.tag === "tr") collectRow(tr, true);
      }
    } else if (child.tag === "tbody") {
      for (const tr of child.children) {
        if (tr.kind === "element" && tr.tag === "tr") collectRow(tr, false);
      }
    } else if (child.tag === "tr") {
      collectRow(child, false);
    }
  }

  if (headers.length === 0 && rows.length === 0) return null;
  return { kind: "table", headers, rows };
}

function serializeInlinesToHtml(inlines: readonly KnowledgeInlineNode[]): string {
  let out = "";
  for (const node of inlines) {
    switch (node.kind) {
      case "text":
        out += escapeHtml(node.text);
        break;
      case "br":
        out += "<br>";
        break;
      case "strong":
        out += `<strong>${serializeInlinesToHtml(node.children)}</strong>`;
        break;
      case "em":
        out += `<em>${serializeInlinesToHtml(node.children)}</em>`;
        break;
      case "code":
        out += `<code>${escapeHtml(node.text)}</code>`;
        break;
      case "link": {
        const rel = node.external ? ' rel="noopener noreferrer"' : "";
        out += `<a href="${escapeHtml(node.href)}"${rel}>${serializeInlinesToHtml(node.children)}</a>`;
        break;
      }
    }
  }
  return out;
}

function serializeListToHtml(ordered: boolean, items: readonly KnowledgeListItemNode[]): string {
  const tag = ordered ? "ol" : "ul";
  const body = items
    .map((item) => {
      const sub = (item.sublists ?? [])
        .map((s) => serializeListToHtml(s.ordered, s.items))
        .join("");
      return `<li>${serializeInlinesToHtml(item.inlines)}${sub}</li>`;
    })
    .join("");
  return `<${tag}>${body}</${tag}>`;
}

function serializeBlocksToHtml(blocks: readonly KnowledgeRichBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "heading":
        parts.push(`<h${b.level} id="${escapeHtml(b.id)}">${serializeInlinesToHtml(b.children)}</h${b.level}>`);
        break;
      case "paragraph":
        parts.push(`<p>${serializeInlinesToHtml(b.children)}</p>`);
        break;
      case "list":
        parts.push(serializeListToHtml(b.ordered, b.items));
        break;
      case "blockquote":
        parts.push(`<blockquote>${serializeInlinesToHtml(b.children)}</blockquote>`);
        break;
      case "code_block":
        parts.push(`<pre><code>${escapeHtml(b.code)}</code></pre>`);
        break;
      case "hr":
        parts.push("<hr>");
        break;
      case "image":
        parts.push(`<img src="${escapeHtml(b.src)}" alt="${escapeHtml(b.alt)}">`);
        break;
      case "table": {
        const thead =
          b.headers.length > 0
            ? `<thead><tr>${b.headers.map((h) => `<th>${serializeInlinesToHtml(h)}</th>`).join("")}</tr></thead>`
            : "";
        const tbody =
          b.rows.length > 0
            ? `<tbody>${b.rows
                .map((r) => `<tr>${r.map((c) => `<td>${serializeInlinesToHtml(c)}</td>`).join("")}</tr>`)
                .join("")}</tbody>`
            : "";
        parts.push(`<table>${thead}${tbody}</table>`);
        break;
      }
    }
  }
  return parts.join("");
}

function projectBlocksAndToc(roots: readonly RawAstNode[]): {
  blocks: KnowledgeRichBlock[];
  toc: KnowledgeTocEntry[];
} {
  const blocks: KnowledgeRichBlock[] = [];
  const toc: KnowledgeTocEntry[] = [];
  const usedIds = new Set<string>();
  let pendingInlines: RawAstNode[] = [];

  const flushPendingParagraph = () => {
    if (pendingInlines.length === 0) return;
    const textCheck = extractNodeText(pendingInlines).trim();
    if (textCheck.length > 0) {
      blocks.push({ kind: "paragraph", children: toInlineNodes(pendingInlines) });
    }
    pendingInlines = [];
  };

  const visitNodes = (nodes: readonly RawAstNode[]) => {
    for (const node of nodes) {
      if (node.kind === "text") {
        if (node.text.trim().length > 0 || pendingInlines.length > 0) {
          pendingInlines.push(node);
        }
        continue;
      }

      switch (node.tag) {
        case "h2":
        case "h3":
        case "h4": {
          flushPendingParagraph();
          const level = node.tag === "h2" ? 2 : node.tag === "h3" ? 3 : 4;
          const headingText = extractNodeText(node.children).replace(/\s+/g, " ").trim();
          if (headingText.length > 0) {
            const id = slugifyHeading(headingText, usedIds);
            blocks.push({
              kind: "heading",
              level,
              id,
              text: headingText,
              children: toInlineNodes(node.children),
            });
            toc.push({ id, level, text: headingText });
          }
          break;
        }
        case "p": {
          flushPendingParagraph();
          // Extract standalone images inside <p> cleanly
          const pInlines: RawAstNode[] = [];
          for (const child of node.children) {
            if (child.kind === "element" && child.tag === "img" && child.attrs.src) {
              if (extractNodeText(pInlines).trim().length > 0) {
                blocks.push({ kind: "paragraph", children: toInlineNodes(pInlines) });
              }
              pInlines.length = 0;
              blocks.push({
                kind: "image",
                src: child.attrs.src,
                alt: child.attrs.alt ?? "Article illustration",
              });
            } else {
              pInlines.push(child);
            }
          }
          if (extractNodeText(pInlines).trim().length > 0) {
            blocks.push({ kind: "paragraph", children: toInlineNodes(pInlines) });
          }
          break;
        }
        case "ul":
        case "ol": {
          flushPendingParagraph();
          const items = toListItems(node.children);
          if (items.length > 0) {
            blocks.push({ kind: "list", ordered: node.tag === "ol", items });
          }
          break;
        }
        case "blockquote": {
          flushPendingParagraph();
          const txt = extractNodeText(node.children).trim();
          if (txt.length > 0) {
            blocks.push({ kind: "blockquote", children: toInlineNodes(node.children) });
          }
          break;
        }
        case "pre": {
          flushPendingParagraph();
          const code = extractNodeText(node.children).replace(/^\n+|\n+$/g, "");
          if (code.length > 0) {
            blocks.push({ kind: "code_block", code });
          }
          break;
        }
        case "hr": {
          flushPendingParagraph();
          blocks.push({ kind: "hr" });
          break;
        }
        case "img": {
          flushPendingParagraph();
          if (node.attrs.src) {
            blocks.push({
              kind: "image",
              src: node.attrs.src,
              alt: node.attrs.alt ?? "Article illustration",
            });
          }
          break;
        }
        case "table": {
          flushPendingParagraph();
          const tbl = toTableBlock(node);
          if (tbl) blocks.push(tbl);
          break;
        }
        default: {
          pendingInlines.push(node);
          break;
        }
      }
    }
  };

  visitNodes(roots);
  flushPendingParagraph();
  return { blocks, toc };
}

/**
 * Strictly validates and sanitises an article HTML body on write, returning canonical HTML,
 * normalized plain text for search, structured `KnowledgeRichBlock[]`, and `KnowledgeTocEntry[]`.
 */
export function sanitizeKnowledgeHtmlOnWrite(rawHtml: string): {
  html: string;
  plainText: string;
  blocks: KnowledgeRichBlock[];
  toc: KnowledgeTocEntry[];
} {
  const trimmed = rawHtml.trim();
  if (!trimmed) {
    throw validation("EMPTY_ARTICLE_BODY", "Article body cannot be empty.");
  }
  const ast = parseSanitizedRawAst(trimmed, true);
  const { blocks, toc } = projectBlocksAndToc(ast);
  const plainText = extractNodeText(ast)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (blocks.length === 0 || !plainText) {
    throw validation("EMPTY_ARTICLE_BODY", "Article body must contain readable text.");
  }

  const html = serializeBlocksToHtml(blocks);
  if (Buffer.byteLength(html, "utf8") > MAX_ARTICLE_HTML_BYTES) {
    throw validation("ARTICLE_HTML_TOO_LARGE", "Sanitised article HTML exceeds 128 KB.");
  }

  return { html, plainText, blocks, toc };
}

/**
 * Projects stored sanitised HTML into `KnowledgeRichBlock[]` + `KnowledgeTocEntry[]` on read/preview
 * without throwing on legacy/partial drafts.
 */
export function projectKnowledgeHtmlToBlocks(storedHtml: string): {
  blocks: KnowledgeRichBlock[];
  toc: KnowledgeTocEntry[];
} {
  if (!storedHtml) return { blocks: [], toc: [] };
  const ast = parseSanitizedRawAst(storedHtml, false);
  return projectBlocksAndToc(ast);
}
