import { useQuery } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { ChevronDown } from "lucide-react";
import { Link, useSearch } from "wouter";
import { PASSWORD_POLICY, countCodePoints } from "@shared/domain";
import { useAuthApi, type Accepted } from "@/lib/authApi";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { errorMessage, safeError } from "@/lib/trpc";
import { Button, Callout, Checkbox, Field, Input } from "@/ui";
import { usePreviewProfile } from "@/app/shell/common";
import { CustomerMaintenanceSlot } from "@/app/slots";
import { AuthLayout } from "../components/AuthLayout";
import { FormError, PasswordInput, PasswordMeter, useFocusOnError } from "../components/bits";
import { EMPTY_NAME, NameFields, validateNameParts, type NameErrors, type NameValues } from "../components/NameFields";
import {
  BillingFields, EMPTY_BILLING_DETAILS, extractBillingFieldErrors, isBillingFieldsEmpty, validateBillingFields,
  type BillingDetails, type BillingFieldErrors,
} from "@/features/billingProfile";

export const BILLING_DISCLOSURE_LABEL = "Billing information (optional — you can add it later)";

/** Referral code from `/register?ref=CODE` (decision 8); anything that isn't a well-formed code is dropped. */
export function referralCodeFrom(search: string): string | undefined {
  const raw = new URLSearchParams(search).get("ref")?.trim().toUpperCase();
  return raw && /^[0-9A-Z]{10}$/.test(raw) ? raw : undefined;
}

const REFERRAL_HOLD = "/api/referrals/hold";

/**
 * The referral feature keeps a 30-day first-party hold (HttpOnly cookie, no Web Storage) set by its /register wrapper.
 * When the URL has no ?ref=, ask the server for the held code. Any failure means "no code" (fail closed).
 */
export async function fetchHeldReferralCode(): Promise<string | null> {
  try {
    const response = await sessionFetch(apiUrl(REFERRAL_HOLD), { method: "GET", credentials: "include" });
    if (!response.ok) return null;
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === "string" ? (referralCodeFrom(`?ref=${encodeURIComponent(body.code)}`) ?? null) : null;
  } catch {
    return null;
  }
}

function clearHeldReferralCode(): void {
  void sessionFetch(apiUrl(REFERRAL_HOLD), { method: "DELETE", credentials: "include" }).catch(() => undefined);
}

