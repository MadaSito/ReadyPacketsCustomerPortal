import { AlertTriangle, CheckCircle2, Info, PowerOff, SearchX, Sparkles, XCircle, type LucideIcon } from "lucide-react";
import { QueryClientContext } from "@tanstack/react-query";
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage, safeError } from "@/lib/trpc";
import { Button } from "./Button";
import { cn } from "./cn";
import { isStepUpRequired, useOptionalStepUp } from "./stepUpContext";

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

export type EmptyStateVariant = "default" | "first-use" | "no-results" | "filtered" | "disabled" | "error";
const EMPTY_ICONS: Record<EmptyStateVariant, LucideIcon | undefined> = {
  default: undefined,
  "first-use": Sparkles,
  "no-results": SearchX,
  filtered: SearchX,
  disabled: PowerOff,
  error: AlertTriangle,
};

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Primary next step (e.g. "Start your first order"). */
  action?: ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
  /** Chooses the default icon; `filtered` with `onClearFilters` adds a "Clear filters" button. */
  variant?: EmptyStateVariant;
  size?: "sm" | "md";
  onClearFilters?: () => void;
}
export function EmptyState({ icon, title, description, action, className, headingLevel = 2, variant = "default", size = "md", onClearFilters }: EmptyStateProps) {
  const H = `h${headingLevel}` as const;
  const Icon = icon ?? EMPTY_ICONS[variant];
  const clear =
    variant === "filtered" && onClearFilters ? (
      <button type="button" onClick={onClearFilters} className="inline-flex min-h-11 items-center rounded-[var(--radius-control)] border border-control-border px-4 text-sm font-medium text-ink hover:bg-surface-sunken">
        Clear filters
      </button>
    ) : null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border border-dashed border-control-border bg-surface text-center",
        size === "sm" ? "px-4 py-6" : "px-6 py-10",
        className,
      )}
    >
      {Icon ? (
        <span className={cn("inline-flex items-center justify-center rounded-full bg-action-soft text-action", size === "sm" ? "size-10" : "size-12")}>
          <Icon aria-hidden="true" className={size === "sm" ? "size-5" : "size-6"} />
        </span>
      ) : null}
      <H className="text-base font-semibold break-words text-ink">{title}</H>
      {description ? <p className="max-w-md text-sm break-words text-body">{description}</p> : null}
      {action || clear ? (
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          {clear}
          {action}
        </div>
      ) : null}
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
/**
 * Error panel. Shows only the server's safe message and the request reference.
 * A STEP_UP_REQUIRED error (a read that needs a fresh verification) instead renders a calm "Verification
 * required" prompt whose button opens the step-up dialog and, once verified, retries: `onRetry` when given,
 * otherwise a refetch of the active queries that are in error. Without a StepUpProvider it falls back to
 * the generic panel.
 */
export function ErrorState(props: ErrorStateProps) {
  const stepUp = useOptionalStepUp();
  if (stepUp && isStepUpRequired(props.error)) return <StepUpRequiredState {...props} request={stepUp.request} />;
  return <GenericErrorState {...props} />;
}

export const STEP_UP_REQUIRED_COPY = {
  title: "Verification required",
  body: "For your security, confirm your password and a verification code to view this page.",
  action: "Verify identity",
} as const;

function StepUpRequiredState({ onRetry, className, request }: ErrorStateProps & { request: (o?: { reason?: string }) => Promise<boolean> }) {
  const queryClient = useContext(QueryClientContext);
  const [busy, setBusy] = useState(false);
  const verify = async () => {
    setBusy(true);
    try {
      const ok = await request({ reason: STEP_UP_REQUIRED_COPY.body });
      if (!ok) return;
      if (onRetry) onRetry();
      else void queryClient?.refetchQueries({ type: "active", predicate: (query) => query.state.status === "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Callout
      tone="info"
      live="polite"
      title={STEP_UP_REQUIRED_COPY.title}
      className={className}
      actions={
        <Button size="sm" loading={busy} onClick={() => void verify()}>
          {STEP_UP_REQUIRED_COPY.action}
        </Button>
      }
    >
      <p>{STEP_UP_REQUIRED_COPY.body}</p>
    </Callout>
  );
}

function GenericErrorState({ error, title = "We couldn't load this", message, onRetry, className }: ErrorStateProps) {
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
/**
 * Cursor-pagination control (no infinite scroll — keyboard and AT friendly). When the last page loads, the button
 * disappears; if it was the focused control, focus moves to the summary (or the control's region) instead of being
 * dropped on <body>.
 */
export function LoadMore({ hasMore, loading, onLoadMore, summary, label = "Load more" }: LoadMoreProps) {
  const regionRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const ownedFocus = useRef(false);
  useLayoutEffect(() => {
    if (hasMore || !ownedFocus.current) return;
    ownedFocus.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) return;
    (summaryRef.current ?? regionRef.current)?.focus();
  }, [hasMore]);
  return (
    <div ref={regionRef} tabIndex={-1} className="flex flex-col items-center gap-2 py-4 outline-none">
      {summary ? (
        <p ref={summaryRef} tabIndex={-1} role="status" className="text-sm text-muted outline-none">
          {summary}
        </p>
      ) : null}
      {hasMore ? (
        <Button
          variant="secondary"
          onClick={onLoadMore}
          loading={loading}
          onFocus={() => {
            ownedFocus.current = true;
          }}
          onBlur={(event) => {
            // Keep ownership only while focus is being lost to the unmount (relatedTarget null and still pending).
            if (event.relatedTarget) ownedFocus.current = false;
          }}
        >
          {label}
        </Button>
      ) : null}
    </div>
  );
}
