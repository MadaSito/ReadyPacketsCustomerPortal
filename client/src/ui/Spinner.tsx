import { cn } from "./cn";

export interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  /** Screen-reader text. Pass "" when the parent already conveys busy state. */
  label?: string;
  className?: string;
}

const dims = { sm: "size-4 border-2", md: "size-6 border-2", lg: "size-10 border-[3px]" } as const;

export function Spinner({ size = "md", label = "Loading", className }: SpinnerProps) {
  return (
    <span role={label ? "status" : undefined} className={cn("inline-flex items-center", className)}>
      <span
        aria-hidden="true"
        className={cn("inline-block animate-spin rounded-full border-current border-r-transparent motion-reduce:animate-[spin_1.5s_linear_infinite]", dims[size])}
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
