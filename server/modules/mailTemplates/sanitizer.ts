/**
 * Mail Templates — deterministic HTML allow-list sanitizer, inert preview projection,
 * plain-text derivation, and logic-less `{{variable}}` renderer (Package D).
 *
 * Security invariants (ADR 0025, Contract §2.D, §4, §4.1):
 *  1. Zero third-party HTML parser dependencies and zero pass-through markup: input HTML is
 *     tokenized into a bounded AST of compile-time literal tag names and text nodes, then
 *     re-serialized from scratch with every text character and attribute value escaped.
 *  2. Opaque dangerous subtrees (`script`, `style`, `svg`, `math`, `iframe`, `form`, `meta`,
 *     `base`, `link`, `object`, `embed`, etc.) are dropped in full (tag + body).
 *  3. Delivery HTML allow-list accepts the RichTextEditor subset (`p, h2, h3, strong, em, ul,
 *     ol, li, br, hr, a[href], a[href][data-rp-button="primary"], img[src][alt]`) plus standard
 *     semantic headings/tables/code (`h1, h4, blockquote, pre, code, table, thead, tbody, tr,
 *     th, td`). Links require `https:`, `mailto:` or an exact `{{varName}}` placeholder; images
 *     require `https:` `src` and non-empty `alt`.
 *  4. Placeholders are strictly typed (`{{[a-zA-Z][a-zA-Z0-9_]{0,63}}}`) and allowed ONLY in
 *     text nodes and as the entire `a[href]` attribute value. Any malformed `{{...}}` or any
 *     placeholder in a disallowed tag/attribute/comment/URL prefix is rejected on save & preview.
 *  5. Inert preview projection (`projectInertMailPreviewHtml`) emits semantic text structure
 *     ONLY — zero `<a>`, zero `<img>`, zero `href`/`src`/`srcset`/`style`/`class`/`id`/`data-*`,
 *     zero `<meta>`/`<base>`/`<form>`/SVG/MathML — safe for `<InertMailPreview>` (`sandbox=""`).
 *  6. Subjects and addresses reject control characters (`HEADER_CONTROL_RE`); variables substituted
 *     into HTML text are always HTML-escaped, and `[REDACTED]` link values render as inert text
 *     so redacted audit/retained copies render cleanly.
 */
import { createHash } from "node:crypto";
import { validation } from "../../core/errors.js";

export const VAR_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
export const EXACT_VAR_PLACEHOLDER_RE = /^\{\{([a-zA-Z][a-zA-Z0-9_]{0,63})\}\}$/;
export const HEADER_CONTROL_RE = /[\p{Cc}\u2028\u2029]/u;

export const MAX_SUBJECT_LENGTH = 255;
export const MAX_TEXT_BODY_LENGTH = 65_536;
export const MAX_HTML_INPUT_BYTES = 128 * 1024;
export const MAX_RENDERED_HTML_BYTES = 512 * 1024;
const MAX_AST_DEPTH = 16;
const MAX_AST_NODES = 2_500;
const MAX_URL_LENGTH = 2_048;
const MAX_ALT_LENGTH = 240;
export const REDACTED_MARKER = "[REDACTED]";

export const ALLOWED_DELIVERY_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "strong",
  "em",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "br",
  "hr",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "span",
] as const;

type AllowedTag = (typeof ALLOWED_DELIVERY_TAGS)[number];

const ALLOWED_TAG_MAP: Readonly<Record<string, AllowedTag>> = {
  p: "p",
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  strong: "strong",
  b: "strong",
  em: "em",
  i: "em",
  ul: "ul",
  ol: "ol",
  li: "li",
  blockquote: "blockquote",
  pre: "pre",
  code: "code",
  br: "br",
  hr: "hr",
  a: "a",
  img: "img",
  table: "table",
  thead: "thead",
  tbody: "tbody",
  tr: "tr",
  th: "th",
  td: "td",
  span: "span",
};

const VOID_TAGS = new Set<string>(["br", "hr", "img", "input", "meta", "base", "link", "source", "track", "area", "col", "wbr", "param", "embed"]);

/** Tags whose entire content up to the matching end tag must be dropped (never unwrapped as text). */
const OPAQUE_DROP_TAGS = new Set<string>([
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
  "option",
  "optgroup",
  "meta",
  "base",
  "link",
  "head",
  "title",
  "template",
  "noscript",
  "audio",
  "video",
  "source",
  "track",
  "canvas",
  "map",
  "area",
  "portal",
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  copy: "\u00a9",
  reg: "\u00ae",
};

type AstNode =
  | { kind: "text"; text: string }
  | {
      kind: "element";
      tag: AllowedTag;
      attrs: {
        href?: { kind: "url"; url: string } | { kind: "var"; varName: string };
        buttonPrimary?: boolean;
        src?: string;
        alt?: string;
        scope?: "col" | "row";
        colspan?: number;
        rowspan?: number;
      };
      children: AstNode[];
    };

export function escapeHtmlText(value: string): string {
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
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

function decodeHtmlEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,12});/g, (full, body: string) => {
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
    const replacement = NAMED_ENTITIES[body.toLowerCase()];
    return replacement ?? full;
  });
}

