import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { roleHasCapability } from "@shared/capabilities";
import { Button, Callout, Card, Checkbox, ConfirmDialog, ErrorState, Field, Input, Skeleton, StepUpCancelledError, Textarea, useStepUp } from "@/ui";

const warningHint = "Plain text. Placeholders: {policy}, {deadline}, and {timeLeft}. Up to 1,000 characters.";

export function PolicyDefaultWarningCard() {
  const api = useTRPC().compliance.policies.enforcement;
  const query = useQuery(api.defaultStatus.queryOptions());
  const save = useMutation(api.setDefaultWarning.mutationOptions());
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState("");
  return (
    <Card title="Default enforcement warning" headingLevel={2}>
      {query.isPending ? <Skeleton lines={3} /> : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          setError(undefined);
          void save.mutateAsync({ warningText: value ?? query.data.warningText }).then(async () => {
            await query.refetch();
            setValue(null);
            setMessage("Default enforcement warning saved.");
          }).catch((cause: unknown) => setError(errorMessage(cause)));
        }}>
          {query.data.disabledByHost ? <Callout tone="warning" title="Emergency override active">Session enforcement is disabled on this server. Existing acceptance requirements still apply.</Callout> : null}
          <Field label="Default warning" hint={warningHint} error={error} required>
            <Textarea required maxLength={1000} rows={3} value={value ?? query.data.warningText} onChange={(event) => setValue(event.target.value)} />
          </Field>
          {error ? <p className="sr-only" role="alert">{error}</p> : null}
          <Button type="submit" variant="secondary" loading={save.isPending}>Save default warning</Button>
          <p role="status" className="sr-only">{message}</p>
        </form>
      )}
    </Card>
  );
}

export function PolicyEnforcementCard({ documentPublicId }: { documentPublicId: string }) {
  const api = useTRPC().compliance.policies.enforcement;
  const query = useQuery(api.status.queryOptions({ documentPublicId }));
  const heading = useRef<HTMLHeadingElement>(null);
  const [message, setMessage] = useState("");
  return <Card>
    <div className="space-y-4">
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">Session enforcement</h2>
      <p className="text-sm text-muted">After the grace period, users must review and accept the current policy before they can continue.</p>
      <p role="status" className="sr-only">{message}</p>
      {query.isPending ? <Skeleton lines={3} /> : query.isError
        ? <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        : <ConfigForm key={`${documentPublicId}:${query.data.expectedVersion}`} documentPublicId={documentPublicId} initial={query.data}
          onSaved={() => {
            const active = document.activeElement;
            void query.refetch().then(() => {
              setMessage("Enforcement settings saved.");
              requestAnimationFrame(() => {
                if (document.activeElement === document.body || document.activeElement === active && active instanceof HTMLElement && !active.isConnected) {
                  heading.current?.focus();
                }
              });
            });
          }} />}
    </div>
  </Card>;
}

interface EnforcementConfig {
  disabledByHost: boolean;
  canEnable: boolean;
  mode: "none" | "required_to_continue";
  graceHours: number;
  warningText: string | null;
  expectedVersion: number;
  affectedCount: number;
}

