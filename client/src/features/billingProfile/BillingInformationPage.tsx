/**
 * `/account/billing` — Customer "Billing information" account settings page (Increment 08, Decision D4).
 * Owner: compliance_engineer.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import type {
  BillingProfileView,
  ClearBillingProfileInput,
  ClearBillingProfileResult,
  SaveBillingProfileInput,
} from "@server/modules/billingProfile";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import {
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DateTime,
  ErrorState,
  PageHeader,
  Skeleton,
  useToast,
} from "@/ui";
import {
  BillingFields,
  billingFieldDomId,
  EMPTY_BILLING_DETAILS,
  extractBillingFieldErrors,
  formatBillingSummaryLines,
  validateBillingFields,
  type BillingDetails,
  type BillingFieldErrors,
  type BillingFieldKey,
} from "./BillingFields";

interface BillingProfileTrpcProxy {
  billingProfile: {
    get: {
      queryKey: () => readonly unknown[];
      queryOptions: () => {
        queryKey: readonly unknown[];
        queryFn: () => Promise<BillingProfileView | null>;
      };
    };
    save: {
      mutationOptions: () => {
        mutationFn: (input: SaveBillingProfileInput) => Promise<BillingProfileView>;
      };
    };
    clear: {
      mutationOptions: () => {
        mutationFn: (input: ClearBillingProfileInput) => Promise<ClearBillingProfileResult>;
      };
    };
  };
}

function useBillingProfileTrpc() {
  return (useTRPC() as unknown as BillingProfileTrpcProxy).billingProfile;
}

const ID_PREFIX = "account-billing";

export default function BillingInformationPage() {
  const api = useBillingProfileTrpc();
  const queryClient = useQueryClient();
  const toast = useToast();

  const profileQuery = useQuery(api.get.queryOptions());
  const saveMutation = useMutation(api.save.mutationOptions());
  const clearMutation = useMutation(api.clear.mutationOptions());

  const [editedDraft, setEditedDraft] = useState<BillingDetails | null>(null);
  const [fieldErrors, setFieldErrors] = useState<BillingFieldErrors>({});
  const [formBannerError, setFormBannerError] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const errorBannerRef = useRef<HTMLDivElement | null>(null);

  const savedProfile = profileQuery.data ?? null;
  const draft: BillingDetails = editedDraft ?? savedProfile?.details ?? EMPTY_BILLING_DETAILS;

  const header = (
    <PageHeader
      title="Billing information"
      description="Save your default billing contact and address for faster checkout."
      actions={
        <Button asChild variant="secondary">
          <Link href="/account">Account overview</Link>
        </Button>
      }
    />
  );

  if (profileQuery.isPending) {
    return (
      <>
        {header}
        <div role="status" className="flex min-w-0 flex-col gap-3">
          <span className="sr-only">Loading your billing information</span>
          <Skeleton lines={6} />
        </div>
      </>
    );
  }

  if (profileQuery.isError) {
    return (
      <>
        {header}
        <ErrorState error={profileQuery.error} onRetry={() => void profileQuery.refetch()} />
      </>
    );
  }

  const focusField = (key: BillingFieldKey) => {
    const el = document.getElementById(billingFieldDomId(ID_PREFIX, key));
    if (el instanceof HTMLElement) {
      el.focus();
    }
  };

  const handleFieldChange = (next: BillingDetails) => {
    setEditedDraft(next);
    if (Object.keys(fieldErrors).length > 0) {
      const nextErrors: BillingFieldErrors = {};
      for (const [k, msg] of Object.entries(fieldErrors) as [BillingFieldKey, string | undefined][]) {
        if (msg && next[k] === draft[k]) {
          nextErrors[k] = msg;
        }
      }
      setFieldErrors(nextErrors);
    }
  };

  const handleReloadLatest = async () => {
    await profileQuery.refetch();
    setEditedDraft(null);
    setFieldErrors({});
    setFormBannerError(null);
    setVersionConflict(false);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFormBannerError(null);
    setVersionConflict(false);

    const validated = validateBillingFields(draft);
    if (!validated.ok) {
      setFieldErrors(validated.errors);
      setFormBannerError("Correct the highlighted billing fields before saving.");
      requestAnimationFrame(() => focusField(validated.firstKey));
      return;
    }

    setFieldErrors({});
    try {
      const saved = await saveMutation.mutateAsync(
        savedProfile
          ? {
              details: validated.data,
              expectedVersion: savedProfile.version,
              expectedPublicId: savedProfile.publicId,
            }
          : {
              details: validated.data,
              expectedVersion: 0,
            },
      );
      queryClient.setQueryData(api.get.queryKey(), saved);
      setEditedDraft(null);
      toast.show({ tone: "success", title: "Billing information saved" });
    } catch (err) {
      const safe = safeError(err);
      if (safe?.reasonCode === "BILLING_PROFILE_VERSION_CONFLICT") {
        setVersionConflict(true);
        setFormBannerError(safe.safeMessage);
        requestAnimationFrame(() => errorBannerRef.current?.focus());
        return;
      }
      const mapped = extractBillingFieldErrors(safe?.fieldErrors, "details");
      if (Object.keys(mapped).length > 0) {
        setFieldErrors(mapped);
        const firstServerKey = (Object.keys(mapped)[0] as BillingFieldKey | undefined) ?? "fullName";
        setFormBannerError(errorMessage(err));
        requestAnimationFrame(() => focusField(firstServerKey));
        return;
      }
      setFormBannerError(errorMessage(err));
      requestAnimationFrame(() => errorBannerRef.current?.focus());
    }
  };

  const handleConfirmClear = async () => {
    setFormBannerError(null);
    setVersionConflict(false);
    if (!savedProfile) {
      setConfirmClearOpen(false);
      return;
    }
    try {
      await clearMutation.mutateAsync({
        expectedVersion: savedProfile.version,
        expectedPublicId: savedProfile.publicId,
      });
      setConfirmClearOpen(false);
      queryClient.setQueryData(api.get.queryKey(), null);
      setEditedDraft(null);
      setFieldErrors({});
      toast.show({ tone: "success", title: "Saved billing information cleared" });
    } catch (err) {
      setConfirmClearOpen(false);
      const safe = safeError(err);
      if (safe?.reasonCode === "BILLING_PROFILE_VERSION_CONFLICT") {
        setVersionConflict(true);
      }
      setFormBannerError(errorMessage(err));
      requestAnimationFrame(() => errorBannerRef.current?.focus());
    }
  };

  const isBusy = saveMutation.isPending || clearMutation.isPending;
  const summaryLines = savedProfile ? formatBillingSummaryLines(savedProfile.details) : [];

  return (
    <div
      data-testid="billing-profile-page"
      data-profile-state={savedProfile ? "saved" : "empty"}
      className="flex min-w-0 flex-col gap-6"
    >
      {header}

      <Card
        title={savedProfile ? "Saved billing summary" : "No saved billing information"}
        description="Updating or clearing these details applies to future checkouts only and never modifies issued invoices or payment receipts."
      >
        {savedProfile ? (
          <div data-testid="billing-profile-summary" className="flex min-w-0 flex-col gap-2 text-sm">
            <div className="flex min-w-0 flex-col gap-0.5 text-ink">
              {summaryLines.map((line, index) => (
                <p key={`${index}-${line}`} className="min-w-0 break-words">
                  {line}
                </p>
              ))}
            </div>
            <p className="text-xs text-muted">
              Last updated <DateTime value={savedProfile.updatedAt} />
            </p>
          </div>
        ) : (
          <p data-testid="billing-profile-empty" className="text-sm text-muted">
            You have not saved default billing information yet. Add your billing contact and address below to speed up
            checkout, or enter billing details per order during checkout.
          </p>
        )}
      </Card>

      <Card title={savedProfile ? "Edit billing information" : "Add billing information"}>
        <form onSubmit={handleSubmit} noValidate className="flex min-w-0 flex-col gap-5">
          {formBannerError ? (
            <div
              ref={errorBannerRef}
              tabIndex={-1}
              className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-action"
            >
              <Callout
                tone={versionConflict ? "warning" : "danger"}
                live="assertive"
                title={versionConflict ? "Billing information changed elsewhere" : "Could not save billing information"}
              >
                <p>{formBannerError}</p>
                {versionConflict ? (
                  <div className="mt-3">
                    <Button type="button" variant="secondary" size="sm" onClick={() => void handleReloadLatest()}>
                      Reload latest saved details
                    </Button>
                  </div>
                ) : null}
              </Callout>
            </div>
          ) : null}

          <BillingFields
            idPrefix={ID_PREFIX}
            value={draft}
            onChange={handleFieldChange}
            errors={fieldErrors}
            disabled={isBusy}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            {savedProfile ? (
              <Button
                type="button"
                variant="secondary"
                disabled={isBusy}
                onClick={() => setConfirmClearOpen(true)}
              >
                Clear billing information
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" loading={saveMutation.isPending} disabled={clearMutation.isPending}>
              Save billing information
            </Button>
          </div>
        </form>
      </Card>

      <ConfirmDialog
        open={confirmClearOpen}
        onOpenChange={setConfirmClearOpen}
        title="Clear saved billing information?"
        description="Your saved billing contact and address will be removed from your account. Previously issued invoices and payment receipts are not affected."
        confirmLabel="Clear billing information"
        destructive
        onConfirm={handleConfirmClear}
      />
    </div>
  );
}