function hasAnyCurlyBraces(value: string): boolean {
  return value.includes("{{") || value.includes("}}");
}

/**
 * Validates all `{{...}}` placeholders in a plain-text or text-node segment and returns the
 * ordered unique variable names referenced. Any malformed `{{...}}`, triple brace, expression,
 * or unmatched `{{` / `}}` throws `VALIDATION_ERROR`.
 */
export function extractTextPlaceholders(input: string): string[] {
  const found: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const open = input.indexOf("{{", cursor);
    const strayClose = input.indexOf("}}", cursor);
    if (strayClose !== -1 && (open === -1 || strayClose < open)) {
      throw validation("INVALID_TEMPLATE_PLACEHOLDER", "Unmatched '}}' in template content.");
    }
    if (open === -1) break;
    if (input[open + 2] === "{") {
      throw validation("INVALID_TEMPLATE_PLACEHOLDER", "Triple-brace unescaped placeholders are not allowed.");
    }
    const close = input.indexOf("}}", open + 2);
    if (close === -1) {
      throw validation("INVALID_TEMPLATE_PLACEHOLDER", "Unclosed '{{' placeholder in template content.");
    }
    if (input[close + 2] === "}") {
      throw validation("INVALID_TEMPLATE_PLACEHOLDER", "Triple-brace unescaped placeholders are not allowed.");
    }
    const varName = input.slice(open + 2, close);
    if (!VAR_NAME_RE.test(varName)) {
      throw validation(
        "INVALID_TEMPLATE_PLACEHOLDER",
        "Placeholders must be simple variable names such as {{reference}}.",
      );
    }
    if (!found.includes(varName)) found.push(varName);
    cursor = close + 2;
  }
  return found;
}

export function substitutePlainText(
  template: string,
  vars: Readonly<Record<string, string | number | boolean>>,
  declaredVars?: ReadonlySet<string>,
): string {
  extractTextPlaceholders(template);
  return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]{0,63})\}\}/g, (_match, name: string) => {
    if (declaredVars && !declaredVars.has(name)) {
      throw validation("UNDECLARED_TEMPLATE_VARIABLE", `Template references undeclared variable {{${name}}}.`);
    }
    const raw = vars[name];
    if (raw === undefined || raw === null) return "";
    const str = String(raw);
    if (str.includes("\0")) {
      throw validation("INVALID_MAIL_RENDER", "Template variable contains disallowed null bytes.");
    }
    return str;
  });
}

/**
 * Validates and canonicalizes an allowed link URL (`https:` or `mailto:`) or image URL (`https:` only).
 * Optionally resolves a safe portal-relative path (`/orders/...`) against an `https:` `canonicalOrigin`.
 */
export function parseAllowedTemplateUrl(
  rawUrl: string,
  options: { allowMailto: boolean; canonicalOrigin?: string },
): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH || HEADER_CONTROL_RE.test(trimmed) || /\s/u.test(trimmed)) {
    return null;
  }
  let candidate = trimmed;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && options.canonicalOrigin) {
    try {
      const origin = new URL(options.canonicalOrigin);
      if (origin.protocol === "https:" && !origin.username && !origin.password) {
        candidate = `${origin.origin}${trimmed}`;
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === "https:") {
      if (!parsed.hostname) return null;
      return parsed.toString();
    }
    if (options.allowMailto && parsed.protocol === "mailto:") {
      // Reject query headers on mailto: (e.g. ?subject=...&body=... header/body injection) — address only.
      if (parsed.search || parsed.hash || !parsed.pathname || HEADER_CONTROL_RE.test(parsed.pathname)) {
        return null;
      }
      return `mailto:${parsed.pathname}`;
    }
    return null;
  } catch {
    return null;
  }
}

interface ParseOptions {
  /**
   * `strict`: used on save, publish, preview, and render of authored templates — rejects unsafe
   * URLs, missing image `alt`, malformed placeholders, or placeholders outside safe sinks.
   * `lenient_preview`: used by `projectInertMailPreviewHtml` so arbitrary stored HTML can be
   * projected safely without throwing while stripping all navigation/network/presentational attrs.
   */
  mode: "strict" | "lenient_preview";
  allowPlaceholders: boolean;
  declaredVars?: ReadonlySet<string>;
}

