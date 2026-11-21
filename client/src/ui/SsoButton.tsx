import { KeyRound } from "lucide-react";
import { cn } from "./cn";

export interface SsoButtonProps {
  /** Start endpoint; the browser performs a top-level navigation to it. */
  href: string;
  label?: string;
  providerName?: string;
  disabled?: boolean;
  /** "or" divider above the button. Default true. */
  divider?: boolean;
  className?: string;
}

/** "Sign in with SSO": full-width outline button, a real link (server redirect), neutral key icon. */
export function SsoButton({ href, label = "Sign in with SSO", providerName = "Microsoft Entra ID", disabled, divider = true, className }: SsoButtonProps) {
  const body = (
    <>
      <KeyRound aria-hidden={true} className="size-5 shrink-0 text-action" />
      <span className="flex min-w-0 flex-col items-start text-left">
        <span className="font-semibold text-ink">{label}</span>
        {providerName ? <span className="text-sm font-normal text-muted">{providerName}</span> : null}
      </span>
    </>
  );
  const classes =
    "flex min-h-12 w-full items-center justify-center gap-3 rounded-[var(--radius-control)] border-2 border-control-border bg-surface px-4 py-2 transition-colors duration-150 hover:border-action hover:bg-surface-sunken";
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {divider ? (
        <div className="flex items-center gap-3 text-sm text-muted">
          <span aria-hidden="true" className="h-px flex-1 bg-line" />
          <span>or</span>
          <span aria-hidden="true" className="h-px flex-1 bg-line" />
        </div>
      ) : null}
      {disabled ? (
        <span role="link" aria-disabled="true" className={cn(classes, "cursor-not-allowed opacity-60")}>
          {body}
        </span>
      ) : (
        <a href={href} className={classes}>
          {body}
        </a>
      )}
    </div>
  );
}
