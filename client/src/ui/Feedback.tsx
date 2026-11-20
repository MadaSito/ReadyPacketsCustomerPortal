import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage, safeError } from "@/lib/trpc";
import { Button } from "./Button";
import { cn } from "./cn";

export type CalloutTone = "info" | "success" | "warning" | "danger";
const calloutStyles: Record<CalloutTone, { box: string; icon: LucideIcon; iconClass: string }> = {
  info: { box: "bg-info-soft border-info/40", icon: Info, iconClass: "text-info" },
  success: { box: "bg-success-soft border-success/40", icon: CheckCircle2, iconClass: "text-success" },
  warning: { box: "bg-warning-soft border-warning/40", icon: AlertTriangle, iconClass: "text-warning" },
  danger: { box: "bg-danger-soft border-danger/40", icon: XCircle, iconClass: "text-danger" },
};

export interface CalloutProps {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** "polite" → role=status, "assertive" → role=alert; omit for static content. */
  live?: "polite" | "assertive";
  className?: string;
}

export function Callout({ tone = "info", title, children, actions, live, className }: CalloutProps) {
  const style = calloutStyles[tone];
  const Icon = style.icon;
  return (
    <div
      role={live === "assertive" ? "alert" : live === "polite" ? "status" : undefined}
      className={cn("flex gap-3 rounded-[var(--radius-card)] border p-4 text-ink rp-forced-border", style.box, className)}
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-5 shrink-0", style.iconClass)} />
      <div className="min-w-0 flex-1 text-sm">
        {title ? <p className="font-semibold text-ink">{title}</p> : null}
        {children ? <div className={cn("text-ink", title && "mt-1")}>{children}</div> : null}
        {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export interface SkeletonProps {
  className?: string;
  /** Number of text lines to render. */
  lines?: number;
}
/** Decorative loading placeholder (aria-hidden). Pair with a status label when it is the only content. */
export function Skeleton({ className, lines }: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <div aria-hidden="true" className="flex flex-col gap-2">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={cn("h-4 animate-pulse rounded bg-surface-sunken", i === lines - 1 && "w-2/3", className)} />
        ))}
      </div>
    );
  }
  return <div aria-hidden="true" className={cn("h-4 animate-pulse rounded bg-surface-sunken", className)} />;
}

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Primary next step (e.g. "Start your first order"). */
  action?: ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
}
export function EmptyState({ icon: Icon, title, description, action, className, headingLevel = 2 }: EmptyStateProps) {
  const H = `h${headingLevel}` as const;
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border border-dashed border-control-border bg-surface px-6 py-10 text-center", className)}>
      {Icon ? (
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-action-soft text-action">
          <Icon aria-hidden="true" className="size-6" />
        </span>
      ) : null}
      <H className="text-base font-semibold text-ink">{title}</H>
      {description ? <p className="max-w-md text-sm text-body">{description}</p> : null}
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  /** A tRPC/unknown error; renders its safe message + request reference. */
  error?: unknown;
  title?: ReactNode;
  message?: ReactNode;
  onRetry?: () => void;
  className?: string;
}
/** Error panel announced politely. Shows only the server's safe message and the request reference. */
export function ErrorState({ error, title = "We couldn't load this", message, onRetry, className }: ErrorStateProps) {
  const safe = safeError(error);
  return (
    <Callout
      tone="danger"
      live="assertive"
      title={title}
      className={className}
      actions={onRetry ? <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button> : undefined}
    >
      <p>{message ?? errorMessage(error)}</p>
      {safe?.requestId && safe.requestId !== "unknown" ? <p className="mt-1 text-xs text-muted">Reference: <code>{safe.requestId}</code></p> : null}
    </Callout>
  );
}

export interface LoadMoreProps {
  hasMore: boolean;
  loading?: boolean;
  onLoadMore: () => void;
  /** e.g. "Showing 25 orders". Announced politely when it changes. */
  summary?: ReactNode;
  label?: string;
}
/** Cursor-pagination control (no infinite scroll — keyboard and AT friendly). */
export function LoadMore({ hasMore, loading, onLoadMore, summary, label = "Load more" }: LoadMoreProps) {
  return (
    <div className="flex flex-col items-center gap-2 py-4">
      {summary ? (
        <p role="status" className="text-sm text-muted">
          {summary}
        </p>
      ) : null}
      {hasMore ? (
        <Button variant="secondary" onClick={onLoadMore} loading={loading}>
          {label}
        </Button>
      ) : null}
    </div>
  );
}