function parseAttributes(
  rawAttrs: string,
  strictPlaceholders: boolean,
): Array<{ name: string; value: string }> {
  const attrs: Array<{ name: string; value: string }> = [];
  let i = 0;
  const len = rawAttrs.length;
  while (i < len) {
    while (i < len && /\s/.test(rawAttrs[i]!)) i++;
    if (i >= len || rawAttrs[i] === "/") break;
    const nameStart = i;
    while (i < len && !/[\s=/>"']/.test(rawAttrs[i]!)) i++;
    const rawName = rawAttrs.slice(nameStart, i);
    if (!rawName) {
      i++;
      continue;
    }
    if (strictPlaceholders && hasAnyCurlyBraces(rawName)) {
      throw validation("UNSAFE_PLACEHOLDER_CONTEXT", "Placeholders are not allowed in HTML attribute names.");
    }
    const name = rawName.toLowerCase();
    while (i < len && /\s/.test(rawAttrs[i]!)) i++;
    let value = "";
    if (i < len && rawAttrs[i] === "=") {
      i++;
      while (i < len && /\s/.test(rawAttrs[i]!)) i++;
      if (i < len && (rawAttrs[i] === '"' || rawAttrs[i] === "'")) {
        const quote = rawAttrs[i]!;
        i++;
        const valStart = i;
        while (i < len && rawAttrs[i] !== quote) i++;
        value = decodeHtmlEntities(rawAttrs.slice(valStart, i));
        if (i < len && rawAttrs[i] === quote) i++;
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(rawAttrs[i]!)) i++;
        value = decodeHtmlEntities(rawAttrs.slice(valStart, i));
      }
    }
    attrs.push({ name, value });
  }
  return attrs;
}

interface ParsedHtmlResult {
  roots: AstNode[];
  referencedVars: string[];
  hrefVars: string[];
}

function parseHtmlToAst(rawHtml: string, options: ParseOptions): ParsedHtmlResult {
  if (rawHtml.includes("\0")) {
    throw validation("INVALID_HTML_INPUT", "HTML template cannot contain null bytes.");
  }
  if (Buffer.byteLength(rawHtml, "utf8") > MAX_HTML_INPUT_BYTES) {
    throw validation("HTML_TEMPLATE_TOO_LARGE", "HTML template exceeds maximum size of 128 KB.");
  }

  const normalizedInput = rawHtml.normalize("NFC").replace(/\r\n?/g, "\n");
  const rootChildren: AstNode[] = [];
  const stack: Array<{ rawTag: string; node: Extract<AstNode, { kind: "element" }> | null }> = [];
  const referencedVars: string[] = [];
  const hrefVars: string[] = [];
  let nodeCount = 0;

  const recordVar = (name: string, isHref = false) => {
    if (options.declaredVars && !options.declaredVars.has(name)) {
      throw validation("UNDECLARED_TEMPLATE_VARIABLE", `Template references undeclared variable {{${name}}}.`);
    }
    if (!referencedVars.includes(name)) referencedVars.push(name);
    if (isHref && !hrefVars.includes(name)) hrefVars.push(name);
  };

  const currentTarget = (): AstNode[] => {
    for (let idx = stack.length - 1; idx >= 0; idx--) {
      const entry = stack[idx]!;
      if (entry.node) return entry.node.children;
    }
    return rootChildren;
  };

  const appendText = (rawSegment: string) => {
    if (!rawSegment) return;
    const decoded = decodeHtmlEntities(rawSegment);
    if (!decoded) return;
    if (options.mode === "strict") {
      if (options.allowPlaceholders) {
        for (const v of extractTextPlaceholders(decoded)) recordVar(v, false);
      } else if (hasAnyCurlyBraces(decoded)) {
        // After substitution, literal braces in user values are allowed (they are escaped as text).
      }
    }
    const target = currentTarget();
    const prev = target[target.length - 1];
    if (prev && prev.kind === "text") {
      prev.text += decoded;
    } else {
      nodeCount++;
      if (nodeCount > MAX_AST_NODES) {
        throw validation("HTML_TEMPLATE_TOO_COMPLEX", "HTML template contains too many elements.");
      }
      target.push({ kind: "text", text: decoded });
    }
  };

  let i = 0;
  const len = normalizedInput.length;

  while (i < len) {
    const lt = normalizedInput.indexOf("<", i);
    if (lt === -1) {
      appendText(normalizedInput.slice(i));
      break;
    }
    if (lt > i) {
      appendText(normalizedInput.slice(i, lt));
    }

    // Comments: <!-- ... -->
    if (normalizedInput.startsWith("<!--", lt)) {
      const endComment = normalizedInput.indexOf("-->", lt + 4);
      const commentBody = endComment === -1 ? normalizedInput.slice(lt + 4) : normalizedInput.slice(lt + 4, endComment);
      if (options.mode === "strict" && hasAnyCurlyBraces(commentBody)) {
        throw validation("UNSAFE_PLACEHOLDER_CONTEXT", "Placeholders are not allowed inside HTML comments.");
      }
      i = endComment === -1 ? len : endComment + 3;
      continue;
    }

    // Declarations / CDATA / processing instructions: <!DOCTYPE ...>, <![CDATA[...]]>, <?...?>
    if (normalizedInput[lt + 1] === "!" || normalizedInput[lt + 1] === "?") {
      const gt = normalizedInput.indexOf(">", lt + 2);
      const declBody = gt === -1 ? normalizedInput.slice(lt + 2) : normalizedInput.slice(lt + 2, gt);
      if (options.mode === "strict" && hasAnyCurlyBraces(declBody)) {
        throw validation("UNSAFE_PLACEHOLDER_CONTEXT", "Placeholders are not allowed inside HTML declarations.");
      }
      i = gt === -1 ? len : gt + 1;
      continue;
    }

    // Find closing `>` respecting quoted attribute values
    let gt = lt + 1;
    let quote: string | null = null;
    while (gt < len) {
      const ch = normalizedInput[gt]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      gt++;
    }

    if (gt >= len) {
      if (options.mode === "strict") {
        throw validation("INVALID_HTML_INPUT", "Malformed unclosed HTML tag in template.");
      }
      appendText(normalizedInput.slice(lt));
      break;
    }

    const insideTag = normalizedInput.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (!insideTag) continue;

    // Closing tag: </tag>
    if (insideTag.startsWith("/")) {
      const closeName = insideTag.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (options.mode === "strict" && hasAnyCurlyBraces(insideTag)) {
        throw validation("UNSAFE_PLACEHOLDER_CONTEXT", "Placeholders are not allowed in closing tags.");
      }
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s]!.rawTag === closeName) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    const selfClosing = insideTag.endsWith("/");
    const withoutSlash = selfClosing ? insideTag.slice(0, -1).trim() : insideTag;
    const spaceIdx = withoutSlash.search(/\s/);
    const rawTagName = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).toLowerCase();
    const rawAttrPart = spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1);

    if (!/^[a-z][a-z0-9:-]{0,31}$/.test(rawTagName)) {
      if (options.mode === "strict") {
        throw validation("INVALID_HTML_INPUT", "Invalid HTML tag name in template.");
      }
      continue;
    }

    // Drop entire opaque dangerous subtrees (`script`, `style`, `svg`, `math`, `iframe`, `form`, `meta`, `base`, etc.)
    if (OPAQUE_DROP_TAGS.has(rawTagName)) {
      if (options.mode === "strict") {
        throw validation(
          "DISALLOWED_HTML_ELEMENT",
          `HTML element <${rawTagName}> is not permitted in mail templates.`,
        );
      }
      if (!selfClosing && !VOID_TAGS.has(rawTagName)) {
        const closeRe = new RegExp(`</\\s*${rawTagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^>]*>`, "i");
        const rest = normalizedInput.slice(i);
        const match = closeRe.exec(rest);
        i = match ? i + match.index + match[0].length : len;
      }
      continue;
    }

    const parsedAttrs = parseAttributes(rawAttrPart, options.mode === "strict" && options.allowPlaceholders);
    const mappedTag = ALLOWED_TAG_MAP[rawTagName];

    // Neutral structural wrappers (`html`, `body`, `div`, `section`, `article`, `main`, `header`, `footer`)
    if (!mappedTag) {
      if (options.mode === "strict") {
        for (const attr of parsedAttrs) {
          if (hasAnyCurlyBraces(attr.value)) {
            throw validation(
              "UNSAFE_PLACEHOLDER_CONTEXT",
              "Placeholders are only permitted in text or exact link href attributes.",
            );
          }
        }
        const neutralContainers = new Set(["html", "body", "div", "section", "article", "main", "header", "footer"]);
        if (!neutralContainers.has(rawTagName)) {
          throw validation("DISALLOWED_HTML_ELEMENT", `HTML element <${rawTagName}> is not permitted in mail templates.`);
        }
      }
      if (!selfClosing && !VOID_TAGS.has(rawTagName)) {
        if (stack.length >= MAX_AST_DEPTH) {
          throw validation("HTML_TEMPLATE_TOO_COMPLEX", "HTML template nesting exceeds maximum depth.");
        }
        stack.push({ rawTag: rawTagName, node: null });
      }
      continue;
    }

    // Build sanitized attributes for `mappedTag`
    const cleanAttrs: Extract<AstNode, { kind: "element" }>["attrs"] = {};

    for (const attr of parsedAttrs) {
      if (mappedTag === "a" && attr.name === "href") {
        const trimmedHref = attr.value.trim();
        const varMatch = options.allowPlaceholders ? EXACT_VAR_PLACEHOLDER_RE.exec(trimmedHref) : null;
        if (varMatch) {
          const varName = varMatch[1]!;
          recordVar(varName, true);
          cleanAttrs.href = { kind: "var", varName };
        } else {
          if (options.mode === "strict" && hasAnyCurlyBraces(trimmedHref)) {
            throw validation(
              "UNSAFE_PLACEHOLDER_CONTEXT",
              "Link href placeholders must be an exact standalone {{variable}} value.",
            );
          }
          const safeUrl = parseAllowedTemplateUrl(trimmedHref, { allowMailto: true });
          if (!safeUrl) {
            if (options.mode === "strict") {
              throw validation(
                "UNSAFE_TEMPLATE_URL",
                "Template links must use https: or mailto: (or an exact {{variable}} placeholder).",
              );
            }
          } else {
            cleanAttrs.href = { kind: "url", url: safeUrl };
          }
        }
        continue;
      }

      if (mappedTag === "a" && attr.name === "data-rp-button") {
        if (options.mode === "strict" && hasAnyCurlyBraces(attr.value)) {
          throw validation("UNSAFE_PLACEHOLDER_CONTEXT", "Placeholders are not allowed in data-rp-button.");
        }
        if (attr.value === "primary") {
          cleanAttrs.buttonPrimary = true;
        }
        continue;
      }

      if (mappedTag === "img" && attr.name === "src") {
        if (options.mode === "strict" && hasAnyCurlyBraces(attr.value)) {
          throw validation("UNSAFE_PLACEHOLDER_CONTEXT", "Image src must be a static https: URL, not a placeholder.");
        }
        const safeSrc = parseAllowedTemplateUrl(attr.value, { allowMailto: false });
        if (!safeSrc) {
          if (options.mode === "strict") {
            throw validation("UNSAFE_TEMPLATE_URL", "Template images must use https: URLs.");
          }
        } else {
          cleanAttrs.src = safeSrc;
        }
        continue;
      }

      if (mappedTag === "img" && attr.name === "alt") {
        if (options.mode === "strict" && hasAnyCurlyBraces(attr.value)) {
          throw validation("UNSAFE_PLACEHOLDER_CONTEXT", "Placeholders are not allowed in image alt attributes.");
        }
        const normalizedAlt = attr.value.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim().slice(0, MAX_ALT_LENGTH);
        cleanAttrs.alt = normalizedAlt;
        continue;
      }

      if (mappedTag === "th" && attr.name === "scope" && (attr.value === "col" || attr.value === "row")) {
        cleanAttrs.scope = attr.value;
        continue;
      }

      if ((mappedTag === "th" || mappedTag === "td") && (attr.name === "colspan" || attr.name === "rowspan")) {
        const parsedInt = Number.parseInt(attr.value, 10);
        if (Number.isInteger(parsedInt) && parsedInt >= 1 && parsedInt <= 12) {
          cleanAttrs[attr.name] = parsedInt;
        }
        continue;
      }

      // Any other attribute is dropped — UNLESS in strict mode it contains a placeholder!
      if (options.mode === "strict" && hasAnyCurlyBraces(attr.value)) {
        throw validation(
          "UNSAFE_PLACEHOLDER_CONTEXT",
          `Placeholders are not permitted inside disallowed attribute "${attr.name}".`,
        );
      }
    }

    if (mappedTag === "a" && !cleanAttrs.href) {
      if (options.mode === "strict") {
        throw validation("UNSAFE_TEMPLATE_URL", "Every link in a mail template requires an https:, mailto:, or {{variable}} href.");
      }
      // In lenient preview mode, unwrap headless `<a>` into its children
      if (!selfClosing) {
        stack.push({ rawTag: rawTagName, node: null });
      }
      continue;
    }

    if (mappedTag === "img") {
      if (options.mode === "strict") {
        if (!cleanAttrs.src) {
          throw validation("UNSAFE_TEMPLATE_URL", "Every image in a mail template requires an https: src.");
        }
        if (!cleanAttrs.alt) {
          throw validation("IMAGE_ALT_REQUIRED", "Every image in a mail template must include descriptive alt text.");
        }
      }
    }

    nodeCount++;
    if (nodeCount > MAX_AST_NODES) {
      throw validation("HTML_TEMPLATE_TOO_COMPLEX", "HTML template contains too many elements.");
    }

    const elemNode: Extract<AstNode, { kind: "element" }> = {
      kind: "element",
      tag: mappedTag,
      attrs: cleanAttrs,
      children: [],
    };
    currentTarget().push(elemNode);

    if (!selfClosing && !VOID_TAGS.has(mappedTag)) {
      if (stack.length >= MAX_AST_DEPTH) {
        throw validation("HTML_TEMPLATE_TOO_COMPLEX", "HTML template nesting exceeds maximum depth.");
      }
      stack.push({ rawTag: rawTagName, node: elemNode });
    }
  }

  return { roots: rootChildren, referencedVars, hrefVars };
}

