import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_DELIVERY_TAGS,
  MAX_HTML_INPUT_BYTES,
  MAX_TEMPLATE_VARS,
  REDACTED_MARKER,
  parseAllowedTemplateUrl,
  projectInertMailPreviewHtml,
  renderMailTemplateVersion,
  sanitizeTemplateHtmlOnSave,
  validateSubjectTemplate,
} from "./sanitizer.js";

interface JsdomModule {
  JSDOM: new (html: string) => { window: { document: Document } };
}

const requireModule = createRequire(import.meta.url);
const { JSDOM } = requireModule("jsdom") as JsdomModule;

const ALLOWED_DELIVERY_SET = new Set<string>(ALLOWED_DELIVERY_TAGS);
const INERT_FORBIDDEN_TAGS = new Set(["a", "img", "script", "style", "svg", "math", "iframe", "form", "object", "embed", "base", "link", "meta"]);
const INERT_ALLOWED_ATTRS = new Map<string, ReadonlySet<string>>([
  ["th", new Set(["scope", "colspan", "rowspan"])],
  ["td", new Set(["colspan", "rowspan"])],
]);

/**
 * Parses HTML with an independent WHATWG HTML5 standards parser (`JSDOM`) and asserts that
 * every resulting DOM element, attribute, parent/child relationship, and URL scheme conforms
 * strictly to the ReadyPackets mail-template allow-list (zero mXSS / foster-parent breakout).
 */
function assertStandardsDomSafeDelivery(htmlFragmentOrDoc: string, options?: { allowPlaceholderHref?: boolean }) {
  const dom = new JSDOM(
    htmlFragmentOrDoc.startsWith("<!doctype html>")
      ? htmlFragmentOrDoc
      : `<!doctype html><html><body>${htmlFragmentOrDoc}</body></html>`,
  );
  const { document } = dom.window;

  // Head must never gain injected active/metadata elements beyond `<meta charset="utf-8">`
  for (const headEl of Array.from(document.head.querySelectorAll("*"))) {
    const tag = headEl.tagName.toLowerCase();
    expect(tag).toBe("meta");
    expect(headEl.attributes.length).toBe(1);
    expect(headEl.getAttribute("charset")?.toLowerCase()).toBe("utf-8");
  }

  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    expect(ALLOWED_DELIVERY_SET.has(tag), `disallowed tag <${tag}> survived into standards DOM`).toBe(true);

    // Enforce contextual parent rules in standards-parsed DOM (catches table foster parenting & nested <a>)
    const parentTag = el.parentElement?.tagName.toLowerCase() ?? "body";
    if (tag === "a") {
      expect(el.closest("a"), "nested <a> in standards DOM").toBe(el);
    }
    if (tag === "table") {
      expect(el.closest("table"), "nested <table> in standards DOM").toBe(el);
    }
    if (tag === "li") {
      expect(parentTag === "ul" || parentTag === "ol", `<li> parent was <${parentTag}>`).toBe(true);
    }
    if (tag === "thead" || tag === "tbody") {
      expect(parentTag).toBe("table");
    }
    if (tag === "tr") {
      expect(parentTag === "thead" || parentTag === "tbody").toBe(true);
    }
    if (tag === "th" || tag === "td") {
      expect(parentTag).toBe("tr");
    }

    // Attribute allow-list check
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      expect(name.startsWith("on"), `event handler ${name} survived`).toBe(false);
      expect(name).not.toBe("style");
      expect(name).not.toBe("srcdoc");
      expect(name).not.toBe("formaction");

      if (tag === "a") {
        expect(["href", "rel", "data-rp-button"].includes(name), `unexpected a[${name}]`).toBe(true);
        if (name === "href") {
          if (options?.allowPlaceholderHref && /^\{\{[a-zA-Z][a-zA-Z0-9_]{0,63}\}\}$/.test(attr.value)) {
            continue;
          }
          expect(
            parseAllowedTemplateUrl(attr.value, { allowMailto: true }),
            `unsafe href in standards DOM: ${attr.value}`,
          ).not.toBeNull();
        }
        if (name === "rel") {
          expect(attr.value).toBe("noopener noreferrer");
        }
        if (name === "data-rp-button") {
          expect(attr.value).toBe("primary");
        }
      } else if (tag === "img") {
        expect(["src", "alt"].includes(name), `unexpected img[${name}]`).toBe(true);
        if (name === "src") {
          expect(
            parseAllowedTemplateUrl(attr.value, { allowMailto: false }),
            `unsafe img[src] in standards DOM: ${attr.value}`,
          ).not.toBeNull();
        }
      } else if (tag === "th") {
        expect(["scope", "colspan", "rowspan"].includes(name), `unexpected th[${name}]`).toBe(true);
      } else if (tag === "td") {
        expect(["colspan", "rowspan"].includes(name), `unexpected td[${name}]`).toBe(true);
      } else {
        throw new Error(`Unexpected attribute ${name} on <${tag}>`);
      }
    }
  }
}

