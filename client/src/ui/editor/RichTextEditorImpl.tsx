/**
 * RichTextEditor on TipTap / ProseMirror (lazy chunk). CSP: created with `injectCSS: false` (TipTap would otherwise
 * add a <style> element); the base rules live in ./editor.css, bundled as a same-origin stylesheet.
 */
import "./editor.css";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { Bold, Braces, Heading2, Heading3, ImageIcon, Italic, Link2, List, ListOrdered, MousePointerClick, Pilcrow, Redo2, Undo2, Unlink } from "lucide-react";
import { useEffect, useId, useRef, useState, type FocusEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Button } from "../Button";
import { cn } from "../cn";
import { Field, Input } from "../Field";
import { Dialog, DropdownMenu } from "../Overlay";
import { editorExtensions } from "./extensions";
import { fromEditorHtml, isAllowedHref, isAllowedImageSrc, toEditorHtml } from "./html";
import type { RichTextEditorProps } from "./types";

type DialogKind = "link" | "button" | "image" | null;

function ToolButton({ label, icon, pressed, disabled, onClick }: { label: string; icon: ReactNode; pressed?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={disabled}
      data-rp-tool=""
      tabIndex={-1}
      // Keep the editor selection when a toolbar button is pressed with the mouse.
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

/** Roving tabindex: one Tab stop for the toolbar, arrows / Home / End move between tools (WAI-ARIA toolbar pattern). */
function useRovingToolbar(ref: RefObject<HTMLDivElement | null>) {
  const tools = () => Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-rp-tool]:not(:disabled)") ?? []);
  const sync = (active?: HTMLElement) => {
    const list = tools();
    const target = active ?? list.find((el) => el.tabIndex === 0) ?? list[0];
    for (const el of list) el.tabIndex = el === target ? 0 : -1;
  };
  useEffect(() => sync());
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = tools();
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
    if ((event.target as HTMLElement).hasAttribute("data-rp-tool")) sync(event.target as HTMLElement);
  };
  return [onKeyDown, onFocus] as const;
}

function useToolState(editor: Editor | null) {
  return useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            h2: e.isActive("heading", { level: 2 }),
            h3: e.isActive("heading", { level: 3 }),
            paragraph: e.isActive("paragraph"),
            bullet: e.isActive("bulletList"),
            ordered: e.isActive("orderedList"),
            link: e.isActive("link"),
            button: e.isActive("rpButton"),
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
          }
        : null,
  });
}

