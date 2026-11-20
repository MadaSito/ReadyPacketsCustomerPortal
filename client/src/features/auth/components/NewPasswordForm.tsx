import { useState, type FormEvent } from "react";
import { PASSWORD_POLICY, countCodePoints } from "@shared/domain";
import { errorMessage, safeError } from "@/lib/trpc";
import { Button, Field } from "@/ui";
import { FormError, PasswordInput, PasswordMeter, useFocusOnError } from "./bits";

/** New-password form shared by reset, activation and forced change. `withCurrent` adds the current password. */
export function NewPasswordForm({ submitLabel, withCurrent, onSubmit }: { submitLabel: string; withCurrent?: boolean; onSubmit: (input: { currentPassword: string; password: string }) => Promise<void> }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useFocusOnError(error);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const length = countCodePoints(password);
    if (withCurrent && !current) {
      setError("Enter your current password.");
      return;
    }
    if (length < PASSWORD_POLICY.minLength || length > PASSWORD_POLICY.maxLength) {
      setFieldError(`Use between ${PASSWORD_POLICY.minLength} and ${PASSWORD_POLICY.maxLength} characters.`);
      setError("Please choose a longer password.");
      return;
    }
    setFieldError(undefined);
    setError(null);
    setBusy(true);
    try {
      await onSubmit({ currentPassword: current, password });
      setCurrent("");
      setPassword("");
    } catch (err) {
      const safe = safeError(err);
      setFieldError(safe?.fieldErrors?.password?.[0] ?? safe?.fieldErrors?.newPassword?.[0]);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <FormError message={error} focusRef={errorRef} />
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        {/* Hidden username helps password managers associate the new password with the account. */}
        {withCurrent ? (
          <Field label="Current password" required>
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
