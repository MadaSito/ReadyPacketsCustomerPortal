import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useQuery } from "@tanstack/react-query";
import { Fingerprint, KeyRound, Smartphone } from "lucide-react";
import { Suspense, useState, type FormEvent, type ReactNode } from "react";
import type { UserRole } from "@shared/domain";
import { SECURITY_CARDS } from "@/app/registry";
import { clearRecoveryBatch, stageRecoveryBatch } from "@/lib/recoveryBatch";
import type { SecurityCard } from "@/lib/routes";
import { RUNTIME } from "@/lib/runtime";
import { useRefreshSession, useSession } from "@/lib/session";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, CodeBlock, ConfirmDialog, DateTime, Dialog, EmptyState,
  ErrorState, Field, Input, PageHeader, Skeleton, Spinner, StepUpCancelledError, useStepUp,
} from "@/ui";
import type { StepUpApi } from "@/ui";

type AssuranceClient = ReturnType<typeof useTRPCClient>["assurance"];
export type SecurityState = Awaited<ReturnType<AssuranceClient["getState"]["query"]>>;
export type Passkeys = Awaited<ReturnType<AssuranceClient["listPasskeys"]["query"]>>;
type Setup = Awaited<ReturnType<AssuranceClient["beginTotpEnrollment"]["mutate"]>>;
type PasskeySetup = Awaited<ReturnType<AssuranceClient["beginPasskeyRegistration"]["mutate"]>>;
type Batch = Awaited<ReturnType<AssuranceClient["regenerateRecoveryCodes"]["mutate"]>>;
type Key = Passkeys[number];

export interface SecurityActions {
  beginTotp: () => Promise<Setup>;
  confirmTotp: (code: string) => Promise<Awaited<ReturnType<AssuranceClient["confirmTotpEnrollment"]["mutate"]>>>;
  disableTotp: () => Promise<unknown>;
  regenerate: () => Promise<Batch>;
  acknowledge: (recoverySetId: string) => Promise<unknown>;
  beginPasskey: () => Promise<PasskeySetup>;
  finishPasskey: (input: Parameters<AssuranceClient["finishPasskeyRegistration"]["mutate"]>[0]) => Promise<unknown>;
  renamePasskey: (publicId: string, name: string) => Promise<unknown>;
  removePasskey: (publicId: string) => Promise<unknown>;
}

type ActiveDialog = { kind: "totp"; setup: Setup } | { kind: "passkey"; setup: PasskeySetup }
  | { kind: "recovery"; batch: Batch } | { kind: "rename"; key: Key } | null;
type Confirmation = { kind: "regenerate" | "disable_totp" } | { kind: "remove_passkey"; key: Key } | null;

const heading = <PageHeader title="Account security" description="Manage the methods you use to verify your identity when you sign in or make sensitive changes." />;

const TWO_FACTOR_ORDER = 20;
const roleRank = { customer: 0, staff: 1, admin: 2 } as const;

/** The registry owns ordering. Contributors provide their own labelled regions. */
export function SecurityCardSlot({ viewerRole, position, cards = SECURITY_CARDS }: {
  viewerRole: UserRole | undefined;
  position: "before" | "after";
  cards?: readonly SecurityCard[];
}) {
  if (!viewerRole) return null;
  return cards.filter(({ access, order }) => roleRank[viewerRole] >= roleRank[access] && (
    position === "before" ? order < TWO_FACTOR_ORDER : order >= TWO_FACTOR_ORDER
  )).map(({ key, component: Component }) => (
    <Suspense key={key} fallback={<Spinner label="Loading security settings" />}>
      <Component />
    </Suspense>
  ));
}

