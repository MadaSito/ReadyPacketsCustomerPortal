/** Second-factor entry: authenticator code, recovery code or passkey. Used by the MFA challenge and code reissue. */
import { startAuthentication } from "@simplewebauthn/browser";
import { KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { PasskeyChallenge, SecondFactorInput } from "@/lib/authApi";
import { errorMessage } from "@/lib/trpc";
import { Button, Field, Input, RadioGroup } from "@/ui";
import { FormError, useFocusOnError } from "./bits";

type Method = "totp" | "recovery_code" | "passkey";

export function FactorForm({
  methods,
  submitLabel,
  beginPasskey,
  onSubmit,
}: {
  methods: readonly Method[];
  submitLabel: string;
  beginPasskey: () => Promise<PasskeyChallenge>;
  onSubmit: (factor: SecondFactorInput) => Promise<void>;
}) {
  const [method, setMethod] = useState<Method>(methods[0] ?? "totp");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useFocusOnError(error);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const cleaned = code.replace(/\s+/g, "");
    if (method !== "passkey" && !cleaned) {
      setError(method === "totp" ? "Enter the 6-digit code from your authenticator app." : "Enter one of your recovery codes.");
      return;
    }
    setBusy(true);
    try {
      if (method === "passkey") {
        const challenge = await beginPasskey();
        const response = await startAuthentication({ optionsJSON: challenge.options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
        await onSubmit({ method: "passkey", challengeId: challenge.challengeId, response });
      } else {
        await onSubmit({ method, code: cleaned });
      }
      setCode("");
    } catch (err) {
      setError(err instanceof Error && err.name === "NotAllowedError" ? "The passkey request was cancelled or timed out. Try again or use another method." : errorMessage(err, "That code didn't work. Check it and try again."));
    } finally {
      setBusy(false);
    }
  };

  const labels: Record<Method, string> = { totp: "Authenticator app", recovery_code: "Recovery code", passkey: "Passkey" };
  return (
    <>
      <FormError message={error} focusRef={errorRef} />
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        {methods.length > 1 ? (
          <RadioGroup
            legend="Verification method"
            variant="cards"
            options={methods.map((m) => ({ value: m, label: labels[m] }))}
            value={method}
            onValueChange={(v) => {
              setMethod(v as Method);
              setCode("");
              setError(null);
            }}
          />
        ) : null}
        {method === "totp" ? (
          <Field label="6-digit code" hint="Open your authenticator app and enter the current code for ReadyPackets.">
            <Input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9 ]*" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono text-lg tracking-[0.3em]" />
          </Field>
        ) : null}
        {method === "recovery_code" ? (
          <Field label="Recovery code" hint="Each recovery code works once.">
            <Input autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" />
          </Field>
        ) : null}
        {method === "passkey" ? <p className="text-sm text-body">Your browser will ask you to confirm with your passkey (fingerprint, face, screen lock or security key).</p> : null}
        <Button type="submit" size="lg" block loading={busy} leadingIcon={method === "passkey" ? <KeyRound aria-hidden="true" /> : undefined}>
          {method === "passkey" ? "Use passkey" : submitLabel}
        </Button>
      </form>
    </>
  );
}
