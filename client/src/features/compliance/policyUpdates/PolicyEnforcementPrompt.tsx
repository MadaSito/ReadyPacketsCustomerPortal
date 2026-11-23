import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useRef, useState, type FormEvent, type Ref } from "react";
import { useLocation } from "wouter";
import { useRefreshSession, useSession } from "@/lib/session";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Button, Callout, Card, Checkbox, ConfirmDialog, Countdown, DateTime, Dialog, ErrorState, Field, Input, Skeleton } from "@/ui";
import { RequiredPolicyForms, usePolicyStatus } from "../customer/PolicyAcceptance";
import { SafePolicyText } from "../shared";

function usePendingEnforcement() {
  const api = useTRPC().compliance.policies.enforcement;
  return useQuery(api.pending.queryOptions(undefined, { staleTime: 0, refetchOnWindowFocus: true }));
}

type Pending = NonNullable<ReturnType<typeof usePendingEnforcement>["data"]>[number];

function WarningMessage({ item, onElapsed }: { item: Pending; onElapsed?: () => void }) {
  const parts = item.warningText.split(/(\{policy\}|\{deadline\}|\{timeLeft\})/u);
  const time = parts.indexOf("{timeLeft}");
  return (
    <p className="break-words whitespace-pre-wrap">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part === "{policy}" ? item.title : part === "{deadline}" ? <DateTime value={item.deadline} /> : part === "{timeLeft}" ? (
            <Countdown to={item.deadline} label={`Time left to accept ${item.title}`} announce={time === index ? "milestones" : "off"}
              {...(time === index && onElapsed ? { onElapsed } : {})} elapsedText="Deadline reached" />
          ) : part}
        </Fragment>
      ))}
      {time === -1 ? (
        <> Time remaining: <Countdown to={item.deadline} label={`Time left to accept ${item.title}`} {...(onElapsed ? { onElapsed } : {})} elapsedText="Deadline reached" />.</>
      ) : null}
    </p>
  );
}

