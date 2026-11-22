/**
 * Shared discount-code entry (D3) for the cart (recovery_ops_engineer) and the order wizard (orders_engineer).
 * Owner: audit engineer. It imports no other feature and calls no procedure: the host applies the code through
 * its own server call (cart apply / order quote) and rethrows the tRPC error on refusal.
 *
 * - One uniform refusal text ("This code cannot be applied."); only cart-specific reasons the server sends
 *   for a code this customer is entitled to (minimum subtotal, no eligible items) show the server's message.
 * - The error is linked to the input; results are announced (host live region via `onAnnounce`, else our own).
 * - Focus: after Apply → the Remove button; after Remove → the input.
 * - A code saved from a promotion link is offered ("Use saved code"), never applied without the customer's click.
 * - The entry and the applied code are masked from session replay / analytics.
 */
import { useId, useRef, useState, type FormEvent } from "react";
import { Tag, X } from "lucide-react";
import { Button, cn } from "@/ui";
import { safeError } from "@/lib/trpc";
import { clearSavedPromoCode, isPlausiblePromoCode, normalizePromoCode, readSavedPromoCode } from "./savedCode";

export interface AppliedPromo {
  /** Customer-facing label (never the code itself). */
  label: string;
  discountMinor: number;
  currency: string;
}

export interface PromoCodeFieldProps {
  applied: AppliedPromo | null;
  onApply: (code: string) => Promise<void>;
  onRemove: () => Promise<void>;
  disabled?: boolean;
  /** Visible label of the input. */
  label?: string;
  /** Host live region (e.g. the cart's); the field announces through its own polite region otherwise. */
  onAnnounce?: (message: string) => void;
  className?: string;
}

export const PROMO_UNIFORM_ERROR = "This code cannot be applied.";
/** Reasons whose server message may be shown (only sent for a code the customer is entitled to). */
const SPECIFIC_REASONS = new Set(["PROMO_MIN_SUBTOTAL", "PROMO_NOT_ELIGIBLE_ITEMS"]);
const BLOCKED_REASONS = new Set(["PROMO_ATTEMPTS_BLOCKED", "RATE_LIMITED"]);

export function promoErrorText(error: unknown): string {
  const safe = safeError(error);
  if (safe && SPECIFIC_REASONS.has(safe.reasonCode) && safe.safeMessage) return safe.safeMessage;
  if (safe && BLOCKED_REASONS.has(safe.reasonCode)) return "Too many attempts. Please wait a few minutes before trying another code.";
  return PROMO_UNIFORM_ERROR;
}

export function formatDiscount(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Math.abs(minor) / 100);
  } catch {
    return `${(Math.abs(minor) / 100).toFixed(2)} ${currency}`;
  }
}

export function PromoCodeField({ applied, onApply, onRemove, disabled, label = "Discount code", onAnnounce, className }: PromoCodeFieldProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const savedId = `${inputId}-saved`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"apply" | "remove" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [saved, setSaved] = useState<string | null>(() => readSavedPromoCode());

  /** Move focus only if it is still inside the field (or was lost to <body>) — never steal it from elsewhere. */
  const focusIfOurs = (target: () => HTMLElement | null) => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || rootRef.current?.contains(active)) target()?.focus();
    });
  };
  const announce = (message: string) => {
    if (onAnnounce) onAnnounce(message);
    else setAnnouncement(message);
  };

  const apply = async (raw: string) => {
    const code = normalizePromoCode(raw);
    if (!code) {
      setError("Enter a discount code.");
      announce("Enter a discount code.");
      inputRef.current?.focus();
      return;
    }
    if (!isPlausiblePromoCode(code)) {
      setError(PROMO_UNIFORM_ERROR);
      announce(PROMO_UNIFORM_ERROR);
      inputRef.current?.focus();
      return;
    }
    setBusy("apply");
    setError(null);
    try {
      await onApply(code);
      if (saved === code) {
        clearSavedPromoCode();
        setSaved(null);
      }
      setValue("");
      announce("Discount code applied.");
      focusIfOurs(() => removeRef.current);
    } catch (e) {
      const text = promoErrorText(e);
      setError(text);
      announce(text);
      focusIfOurs(() => inputRef.current);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      await onRemove();
      announce("Discount code removed.");
      focusIfOurs(() => inputRef.current);
    } catch {
      announce("The discount code could not be removed. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void apply(value);
  };

  return (
    <div ref={rootRef} className={cn("ph-no-capture min-w-0 space-y-2", className)} data-clarity-mask="true">
      {applied ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3">
          <p className="flex min-w-0 items-center gap-2 text-sm text-ink">
            <Tag aria-hidden="true" className="size-4 shrink-0 text-muted" />
            <span className="min-w-0 break-words">
              <span className="font-medium">Discount applied:</span> {applied.label}
              <span className="ml-1 whitespace-nowrap">(−{formatDiscount(applied.discountMinor, applied.currency)})</span>
            </span>
          </p>
          <Button
            ref={removeRef}
            variant="ghost"
            size="sm"
            leadingIcon={<X aria-hidden="true" className="size-4" />}
            onClick={() => void remove()}
            loading={busy === "remove"}
            disabled={disabled}
            aria-label={`Remove discount ${applied.label}`}
          >
            Remove
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="min-w-0 space-y-2">
          <label htmlFor={inputId} className="block text-sm font-medium text-ink">{label}</label>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <input
              ref={inputRef}
              id={inputId}
              name="promoCode"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={64}
              disabled={disabled || busy !== null}
              aria-invalid={error ? true : undefined}
              aria-describedby={[error ? errorId : null, saved ? savedId : null].filter(Boolean).join(" ") || undefined}
              className="min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 py-2 text-ink uppercase placeholder:normal-case focus-visible:border-action focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action aria-[invalid=true]:border-danger"
            />
            <Button type="submit" variant="secondary" loading={busy === "apply"} disabled={disabled} className="shrink-0">
              Apply
            </Button>
          </div>
          {error ? (
            <p id={errorId} className="flex items-start gap-1 text-sm text-danger">
              <span aria-hidden="true">!</span>
              <span>{error}</span>
            </p>
          ) : null}
          {saved ? (
            <p id={savedId} className="flex flex-wrap items-center gap-2 text-sm text-muted">
              <span>A code from your link is saved.</span>
              <Button type="button" variant="link" size="sm" disabled={disabled || busy !== null} onClick={() => void apply(saved)}>
                Use saved code
              </Button>
            </p>
          ) : null}
        </form>
      )}
      {onAnnounce ? null : (
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      )}
    </div>
  );
}

export default PromoCodeField;
