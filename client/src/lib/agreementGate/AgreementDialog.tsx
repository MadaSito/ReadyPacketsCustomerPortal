/**
 * Increment 06 D14 + D11 — Shared account-level Order Agreement (MNDA) acceptance dialog.
 *
 * Lives in `@/lib/agreementGate` (outside `@/features/*`) so `orders`, `files`, and `cart`
 * can open it when a mutation returns `CONFLICT` / `AGREEMENT_REQUIRED` and retry cleanly.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Button, Callout, Checkbox, DateTime, Dialog, ErrorState, Field, Input, Skeleton } from "@/ui";
import { SafePolicyText, type SafePolicyContentFormat } from "./SafePolicyText";

export type AgreementSignatureMode = "typed_name" | "checkbox";

export interface AgreementRequiredDetails {
  policyPublicId: string;
  signatureMode: AgreementSignatureMode;
}

export interface AgreementDialogProps {
  policyPublicId: string;
  signatureMode: AgreementSignatureMode;
  open: boolean;
  onAccepted: () => void | Promise<void>;
  onClose: () => void;
}

interface PublishedPolicyItem {
  documentPublicId: string;
  title: string;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  effectiveAt: Date | string;
  contentFormat: SafePolicyContentFormat;
  bodyText: string;
  contentHash: string;
  requiresTypedSignature: boolean;
}

/** Returns true when a tRPC / DomainError represents `AGREEMENT_REQUIRED`. */
export function isAgreementRequiredError(error: unknown): boolean {
  if (safeError(error)?.reasonCode === "AGREEMENT_REQUIRED") return true;
  if (error && typeof error === "object" && (error as { reasonCode?: unknown }).reasonCode === "AGREEMENT_REQUIRED") {
    return true;
  }
  return false;
}

/** Extracts `{ policyPublicId, signatureMode }` from an `AGREEMENT_REQUIRED` error, or `null` otherwise. */
export function parseAgreementRequiredDetails(error: unknown): AgreementRequiredDetails | null {
  const safe = safeError(error);
  const rawReason =
    safe?.reasonCode ??
    (error && typeof error === "object" ? (error as { reasonCode?: unknown }).reasonCode : undefined);
  if (rawReason !== "AGREEMENT_REQUIRED") return null;

  const details =
    safe?.details ??
    (error && typeof error === "object" ? (error as { details?: unknown }).details : undefined);
  if (!details || typeof details !== "object") return null;

  const policyPublicId = (details as { policyPublicId?: unknown }).policyPublicId;
  const rawMode = (details as { signatureMode?: unknown }).signatureMode;
  if (typeof policyPublicId !== "string" || policyPublicId.length === 0) return null;
  const signatureMode: AgreementSignatureMode = rawMode === "checkbox" ? "checkbox" : "typed_name";
  return { policyPublicId, signatureMode };
}

