import { useQuery } from "@tanstack/react-query";
import { KeyRound, ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, CodeBlock, ConfirmDialog, Dialog, Field, Input, Select,
  StepUpCancelledError, useStepUp,
} from "@/ui";
import type { StepUpApi } from "@/ui";
import { PASSWORD_POLICY, countCodePoints } from "@shared/domain";

type AssuranceClient = ReturnType<typeof useTRPCClient>["assurance"]["admin"];
type CredentialInput = Parameters<AssuranceClient["setCredential"]["mutate"]>[0];
type Mode = CredentialInput["mode"];
export interface CredentialsActions {
  setCredential: (input: CredentialInput) => Promise<Awaited<ReturnType<AssuranceClient["setCredential"]["mutate"]>>>;
  resetMfa: (customerId: string) => Promise<unknown>;
}
export interface EmailAvailability { state: "checking" | "ready" | "unavailable"; summary?: string }

export default function CredentialsTab({ customerId }: { customerId: string }) {
  const trpc = useTRPC();
  const client = useTRPCClient().assurance.admin;
  const stepUp = useStepUp();
  const mail = useQuery(trpc.assurance.admin.mailReadiness.queryOptions());
  return <CredentialAdmin key={customerId} customerId={customerId} stepUp={stepUp}
    email={{
      state: mail.isPending ? "checking" : mail.data?.ready ? "ready" : "unavailable",
    }}
    actions={{
      // A plaintext temporary password must not enter a retained mutation-cache entry.
      setCredential: (input) => client.setCredential.mutate(input),
      resetMfa: (id) => client.resetMfa.mutate({ customerId: id }),
    }} />;
}