export default function RichTextEditorImpl({ label, hint, error, required, id, value, onChange, variables = [], disabled }: RichTextEditorProps) {
  const autoId = useId();
  const editorId = id ?? `${autoId}-editor`;
  const labelId = `${autoId}-label`;
  const hintId = hint ? `${autoId}-hint` : undefined;
  const errorId = error ? `${autoId}-error` : undefined;
  const lastEmitted = useRef<string>(value);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [onToolbarKeyDown, onToolbarFocus] = useRovingToolbar(toolbarRef);

  const editor = useEditor({
    extensions: editorExtensions(),
    content: toEditorHtml(value),
    injectCSS: false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editable: !disabled,
    editorProps: {
      attributes: {
        id: editorId,
        role: "textbox",
        "aria-multiline": "true",
        "aria-labelledby": labelId,
        ...(hintId || errorId ? { "aria-describedby": [hintId, errorId].filter(Boolean).join(" ") } : {}),
        ...(error ? { "aria-invalid": "true" } : {}),
        ...(required ? { "aria-required": "true" } : {}),
        class: "rp-editor min-h-48 px-3 py-3 text-body",
      },
    },
    onUpdate: ({ editor: e }) => {
      const html = fromEditorHtml(e.getHTML());
      if (html === lastEmitted.current) return;
      lastEmitted.current = html;
      onChange(html);
    },
  });

  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    lastEmitted.current = value;
    editor.commands.setContent(toEditorHtml(value), { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    if (editor && editor.isEditable === !!disabled) editor.setEditable(!disabled, false);
  }, [editor, disabled]);

  const state = useToolState(editor);
  const run = (fn: (e: Editor) => void) => () => {
    if (editor) fn(editor);
  };
  const off = disabled || !editor;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium text-ink">
        {label}
        {required ? <span aria-hidden="true" className="text-danger"> *</span> : null}
      </span>
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      <div className={cn("min-w-0 rounded-[var(--radius-control)] border bg-surface focus-within:ring-2 focus-within:ring-action", error ? "border-danger" : "border-control-border", disabled && "opacity-60")}>
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label={`${label}: formatting`}
          aria-controls={editorId}
          onKeyDown={onToolbarKeyDown}
          onFocus={onToolbarFocus}
          className="flex flex-wrap items-center gap-0.5 border-b border-line p-1"
        >
          <ToolButton label="Paragraph" icon={<Pilcrow />} pressed={!!state?.paragraph} disabled={off} onClick={run((e) => e.chain().focus().setParagraph().run())} />
          <ToolButton label="Heading 2" icon={<Heading2 />} pressed={!!state?.h2} disabled={off} onClick={run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())} />
          <ToolButton label="Heading 3" icon={<Heading3 />} pressed={!!state?.h3} disabled={off} onClick={run((e) => e.chain().focus().toggleHeading({ level: 3 }).run())} />
          <span aria-hidden="true" className="mx-1 h-6 w-px bg-line" />
          <ToolButton label="Bold" icon={<Bold />} pressed={!!state?.bold} disabled={off} onClick={run((e) => e.chain().focus().toggleBold().run())} />
          <ToolButton label="Italic" icon={<Italic />} pressed={!!state?.italic} disabled={off} onClick={run((e) => e.chain().focus().toggleItalic().run())} />
          <ToolButton label="Bulleted list" icon={<List />} pressed={!!state?.bullet} disabled={off} onClick={run((e) => e.chain().focus().toggleBulletList().run())} />
          <ToolButton label="Numbered list" icon={<ListOrdered />} pressed={!!state?.ordered} disabled={off} onClick={run((e) => e.chain().focus().toggleOrderedList().run())} />
          <span aria-hidden="true" className="mx-1 h-6 w-px bg-line" />
          <ToolButton label="Link" icon={<Link2 />} pressed={!!state?.link} disabled={off} onClick={() => setDialog("link")} />
          {state?.link ? <ToolButton label="Remove link" icon={<Unlink />} disabled={off} onClick={run((e) => e.chain().focus().extendMarkRange("link").unsetLink().run())} /> : null}
          <ToolButton label="Button" icon={<MousePointerClick />} pressed={!!state?.button} disabled={off} onClick={() => setDialog("button")} />
          <ToolButton label="Image" icon={<ImageIcon />} disabled={off} onClick={() => setDialog("image")} />
          {variables.length > 0 ? (
            <DropdownMenu
              align="start"
              trigger={
                <button
                  type="button"
                  data-rp-tool=""
                  tabIndex={-1}
                  disabled={off}
                  className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-sm font-medium text-ink hover:bg-surface-sunken disabled:opacity-50 pointer-coarse:min-h-11 [&_svg]:size-4"
                >
                  <Braces aria-hidden={true} />
                  Insert variable
                </button>
              }
              items={variables.map((variable) => ({
                label: (
                  <span className="flex flex-col">
                    <span>{variable.label}</span>
                    <span className="font-mono text-xs text-muted">{`{{${variable.name}}}`}{variable.required ? " · required" : ""}</span>
                  </span>
                ),
                onSelect: () => editor?.chain().focus().insertVariable(variable.name).run(),
              }))}
            />
          ) : null}
          <span aria-hidden="true" className="mx-1 h-6 w-px bg-line" />
          <ToolButton label="Undo" icon={<Undo2 />} disabled={off || !state?.canUndo} onClick={run((e) => e.chain().focus().undo().run())} />
          <ToolButton label="Redo" icon={<Redo2 />} disabled={off || !state?.canRedo} onClick={run((e) => e.chain().focus().redo().run())} />
        </div>
        <EditorContent editor={editor} />
      </div>
      {error ? (
        <p id={errorId} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
      {editor && dialog ? <InsertDialog kind={dialog} editor={editor} variables={variables.map((v) => v.name)} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function InsertDialog({ kind, editor, variables, onClose }: { kind: Exclude<DialogKind, null>; editor: Editor; variables: string[]; onClose: () => void }) {
  const { from, to, empty } = editor.state.selection;
  const selectedText = editor.state.doc.textBetween(from, to, " ");
  const existing = kind === "link" ? (editor.getAttributes("link").href as string | undefined) : kind === "button" ? (editor.getAttributes("rpButton").href as string | undefined) : undefined;
  const [url, setUrl] = useState(existing ?? "");
  const [text, setText] = useState(selectedText);
  const [alt, setAlt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const needsText = kind === "button" || (kind === "link" && empty);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = url.trim();
    if (kind === "image") {
      if (!isAllowedImageSrc(target)) return setError("Enter an image address that starts with https://.");
      if (!alt.trim()) return setError("Describe the image for people who cannot see it.");
      editor.chain().focus().setImage({ src: target, alt: alt.trim() }).run();
      return onClose();
    }
    if (!isAllowedHref(target)) return setError("Enter an address that starts with https:// or mailto:, or a variable such as {{resetLink}}.");
    if (needsText && !text.trim()) return setError("Enter the text to show.");
    const chain = editor.chain().focus();
    if (kind === "link") {
      if (empty) chain.insertContent({ type: "text", text: text.trim(), marks: [{ type: "link", attrs: { href: target } }] }).run();
      else chain.extendMarkRange("link").setLink({ href: target }).run();
    } else {
      chain
        .insertContent({ type: "text", text: text.trim(), marks: [{ type: "rpButton", attrs: { href: target } }] })
        .run();
    }
    onClose();
  };

  const title = kind === "image" ? "Insert image" : kind === "button" ? "Insert button" : existing ? "Edit link" : "Insert link";
  const urlHint =
    kind === "image"
      ? "Images are loaded by the recipient's mail program from this https:// address."
      : `https://…, mailto:… or a variable${variables.length ? ` (${variables.slice(0, 3).map((v) => `{{${v}}}`).join(", ")}${variables.length > 3 ? ", …" : ""})` : ""}.`;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId}>
            {kind === "image" ? "Insert image" : kind === "button" ? "Insert button" : "Save link"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
        <Field label={kind === "image" ? "Image address" : "Address"} hint={urlHint} required>
          <Input type="text" inputMode="url" autoComplete="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        {needsText ? (
          <Field label={kind === "button" ? "Button text" : "Link text"} required>
            <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={120} />
          </Field>
        ) : null}
        {kind === "image" ? (
          <Field label="Description (alt text)" required>
            <Input value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={250} />
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}
