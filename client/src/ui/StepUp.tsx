/**
 * Step-up re-authentication. `useStepUp().run(action)` executes `action`; if the server answers
 * STEP_UP_REQUIRED (safeError(err).domainCode), a dialog collects the password plus a second factor
 * (authenticator code, recovery code or passkey), calls assurance.stepUp, then retries `action` ONCE.
 * Cancelling rejects with StepUpCancelledError. The server stays the authority (fresh step-up ≤ 10 min).
 */
import { startAuthentication } from "@simplewebauthn/browser";
import { KeyRound } from "lucide-react";
import { useCallback, useContext, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useAuthApi, type SecondFactorInput } from "@/lib/authApi";
import { errorMessage } from "@/lib/trpc";
import { isStepUpRequired, StepUpCancelledError, StepUpContext, type StepUpApi } from "./stepUpContext";
import { Button } from "./Button";
import { Callout } from "./Feedback";
import { Field, Input, RadioGroup } from "./Field";
import { Dialog } from "./Overlay";

export { isStepUpRequired, StepUpCancelledError, type StepUpApi } from "./stepUpContext";

export function useStepUp(): StepUpApi {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error("StepUpProvider missing (it is mounted by the app providers)");
  return ctx;
}

type Method = "totp" | "recovery_code" | "passkey";
interface Pending {
  reason?: string;
  resolve: (ok: boolean) => void;
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const api = useAuthApi();
  const [pending, setPending] = useState<Pending | null>(null);
  const [factors, setFactors] = useState<{ totp: boolean; passkey: boolean }>({ totp: true, passkey: false });
  const pendingRef = useRef<Pending | null>(null);

  const request = useCallback(
    (options?: { reason?: string }) =>
      new Promise<boolean>((resolve) => {
        const next = { reason: options?.reason, resolve };
        pendingRef.current = next;
        setPending(next);
        api.assuranceState().then(
          (s) => setFactors({ totp: s.totpEnrolled, passkey: s.passkeyCount > 0 }),
          () => setFactors({ totp: true, passkey: false }),
        );
      }),
    [api],
  );

  const run = useCallback(
    async <T,>(action: () => Promise<T>, options?: { reason?: string }): Promise<T> => {
      try {
        return await action();
      } catch (error) {
        if (!isStepUpRequired(error)) throw error;
        const ok = await request(options);
        if (!ok) throw new StepUpCancelledError();
        return action();
      }
    },
    [request],
  );

  const finish = (ok: boolean) => {
    pendingRef.current?.resolve(ok);
    pendingRef.current = null;
    setPending(null);
  };

  const value = useMemo(() => ({ run, request }), [run, request]);
  return (
    <StepUpContext.Provider value={value}>
      {children}
      {pending ? <StepUpDialog key={`${factors.totp}-${factors.passkey}`} reason={pending.reason} factors={factors} onDone={finish} /> : null}
    </StepUpContext.Provider>
  );
}

function StepUpDialog({ reason, factors, onDone }: { reason?: string; factors: { totp: boolean; passkey: boolean }; onDone: (ok: boolean) => void }) {
  const api = useAuthApi();
  const [password, setPassword] = useState("");
  const [method, setMethod] = useState<Method>(factors.totp ? "totp" : factors.passkey ? "passkey" : "recovery_code");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!password || (method !== "passkey" && !code.trim())) {
      setError("Enter your password and verification code.");
      return;
    }
    setBusy(true);
    try {
      let factor: SecondFactorInput;
      if (method === "passkey") {
        const challenge = await api.beginPasskeyAuthentication({ purpose: "step_up" });
        const response = await startAuthentication({ optionsJSON: challenge.options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
        factor = { method: "passkey", challengeId: challenge.challengeId, response };
      } else {
        factor = { method, code: code.replace(/\s+/g, "") };
      }
      await api.stepUp({ password, factor });
      setPassword("");
      setCode("");
      onDone(true);
    } catch (err) {
      setError(err instanceof Error && err.name === "NotAllowedError" ? "The passkey request was cancelled or timed out." : errorMessage(err, "Verification failed. Check your details and try again."));
    } finally {
      setBusy(false);
    }
  };

  const options = [
    ...(factors.passkey ? [{ value: "passkey", label: "Passkey" }] : []),
    ...(factors.totp ? [{ value: "totp", label: "Authenticator app code" }] : []),
    { value: "recovery_code", label: "Recovery code" },
  ];

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onDone(false)}
      dismissible={!busy}
      title="Confirm it's you"
      description={reason ?? "This action needs a recent verification. Enter your password and a second factor."}
      size="sm"
    >
      <form id="rp-step-up" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error ? (
          <Callout tone="danger" live="assertive">
            {error}
          </Callout>
        ) : null}
        <Field label="Password" required>
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <RadioGroup legend="Second factor" options={options} value={method} onValueChange={(v) => setMethod(v as Method)} />
        {method !== "passkey" ? (
          <Field label={method === "totp" ? "6-digit code" : "Recovery code"} required>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              inputMode={method === "totp" ? "numeric" : "text"}
              maxLength={method === "totp" ? 8 : 40}
              spellCheck={false}
            />
          </Field>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} leadingIcon={<KeyRound aria-hidden="true" />}>
            Verify
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