export function CredentialAdmin({
  customerId, stepUp, actions, email,
}: {
  customerId: string;
  stepUp: StepUpApi;
  actions: CredentialsActions;
  email: EmailAvailability;
}) {
  const [mode, setMode] = useState<Mode>("generate_temporary");
  const [password, setPassword] = useState("");
  const [generated, setGenerated] = useState<string>();
  const [confirm, setConfirm] = useState<"credential" | "mfa" | null>(null);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [validationError, setValidationError] = useState<string>();
  const emailReady = email.state === "ready";

  const selectMode = (value: string) => {
    setMode(value as Mode);
    setPassword("");
    setValidationError(undefined);
    setError(undefined);
    setNotice(undefined);
  };

  const review = (event: FormEvent) => {
    event.preventDefault();
    setValidationError(undefined);
    setError(undefined);
    setNotice(undefined);
    if (mode === "enter_temporary") {
      const length = countCodePoints(password);
      if (length < PASSWORD_POLICY.minLength || length > PASSWORD_POLICY.maxLength) {
        setValidationError(`Enter between ${PASSWORD_POLICY.minLength} and ${PASSWORD_POLICY.maxLength} characters.`);
        return;
      }
    }
    if (mode === "email_link" && !emailReady) {
      setError("Email delivery is unavailable. Use a temporary password or configure email first.");
      return;
    }
    setConfirm("credential");
  };

  const perform = async () => {
    setError(undefined);
    try {
      if (confirm === "mfa") {
        await stepUp.run(() => actions.resetMfa(customerId), { reason: "Verify before resetting this account’s authenticators." });
        setNotice("Authenticators reset. The user was signed out and must set up an authenticator app at their next sign-in.");
      } else {
        const input: CredentialInput = mode === "enter_temporary" ? { customerId, mode, password } : { customerId, mode };
        setPassword(""); // remove submitted secrets before a potential step-up dialog, success or network error
        const result = await stepUp.run(() => actions.setCredential(input), { reason: "Verify before changing this account’s login credentials." });
        if (result.temporaryPassword) {
          setGenerated(result.temporaryPassword);
        } else if (mode === "email_link") {
          setNotice("Set-password email queued. Delivery is not yet confirmed. The user’s active sessions were revoked.");
        } else {
          setNotice("Temporary password set. The user was signed out and must change it at their next sign-in.");
        }
      }
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setError(errorMessage(err, "We could not confirm the change. Check the audit trail before trying again."));
      // Close after an error: the entered password has already been cleared.
    }
  };

  return (
    <div className="ph-no-capture grid gap-4" data-clarity-mask="true">
      {notice ? <Callout tone="success" live="polite">{notice}</Callout> : null}
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
      <Card as="section" title="Password administration" description="Start a password change without reading the user’s current password.">
        <form onSubmit={review} className="grid max-w-xl gap-4" noValidate>
          <Field label="Reset method" required>
            <Select value={mode} onChange={(event) => selectMode(event.target.value)}
              options={[
                { value: "generate_temporary", label: "Generate a temporary password" },
                { value: "enter_temporary", label: "Enter a temporary password" },
                { value: "email_link", label: "Email a set-password link", disabled: !emailReady },
              ]} />
          </Field>
          {email.state !== "ready" ? <Callout tone={email.state === "checking" ? "info" : "warning"}
            title={email.state === "checking" ? "Checking email delivery" : "Set-password email unavailable"}>
            {email.summary ?? (email.state === "checking" ? "Temporary password methods are still available."
              : "Temporary password methods are available. An administrator can configure a sender and delivery route in Email Delivery.")}
          </Callout> : null}
          {mode === "enter_temporary" ? (
            <Field label="Temporary password" required error={validationError}
              hint="Choose at least 15 characters. The user must replace this password at the next sign-in.">
              <Input type="password" autoComplete="new-password" value={password} maxLength={512} spellCheck={false}
                onChange={(event) => setPassword(event.target.value)} />
            </Field>
          ) : mode === "generate_temporary" ? (
            <p className="text-sm text-body">A temporary password will be shown once. Share it securely with the user and never paste it into this account’s notes or support messages.</p>
          ) : (
            <p className="text-sm text-body">A single-use link will be sent to the user’s verified email address. Their previous password will stop working immediately.</p>
          )}
          <div><Button type="submit" leadingIcon={<KeyRound aria-hidden="true" />} disabled={mode === "email_link" && !emailReady}>Review password change</Button></div>
        </form>
      </Card>
      <Card as="section" title="Multi-factor authentication" description="Reset enrollment only after confirming the user’s identity according to your support policy."
        actions={<Badge tone="warning">High impact</Badge>}>
        <p className="mb-3 text-sm text-body">Resetting removes all authenticator apps, passkeys and recovery codes. It also signs the user out of every active session.</p>
        <Button variant="secondary" className="max-w-full whitespace-normal py-2 text-center"
          leadingIcon={<ShieldAlert aria-hidden="true" />} onClick={() => {
          setError(undefined); setNotice(undefined); setPassword(""); setConfirm("mfa");
        }}>Reset multi-factor authentication</Button>
      </Card>
      {confirm ? (
        <ConfirmDialog open destructive onOpenChange={(open) => {
          if (!open) { setConfirm(null); setPassword(""); }
        }}
        title={confirm === "mfa" ? "Reset multi-factor authentication?" : "Apply this password change?"}
        description={confirm === "mfa"
          ? "Existing authenticators and recovery codes will stop working. The user will need to re-enroll after signing in."
          : "The user will be signed out everywhere and must choose a new password. A security notification will be saved to their account."}
        confirmLabel={confirm === "mfa" ? "Reset MFA" : "Apply password change"} onConfirm={perform} />
      ) : null}
      {generated ? (
        <Dialog open title="Temporary password generated" description="This password is shown once. The user must change it when they sign in."
          onOpenChange={(open) => !open && (setGenerated(undefined), setNotice("Temporary password set. The user’s sessions were revoked."))}>
          <div className="ph-no-capture grid gap-3 pb-2" data-clarity-mask="true">
            <CodeBlock label="Temporary password" copyable wrap>{generated}</CodeBlock>
            <div className="flex justify-end"><Button onClick={() => {
              setGenerated(undefined);
              setNotice("Temporary password set. The user’s sessions were revoked.");
            }}>Done</Button></div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
