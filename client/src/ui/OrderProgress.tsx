/**
 * Increment 07 D3: the order progress bar and phase stepper the customer sees first.
 *
 * - `role="progressbar"` with aria-valuenow/min/max and aria-valuetext ("40 percent, phase 2 of 5: Intake").
 * - The number is always visible as text; phase state is given by icon + text, never colour alone.
 * - Smooth fill and count-up; no animation at all with `prefers-reduced-motion: reduce`.
 * - A canceled order shows its last value frozen, with the word "Canceled".
 * - Display only: the server calculates the percentage (orders D3) and decides the current phase.
 */
import { Ban, CheckCircle2, Circle, CircleDot, Lock, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "./cn";

export type OrderProgressStageState = "done" | "current" | "upcoming" | "locked";

export interface OrderProgressStage {
  key: string;
  /** Customer-facing phase label (customer pages) or staff label (console). */
  label: string;
  /** Optional override; by default stages before `currentIndex` are done and after it upcoming. */
  state?: OrderProgressStageState;
  /** Short visible note under the label, e.g. why a future phase is not open yet ("Opens after Intake is reviewed"). */
  note?: string;
}

export interface OrderProgressProps {
  /** Shown percentage 0–100 (orders.progress_percent). Rounded and clamped for display. */
  percent: number;
  stages: readonly OrderProgressStage[];
  /** 0-based index of the current phase; -1 when there is none (for example a fully closed order). */
  currentIndex: number;
  /** Freezes the bar and says "Canceled". */
  canceled?: boolean;
  /**
   * `full`: bar, number, current-phase line and stepper (order page, console).
   * `compact`: bar, number and current-phase line only (order list rows, dashboard cards).
   */
  variant?: "full" | "compact";
  /** Accessible name of the progress bar. */
  label?: string;
  /** Heading-like caption above the bar (visual); defaults to "Progress". Pass null to hide. */
  caption?: string | null;
  /** When set, completed phases in the stepper are buttons (review a completed phase). */
  onStageSelect?: (key: string) => void;
  className?: string;
}

const STATE_META: Record<OrderProgressStageState, { icon: LucideIcon; text: string }> = {
  done: { icon: CheckCircle2, text: "completed" },
  current: { icon: CircleDot, text: "current phase" },
  upcoming: { icon: Circle, text: "not started" },
  locked: { icon: Lock, text: "locked" },
};

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function stageStates(stages: readonly OrderProgressStage[], currentIndex: number, percent: number): OrderProgressStageState[] {
  const allDone = currentIndex < 0 && clampPercent(percent) >= 100;
  return stages.map((stage, index) => {
    if (stage.state) return stage.state;
    if (allDone) return "done";
    if (currentIndex < 0) return "upcoming";
    return index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
  });
}

/** "40 percent, phase 2 of 5: Intake" (+ ", canceled"). Exported so tests and hosts can match it. */
export function progressValueText({ percent, stages, currentIndex, canceled }: Pick<OrderProgressProps, "percent" | "stages" | "currentIndex" | "canceled">): string {
  const value = `${clampPercent(percent)} percent`;
  const current = currentIndex >= 0 ? stages[currentIndex] : undefined;
  const phase = current ? `, phase ${currentIndex + 1} of ${stages.length}: ${current.label}` : clampPercent(percent) >= 100 && stages.length ? ", all phases complete" : "";
  return `${value}${canceled ? ", canceled" : ""}${phase}`;
}

function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.(query).matches));
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

/** Counts from the previously shown value to `target` (ease-out, ~700 ms); shows `target` directly when not animating. */
function useCountUp(target: number, animate: boolean): number {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (!animate || typeof window.requestAnimationFrame !== "function") {
      from.current = target;
      return;
    }
    const start = from.current;
    if (start === target) return;
    let frame = 0;
    const began = performance.now();
    const duration = 700;
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(start + (target - start) * eased);
      from.current = value;
      setShown(value);
      if (t < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [target, animate]);
  return animate && typeof window !== "undefined" && typeof window.requestAnimationFrame === "function" ? shown : target;
}