function serializeDeliveryNodes(
  nodes: readonly AstNode[],
  substitutions?: {
    vars: Readonly<Record<string, string | number | boolean>>;
    canonicalOrigin?: string;
  },
): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      const rawText = substitutions ? substitutePlainText(node.text, substitutions.vars) : node.text;
      parts.push(escapeHtmlText(rawText));
      continue;
    }

    const { tag, attrs, children } = node;

    if (tag === "br") {
      parts.push("<br>");
      continue;
    }
    if (tag === "hr") {
      parts.push("<hr>");
      continue;
    }
    if (tag === "img") {
      if (!attrs.src) continue;
      parts.push(`<img src="${escapeHtmlText(attrs.src)}" alt="${escapeHtmlText(attrs.alt ?? "")}">`);
      continue;
    }

    if (tag === "a") {
      const inner = serializeDeliveryNodes(children, substitutions);
      if (!attrs.href) {
        parts.push(inner);
        continue;
      }
      let hrefOut: string;
      if (attrs.href.kind === "url") {
        hrefOut = attrs.href.url;
      } else if (substitutions) {
        const rawVal = substitutions.vars[attrs.href.varName];
        const strVal = rawVal === undefined || rawVal === null ? "" : String(rawVal).trim();
        if (strVal === REDACTED_MARKER) {
          // Redacted audit copy / stored content render: emit inert text span with no href
          parts.push(`<span>${inner} (${escapeHtmlText(REDACTED_MARKER)})</span>`);
          continue;
        }
        const validated = parseAllowedTemplateUrl(strVal, {
          allowMailto: true,
          canonicalOrigin: substitutions.canonicalOrigin,
        });
        if (!validated) {
          throw validation("INVALID_MAIL_RENDER", "Link variable did not resolve to an allowed https: or mailto: URL.");
        }
        hrefOut = validated;
      } else {
        hrefOut = `{{${attrs.href.varName}}}`;
      }

      const btnAttr = attrs.buttonPrimary ? ' data-rp-button="primary"' : "";
      parts.push(`<a href="${escapeHtmlText(hrefOut)}"${btnAttr} rel="noopener noreferrer">${inner}</a>`);
      continue;
    }

    let tableAttr = "";
    if (tag === "th" && attrs.scope) tableAttr += ` scope="${attrs.scope}"`;
    if ((tag === "th" || tag === "td") && attrs.colspan) tableAttr += ` colspan="${attrs.colspan}"`;
    if ((tag === "th" || tag === "td") && attrs.rowspan) tableAttr += ` rowspan="${attrs.rowspan}"`;

    parts.push(`<${tag}${tableAttr}>${serializeDeliveryNodes(children, substitutions)}</${tag}>`);
  }
  return parts.join("");
}

