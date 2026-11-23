/**
 * Lazy TipTap document editor canvas (headings, bold/italic/underline/strike, alignment, lists, links, tables).
 * Runs with `injectCSS: false` and bundled `./docedit.css`; designed and tested against WCAG 2.2 AA.
 */
import "./docedit.css";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  Strikethrough,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Undo2,
  Unlink,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { isAllowedDocumentHref, sanitizeDocumentHtml } from "@/lib/docconvert";
import { Button, cn, Dialog, DropdownMenu, Field, Input } from "@/ui";
import { documentEditorExtensions } from "./extensions";

export interface DocumentEditorCanvasProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (sanitizedHtml: string) => void;
  readonly readOnly?: boolean;
  readonly hint?: string;
}

function ToolButton({
  label,
  icon,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={disabled}
      data-rp-doctool=""
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-ink hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11 [&_svg]:size-4",
        pressed && "bg-action-soft text-action",
      )}
    >
      {icon}
    </button>
  );
}

function useRovingToolbar(ref: RefObject<HTMLDivElement | null>) {
  const tools = () =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-rp-doctool]:not(:disabled)") ?? []);
  const sync = (active?: HTMLElement) => {
    const list = tools();
    const target = active ?? list.find((el) => el.tabIndex === 0) ?? list[0];
    for (const el of list) el.tabIndex = el === target ? 0 : -1;
  };
  useEffect(() => sync());

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = tools();
    if (list.length === 0) return;
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % list.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + list.length) % list.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = list.length - 1;
    if (next < 0) return;
    event.preventDefault();
    sync(list[next]);
    list[next]?.focus();
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).hasAttribute("data-rp-doctool")) {
      sync(event.target as HTMLElement);
    }
  };
  return [onKeyDown, onFocus] as const;
}

function useDocumentToolState(editor: Editor | null) {
  return useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            paragraph: e.isActive("paragraph"),
            h1: e.isActive("heading", { level: 1 }),
            h2: e.isActive("heading", { level: 2 }),
            h3: e.isActive("heading", { level: 3 }),
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            strike: e.isActive("strike"),
            blockquote: e.isActive("blockquote"),
            bullet: e.isActive("bulletList"),
            ordered: e.isActive("orderedList"),
            alignCenter: e.isActive({ textAlign: "center" }),
            alignRight: e.isActive({ textAlign: "right" }),
            alignJustify: e.isActive({ textAlign: "justify" }),
            link: e.isActive("link"),
            inTable: e.isActive("table"),
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
          }
        : null,
  });
}