function AcceptanceForm({ item, onAccepted }: { item: Pending; onAccepted?: () => void }) {
  const api = useTRPC().compliance.policies;
  const refreshSession = useRefreshSession();
  const { me } = useSession();
  const qc = useQueryClient();
  const accept = useMutation(api.enforcement.accept.mutationOptions());
  const id = useId();
  const [consent, setConsent] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();
  const [expectedName, setExpectedName] = useState<string>();
  const signerRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLParagraphElement>(null);
  const [reviewed, setReviewed] = useState(false);
  const inFlight = useRef(false);

  const checkEnd = () => {
    const node = scrollRef.current;
    if (node && node.scrollTop + node.clientHeight >= node.scrollHeight - 2) setReviewed(true);
  };
  useEffect(() => {
    checkEnd();
    const node = scrollRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(checkEnd);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reviewed || !consent || inFlight.current) return;
    setFieldError(undefined);
    setError(undefined);
    if (item.requiresTypedSignature && !signerName.trim()) {
      setFieldError("Type the full name on your account.");
      signerRef.current?.focus();
      return;
    }
    inFlight.current = true;
    try {
      await accept.mutateAsync({
        versionPublicId: item.versionPublicId, contentHash: item.contentHash,
        ...(item.requiresTypedSignature ? { signerName: signerName.trim() } : {}),
      });
      setSignerName("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: api.enforcement.pending.queryKey() }),
        qc.invalidateQueries({ queryKey: api.myStatus.queryKey() }),
        refreshSession(),
      ]);
      onAccepted?.();
    } catch (cause) {
      const safe = safeError(cause);
      if (item.requiresTypedSignature && (safe?.reasonCode === "SIGNER_NAME_MISMATCH" || safe?.reasonCode === "TYPED_SIGNATURE_REQUIRED")) {
        const verifiedName = safe.details?.expectedName;
        if (typeof verifiedName === "string" && verifiedName.trim()) setExpectedName(verifiedName);
        setFieldError(safe.safeMessage);
        signerRef.current?.focus();
      } else {
        setError(errorMessage(cause, "The policy could not be accepted. Review the current version and try again."));
      }
    } finally {
      inFlight.current = false;
    }
  };

  const nameOnAccount = expectedName ?? me?.user.name;
  return (
    <form aria-labelledby={id} onSubmit={(event) => void submit(event)} noValidate className="min-w-0 space-y-4">
      <h2 className="text-lg font-semibold break-words" id={id}>{item.title}</h2>
      <p className="text-sm text-muted">Version {item.versionLabel}</p>
      {item.changeSummary ? <p className="break-words"><strong>What changed:</strong> {item.changeSummary}</p> : null}
      {/* Keyboard users need a tab stop to scroll the exact signed text. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div ref={scrollRef} onScroll={checkEnd} tabIndex={0} role="region" aria-label={`${item.title}, version ${item.versionLabel}, full text`}
        className="max-h-64 min-w-0 overflow-auto rounded-lg border border-line bg-surface-sunken p-4 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-action">
        <SafePolicyText bodyText={item.bodyText} format={item.contentFormat} />
        <p ref={endRef} tabIndex={-1} className="mt-3 text-sm font-medium">End of policy</p>
      </div>
      {!reviewed ? <Button size="sm" variant="secondary" onClick={() => { endRef.current?.focus(); checkEnd(); }}>Go to end of policy</Button> : null}
      <Checkbox label={`I have read and agree to ${item.title}, version ${item.versionLabel}.`} checked={consent} onCheckedChange={setConsent} disabled={!reviewed || accept.isPending} />
      {item.requiresTypedSignature ? (
        <Field label="Type your full name to sign" hint={nameOnAccount
          ? `Use the name on your account: ${nameOnAccount}.`
          : "Use the name on your account."} error={fieldError} required>
          <Input ref={signerRef} autoComplete="name" value={signerName} maxLength={160} onChange={(event) => {
            setSignerName(event.target.value);
            setFieldError(undefined);
          }} />
        </Field>
      ) : null}
      {fieldError ? <p className="sr-only" role="alert">{fieldError}</p> : null}
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
      <Button type="submit" disabled={!reviewed || !consent} loading={accept.isPending}>Accept this version</Button>
    </form>
  );
}

export function PolicyEnforcementRemediation() {
  const pending = usePendingEnforcement();
  const refreshSession = useRefreshSession();
  const [message, setMessage] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <section aria-label="Pending required policies" className="min-w-0 space-y-4">
      <h2 ref={heading} tabIndex={-1} className="sr-only">Pending required policies</h2>
      <p className="sr-only" role="status">{message}</p>
      {pending.isPending ? (
        <div role="status"><span className="sr-only">Loading required policies</span><Skeleton lines={4} /></div>
      ) : pending.isError ? <ErrorState error={pending.error} onRetry={() => void pending.refetch()} /> : (
        pending.data.filter((item) => item.blocking).length ? pending.data.filter((item) => item.blocking).map((item) => (
          <Card key={`${item.versionPublicId}:${item.contentHash}`}>
            <AcceptanceForm item={item} onAccepted={() => { setMessage("Policy accepted."); heading.current?.focus(); }} />
          </Card>
        )) : (
          <Callout tone="info" title="No policies block your account">
            <Button onClick={() => void refreshSession()}>Refresh access</Button>
          </Callout>
        )
      )}
    </section>
  );
}

const snoozeFallback = new Map<string, number>();
const SNOOZE_PREFIX = "rp:policy-snooze:";

function snoozeStorage() {
  // eslint-disable-next-line no-restricted-properties -- Approved by /root for tab-scoped policy snoozing: opaque public ids in the key and a numeric checkpoint only; no policy text, profile fields, or credentials.
  return window.sessionStorage;
}

function usePolicySnooze(key: string, checkpoint = 0) {
  const [dismissedAt, setDismissedAt] = useState<number | null>(() => {
    const memory = snoozeFallback.get(key);
    if (memory !== undefined) return memory;
    try {
      const value = snoozeStorage().getItem(key);
      return value !== null && /^[0-3]$/u.test(value) ? Number(value) : null;
    } catch { return null; }
  });
  const [reviewing, setReviewing] = useState(false);
  const reminderButton = useRef<HTMLButtonElement>(null);
  function dismiss() {
    setReviewing(false);
    setDismissedAt(checkpoint);
    try {
      snoozeStorage().setItem(key, String(checkpoint));
      snoozeFallback.delete(key);
    } catch { snoozeFallback.set(key, checkpoint); }
  }
  return {
    open: reviewing || dismissedAt === null || checkpoint > dismissedAt,
    hasDismissed: dismissedAt !== null,
    reminderButton,
    dismiss,
    review: () => setReviewing(true),
  };
}

// After "Later", reopen once at each closer deadline milestone: one hour, 15 minutes, one minute.
// Crossing several milestones while the tab is inactive opens only one dialog at the latest one.
const GRACE_MILESTONES_MS = [3_600_000, 900_000, 60_000] as const;
function graceCheckpoint(deadline: number) {
  return GRACE_MILESTONES_MS.filter((milestone) => deadline - Date.now() <= milestone).length;
}

function useGraceCheckpoint(deadline: number) {
  const [checkpoint, setCheckpoint] = useState(() => graceCheckpoint(deadline));
  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      const phase = graceCheckpoint(deadline);
      setCheckpoint(phase);
      const next = GRACE_MILESTONES_MS[phase];
      if (next !== undefined) timer = window.setTimeout(update, Math.min(2_147_483_647, Math.max(1, deadline - next - Date.now())));
    };
    update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [deadline]);
  return checkpoint;
}

function PolicyReminder({ item, onReview, reviewRef }: { item?: Pending; onReview: () => void; reviewRef: Ref<HTMLButtonElement> }) {
  return (
    <section aria-label="Policy review reminder" className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
        <p className="min-w-0 break-words text-sm text-body">
          {item ? <>Accept {item.title} to keep using the portal. Time remaining:{" "}
            <Countdown to={item.deadline} label={`Deadline to accept ${item.title}`} announce="off" elapsedText="Deadline reached" />.</>
            : "Updated policies are ready for your review."}
        </p>
        <Button ref={reviewRef} size="sm" variant="secondary" onClick={onReview}>Review policies</Button>
      </div>
    </section>
  );
}

function GraceDialog({ item, snoozeKey, onElapsed }: { item: Pending; snoozeKey: string; onElapsed: () => void }) {
  const api = useTRPC().compliance.policies.enforcement;
  const refreshSession = useRefreshSession();
  const decline = useMutation(api.decline.mutationOptions());
  const checkpoint = useGraceCheckpoint(item.deadline.getTime());
  const snooze = usePolicySnooze(snoozeKey, checkpoint);
  const [reading, setReading] = useState(false);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [error, setError] = useState<string>();
  const readerHeading = useRef<HTMLHeadingElement>(null);
  const dismiss = () => { setReading(false); snooze.dismiss(); };
  return (
    <>
      {snooze.hasDismissed ? <PolicyReminder item={item} onReview={snooze.review} reviewRef={snooze.reminderButton} /> : null}
      <Dialog open={snooze.open && !confirmDecline} onOpenChange={(open) => { if (!open) dismiss(); }}
        returnFocusRef={!snooze.open && !confirmDecline ? snooze.reminderButton : undefined}
        title={reading ? "Read and accept the policy" : "An updated policy needs your attention"}
        description={reading ? "Review the exact version before accepting." : "You can review now or return before the deadline."}
        size="lg" footer={
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button variant="secondary" onClick={dismiss}>Later</Button>
            <Button variant="secondary" onClick={() => setConfirmDecline(true)}>I do not accept</Button>
            {!reading ? <Button onClick={() => { setReading(true); requestAnimationFrame(() => readerHeading.current?.focus()); }}>Read and accept</Button> : null}
          </div>
        }>
        <div className="space-y-3">
          <WarningMessage item={item} onElapsed={onElapsed} />
          {reading ? (
            <div>
              <h2 tabIndex={-1} ref={readerHeading} className="sr-only">Policy text and acceptance</h2>
              <AcceptanceForm item={item} onAccepted={dismiss} />
            </div>
          ) : item.changeSummary ? <p className="break-words"><strong>What changed:</strong> {item.changeSummary}</p> : null}
        </div>
      </Dialog>
      <ConfirmDialog open={confirmDecline} onOpenChange={setConfirmDecline} title="Decline this policy?"
        description="This signs you out of every device. To use the portal again, sign in, review and accept the policy."
        destructive confirmLabel="Decline and sign out" onConfirm={async () => {
          setError(undefined);
          try {
            await decline.mutateAsync({ versionPublicId: item.versionPublicId });
            snooze.dismiss();
            await refreshSession();
          } catch (cause) { setError(errorMessage(cause)); throw cause; }
        }}>
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
      </ConfirmDialog>
    </>
  );
}

function RequiredUpdateDialog({ policies, expectedSignerName, snoozeKey }: {
  policies: NonNullable<ReturnType<typeof usePolicyStatus>["data"]>["pendingRequired"];
  expectedSignerName?: string | null;
  snoozeKey: string;
}) {
  const snooze = usePolicySnooze(snoozeKey);
  return (
    <>
      {snooze.hasDismissed ? <PolicyReminder onReview={snooze.review} reviewRef={snooze.reminderButton} /> : null}
      <Dialog open={snooze.open} onOpenChange={(open) => { if (!open) snooze.dismiss(); }} title="Updated policies need your review"
        returnFocusRef={!snooze.open ? snooze.reminderButton : undefined}
        description="Review the latest required versions. You can read and accept them here, or return later."
        size="lg" footer={<Button variant="secondary" onClick={snooze.dismiss}>Later</Button>}>
        <div className="min-w-0 space-y-4">
          {policies.filter((item) => item.changeSummary).map((item) => (
            <p key={item.versionPublicId} className="break-words"><strong>{item.title}, what changed:</strong> {item.changeSummary}</p>
          ))}
          <RequiredPolicyForms policies={policies} expectedSignerName={expectedSignerName} />
        </div>
      </Dialog>
    </>
  );
}

/** Mount only inside a full-session shell. Closing the grace warning does not change server policy. */
export function PolicyEnforcementPrompt() {
  const pending = usePendingEnforcement();
  const required = usePolicyStatus();
  const refreshSession = useRefreshSession();
  const { me } = useSession();
  const [location] = useLocation();
  const refetchEnforcement = pending.refetch;
  const refetchRequired = required.refetch;
  useEffect(() => { void refetchEnforcement(); void refetchRequired(); }, [location, refetchEnforcement, refetchRequired]);
  const item = pending.data?.reduce<Pending | undefined>((first, candidate) =>
    !first || (candidate.blocking && !first.blocking) || (candidate.blocking === first.blocking && candidate.deadline < first.deadline)
      ? candidate : first, undefined);
  const deadline = item?.deadline.getTime();
  // Keep tracking the server's deadline after the user closes the grace dialog. Scheduling the
  // refresh does not enforce access; server session resolution is authoritative.
  useEffect(() => {
    if (deadline === undefined) return;
    let timer: number | undefined;
    const schedule = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) void refreshSession();
      else timer = window.setTimeout(schedule, Math.min(2_147_483_647, remaining));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [deadline, refreshSession]);
  if (!me) return null;
  if (item) {
    const snoozeKey = `${SNOOZE_PREFIX}${me.user.publicId}:grace:${item.versionPublicId}:${deadline}`;
    return <GraceDialog key={snoozeKey} snoozeKey={snoozeKey} item={item} onElapsed={() => { void refreshSession(); }} />;
  }
  if (pending.isPending || pending.isError) return null;
  const policies = required.data?.pendingRequired ?? [];
  const snoozeKey = `${SNOOZE_PREFIX}${me.user.publicId}:update:${[...new Set(policies.map((policy) => policy.versionPublicId))].sort().join(":")}`;
  return policies.length > 0 ? <RequiredUpdateDialog key={snoozeKey} snoozeKey={snoozeKey} policies={policies}
    expectedSignerName={required.data?.expectedSignerName} /> : null;
}