function serializeInertPreviewNodes(nodes: readonly AstNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      parts.push(escapeHtmlText(node.text));
      continue;
    }
    const { tag, attrs, children } = node;
    if (tag === "br") {
      parts.push("<br>");
      continue;
    }
    if (tag === "hr") {
      parts.push("<hr>");
      continue;
    }
    if (tag === "img") {
      const label = attrs.alt ? `[Image: ${attrs.alt}]` : "[Image]";
      parts.push(`<span><em>${escapeHtmlText(label)}</em></span>`);
      continue;
    }
    if (tag === "a") {
      const inner = serializeInertPreviewNodes(children);
      if (attrs.buttonPrimary) {
        parts.push(`<span><strong>${inner}</strong></span>`);
      } else {
        parts.push(`<span>${inner}</span>`);
      }
      continue;
    }
    let tableAttr = "";
    if (tag === "th" && attrs.scope) tableAttr += ` scope="${attrs.scope}"`;
    if ((tag === "th" || tag === "td") && attrs.colspan) tableAttr += ` colspan="${attrs.colspan}"`;
    if ((tag === "th" || tag === "td") && attrs.rowspan) tableAttr += ` rowspan="${attrs.rowspan}"`;

    parts.push(`<${tag}${tableAttr}>${serializeInertPreviewNodes(children)}</${tag}>`);
  }
  return parts.join("");
}

