import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "wouter";
import type { RequiredPolicySummary } from "@server/modules/compliance/policiesService";
import { ME_QUERY_KEY, type MeResult } from "@/lib/authApi";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Button, Callout, Card, Checkbox, DateTime, Dialog, ErrorState, Field, Input, PageHeader, Skeleton } from "@/ui";
import { SafePolicyText } from "../shared";

function PolicyAcceptanceForm({
  policy,
  expectedSignerName,
}: {
  policy: RequiredPolicySummary;
  expectedSignerName?: string | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const accept = useMutation(trpc.compliance.policies.accept.mutationOptions());
  const id = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const documentBody = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLParagraphElement>(null);
  const signerInputRef = useRef<HTMLInputElement>(null);
  const requestInFlight = useRef(false);
  const [reviewed, setReviewed] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [error, setError] = useState<string>();
  const [signerFieldError, setSignerFieldError] = useState<string>();
  const [mismatchExpectedName, setMismatchExpectedName] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const sessionAccountName = queryClient.getQueryData<MeResult>(ME_QUERY_KEY)?.user.name ?? null;
  const displayedExpectedName = mismatchExpectedName ?? expectedSignerName ?? sessionAccountName;

  function checkEnd() {
    const el = viewport.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) setReviewed(true);
  }

  useEffect(() => {
    checkEnd();
    if (typeof ResizeObserver === "undefined" || !viewport.current || !documentBody.current) return;
    const observer = new ResizeObserver(checkEnd);
    observer.observe(viewport.current);
    observer.observe(documentBody.current);
    return () => observer.disconnect();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reviewed || !accepted || requestInFlight.current || (policy.requiresTypedSignature && !signerName.trim())) return;
    requestInFlight.current = true;
    setConfirming(true);
    setError(undefined);
    setSignerFieldError(undefined);
    setMismatchExpectedName(null);
    try {
      await accept.mutateAsync({
        versionPublicId: policy.versionPublicId,
        contentHash: policy.contentHash,
        ...(policy.requiresTypedSignature ? { signerName: signerName.trim() } : {}),
      });
      setAccepted(false);
      setSignerName("");
    } catch (failure) {
      const safe = safeError(failure);
      const isSignatureError =
        safe?.reasonCode === "SIGNER_NAME_MISMATCH" ||
        safe?.reasonCode === "TYPED_SIGNATURE_REQUIRED";
      const serverExpected =
        safe?.reasonCode === "SIGNER_NAME_MISMATCH" &&
        safe.details &&
        typeof (safe.details as { expectedName?: unknown }).expectedName === "string"
          ? (safe.details as { expectedName: string }).expectedName
          : null;
      if (serverExpected) {
        setMismatchExpectedName(serverExpected);
      }
      const message = errorMessage(
        failure,
        "We couldn't confirm acceptance. Refresh policy status before trying again.",
      );
      if (policy.requiresTypedSignature && isSignatureError) {
        setSignerFieldError(message);
        signerInputRef.current?.focus();
      }
      setError(message);
    } finally {
      // Evidence and current versions come from the server, even after an uncertain response.
      await queryClient.invalidateQueries({ queryKey: trpc.compliance.policies.myStatus.queryKey() });
      requestInFlight.current = false;
      setConfirming(false);
    }
  }

  return (
    <Card as="article" aria-labelledby={`${id}-title`} className="min-w-0">
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <div>
          <h2 id={`${id}-title`} className="break-words text-lg font-semibold text-ink">{policy.title}</h2>
          <p className="text-sm text-muted">Version {policy.versionNumber} · {policy.versionLabel} · Effective <DateTime value={policy.effectiveAt} format="date" /></p>
        </div>
        {policy.changeSummary ? (
          <div className="rounded-[var(--radius-control)] border border-line bg-surface-raised px-3 py-2 text-sm text-ink">
            <span className="font-medium">What changed:</span> {policy.changeSummary}
          </div>
        ) : null}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Allow keyboard scrolling of the bounded document. */}
        <div ref={viewport} tabIndex={0} role="region" aria-label={`${policy.title} policy text`}
          onScroll={checkEnd} className="max-h-72 overflow-auto rounded-[var(--radius-control)] border border-line bg-surface-sunken p-4">
          <div ref={documentBody}>
            <SafePolicyText bodyText={policy.bodyText} format={policy.contentFormat} />
            <p ref={end} tabIndex={-1} className="mt-4 text-sm font-medium text-muted">End of policy</p>
          </div>
        </div>
        {!reviewed ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-muted">Read the complete policy before accepting.</p>
            <Button type="button" variant="ghost" size="sm" onClick={() => {
              end.current?.focus();
              checkEnd();
            }}>Go to end of policy</Button>
          </div>
        ) : null}
        <Checkbox label={`I have read and agree to ${policy.title} (version ${policy.versionNumber}).`}
          checked={accepted} onCheckedChange={setAccepted} disabled={!reviewed || confirming} />
        {policy.requiresTypedSignature ? (
          <div className="space-y-1.5">
            <Field
              label="Type your full name to sign"
              hint={
                displayedExpectedName
                  ? `Expected account name: ${displayedExpectedName}.`
                  : "Enter the full name on your account."
              }
              error={signerFieldError}
              required
            >
              <Input
                ref={signerInputRef}
                value={signerName}
                onChange={(event) => {
                  setSignerName(event.target.value);
                  setSignerFieldError(undefined);
                }}
                maxLength={160}
                autoComplete="name"
                disabled={!reviewed || confirming}
              />
            </Field>
            <p className="text-xs text-muted">
              Need to update your account name?{" "}
              <Link href="/account" className="font-medium text-action underline underline-offset-2">
                Edit your profile name
              </Link>
              .
            </p>
          </div>
        ) : null}
        {error ? (
          <Callout tone="danger" live="assertive">
            <div className="space-y-1">
              <p>{error}</p>
              {mismatchExpectedName ? (
                <p className="text-sm">
                  Expected account name: <strong>{mismatchExpectedName}</strong>.{" "}
                  <Link href="/account" className="font-medium underline underline-offset-2">
                    Update your profile name
                  </Link>{" "}
                  if your legal name has changed.
                </p>
              ) : null}
            </div>
          </Callout>
        ) : null}
        <Button type="submit" disabled={!reviewed || !accepted || (policy.requiresTypedSignature && !signerName.trim())}
          loading={confirming}>Accept this version</Button>
      </form>
    </Card>
  );
}