export default function DocumentEditorCanvas({
  label,
  value,
  onChange,
  readOnly = false,
  hint,
}: DocumentEditorCanvasProps) {
  const autoId = useId();
  const editorId = `${autoId}-doc-editor`;
  const labelId = `${autoId}-doc-label`;
  const hintId = hint ? `${autoId}-doc-hint` : undefined;
  const lastEmitted = useRef<string>(value);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [onToolbarKeyDown, onToolbarFocus] = useRovingToolbar(toolbarRef);

  const editor = useEditor({
    extensions: documentEditorExtensions(),
    content: value,
    injectCSS: false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editable: !readOnly,
    editorProps: {
      attributes: {
        id: editorId,
        role: "textbox",
        "aria-multiline": "true",
        "aria-labelledby": labelId,
        ...(hintId ? { "aria-describedby": hintId } : {}),
        ...(readOnly ? { "aria-readonly": "true" } : {}),
        class: "rp-docedit-body text-body",
      },
    },
    onUpdate: ({ editor: e }) => {
      const cleanHtml = sanitizeDocumentHtml(e.getHTML());
      if (cleanHtml === lastEmitted.current) return;
      lastEmitted.current = cleanHtml;
      onChange(cleanHtml);
    },
  });

  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    lastEmitted.current = value;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    if (editor && editor.isEditable === readOnly) {
      editor.setEditable(!readOnly, false);
    }
  }, [editor, readOnly]);

  const state = useDocumentToolState(editor);
  const off = readOnly || !editor;
  const run = (fn: (e: Editor) => void) => () => {
    if (editor && !readOnly) fn(editor);
  };

  const alignLeftActive =
    !!state && !state.alignCenter && !state.alignRight && !state.alignJustify;

  return (
    <div className="rp-docedit flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span id={labelId} className="text-sm font-semibold text-ink">
          {label}
        </span>
        {hint ? (
          <span id={hintId} className="text-xs text-muted">
            {hint}
          </span>
        ) : null}
      </div>

      <div
        className={cn(
          "min-w-0 rounded-[var(--radius-card)] border border-control-border bg-surface focus-within:ring-2 focus-within:ring-action",
          readOnly && "bg-surface-sunken/40",
        )}
      >
        {!readOnly ? (
          <div
            ref={toolbarRef}
            role="toolbar"
            aria-label={`${label}: formatting`}
            aria-controls={editorId}
            onKeyDown={onToolbarKeyDown}
            onFocus={onToolbarFocus}
            className="flex flex-wrap items-center gap-0.5 border-b border-line p-1.5"
          >
            <ToolButton
              label="Paragraph"
              icon={<Pilcrow />}
              pressed={!!state?.paragraph}
              disabled={off}
              onClick={run((e) => e.chain().focus().setParagraph().run())}
            />
            <ToolButton
              label="Heading 1"
              icon={<Heading1 />}
              pressed={!!state?.h1}
              disabled={off}
              onClick={run((e) => e.chain().focus().toggleHeading({ level: 1 }).run())}
            />
            <ToolButton
              label="Heading 2"
              icon={<Heading2 />}
              pressed={!!state?.h2}
              disabled={off}
              onClick={run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())}
            />
            <ToolButton
              label="Heading 3"
              icon={<Heading3 />}
              pressed={!!state?.h3}
              disabled={off}
              onClick={run((e) => e.chain().focus().toggleHeading({ level: 3 }).run())}
            />

            <span aria-hidden="true" className="mx-1 h-6 w-px bg-line" />

            <ToolButton
              label="Bold"
              icon={<Bold />}
              pressed={!!state?.bold}
              disabled={off}
              onClick={run((e) => e.chain().focus().toggleBold().run())}
            />
            <ToolButton
              label="Italic"
              icon={<Italic />}
              pressed={!!state?.italic}
              disabled={off}
              onClick={run((e) => e.chain().focus().toggleItalic().run())}
            />
            <ToolButton
              label="Underline"
              icon={<UnderlineIcon />}
              pressed={!!state?.underline}
              disabled={off}
              onClick={run((e) => e.chain().focus().toggleUnderline().run())}
            />
            <ToolButton
              label="Strikethrough"
              icon={<Strikethrough />}
              pressed={!!state?.strike}
              disabled={off}
              onClick={run((e) => e.chain().focus().toggleStrike().run())}
            />
            <ToolButton
              label="Quote"
              icon={<Quote />}
              pressed={!!state?.blockquote}
              disabled={off}
              onClick={run((e) => e.chain().focus().toggleBlockquote().run())}
            />

            <span aria-hidden="true" className="mx-1 h-6 w-px bg-line" />

            <ToolButton
              label="Align left"
              icon={<AlignLeft />}
              pressed={alignLeftActive}
              disabled={off}
              onClick={run((e) => e.chain().focus().unsetTextAlign().run())}
            />
            <ToolButton
              label="Align center"
              icon={<AlignCenter />}
              pressed={!!state?.alignCenter}
              disabled={off}
              onClick={run((e) => e.chain().focus().setTextAlign("center").run())}
            />
            <ToolButton
              label="Align right"
              icon={<AlignRight />}
              pressed={!!state?.alignRight}
              disabled={off}
              onClick={run((e) => e.chain().focus().setTextAlign("right").run())}
            />
            <ToolButton
              label="Justify"
              icon={<AlignJustify />}
              pressed={!!state?.alignJustify}
              disabled={off}
              onClick={run((e) => e.chain().focus().setTextAlign("justify").run())}
            />

            <span aria-hidden="true" className="mx-1 h-6 w-px bg-line" />

            <ToolButton
              label="Bulleted list"
              icon={<List />}
              pressed={!!state?.bullet}
              disabled={off}
              onClick={run((e) => e.chain().focus().toggleBulletList().run())}
            />
            <ToolButton
              label="Numbered list"
              icon={<ListOrdered />}
              pressed={!!state?.ordered}
              disabled={off}
              onClick={run((e) => e.chain().focus().toggleOrderedList().run())}
            />
            <ToolButton
              label="Horizontal divider"
              icon={<Minus />}
              disabled={off}
              onClick={run((e) => e.chain().focus().setHorizontalRule().run())}
            />

            <span aria-hidden="true" className="mx-1 h-6 w-px bg-line" />

            <ToolButton
              label="Insert or edit link"
              icon={<Link2 />}
              pressed={!!state?.link}
              disabled={off}
              onClick={() => setLinkDialogOpen(true)}
            />
            {state?.link ? (
              <ToolButton
                label="Remove link"
                icon={<Unlink />}
                disabled={off}
                onClick={run((e) => e.chain().focus().extendMarkRange("link").unsetLink().run())}
              />
            ) : null}

            <DropdownMenu
              align="start"
              trigger={
                <button
                  type="button"
                  data-rp-doctool=""
                  tabIndex={-1}
                  disabled={off}
                  aria-label="Table actions"
                  className={cn(
                    "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-xs font-semibold text-ink hover:bg-surface-sunken disabled:opacity-50 pointer-coarse:min-h-11 [&_svg]:size-4",
                    state?.inTable && "bg-action-soft text-action",
                  )}
                >
                  <TableIcon aria-hidden="true" />
                  Table
                </button>
              }
              items={[
                {
                  label: "Insert 3x3 table",
                  onSelect: () =>
                    editor
                      ?.chain()
                      .focus()
                      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                      .run(),
                },
                {
                  label: "Add row above",
                  disabled: !state?.inTable,
                  onSelect: () => editor?.chain().focus().addRowBefore().run(),
                },
                {
                  label: "Add row below",
                  disabled: !state?.inTable,
                  onSelect: () => editor?.chain().focus().addRowAfter().run(),
                },
                {
                  label: "Delete row",
                  disabled: !state?.inTable,
                  onSelect: () => editor?.chain().focus().deleteRow().run(),
                },
                {
                  label: "Add column before",
                  disabled: !state?.inTable,
                  onSelect: () => editor?.chain().focus().addColumnBefore().run(),
                },
                {
                  label: "Add column after",
                  disabled: !state?.inTable,
                  onSelect: () => editor?.chain().focus().addColumnAfter().run(),
                },
                {
                  label: "Delete column",
                  disabled: !state?.inTable,
                  onSelect: () => editor?.chain().focus().deleteColumn().run(),
                },
                {
                  label: "Delete table",
                  disabled: !state?.inTable,
                  destructive: true,
                  onSelect: () => editor?.chain().focus().deleteTable().run(),
                },
              ]}
            />

            <span aria-hidden="true" className="mx-1 h-6 w-px bg-line" />

            <ToolButton
              label="Undo"
              icon={<Undo2 />}
              disabled={off || !state?.canUndo}
              onClick={run((e) => e.chain().focus().undo().run())}
            />
            <ToolButton
              label="Redo"
              icon={<Redo2 />}
              disabled={off || !state?.canRedo}
              onClick={run((e) => e.chain().focus().redo().run())}
            />
          </div>
        ) : null}

        <EditorContent editor={editor} />
      </div>

      {editor && linkDialogOpen ? (
        <DocumentLinkDialog editor={editor} onClose={() => setLinkDialogOpen(false)} />
      ) : null}
    </div>
  );
}

function DocumentLinkDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const { from, to, empty } = editor.state.selection;
  const selectedText = editor.state.doc.textBetween(from, to, " ");
  const existingHref = (editor.getAttributes("link").href as string | undefined) ?? "";
  const [url, setUrl] = useState(existingHref);
  const [text, setText] = useState(selectedText);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const needsText = empty && !existingHref;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const target = url.trim();
    if (!isAllowedDocumentHref(target)) {
      setError("Enter a link starting with https:// or mailto:.");
      return;
    }
    if (needsText && !text.trim()) {
      setError("Enter the link text to display in the document.");
      return;
    }
    const chain = editor.chain().focus();
    if (needsText) {
      chain
        .insertContent({
          type: "text",
          text: text.trim(),
          marks: [{ type: "link", attrs: { href: target } }],
        })
        .run();
    } else {
      chain.extendMarkRange("link").setLink({ href: target }).run();
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={existingHref ? "Edit document link" : "Insert document link"}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId}>
            Save link
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
        <Field label="Link address" hint="Must start with https:// or mailto:." required>
          <Input
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        {needsText ? (
          <Field label="Link text" required>
            <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} />
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}
