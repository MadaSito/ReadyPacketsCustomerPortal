import { useState, type FormEvent } from "react";
import { PASSWORD_POLICY, countCodePoints } from "@shared/domain";
import { errorMessage, safeError } from "@/lib/trpc";
import { Button, Field } from "@/ui";
import { RateLimitCountdown } from "@/lib/RateLimitCountdown";
import { FormError, PasswordInput, PasswordMeter, useFocusOnError } from "./bits";

type NewPasswordFormProps = {
  submitLabel: string;
  /** Adds the field for the password in use now. */
  withCurrent?: boolean;
  /** Label, hint and wrong-password message of that field (defaults suit a voluntary change). */
  currentLabel?: string;
  currentHint?: string;
  currentIncorrectMessage?: string;
  /** The account's sign-in name, so that a password manager offers and saves the right entry. */
  username?: string;
  onSubmit: (input: { currentPassword: string; password: string }) => Promise<void>;
};

/** New-password form shared by reset, activation and forced change. */
export function NewPasswordForm({ submitLabel, withCurrent, currentLabel = "Current password", currentHint, currentIncorrectMessage, username, onSubmit }: NewPasswordFormProps) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [currentError, setCurrentError] = useState<string | undefined>();
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  /** D7: the raw failure, so a rate-limited response can show its authoritative retry countdown. */
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useFocusOnError(error);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const length = countCodePoints(password);
    if (withCurrent && !current) {
      setCurrentError("This field is required.");
      setError(`Enter the ${currentLabel.toLowerCase()}.`);
      return;
    }
    setCurrentError(undefined);
    if (length < PASSWORD_POLICY.minLength || length > PASSWORD_POLICY.maxLength) {
      setFieldError(`Use between ${PASSWORD_POLICY.minLength} and ${PASSWORD_POLICY.maxLength} characters.`);
      setError("Please choose a longer password.");
      return;
    }
    setFieldError(undefined);
    setError(null);
    setFailure(null);
    setBusy(true);
    try {
      await onSubmit({ currentPassword: current, password });
      setCurrent("");
      setPassword("");
    } catch (err) {
      setFailure(err);
      const safe = safeError(err);
      if (safe?.reasonCode === "CURRENT_PASSWORD_INCORRECT") {
        // Shown on the field it concerns, so it is not mistaken for a verdict on the new password.
        const message = currentIncorrectMessage ?? safe.safeMessage;
        setCurrentError(message);
        setFieldError(undefined);
        setError(message);
        return;
      }
      setFieldError(safe?.fieldErrors?.password?.[0] ?? safe?.fieldErrors?.newPassword?.[0]);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <FormError message={error} focusRef={errorRef} />
      <RateLimitCountdown error={failure} />
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        {/* The sign-in name, out of sight: a password manager then matches its saved entries to this account
            instead of filling in a password saved for another one, and files the new password correctly. */}
        {username ? (
          <input type="text" name="username" autoComplete="username" value={username} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
        ) : null}
        {withCurrent ? (
          <Field label={currentLabel} hint={currentHint} error={currentError} required>
            <PasswordInput autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} maxLength={1024} />
          </Field>
        ) : null}
        <Field label="New password" error={fieldError} required>
          <PasswordInput autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="new-pw-meter" />
        </Field>
        <PasswordMeter id="new-pw-meter" password={password} />
        <Button type="submit" size="lg" block loading={busy}>
          {submitLabel}
        </Button>
      </form>
    </>
  );
}
