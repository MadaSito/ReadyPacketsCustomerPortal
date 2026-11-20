import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatMoney, type Money as MoneyValue } from "@shared/domain";
import { Button } from "./Button";
import { cn } from "./cn";
import { useToast } from "./Toast";

export interface CopyButtonProps {
  /** Text placed on the clipboard. Never pass secrets that should not leave the page. */
  value: string;
  /** Accessible label, e.g. "Copy order number". */
  label?: string;
  /** Show only the icon (label stays accessible). */
  iconOnly?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export function CopyButton({ value, label = "Copy", iconOnly, size = "sm", className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.show({ tone: "success", title: "Copied to clipboard" });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.show({ tone: "danger", title: "Copy failed", description: "Your browser blocked clipboard access. Select the text and copy it manually." });
    }
  };
  const icon = copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />;
  return (
    <Button variant="secondary" size={size} onClick={onCopy} aria-label={iconOnly ? label : undefined} title={iconOnly ? label : undefined} className={cn(iconOnly && "px-2.5", className)} leadingIcon={icon}>
      {iconOnly ? null : copied ? "Copied" : label}
    </Button>
  );
}

export interface CodeBlockProps {
  children: string;
  /** Accessible name of the (focusable, scrollable) region. */
  label?: string;
  copyable?: boolean;
  wrap?: boolean;
  className?: string;
}

export function CodeBlock({ children, label = "Code", copyable, wrap, className }: CodeBlockProps) {
  return (
    <div className={cn("relative min-w-0 rounded-[var(--radius-control)] border border-line bg-surface-sunken", className)}>
      {copyable ? (
        <div className="absolute top-1.5 right-1.5">
          <CopyButton value={children} label={`Copy ${label.toLowerCase()}`} iconOnly />
        </div>
      ) : null}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard reachable */}
      <pre tabIndex={0} role="region" aria-label={label} className={cn("max-h-96 overflow-auto p-3 text-sm text-ink", copyable && "pr-14", wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre")}>
        <code>{children}</code>
      </pre>
    </div>
  );
}

export interface DateTimeProps {
  /** Date or ISO string (UTC from the API). */
  value: Date | string | null | undefined;
  /** date → "Nov 20, 2026"; datetime → "+ 3:04 PM"; relative → "5 minutes ago" (absolute in title). */
  format?: "date" | "datetime" | "relative" | "time";
  className?: string;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function formatDateTime(value: Date | string, format: DateTimeProps["format"] = "datetime", now: Date = new Date()): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  if (format === "date") return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  if (format === "time") return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (format === "relative") {
    const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
    const abs = Math.abs(seconds);
    if (abs < 45) return rtf.format(0, "second") === "now" ? "just now" : rtf.format(seconds, "second");
    if (abs < 2700) return rtf.format(Math.round(seconds / 60), "minute");
    if (abs < 79200) return rtf.format(Math.round(seconds / 3600), "hour");
    if (abs < 2592000) return rtf.format(Math.round(seconds / 86400), "day");
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Semantic <time> with machine-readable dateTime and a full absolute title. */
export function DateTime({ value, format = "datetime", className }: DateTimeProps) {
  if (!value) return <span className={cn("text-muted", className)}>—</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return <span className={cn("text-muted", className)}>—</span>;
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })} className={className}>
      {formatDateTime(date, format)}
    </time>
  );
}

export interface MoneyProps {
  value: MoneyValue | null | undefined;
  className?: string;
}
/** Integer minor units + ISO currency → localized amount (tabular figures). */
export function Money({ value, className }: MoneyProps) {
  if (!value) return <span className={cn("text-muted", className)}>—</span>;
  return <span className={cn("tabular-nums", className)}>{formatMoney(value)}</span>;
}