function astToPlainText(nodes: readonly AstNode[], listKind?: "ul" | "ol"): string {
  const chunks: string[] = [];
  let itemIndex = 0;
  for (const node of nodes) {
    if (node.kind === "text") {
      chunks.push(node.text);
      continue;
    }
    const { tag, attrs, children } = node;
    if (tag === "br") {
      chunks.push("\n");
      continue;
    }
    if (tag === "hr") {
      chunks.push("\n---\n");
      continue;
    }
    if (tag === "img") {
      if (attrs.alt) chunks.push(`[Image: ${attrs.alt}]`);
      continue;
    }
    if (tag === "a") {
      const inner = astToPlainText(children).trim();
      const target =
        attrs.href?.kind === "url"
          ? attrs.href.url
          : attrs.href?.kind === "var"
            ? `{{${attrs.href.varName}}}`
            : "";
      if (target && inner && inner !== target) {
        chunks.push(`${inner} (${target})`);
      } else {
        chunks.push(inner || target);
      }
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      chunks.push(`\n${astToPlainText(children, tag)}\n`);
      continue;
    }
    if (tag === "li") {
      itemIndex++;
      const prefix = listKind === "ol" ? `${itemIndex}. ` : "- ";
      chunks.push(`${prefix}${astToPlainText(children).trim()}\n`);
      continue;
    }
    const isBlock =
      tag === "p" ||
      tag === "h1" ||
      tag === "h2" ||
      tag === "h3" ||
      tag === "h4" ||
      tag === "blockquote" ||
      tag === "pre" ||
      tag === "tr";
    const inner = astToPlainText(children);
    chunks.push(isBlock ? `${inner.trim()}\n\n` : inner);
  }
  return chunks.join("");
}

