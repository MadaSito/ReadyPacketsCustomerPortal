/**
 * Form controls. <Field> wires label + hint + error to its single control child via context:
 * id, aria-describedby (hint + error), aria-invalid, aria-required. Errors render with role="alert"-free
 * text (announced via the form's live region / focus management) and an icon so colour is never the only cue.
 */
import { Checkbox as RCheckbox, RadioGroup as RRadioGroup, Switch as RSwitch } from "radix-ui";
import { AlertCircle, Check, ChevronDown } from "lucide-react";
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "./cn";

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}
const FieldContext = createContext<FieldContextValue | null>(null);

/** For custom controls inside <Field>: returns the aria wiring props. */
export function useFieldControl(): { id?: string; "aria-describedby"?: string; "aria-invalid"?: true; "aria-required"?: true } {
  const ctx = useContext(FieldContext);
  if (!ctx) return {};
  return {
    id: ctx.id,
    "aria-describedby": ctx.describedBy,
    "aria-invalid": ctx.invalid ? true : undefined,
    "aria-required": ctx.required ? true : undefined,
  };
}

export interface FieldProps {
  label: ReactNode;
  /** Helper text shown under the label. */
  hint?: ReactNode;
  /** Error text; sets aria-invalid on the control. */
  error?: ReactNode;
  required?: boolean;
  /** Hide the label visually (still accessible). Prefer visible labels. */
  hideLabel?: boolean;
  /** Override generated id. */
  id?: string;
  /** Extra content right of the label (e.g. "Forgot password?" link). */
  labelAside?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, required = false, hideLabel, id, labelAside, className, children }: FieldProps) {
  const auto = useId();
  const controlId = id ?? `f${auto.replace(/:/g, "")}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext.Provider value={{ id: controlId, describedBy, invalid: Boolean(error), required }}>
      <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
        <div className={cn("flex items-baseline justify-between gap-3", hideLabel && !labelAside && "sr-only")}>
          <label htmlFor={controlId} className={cn("text-sm font-medium text-ink", hideLabel && "sr-only")}>
            {label}
            {required ? (
              <span className="text-danger" aria-hidden="true">
                {" "}*
              </span>
            ) : null}
            {required ? <span className="sr-only"> (required)</span> : null}
          </label>
          {labelAside ? <div className="text-sm">{labelAside}</div> : null}
        </div>
        {hint ? (
          <p id={hintId} className="text-sm text-muted">
            {hint}
          </p>
        ) : null}
        {children}
        {error ? (
          <p id={errorId} className="flex items-start gap-1.5 text-sm font-medium text-danger">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

const controlBase =
  "w-full min-w-0 rounded-[var(--radius-control)] border border-control-border bg-surface text-ink placeholder:text-muted transition-colors duration-150 hover:border-ink/60 focus-visible:border-action disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-70 aria-invalid:border-danger aria-invalid:border-2";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, type = "text", ...rest }, ref) {
  const wiring = useFieldControl();
  return <input ref={ref} type={type} className={cn(controlBase, "min-h-11 px-3 py-2", className)} {...wiring} {...rest} />;
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, rows = 4, ...rest }, ref) {
  const wiring = useFieldControl();
  return <textarea ref={ref} rows={rows} className={cn(controlBase, "min-h-24 px-3 py-2 leading-relaxed", className)} {...wiring} {...rest} />;
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: readonly SelectOption[];
  /** Optional first, empty option (e.g. "Choose…"). */
  placeholder?: string;
}
/** Native <select> (best mobile + AT support), styled. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, options, placeholder, ...rest }, ref) {
  const wiring = useFieldControl();
  return (
    <div className="relative min-w-0">
      <select ref={ref} className={cn(controlBase, "min-h-11 appearance-none py-2 pr-10 pl-3", className)} {...wiring} {...rest}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" />
    </div>
  );
});

export interface CheckboxProps {
  /** Visible label (required). */
  label: ReactNode;
  description?: ReactNode;
  checked?: boolean | "indeterminate";
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  error?: ReactNode;
  className?: string;
}
export function Checkbox({ label, description, checked, defaultChecked, onCheckedChange, disabled, required, name, id, error, className }: CheckboxProps) {
  const auto = useId();
  const cid = id ?? `c${auto.replace(/:/g, "")}`;
  const descId = description ? `${cid}-desc` : undefined;
  const errId = error ? `${cid}-error` : undefined;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-start gap-3">
        <span className="inline-flex min-h-11 min-w-11 items-center justify-center -m-2.5">
          <RCheckbox.Root
            id={cid}
            name={name}
            checked={checked}
            defaultChecked={defaultChecked}
            onCheckedChange={(value) => onCheckedChange?.(value === true)}
            disabled={disabled}
            required={required}
            aria-describedby={[descId, errId].filter(Boolean).join(" ") || undefined}
            aria-invalid={error ? true : undefined}
            className="inline-flex size-5 items-center justify-center rounded border-2 border-control-border bg-surface data-[state=checked]:border-action data-[state=checked]:bg-action data-[state=checked]:text-on-action aria-invalid:border-danger disabled:opacity-60"
          >
            <RCheckbox.Indicator>
              <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
            </RCheckbox.Indicator>
          </RCheckbox.Root>
        </span>
        <div className="min-w-0 pt-0.5">
          <label htmlFor={cid} className="text-sm font-medium text-ink">
            {label}
            {required ? <span className="sr-only"> (required)</span> : null}
          </label>
          {description ? (
            <p id={descId} className="text-sm text-muted">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {error ? (
        <p id={errId} className="flex items-start gap-1.5 pl-8 text-sm font-medium text-danger">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

export interface SwitchProps {
  label: ReactNode;
  description?: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
}
export function Switch({ label, description, checked, defaultChecked, onCheckedChange, disabled, name, id, className }: SwitchProps) {
  const auto = useId();
  const sid = id ?? `s${auto.replace(/:/g, "")}`;
  const descId = description ? `${sid}-desc` : undefined;
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <label htmlFor={sid} className="text-sm font-medium text-ink">
          {label}
        </label>
        {description ? (
          <p id={descId} className="text-sm text-muted">
            {description}
          </p>
        ) : null}
      </div>
      <RSwitch.Root
        id={sid}
        name={name}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={descId}
        className="relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 border-control-border bg-surface-sunken transition-colors data-[state=checked]:border-action data-[state=checked]:bg-action disabled:opacity-60 before:absolute before:-inset-2 before:content-['']"
      >
        <RSwitch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-control-border shadow transition-transform data-[state=checked]:translate-x-[1.375rem] data-[state=checked]:bg-on-action" />
      </RSwitch.Root>
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}
export interface RadioGroupProps {
  /** Group legend (required). */
  legend: ReactNode;
  options: readonly RadioOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  required?: boolean;
  error?: ReactNode;
  hint?: ReactNode;
  orientation?: "vertical" | "horizontal";
  /** Render each option as a selectable card. */
  variant?: "plain" | "cards";
  className?: string;
}
export function RadioGroup({ legend, options, value, defaultValue, onValueChange, name, required, error, hint, orientation = "vertical", variant = "plain", className }: RadioGroupProps) {
  const auto = useId().replace(/:/g, "");
  const hintId = hint ? `r${auto}-hint` : undefined;
  const errId = error ? `r${auto}-error` : undefined;
  return (
    <fieldset className={cn("min-w-0", className)} aria-describedby={[hintId, errId].filter(Boolean).join(" ") || undefined}>
      <legend className="mb-1.5 text-sm font-medium text-ink">
        {legend}
        {required ? <span className="sr-only"> (required)</span> : null}
      </legend>
      {hint ? (
        <p id={hintId} className="mb-2 text-sm text-muted">
          {hint}
        </p>
      ) : null}
      <RRadioGroup.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        name={name}
        required={required}
        orientation={orientation}
        aria-invalid={error ? true : undefined}
        className={cn("flex gap-2", orientation === "vertical" ? "flex-col" : "flex-row flex-wrap")}
      >
        {options.map((option) => {
          const oid = `r${auto}-${option.value}`;
          return (
            <label
              key={option.value}
              htmlFor={oid}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 py-2",
                variant === "cards" &&
                  "rounded-[var(--radius-card)] border border-control-border bg-surface px-4 py-3 has-[[data-state=checked]]:border-action has-[[data-state=checked]]:bg-action-soft",
                option.disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <RRadioGroup.Item
                id={oid}
                value={option.value}
                disabled={option.disabled}
                className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-control-border bg-surface data-[state=checked]:border-action"
              >
                <RRadioGroup.Indicator className="block size-2.5 rounded-full bg-action" />
              </RRadioGroup.Item>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{option.label}</span>
                {option.description ? <span className="block text-sm text-muted">{option.description}</span> : null}
              </span>
            </label>
          );
        })}
      </RRadioGroup.Root>
      {error ? (
        <p id={errId} className="mt-1.5 flex items-start gap-1.5 text-sm font-medium text-danger">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </fieldset>
  );
}