function assertStandardsDomSafeInertPreview(previewHtml: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${previewHtml}</body></html>`);
  const { document } = dom.window;
  expect(document.head.children.length).toBe(0);

  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    expect(INERT_FORBIDDEN_TAGS.has(tag), `forbidden preview tag <${tag}>`).toBe(false);
    expect(ALLOWED_DELIVERY_SET.has(tag), `disallowed preview tag <${tag}>`).toBe(true);

    const allowedAttrs = INERT_ALLOWED_ATTRS.get(tag) ?? new Set<string>();
    for (const attr of Array.from(el.attributes)) {
      expect(allowedAttrs.has(attr.name.toLowerCase()), `forbidden preview attr ${tag}[${attr.name}]`).toBe(true);
    }
  }
}

describe("mailTemplates sanitizer security gates (D-S01..D-S04) & independent standards-parser corpus", () => {
  it("D-S01: rejects Object.prototype tag names (constructor, __proto__, toString) and prototype entity names", () => {
    for (const protoTag of ["constructor", "tostring", "valueof", "hasownproperty"]) {
      expect(() => sanitizeTemplateHtmlOnSave(`<${protoTag}>payload</${protoTag}>`)).toThrow();
      expect(projectInertMailPreviewHtml(`<${protoTag}>payload</${protoTag}>`)).toBe("");
    }
    const entitySaved = sanitizeTemplateHtmlOnSave("<p>&constructor; &toString; &amp; ok</p>");
    expect(entitySaved.html).toBe("<p>&amp;constructor; &amp;toString; &amp; ok</p>");
    expect(sanitizeTemplateHtmlOnSave(entitySaved.html).html).toBe(entitySaved.html);
  });

  it("D-S02: enforces stack depth on neutral wrappers, caps placeholder count, runs in linear O(n) on comment-split text, and bounds canonical byte expansion", () => {
    const deepDivs = `${"<div>".repeat(20)}<p>deep</p>${"</div>".repeat(20)}`;
    expect(() => sanitizeTemplateHtmlOnSave(deepDivs)).toThrow(/HTML_TEMPLATE_TOO_COMPLEX/);
    expect(projectInertMailPreviewHtml(deepDivs)).toBe("");

    const tooManyVars = Array.from({ length: MAX_TEMPLATE_VARS + 1 }, (_, idx) => `{{var_${idx}}}`).join(" ");
    expect(() => sanitizeTemplateHtmlOnSave(`<p>${tooManyVars}</p>`)).toThrow(/TOO_MANY_TEMPLATE_VARIABLES/);

    // 4,000 comment-split fragments must normalize in linear time (< 500ms) without quadratic NFC blowup
    const splitFragments = Array.from({ length: 4_000 }, (_, idx) => `w${idx}<!-- c -->`).join("");
    const t0 = performance.now();
    const res = sanitizeTemplateHtmlOnSave(`<p>${splitFragments}</p>`);
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(500);
    expect(res.html.startsWith("<p>w0w1w2")).toBe(true);
    expect(sanitizeTemplateHtmlOnSave(res.html).html).toBe(res.html);

    // Input just under 128 KiB that expands past 128 KiB via `"` -> `&quot;` (6x) must be rejected
    const expandingQuotes = '"'.repeat(30_000);
    expect(Buffer.byteLength(`<p>${expandingQuotes}</p>`, "utf8")).toBeLessThan(MAX_HTML_INPUT_BYTES);
    expect(() => sanitizeTemplateHtmlOnSave(`<p>${expandingQuotes}</p>`)).toThrow(/HTML_TEMPLATE_TOO_LARGE/);
    expect(projectInertMailPreviewHtml(`<p>${expandingQuotes}</p>`)).toBe("");
  });

  it("D-S03: fails closed on dangerous/foreign/raw-text/head-smuggled subtrees and malformed EOF in both strict and lenient preview modes", () => {
    const dangerousCorpus = [
      // mXSS classics (noscript, style, title, textarea, xmp, iframe, svg, math)
      '<svg><desc><script>alert(1)</script></desc></svg>',
      '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
      '<p><style><!--</style><script>alert(1)</script></p>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<title><script>alert(1)</script></title><p>Hello</p>',
      '<script/>alert(1)<p>after self-closing script</p>',
      '<style/>body{display:none}<p>after self-closing style</p>',
      '<svg/><img src="https://example.com/a.png" alt="x">',
      '<form><button formaction="javascript:alert(1)">Click</button></form>',
      '<head><p>smuggled body element inside head</p></head><body><p>ok</p></body>',
      '<head>non-empty text inside head</head><body><p>ok</p></body>',
      '<meta charset="utf-8"><p>meta outside head</p>',
      '<head><meta http-equiv="refresh" content="0;url=https://evil.example"></head><body><p>ok</p></body>',
      '<table>foster parented bare text<img src=x onerror=alert(1)><tr><td>cell</td></tr></table>',
      '<table><tbody><tr><td><div><table><tbody><tr><td>nested table</td></tr></tbody></table></div></td></tr></tbody></table>',
      '<a href="https://example.com/1">outer <a href="https://example.com/2">nested</a></a>',
    ];

    for (const vector of dangerousCorpus) {
      expect(() => sanitizeTemplateHtmlOnSave(vector), `strict should reject: ${vector}`).toThrow();
    }

    for (const mustFailClosed of dangerousCorpus.slice(0, 13)) {
      expect(
        projectInertMailPreviewHtml(mustFailClosed),
        `preview should fail closed to empty string: ${mustFailClosed}`,
      ).toBe("");
    }
    expect(projectInertMailPreviewHtml(dangerousCorpus[14]!)).toBe("");

    // Truncated EOF tag/comment must never leak raw markup tail into preview
    const truncatedTag = '<p>Safe intro</p><a href="https://example.com" onclick="alert(1)"';
    const projectedTruncated = projectInertMailPreviewHtml(truncatedTag);
    expect(projectedTruncated).toBe("<p>Safe intro</p>");
    assertStandardsDomSafeInertPreview(projectedTruncated);
    expect(projectInertMailPreviewHtml(projectedTruncated)).toBe(projectedTruncated);

    const truncatedComment = "<p>Safe intro</p><!-- unclosed comment <script>alert(1)</script>";
    expect(projectInertMailPreviewHtml(truncatedComment)).toBe("<p>Safe intro</p>");
  });

  it("D-S04: detects split placeholders formed across stripped comments/wrappers/entities and guarantees exact byte-for-byte idempotence", () => {
    const declared = new Set(["customer_name", "action_url"]);

    // Split braces `{<!-- -->{undeclared}<!-- -->}` and `{<div></div>{undeclared}}` must be caught on save!
    expect(() => sanitizeTemplateHtmlOnSave("<p>{<!-- split -->{undeclared}<!-- split -->}</p>", declared)).toThrow(
      /undeclared/i,
    );
    expect(() => sanitizeTemplateHtmlOnSave("<p>{<div></div>{undeclared}}</p>", declared)).toThrow(/undeclared/i);
    expect(() => sanitizeTemplateHtmlOnSave("<p>&#123;&#123;undeclared&#125;&#125;</p>", declared)).toThrow(
      /undeclared/i,
    );
    expect(() => sanitizeTemplateHtmlOnSave("<p>{<!-- -->{bad-name!}}</p>", declared)).toThrow(/placeholder/i);

    // Valid split placeholder with declared var normalizes cleanly and is byte-for-byte idempotent on pass 2
    const splitValid = sanitizeTemplateHtmlOnSave("<p>Hi {<!-- -->{customer_name}}</p>", declared);
    expect(splitValid.referencedVars).toEqual(["customer_name"]);
    expect(splitValid.html).toBe("<p>Hi {{customer_name}}</p>");
    expect(sanitizeTemplateHtmlOnSave(splitValid.html, declared).html).toBe(splitValid.html);

    // Image alt slice boundary trailing whitespace is re-trimmed so pass 2 is exact byte-for-byte identical
    const paddedAlt = `${"A".repeat(239)} B`;
    const imgSaved = sanitizeTemplateHtmlOnSave(
      `<p><img src="https://portal.example.com/logo.png" alt="${paddedAlt}"></p>`,
    );
    expect(sanitizeTemplateHtmlOnSave(imgSaved.html).html).toBe(imgSaved.html);
    assertStandardsDomSafeDelivery(imgSaved.html);

    // Decomposed Unicode around markup normalizes identically on pass 1 and pass 2
    const decomposed = `<p>Cafe<span>\u0301</span> — {{customer_name}}</p>`;
    const savedUnicode = sanitizeTemplateHtmlOnSave(decomposed, declared);
    expect(sanitizeTemplateHtmlOnSave(savedUnicode.html, declared).html).toBe(savedUnicode.html);

    // Numeric CR/CRLF entities (`&#13;`, `&#x0d;`, `&#13;&#10;`) must normalize to LF on pass 1 so save & preview are exact on pass 2
    const numericCrHtml = "<p>LineA&#13;LineB&#x0d;&#x0a;LineC&#13;&#10;End</p>";
    const savedCr = sanitizeTemplateHtmlOnSave(numericCrHtml);
    expect(savedCr.html).not.toContain("\r");
    expect(savedCr.html).toBe("<p>LineA\nLineB\nLineC\nEnd</p>");
    expect(sanitizeTemplateHtmlOnSave(savedCr.html).html).toBe(savedCr.html);
    const previewCr = projectInertMailPreviewHtml(numericCrHtml);
    expect(previewCr).not.toContain("\r");
    expect(projectInertMailPreviewHtml(previewCr)).toBe(previewCr);

    // Near-cap & at-cap depth (`MAX_AST_DEPTH = 16`) with `<img>` and `<a data-rp-button="primary">` must remain exact idempotent on pass 2
    for (const depth of [14, 15, 16]) {
      const openQuotes = "<blockquote>".repeat(depth);
      const closeQuotes = "</blockquote>".repeat(depth);
      const atCapImg = `${openQuotes}<img src="https://portal.example.com/a.png" alt="Cap">${closeQuotes}`;
      const p1 = projectInertMailPreviewHtml(atCapImg);
      expect(projectInertMailPreviewHtml(p1)).toBe(p1);

      const atCapBtn = `${openQuotes}<a href="https://portal.example.com" data-rp-button="primary">Go</a>${closeQuotes}`;
      const b1 = projectInertMailPreviewHtml(atCapBtn);
      expect(projectInertMailPreviewHtml(b1)).toBe(b1);
    }

    // Near-cap & at-cap node count (`MAX_AST_NODES = 2500`) with `<img>` expansion (`img` -> `<em>text</em>`) must remain exact idempotent on pass 2
    for (const imgCount of [1_248, 1_249, 1_250, 2_499, 2_500]) {
      const manyImgs = `<p>${'<img src="https://portal.example.com/a.png" alt="x">'.repeat(imgCount)}</p>`;
      const proj1 = projectInertMailPreviewHtml(manyImgs);
      expect(projectInertMailPreviewHtml(proj1)).toBe(proj1);
    }

    // Percent-encoded control chars / multi-recipient injection in mailto: are rejected
    expect(parseAllowedTemplateUrl("mailto:help@example.com", { allowMailto: true })).toBe("mailto:help@example.com");
    expect(parseAllowedTemplateUrl("mailto:victim@example.com%0d%0aBcc:attacker@evil.test", { allowMailto: true })).toBeNull();
    expect(parseAllowedTemplateUrl("mailto:a@example.com,b@example.com", { allowMailto: true })).toBeNull();
    expect(parseAllowedTemplateUrl("mailto:help@example.com?subject=hi", { allowMailto: true })).toBeNull();
    expect(parseAllowedTemplateUrl("javascript:alert(1)", { allowMailto: true })).toBeNull();
    expect(parseAllowedTemplateUrl("data:text/html,<script>alert(1)</script>", { allowMailto: true })).toBeNull();
    expect(parseAllowedTemplateUrl("https://user:pass@example.com/path", { allowMailto: false })).toBeNull();
  });

  it("enforces subject header-injection rules and renders redacted [REDACTED] links safely", () => {
    expect(() => validateSubjectTemplate("Hello\r\nBcc: attacker@evil.test")).toThrow();
    expect(() => validateSubjectTemplate("Hello\u2028LineSep")).toThrow();

    const saved = sanitizeTemplateHtmlOnSave(
      '<p>Hello {{name}}, open <a href="{{reset_link}}" data-rp-button="primary">Reset password</a>.</p>',
      new Set(["name", "reset_link"]),
    );
    assertStandardsDomSafeDelivery(saved.html, { allowPlaceholderHref: true });

    // Live render with untrusted XSS payload in `name`
    const live = renderMailTemplateVersion({
      format: "html",
      subjectTemplate: "Reset for {{name}}",
      bodyHtmlTemplate: saved.html,
      bodyTextTemplate: "Reset for {{name}}: {{reset_link}}",
      declaredVars: ["name", "reset_link"],
      vars: {
        name: '<img src=x onerror=alert(1)>"><script>alert(1)</script>',
        reset_link: "https://portal.readypackets.test/reset?token=abc123",
      },
    });
    assertStandardsDomSafeDelivery(live.html);
    assertStandardsDomSafeInertPreview(live.previewHtml ?? "");
    expect(projectInertMailPreviewHtml(live.html)).toBe(live.previewHtml);
    expect(projectInertMailPreviewHtml(live.previewHtml ?? "")).toBe(live.previewHtml);

    // Redacted audit copy render (`sensitiveVars` replaced with `[REDACTED]`)
    const redacted = renderMailTemplateVersion({
      format: "html",
      subjectTemplate: "Reset for {{name}}",
      bodyHtmlTemplate: saved.html,
      bodyTextTemplate: "Reset for {{name}}: {{reset_link}}",
      declaredVars: ["name", "reset_link"],
      vars: {
        name: "Ada Lovelace",
        reset_link: REDACTED_MARKER,
      },
    });
    assertStandardsDomSafeDelivery(redacted.html);
    expect(redacted.html).toContain("[REDACTED]");
    expect(redacted.html).not.toContain("abc123");
  });

  it("deterministic seeded property fuzz: 150 mixed-nesting ASTs + hostile substitutions reparsed by JSDOM with exact second-pass idempotence", { timeout: 25_000 }, () => {
    let state = 0x5eed_c0de;
    const nextRand = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    const pick = <T>(arr: readonly T[]): T => arr[nextRand() % arr.length]!;

    const hostileTextSnippets = [
      "Plain ASCII text",
      "Cafe\u0301 & <script>alert(1)</script>",
      'Quote "test" \'single\' &amp; &lt;svg onload=alert(1)&gt;',
      "{{v_text}}",
      "Line1<!-- comment -->Line2",
      "Table breaker </td></tr></table><img src=x onerror=alert(1)>",
      "{ literal brace } and &constructor;",
    ] as const;

    const hostileVarValues = [
      "Normal Customer",
      "<svg/onload=alert(1)>",
      '"><a href="javascript:alert(1)">click</a>',
      "</table><script>evil()</script>",
      "{{v_url}}",
      "Cafe\u0301 \u2014 ReadyPackets",
    ] as const;

    const genInline = (depth: number): string => {
      if (depth <= 0 || nextRand() % 3 === 0) {
        return escapeForTemplateSource(pick(hostileTextSnippets));
      }
      const kind = nextRand() % 6;
      switch (kind) {
        case 0:
          return `<strong>${genInline(depth - 1)}</strong>`;
        case 1:
          return `<em>${genInline(depth - 1)}</em>`;
        case 2:
          return `<code>${escapeForTemplateSource(pick(hostileTextSnippets))}</code>`;
        case 3:
          return `<a href="https://portal.example.com/item/${nextRand() % 100}" data-rp-button="primary">${escapeForTemplateSource("Open item")}</a>`;
        case 4:
          return `<a href="{{v_url}}">${escapeForTemplateSource("Dynamic action")}</a>`;
        default:
          return `<img src="https://cdn.example.com/img/${nextRand() % 50}.png" alt="Badge ${nextRand() % 50}">`;
      }
    };

    const genBlock = (_depth: number): string => {
      const kind = nextRand() % 7;
      switch (kind) {
        case 0:
          return `<div><p>${genInline(2)} ${genInline(1)}</p></div>`;
        case 1:
          return `<h2>${escapeForTemplateSource("Section")} {{v_text}}</h2>`;
        case 2:
          return `<ul><li>${genInline(2)}</li><li>${genInline(1)}</li></ul>`;
        case 3:
          return `<ol><li>${genInline(2)}</li><li><p>${genInline(2)}</p></li></ol>`;
        case 4:
          return `<blockquote><p>${genInline(2)}</p></blockquote>`;
        case 5:
          return `<hr>`;
        default:
          return `<table><thead><tr><th scope="col">Item</th><th scope="col">Value</th></tr></thead><tbody><tr><td>${genInline(2)}</td><td colspan="1">${genInline(1)}</td></tr></tbody></table>`;
      }
    };

    const declared = new Set(["v_text", "v_url"]);

    for (let seedRun = 0; seedRun < 150; seedRun++) {
      const blockCount = 1 + (nextRand() % 4);
      const rawHtml = Array.from({ length: blockCount }, () => genBlock(3)).join("\n");

      const pass1 = sanitizeTemplateHtmlOnSave(rawHtml, declared);
      const pass2 = sanitizeTemplateHtmlOnSave(pass1.html, declared);

      // Exact byte-for-byte idempotence on canonical saved HTML
      expect(pass2.html).toBe(pass1.html);
      expect(pass2.derivedText).toBe(pass1.derivedText);

      // Independent standards HTML5 parser check on saved template
      assertStandardsDomSafeDelivery(pass1.html, { allowPlaceholderHref: true });

      // Render with hostile variable values and verify standards DOM + preview idempotence
      const rendered = renderMailTemplateVersion({
        format: "html",
        subjectTemplate: "Notice: {{v_text}}",
        bodyHtmlTemplate: pass1.html,
        bodyTextTemplate: pass1.derivedText,
        declaredVars: ["v_text", "v_url"],
        vars: {
          v_text: pick(hostileVarValues),
          v_url:
            seedRun % 5 === 0
              ? REDACTED_MARKER
              : seedRun % 3 === 0
                ? "mailto:support@readypackets.example"
                : `/orders/ord_${seedRun}`,
        },
        canonicalOrigin: "https://portal.readypackets.example",
      });

      assertStandardsDomSafeDelivery(rendered.html);
      const projected1 = projectInertMailPreviewHtml(rendered.html);
      const projected2 = projectInertMailPreviewHtml(projected1);
      expect(projected1).toBe(rendered.previewHtml);
      expect(projected2).toBe(projected1);
      assertStandardsDomSafeInertPreview(projected1);
    }
  });
});

function escapeForTemplateSource(snippet: string): string {
  if (snippet.startsWith("Line1<!--")) return snippet;
  if (snippet === "{{v_text}}") return snippet;
  return snippet
    .replace(/&(?!(?:amp|lt|gt|constructor);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