/**
 * Server-side HTML allow-list sanitizer for template authoring & persistence.
 * Returns canonical HTML plus all referenced `{{variable}}` names.
 */
export function sanitizeTemplateHtmlOnSave(
  rawHtml: string,
  declaredVars?: ReadonlySet<string>,
): { html: string; derivedText: string; referencedVars: string[]; hrefVars: string[] } {
  const parsed = parseHtmlToAst(rawHtml, {
    mode: "strict",
    allowPlaceholders: true,
    declaredVars,
  });
  const html = serializeDeliveryNodes(parsed.roots);
  const derivedText = astToPlainText(parsed.roots)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!html || !derivedText) {
    throw validation("EMPTY_TEMPLATE_BODY", "Template body cannot be empty.");
  }
  return {
    html,
    derivedText,
    referencedVars: parsed.referencedVars,
    hrefVars: parsed.hrefVars,
  };
}

/**
 * Reusable server-side inert HTML preview projection (shared by Package D and Package B Jobs).
 *
 * Strictly emits allowlisted semantic text structure ONLY (`p, h1-h4, strong, em, ul, ol, li,
 * blockquote, pre, code, br, hr, span, table, thead, tbody, tr, th, td`). Removes 100% of
 * navigation, network, form, metadata, script, style, SVG/MathML, and presentational attributes
 * (`href`, `src`, `srcset`, `style`, `class`, `id`, `data-*`, `on*`).
 *
 * Safe to pass directly as the `html` prop of `<InertMailPreview>` (`sandbox=""`).
 */
export function projectInertMailPreviewHtml(rawOrRenderedHtml: string): string {
  if (!rawOrRenderedHtml || Buffer.byteLength(rawOrRenderedHtml, "utf8") > MAX_RENDERED_HTML_BYTES) {
    return "";
  }
  const cleaned = rawOrRenderedHtml.replace(/\0/g, "");
  const parsed = parseHtmlToAst(cleaned, {
    mode: "lenient_preview",
    allowPlaceholders: false,
  });
  return serializeInertPreviewNodes(parsed.roots);
}

export function validateSubjectTemplate(
  rawSubject: string,
  declaredVars?: ReadonlySet<string>,
): { subject: string; referencedVars: string[] } {
  const normalized = rawSubject.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > MAX_SUBJECT_LENGTH) {
    throw validation("INVALID_TEMPLATE_SUBJECT", "Subject must be between 1 and 255 characters.");
  }
  if (HEADER_CONTROL_RE.test(normalized)) {
    throw validation("INVALID_TEMPLATE_SUBJECT", "Subject cannot contain line breaks or control characters.");
  }
  // Reject HTML markup in subject templates so subjects stay crisp plain text
  if (/<[a-zA-Z!/]/.test(normalized)) {
    throw validation("INVALID_TEMPLATE_SUBJECT", "Subject must be plain text and cannot contain HTML tags.");
  }
  const referencedVars = extractTextPlaceholders(normalized);
  if (declaredVars) {
    for (const name of referencedVars) {
      if (!declaredVars.has(name)) {
        throw validation("UNDECLARED_TEMPLATE_VARIABLE", `Subject references undeclared variable {{${name}}}.`);
      }
    }
  }
  return { subject: normalized, referencedVars };
}