function ConfigForm({ documentPublicId, initial, onSaved }: { documentPublicId: string; initial: EnforcementConfig; onSaved: () => void }) {
  const api = useTRPC().compliance.policies.enforcement;
  const save = useMutation(api.configure.mutationOptions());
  const [enabled, setEnabled] = useState(initial.mode === "required_to_continue");
  const [grace, setGrace] = useState(String(initial.graceHours));
  const [warning, setWarning] = useState(initial.warningText ?? "");
  const [confirmedCount, setConfirmedCount] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [graceError, setGraceError] = useState<string>();
  const graceRef = useRef<HTMLInputElement>(null);

  const submit = async (confirmedCount?: number) => {
    setError(undefined);
    try {
      await save.mutateAsync({
        documentPublicId, expectedVersion: initial.expectedVersion,
        mode: enabled ? "required_to_continue" : "none", graceHours: Number(grace),
        warningText: warning.trim() || null, ...(confirmedCount !== undefined ? { confirmedCount } : {}),
      });
      onSaved();
    } catch (cause) { setError(errorMessage(cause)); throw cause; }
  };

  return (
    <>
      <form className="space-y-4" noValidate onSubmit={(event) => {
        event.preventDefault();
        setError(undefined);
        setGraceError(undefined);
        if (!/^\d+$/u.test(grace) || Number(grace) > 720) {
          setGraceError("Enter a whole number from 0 to 720.");
          graceRef.current?.focus();
          return;
        }
        if (enabled && (initial.mode === "none" || Number(grace) < initial.graceHours)) setConfirmedCount(initial.affectedCount);
        else void submit().catch(() => undefined);
      }}>
        {initial.disabledByHost ? <Callout tone="warning" title="Emergency override active">Your server is not enforcing policy sign-outs. Other acceptance requirements still apply.</Callout> : null}
        {!initial.canEnable ? <p className="text-sm text-muted">Publish an active policy requiring acceptance first.</p> : null}
        <Checkbox label="Require acceptance to continue using the portal" checked={enabled} onCheckedChange={setEnabled}
          disabled={!enabled && (!initial.canEnable || initial.disabledByHost)} />
        <Field label="Grace period (hours)" hint="Use 0 to require acceptance as soon as the current version becomes effective." error={graceError}>
          <Input ref={graceRef} value={grace} inputMode="numeric" maxLength={3} onChange={(event) => setGrace(event.target.value)} className="max-w-32" />
        </Field>
        <Field label="Custom warning" hint={`${warningHint} Leave blank to use the site-wide warning.`}>
          <Textarea rows={3} maxLength={1000} value={warning} onChange={(event) => setWarning(event.target.value)} />
        </Field>
        {graceError ? <p className="sr-only" role="alert">{graceError}</p> : null}
        {confirmedCount === null && error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Button type="submit" loading={save.isPending}>Save enforcement settings</Button>
      </form>
      <ConfirmDialog open={confirmedCount !== null} onOpenChange={(open) => { if (!open) { setConfirmedCount(null); setError(undefined); } }}
        title={initial.mode === "none" ? "Turn on policy session enforcement?" : "Shorten the grace period?"}
        description={`${confirmedCount ?? 0} ${confirmedCount === 1 ? "person in this audience has" : "people in this audience have"} not accepted the current version. Users who do not accept by the deadline will be signed out.`}
        confirmLabel="Confirm enforcement" destructive onConfirm={() => submit(confirmedCount ?? undefined)}>
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
      </ConfirmDialog>
    </>
  );
}

export function EndPolicySessionsAction({ userPublicId, versionPublicId, customerName, checkOnDemand = false }: {
  userPublicId: string; versionPublicId?: string | undefined; customerName?: string | undefined; checkOnDemand?: boolean;
}) {
  const api = useTRPC().compliance.policies.enforcement;
  const { me } = useSession();
  const stepUp = useStepUp();
  const allowed = me ? roleHasCapability(me.user.role, "sessions.revoke_any") : false;
  const target = { userPublicId, ...(versionPublicId ? { versionPublicId } : {}) };
  const query = useQuery(api.forTarget.queryOptions(target, { enabled: allowed && !checkOnDemand }));
  const action = useMutation(api.endNow.mutationOptions());
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("");
  if (!allowed) return null;
  return <>
    {checkOnDemand || query.data?.canEndSessions ? (
      <Button variant="secondary" size="sm" aria-busy={query.isFetching || undefined}
        aria-label={customerName ? `End sessions now for ${customerName}` : undefined}
        onClick={() => {
          if (query.isFetching) return;
          setStatus("");
          if (!checkOnDemand) { setConfirm(true); return; }
          void query.refetch({ throwOnError: true }).then((result) => {
            if (result.data?.canEndSessions) setConfirm(true);
            else setStatus("No enforced policy is pending for this customer.");
          }).catch((cause: unknown) => setStatus(errorMessage(cause, "Could not check policy enforcement.")));
        }}>
        End sessions now
      </Button>
    ) : null}
    <p role="status" className={status ? "break-words text-xs text-muted" : "sr-only"}>{status}</p>
    <ConfirmDialog open={confirm} onOpenChange={(open) => { setConfirm(open); if (!open) setError(undefined); }}
      title="End all sessions for this user?" description="This signs the user out of all devices. They must accept the current policy to continue."
      destructive confirmLabel="End sessions now" onConfirm={async () => {
        try {
          const result = await stepUp.run(() => action.mutateAsync(target), { reason: "Ending another user's sessions requires fresh verification." });
          setStatus(result.ended === 1 ? "Ended 1 session." : `Ended ${result.ended} sessions.`);
        } catch (cause) {
          if (!(cause instanceof StepUpCancelledError)) setError(errorMessage(cause));
          throw cause;
        }
      }}>
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
    </ConfirmDialog>
  </>;
}
