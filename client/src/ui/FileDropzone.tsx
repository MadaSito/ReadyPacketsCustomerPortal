/**
 * File picker + drag-and-drop zone. The visible control is a real <button> that opens the native picker
 * (keyboard + AT complete); drag-and-drop is an enhancement. Client checks (size/type) are guidance only —
 * the server re-validates content type, size and scanning.
 */
import { Upload } from "lucide-react";
import { useId, useRef, useState, type DragEvent } from "react";
import { cn } from "./cn";

export interface FileDropzoneProps {
  onFiles: (files: File[]) => void;
  /** e.g. ".pdf,.docx,image/*" */
  accept?: string;
  multiple?: boolean;
  /** Bytes; files above are rejected with a message. */
  maxSize?: number;
  disabled?: boolean;
  label?: string;
  hint?: string;
  className?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileDropzone({ onFiles, accept, multiple = true, maxSize, disabled, label = "Choose files", hint, className }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const id = useId().replace(/:/g, "");

  const accept_ = (list: FileList | null) => {
    if (!list) return;
    const files = Array.from(list);
    const tooBig = maxSize ? files.filter((f) => f.size > maxSize) : [];
    const ok = files.filter((f) => !tooBig.includes(f));
    setMessage(tooBig.length ? `${tooBig.length} file(s) exceed the ${formatBytes(maxSize!)} limit and were not added.` : ok.length ? `${ok.length} file(s) selected.` : null);
    if (ok.length) onFiles(multiple ? ok : ok.slice(0, 1));
    if (inputRef.current) inputRef.current.value = "";
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled) accept_(event.dataTransfer.files);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "flex flex-col items-center gap-3 rounded-[var(--radius-card)] border-2 border-dashed border-control-border bg-surface px-4 py-8 text-center transition-colors",
        dragging && "border-action bg-action-soft",
        disabled && "opacity-60",
        className,
      )}
    >
      <span className="inline-flex size-12 items-center justify-center rounded-full bg-action-soft text-action">
        <Upload aria-hidden="true" className="size-6" />
      </span>
      <div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          aria-describedby={`${id}-hint`}
          className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] bg-action px-4 font-semibold text-on-action hover:bg-action-hover disabled:cursor-not-allowed"
        >
          {label}
        </button>
        <p id={`${id}-hint`} className="mt-2 text-sm text-muted">
          <span className="hidden sm:inline">or drag and drop here. </span>
          {hint}
          {maxSize ? ` Up to ${formatBytes(maxSize)} each.` : ""}
        </p>
      </div>
      <input ref={inputRef} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" accept={accept} multiple={multiple} disabled={disabled} onChange={(e) => accept_(e.target.files)} />
      <p role="status" className="text-sm text-ink">
        {message}
      </p>
    </div>
  );
}