export default function SecurityPage() {
  const trpc = useTRPC();
  const api = useTRPCClient().assurance;
  const stepUp = useStepUp();
  const refreshSession = useRefreshSession();
  const { me, view } = useSession();
  const role = view.status === "full" ? me?.user.role : undefined;
  const state = useQuery(trpc.assurance.getState.queryOptions());
  const passkeys = useQuery(trpc.assurance.listPasskeys.queryOptions());
  const refresh = () => { void state.refetch(); void passkeys.refetch(); };
  if (state.isPending || passkeys.isPending) {
    return <>{heading}<div role="status" className="flex flex-col gap-3"><span className="sr-only">Loading account security</span><Skeleton lines={4} /></div></>;
  }
  if (state.isError || passkeys.isError) {
    return <>{heading}<ErrorState title="Account security could not load" error={state.error ?? passkeys.error} onRetry={refresh} /></>;
  }
  const actions: SecurityActions = {
    // Keep secret inputs and one-time outputs out of the TanStack Query mutation cache.
    beginTotp: () => api.beginTotpEnrollment.mutate(), confirmTotp: (code) => api.confirmTotpEnrollment.mutate({ code }),
    disableTotp: () => api.disableTotp.mutate(), regenerate: () => api.regenerateRecoveryCodes.mutate(),
    acknowledge: (recoverySetId) => api.acknowledgeRecoveryCodes.mutate({ recoverySetId }),
    beginPasskey: () => api.beginPasskeyRegistration.mutate(), finishPasskey: (input) => api.finishPasskeyRegistration.mutate(input),
    renamePasskey: (publicId, name) => api.renamePasskey.mutate({ publicId, name }),
    removePasskey: (publicId) => api.removePasskey.mutate({ publicId }),
  };
  return <SecuritySettings state={state.data} passkeys={passkeys.data} actions={actions} stepUp={stepUp} refresh={refresh}
    onUnacknowledgedExit={() => { void refreshSession(); }}
    passkeysSupported={!RUNTIME.preview && browserSupportsWebAuthn()}
    beforeTwoFactor={<SecurityCardSlot viewerRole={role} position="before" />}
    afterTwoFactor={<SecurityCardSlot viewerRole={role} position="after" />} />;
}

