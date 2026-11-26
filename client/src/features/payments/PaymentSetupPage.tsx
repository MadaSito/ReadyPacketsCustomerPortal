import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, CreditCard, KeyRound, Play, PlugZap, ShieldAlert, Terminal, Webhook } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import type { ActivePaymentProvider } from "@server/modules/payments/schema";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  Callout,
  Card,
  Checkbox,
  Checklist,
  CodeBlock,
  ConfirmDialog,
  CopyField,
  DataTable,
  DateTime,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  KeyValueList,
  LoadMore,
  PageHeader,
  Select,
  Skeleton,
  StepUpCancelledError,
  Switch,
  useStepUp,
  useToast,
  type ChecklistItem,
} from "@/ui";
import {
  type CredentialFieldKey,
  extractServerCredentialFieldError,
  isLikelyValidWhsec,
  SecretCredentialField,
  validateStripeSecretKeyField,
  validateStripeWebhookSecretField,
} from "./stripeCredentialValidation";

const DEFAULT_STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.refund.updated",
  "refund.created",
  "refund.updated",
] as const;

const modeOptions = [
  { value: "test", label: "Test / sandbox" },
  { value: "live", label: "Live payments" },
];

const rejectionReasons: Record<string, string> = {
  INVALID_SIGNATURE: "Invalid signature",
  SQUARE_SIGNATURE_INVALID: "Invalid signature",
  WEBHOOK_SIGNATURE_INVALID: "Invalid signature",
  invalid_signature: "Invalid signature",
  MISSING_SIGNATURE: "Missing signature",
  MALFORMED_SIGNATURE: "Missing signature",
  WEBHOOK_SIGNATURE_MISSING: "Missing signature",
  TIMESTAMP_OUT_OF_RANGE: "Stale timestamp",
  SQUARE_EVENT_STALE: "Stale timestamp",
  WEBHOOK_TIMESTAMP_EXPIRED: "Stale timestamp",
  stale_timestamp: "Stale timestamp",
  INVALID_JSON: "Malformed JSON",
  INVALID_EVENT_PAYLOAD: "Malformed JSON",
  INVALID_EVENT_ENVELOPE: "Malformed JSON",
  SQUARE_EVENT_INVALID: "Malformed JSON",
  WEBHOOK_PAYLOAD_INVALID: "Malformed JSON",
  malformed_json: "Malformed JSON",
  WEBHOOK_MODE_MISMATCH: "Environment mismatch",
  environment_mismatch: "Environment mismatch",
  WEBHOOK_NOT_CONFIGURED: "Signing secret missing",
  WEBHOOK_SECRET_MISSING: "Signing secret missing",
  WEBHOOK_PROVIDER_OFF: "Provider not configured",
  provider_not_configured: "Provider not configured",
  PAYLOAD_TAMPER_CONFLICT: "Payload conflict",
  WEBHOOK_EMPTY_BODY: "Empty payload",
};

const rejectionReasonOptions = [
  { value: "", label: "All rejection reasons" },
  { value: "INVALID_SIGNATURE", label: "Invalid signature" },
  { value: "MISSING_SIGNATURE", label: "Missing signature" },
  { value: "TIMESTAMP_OUT_OF_RANGE", label: "Stale timestamp" },
  { value: "INVALID_JSON", label: "Malformed JSON" },
  { value: "WEBHOOK_MODE_MISMATCH", label: "Environment mismatch" },
  { value: "WEBHOOK_NOT_CONFIGURED", label: "Signing secret missing" },
  { value: "PAYLOAD_TAMPER_CONFLICT", label: "Payload conflict" },
  { value: "WEBHOOK_EMPTY_BODY", label: "Empty payload" },
];

const providerFilterOptions = [
  { value: "", label: "All providers" },
  { value: "stripe", label: "Stripe" },
  { value: "square", label: "Square" },
];

const failureClassLabels: Record<string, string> = {
  configuration: "Provider credentials, mode, or verification stale",
  egress: "Outbound HTTPS allowlist blocked",
  provider_auth: "Invalid or revoked API key (HTTP 401)",
  provider_permission: "Restricted key missing permission (HTTP 403)",
  provider_request: "Stripe rejected request parameters (HTTP 400)",
  provider_transient: "Stripe rate limit, 5xx, or network timeout",
  provider_response: "Malformed Stripe API response",
  untrusted_redirect_url: "Untrusted or custom Stripe Checkout domain",
  payment_declined: "Payment method declined",
  expired: "Checkout session expired",
  cancelled: "Cancelled by customer",
};

type StagedStripeField = "stripeSecretKey" | "stripeWebhookSecret" | "stripeWebhookSecretSecondary";

function keyStatusHint(last4: string | null) {
  return last4
    ? `Configured (ending in ${last4}). Leave blank to keep the saved value.`
    : "Not configured yet. Encrypted at rest and never returned after saving.";
}

