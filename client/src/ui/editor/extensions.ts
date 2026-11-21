import { Mark, Node, mergeAttributes, type Extensions } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import StarterKit from "@tiptap/starter-kit";
import { isAllowedHref, isAllowedImageSrc } from "./html";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    variable: { insertVariable: (name: string) => ReturnType };
  }
}

/** `{{name}}` as an atomic inline chip. Stored as text by `fromEditorHtml`. */
export const Variable = Node.create({
  name: "variable",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-variable") ?? "",
        renderHTML: (attributes) => ({ "data-variable": String(attributes.name ?? "") }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-variable]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "rp-variable-chip", contenteditable: "false" }), `{{${String(node.attrs.name)}}}`];
  },
  renderText({ node }) {
    return `{{${String(node.attrs.name)}}}`;
  },
  addCommands() {
    return {
      insertVariable:
        (name: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { name } }),
    };
  },
});

/** Call-to-action button: `<a href data-rp-button="primary">`. Takes precedence over the plain link rule. */
export const MailButton = Mark.create({
  name: "rpButton",
  priority: 1100,
  inclusive: false,
  excludes: "link",
  addAttributes() {
    return { href: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "a[data-rp-button]",
        priority: 100,
        getAttrs: (element) => {
          const href = (element as HTMLElement).getAttribute("href") ?? "";
          return isAllowedHref(href) ? { href } : false;
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["a", { href: String(HTMLAttributes.href ?? ""), "data-rp-button": "primary" }, 0];
  },
});

export function editorExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      blockquote: false,
      code: false,
      codeBlock: false,
      strike: false,
      underline: false,
      trailingNode: false,
      link: {
        openOnClick: false,
        autolink: false,
        linkOnPaste: false,
        enableClickSelection: true,
        protocols: [],
        HTMLAttributes: { target: null, rel: null, class: null },
        isAllowedUri: (url: string) => isAllowedHref(url),
      },
    }),
    Image.configure({ inline: false, allowBase64: false }).extend({
      // Only https: sources are kept on parse (paste, initial content); the server checks again.
      parseHTML() {
        return [
          {
            tag: "img[src]",
            getAttrs: (element) => {
              const src = (element as HTMLElement).getAttribute("src") ?? "";
              return isAllowedImageSrc(src) ? null : false;
            },
          },
        ];
      },
    }),
    Variable,
    MailButton,
  ];
}
