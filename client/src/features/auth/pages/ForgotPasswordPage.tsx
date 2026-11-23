import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useAuthApi, type Accepted } from "@/lib/authApi";
import { errorMessage } from "@/lib/trpc";
import { Button, Callout, Field, Input } from "@/ui";
import { RateLimitCountdown } from "@/lib/RateLimitCountdown";
import { AuthLayout } from "../components/AuthLayout";
import { FormError, PreviewLinkCallout, useFocusOnError } from "../components/bits";

export default function ForgotPasswordPage() {
  const api = useAuthApi();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** D7: the raw failure, so a rate-limited response can show its authoritative retry countdown. */
  const [failure, setFailure] = useState<unknown>(null);
  const [done, setDone] = useState<Accepted | null>(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useFocusOnError(error);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim()) {
      setError("Enter your email address.");
      return;
    }
    setError(null);
    setFailure(null);
    setBusy(true);
    try {
      setDone(await api.requestPasswordReset({ email: email.trim() }));
    } catch (err) {
      setFailure(err);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={done ? "Check your email" : "Reset your password"} description={done ? undefined : "Enter the email you use for ReadyPackets. If an account exists, we'll send a reset link."}>
      {done ? (
        <>
          <Callout tone="success" live="polite">
            If an account exists for that address, a password reset link is on its way. The link expires soon and can be used once.
          </Callout>
          <PreviewLinkCallout link={done.previewLink} label="open the password reset link" />
          <Button asChild variant="secondary" block className="mt-6">
            <Link href="/sign-in">Back to sign in</Link>
          </Button>
        </>
      ) : (
        <>
          <FormError message={error} focusRef={errorRef} />
      <RateLimitCountdown error={failure} />
          <form onSubmit={submit} noValidate className="flex flex-col gap-5">
            <Field label="Email">
              <Input type="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />
            </Field>
            <Button type="submit" size="lg" block loading={busy}>
              Send reset link
            </Button>
            <Link href="/sign-in" className="text-center text-sm font-medium text-action underline-offset-2 hover:underline">
              Back to sign in
            </Link>
          </form>
        </>
      )}
    </AuthLayout>
  );
}
