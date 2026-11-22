/**
 * Increment 04 inputs: CopyField (read-only value + copy, optional masked secret) and TagInput.
 */
import { Eye, EyeOff, X } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "./cn";
import { CopyButton } from "./Data";
import { Field, Input } from "./Field";

export interface CopyFieldProps {
  label: string;
  value: string;
  hint?: ReactNode;
  monospace?: boolean;
  /** Accessible name of the copy button; defaults to "Copy <label>". */
  copyLabel?: string;
  /** Mask the value until "Show" is pressed (one-time API keys, webhook secrets). */
  secret?: boolean;
  className?: string;
}

export function CopyField({ label, value, hint, monospace, copyLabel, secret, className }: CopyFieldProps) {
  const [shown, setShown] = useState(false);
  const masked = secret && !shown;
  return (
    <Field label={label} hint={hint} className={className}>
      <CopyFieldControl value={value} masked={Boolean(masked)} monospace={monospace}>
        {secret ? (
          <button
            type="button"
            aria-label={`${shown ? "Hide" : "Show"} ${label}`}
            onClick={() => setShown((s) => !s)}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border border-control-border bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-sunken"
          >
            {shown ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
            {shown ? "Hide" : "Show"}
          </button>
        ) : null}
        <CopyButton value={value} label={copyLabel ?? `Copy ${label.toLowerCase()}`} size="md" className="shrink-0" />
      </CopyFieldControl>
    </Field>
  );
}

function CopyFieldControl({ value, masked, monospace, children }: { value: string; masked: boolean; monospace?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      <Input
        readOnly
        value={masked ? "•".repeat(Math.min(24, Math.max(8, value.length))) : value}
        onFocus={(event) => event.currentTarget.select()}
        className={cn("min-w-0 flex-1 basis-48", monospace && "font-mono text-sm")}
        spellCheck={false}
        autoComplete="off"
      />
      {children}
    </div>
  );
}

export interface TagInputProps {
  label: string;
  value: readonly string[];
  onValueChange: (value: string[]) => void;
  max?: number;
  /** Per tag; default 40. */
  maxLength?: number;
  suggestions?: readonly string[];
  /** Return an error message to refuse a tag. */
  validate?: (tag: string) => string | null;
  /** Default: trim and lower-case. */
  normalize?: (tag: string) => string;
  hint?: ReactNode;
  error?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

const defaultNormalize = (tag: string) => tag.trim().toLowerCase();

export function TagInput({ label, value, onValueChange, max, maxLength = 40, suggestions, validate, normalize = defaultNormalize, hint, error, placeholder, disabled, className }: TagInputProps) {
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = `tags${useId().replace(/:/g, "")}`;
  const full = max !== undefined && value.length >= max;

  const add = (raw: string): boolean => {
    const tag = normalize(raw);
    if (!tag) return false;
    if (tag.length > maxLength) return refuse(`A tag can be at most ${maxLength} characters.`);
    if (value.includes(tag)) return refuse(`"${tag}" is already added.`);
    if (full) return refuse(`You can add at most ${max} tags.`);
    const invalid = validate?.(tag);
    if (invalid) return refuse(invalid);
    onValueChange([...value, tag]);
    setLocalError(null);
    setAnnouncement(`Added ${tag}.`);
    setDraft("");
    return true;
  };
  const refuse = (message: string) => {
    setLocalError(message);
    return false;
  };
  const remove = (tag: string) => {
    onValueChange(value.filter((t) => t !== tag));
    setAnnouncement(`Removed ${tag}.`);
    inputRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      if (!draft.trim()) {
        if (event.key === ",") event.preventDefault();
        return;
      }
      event.preventDefault();
      add(draft);
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      const last = value[value.length - 1];
      if (last) remove(last);
    }
  };

  const shownError = error ?? localError;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Field label={label} hint={hint ?? "Press Enter or comma to add a tag."} error={shownError}>
        <Input
          ref={inputRef}
          value={draft}
          disabled={disabled || full}
          placeholder={full ? `Maximum of ${max} tags reached` : placeholder}
          maxLength={maxLength + 1}
          onChange={(event) => {
            setDraft(event.target.value);
            if (localError) setLocalError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => draft.trim() && add(draft)}
          list={suggestions?.length ? `${listId}-suggestions` : undefined}
          autoComplete="off"
        />
      </Field>
      {suggestions?.length ? (
        <datalist id={`${listId}-suggestions`}>
          {suggestions.filter((s) => !value.includes(s)).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
      {value.length ? (
        <ul aria-label={`${label}: ${value.length} added`} className="flex min-w-0 flex-wrap gap-1.5">
          {value.map((tag) => (
            <li key={tag} className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-line bg-surface-sunken py-0.5 pr-0.5 pl-2.5 text-sm text-ink">
              <span className="min-w-0 truncate">{tag}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(tag)}
                aria-label={`Remove tag ${tag}`}
                className="rp-target inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-ink"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
