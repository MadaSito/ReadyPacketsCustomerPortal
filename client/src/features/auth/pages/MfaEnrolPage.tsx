import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuthApi } from "@/lib/authApi";
import { clearRecoveryBatch, stageRecoveryBatch, useRecoveryBatch } from "@/lib/recoveryBatch";
import { useSession } from "@/lib/session";
import { errorMessage } from "@/lib/trpc";
import { Button, CopyButton, ErrorState, Field, Input, Skeleton } from "@/ui";
import { AuthLayout } from "../components/AuthLayout";
import { FormError, useFocusOnError } from "../components/bits";
import { RecoveryCodesPanel } from "../components/RecoveryCodesPanel";
import { useContinueAfterAuth } from "../useAuthNavigation";

export function groupKey(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

export default function MfaEnrolPage() {
  const api = useAuthApi();
  const { me } = useSession();
  const proceed = useContinueAfterAuth();
  const batch = useRecoveryBatch();
  const begin = useMutation({ mutationFn: () => api.beginTotpEnrollment() });
  const started = useRef(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useFocusOnError(error);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    begin.mutate();
  }, [begin]);

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    const cleaned = code.replace(/\s+/g, "");
    if (!/^\d{6,8}$/.test(cleaned)) {
      setError("Enter the 6-digit code shown in your authenticator app.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await api.confirmTotpEnrollment({ code: cleaned });
      setCode("");
      if (result.recoveryCodes && result.recoverySetId) {
        // Stage first: a session refresh may redirect to /mfa/recovery-codes, which shows the same batch.
        stageRecoveryBatch({ recoveryCodes: result.recoveryCodes, recoverySetId: result.recoverySetId });
      } else {
        await proceed(null, me?.user.role);
      }
    } catch (err) {
      setError(errorMessage(err, "That code didn't match. Wait for a new code and try again."));
    } finally {
      setBusy(false);
    }
  };

  if (batch) {
    return (
      <AuthLayout wide title="Save your recovery codes" description="Authenticator app connected. One last step.">
        <RecoveryCodesPanel
          batch={batch}
          onAcknowledge={async (recoverySetId) => {
            await api.acknowledgeRecoveryCodes({ recoverySetId });
            clearRecoveryBatch();
            await proceed(null, me?.user.role);
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout wide title="Set up two-step verification" description="ReadyPackets requires an authenticator app (such as 1Password, Microsoft Authenticator or Google Authenticator) for every account.">
      {begin.isError ? (
        <ErrorState error={begin.error} title="We couldn't start setup" onRetry={() => begin.mutate()} />
      ) : !begin.data ? (
        <div role="status" aria-label="Preparing setup" className="grid gap-6 sm:grid-cols-[12rem_1fr]">
          <Skeleton className="size-48" />
          <Skeleton lines={4} />
        </div>
      ) : (
        <div className="grid gap-8 sm:grid-cols-[13rem_minmax(0,1fr)]">
          <div className="flex flex-col items-center gap-2">
            <div className="rounded-xl bg-white p-3 shadow-[var(--shadow-card)]">
              <img src={begin.data.qrDataUrl} alt="QR code to add ReadyPackets to your authenticator app" className="size-44" />
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            <ol className="list-decimal space-y-1.5 pl-5 text-[0.9375rem] text-body">
              <li>Scan the QR code with your authenticator app.</li>
              <li>Can't scan? Enter the setup key manually.</li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            <div>
              <p className="text-sm font-medium text-ink">Setup key</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <code className="rounded-md bg-surface-sunken px-3 py-2 font-mono text-sm break-all text-ink">{groupKey(begin.data.secret)}</code>
                <CopyButton value={begin.data.secret} label="Copy setup key" />
              </div>
            </div>
            <FormError message={error} focusRef={errorRef} />
            <form onSubmit={confirm} noValidate className="flex flex-col gap-4">
              <Field label="6-digit code">
                <Input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9 ]*" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono text-lg tracking-[0.3em]" />
              </Field>
              <Button type="submit" size="lg" loading={busy}>
                Verify and continue
              </Button>
            </form>
          </div>
        </div>
      )}
    </AuthLayout>
  );
}