export default function RegisterPage() {
  const api = useAuthApi();
  const urlCode = referralCodeFrom(useSearch());
  const held = useQuery({ queryKey: ["rp", "referrals", "hold"], queryFn: fetchHeldReferralCode, enabled: !urlCode, retry: false, staleTime: Infinity });
  const referralCode = urlCode ?? held.data ?? undefined;
  const preview = usePreviewProfile();
  const [names, setNames] = useState<NameValues>(EMPTY_NAME);
  const [nameErrors, setNameErrors] = useState<NameErrors>({});
  const [billingOpen, setBillingOpen] = useState(false);
  const [billing, setBilling] = useState<BillingDetails>(EMPTY_BILLING_DETAILS);
  const [billingErrors, setBillingErrors] = useState<BillingFieldErrors>({});
  const billingRegionId = `register-billing-${useId().replace(/:/g, "")}`;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Accepted | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const errorRef = useFocusOnError(error, attempt);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    const nameCheck = validateNameParts(names);
    setNameErrors(nameCheck.ok ? {} : nameCheck.errors);
    // D4: the billing section is optional; when anything is filled in it must be complete and valid.
    const billingCheck = isBillingFieldsEmpty(billing) ? null : validateBillingFields(billing);
    setBillingErrors(billingCheck && !billingCheck.ok ? billingCheck.errors : {});
    if (billingCheck && !billingCheck.ok) setBillingOpen(true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = "Enter a valid email address.";
    const length = countCodePoints(password);
    if (length < PASSWORD_POLICY.minLength) next.password = `Use at least ${PASSWORD_POLICY.minLength} characters.`;
    if (length > PASSWORD_POLICY.maxLength) next.password = `Use at most ${PASSWORD_POLICY.maxLength} characters.`;
    if (!accepted) next.accepted = "You need to accept the Terms and Privacy Notice to create an account.";
    setErrors(next);
    if (Object.keys(next).length || !nameCheck.ok || (billingCheck && !billingCheck.ok)) {
      setAttempt((n) => n + 1);
      setError("Please fix the highlighted fields.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await api.register({
        ...nameCheck.data,
        email: email.trim(),
        password,
        ...(referralCode ? { referralCode } : {}),
        ...(billingCheck?.ok ? { billing: billingCheck.data } : {}),
      });
      setPassword("");
      if (referralCode) clearHeldReferralCode();
      setDone(result);
    } catch (err) {
      const safe = safeError(err);
      if (safe?.fieldErrors?.password?.[0]) setErrors({ password: safe.fieldErrors.password[0] });
      const serverBilling = extractBillingFieldErrors(safe?.fieldErrors, "billing");
      if (Object.keys(serverBilling).length) {
        setBillingErrors(serverBilling);
        setBillingOpen(true);
      }
      setError(errorMessage(err, "We couldn't create the account. Please try again."));
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthLayout showcase focusTitle title="Check your email">
        <Callout tone="success" live="polite" title="Almost there">
          If this address can be registered, we've sent a link to confirm it. Follow the link to finish setting up your account and multi-factor authentication.
        </Callout>
        {/* Never render done.previewLink here: whether it is present would reveal if the address already had an
            account (review C-04). Preview users get the link from the signed-in resend on /verify-email. */}
        {preview ? (
          <Callout tone="info" title="Preview environment — e-mail delivery is not configured" className="mt-4">
            Sign in with your new account; the verification screen offers a "Send a new link" button that shows the link here in preview.
          </Callout>
        ) : null}
        <Button asChild variant="secondary" block className="mt-6">
          <Link href="/sign-in">Back to sign in</Link>
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      showcase
      title="Create your account"
      description="Order, track and receive your business packets in one secure place."
      below={
        <>
          Already have an account?{" "}
          <Link href="/sign-in" className="font-semibold text-action underline-offset-2 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <CustomerMaintenanceSlot />
      <FormError message={error} focusRef={errorRef} />
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <NameFields value={names} onChange={setNames} errors={nameErrors} />
        <Field label="Email" error={errors.email} required>
          <Input type="email" name="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />
        </Field>
        <Field label="Password" error={errors.password} required>
          <PasswordInput name="new-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="register-pw-meter" />
        </Field>
        <PasswordMeter id="register-pw-meter" password={password} />
        <div className="rounded-lg border border-line">
          <h2 className="m-0 text-base font-semibold">
            <button
              type="button"
              aria-expanded={billingOpen}
              aria-controls={billingRegionId}
              onClick={() => setBillingOpen((open) => !open)}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left text-ink"
            >
              <span>{BILLING_DISCLOSURE_LABEL}</span>
              <ChevronDown aria-hidden className={billingOpen ? "size-5 shrink-0 rotate-180 transition-transform motion-reduce:transition-none" : "size-5 shrink-0 transition-transform motion-reduce:transition-none"} />
            </button>
          </h2>
          <div id={billingRegionId} role="group" aria-label={BILLING_DISCLOSURE_LABEL} hidden={!billingOpen} className="border-t border-line px-4 py-4">
            <p className="mb-4 text-sm text-muted">Save the details used on your invoices now, or skip this and add them later in your account settings.</p>
            <BillingFields value={billing} onChange={setBilling} errors={billingErrors} idPrefix="register-billing" />
          </div>
        </div>
        <Checkbox
          label={
            <>
              I agree to the{" "}
              <Link href="/terms" className="text-action underline underline-offset-2">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="text-action underline underline-offset-2">
                Privacy Notice
              </Link>
            </>
          }
          description="You'll confirm the current versions after signing in."
          checked={accepted}
          onCheckedChange={setAccepted}
          error={errors.accepted}
          required
        />
        <Button type="submit" size="lg" block loading={busy}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
