import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useAuthApi, type Accepted } from "@/lib/authApi";
import { useSession } from "@/lib/session";
import { errorMessage } from "@/lib/trpc";
import { Button, Callout, Spinner } from "@/ui";
import { AuthLayout } from "../components/AuthLayout";
import { PreviewLinkCallout, useOneTimeToken } from "../components/bits";
import { useContinueAfterAuth } from "../useAuthNavigation";

type State = { kind: "idle" } | { kind: "verifying" } | { kind: "verified" } | { kind: "failed"; message: string };

export default function VerifyEmailPage() {
  const api = useAuthApi();
  const token = useOneTimeToken();
  const { view, me } = useSession();
  const proceed = useContinueAfterAuth();
  const [state, setState] = useState<State>(token ? { kind: "verifying" } : { kind: "idle" });
  const [resent, setResent] = useState<Accepted | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    // Exactly one server call per token. A token can also arrive after mount, when a link to this same
    // route is followed in-app (the preview profile's demo link), so the latest token is what is verified.
    if (!token || startedFor.current === token) return;
    startedFor.current = token;
    setState({ kind: "verifying" });
    api.verifyEmail({ token }).then(
      () => { if (startedFor.current === token) setState({ kind: "verified" }); },
      (err) => { if (startedFor.current === token) setState({ kind: "failed", message: errorMessage(err, "This verification link is invalid or has expired.") }); },
    );
  }, [api, token]);

  const signedIn = view.status === "remediation" || view.status === "full";
  // The session is replaced when a signed-in person confirms, which can remount this page without its
  // token, and the address may equally have been confirmed in another tab. Either way the server no
  // longer lists the step, so say so and offer Continue instead of a "Send a new link" that does nothing.
  const alreadyConfirmed = signedIn && state.kind === "idle" && !!me && !me.pendingSteps.includes("verify_email");
  const resend = async () => {
    setResending(true);
    setResendError(null);
    try {
      setResent(await api.resendVerification());
    } catch (err) {
      setResendError(errorMessage(err));
    } finally {
      setResending(false);
    }
  };

  if (state.kind === "verifying") {
    return (
      <AuthLayout title="Verifying your email">
        <div className="flex items-center gap-3 text-ink">
          <Spinner label="" /> <span role="status">Confirming your address…</span>
        </div>
      </AuthLayout>
    );
  }
  if (state.kind === "verified" || alreadyConfirmed) {
    return (
      <AuthLayout title="Email confirmed">
        <Callout tone="success" live="polite">
          Thanks — your email address is confirmed.
        </Callout>
        {signedIn ? (
          <Button block className="mt-6" onClick={() => void proceed(null, me?.user.role)}>
            Continue
          </Button>
        ) : (
          <Button asChild block className="mt-6">
            <Link href="/sign-in">Sign in to continue</Link>
          </Button>
        )}
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={state.kind === "failed" ? "We couldn't verify that link" : "Confirm your email"}>
      {state.kind === "failed" ? (
        <Callout tone="danger" live="assertive" className="mb-4">
          {state.message}
        </Callout>
      ) : (
        <p className="text-[0.9375rem] text-body">We sent a confirmation link to your email address. Open it on this device to continue. It may take a few minutes to arrive; check your spam folder too.</p>
      )}
      {signedIn ? (
        <div className="mt-6 flex flex-col gap-3">
          {resent ? (
            <Callout tone="success" live="polite">
              If your address still needs confirming, a new link is on its way.
            </Callout>
          ) : null}
          {resendError ? (
            <Callout tone="danger" live="assertive">
              {resendError}
            </Callout>
          ) : null}
          <PreviewLinkCallout link={resent?.previewLink} label="open the verification link" />
          <Button variant="secondary" block onClick={resend} loading={resending}>
            Send a new link
          </Button>
        </div>
      ) : (
        <Button asChild variant="secondary" block className="mt-6">
          <Link href="/sign-in">Back to sign in</Link>
        </Button>
      )}
    </AuthLayout>
  );
}