function AgreementFormBody({
  policy,
  signatureMode,
  expectedSignerName,
  onAccepted,
  onClose,
  onSubmittingChange,
}: {
  policy: PublishedPolicyItem;
  signatureMode: AgreementSignatureMode;
  expectedSignerName: string | null;
  onAccepted: () => void | Promise<void>;
  onClose: () => void;
  onSubmittingChange: (submitting: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const acceptMutation = useMutation(trpc.compliance.policies.accept.mutationOptions());

  const id = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLParagraphElement>(null);
  const inFlightRef = useRef(false);

  const [reviewed, setReviewed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [error, setError] = useState<string>();
  const [mismatchExpectedName, setMismatchExpectedName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const requiresTyped = signatureMode === "typed_name" || policy.requiresTypedSignature;
  const displayedExpectedName = mismatchExpectedName ?? expectedSignerName;

  function checkScrollEnd() {
    const el = viewportRef.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
      setReviewed(true);
    }
  }

  useEffect(() => {
    const rafId = window.requestAnimationFrame(checkScrollEnd);
    if (typeof ResizeObserver === "undefined" || !viewportRef.current || !bodyRef.current) {
      return () => window.cancelAnimationFrame(rafId);
    }
    const observer = new ResizeObserver(checkScrollEnd);
    observer.observe(viewportRef.current);
    observer.observe(bodyRef.current);
    return () => {
      window.cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [policy.versionPublicId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reviewed || !checked || inFlightRef.current) return;
    if (requiresTyped && !signerName.trim()) return;

    inFlightRef.current = true;
    setSubmitting(true);
    onSubmittingChange(true);
    setError(undefined);
    setMismatchExpectedName(null);

    try {
      await acceptMutation.mutateAsync({
        versionPublicId: policy.versionPublicId,
        contentHash: policy.contentHash,
        method: requiresTyped ? "typed_signature" : "portal_checkbox",
        ...(requiresTyped ? { signerName: signerName.trim() } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: trpc.compliance.policies.myStatus.queryKey() });
      await onAccepted();
    } catch (failure) {
      const safe = safeError(failure);
      const serverExpected =
        safe?.reasonCode === "SIGNER_NAME_MISMATCH" &&
        safe.details &&
        typeof (safe.details as { expectedName?: unknown }).expectedName === "string"
          ? (safe.details as { expectedName: string }).expectedName
          : null;
      if (serverExpected) {
        setMismatchExpectedName(serverExpected);
      }
      setError(errorMessage(failure, "We could not record your agreement. Review the text and try again."));
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
      onSubmittingChange(false);
    }
  }

  return (
    <form id={`${id}-form`} onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
      <p className="text-sm text-muted">
        Version {policy.versionNumber} · {policy.versionLabel} · Effective{" "}
        <DateTime value={policy.effectiveAt} format="date" />
      </p>

      <div
        ref={viewportRef}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must scroll bounded agreement text
        tabIndex={0}
        role="region"
        aria-label={`${policy.title} agreement text`}
        onScroll={checkScrollEnd}
        className="max-h-72 overflow-auto rounded-[var(--radius-control)] border border-line bg-surface-sunken p-4"
      >
        <div ref={bodyRef}>
          <SafePolicyText bodyText={policy.bodyText} format={policy.contentFormat} />
          <p ref={endRef} tabIndex={-1} className="mt-4 text-sm font-medium text-muted">
            End of agreement
          </p>
        </div>
      </div>

      {!reviewed ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted">Read to the end of the agreement before accepting.</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              endRef.current?.focus();
              setReviewed(true);
            }}
          >
            Go to end of agreement
          </Button>
        </div>
      ) : null}

      <Checkbox
        label={`I have read and agree to ${policy.title} (version ${policy.versionNumber}).`}
        checked={checked}
        onCheckedChange={setChecked}
        disabled={!reviewed || submitting}
      />

      {requiresTyped ? (
        <div className="space-y-2">
          <Field
            label="Type your full name to sign"
            hint={
              displayedExpectedName
                ? `Expected account name: ${displayedExpectedName}.`
                : "Enter the full name on your account."
            }
            required
          >
            <Input
              value={signerName}
              onChange={(event) => setSignerName(event.target.value)}
              maxLength={160}
              autoComplete="name"
              disabled={!reviewed || submitting}
            />
          </Field>
          <p className="text-xs text-muted">
            Need to update your account name?{" "}
            <Link href="/account" className="font-medium text-action underline underline-offset-2">
              Edit your profile name
            </Link>{" "}
            (changes are recorded in the audit log).
          </p>
        </div>
      ) : null}

      {error ? (
        <Callout tone="danger" live="assertive">
          <div className="space-y-1">
            <p>{error}</p>
            {mismatchExpectedName ? (
              <p className="text-sm">
                Expected account name: <strong>{mismatchExpectedName}</strong>. You can{" "}
                <Link href="/account" className="font-medium underline underline-offset-2">
                  correct your profile name
                </Link>{" "}
                if your legal name has changed.
              </p>
            ) : null}
          </div>
        </Callout>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          loading={submitting}
          disabled={!reviewed || !checked || (requiresTyped && !signerName.trim())}
        >
          Accept and continue
        </Button>
      </div>
    </form>
  );
}

export function AgreementDialog({
  policyPublicId,
  signatureMode,
  open,
  onAccepted,
  onClose,
}: AgreementDialogProps) {
  const trpc = useTRPC();
  const [submitting, setSubmitting] = useState(false);

  const statusQuery = useQuery({
    ...trpc.compliance.policies.myStatus.queryOptions(),
    enabled: open && policyPublicId.length > 0,
  });

  const policy = statusQuery.data?.published.find((item) => item.documentPublicId === policyPublicId) ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) onClose();
      }}
      dismissible={!submitting}
      title={policy ? `Review and accept ${policy.title}` : "Review and accept agreement"}
      description="Read the agreement below and confirm once for this version before continuing."
      size="lg"
    >
      {statusQuery.isPending ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : statusQuery.isError ? (
        <ErrorState
          title="Could not load agreement"
          error={statusQuery.error}
          onRetry={() => void statusQuery.refetch()}
        />
      ) : !policy ? (
        <Callout tone="warning">
          This agreement is not currently available. Please refresh the page or contact support.
        </Callout>
      ) : (
        <AgreementFormBody
          key={`${policy.documentPublicId}:${policy.versionPublicId}:${signatureMode}`}
          policy={policy}
          signatureMode={signatureMode}
          expectedSignerName={statusQuery.data?.expectedSignerName ?? null}
          onAccepted={onAccepted}
          onClose={onClose}
          onSubmittingChange={setSubmitting}
        />
      )}
    </Dialog>
  );
}
