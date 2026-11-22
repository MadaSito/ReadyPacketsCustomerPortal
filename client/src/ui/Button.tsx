import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] max-w-full font-semibold whitespace-nowrap select-none max-[359px]:whitespace-normal max-[359px]:text-center max-[359px]:break-words transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 [&_svg]:size-4 [&_svg]:shrink-0";
const variants: Record<ButtonVariant, string> = {
  primary: "bg-action text-on-action hover:bg-action-hover shadow-[var(--shadow-card)]",
  secondary: "bg-surface text-ink border border-control-border hover:bg-surface-sunken",
  ghost: "bg-transparent text-ink hover:bg-surface-sunken",
  danger: "bg-danger-action text-on-danger-action hover:bg-danger-action-hover",
  link: "bg-transparent text-action underline underline-offset-2 hover:text-action-hover px-0 min-h-0 h-auto",
};
const sizes: Record<ButtonSize, string> = {
  sm: "min-h-9 px-3 text-sm pointer-coarse:min-h-11",
  md: "min-h-11 px-4 text-[0.9375rem]",
  lg: "min-h-12 px-6 text-base",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and blocks clicks. */
  loading?: boolean;
  /** Render as the single child (e.g. a wouter <Link>) with button styling. */
  asChild?: boolean;
  /** Stretch to container width. */
  block?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra?: string): string {
  return cn(base, variants[variant], variant === "link" ? "" : sizes[size], extra);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, asChild = false, block = false, leadingIcon, trailingIcon, className, children, disabled, type, onClick, ...rest },
  ref,
) {
  const classes = buttonClasses(variant, size, cn(block && "w-full", className));
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} {...rest}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={classes}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? (event) => event.preventDefault() : onClick}
      {...rest}
    >
      {loading ? <Spinner size="sm" label="" /> : leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name (required) — also shown as the native tooltip. */
  label: string;
  icon: ReactNode;
  variant?: Exclude<ButtonVariant, "link">;
  size?: "sm" | "md";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = "ghost", size = "md", className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cn(
        base,
        variants[variant],
        size === "md" ? "size-11" : "size-9 pointer-coarse:size-11",
        "p-0 [&_svg]:size-5",
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
    </button>
  );
});
