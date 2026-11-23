/**
 * CSP-safe TipTap extensions for the portal Word document editor (Increment 06 D9).
 * Avoids `TableView` inline `style` DOM writes and replaces `style="text-align: ..."` with
 * `data-text-align="..."` so `style-src 'self'` holds with zero violations.
 */
import { mergeAttributes, type Extensions } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import StarterKit from "@tiptap/starter-kit";
import {
  isAllowedDocumentHref,
  isAllowedDocumentImageSrc,
  type DocumentTextAlignment,
} from "@/lib/docconvert";

const VALID_ALIGNMENTS = new Set<string>(["left", "center", "right", "justify"]);

function parseAlignmentFromElement(element: HTMLElement): DocumentTextAlignment | null {
  const dataVal = (element.getAttribute("data-text-align") ?? "").trim().toLowerCase();
  if (VALID_ALIGNMENTS.has(dataVal)) return dataVal as DocumentTextAlignment;

  const attrVal = (element.getAttribute("align") ?? "").trim().toLowerCase();
  if (VALID_ALIGNMENTS.has(attrVal)) return attrVal as DocumentTextAlignment;

  const styleVal = (element.style?.textAlign ?? "").trim().toLowerCase();
  if (VALID_ALIGNMENTS.has(styleVal)) return styleVal as DocumentTextAlignment;

  return null;
}

function stripInlineStyleAttribute(attrs: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(attrs)) {
    if (key.toLowerCase() === "style" || val === undefined || val === null) continue;
    cleaned[key] = val;
  }
  return cleaned;
}

export const CspSafeTextAlign = TextAlign.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          textAlign: {
            default: this.options.defaultAlignment,
            parseHTML: (element) =>
              parseAlignmentFromElement(element as HTMLElement) ?? this.options.defaultAlignment,
            renderHTML: (attributes: { textAlign?: string | null }) => {
              const align = attributes.textAlign ?? null;
              if (!align || align === "left" || !VALID_ALIGNMENTS.has(align)) {
                return {};
              }
              return { "data-text-align": align };
            },
          },
        },
      },
    ];
  },
}).configure({
  types: ["heading", "paragraph", "tableCell", "tableHeader"],
  alignments: ["left", "center", "right", "justify"],
  defaultAlignment: null,
});

const CspSafeTable = Table.extend({
  renderHTML({ HTMLAttributes }) {
    const safeAttrs = stripInlineStyleAttribute(
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
    );
    return ["div", { class: "rp-docedit-table-wrap" }, ["table", safeAttrs, ["tbody", 0]]];
  },
}).configure({
  resizable: false,
  View: null,
});

const CspSafeTableCell = TableCell.extend({
  addAttributes() {
    const parentAttrs = this.parent?.() ?? {};
    return {
      ...parentAttrs,
      colwidth: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      align: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
    };
  },
  renderHTML({ HTMLAttributes }) {
    const safeAttrs = stripInlineStyleAttribute(
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
    );
    if (safeAttrs.colspan === 1 || safeAttrs.colspan === "1") delete safeAttrs.colspan;
    if (safeAttrs.rowspan === 1 || safeAttrs.rowspan === "1") delete safeAttrs.rowspan;
    return ["td", safeAttrs, 0];
  },
});

const CspSafeTableHeader = TableHeader.extend({
  addAttributes() {
    const parentAttrs = this.parent?.() ?? {};
    return {
      ...parentAttrs,
      colwidth: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      align: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
    };
  },
  renderHTML({ HTMLAttributes }) {
    const safeAttrs = stripInlineStyleAttribute(
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
    );
    if (safeAttrs.colspan === 1 || safeAttrs.colspan === "1") delete safeAttrs.colspan;
    if (safeAttrs.rowspan === 1 || safeAttrs.rowspan === "1") delete safeAttrs.rowspan;
    return ["th", safeAttrs, 0];
  },
});

export function documentEditorExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      codeBlock: false,
      trailingNode: false,
      link: {
        openOnClick: false,
        autolink: false,
        linkOnPaste: false,
        enableClickSelection: true,
        protocols: [],
        HTMLAttributes: { target: null, rel: null, class: null },
        isAllowedUri: (url: string) => isAllowedDocumentHref(url),
      },
    }),
    Image.configure({ inline: false, allowBase64: true }).extend({
      parseHTML() {
        return [
          {
            tag: "img[src]",
            getAttrs: (element) => {
              const src = (element as HTMLElement).getAttribute("src") ?? "";
              return isAllowedDocumentImageSrc(src) ? null : false;
            },
          },
        ];
      },
    }),
    CspSafeTable,
    TableRow,
    CspSafeTableCell,
    CspSafeTableHeader,
    CspSafeTextAlign,
  ];
}
