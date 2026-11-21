/**
 * The e-mail HTML subset produced by RichTextEditor and the conversions between stored HTML (variables as the literal
 * text `{{name}}`) and editor HTML (variables as chips). Parsing uses DOMParser, whose documents are inert (no scripts,
 * no resource loads). The SERVER sanitiser is the authority; this only keeps the editor's own output in the subset.
 */

export const VARIABLE_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}/g;
const EXACT_VARIABLE = /^\{\{\s*[A-Za-z][A-Za-z0-9_.]*\s*\}\}$/;

/** Link / button targets: https:, mailto:, or exactly one `{{variable}}`. */
export function isAllowedHref(value: string): boolean {
  const href = value.trim();
  if (EXACT_VARIABLE.test(href)) return true;
  if (/[\s<>"'`]/.test(href)) return false;
  return /^https:\/\/[^/]/i.test(href) || /^mailto:[^@\s]+@[^@\s]+$/i.test(href);
}

/** Image sources: https: only. */
export function isAllowedImageSrc(value: string): boolean {
  const src = value.trim();
  return /^https:\/\/[^/\s]/i.test(src) && !/[\s<>"'`]/.test(src);
}

const ALLOWED: Record<string, readonly string[]> = {
  p: [],
  h2: [],
  h3: [],
  strong: [],
  em: [],
  ul: [],
  ol: [],
  li: [],
  br: [],
  hr: [],
  a: ["href", "data-rp-button"],
  img: ["src", "alt"],
};

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
}

/** Stored HTML → editor HTML: `{{name}}` in text becomes `<span data-variable="name">`. Attributes are untouched. */
export function toEditorHtml(html: string): string {
  if (!html.trim()) return "";
  const doc = parse(html);
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const text of texts) {
    const value = text.data;
    VARIABLE_PATTERN.lastIndex = 0;
    if (!VARIABLE_PATTERN.test(value)) continue;
    VARIABLE_PATTERN.lastIndex = 0;
    const fragment = doc.createDocumentFragment();
    let last = 0;
    for (const match of value.matchAll(VARIABLE_PATTERN)) {
      const at = match.index ?? 0;
      if (at > last) fragment.append(doc.createTextNode(value.slice(last, at)));
      const chip = doc.createElement("span");
      chip.setAttribute("data-variable", match[1] ?? "");
      fragment.append(chip);
      last = at + match[0].length;
    }
    if (last < value.length) fragment.append(doc.createTextNode(value.slice(last)));
    text.replaceWith(fragment);
  }
  return doc.body.innerHTML;
}

/** Editor HTML → stored HTML in the subset: chips become `{{name}}`, everything outside the subset is unwrapped or dropped. */
export function fromEditorHtml(html: string): string {
  const doc = parse(html);
  for (const chip of Array.from(doc.body.querySelectorAll("span[data-variable]"))) {
    chip.replaceWith(doc.createTextNode(`{{${chip.getAttribute("data-variable") ?? ""}}}`));
  }
  clean(doc.body);
  // Trailing empty paragraphs carry nothing for the recipient.
  while (doc.body.lastElementChild?.tagName === "P" && !doc.body.lastElementChild.hasChildNodes()) doc.body.lastElementChild.remove();
  return doc.body.innerHTML;
}

function clean(parent: Element): void {
  for (const child of Array.from(parent.children)) {
    const tag = child.tagName.toLowerCase();
    const allowed = ALLOWED[tag];
    if (!allowed) {
      if (["script", "style", "iframe", "object", "embed", "template", "svg", "math", "form"].includes(tag)) child.remove();
      else {
        clean(child);
        child.replaceWith(...Array.from(child.childNodes));
      }
      continue;
    }
    for (const attr of Array.from(child.attributes)) {
      if (!allowed.includes(attr.name)) child.removeAttribute(attr.name);
    }
    if (tag === "a") {
      const href = child.getAttribute("href") ?? "";
      if (!isAllowedHref(href)) {
        clean(child);
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      if (child.hasAttribute("data-rp-button")) child.setAttribute("data-rp-button", "primary");
    }
    if (tag === "img") {
      const src = child.getAttribute("src") ?? "";
      const alt = child.getAttribute("alt") ?? "";
      if (!isAllowedImageSrc(src) || !alt.trim()) {
        child.remove();
        continue;
      }
    }
    clean(child);
  }
}