function WebhookRejectionsCard() {
  const trpc = useTRPC();
  const [provider, setProvider] = useState<ActivePaymentProvider | "">("");
  const [reasonCode, setReasonCode] = useState<string>("");
  const rejections = useInfiniteQuery(
    trpc.payments.admin.listWebhookRejections.infiniteQueryOptions(
      {
        limit: 20,
        provider: provider || undefined,
        reasonCode: reasonCode || undefined,
      },
      { getNextPageParam: (page) => page.nextCursor ?? undefined },
    ),
  );
  const rows = rejections.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <ShieldAlert className="size-4" aria-hidden />
          Webhook rejections
        </span>
      }
      description="Recent pre-verification rejections retained for 14 days. Raw bodies, headers, secrets, and client IP addresses are never stored. Requests with non-JSON media types (HTTP 400) or payloads over 256 KB (HTTP 413) are refused by the HTTP transport layer before webhook verification and do not appear in this log."
    >
      <FilterBar
        activeCount={Number(Boolean(provider)) + Number(Boolean(reasonCode))}
        onReset={() => {
          setProvider("");
          setReasonCode("");
        }}
      >
        <Field label="Rejection provider">
          <Select
            options={providerFilterOptions}
            value={provider}
            onChange={(event) => setProvider(event.target.value as ActivePaymentProvider | "")}
          />
        </Field>
        <Field label="Rejection reason">
          <Select
            options={rejectionReasonOptions}
            value={reasonCode}
            onChange={(event) => setReasonCode(event.target.value)}
          />
        </Field>
      </FilterBar>
      <DataTable
        caption="Pre-verification webhook rejections"
        rows={rows}
        rowKey={(row) => row.rejectionPublicId}
        loading={rejections.isPending}
        error={rejections.error}
        onRetry={() => {
          void rejections.refetch();
        }}
        empty={
          <EmptyState
            icon={Webhook}
            title="No rejected webhook deliveries"
            description="Signature mismatches, stale timestamps, or environment mismatches will appear here."
          />
        }
        columns={[
          {
            key: "reason",
            header: "Reason",
            primary: true,
            cell: (row) => {
              const humanLabel =
                ("reasonLabel" in row && typeof row.reasonLabel === "string" && row.reasonLabel) ||
                rejectionReasons[row.reasonCode] ||
                row.reasonCode;
              return (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="danger">{humanLabel}</Badge>
                  <span className="font-mono text-xs text-muted">
                    {row.reasonCode} · HTTP {row.httpStatus}
                  </span>
                </div>
              );
            },
          },
          {
            key: "provider",
            header: "Provider",
            cell: (row) => <span className="capitalize">{row.provider}</span>,
          },
          {
            key: "detail",
            header: "Diagnostic summary",
            cell: (row) => row.detail ?? "No additional detail",
          },
          {
            key: "receivedAt",
            header: "Received",
            hideOnMobile: true,
            cell: (row) => <DateTime value={row.receivedAt} />,
          },
        ]}
      />
      <LoadMore
        hasMore={rejections.hasNextPage}
        loading={rejections.isFetchingNextPage}
        onLoadMore={() => {
          void rejections.fetchNextPage();
        }}
      />
    </Card>
  );
}

