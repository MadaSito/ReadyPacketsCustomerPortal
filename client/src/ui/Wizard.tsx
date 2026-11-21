import { Check } from "lucide-react";
import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";

export interface WizardStep {
  id: string;
  label: string;
  optional?: boolean;
}

export interface WizardProps {
  steps: WizardStep[];
  /** Id of the current step (controlled). */
  current: string;
  /** Submit of the current step's form. Validate here; do not advance on error. */
  onNext: () => void;
  /** Back; hidden on the first step. */
  onBack?: () => void;
  /** Makes completed steps clickable. */
  onStepSelect?: (id: string) => void;
  completed?: string[];
  /** Default "Continue". */
  nextLabel?: string;
  nextDisabled?: boolean;
  busy?: boolean;
  /** Extra action in the footer, e.g. "Save draft". */
  secondaryAction?: ReactNode;
  /** Fields of the current step (no <form>; the wizard renders it). */
  children: ReactNode;
  className?: string;
}

/**
 * Controlled multi-step form. Progress list with `aria-current="step"`, the step heading receives focus on change,
 * one `<form>` per step and a Back / Continue bar. The parent owns all entered data, so Back never loses it.
 */
export function Wizard({ steps, current, onNext, onBack, onStepSelect, completed = [], nextLabel = "Continue", nextDisabled, busy, secondaryAction, children, className }: WizardProps) {
  const index = Math.max(0, steps.findIndex((step) => step.id === current));
  const step = steps[index];
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const headingId = useId();

  useEffect(() => {
    // Move focus only on step changes, not on first render (the page heading keeps focus then).
    if (mounted.current) headingRef.current?.focus();
    mounted.current = true;
  }, [current]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && !nextDisabled) onNext();
  };

  return (
    <div className={cn("flex min-w-0 flex-col gap-6", className)}>
      <nav aria-label="Progress">
        <p className="text-sm font-medium text-muted sm:hidden">
          Step {index + 1} of {steps.length}
        </p>
        <ol className="hidden flex-wrap gap-2 sm:flex">
          {steps.map((item, i) => {
            const done = completed.includes(item.id);
            const isCurrent = i === index;
            const content = (
              <>
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                    isCurrent ? "border-action bg-action text-on-action" : done ? "border-success bg-success-soft text-success" : "border-control-border bg-surface text-muted",
                  )}
                >
                  {done && !isCurrent ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className={cn("min-w-0 break-words", isCurrent ? "font-semibold text-ink" : "text-body")}>
                  <span className="sr-only">
                    Step {i + 1} of {steps.length}:{" "}
                  </span>
                  {item.label}
                  {item.optional ? <span className="text-muted"> (optional)</span> : null}
                  {done && !isCurrent ? <span className="sr-only"> (completed)</span> : null}
                </span>
              </>
            );
            const selectable = !!onStepSelect && done && !isCurrent;
            return (
              <li key={item.id} aria-current={isCurrent ? "step" : undefined} className="flex min-w-0 items-center gap-2">
                {selectable ? (
                  <button
                    type="button"
                    onClick={() => onStepSelect(item.id)}
                    className="flex min-h-11 min-w-0 items-center gap-2 rounded-[var(--radius-control)] px-2 text-sm hover:bg-surface-sunken"
                  >
                    {content}
                  </button>
                ) : (
                  <span className="flex min-h-11 min-w-0 items-center gap-2 px-2 text-sm">{content}</span>
                )}
                {i < steps.length - 1 ? <span aria-hidden="true" className="hidden h-px w-6 bg-line md:block" /> : null}
              </li>
            );
          })}
        </ol>
      </nav>
      <form noValidate onSubmit={submit} className="flex min-w-0 flex-col gap-6" aria-labelledby={headingId}>
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-ink outline-none">
          {step?.label}
        </h2>
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
        <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:items-center">
          {index > 0 && onBack ? (
            <Button variant="secondary" onClick={onBack} disabled={busy}>
              Back
            </Button>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row sm:items-center">
            {secondaryAction}
            <Button type="submit" loading={busy} disabled={nextDisabled}>
              {nextLabel}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
