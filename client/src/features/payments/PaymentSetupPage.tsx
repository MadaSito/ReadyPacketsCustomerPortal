import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Play, PlugZap, ShieldAlert, Terminal, Webhook } from "lucide-react";
import { useState, type FormEvent } from "react";
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
  Input,
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

function keyStatusHint(last4: string | null) {
  return last4
    ? `Configured (ending in ${last4}). Leave blank to keep the saved key.`
    : "Not configured yet. Keys are encrypted at rest and never returned after saving.";
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
  const sendSelfTest = useMutation(trpc.payments.admin.sendSelfTestWebhook.mutationOptions());

  const [modeDraft, setModeDraft] = useState<"test" | "live" | null>(null);
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookSecretSecondary, setWebhookSecretSecondary] = useState("");
  const [clearSecondary, setClearSecondary] = useState(false);
  const [savingKeys, setSavingKeys] = useState(false);
  const [activating, setActivating] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [confirmActivateOpen, setConfirmActivateOpen] = useState(false);
  const [confirmDeactivateOpen, setConfirmDeactivateOpen] = useState(false);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  const [connectionCheckResult, setConnectionCheckResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

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
  const stripePrereqsReady =
    egressAllowlisted &&
    settings.stripe.secretKeyConfigured &&
    settings.stripe.webhookSecretConfigured &&
    apiVerified &&
    selfTestVerified;
  const stripeActiveAndReady = settings.provider === "stripe" && settings.onlineEnabled;

  async function toggleStripeEgress(nextEnabled: boolean) {
    try {
      await stepUp.run(
        () => setEgressPreset.mutateAsync({ presetKey: "stripe", enabled: nextEnabled }),
        { reason: "Updating outbound network presets requires a recent identity check." },
      );
      setConnectionCheckResult(null);
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

  async function handleSendSelfTest() {
    try {
      const res = await stepUp.run(
        () => sendSelfTest.mutateAsync({ provider: "stripe" }),
        { reason: "Running a signed webhook self-test requires a recent identity check." },
      );
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
    const trimmedSk = secretKey.trim();
    const trimmedWh = webhookSecret.trim();
    const trimmedWhSecondary = webhookSecretSecondary.trim();
    if (!trimmedSk && !trimmedWh && !trimmedWhSecondary && !clearSecondary && sameMode) {
      setFormNotice("Enter at least one Stripe key or change the target environment before saving.");
      return;
    }
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
            ...(trimmedSk ? { stripeSecretKey: trimmedSk } : {}),
            ...(trimmedWh ? { stripeWebhookSecret: trimmedWh } : {}),
            ...(trimmedWhSecondary ? { stripeWebhookSecretSecondary: trimmedWhSecondary } : {}),
            ...(clearSecondary && !trimmedWhSecondary
              ? { clearStripeWebhookSecretSecondary: true }
              : {}),
          }),
        { reason: "Saving Stripe credentials requires a recent identity check." },
      );
      setSecretKey("");
      setWebhookSecret("");
      setWebhookSecretSecondary("");
      setClearSecondary(false);
      setModeDraft(null);
      if (trimmedSk || !sameMode) {
        setConnectionCheckResult(null);
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
      key: "selfTest",
      label: "Verify signed webhook pipeline with self-test event",
      description: settings.stripe.lastSelfTestWebhookAt ? (
        <span>
          Last self-test verified <DateTime value={settings.stripe.lastSelfTestWebhookAt} />.
        </span>
      ) : (
        "Signs a synthetic event with the saved signing secret and runs it through signature verification without booking any invoice."
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
        description="Complete outbound allowlisting, stage credentials safely, verify signed webhooks, and inspect delivery diagnostics."
        actions={
          <Button asChild variant="secondary">
            <Link href="/admin/payments">Back to Payments</Link>
          </Button>
        }
      />

      <Callout
        tone={stripeActiveAndReady ? "success" : "warning"}
        title={
          stripeActiveAndReady
            ? `Stripe Checkout is active (${settings.mode} mode)`
            : stripePrereqsReady
              ? "Stripe prerequisites are ready — activate when ready"
              : "Complete the checklist below before enabling Stripe Checkout"
        }
      >
        {stripeActiveAndReady
          ? "Customer cart checkouts and unpaid issued invoices can start hosted Stripe Checkout sessions, and verified webhooks settle invoices automatically."
          : "You can stage credentials, allow outbound access to api.stripe.com:443, and run both connection checks while keeping Pay by invoice active."}
      </Callout>

      <Checklist title="Stripe readiness checklist" items={checklistItems} />

      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <KeyRound className="size-4" aria-hidden />
            Stage Stripe credentials
          </span>
        }
        description="Save or rotate Stripe keys for the selected environment. Saving here keeps your current active provider unchanged until you activate Stripe Checkout."
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
                  setClearSecondary(false);
                }}
              />
            </Field>
          </div>
          <Field
            label="Stripe API secret key"
            hint={sameMode ? keyStatusHint(settings.stripe.secretKeyLast4) : "Enter a key matching the selected environment."}
          >
            <Input
              type="password"
              value={secretKey}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={256}
              disabled={savingKeys}
              onChange={(event) => setSecretKey(event.target.value)}
            />
          </Field>
          <Field
            label="Primary Stripe webhook signing secret"
            hint={sameMode ? keyStatusHint(settings.stripe.webhookSecretLast4) : "Enter the whsec_ secret for the selected environment."}
          >
            <Input
              type="password"
              value={webhookSecret}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={256}
              disabled={savingKeys}
              onChange={(event) => setWebhookSecret(event.target.value)}
            />
          </Field>
          <Field
            label="Secondary Stripe webhook signing secret (optional rollover)"
            hint={
              sameMode
                ? keyStatusHint(settings.stripe.webhookSecretSecondaryLast4 ?? null)
                : "Optional rollover secret accepted alongside the primary secret during zero-downtime key rotation."
            }
          >
            <Input
              type="password"
              value={webhookSecretSecondary}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={256}
              disabled={savingKeys}
              onChange={(event) => setWebhookSecretSecondary(event.target.value)}
            />
          </Field>
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