export default function PaymentSetupPage() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();

  const settingsQuery = useQuery(trpc.payments.admin.getSettings.queryOptions());
  const egressPresetsQuery = useQuery(trpc.integrations.admin.egress.presets.queryOptions());
  const setEgressPreset = useMutation(trpc.integrations.admin.egress.setPreset.mutationOptions());
  const testConnection = useMutation(trpc.payments.admin.testConnection.mutationOptions());
  const verifyCheckoutSession = useMutation(trpc.payments.admin.verifyCheckoutSession.mutationOptions());
  const sendSelfTest = useMutation(trpc.payments.admin.sendSelfTestWebhook.mutationOptions());

  const [modeDraft, setModeDraft] = useState<"test" | "live" | null>(null);
  const [secretResetSeq, setSecretResetSeq] = useState(0);
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookSecretSecondary, setWebhookSecretSecondary] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<StagedStripeField, string>>>({});
  const [clearSecondary, setClearSecondary] = useState(false);
  const [savingKeys, setSavingKeys] = useState(false);
  const [activating, setActivating] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [confirmActivateOpen, setConfirmActivateOpen] = useState(false);
  const [confirmDeactivateOpen, setConfirmDeactivateOpen] = useState(false);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  const [signingSecretRotatedKind, setSigningSecretRotatedKind] = useState<"primary" | "secondary" | null>(null);
  const [connectionCheckResult, setConnectionCheckResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [checkoutProbeResult, setCheckoutProbeResult] = useState<{
    ok: boolean;
    message: string;
    reasonCode: string;
  } | null>(null);

  const fieldRefs = useRef<Partial<Record<StagedStripeField, HTMLInputElement | null>>>({});

  const focusField = (field: StagedStripeField) => {
    queueMicrotask(() => {
      fieldRefs.current[field]?.focus();
    });
  };

  const clearFieldError = (field: StagedStripeField) => {
    setFieldErrors((previous) => {
      if (!previous[field]) return previous;
      const copy = { ...previous };
      delete copy[field];
      return copy;
    });
  };

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.payments.admin.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.integrations.admin.egress.presets.queryKey() }),
    ]);
  };

  if (settingsQuery.isPending) {
    return (
      <div role="status" aria-label="Loading Stripe setup">
        <Skeleton lines={8} />
      </div>
    );
  }

  if (!settingsQuery.data) {
    return (
      <ErrorState
        title="Could not load Stripe setup"
        error={settingsQuery.error}
        onRetry={() => {
          void settingsQuery.refetch();
        }}
      />
    );
  }

  const settings = settingsQuery.data;
  const activeMode = modeDraft ?? settings.mode;
  const sameMode = activeMode === settings.mode;
  const stripePreset = egressPresetsQuery.data?.find((preset) => preset.key === "stripe");
  const egressAllowlisted = stripePreset ? stripePreset.enabled : settings.stripe.egressAllowlisted;
  const requiredEvents = settings.stripe.requiredEvents ?? DEFAULT_STRIPE_EVENTS;
  const apiVerified = Boolean(settings.stripe.lastApiVerifiedAt);
  const selfTestVerified = Boolean(settings.stripe.lastSelfTestWebhookAt);

  const persistedProbe = settings.stripe.lastCheckoutProbe ?? null;
  const effectiveProbeOk =
    checkoutProbeResult !== null
      ? checkoutProbeResult.ok
      : persistedProbe !== null
        ? persistedProbe.ok
        : null;
  const checkoutProbeFailed = effectiveProbeOk === false;

  const stripePrereqsReady =
    egressAllowlisted &&
    settings.stripe.secretKeyConfigured &&
    settings.stripe.webhookSecretConfigured &&
    apiVerified &&
    selfTestVerified &&
    !checkoutProbeFailed;
  const stripeActiveAndReady = settings.provider === "stripe" && settings.onlineEnabled && !checkoutProbeFailed;

  const computedMissingGates: string[] = [];
  if (!egressAllowlisted) {
    computedMissingGates.push("Outbound HTTPS allowlist for api.stripe.com:443 is disabled.");
  }
  if (!settings.stripe.secretKeyConfigured) {
    computedMissingGates.push(`Stripe API secret key (${settings.mode}) is not saved.`);
  }
  if (!settings.stripe.webhookSecretConfigured) {
    computedMissingGates.push(`Primary Stripe webhook signing secret (${settings.mode}) is not saved.`);
  }
  if (!apiVerified) {
    computedMissingGates.push("Stripe API connection check has not been verified for the current key, mode, and allowlist.");
  }
  if (checkoutProbeFailed) {
    computedMissingGates.push(
      `Checkout session creation check failed (${checkoutProbeResult?.reasonCode ?? persistedProbe?.reasonCode ?? "STRIPE_CHECKOUT_PROBE_FAILED"}).`,
    );
  }
  if (!selfTestVerified) {
    computedMissingGates.push("Signed webhook self-test has not passed for the current primary signing secret.");
  }
  if (settings.provider !== "stripe") {
    computedMissingGates.push(
      `Stripe Checkout is not activated yet (active provider: ${settings.provider === "none" ? "Pay by invoice" : "Square"}).`,
    );
  }
  const missingGates = computedMissingGates;
  const reverificationReasons = settings.stripe.reverificationReasons ?? [];
  const reverificationNeeded = Boolean(settings.stripe.reverificationNeeded) || reverificationReasons.length > 0;
  const lastCheckoutFailure = settings.stripe.lastCheckoutFailure ?? null;

  const showSecondaryRolloverCallout =
    sameMode &&
    settings.stripe.webhookSecretConfigured &&
    !webhookSecret.trim() &&
    isLikelyValidWhsec(webhookSecretSecondary);

  const statusHeadline =
    settings.stripe.statusHeadline ??
    (stripeActiveAndReady
      ? `Online card checkout: ACTIVE — Customers are sent to Stripe Checkout (${settings.mode})`
      : settings.provider === "stripe"
        ? `Online card checkout: NOT ACTIVE — Stripe Checkout (${settings.mode}) is paused pending verification; customers receive an unpaid invoice`
        : "Online card checkout: NOT ACTIVE — Customers get pay-by-invoice; no card payment is collected");

  const customerExperienceSummary =
    settings.stripe.customerExperienceSummary ??
    (stripeActiveAndReady
      ? `Customer cart checkouts and unpaid issued invoices redirect buyers to hosted Stripe Checkout (${settings.mode} mode), and verified webhooks settle invoices automatically.`
      : settings.provider === "stripe"
        ? "Stripe is selected as provider, but online card redirect stays paused until every missing gate below is satisfied. Customer orders still complete with an issued invoice so buyers never lose their cart."
        : "Customers submit orders with an issued invoice and no online card redirect occurs. You can stage keys, allow api.stripe.com:443, and run every verification check below before activating Stripe Checkout.");

  async function toggleStripeEgress(nextEnabled: boolean) {
    try {
      await stepUp.run(
        () => setEgressPreset.mutateAsync({ presetKey: "stripe", enabled: nextEnabled }),
        { reason: "Updating outbound network presets requires a recent identity check." },
      );
      setConnectionCheckResult(null);
      setCheckoutProbeResult(null);
      await refreshAll();
      toast.show({
        title: nextEnabled ? "Stripe outbound HTTPS enabled" : "Stripe outbound HTTPS disabled",
        tone: "success",
      });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) {
        toast.show({
          title: "Outbound allowlist was not updated",
          tone: "danger",
          description: errorMessage(error),
        });
      }
    }
  }

  async function handleTestConnection() {
    try {
      const res = await stepUp.run(
        () => testConnection.mutateAsync({ provider: "stripe" }),
        { reason: "Testing provider credentials requires a recent identity check." },
      );
      setConnectionCheckResult({ ok: res.ok, message: res.message });
      await refreshAll();
      toast.show({
        title: res.ok ? "Stripe API connection verified" : "Stripe API check reported an issue",
        tone: res.ok ? "success" : "danger",
        description: res.message,
      });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) {
        const msg = errorMessage(error, "Stripe API check failed.");
        setConnectionCheckResult({ ok: false, message: msg });
        toast.show({ title: "Stripe API check failed", tone: "danger", description: msg });
      }
    }
  }

  async function handleVerifyCheckoutSession() {
    try {
      const res = await stepUp.run(
        () => verifyCheckoutSession.mutateAsync({ provider: "stripe" }),
        { reason: "Verifying Stripe Checkout session creation requires a recent identity check." },
      );
      setCheckoutProbeResult({
        ok: res.ok,
        message: res.message,
        reasonCode: res.failureReasonCode ?? (res.ok ? "CHECKOUT_SESSION_VERIFIED" : "STRIPE_CHECKOUT_PROBE_FAILED"),
      });
      await refreshAll();
      toast.show({
        title: res.ok ? "Checkout session creation verified" : "Checkout session creation failed",
        tone: res.ok ? "success" : "danger",
        description: res.message,
      });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) {
        const msg = errorMessage(error, "Checkout session creation check failed.");
        setCheckoutProbeResult({ ok: false, message: msg, reasonCode: "STRIPE_CHECKOUT_PROBE_FAILED" });
        toast.show({ title: "Checkout session creation failed", tone: "danger", description: msg });
      }
    }
  }

  async function handleSendSelfTest() {
    try {
      const res = await stepUp.run(
        () => sendSelfTest.mutateAsync({ provider: "stripe" }),
        { reason: "Running a signed webhook self-test requires a recent identity check." },
      );
      if (res.ok) {
        setSigningSecretRotatedKind(null);
      }
      await refreshAll();
      toast.show({
        title: res.ok ? "Self-test webhook verified" : "Self-test webhook rejected",
        tone: res.ok ? "success" : "danger",
        description: `HTTP ${res.httpStatus}${res.reasonCode ? ` (${res.reasonCode})` : ""}`,
      });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) {
        toast.show({
          title: "Self-test webhook could not run",
          tone: "danger",
          description: errorMessage(error),
        });
      }
    }
  }

  async function submitStagedCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormNotice(null);
    setFieldErrors({});
    setSigningSecretRotatedKind(null);

    const rawSk = secretKey;
    const rawWh = webhookSecret;
    const rawWhSecondary = webhookSecretSecondary;

    if (!rawSk.trim() && !rawWh.trim() && !rawWhSecondary.trim() && !clearSecondary && sameMode) {
      setFormNotice("Enter at least one Stripe key or change the target environment before saving.");
      return;
    }

    const nextFieldErrors: Partial<Record<StagedStripeField, string>> = {};
    let normalizedSk: string | undefined;
    let normalizedWh: string | undefined;
    let normalizedWhSecondary: string | undefined;

    if (rawSk.trim()) {
      const res = validateStripeSecretKeyField(rawSk, activeMode);
      if (!res.ok) nextFieldErrors.stripeSecretKey = res.error;
      else normalizedSk = res.normalized;
    }
    if (rawWh.trim()) {
      const res = validateStripeWebhookSecretField(rawWh, "stripeWebhookSecret");
      if (!res.ok) nextFieldErrors.stripeWebhookSecret = res.error;
      else normalizedWh = res.normalized;
    }
    if (rawWhSecondary.trim()) {
      const res = validateStripeWebhookSecretField(rawWhSecondary, "stripeWebhookSecretSecondary");
      if (!res.ok) nextFieldErrors.stripeWebhookSecretSecondary = res.error;
      else normalizedWhSecondary = res.normalized;
    }

    const orderedFields: StagedStripeField[] = [
      "stripeSecretKey",
      "stripeWebhookSecret",
      "stripeWebhookSecretSecondary",
    ];
    const firstInvalid = orderedFields.find((f) => Boolean(nextFieldErrors[f]));
    if (firstInvalid) {
      setFieldErrors(nextFieldErrors);
      setFormNotice(nextFieldErrors[firstInvalid] ?? "Correct the highlighted field before saving.");
      focusField(firstInvalid);
      return;
    }

    const rotatedKind: "primary" | "secondary" | null = normalizedWh
      ? "primary"
      : normalizedWhSecondary
        ? "secondary"
        : null;

    setSavingKeys(true);
    try {
      await stepUp.run(
        () =>
          client.payments.admin.updateSettings.mutate({
            provider: settings.provider,
            mode: activeMode,
            currency: settings.currency,
            successPath: settings.successPath,
            cancelPath: settings.cancelPath,
            webhookToleranceSeconds: settings.webhookToleranceSeconds,
            squareLocationId: settings.square.locationId,
            ...(normalizedSk ? { stripeSecretKey: normalizedSk } : {}),
            ...(normalizedWh ? { stripeWebhookSecret: normalizedWh } : {}),
            ...(normalizedWhSecondary ? { stripeWebhookSecretSecondary: normalizedWhSecondary } : {}),
            ...(clearSecondary && !normalizedWhSecondary
              ? { clearStripeWebhookSecretSecondary: true }
              : {}),
          }),
        { reason: "Saving Stripe credentials requires a recent identity check." },
      );
      setSecretKey("");
      setWebhookSecret("");
      setWebhookSecretSecondary("");
      setSecretResetSeq((n) => n + 1);
      setClearSecondary(false);
      setModeDraft(null);
      setSigningSecretRotatedKind(rotatedKind);
      if (normalizedSk || !sameMode) {
        setConnectionCheckResult(null);
        setCheckoutProbeResult(null);
      }
      await refreshAll();
      toast.show({
        title:
          settings.provider === "stripe"
            ? "Stripe credentials updated"
            : "Stripe credentials staged without changing active provider",
        tone: "success",
      });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) {
        const extracted = extractServerCredentialFieldError(error, "Stripe credentials could not be saved.");
        if (
          extracted.field === "stripeSecretKey" ||
          extracted.field === "stripeWebhookSecret" ||
          extracted.field === "stripeWebhookSecretSecondary"
        ) {
          const targetField: StagedStripeField = extracted.field;
          setFieldErrors({ [targetField]: extracted.message });
          focusField(targetField);
        }
        setFormNotice(errorMessage(error, "Stripe credentials could not be saved."));
      }
    } finally {
      setSavingKeys(false);
    }
  }

  async function activateStripeCheckout() {
    setActivating(true);
    try {
      await stepUp.run(
        () =>
          client.payments.admin.updateSettings.mutate({
            provider: "stripe",
            mode: settings.mode,
            currency: settings.currency,
            successPath: settings.successPath,
            cancelPath: settings.cancelPath,
            webhookToleranceSeconds: settings.webhookToleranceSeconds,
            squareLocationId: settings.square.locationId,
          }),
        { reason: "Activating Stripe Checkout requires a recent identity check." },
      );
      await refreshAll();
      toast.show({ title: "Stripe Checkout is now active", tone: "success" });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) {
        toast.show({
          title: "Stripe Checkout could not be activated",
          tone: "danger",
          description: errorMessage(error),
        });
      }
    } finally {
      setActivating(false);
    }
  }

  async function deactivateStripeCheckout() {
    setDeactivating(true);
    try {
      await stepUp.run(
        () =>
          client.payments.admin.updateSettings.mutate({
            provider: "none",
            mode: settings.mode,
            currency: settings.currency,
            successPath: settings.successPath,
            cancelPath: settings.cancelPath,
            webhookToleranceSeconds: settings.webhookToleranceSeconds,
            squareLocationId: settings.square.locationId,
          }),
        { reason: "Switching back to Pay by invoice requires a recent identity check." },
      );
      await refreshAll();
      toast.show({ title: "Switched back to Pay by invoice", tone: "success" });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) {
        toast.show({
          title: "Provider could not be updated",
          tone: "danger",
          description: errorMessage(error),
        });
      }
    } finally {
      setDeactivating(false);
    }
  }

  const checklistItems: ChecklistItem[] = [
    {
      key: "egress",
      label: "Outbound HTTPS allowlist for api.stripe.com:443",
      description:
        "Required for creating Checkout Sessions, expanding PaymentIntent details, and verifying refunds over pinned TLS.",
      state: egressAllowlisted ? "done" : "todo",
      action: (
        <Switch
          label="Allow api.stripe.com:443"
          checked={egressAllowlisted}
          disabled={setEgressPreset.isPending}
          onCheckedChange={(checked) => {
            void toggleStripeEgress(checked);
          }}
        />
      ),
    },
    {
      key: "inbound",
      label: "Inbound country allow-list exemption for /api/payments/webhooks/stripe",
      description:
        "Signed Stripe webhook deliveries bypass country filtering before geo checks while keeping rate limits, the 256 KB body limit, and HMAC verification active.",
      state: "done",
    },
    {
      key: "secretKey",
      label: `Stripe API secret key (${settings.mode})`,
      description: settings.stripe.secretKeyLast4
        ? `Saved (ending in ${settings.stripe.secretKeyLast4}).`
        : "Stage an sk_test_, sk_live_, rk_test_, or rk_live_ key below.",
      state: settings.stripe.secretKeyConfigured ? "done" : "todo",
    },
    {
      key: "webhookSecret",
      label: `Primary Stripe webhook signing secret (${settings.mode})`,
      description: settings.stripe.webhookSecretLast4
        ? `Saved (ending in ${settings.stripe.webhookSecretLast4}).`
        : "Stage the whsec_ endpoint secret from your Stripe webhook configuration.",
      state: settings.stripe.webhookSecretConfigured ? "done" : "todo",
    },
    {
      key: "apiTest",
      label: "Verify outbound Stripe API connectivity",
      description:
        connectionCheckResult && !connectionCheckResult.ok ? (
          connectionCheckResult.message
        ) : settings.stripe.lastApiVerifiedAt ? (
          <span>
            Verified <DateTime value={settings.stripe.lastApiVerifiedAt} />
            {connectionCheckResult?.ok ? ` — ${connectionCheckResult.message}` : "."}
          </span>
        ) : (
          "Calls GET /v1/checkout/sessions?limit=1 over the pinned outbound allowlist and confirms key environment alignment. Required for the current staged key, mode, and allowlist."
        ),
      state: apiVerified ? "done" : "todo",
      action: (
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<PlugZap aria-hidden />}
          loading={testConnection.isPending}
          disabled={!egressAllowlisted || !settings.stripe.secretKeyConfigured}
          onClick={() => {
            void handleTestConnection();
          }}
        >
          Test Stripe API
        </Button>
      ),
    },
    {
      key: "checkoutSessionProbe",
      label: "Verify Checkout session creation",
      description:
        checkoutProbeResult !== null ? (
          checkoutProbeResult.message
        ) : persistedProbe !== null ? (
          <span>
            {persistedProbe.ok ? "Verified " : `Failed (${persistedProbe.reasonCode}) `}
            <DateTime value={persistedProbe.checkedAt} />.
          </span>
        ) : (
          "Creates an unpaid test Checkout Session over pinned HTTPS and expires it immediately at zero cost. Catches restricted keys missing Checkout Sessions write permission and custom Checkout domains before customers try to pay."
        ),
      state: effectiveProbeOk === true ? "done" : effectiveProbeOk === false ? "blocked" : "todo",
      action: (
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<CreditCard aria-hidden />}
          loading={verifyCheckoutSession.isPending}
          disabled={!egressAllowlisted || !settings.stripe.secretKeyConfigured}
          onClick={() => {
            void handleVerifyCheckoutSession();
          }}
        >
          Verify Checkout session creation
        </Button>
      ),
    },
    {
      key: "selfTest",
      label: "Verify signed webhook pipeline with self-test event",
      description: settings.stripe.lastSelfTestWebhookAt ? (
        <span>
          Last self-test verified <DateTime value={settings.stripe.lastSelfTestWebhookAt} />. Confirms local signature verification; also send a test event from Stripe Workbench to verify live endpoint delivery.
        </span>
      ) : (
        "Signs a synthetic event with the saved primary signing secret and runs it through signature verification without booking any invoice."
      ),
      state: selfTestVerified ? "done" : "todo",
      action: (
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<Play aria-hidden />}
          loading={sendSelfTest.isPending}
          disabled={!settings.stripe.webhookSecretConfigured}
          onClick={() => {
            void handleSendSelfTest();
          }}
        >
          Send self-test webhook
        </Button>
      ),
    },
    {
      key: "activate",
      label: "Activate Stripe Checkout for customer invoices and cart checkout",
      description: stripeActiveAndReady
        ? `Active in ${settings.mode} mode.`
        : settings.provider === "stripe"
          ? "Stripe is selected as provider, but online checkout stays on invoice fallback until every prerequisite above is verified."
          : `Current active provider: ${settings.provider === "none" ? "Pay by invoice" : "Square"}.`,
      state: stripeActiveAndReady ? "done" : stripePrereqsReady ? "todo" : "blocked",
      action:
        settings.provider === "stripe" ? (
          <div className="flex flex-wrap items-center gap-2">
            {!stripeActiveAndReady && stripePrereqsReady ? (
              <Button
                size="sm"
                loading={activating}
                disabled={activating || deactivating}
                onClick={() => setConfirmActivateOpen(true)}
              >
                Activate Stripe Checkout
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              loading={deactivating}
              disabled={deactivating || activating}
              onClick={() => setConfirmDeactivateOpen(true)}
            >
              Switch to Pay by invoice
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            loading={activating}
            disabled={!stripePrereqsReady || activating}
            onClick={() => setConfirmActivateOpen(true)}
          >
            Activate Stripe Checkout
          </Button>
        ),
    },
  ];

  const cliSnippet = [
    `stripe listen --events ${requiredEvents.join(",")} --forward-to ${settings.stripe.webhookUrl}`,
    "stripe trigger checkout.session.completed",
  ].join("\n");

  const CredentialFieldKeyGuard: Record<StagedStripeField, CredentialFieldKey> = {
    stripeSecretKey: "stripeSecretKey",
    stripeWebhookSecret: "stripeWebhookSecret",
    stripeWebhookSecretSecondary: "stripeWebhookSecretSecondary",
  };
  void CredentialFieldKeyGuard;

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6">
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            items={[
              { href: "/admin/payments", label: "Payments" },
              { label: "Stripe setup" },
            ]}
          />
        }
        title="Stripe setup"
        description="Complete outbound allowlisting, stage credentials safely, verify Checkout session creation and signed webhooks, and inspect delivery diagnostics."
        actions={
          <Button asChild variant="secondary">
            <Link href="/admin/payments">Back to Payments</Link>
          </Button>
        }
      />

      <Callout
        tone={stripeActiveAndReady ? "success" : settings.provider === "stripe" ? "danger" : "warning"}
        title={statusHeadline}
      >
        <div className="grid min-w-0 gap-2">
          <p>{customerExperienceSummary}</p>
          {!stripeActiveAndReady && missingGates.length > 0 ? (
            <div>
              <p className="font-semibold">Missing readiness gates:</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {missingGates.map((gate) => (
                  <li key={gate} className="break-words">
                    {gate}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Callout>

      {reverificationNeeded ? (
        <Callout
          tone="warning"
          title="Credentials or outbound allowlist changed after verification"
          live="polite"
        >
          <p className="mb-1.5">
            Online card redirect is paused while verification is stale so customers never hit an unverified configuration. Meanwhile, customer orders still submit cleanly and issue an unpaid invoice without losing cart items.
          </p>
          {reverificationReasons.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5">
              {reverificationReasons.map((reason) => (
                <li key={reason} className="break-words">
                  {reason}
                </li>
              ))}
            </ul>
          ) : null}
        </Callout>
      ) : null}

      {signingSecretRotatedKind ? (
        <Callout tone="warning" title="Re-run webhook verification after changing a signing secret" live="polite">
          <p>
            {signingSecretRotatedKind === "primary"
              ? "You saved a new Primary Stripe webhook signing secret. Click Send self-test webhook in the checklist below so online card checkout can resume. "
              : "You saved a Secondary rollover signing secret. "}
            Important: the portal self-test only proves ReadyPackets&apos; local signature check against the secret stored here — confirm real end-to-end delivery from Stripe Workbench &gt; Webhooks &gt; Send test event (or a real payment) to verify Stripe has the matching endpoint URL and signing secret.
          </p>
        </Callout>
      ) : null}

      <Checklist title="Stripe readiness checklist" items={checklistItems} />

      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <KeyRound className="size-4" aria-hidden />
            Stage Stripe credentials
          </span>
        }
        description="Save or rotate Stripe keys for the selected environment. Saving here keeps your current active provider unchanged until you activate Stripe Checkout; rotating an active key pauses online card redirect until re-verified."
      >
        <form className="grid min-w-0 grid-cols-1 gap-4" onSubmit={(event) => void submitStagedCredentials(event)}>
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Target Stripe environment" required>
              <Select
                value={activeMode}
                options={modeOptions}
                disabled={savingKeys}
                onChange={(event) => {
                  setModeDraft(event.target.value as "test" | "live");
                  setSecretKey("");
                  setWebhookSecret("");
                  setWebhookSecretSecondary("");
                  setSecretResetSeq((n) => n + 1);
                  setFieldErrors({});
                  setClearSecondary(false);
                }}
              />
            </Field>
          </div>
          <SecretCredentialField
            key={`sk-${secretResetSeq}`}
            label="Stripe API secret key"
            hint={`${sameMode ? keyStatusHint(settings.stripe.secretKeyLast4) : "Enter a key matching the selected environment."} Where to find it: Stripe Dashboard > Developers > API keys > Secret key (sk_${activeMode}_…) or Restricted keys (rk_${activeMode}_… with Checkout Sessions: Write, Payment Intents: Read, and Charges: Read/Write for refunds). Publishable keys (pk_…) are not used.`}
            error={fieldErrors.stripeSecretKey}
            value={secretKey}
            disabled={savingKeys}
            inputRef={(el) => {
              fieldRefs.current.stripeSecretKey = el;
            }}
            onChange={(next) => {
              setSecretKey(next);
              clearFieldError("stripeSecretKey");
            }}
          />
          <SecretCredentialField
            key={`wh1-${secretResetSeq}`}
            label="Primary Stripe webhook signing secret"
            hint={`${sameMode ? keyStatusHint(settings.stripe.webhookSecretLast4) : "Enter the whsec_ secret for the selected environment."} Where to find it: Stripe Dashboard > Developers > Webhooks (or Workbench > Webhooks) > select your endpoint > Signing secret > Reveal (whsec_…). Do not paste the endpoint ID (we_…) or an API key (sk_… / rk_…).`}
            error={fieldErrors.stripeWebhookSecret}
            value={webhookSecret}
            disabled={savingKeys}
            inputRef={(el) => {
              fieldRefs.current.stripeWebhookSecret = el;
            }}
            onChange={(next) => {
              setWebhookSecret(next);
              clearFieldError("stripeWebhookSecret");
            }}
          />
          <SecretCredentialField
            key={`wh2-${secretResetSeq}`}
            label="Secondary Stripe webhook signing secret (optional rollover)"
            hint={`${sameMode ? keyStatusHint(settings.stripe.webhookSecretSecondaryLast4 ?? null) : "Leave empty during normal setup."} Optional rollover slot accepted alongside Primary only while rotating secrets with zero downtime. Leave empty during normal setup. To replace the saved signing secret, paste the new whsec_… value into Primary Stripe webhook signing secret above.`}
            error={fieldErrors.stripeWebhookSecretSecondary}
            value={webhookSecretSecondary}
            disabled={savingKeys}
            inputRef={(el) => {
              fieldRefs.current.stripeWebhookSecretSecondary = el;
            }}
            onChange={(next) => {
              setWebhookSecretSecondary(next);
              clearFieldError("stripeWebhookSecretSecondary");
            }}
          />
          {showSecondaryRolloverCallout ? (
            <Callout tone="info" title="Saving Secondary keeps your existing Primary signing secret">
              You entered a <code>whsec_…</code> secret in <strong>Secondary Stripe webhook signing secret</strong> while leaving Primary blank. Secondary is used only during zero-downtime rollover while Stripe signs events with two secrets simultaneously, and <strong>Send self-test webhook</strong> tests Primary. If you meant to replace your saved signing secret, paste it into <strong>Primary Stripe webhook signing secret</strong> instead.
            </Callout>
          ) : null}
          {sameMode && settings.stripe.webhookSecretSecondaryConfigured ? (
            <Checkbox
              label="Retire secondary signing secret"
              description="Clears the secondary signing secret once webhook secret rotation is complete."
              checked={clearSecondary}
              disabled={savingKeys || Boolean(webhookSecretSecondary.trim())}
              onCheckedChange={setClearSecondary}
            />
          ) : null}
          {formNotice ? (
            <Callout tone="danger" title="Credentials were not saved" live="assertive">
              {formNotice}
            </Callout>
          ) : null}
          <div>
            <Button type="submit" loading={savingKeys} disabled={savingKeys}>
              Stage Stripe credentials
            </Button>
          </div>
        </form>
      </Card>

      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <Activity className="size-4" aria-hidden />
            Checkout session diagnostics
          </span>
        }
        description="Safe summary of the most recent Checkout Session creation failure and setup probe. Raw provider error strings and secret values are never stored or displayed."
      >
        {lastCheckoutFailure ? (
          <div className="grid min-w-0 gap-4">
            <Callout tone="danger" title="Last checkout-session failure">
              Customers could not be redirected to Stripe Checkout during an order or invoice payment attempt. An operational alert was also posted to <Link href="/admin/alerts" className="font-semibold underline underline-offset-2">/admin/alerts</Link>.
            </Callout>
            <KeyValueList
              columns={3}
              items={[
                {
                  label: "Occurred at",
                  value: <DateTime value={lastCheckoutFailure.occurredAt} />,
                },
                {
                  label: "Failure class",
                  value:
                    failureClassLabels[lastCheckoutFailure.failureClass] ??
                    lastCheckoutFailure.failureClass,
                },
                {
                  label: "Reason code",
                  value: <span className="break-all font-mono text-xs">{lastCheckoutFailure.reasonCode}</span>,
                },
                {
                  label: "Upstream HTTP status",
                  value:
                    lastCheckoutFailure.upstreamStatus !== null
                      ? `HTTP ${lastCheckoutFailure.upstreamStatus}`
                      : "Not applicable (blocked before upstream response)",
                },
                {
                  label: "Stripe error code",
                  value: lastCheckoutFailure.stripeErrorCode ? (
                    <span className="break-all font-mono text-xs">{lastCheckoutFailure.stripeErrorCode}</span>
                  ) : (
                    "None reported"
                  ),
                },
                {
                  label: "Stripe error type / param",
                  value:
                    lastCheckoutFailure.stripeErrorType || lastCheckoutFailure.stripeErrorParam ? (
                      <span className="break-all font-mono text-xs">
                        {[lastCheckoutFailure.stripeErrorType, lastCheckoutFailure.stripeErrorParam]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    ) : (
                      "None reported"
                    ),
                },
              ]}
            />
          </div>
        ) : (
          <p className="text-sm text-muted">
            No failed Stripe Checkout session creations have been recorded.
          </p>
        )}
      </Card>

      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <Webhook className="size-4" aria-hidden />
            Webhook endpoint &amp; required events
          </span>
        }
        description="Register this exact HTTPS endpoint in the Stripe Dashboard and subscribe to all 9 event types below."
      >
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <CopyField
            className="min-w-0"
            label="Stripe webhook endpoint URL"
            value={settings.stripe.webhookUrl}
            copyLabel="Copy webhook endpoint URL"
            monospace
          />
          <CopyField
            className="min-w-0"
            label="Required Stripe webhook events (comma-separated)"
            value={requiredEvents.join(",")}
            copyLabel="Copy event list"
            monospace
          />
          <ul className="flex min-w-0 max-w-full flex-wrap gap-2" aria-label="Required Stripe webhook event names">
            {requiredEvents.map((eventName) => (
              <li key={eventName} className="min-w-0 max-w-full">
                <code className="inline-block max-w-full rounded-full border border-line bg-surface-sunken px-2.5 py-0.5 font-mono text-xs font-semibold break-all text-ink">
                  {eventName}
                </code>
              </li>
            ))}
          </ul>
          <KeyValueList
            columns={3}
            items={[
              {
                label: "Last verified webhook",
                value: settings.stripe.lastVerifiedWebhookAt ? (
                  <DateTime value={settings.stripe.lastVerifiedWebhookAt} />
                ) : (
                  "None received yet"
                ),
              },
              {
                label: "Last verified event type",
                value: settings.stripe.lastVerifiedWebhookEventType ? (
                  <span className="break-all font-mono text-xs">{settings.stripe.lastVerifiedWebhookEventType}</span>
                ) : (
                  "Not applicable"
                ),
              },
              {
                label: "Last self-test webhook",
                value: settings.stripe.lastSelfTestWebhookAt ? (
                  <DateTime value={settings.stripe.lastSelfTestWebhookAt} />
                ) : (
                  "Not run yet"
                ),
              },
            ]}
          />
        </div>
      </Card>

      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <Terminal className="size-4" aria-hidden />
            Local &amp; staging Stripe CLI verification
          </span>
        }
        description="Forward signed sandbox events from the Stripe CLI when testing before pointing a public Dashboard endpoint at this server."
      >
        <CodeBlock language="bash" label="Stripe CLI commands" copyable>
          {cliSnippet}
        </CodeBlock>
      </Card>

      <WebhookRejectionsCard />

      <ConfirmDialog
        title={
          settings.mode === "live"
            ? "Activate live Stripe Checkout?"
            : "Activate Stripe Checkout (test mode)?"
        }
        open={confirmActivateOpen}
        onOpenChange={setConfirmActivateOpen}
        description={
          settings.mode === "live"
            ? "Customer cart checkouts and unpaid issued invoices will redirect buyers to live Stripe Checkout and charge real payment methods. Verified live webhooks will settle matching invoices and issue receipts automatically."
            : "Customer cart checkouts and unpaid issued invoices will offer hosted Stripe Checkout in test mode instead of invoice-only checkout. Sandbox test cards will be accepted and no real funds will move."
        }
        confirmText={settings.mode === "live" ? "ACTIVATE LIVE PAYMENTS" : undefined}
        confirmLabel={
          settings.mode === "live" ? "Activate live Stripe Checkout" : "Activate Stripe Checkout"
        }
        onConfirm={activateStripeCheckout}
      />

      <ConfirmDialog
        title="Switch back to Pay by invoice?"
        open={confirmDeactivateOpen}
        onOpenChange={setConfirmDeactivateOpen}
        description="Hosted Stripe Checkout buttons will be turned off for new customer cart checkouts and unpaid invoices. Customers will place invoice-only orders while your staged Stripe credentials remain saved."
        confirmLabel="Switch to Pay by invoice"
        onConfirm={deactivateStripeCheckout}
      />
    </div>
  );
}