export function SecuritySettings({
  state, passkeys, actions, stepUp, refresh, passkeysSupported, onUnacknowledgedExit, beforeTwoFactor, afterTwoFactor,
}: {
  state: SecurityState;
  passkeys: Passkeys;
  actions: SecurityActions;
  stepUp: StepUpApi;
  refresh: () => void;
  passkeysSupported: boolean;
  onUnacknowledgedExit: () => void;
  beforeTwoFactor?: ReactNode;
  afterTwoFactor?: ReactNode;
}) {
  const [dialog, setDialog] = useState<ActiveDialog>(null);
  const [confirm, setConfirm] = useState<Confirmation>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const remaining = state.recoveryCodesRemaining;

  const resetForm = () => { setInput(""); setError(undefined); };
  const close = () => { setDialog(null); resetForm(); };
  const opened = (next: ActiveDialog, value = "") => { setInput(value); setError(undefined); setStatus(undefined); setDialog(next); };
  const showRecovery = (batch: Batch) => {
    // A session refetch can move the user to remediation while the dialog is still open.
    stageRecoveryBatch(batch);
    opened({ kind: "recovery", batch });
  };
  const ask = (next: Confirmation) => { resetForm(); setStatus(undefined); setConfirm(next); };
  const completed = (message: string) => { close(); setStatus(message); refresh(); };

  const run = async (work: () => Promise<void>): Promise<boolean> => {
    resetError();
    setBusy(true);
    try {
      await work();
      return true;
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) {
        setError(err instanceof Error && err.name === "NotAllowedError"
          ? "Your device did not complete the passkey request. Check its prompt or start again."
          : errorMessage(err, "We could not confirm this action. Check your security settings before trying again."));
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  const resetError = () => { setError(undefined); setStatus(undefined); };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!dialog) return;
    void run(async () => {
      if (dialog.kind === "totp") {
        const result = await stepUp.run(() => actions.confirmTotp(input.replace(/\s+/g, "")), { reason: "Verify to save a new authenticator app." });
        if (result.recoveryCodes && result.recoverySetId) {
          showRecovery({ recoveryCodes: result.recoveryCodes, recoverySetId: result.recoverySetId });
        } else completed("Authenticator app saved.");
      } else if (dialog.kind === "passkey") {
        const response = await startRegistration({ optionsJSON: dialog.setup.options });
        await stepUp.run(() => actions.finishPasskey({ challengeId: dialog.setup.challengeId, response, name: input }),
          { reason: "Verify to save this passkey." });
        completed("Passkey saved.");
      } else if (dialog.kind === "rename") {
        await stepUp.run(() => actions.renamePasskey(dialog.key.publicId, input), { reason: "Verify to rename this passkey." });
        completed("Passkey renamed.");
      } else {
        await actions.acknowledge(dialog.batch.recoverySetId);
        clearRecoveryBatch();
        completed("Recovery codes saved.");
      }
    });
  };

  const confirmationAction = async () => {
    if (!confirm) return;
    const success = await run(async () => {
      if (confirm.kind === "regenerate") {
        const batch = await stepUp.run(actions.regenerate, { reason: "Verify to replace every existing recovery code." });
        showRecovery(batch);
      } else if (confirm.kind === "disable_totp") {
        await stepUp.run(actions.disableTotp, { reason: "Verify before removing your authenticator app." });
        completed("Authenticator app removed.");
      } else if (confirm.kind === "remove_passkey") {
        await stepUp.run(() => actions.removePasskey(confirm.key.publicId), { reason: "Verify before removing this passkey." });
        completed("Passkey removed.");
      }
    });
    if (!success) throw new Error("ASSURANCE_ACTION_NOT_CONFIRMED");
  };

  return (
    <div className="ph-no-capture" data-clarity-mask="true">
      {heading}
      <div className="grid gap-4">
        {error && !dialog && !confirm ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        {status ? <Callout tone="success" live="polite">{status}</Callout> : null}
        {beforeTwoFactor}
        <Card as="section" title="Authenticator app" description="Use six-digit, time-based codes from your authenticator app."
          actions={<Badge tone={state.totpEnrolled ? "success" : "neutral"}>{state.totpEnrolled ? "Enabled" : "Not set up"}</Badge>}>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} leadingIcon={<Smartphone aria-hidden="true" />}
              onClick={() => void run(async () => opened({ kind: "totp", setup: await stepUp.run(actions.beginTotp, { reason: "Verify before changing your authenticator app." }) }))}>
              {state.totpEnrolled ? "Replace authenticator app" : "Set up authenticator app"}
            </Button>
            {state.totpEnrolled ? <Button variant="ghost" disabled={!passkeys.length || busy} onClick={() => ask({ kind: "disable_totp" })}>Remove authenticator app</Button> : null}
          </div>
          {state.totpEnrolled && !passkeys.length ? <p className="mt-3 text-sm text-muted">Register a passkey before removing your authenticator app.</p> : null}
        </Card>
        <Card as="section" title="Passkeys" description="Use your device PIN, biometrics or a security key after signing in with your password."
          actions={<Button variant="secondary" disabled={!passkeysSupported || busy || passkeys.length >= 10} leadingIcon={<Fingerprint aria-hidden="true" />}
            onClick={() => void run(async () => opened({ kind: "passkey", setup: await stepUp.run(actions.beginPasskey, { reason: "Verify before adding a passkey." }) }))}>Add passkey</Button>}>
          {!passkeysSupported ? <p className="mb-3 text-sm text-muted">Adding passkeys requires a supported browser on the ReadyPackets portal. It is not available in an embedded preview.</p> : null}
          {passkeys.length ? (
            <ul aria-label="Registered passkeys" className="divide-y divide-line">
              {passkeys.map((key) => (
                <li key={key.publicId} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="font-medium text-ink wrap-anywhere">{key.name}</p>
                    <p className="text-sm text-muted">
                      Added <DateTime value={key.createdAt} format="date" />. {key.lastUsedAt ? <>Last used <DateTime value={key.lastUsedAt} format="relative" />.</> : "Not used yet."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" aria-label={`Rename ${key.name}`} disabled={busy} onClick={() => opened({ kind: "rename", key }, key.name)}>Rename</Button>
                    <Button variant="secondary" aria-label={`Remove ${key.name}`} disabled={busy || (passkeys.length === 1 && !state.totpEnrolled)}
                      onClick={() => ask({ kind: "remove_passkey", key })}>Remove</Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : <EmptyState headingLevel={3} icon={Fingerprint} title="No passkeys registered" description="Add a passkey to give yourself a sign-in option that resists phishing." />}
          {passkeys.length === 1 && !state.totpEnrolled ? <p className="mt-3 text-sm text-muted">Add another passkey or authenticator app before removing this passkey.</p> : null}
        </Card>
        <Card as="section" title="Recovery codes" description="Use one code to sign in when your other methods are unavailable."
          actions={<Badge tone={remaining > 0 ? "neutral" : "warning"}>{remaining} {remaining === 1 ? "code" : "codes"} left</Badge>}>
          <p className="mb-3 text-sm text-body">Keep these single-use codes separate from your password. Creating a new set immediately invalidates the previous one.</p>
          <Button variant="secondary" leadingIcon={<KeyRound aria-hidden="true" />} disabled={busy} onClick={() => ask({ kind: "regenerate" })}>
            Generate new recovery codes
          </Button>
        </Card>
        {busy && !dialog && !confirm ? <Spinner label="Working on your security settings" /> : null}
        {afterTwoFactor}
      </div>
      {confirm ? <ConfirmDialog open onOpenChange={(open) => !open && (setConfirm(null), setError(undefined))}
        destructive title={confirm.kind === "regenerate" ? "Replace your recovery codes?" : confirm.kind === "disable_totp" ? "Remove your authenticator app?" : "Remove this passkey?"}
        description={confirm.kind === "regenerate" ? "Any previously saved codes will stop working immediately. Store the new set before you close it."
          : "You can no longer use this method to sign in. Your remaining methods will still work."}
        confirmLabel={confirm.kind === "regenerate" ? "Generate new codes" : "Remove method"} onConfirm={confirmationAction}>
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
      </ConfirmDialog> : null}
      {dialog ? <Dialog open onOpenChange={(open) => !open && close()} dismissible={!busy && dialog.kind !== "recovery"}
        title={dialog.kind === "totp" ? "Set up your authenticator app" : dialog.kind === "passkey" ? "Register a passkey"
          : dialog.kind === "rename" ? "Rename passkey" : "Save your recovery codes"}
        description={dialog.kind === "recovery" ? "These codes are shown once. Store them somewhere safe before continuing."
          : dialog.kind === "totp" ? "Scan the QR code or enter the setup key into your authenticator app."
            : dialog.kind === "passkey" ? "Give this passkey a recognizable name, then follow your device’s instructions."
              : "Choose a name that helps you recognize this passkey."}>
        <form className="ph-no-capture flex flex-col gap-4" data-clarity-mask="true" onSubmit={submit}>
          {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
          {dialog.kind === "totp" ? <>
            <img className="h-auto max-w-full self-start rounded-[var(--radius-control)]" width={200} height={200}
              src={dialog.setup.qrDataUrl} alt="Authenticator setup QR code. The same setup information can be entered as the key below." />
            <CodeBlock label="Authenticator setup key" copyable wrap>{dialog.setup.secret}</CodeBlock>
            <Field label="Six-digit verification code" required>
              <Input inputMode="numeric" autoComplete="one-time-code" value={input} maxLength={8}
                pattern="[0-9 ]{6,8}" onChange={(e) => setInput(e.target.value)} required />
            </Field>
          </> : dialog.kind === "recovery" ? (
            <CodeBlock label="Recovery codes" copyable wrap>{dialog.batch.recoveryCodes.join("\n")}</CodeBlock>
          ) : (
            <Field label="Passkey name" required>
              <Input value={input} onChange={(event) => setInput(event.target.value)} autoComplete="off" maxLength={80} required />
            </Field>
          )}
          <div className="flex flex-col gap-2 pb-2 sm:flex-row sm:justify-end">
            {dialog.kind !== "recovery" ? <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button> : null}
            {dialog.kind === "recovery" ? <Button variant="secondary" onClick={() => { clearRecoveryBatch(); close(); refresh(); onUnacknowledgedExit(); }}
              disabled={busy}>Close without saving</Button> : null}
            <Button type="submit" loading={busy}>
              {dialog.kind === "recovery" ? "I saved my recovery codes"
                : dialog.kind === "passkey" ? "Continue on this device" : "Save"}
            </Button>
          </div>
        </form>
      </Dialog> : null}
    </div>
  );
}
