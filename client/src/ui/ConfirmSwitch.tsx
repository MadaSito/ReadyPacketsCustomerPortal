/**
 * Switch that asks before a consequential change (increment 06). The switch keeps showing the stored value
 * until the change is confirmed and saved; Cancel / Escape leaves it unchanged and focus returns to the switch.
 * Directions without a `confirmOn` / `confirmOff` description change immediately.
 */
import { useState, type ReactNode } from "react";
import { Switch } from "./Field";
import { ConfirmDialog } from "./Overlay";

export interface ConfirmSwitchStep {
  title: ReactNode;
  description?: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** Require typing this exact text (high-impact switches). */
  confirmText?: string;
}

export interface ConfirmSwitchProps {
  label: ReactNode;
  description?: ReactNode;
  /** Stored value (controlled). */
  checked: boolean;
  /** Persist the change; may be async. Throw to keep the dialog open (show the error yourself). */
  onConfirmedChange: (next: boolean) => void | Promise<void>;
  confirmOn?: ConfirmSwitchStep | null;
  confirmOff?: ConfirmSwitchStep | null;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function ConfirmSwitch({ label, description, checked, onConfirmedChange, confirmOn, confirmOff, disabled, id, className }: ConfirmSwitchProps) {
  const [pending, setPending] = useState<boolean | null>(null);
  const step = pending === null ? null : pending ? confirmOn : confirmOff;
  const request = (next: boolean) => {
    const needs = next ? confirmOn : confirmOff;
    if (needs) setPending(next);
    else void onConfirmedChange(next);
  };
  return (
    <>
      <Switch label={label} description={description} checked={checked} onCheckedChange={request} disabled={disabled} id={id} className={className} />
      {step ? (
        <ConfirmDialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          title={step.title}
          description={step.description}
          confirmLabel={step.confirmLabel ?? (pending ? "Turn on" : "Turn off")}
          destructive={step.destructive}
          confirmText={step.confirmText}
          onConfirm={async () => {
            await onConfirmedChange(pending === true);
            setPending(null);
          }}
        >
          {step.body}
        </ConfirmDialog>
      ) : null}
    </>
  );
}
