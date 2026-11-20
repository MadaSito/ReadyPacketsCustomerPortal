import { Ban, CheckCircle2, CircleDashed, CircleHelp, Clock, Loader2, XCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { OperationState } from "@shared/domain";
import { cn } from "./cn";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "brand";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-ink border-line",
  info: "bg-info-soft text-info border-info/30",
  success: "bg-success-soft text-success border-success/30",
  warning: "bg-warning-soft text-warning border-warning/30",
  danger: "bg-danger-soft text-danger border-danger/30",
  brand: "bg-action-soft text-action border-action/30",
};

export interface BadgeProps {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Small status pill. Always carries text; add an icon when meaning is status (never colour alone). */
export function Badge({ tone = "neutral", icon, children, className }: BadgeProps) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0", tones[tone], className)}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

export const OPERATION_STATE_META: Record<OperationState, { label: string; tone: Tone; icon: LucideIcon }> = {
  queued: { label: "Queued", tone: "neutral", icon: Clock },
  running: { label: "Running", tone: "info", icon: Loader2 },
  completed: { label: "Completed", tone: "success", icon: CheckCircle2 },
  failed: { label: "Failed", tone: "danger", icon: XCircle },
  canceled: { label: "Canceled", tone: "neutral", icon: CircleDashed },
  refused: { label: "Refused", tone: "warning", icon: Ban },
  unknown: { label: "Unknown outcome", tone: "warning", icon: CircleHelp },
};

export interface StatusBadgeProps {
  state: OperationState;
  /** Override the default label (e.g. "Delivered"). */
  label?: string;
  className?: string;
}

/** Truthful operation state with icon + text. `unknown` is shown as unknown, never as failed. */
export function StatusBadge({ state, label, className }: StatusBadgeProps) {
  const meta = OPERATION_STATE_META[state] ?? OPERATION_STATE_META.unknown;
  const Icon = meta.icon;
  return (
    <Badge tone={meta.tone} className={className} icon={<Icon aria-hidden="true" className={cn(state === "running" && "motion-safe:animate-spin")} />}>
      {label ?? meta.label}
    </Badge>
  );
}
