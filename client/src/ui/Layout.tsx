import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Optional heading rendered as h2 (or `headingLevel`). */
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned header content (buttons, badges). */
  actions?: ReactNode;
  footer?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  /** Remove body padding (e.g. to host a DataTable edge-to-edge). */
  flush?: boolean;
  as?: "div" | "section" | "article";
}

export function Card({ title, description, actions, footer, headingLevel = 2, flush, as: As = "div", className, children, ...rest }: CardProps) {
  const H = `h${headingLevel}` as const;
  return (
    <As className={cn("min-w-0 rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)] rp-forced-border", className)} {...rest}>
      {title || actions ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title ? <H className="text-base font-semibold text-ink">{title}</H> : null}
            {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn(!flush && "p-4 sm:p-5")}>{children}</div>
      {footer ? <div className="border-t border-line px-4 py-3 sm:px-5">{footer}</div> : null}
    </As>
  );
}

export interface PageHeaderProps {
  /** The page's single <h1>. */
  title: ReactNode;
  description?: ReactNode;
  /** Primary page actions; wrap below the title on small screens. */
  actions?: ReactNode;
  /** Usually <Breadcrumbs/>. */
  breadcrumbs?: ReactNode;
  /** Small content beside the title (e.g. a StatusBadge). */
  meta?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, breadcrumbs, meta, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-6 flex flex-col gap-3", className)}>
      {breadcrumbs}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-ink break-words sm:text-[1.75rem]">{title}</h1>
            {meta}
          </div>
          {description ? <p className="mt-1 max-w-[70ch] text-[0.9375rem] text-body">{description}</p> : null}
        </div>
        {actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
}

/** Titled page region (<section aria-labelledby>). */
export function Section({ title, description, actions, headingLevel = 2, className, children, id, ...rest }: SectionProps) {
  const H = `h${headingLevel}` as const;
  const headingId = `${id ?? "sec"}-${String(title).replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40)}-h`;
  return (
    <section aria-labelledby={headingId} id={id} className={cn("min-w-0 py-2", className)} {...rest}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <H id={headingId} className={headingLevel === 2 ? "text-lg font-semibold" : "text-base font-semibold"}>
            {title}
          </H>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** Span both columns on wide layouts. */
  wide?: boolean;
}
export interface KeyValueListProps {
  items: readonly KeyValueItem[];
  columns?: 1 | 2 | 3;
  className?: string;
}
/** Semantic <dl> of label/value pairs; one column on mobile. */
export function KeyValueList({ items, columns = 2, className }: KeyValueListProps) {
  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-4", columns >= 2 && "sm:grid-cols-2", columns === 3 && "lg:grid-cols-3", className)}>
      {items.map((item, index) => (
        <div key={index} className={cn("min-w-0", item.wide && "sm:col-span-full")}>
          <dt className="text-xs font-medium tracking-wide text-muted uppercase">{item.label}</dt>
          <dd className="mt-1 text-[0.9375rem] break-words text-ink">{item.value ?? <span className="text-muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