export function RequiredPolicyForms({
  policies,
  expectedSignerName,
}: {
  policies: readonly RequiredPolicySummary[];
  expectedSignerName?: string | null;
}) {
  return (
    <div className="grid gap-4">
      {policies.map((policy) => (
        <PolicyAcceptanceForm
          key={`${policy.versionPublicId}:${policy.contentHash}:${policy.requiresTypedSignature}`}
          policy={policy}
          expectedSignerName={expectedSignerName}
        />
      ))}
    </div>
  );
}

export function usePolicyStatus() {
  const trpc = useTRPC();
  return useQuery(trpc.compliance.policies.myStatus.queryOptions(undefined, { refetchOnMount: "always" }));
}

/** Order creation stays unavailable until an authoritative response confirms all required versions. */
export function RequiredPolicyGate({ children }: { children: ReactNode }) {
  const status = usePolicyStatus();
  const allowed = status.isFetchedAfterMount && status.isSuccess && !status.data.pendingRequired.length;
  const [wizardStarted, setWizardStarted] = useState(false);
  if (allowed && !wizardStarted) setWizardStarted(true);
  return (
    <>
      {allowed || wizardStarted ? (
        <div hidden={!allowed}>
          <Suspense
            fallback={
              <>
                <PageHeader title="New order" />
                <Skeleton lines={3} />
              </>
            }
          >
            {children}
          </Suspense>
        </div>
      ) : null}
      {!allowed ? !status.isFetchedAfterMount || status.isError || !status.data ? <>
        <PageHeader title="New order" />
        {status.isFetching ? <Skeleton lines={3} /> : <ErrorState title="We couldn't verify your policy status" onRetry={() => void status.refetch()} />}
      </> : <>
        <PageHeader title="Review required policies" description="Accept every required version before starting a new order." />
        <RequiredPolicyForms policies={status.data.pendingRequired} expectedSignerName={status.data.expectedSignerName} />
        <p className="mt-4"><Link className="text-action underline" href="/orders">Back to orders</Link></p>
      </> : null}
    </>
  );
}

export default function PolicyAcceptanceWidget() {
  const status = usePolicyStatus();
  const [open, setOpen] = useState(false);
  const [reviewStarted, setReviewStarted] = useState(false);
  const policies = status.data?.pendingRequired ?? [];
  if (!open && status.isPending) return <Skeleton lines={3} />;
  if (!open && status.isError) return <ErrorState title="We couldn't check required policies" onRetry={() => void status.refetch()} />;
  if (!reviewStarted && !policies.length) return null;
  return (
    <Callout tone={policies.length ? "warning" : "success"} title={policies.length ? "Policy review required" : "Required policies are up to date"}
      actions={<>
        <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setReviewStarted(true); }}
          trigger={<Button variant="secondary">{policies.length ? "Review required policies" : "Review policy status"}</Button>}
          size="xl" title="Required policy review"
          description="Review each required version and explicitly agree before starting a new order.">
          {status.isError ? <ErrorState title="We couldn't verify your current policy status" onRetry={() => void status.refetch()} />
            : policies.length ? <RequiredPolicyForms policies={policies} expectedSignerName={status.data?.expectedSignerName} />
              : <Callout tone="success" live="polite">The portal confirmed all required versions are accepted.</Callout>}
        </Dialog>
        <Button asChild variant="link" className="whitespace-normal text-left"><Link href="/policies">View published policies and acceptance history</Link></Button>
      </>}>
        {policies.length ? "Review and accept each required version before creating a new order." : "You can start a new order."}
      </Callout>
  );
}
