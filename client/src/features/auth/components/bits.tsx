/** Shared auth-form pieces: password input with show/hide, length meter, preview-link callout, form error, token hook. */
import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes, type RefObject } from "react";
import { Link, useSearch } from "wouter";
import { PASSWORD_POLICY, countCodePoints } from "@shared/domain";
import { Callout, useFieldControl } from "@/ui";
import { cn } from "@/ui/cn";

export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(function PasswordInput({ className, ...rest }, ref) {
  const [visible, setVisible] = useState(false);
  const wiring = useFieldControl();
  return (
    <div className="relative">
      <input
        ref={ref}
        type={visible ? "text" : "password"}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          "min-h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-control-border bg-surface py-2 pr-12 pl-3 text-ink placeholder:text-muted hover:border-ink/60 focus-visible:border-action aria-invalid:border-2 aria-invalid:border-danger",
          className,
        )}
        {...wiring}
        {...rest}
        aria-describedby={[wiring["aria-describedby"], rest["aria-describedby"]].filter(Boolean).join(" ") || undefined}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-pressed={visible}
        aria-label={visible ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center rounded-r-[var(--radius-control)] text-muted hover:text-ink"
      >
        {visible ? <EyeOff aria-hidden="true" className="size-5" /> : <Eye aria-hidden="true" className="size-5" />}
      </button>
    </div>
  );
});

export type PasswordStrength = "empty" | "short" | "ok" | "strong" | "too-long";
export function passwordStrength(password: string, min: number = PASSWORD_POLICY.minLength, max: number = PASSWORD_POLICY.maxLength): { level: PasswordStrength; length: number } {
  const length = countCodePoints(password);
  if (length === 0) return { level: "empty", length };
  if (length > max) return { level: "too-long", length };
  if (length < min) return { level: "short", length };
  return { level: length >= min + 5 ? "strong" : "ok", length };
}

/** Length-only guidance (no composition rules, per policy). The server decides (incl. breached-password checks). */
export function PasswordMeter({ password, id, min = PASSWORD_POLICY.minLength, max = PASSWORD_POLICY.maxLength }: { password: string; id: string; min?: number; max?: number }) {
  const { level, length } = passwordStrength(password, min, max);
  const pct = Math.min(100, Math.round((length / (min + 5)) * 100));
  const text: Record<PasswordStrength, string> = {
    empty: `Use at least ${min} characters. A few unrelated words make a strong, memorable passphrase.`,
    short: `${length} of ${min} characters minimum.`,
    ok: `Meets the ${min}-character minimum. Longer is even better.`,
    strong: "Great length.",
    "too-long": `Too long: the maximum is ${max} characters.`,
  };
  const bar = level === "short" || level === "too-long" ? "bg-warning" : level === "empty" ? "bg-transparent" : "bg-success";
  return (
    <div id={id} className="flex flex-col gap-1.5">
      <div aria-hidden="true" className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div className={cn("h-full rounded-full transition-[width] duration-200", bar)} style={{ width: `${level === "empty" ? 0 : pct}%` }} />
      </div>
      <p className="text-sm text-muted" aria-live="polite">
        {text[level]}
      </p>
    </div>
  );
}

/** Preview profile only: e-mail delivery is not configured, so the server returned the link for the demo. */
export function PreviewLinkCallout({ link, label }: { link?: string; label: string }) {
  if (!link || !link.startsWith("/") || link.startsWith("//")) return null;
  return (
    <Callout tone="warning" title="Preview environment — e-mail delivery is not configured" className="mt-4">
      <p>In a real deployment this link is sent by e-mail.</p>
      <p className="mt-2">
        <Link href={link} className="font-semibold text-action underline underline-offset-2">
          Demo: {label}
        </Link>
      </p>
    </Callout>
  );
}

/** Uniform, announced form-level error. Focus moves here after a failed submit. */
export function FormError({ message, focusRef }: { message: string | null; focusRef?: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={focusRef} tabIndex={-1} className="outline-none">
      {message ? (
        <Callout tone="danger" live="assertive" className="mb-4">
          {message}
        </Callout>
      ) : null}
    </div>
  );
}

/** Focus the error container whenever a new error appears. */
export function useFocusOnError(error: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);
  return ref;
}

function readToken(search: string): string | null {
  const value = new URLSearchParams(search).get("token");
  return value && value.length <= 512 ? value : null;
}

/**
 * Reads `?token=`, then removes it from the address bar and history (history.replaceState) so it
 * does not linger in history, screenshots or Referer headers. Returns the token held in memory.
 * A token that arrives later on the same mounted page (an in-app link to the same route, as the
 * preview profile's demo link is) replaces the held one; stripping the address never clears it.
 */
export function useOneTimeToken(): string | null {
  const search = useSearch();
  const incoming = readToken(search);
  const [token, setToken] = useState(incoming);
  // Adopt a later token while rendering (derived state), so no effect has to copy it across.
  if (incoming && incoming !== token) setToken(incoming);
  useEffect(() => {
    if (!token) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    const hash = url.hash.replace(/([?&])token=[^&]*(&|$)/, (_m, a: string, b: string) => (b ? a : "")).replace(/[?&]$/, "");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${hash}`);
  }, [token]);
  return token;
}
