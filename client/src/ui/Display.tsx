/**
 * Increment 04 display components: StatCard / StatGrid, Timeline, Pagination, CodeSamples.
 */
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import type { Tone } from "./Badge";
import { Button } from "./Button";
import { cn } from "./cn";
import { CodeBlock, DateTime } from "./Data";
import { Skeleton } from "./Feedback";
import { Tabs } from "./Navigation";

const TONE_ICON: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-ink",
  info: "bg-info-soft text-info",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  brand: "bg-action-soft text-action",
};

export interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  /** Decoration of the icon only; the label and value carry the meaning. */
  tone?: Tone;
  /** Makes the whole card one link (its name is the label and value). */
  href?: string;
  loading?: boolean;
  className?: string;
}

export function StatCard({ label, value, hint, icon: Icon, tone = "neutral", href, loading, className }: StatCardProps) {
  const content = (
    <dl className="flex min-w-0 flex-col gap-1">
      <dt className="flex items-center gap-2 text-sm font-medium text-muted">
        {Icon ? (
          <span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-full", TONE_ICON[tone])}>
            <Icon aria-hidden="true" className="size-4" />
          </span>
        ) : null}
        <span className="min-w-0 break-words">{label}</span>
      </dt>
      <dd className="rp-fluid-stat min-w-0 font-semibold break-words text-ink tabular-nums">{loading ? <Skeleton className="h-7 w-20" /> : value}</dd>
      {hint ? <dd className="text-xs break-words text-muted">{hint}</dd> : null}
    </dl>
  );
  const box = "block min-w-0 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)] rp-forced-border";
  if (href) {
    return (
      <Link href={href} className={cn(box, "hover:border-action", className)}>
        {content}
      </Link>
    );
  }
  return <div className={cn(box, className)}>{content}</div>;
}

/** Responsive grid for StatCards, by container width: 1 → 2 → 4 columns. */
export function StatGrid({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <section aria-label={label} className={cn("@container min-w-0", className)}>
      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @3xl:grid-cols-4">{children}</div>
    </section>
  );
}

export interface TimelineItem {
  key: string;
  title: ReactNode;
  time: Date | string;
  description?: ReactNode;
  actor?: string;
  icon?: LucideIcon;
  tone?: Tone;
}

export interface TimelineProps {
  label: string;
  items: readonly TimelineItem[];
  /** Items are rendered in the given order; this only sets the list's description for assistive technology. */
  order?: "newest-first" | "oldest-first";
  className?: string;
}

export function Timeline({ label, items, order = "newest-first", className }: TimelineProps) {
  return (
    <ol aria-label={`${label}, ${order === "newest-first" ? "newest first" : "oldest first"}`} className={cn("relative flex min-w-0 flex-col", className)}>
      {items.map((item, index) => {
        const Icon = item.icon;
        const last = index === items.length - 1;
        return (
          <li key={item.key} className="relative flex min-w-0 gap-3 pb-5 last:pb-0">
            {!last ? <span aria-hidden="true" className="absolute top-8 bottom-0 left-4 w-px bg-line" /> : null}
            <span aria-hidden="true" className={cn("relative inline-flex size-8 shrink-0 items-center justify-center rounded-full", TONE_ICON[item.tone ?? "neutral"])}>
              {Icon ? <Icon className="size-4" /> : <span className="size-2 rounded-full bg-current" />}
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <p className="text-sm font-medium break-words text-ink">{item.title}</p>
              <p className="text-xs text-muted">
                <DateTime value={item.time} />
                {item.actor ? <> · {item.actor}</> : null}
              </p>
              {item.description ? <div className="mt-1 text-sm break-words text-body">{item.description}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

interface PaginationBase {
  /** Accessible name of the navigation, e.g. "Orders pages". */
  label: string;
  /** e.g. "Showing 26–50 of 112"; announced politely. */
  summary?: string;
  loading?: boolean;
  className?: string;
}
export type PaginationProps = PaginationBase &
  (
    | { hasPrevious: boolean; hasNext: boolean; onPrevious: () => void; onNext: () => void; page?: never; pageCount?: never; onPageChange?: never }
    | { page: number; pageCount: number; onPageChange: (page: number) => void; hasPrevious?: never; hasNext?: never; onPrevious?: never; onNext?: never }
  );

/** Page numbers to draw: first, last, current ± 1, with gaps (null). */
export function pageWindow(page: number, pageCount: number): (number | null)[] {
  const pages = new Set([1, pageCount, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pageCount));
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((n, i) => {
    const prev = sorted[i - 1];
    if (i > 0 && prev !== undefined && n - prev > 1) out.push(null);
    out.push(n);
  });
  return out;
}

export function Pagination(props: PaginationProps) {
  const { label, summary, loading, className } = props;
  const paged = props.page !== undefined;
  const hasPrevious = paged ? props.page > 1 : props.hasPrevious;
  const hasNext = paged ? props.page < props.pageCount : props.hasNext;
  const previous = () => (paged ? props.onPageChange(props.page - 1) : props.onPrevious());
  const next = () => (paged ? props.onPageChange(props.page + 1) : props.onNext());
  return (
    <nav aria-label={label} className={cn("flex min-w-0 flex-wrap items-center justify-between gap-3", className)}>
      <p role="status" className="text-sm text-muted">
        {summary ?? (paged ? `Page ${props.page} of ${props.pageCount}` : "")}
      </p>
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="secondary" size="sm" disabled={!hasPrevious || loading} onClick={previous} leadingIcon={<ChevronLeft aria-hidden="true" />}>
          Previous<span className="sr-only"> page</span>
        </Button>
        {paged ? (
          <ul className="hidden items-center gap-1 sm:flex">
            {pageWindow(props.page, props.pageCount).map((n, i) =>
              n === null ? (
                <li key={`gap-${i}`} aria-hidden="true" className="px-1 text-muted">
                  …
                </li>
              ) : (
                <li key={n}>
                  <button
                    type="button"
                    aria-current={n === props.page ? "page" : undefined}
                    aria-label={`Page ${n}`}
                    disabled={loading}
                    onClick={() => n !== props.page && props.onPageChange(n)}
                    className={cn("rp-target inline-flex min-h-9 min-w-9 items-center justify-center rounded-[var(--radius-control)] text-sm font-medium text-body hover:bg-surface-sunken", n === props.page && "bg-action-soft text-action")}
                  >
                    {n}
                  </button>
                </li>
              ),
            )}
          </ul>
        ) : null}
        <Button variant="secondary" size="sm" disabled={!hasNext || loading} onClick={next} trailingIcon={<ChevronRight aria-hidden="true" />}>
          Next<span className="sr-only"> page</span>
        </Button>
      </div>
    </nav>
  );
}

export interface CodeSample {
  key: string;
  label: string;
  code: string;
  language?: string;
}
export interface CodeSamplesProps {
  /** Name of the tab list, e.g. "Create an order: examples". */
  label: string;
  samples: readonly CodeSample[];
  defaultKey?: string;
  className?: string;
}

/** Tabs of copyable code blocks (API examples). Plain text only: no highlighting, no inline styles. */
export function CodeSamples({ label, samples, defaultKey, className }: CodeSamplesProps) {
  return (
    <Tabs
      label={label}
      className={className}
      defaultValue={defaultKey ?? samples[0]?.key}
      items={samples.map((sample) => ({
        value: sample.key,
        label: sample.label,
        content: (
          <CodeBlock label={`${sample.label} example`} language={sample.language} copyable>
            {sample.code}
          </CodeBlock>
        ),
      }))}
    />
  );
}
