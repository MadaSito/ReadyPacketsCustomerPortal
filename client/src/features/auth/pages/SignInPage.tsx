import { useState, type FormEvent } from "react";
import { Link, useSearch } from "wouter";
import { useAuthApi } from "@/lib/authApi";
import { errorMessage, safeError } from "@/lib/trpc";
import { CustomerMaintenanceSlot, SsoSignInSlot } from "@/app/slots";
import { Button, Callout, Field, Input } from "@/ui";
import { AuthLayout } from "../components/AuthLayout";
import { FormError, PasswordInput, useFocusOnError } from "../components/bits";
import { useContinueAfterAuth } from "../useAuthNavigation";

export const SIGN_IN_FAILED = "The email or password is incorrect, or the account can't sign in right now.";

export default function SignInPage() {
  const api = useAuthApi();
  const search = useSearch();
  const proceed = useContinueAfterAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useFocusOnError(error);
  const reason = new URLSearchParams(search).get("reason");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.signIn({ email: email.trim(), password });
      setPassword("");
      await proceed(result.nextStep);
    } catch (err) {
      const code: string | undefined = safeError(err)?.domainCode;
      // Uniform, non-enumerating message for credential failures; pass through rate-limit/maintenance messages.
      setError(code === "RATE_LIMITED" || code === "MAINTENANCE" || code === "CUSTOMER_MAINTENANCE" || code === "UNAVAILABLE" ? errorMessage(err) : SIGN_IN_FAILED);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      showcase
      title="Sign in"
      description="Welcome back. Sign in to manage your orders, files and messages."
      below={
        <>
          New to ReadyPackets?{" "}
          <Link href="/register" className="font-semibold text-action underline-offset-2 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      {reason === "idle" ? (
        <Callout tone="info" className="mb-4">
          You were signed out after a period of inactivity.
        </Callout>
      ) : null}
      <CustomerMaintenanceSlot />
      <FormError message={error} focusRef={errorRef} />
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <Field label="Email">
          <Input type="email" name="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} required />
        </Field>
        <Field
          label="Password"
          labelAside={
            <Link href="/forgot-password" className="font-medium text-action underline-offset-2 hover:underline">
              Forgot password?
            </Link>
          }
        >
          <PasswordInput name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={1024} required />
        </Field>
        <Button type="submit" size="lg" block loading={busy}>
          Sign in
        </Button>
      </form>
      {/* Renders nothing unless single sign-on is configured and enabled. */}
      <div className="mt-4 empty:hidden">
        <SsoSignInSlot next={new URLSearchParams(search).get("next") ?? undefined} />
      </div>
      <p className="mt-5 text-xs text-muted">Every account is protected by multi-factor authentication.</p>
    </AuthLayout>
  );
}
