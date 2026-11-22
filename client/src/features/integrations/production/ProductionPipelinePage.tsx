/**
 * /admin/integrations/production — Production pipeline (P101 / P201 / optional P301 & P401)
 * admin configuration, dry-run egress verification, and filterable dispatch log.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { errorMessage, safeError } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  DateTime,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  Input,
  KeyValueList,
  PageHeader,
  Section,
  Select,
  Skeleton,
  StepUpCancelledError,
  Switch,
  useStepUp,
  useToast,
} from "@/ui";
import { useProductionClient, useProductionTRPC } from "./api";
import {
  auditCorrelationHref,
  DISPATCH_STATE_META,
  formatMaskedUrl,
  HEADER_NAME_RE,
  PHASE_LABELS,
  RUN_MODE_RE,
  SETTINGS_STATE_META,
  type ProductionDestinationTestResult,
  type ProductionDispatchItem,
  type ProductionDispatchState,
  type ProductionPhase,
  type ProductionSettingsView,
} from "./model";

export interface SettingsFormState {
  enabled: boolean;
  canonVersion: string;
  runMode: string;
  timeoutSeconds: string;
  p101Url: string;
  clearP101Url: boolean;
  p201Url: string;
  clearP201Url: boolean;
  p301Url: string;
  clearP301Url: boolean;
  p401Url: string;
  clearP401Url: boolean;
  authHeaderName: string;
  authHeaderValue: string;
  clearAuthHeaderValue: boolean;
}

type FormErrors = Partial<Record<keyof SettingsFormState | "form", string>>;

function toInitialForm(view: ProductionSettingsView): SettingsFormState {
  return {
    enabled: view.enabled,
    canonVersion: view.canonVersion,
    runMode: view.runMode || "production",
    timeoutSeconds: String(Math.round((view.timeoutMs || 10_000) / 1_000)),
    p101Url: "",
    clearP101Url: false,
    p201Url: "",
    clearP201Url: false,
    p301Url: "",
    clearP301Url: false,
    p401Url: "",
    clearP401Url: false,
    authHeaderName: view.authHeaderName,
    authHeaderValue: "",
    clearAuthHeaderValue: false,
  };
}

function isHttpsUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function validateSettingsForm(
  form: SettingsFormState,
  current: ProductionSettingsView,
): FormErrors {
  const errors: FormErrors = {};
  const p101Trimmed = form.p101Url.trim();
  const p201Trimmed = form.p201Url.trim();
  const p301Trimmed = form.p301Url.trim();
  const p401Trimmed = form.p401Url.trim();
  const canonTrimmed = form.canonVersion.trim();
  const runModeTrimmed = form.runMode.trim();
  const headerNameTrimmed = form.authHeaderName.trim();

  if (p101Trimmed && !isHttpsUrl(p101Trimmed)) {
    errors.p101Url = "Enter a valid HTTPS webhook URL starting with https://.";
  }
  if (p201Trimmed && !isHttpsUrl(p201Trimmed)) {
    errors.p201Url = "Enter a valid HTTPS webhook URL starting with https://.";
  }
  if (p301Trimmed && !isHttpsUrl(p301Trimmed)) {
    errors.p301Url = "Enter a valid HTTPS webhook URL starting with https://.";
  }
  if (p401Trimmed && !isHttpsUrl(p401Trimmed)) {
    errors.p401Url = "Enter a valid HTTPS webhook URL starting with https://.";
  }

  const willHaveP101 = p101Trimmed
    ? true
    : current.p101UrlConfigured && !form.clearP101Url;
  const willHaveP201 = p201Trimmed
    ? true
    : current.p201UrlConfigured && !form.clearP201Url;

  if (form.enabled) {
    if (!canonTrimmed) {
      errors.canonVersion =
        "Enter the production canon version before enabling webhooks.";
    }
    if (!willHaveP101) {
      errors.p101Url =
        "Configure the Phase I (P101) HTTPS webhook URL before enabling.";
    }
    if (!willHaveP201) {
      errors.p201Url =
        "Configure the Phase II (P201) HTTPS webhook URL before enabling.";
    }
  }

  if (!RUN_MODE_RE.test(runModeTrimmed)) {
    errors.runMode =
      "Use lowercase letters, numbers, or underscores (start with a letter, up to 32 characters).";
  }

  const timeoutSec = Number(form.timeoutSeconds);
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 30) {
    errors.timeoutSeconds = "Enter a timeout between 1 and 30 seconds.";
  }

  if (headerNameTrimmed && !HEADER_NAME_RE.test(headerNameTrimmed)) {
    errors.authHeaderName =
      "Enter a valid HTTP header name (letters, digits, and hyphens only).";
  }

  return errors;
}

function parseDateStart(raw: string): Date | undefined {
  if (!raw) return undefined;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseDateEnd(raw: string): Date | undefined {
  if (!raw) return undefined;
  const parsed = new Date(`${raw}T23:59:59.999Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function shortPublicId(publicId: string): string {
  return publicId.length > 10 ? `…${publicId.slice(-6)}` : publicId;
}

export default function ProductionPipelinePage() {
  const prodTrpc = useProductionTRPC();
  const prodClient = useProductionClient();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();

  const settings = useQuery(prodTrpc.settings.get.queryOptions());

  const [draft, setDraft] = useState<SettingsFormState>();
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  const [testingPhase, setTestingPhase] = useState<ProductionPhase | null>(null);
  const [testError, setTestError] = useState<string>();
  const [lastTest, setLastTest] = useState<ProductionDestinationTestResult>();

  // Dispatch filter controls
  const [searchInput, setSearchInput] = useState("");
  const [orderReference, setOrderReference] = useState("");
  const [phaseFilter, setPhaseFilter] = useState<"" | ProductionPhase>("");
  const [stateFilter, setStateFilter] = useState<"" | ProductionDispatchState>("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const dispatchFilterInput = {
    ...(phaseFilter ? { phase: phaseFilter } : {}),
    ...(stateFilter ? { state: stateFilter } : {}),
    ...(orderReference.trim() ? { orderReference: orderReference.trim() } : {}),
    ...(parseDateStart(fromDate) ? { fromDate: parseDateStart(fromDate) } : {}),
    ...(parseDateEnd(toDate) ? { toDate: parseDateEnd(toDate) } : {}),
    limit: 50,
  };
  const dispatches = useQuery(prodTrpc.admin.listDispatches.queryOptions(dispatchFilterInput));

  const data = settings.data;
  const form = draft ?? (data ? toInitialForm(data) : undefined);
  const updateForm = <K extends keyof SettingsFormState>(
    key: K,
    value: SettingsFormState[K],
  ) => {
    setDraft((prev) => {
      const base = prev ?? (data ? toInitialForm(data) : undefined);
      return base ? { ...base, [key]: value } : base;
    });
  };

  const activeFilterCount =
    (orderReference.trim() ? 1 : 0) +
    (phaseFilter ? 1 : 0) +
    (stateFilter ? 1 : 0) +
    (fromDate ? 1 : 0) +
    (toDate ? 1 : 0);

  const resetFilters = () => {
    setSearchInput("");
    setOrderReference("");
    setPhaseFilter("");
    setStateFilter("");
    setFromDate("");
    setToDate("");
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || !data || saving) return;

    const found = validateSettingsForm(form, data);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const p101Url = form.clearP101Url
      ? null
      : form.p101Url.trim()
        ? form.p101Url.trim()
        : undefined;
    const p201Url = form.clearP201Url
      ? null
      : form.p201Url.trim()
        ? form.p201Url.trim()
        : undefined;
    const p301Url = form.clearP301Url
      ? null
      : form.p301Url.trim()
        ? form.p301Url.trim()
        : undefined;
    const p401Url = form.clearP401Url
      ? null
      : form.p401Url.trim()
        ? form.p401Url.trim()
        : undefined;
    const authHeaderValue = form.clearAuthHeaderValue
      ? null
      : form.authHeaderValue
        ? form.authHeaderValue
        : undefined;

    setSaving(true);
    try {
      await stepUp.run(
        () =>
          prodClient.settings.update.mutate({
            enabled: form.enabled,
            canonVersion: form.canonVersion.trim(),
            runMode: form.runMode.trim(),
            timeoutMs: Number(form.timeoutSeconds) * 1_000,
            authHeaderName: form.authHeaderName.trim(),
            ...(p101Url !== undefined ? { p101Url } : {}),
            ...(p201Url !== undefined ? { p201Url } : {}),
            ...(p301Url !== undefined ? { p301Url } : {}),
            ...(p401Url !== undefined ? { p401Url } : {}),
            ...(authHeaderValue !== undefined ? { authHeaderValue } : {}),
          }),
        { reason: "Changing production pipeline settings requires verification." },
      );
      toast.show({ tone: "success", title: "Production pipeline settings saved" });
      await queryClient.invalidateQueries({ queryKey: prodTrpc.pathKey() });
      await settings.refetch();
      setDraft(undefined);
      setErrors({});
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      const safe = safeError(err);
      const mapped: FormErrors = {
        form: errorMessage(err, "The production pipeline settings could not be saved."),
      };
      if (safe?.fieldErrors) {
        for (const [k, msgs] of Object.entries(safe.fieldErrors)) {
          if (msgs?.[0]) mapped[k as keyof SettingsFormState] = msgs[0];
        }
      }
      setErrors(mapped);
    } finally {
      setSaving(false);
    }
  };

  const onTestDestination = async (phase: ProductionPhase) => {
    if (testingPhase) return;
    setTestError(undefined);
    setTestingPhase(phase);
    try {
      const result = await stepUp.run(
        () => prodClient.settings.test.mutate({ phase }),
        { reason: "Testing a production webhook destination requires verification." },
      );
      setLastTest(result);
      toast.show({
        tone: result.allowed ? "success" : "warning",
        title: result.allowed
          ? `${PHASE_LABELS[phase]} passed allowlist check`
          : `${PHASE_LABELS[phase]} blocked by outbound policy`,
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setTestError(errorMessage(err, "Destination check could not be completed."));
    } finally {
      setTestingPhase(null);
    }
  };

  const stateMeta = data ? SETTINGS_STATE_META[data.state] : undefined;

  return (
    <>
      <PageHeader
        breadcrumbs={
          <div className="flex flex-col gap-1">
            <Link
              href="/admin/integrations"
              className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold text-action underline-offset-4 hover:underline focus-visible:underline"
            >
              <ArrowLeft className="size-4" aria-hidden />
              Back to Integrations
            </Link>
            <Breadcrumbs
              items={[
                { label: "Integrations", href: "/admin/integrations" },
                { label: "Production pipeline" },
              ]}
            />
          </div>
        }
        title="Production pipeline"
        description="Manual Phase I (P101), Phase II (P201), and optional Phase III (P301) / Phase IV (P401) webhook triggers. Webhook URLs and authorization headers are encrypted at rest, checked against the outbound allowlist, and never echoed."
        meta={stateMeta ? <Badge tone={stateMeta.tone}>{stateMeta.label}</Badge> : undefined}
      />

      <div className="flex min-w-0 flex-col gap-6">
        <Callout tone="info" title="What delivery status confirms">
          A delivered dispatch confirms HTTP acceptance by the configured webhook endpoint. The
          portal receives no inbound callback from the pipeline and cannot verify downstream
          artifact completion.
        </Callout>

        {settings.isError ? (
          <ErrorState
            error={settings.error}
            title="Production pipeline settings unavailable"
            onRetry={() => void settings.refetch()}
          />
        ) : settings.isPending || !data || !form ? (
          <div aria-busy="true">
            <Skeleton lines={6} />
          </div>
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
            <Card
              as="section"
              className="min-w-0 lg:col-span-2"
              title="Pipeline settings"
              description={data.summary}
            >
              <form
                noValidate
                onSubmit={(e) => void onSave(e)}
                className="flex flex-col gap-4"
                aria-label="Pipeline settings"
              >
                {errors.form ? (
                  <Callout tone="danger" live="assertive" title="Settings were not saved">
                    {errors.form}
                  </Callout>
                ) : null}

                <Switch
                  label="Enable production pipeline webhooks"
                  description="Off by default until Phase I (P101), Phase II (P201), and a canon version are configured. Phase III and Phase IV are optional."
                  checked={form.enabled}
                  onCheckedChange={(checked) => updateForm("enabled", checked)}
                />

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field
                    label="Canon version"
                    hint="Sent as canon_version in P101 (required when enabled)."
                    error={errors.canonVersion}
                    required={form.enabled}
                    className="sm:col-span-2"
                  >
                    <Input
                      value={form.canonVersion}
                      onChange={(e) => updateForm("canonVersion", e.target.value)}
                      placeholder="e.g. ReadyPackets_Production_v2.0"
                      maxLength={120}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>

                  <Field
                    label="Request timeout (seconds)"
                    hint="1 to 30 seconds."
                    error={errors.timeoutSeconds}
                    required
                  >
                    <Input
                      value={form.timeoutSeconds}
                      onChange={(e) => updateForm("timeoutSeconds", e.target.value)}
                      inputMode="numeric"
                      maxLength={2}
                      autoComplete="off"
                    />
                  </Field>
                </div>

                <Field
                  label="Run mode"
                  hint="Sent as run_mode in P101 and locked into P201, P301, and P401 for the same order."
                  error={errors.runMode}
                  required
                >
                  <Input
                    value={form.runMode}
                    onChange={(e) => updateForm("runMode", e.target.value)}
                    maxLength={32}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>

                <Field
                  label="Phase I (P101) webhook URL"
                  hint={`Saved endpoint: ${formatMaskedUrl(data.p101UrlMask)}. Leave blank to keep the saved URL.`}
                  error={errors.p101Url}
                >
                  <Input
                    type="url"
                    value={form.p101Url}
                    onChange={(e) => updateForm("p101Url", e.target.value)}
                    placeholder="https://…"
                    maxLength={2048}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={form.clearP101Url}
                  />
                </Field>
                {data.p101UrlConfigured ? (
                  <Checkbox
                    label="Remove saved Phase I (P101) webhook URL"
                    checked={form.clearP101Url}
                    onCheckedChange={(checked) => updateForm("clearP101Url", checked)}
                  />
                ) : null}

                <Field
                  label="Phase II (P201) webhook URL"
                  hint={`Saved endpoint: ${formatMaskedUrl(data.p201UrlMask)}. Leave blank to keep the saved URL.`}
                  error={errors.p201Url}
                >
                  <Input
                    type="url"
                    value={form.p201Url}
                    onChange={(e) => updateForm("p201Url", e.target.value)}
                    placeholder="https://…"
                    maxLength={2048}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={form.clearP201Url}
                  />
                </Field>
                {data.p201UrlConfigured ? (
                  <Checkbox
                    label="Remove saved Phase II (P201) webhook URL"
                    checked={form.clearP201Url}
                    onCheckedChange={(checked) => updateForm("clearP201Url", checked)}
                  />
                ) : null}

                <Field
                  label="Phase III (P301) webhook URL (optional)"
                  hint={`Saved endpoint: ${formatMaskedUrl(data.p301UrlMask)}. When configured, shows "Start Phase III" on the order Automation tab.`}
                  error={errors.p301Url}
                >
                  <Input
                    type="url"
                    value={form.p301Url}
                    onChange={(e) => updateForm("p301Url", e.target.value)}
                    placeholder="https://…"
                    maxLength={2048}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={form.clearP301Url}
                  />
                </Field>
                {data.p301UrlConfigured ? (
                  <Checkbox
                    label="Remove saved Phase III (P301) webhook URL"
                    checked={form.clearP301Url}
                    onCheckedChange={(checked) => updateForm("clearP301Url", checked)}
                  />
                ) : null}

                <Field
                  label="Phase IV (P401) webhook URL (optional)"
                  hint={`Saved endpoint: ${formatMaskedUrl(data.p401UrlMask)}. When configured, shows "Start Phase IV" on the order Automation tab.`}
                  error={errors.p401Url}
                >
                  <Input
                    type="url"
                    value={form.p401Url}
                    onChange={(e) => updateForm("p401Url", e.target.value)}
                    placeholder="https://…"
                    maxLength={2048}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={form.clearP401Url}
                  />
                </Field>
                {data.p401UrlConfigured ? (
                  <Checkbox
                    label="Remove saved Phase IV (P401) webhook URL"
                    checked={form.clearP401Url}
                    onCheckedChange={(checked) => updateForm("clearP401Url", checked)}
                  />
                ) : null}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field
                    label="Authorization header name"
                    hint="Optional custom header name (leave blank if unused)."
                    error={errors.authHeaderName}
                  >
                    <Input
                      value={form.authHeaderName}
                      onChange={(e) => updateForm("authHeaderName", e.target.value)}
                      placeholder="e.g. X-Webhook-Token"
                      maxLength={64}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>

                  <Field
                    label="Authorization header value"
                    hint={`Saved secret: ${data.authHeaderValueConfigured ? "Configured" : "Not configured"}.`}
                    error={errors.authHeaderValue}
                  >
                    <Input
                      type="password"
                      value={form.authHeaderValue}
                      onChange={(e) => updateForm("authHeaderValue", e.target.value)}
                      autoComplete="new-password"
                      maxLength={1024}
                      disabled={form.clearAuthHeaderValue}
                    />
                  </Field>
                </div>
                {data.authHeaderValueConfigured ? (
                  <Checkbox
                    label="Remove saved authorization header value"
                    checked={form.clearAuthHeaderValue}
                    onCheckedChange={(checked) =>
                      updateForm("clearAuthHeaderValue", checked)
                    }
                  />
                ) : null}

                <div className="flex flex-wrap justify-end gap-2 pt-2">
                  {draft ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setDraft(undefined);
                        setErrors({});
                      }}
                    >
                      Discard changes
                    </Button>
                  ) : null}
                  <Button type="submit" loading={saving}>
                    Save settings
                  </Button>
                </div>
              </form>
            </Card>

            <Card
              as="section"
              className="min-w-0"
              title="Destination allowlist check"
              description="Dry run only: resolves DNS and verifies the saved destination against the outbound webhook allowlist without sending an HTTP request."
            >
              <div className="flex flex-col gap-3">
                {testError ? (
                  <Callout tone="danger" live="assertive">
                    {testError}
                  </Callout>
                ) : null}

                <Button
                  variant="secondary"
                  block
                  disabled={!data.p101UrlConfigured}
                  loading={testingPhase === "P101"}
                  onClick={() => void onTestDestination("P101")}
                >
                  Test Phase I (P101) destination
                </Button>

                <Button
                  variant="secondary"
                  block
                  disabled={!data.p201UrlConfigured}
                  loading={testingPhase === "P201"}
                  onClick={() => void onTestDestination("P201")}
                >
                  Test Phase II (P201) destination
                </Button>

                <Button
                  variant="secondary"
                  block
                  disabled={!data.p301UrlConfigured}
                  loading={testingPhase === "P301"}
                  onClick={() => void onTestDestination("P301")}
                >
                  Test Phase III (P301) destination
                </Button>

                <Button
                  variant="secondary"
                  block
                  disabled={!data.p401UrlConfigured}
                  loading={testingPhase === "P401"}
                  onClick={() => void onTestDestination("P401")}
                >
                  Test Phase IV (P401) destination
                </Button>

                <Button asChild variant="ghost" size="sm">
                  <Link href="/admin/integrations/egress">Review outbound allowlist</Link>
                </Button>

                {lastTest ? (
                  <Callout
                    tone={lastTest.allowed ? "success" : "danger"}
                    live="polite"
                    title={
                      lastTest.allowed
                        ? `${PHASE_LABELS[lastTest.phase]} allowed`
                        : `${PHASE_LABELS[lastTest.phase]} blocked`
                    }
                  >
                    <p className="mb-3">{lastTest.safeMessage}</p>
                    <KeyValueList
                      columns={1}
                      items={[
                        { label: "Reason code", value: lastTest.reasonCode },
                        { label: "Host", value: lastTest.host ?? "Unavailable" },
                        {
                          label: "Resolved addresses",
                          value:
                            lastTest.resolvedAddresses.length > 0
                              ? lastTest.resolvedAddresses.join(", ")
                              : "None",
                        },
                        {
                          label: "Matched allowlist rule",
                          value: lastTest.matchedAllowlistRulePublicId ?? "None",
                        },
                        { label: "Checked", value: <DateTime value={lastTest.checkedAt} /> },
                      ]}
                    />
                  </Callout>
                ) : null}
              </div>
            </Card>
          </div>
        )}

        <Section
          title="Production dispatches"
          description="Every manual Phase I (P101), Phase II (P201), Phase III (P301), and Phase IV (P401) webhook dispatch across orders."
        >
          <div className="space-y-4">
            <FilterBar
              search={searchInput}
              onSearchChange={setSearchInput}
              onSearchSubmit={setOrderReference}
              searchLabel="Filter by order reference"
              activeCount={activeFilterCount}
              onReset={resetFilters}
            >
              <Field label="Phase">
                <Select
                  value={phaseFilter}
                  onChange={(e) => setPhaseFilter(e.target.value as "" | ProductionPhase)}
                  options={[
                    { value: "", label: "All phases" },
                    { value: "P101", label: PHASE_LABELS.P101 },
                    { value: "P201", label: PHASE_LABELS.P201 },
                    { value: "P301", label: PHASE_LABELS.P301 },
                    { value: "P401", label: PHASE_LABELS.P401 },
                  ]}
                />
              </Field>
              <Field label="State">
                <Select
                  value={stateFilter}
                  onChange={(e) =>
                    setStateFilter(e.target.value as "" | ProductionDispatchState)
                  }
                  options={[
                    { value: "", label: "All states" },
                    { value: "queued", label: DISPATCH_STATE_META.queued.label },
                    { value: "sending", label: DISPATCH_STATE_META.sending.label },
                    { value: "delivered", label: DISPATCH_STATE_META.delivered.label },
                    { value: "failed", label: DISPATCH_STATE_META.failed.label },
                    { value: "dead", label: DISPATCH_STATE_META.dead.label },
                    { value: "unknown", label: DISPATCH_STATE_META.unknown.label },
                  ]}
                />
              </Field>
              <Field label="From date">
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                />
              </Field>
              <Field label="To date">
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                />
              </Field>
            </FilterBar>

            <DataTable<ProductionDispatchItem>
              caption="Production webhook dispatches"
              rows={dispatches.data?.items}
              loading={dispatches.isPending}
              error={dispatches.error}
              onRetry={() => void dispatches.refetch()}
              rowKey={(row) => row.publicId}
              empty={
                <EmptyState
                  title="No production dispatches recorded"
                  description="Manual pipeline triggers started from an order's Automation tab appear here."
                  headingLevel={3}
                />
              }
              columns={[
                {
                  key: "order",
                  header: "Order",
                  primary: true,
                  cell: (row) => (
                    <div>
                      <Button asChild variant="link">
                        <Link href={`/admin/orders/${row.orderPublicId}/automation`}>
                          {row.orderReference}
                        </Link>
                      </Button>
                      <div className="break-all text-xs text-muted">
                        {row.identityTriple.customerId} · {row.identityTriple.runMode}
                      </div>
                    </div>
                  ),
                },
                {
                  key: "phase",
                  header: "Phase",
                  cell: (row) => (
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-ink">{PHASE_LABELS[row.phase]}</span>
                      {row.packet && row.tier ? (
                        <div className="text-xs text-muted">
                          Packet {row.packet} · {row.tier}
                        </div>
                      ) : null}
                      {row.redeliveryOf ? (
                        <div>
                          <Badge tone="info">
                            Redelivery of {shortPublicId(row.redeliveryOf)}
                          </Badge>
                        </div>
                      ) : null}
                      {row.retryOf ? (
                        <div>
                          <Badge tone="neutral">Retry of {shortPublicId(row.retryOf)}</Badge>
                        </div>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: "state",
                  header: "State",
                  cell: (row) => {
                    const meta = DISPATCH_STATE_META[row.state];
                    return (
                      <div>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        <div className="mt-1 tabular-nums text-xs text-muted">
                          Attempts: {row.attemptCount} of {row.maxAttempts}
                        </div>
                      </div>
                    );
                  },
                },
                {
                  key: "response",
                  header: "Receiver response",
                  cell: (row) => (
                    <div className="min-w-0">
                      <span className="tabular-nums text-sm text-body">
                        {row.httpStatus !== null ? `HTTP ${row.httpStatus}` : "No HTTP response"}
                      </span>
                      {row.lastReasonCode ? (
                        <div className="break-all text-xs text-muted">{row.lastReasonCode}</div>
                      ) : null}
                      {row.responseSummary ? (
                        <div className="mt-0.5 break-words text-xs text-muted">
                          {row.responseSummary}
                        </div>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: "timestamps",
                  header: "Requested",
                  cell: (row) => (
                    <div>
                      <DateTime value={row.createdAt} />
                      {row.deliveredAt ? (
                        <div className="mt-0.5 text-xs text-muted">
                          Delivered <DateTime value={row.deliveredAt} />
                        </div>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: "correlation",
                  header: "Audit trail",
                  cell: (row) => (
                    <Button asChild variant="link">
                      <Link
                        href={auditCorrelationHref(row.correlationId)}
                        aria-label={`Open audit correlation ${row.correlationId}`}
                      >
                        Audit correlation
                      </Link>
                    </Button>
                  ),
                },
              ]}
            />
          </div>
        </Section>
      </div>
    </>
  );
}
