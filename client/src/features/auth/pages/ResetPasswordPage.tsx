import { useState } from "react";
import { Link } from "wouter";
import { useAuthApi } from "@/lib/authApi";
import { Button, Callout } from "@/ui";
import { AuthLayout } from "../components/AuthLayout";
import { useOneTimeToken } from "../components/bits";
import { NewPasswordForm } from "../components/NewPasswordForm";

/** Handles both /reset-password and /activate (invitation) links. */
export function TokenPasswordPage({ mode }: { mode: "reset" | "activate" }) {
  const api = useAuthApi();
  const token = useOneTimeToken();
  const [done, setDone] = useState(false);
  const title = mode === "reset" ? "Choose a new password" : "Activate your account";

  if (!token) {
    return (
      <AuthLayout title={title}>
        <Callout tone="warning" title="This link is incomplete or has expired">
          {mode === "reset" ? "Request a new password reset link and use it within its validity window." : "Ask your ReadyPackets contact to send a new invitation."}
        </Callout>
        <Button asChild variant="secondary" block className="mt-6">
          <Link href={mode === "reset" ? "/forgot-password" : "/sign-in"}>{mode === "reset" ? "Request a new link" : "Go to sign in"}</Link>
        </Button>
      </AuthLayout>
    );
  }
  if (done) {
    return (
      <AuthLayout title={mode === "reset" ? "Password updated" : "Account activated"}>
        <Callout tone="success" live="polite">
          {mode === "reset" ? "Your password was changed and other sessions were signed out. Sign in with your new password." : "Your password is set. Sign in to finish setting up multi-factor authentication."}
        </Callout>
        <Button asChild block className="mt-6">
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={title} description="Use at least 15 characters. A passphrase of several unrelated words works well; your password manager can generate one.">
      <NewPasswordForm
        submitLabel={mode === "reset" ? "Update password" : "Activate account"}
        onSubmit={async ({ password }) => {
          if (mode === "reset") await api.resetPassword({ token, password });
          else await api.activateAccount({ token, password });
          setDone(true);
        }}
      />
    </AuthLayout>
  );
}

export default function ResetPasswordPage() {
  return <TokenPasswordPage mode="reset" />;
}
