/**
 * Increment 08 (D6) — the step-by-step wizard for one phase (audit_engineer). Pure presentation: the caller decides
 * the steps (`buildSteps`), supplies each step's content and the final action. Every step's content stays mounted
 * (hidden when not shown) so selected files and drafts survive moving between steps.
 *
 * WCAG 2.2: the step list is an ordered list with `aria-current="step"` and a written state per item (no colour-only
 * state); focus moves to the step heading on every step change; Back and Next are always visible and Next is
 * disabled only with its reason written next to it (`aria-describedby`); errors are summarised at the top.
 */
import { Check, Circle } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, Callout } from "@/ui";
import { stepTitle, type WizardStep, type WizardStepKey } from "./wizardModel";

export interface StepWizardFinal {
  /** Button text on the last step, e.g. "Submit" or "Finish". */
  label: string;
  run: () => void;
  busy: boolean;
  /** Why the final action is not available (written next to the disabled button). */
  disabledReason?: string | null;
}

export interface StepWizardProps {
  /** Accessible name of the step list, e.g. "Steps in Phase 1 intake". */
  label: string;
  steps: readonly WizardStep[];
  /** Step shown first (resume point). */
  initialIndex: number;
  renderStep: (key: WizardStepKey) => ReactNode;
  final: StepWizardFinal;
  /** Errors to summarise at the top (customer wording); `step` makes the line a button that opens that step. */
  errors?: readonly WizardError[];
  headingLevel?: 3 | 4;
}

export interface WizardError { message: string; step?: WizardStepKey }

export function StepWizard({ label, steps, initialIndex, renderStep, final, errors = [], headingLevel = 4 }: StepWizardProps) {
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), steps.length - 1));
  const [moved, setMoved] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorsRef = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const summaryId = useId();
  const safeIndex = Math.min(index, steps.length - 1);
  const step = steps[safeIndex]!;
  const last = safeIndex === steps.length - 1;
  const go = (next: number) => { setIndex(Math.min(Math.max(next, 0), steps.length - 1)); setMoved((n) => n + 1); };
  const goToKey = (key: WizardStepKey) => { const i = steps.findIndex((s) => s.key === key); if (i >= 0) go(i); };
  useEffect(() => { if (moved) headingRef.current?.focus(); }, [moved]);
  // A new error list is announced by moving focus to its summary.
  const errorKey = errors.map((e) => e.message).join("\n");
  useEffect(() => { if (errorKey) errorsRef.current?.focus(); }, [errorKey]);
  const Heading = headingLevel === 3 ? "h3" : "h4";
  const reason = last ? (final.disabledReason ?? null) : step.blockedReason;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {errors.length ? (
        <div ref={errorsRef} role="region" tabIndex={-1} className="outline-none" aria-labelledby={summaryId}>
          <Callout tone="danger" title={<span id={summaryId}>Please check the following</span>}>
            <ul className="ml-5 list-disc">
              {errors.map((e) => (
                <li key={e.message} className="break-words">
                  {e.step ? <Button variant="link" onClick={() => goToKey(e.step!)}>{e.message}</Button> : e.message}
                </li>
              ))}
            </ul>
          </Callout>
        </div>
      ) : null}

      <ol aria-label={label} className="grid min-w-0 gap-2 sm:grid-flow-col sm:auto-cols-fr">
        {steps.map((s, i) => {
          const current = i === safeIndex;
          const state = current ? "Current step" : s.complete ? "Done" : "Not done";
          return (
            <li key={s.key} aria-current={current ? "step" : undefined} className="min-w-0">
              <button
                type="button"
                onClick={() => go(i)}
                className={[
                  "flex min-h-11 w-full min-w-0 items-start gap-2 rounded-[var(--radius-control)] border px-3 py-2 text-left",
                  current ? "border-action bg-surface font-semibold text-ink" : "border-line bg-surface text-body hover:underline",
                ].join(" ")}
              >
                <span aria-hidden="true" className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                  {s.complete && !current ? <Check className="size-4" /> : current ? <span className="text-xs font-bold">{i + 1}</span> : <Circle className="size-4" />}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="break-words text-sm [overflow-wrap:anywhere]">
                    <span className="sr-only">{`Step ${i + 1} of ${steps.length}: `}</span>
                    {s.title}
                  </span>
                  {" "}
                  <span className="text-xs text-muted">{state}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <Heading ref={headingRef} tabIndex={-1} className="min-w-0 break-words text-base font-semibold text-ink outline-none">
        {stepTitle(step, safeIndex, steps.length)}
      </Heading>

      {steps.map((s, i) => (
        <div key={s.key} hidden={i !== safeIndex} className="min-w-0">
          {renderStep(s.key)}
        </div>
      ))}

      <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <Button variant="secondary" size="lg" onClick={() => go(safeIndex - 1)} disabled={safeIndex === 0}>Back</Button>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          {reason ? <p id={reasonId} className="min-w-0 break-words text-sm text-body sm:text-right">{reason}</p> : null}
          {last ? (
            <Button size="lg" onClick={final.run} loading={final.busy} disabled={Boolean(reason)} aria-describedby={reason ? reasonId : undefined}>
              {final.label}
            </Button>
          ) : (
            <Button size="lg" onClick={() => go(safeIndex + 1)} disabled={Boolean(reason)} aria-describedby={reason ? reasonId : undefined}>
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