export function validateTextBodyTemplate(
  rawText: string,
  declaredVars?: ReadonlySet<string>,
): { text: string; referencedVars: string[] } {
  if (rawText.includes("\0")) {
    throw validation("INVALID_TEMPLATE_TEXT", "Plain-text body cannot contain null bytes.");
  }
  const normalized = rawText.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (normalized.length < 1 || normalized.length > MAX_TEXT_BODY_LENGTH) {
    throw validation("INVALID_TEMPLATE_TEXT", "Plain-text body must be between 1 and 65,536 characters.");
  }
  const referencedVars = extractTextPlaceholders(normalized);
  if (declaredVars) {
    for (const name of referencedVars) {
      if (!declaredVars.has(name)) {
        throw validation("UNDECLARED_TEMPLATE_VARIABLE", `Plain-text body references undeclared variable {{${name}}}.`);
      }
    }
  }
  return { text: normalized, referencedVars };
}

export function wrapDeliveryHtmlDocument(sanitizedBodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${sanitizedBodyHtml}</body></html>`;
}

export function plainTextToDeliveryHtml(renderedText: string): string {
  const paragraphs = renderedText
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtmlText(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return wrapDeliveryHtmlDocument(paragraphs || `<p>${escapeHtmlText(renderedText)}</p>`);
}

/**
 * Renders a validated template (`html` or `text`) with logic-less escaped `{{variable}}`
 * substitution AND repeats server-side HTML allow-list sanitization on the rendered HTML output.
 */
export function renderMailTemplateVersion(input: {
  format: "html" | "text";
  subjectTemplate: string;
  bodyHtmlTemplate: string | null;
  bodyTextTemplate: string;
  declaredVars: readonly string[];
  vars: Readonly<Record<string, string | number | boolean>>;
  canonicalOrigin?: string;
}): { subject: string; text: string; html: string; previewHtml?: string } {
  const allowedSet = new Set(input.declaredVars);
  for (const key of Object.keys(input.vars)) {
    if (!allowedSet.has(key)) {
      throw validation("INVALID_MAIL_INPUT", "Unexpected variable supplied to mail template.");
    }
  }

  const subject = substitutePlainText(input.subjectTemplate, input.vars, allowedSet).trim();
  if (subject.length < 1 || subject.length > MAX_SUBJECT_LENGTH || HEADER_CONTROL_RE.test(subject)) {
    throw validation("INVALID_MAIL_RENDER", "Rendered mail subject is empty, too long, or contains control characters.");
  }

  const text = substitutePlainText(input.bodyTextTemplate, input.vars, allowedSet).trim();
  if (text.length < 1 || text.length > MAX_TEXT_BODY_LENGTH || text.includes("\0")) {
    throw validation("INVALID_MAIL_RENDER", "Rendered plain-text alternative is invalid.");
  }

  if (input.format === "text" || !input.bodyHtmlTemplate) {
    const html = plainTextToDeliveryHtml(text);
    return { subject, text, html };
  }

  // 1. Parse stored HTML template strictly and substitute variables with context-specific escaping
  const ast = parseHtmlToAst(input.bodyHtmlTemplate, {
    mode: "strict",
    allowPlaceholders: true,
    declaredVars: allowedSet,
  });
  const substitutedBody = serializeDeliveryNodes(ast.roots, {
    vars: input.vars,
    canonicalOrigin: input.canonicalOrigin,
  });

  // 2. Repeat server-side HTML allow-list sanitization on the rendered HTML (zero placeholders allowed)
  const resanitizedAst = parseHtmlToAst(substitutedBody, {
    mode: "strict",
    allowPlaceholders: false,
  });
  const finalBodyHtml = serializeDeliveryNodes(resanitizedAst.roots);
  const html = wrapDeliveryHtmlDocument(finalBodyHtml);
  if (Buffer.byteLength(html, "utf8") > MAX_RENDERED_HTML_BYTES) {
    throw validation("INVALID_MAIL_RENDER", "Rendered HTML exceeds maximum message size.");
  }

  const previewHtml = serializeInertPreviewNodes(resanitizedAst.roots);
  return { subject, text, html, previewHtml };
}

export function computeMailTemplateContentHash(input: {
  format: "html" | "text";
  subject: string;
  bodyHtml: string | null;
  bodyText: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        format: input.format,
        subject: input.subject.normalize("NFC"),
        bodyHtml: (input.bodyHtml ?? "").normalize("NFC"),
        bodyText: input.bodyText.normalize("NFC"),
      }),
      "utf8",
    )
    .digest("hex");
}