export function OrderProgress({ percent, stages, currentIndex, canceled = false, variant = "full", label = "Order progress", caption = "Progress", onStageSelect, className }: OrderProgressProps) {
  const target = clampPercent(percent);
  const reduced = usePrefersReducedMotion();
  // A canceled order is frozen: no count-up, no fill animation.
  const animate = !reduced && !canceled;
  const shown = useCountUp(target, animate);
  const fill = useRef<HTMLDivElement>(null);
  const [painted, setPainted] = useState(false);
  const filled = !animate || painted;
  const id = useId();
  const captionId = `${id}-caption`;
  const states = stageStates(stages, currentIndex, target);
  const current = currentIndex >= 0 ? stages[currentIndex] : undefined;
  // "All phases complete" only when no phase is current: an explicit 100 can coexist with an open phase.
  const complete = !canceled && target >= 100 && !current;

  // Start the fill at 0 and transition to the value after first paint (so the first view also animates).
  useEffect(() => {
    if (!animate || typeof window.requestAnimationFrame !== "function") return;
    const frame = window.requestAnimationFrame(() => setPainted(true));
    return () => window.cancelAnimationFrame(frame);
  }, [animate]);
  useEffect(() => {
    // CSSOM write (allowed by the CSP, unlike a style element); the width is data, not a colour.
    fill.current?.style.setProperty("--rp-progress", `${filled ? target : 0}%`);
  }, [filled, target]);

  const statusLine = canceled
    ? current ? `Canceled during ${current.label}` : "Canceled"
    : complete ? "All phases complete"
    : current ? `Phase ${currentIndex + 1} of ${stages.length}: ${current.label}` : stages.length ? "Not started" : null;

  return (
    <div className={cn("@container min-w-0", className)} data-variant={variant} data-canceled={canceled || undefined}>
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          {caption ? <p id={captionId} className="text-xs font-semibold tracking-wide text-muted uppercase">{caption}</p> : null}
          {statusLine ? (
            <p className="text-sm font-medium break-words text-ink [overflow-wrap:anywhere]">
              {canceled ? <Ban aria-hidden="true" className="mr-1 inline size-4 align-[-0.15em] text-danger" /> : null}
              {statusLine}
            </p>
          ) : null}
        </div>
        <p aria-hidden="true" className={cn("shrink-0 text-2xl leading-none font-semibold tabular-nums text-ink", variant === "compact" && "text-lg")}>
          {shown}
          <span className="ml-0.5 text-sm font-medium text-muted">%</span>
        </p>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={target}
        aria-valuetext={progressValueText({ percent: target, stages, currentIndex, canceled })}
        className={cn(
          "rp-progress-track relative mt-2 overflow-hidden rounded-full bg-surface-sunken rp-forced-border",
          variant === "compact" ? "h-2" : "h-3",
        )}
      >
        <div
          ref={fill}
          className={cn(
            "rp-progress-fill h-full rounded-full",
            canceled ? "rp-progress-fill-canceled bg-muted" : complete ? "bg-success" : "bg-action",
            animate && "rp-progress-animate",
          )}
        />
      </div>
      {variant === "full" && stages.length ? (
        <ol aria-label="Order phases" className={cn("rp-progress-steps mt-4 grid min-w-0 gap-2", stages.length <= 7 ? "@xl:auto-cols-fr @xl:grid-flow-col @xl:gap-1" : "@md:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]")}>
          {stages.map((stage, index) => {
            const state = states[index]!;
            const meta = STATE_META[state];
            const Icon = meta.icon;
            const body = (
              <>
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                    state === "done" && "border-success bg-success-soft text-success",
                    state === "current" && "border-action bg-action text-on-action",
                    state === "upcoming" && "border-line bg-surface text-muted",
                    state === "locked" && "border-line bg-surface-sunken text-muted",
                  )}
                >
                  {state === "current" ? index + 1 : <Icon className="size-4" />}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className={cn("text-sm break-words [overflow-wrap:anywhere]", state === "current" ? "font-semibold text-ink" : state === "done" ? "font-medium text-ink" : "text-body")}>
                    <span className="sr-only">Phase {index + 1} of {stages.length}: </span>
                    {stage.label}
                    <span className="sr-only">, {meta.text}</span>
                  </span>
                  <span aria-hidden="true" className="text-xs text-muted @xl:hidden">{state === "current" ? "Current" : state === "done" ? "Completed" : state === "locked" ? "Locked" : "Not started"}</span>
                  {stage.note ? <span className="text-xs break-words text-muted [overflow-wrap:anywhere]">{stage.note}</span> : null}
                </span>
              </>
            );
            return (
              <li
                key={stage.key}
                aria-current={state === "current" ? "step" : undefined}
                className={cn(
                  "rp-progress-step relative flex min-w-0 items-start gap-2 @xl:flex-col @xl:items-center @xl:text-center",
                  state === "current" && "rp-progress-step-current",
                )}
                data-state={state}
              >
                {onStageSelect && state === "done" ? (
                  <button
                    type="button"
                    onClick={() => onStageSelect(stage.key)}
                    className="flex min-h-11 min-w-0 items-start gap-2 rounded-[var(--radius-control)] text-left hover:underline @xl:flex-col @xl:items-center @xl:text-center"
                  >
                    {body}
                    <span className="sr-only"> (review)</span>
                  </button>
                ) : (
                  <span className="flex min-w-0 items-start gap-2 @xl:flex-col @xl:items-center">{body}</span>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
