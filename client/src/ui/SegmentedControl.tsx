/**
 * Segmented control: a small radio group drawn as joined buttons (WAI-ARIA radio group pattern).
 * One tab stop; arrow keys, Home and End move and select. `iconOnly` keeps every option's label as its
 * accessible name and shows it as a tooltip-style title.
 */
import type { LucideIcon } from "lucide-react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useId, useRef, type KeyboardEvent } from "react";
import { cn } from "./cn";
import { useTheme, type ThemePreference } from "./theme";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group (visible when `showLabel`). */
  label: string;
  showLabel?: boolean;
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: "sm" | "md";
  iconOnly?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({ label, showLabel, options, value, onValueChange, size = "md", iconOnly, className }: SegmentedControlProps<T>) {
  const labelId = `seg${useId().replace(/:/g, "")}`;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const move = (index: number) => {
    const next = (index + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onValueChange(option.value);
    refs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys: Record<string, number> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: options.length - 1 };
    const target = keys[event.key];
    if (target === undefined) return;
    event.preventDefault();
    move(target);
  };

  return (
    <div className={cn("inline-flex min-w-0 flex-col gap-1.5", className)}>
      <span id={labelId} className={cn("text-sm font-medium text-ink", !showLabel && "sr-only")}>
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="inline-flex max-w-full rounded-[var(--radius-control)] border border-control-border bg-surface p-0.5 rp-forced-border">
        {options.map((option, index) => {
          const checked = index === current;
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={iconOnly ? option.label : undefined}
              title={iconOnly ? option.label : undefined}
              tabIndex={checked ? 0 : -1}
              onClick={() => onValueChange(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "rp-target inline-flex min-w-0 items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] font-medium whitespace-nowrap text-body hover:text-ink",
                size === "sm" ? "min-h-8 px-2.5 text-xs" : "min-h-9 px-3 text-sm",
                iconOnly && (size === "sm" ? "min-w-8 px-0" : "min-w-9 px-0"),
                checked && "bg-action-soft text-action hover:text-action",
              )}
            >
              {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0" /> : null}
              {iconOnly ? null : <span className="truncate">{option.label}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const THEME_OPTIONS: readonly SegmentedOption<ThemePreference>[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export interface ThemeControlProps {
  /** `compact` = icon-only (phones, tight bars). */
  variant?: "full" | "compact";
  /** Show the "Theme" label above the control (settings pages). */
  showLabel?: boolean;
  className?: string;
}

/** System | Light | Dark, bound to `useTheme()`. */
export function ThemeControl({ variant = "full", showLabel, className }: ThemeControlProps) {
  const { preference, setPreference } = useTheme();
  return (
    <SegmentedControl
      label="Theme"
      showLabel={showLabel}
      options={THEME_OPTIONS}
      value={preference}
      onValueChange={setPreference}
      size="sm"
      iconOnly={variant === "compact"}
      className={className}
    />
  );
}
