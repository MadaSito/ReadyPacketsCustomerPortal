/**
 * Progress displays: Stepper (generic ordered steps), PhaseRail (order phases with lock state) and Checklist
 * ("what is needed before the next step"). State is always given as an icon and as text, never colour alone.
 */
import { AlertTriangle, Ban, CheckCircle2, Circle, CircleDot, Lock, MinusCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export type StepState = "done" | "current" | "upcoming" | "locked" | "blocked";

export interface StepperStep {
  key: string;
  label: string;
  description?: ReactNode;
  state: StepState;
  /** PhaseRail only: extra content under the label (lock badge, date). */
  meta?: ReactNode;
}

export interface StepperProps {
  /** Accessible name of the list, e.g. "Order phases". */
  label: string;
  steps: readonly StepperStep[];
  /** `auto`: vertical in narrow containers, horizontal from a 40rem-wide container. */
  orientation?: "auto" | "horizontal" | "vertical";
  /** When set, completed steps are buttons that call it. */
  onStepSelect?: (key: string) => void;
  className?: string;
}

const STATE_META: Record<StepState, { icon: LucideIcon; text: string; className: string }> = {
  done: { icon: CheckCircle2, text: "completed", className: "text-success" },
  current: { icon: CircleDot, text: "current", className: "text-action" },
  upcoming: { icon: Circle, text: "not started", className: "text-muted" },
  locked: { icon: Lock, text: "locked", className: "text-muted" },
  blocked: { icon: AlertTriangle, text: "blocked", className: "text-warning" },
};

function StepList({ label, steps, orientation = "auto", onStepSelect, className }: StepperProps) {
  const horizontal = orientation === "horizontal";
  const auto = orientation === "auto";
  return (
    <div className={cn("@container min-w-0", className)}>
      <ol
        aria-label={label}
        className={cn("flex min-w-0 flex-col gap-3", horizontal && "flex-row flex-wrap gap-x-6", auto && "@2xl:flex-row @2xl:flex-wrap @2xl:gap-x-6")}
      >
        {steps.map((step, index) => {
          const meta = STATE_META[step.state];
          const Icon = meta.icon;
          const stateText = meta.text;
          const body = (
            <>
              <Icon aria-hidden="true" className={cn("mt-0.5 size-5 shrink-0", meta.className)} />
              <span className="flex min-w-0 flex-col">
                <span className={cn("text-sm font-medium break-words text-ink", step.state === "upcoming" && "text-body")}>
                  <span className="sr-only">
                    Step {index + 1} of {steps.length}:{" "}
                  </span>
                  {step.label}
                  <span className="sr-only">, {stateText}</span>
                </span>
                {step.description ? <span className="text-xs break-words text-muted">{step.description}</span> : null}
                {step.meta ? <span className="mt-1 text-xs text-muted">{step.meta}</span> : null}
              </span>
            </>
          );
          return (
            <li key={step.key} aria-current={step.state === "current" ? "step" : undefined} className="flex min-w-0">
              {onStepSelect && step.state === "done" ? (
                <button type="button" onClick={() => onStepSelect(step.key)} className="flex min-h-11 min-w-0 items-start gap-2 rounded-[var(--radius-control)] text-left hover:underline">
                  {body}
                </button>
              ) : (
                <span className="flex min-w-0 items-start gap-2">{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function Stepper(props: StepperProps) {
  return <StepList {...props} />;
}

export type PhaseRailProps = StepperProps;

/** Order phases. `locked` phases show a lock icon and the word "locked" for assistive technology. */
export function PhaseRail(props: PhaseRailProps) {
  return <StepList {...props} />;
}

export type ChecklistState = "done" | "todo" | "blocked" | "optional";

export interface ChecklistItem {
  key: string;
  label: ReactNode;
  description?: ReactNode;
  state: ChecklistState;
  /** Next step for this item (button or link). */
  action?: ReactNode;
}

export interface ChecklistProps {
  title: ReactNode;
  headingLevel?: 2 | 3;
  items: readonly ChecklistItem[];
  /** Overrides the computed "2 of 5 done" summary. */
  summary?: string;
  className?: string;
}

const CHECK_META: Record<ChecklistState, { icon: LucideIcon; text: string; className: string }> = {
  done: { icon: CheckCircle2, text: "Done", className: "text-success" },
  todo: { icon: Circle, text: "To do", className: "text-muted" },
  blocked: { icon: Ban, text: "Blocked", className: "text-warning" },
  optional: { icon: MinusCircle, text: "Optional", className: "text-muted" },
};

export function checklistSummary(items: readonly ChecklistItem[]): string {
  const required = items.filter((item) => item.state !== "optional");
  const done = required.filter((item) => item.state === "done").length;
  if (required.length === 0) return "Nothing required";
  return done === required.length ? `All ${required.length} done` : `${done} of ${required.length} done`;
}

export function Checklist({ title, headingLevel = 2, items, summary, className }: ChecklistProps) {
  const H = `h${headingLevel}` as const;
  return (
    <section className={cn("min-w-0 rounded-[var(--radius-card)] border border-line bg-surface p-4 rp-forced-border", className)}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <H className="text-base font-semibold text-ink">{title}</H>
        <p role="status" className="text-sm text-muted">
          {summary ?? checklistSummary(items)}
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {items.map((item) => {
          const meta = CHECK_META[item.state];
          const Icon = meta.icon;
          return (
            <li key={item.key} className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0">
              <Icon aria-hidden="true" className={cn("mt-0.5 size-5 shrink-0", meta.className)} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-words text-ink">
                  <span className="sr-only">{meta.text}: </span>
                  {item.label}
                </p>
                {item.description ? <p className="text-sm break-words text-muted">{item.description}</p> : null}
              </div>
              <span aria-hidden="true" className="text-xs font-medium text-muted">
                {meta.text}
              </span>
              {item.action ? <div className="w-full sm:w-auto">{item.action}</div> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
