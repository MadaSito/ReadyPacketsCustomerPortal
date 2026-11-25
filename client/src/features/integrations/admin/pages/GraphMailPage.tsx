/**
 * /admin/integrations/graph — Microsoft Graph mail, outbound preset readiness, SharePoint Sites.Selected
 * write check, and Entra least-privilege runbook. Client secret is write-only and never echoed back.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, ExternalLink, XCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { safeError, useTRPC, type useTRPCClient } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  CodeBlock,
  DateTime,
  ErrorState,
  Field,
  Input,
  KeyValueList,
  PageHeader,
  Skeleton,
  Switch,
  buttonClasses,
} from "@/ui";
import {
  INTEGRATION_PATHS,
  IntegrationsCrumbs,
  ProviderStatusBadge,
  providerStatus,
  usePrivilegedAction,
} from "../shared";

type Client = ReturnType<typeof useTRPCClient>;
type GraphConfig = Awaited<ReturnType<Client["integrations"]["admin"]["graph"]["get"]["query"]>>;
type ConnectionResult = Awaited<ReturnType<Client["integrations"]["admin"]["graph"]["testConnection"]["mutate"]>>;
type MailTestResult = Awaited<ReturnType<Client["integrations"]["admin"]["graph"]["sendTest"]["mutate"]>>;
type SitesSelectedResult = Awaited<
  ReturnType<Client["integrations"]["admin"]["graph"]["verifySitesSelectedWrite"]["mutate"]>
>;

interface Form {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  clearSecret: boolean;
  senderMailbox: string;
  enableEgressPreset: boolean;
}
type Errors = Partial<Record<keyof Form | "form", string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fromConfig(c: GraphConfig): Form {
  return {
    enabled: c.enabled,
    tenantId: c.tenantId ?? "",
    clientId: c.clientId ?? "",
    clientSecret: "",
    clearSecret: false,
    senderMailbox: c.senderMailbox ?? "",
    enableEgressPreset: false,
  };
}

export function validateGraph(form: Form): Errors {
  const errors: Errors = {};
  if (!form.tenantId.trim()) errors.tenantId = "Enter the Microsoft Entra tenant ID or verified domain.";
  if (!form.clientId.trim()) errors.clientId = "Enter the Entra application (client) ID.";
  if (form.senderMailbox.trim() && !EMAIL.test(form.senderMailbox.trim())) {
    errors.senderMailbox = "Enter a valid sender mailbox address, or leave empty if only using SharePoint sync.";
  }
  return errors;
}

const MAIL_TEST_TONE = { accepted: "success", rejected: "danger", unknown: "warning" } as const;
const MAIL_TEST_TITLE = {
  accepted: "Microsoft Graph accepted the test message",
  rejected: "Microsoft Graph refused the test message",
  unknown: "Result unknown — Microsoft Graph did not confirm",
} as const;
const OUTCOME_LABEL = {
  succeeded: "Succeeded",
  failed: "Failed",
  unknown: "Unknown (not confirmed)",
} as const;

export default function GraphMailPage() {
  const trpc = useTRPC();
  const run = usePrivilegedAction();
  const config = useQuery(trpc.integrations.admin.graph.get.queryOptions());
  const runbook = useQuery(trpc.integrations.admin.graph.entraRunbook.queryOptions());
  const update = useMutation(trpc.integrations.admin.graph.update.mutationOptions());
  const testConnection = useMutation(trpc.integrations.admin.graph.testConnection.mutationOptions());
  const sendTest = useMutation(trpc.integrations.admin.graph.sendTest.mutationOptions());
  const verifyWrite = useMutation(trpc.integrations.admin.graph.verifySitesSelectedWrite.mutationOptions());

  const [draft, setDraft] = useState<Form>();
  const form = draft ?? (config.data ? fromConfig(config.data) : undefined);
  const setForm = (updater: (prev: Form | undefined) => Form | undefined) =>
    setDraft((prev) => updater(prev ?? (config.data ? fromConfig(config.data) : undefined)));
  const [errors, setErrors] = useState<Errors>({});

  const [connResult, setConnResult] = useState<ConnectionResult>();
  const [connError, setConnError] = useState<string>();

  const [toAddress, setToAddress] = useState("");
  const [mailError, setMailError] = useState<string>();
  const [mailResult, setMailResult] = useState<MailTestResult>();

  const [siteUrlOrId, setSiteUrlOrId] = useState("");
  const [driveId, setDriveId] = useState("");
  const [probeFolderPath, setProbeFolderPath] = useState("");
  const [probeError, setProbeError] = useState<string>();
  const [probeResult, setProbeResult] = useState<SitesSelectedResult>();

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    const found = validateGraph(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    const clientSecret = form.clearSecret ? null : form.clientSecret ? form.clientSecret : undefined;
    try {
      const done = await run(
        () =>
          update.mutateAsync({
            enabled: form.enabled,
            tenantId: form.tenantId.trim(),
            clientId: form.clientId.trim(),
            ...(clientSecret === undefined ? {} : { clientSecret }),
            ...(form.senderMailbox.trim() ? { senderMailbox: form.senderMailbox.trim() } : {}),
            ...(form.enableEgressPreset ? { enableEgressPreset: true } : {}),
          }),
        "Microsoft Graph settings saved",
        "Changing Microsoft Graph settings needs verification.",
      );
      if (done === undefined) return;
      await config.refetch();
      setDraft(undefined);
    } catch (err) {
      setErrors({ form: safeError(err)?.safeMessage ?? "The settings were not saved." });
    }
  };

  const onTestConnection = async () => {
    setConnError(undefined);
    try {
      const res = await run(
        () => testConnection.mutateAsync({}),
        "Connection check finished",
        "Testing the Microsoft Graph connection needs verification.",
      );
      if (res) {
        setConnResult(res);
        void config.refetch();
      }
    } catch (err) {
      setConnError(safeError(err)?.safeMessage ?? "The connection check could not be run.");
    }
  };

  const onSendTest = async (event: FormEvent) => {
    event.preventDefault();
    setMailError(undefined);
    if (!EMAIL.test(toAddress.trim())) {
      setMailError("Enter the e-mail address that should receive the test message.");
      return;
    }
    try {
      const res = await run(
        () => sendTest.mutateAsync({ toAddress: toAddress.trim() }),
        "Test message finished",
        "Sending a test message through Microsoft Graph needs verification.",
      );
      if (res) {
        setMailResult(res);
        void config.refetch();
      }
    } catch (err) {
      setMailError(safeError(err)?.safeMessage ?? "The test message could not be sent.");
    }
  };

  const onVerifyWrite = async (event: FormEvent) => {
    event.preventDefault();
    setProbeError(undefined);
    const trimmedSite = siteUrlOrId.trim();
    const trimmedDrive = driveId.trim();
    const trimmedFolder = probeFolderPath.trim();
    if (trimmedSite && trimmedSite.length < 3) {
      setProbeError("Enter at least 3 characters for the SharePoint site URL or ID, or leave it blank.");
      return;
    }
    if (trimmedDrive && trimmedDrive.length < 3) {
      setProbeError("Enter at least 3 characters for the document library drive ID, or leave it blank.");
      return;
    }
    try {
      const res = await run(
        () =>
          verifyWrite.mutateAsync({
            ...(trimmedSite ? { siteUrlOrId: trimmedSite } : {}),
            ...(trimmedDrive ? { driveId: trimmedDrive } : {}),
            ...(trimmedFolder ? { probeFolderPath: trimmedFolder } : {}),
          }),
        "Sites.Selected write check finished",
        "Verifying SharePoint Sites.Selected write access needs verification.",
      );
      if (res) {
        setProbeResult(res);
        void config.refetch();
      }
    } catch (err) {
      setProbeError(safeError(err)?.safeMessage ?? "The SharePoint write check could not be run.");
    }
  };

  const data = config.data;
  const uploadPresetEnabled = Boolean(data?.uploadEgressPresetEnabled);

  return (
    <>
      <PageHeader
        breadcrumbs={<IntegrationsCrumbs current="Microsoft Graph & SharePoint" />}
        title="Microsoft Graph & SharePoint"
        description="Single-tenant Microsoft Entra application credentials for Graph mail delivery, cloud connectivity, and SharePoint Sites.Selected upload readiness."
        meta={
          data ? (
            <span
              className="inline-flex min-w-0 max-w-full [&>span]:min-w-0"
              title={providerStatus({ state: data.state, verified: data.verified }).label}
            >
              <ProviderStatusBadge state={data.state} verified={data.verified} />
            </span>
          ) : undefined
        }
      />

      {config.error ? (
        <ErrorState
          error={config.error}
          title="Microsoft Graph settings unavailable"
          onRetry={() => void config.refetch()}
        />
      ) : !form || !data ? (
        <Skeleton lines={6} />
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          <Card
            as="section"
            className="min-w-0"
            title="Outbound preset readiness"
            description="Every connection to Microsoft Entra, Graph, and SharePoint upload sessions must pass the outbound allowlist over HTTPS port 443."
            footer={
              <Link href={INTEGRATION_PATHS.egress} className={buttonClasses("secondary", "sm")}>
                Review outbound presets <ExternalLink className="size-3.5" aria-hidden />
              </Link>
            }
          >
            <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5 rounded-[var(--radius-control)] border border-line bg-surface-sunken p-3">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 text-sm font-semibold wrap-anywhere text-ink">
                    Microsoft Graph & Entra Token
                  </span>
                  <PresetBadge enabled={data.egressPresetEnabled} />
                </div>
                <p className="text-xs wrap-anywhere text-muted">
                  Hosts: <code className="break-all">login.microsoftonline.com</code> and{" "}
                  <code className="break-all">graph.microsoft.com</code> (HTTPS:443). Required for
                  token acquisition, mail delivery, and SharePoint API calls.
                </p>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5 rounded-[var(--radius-control)] border border-line bg-surface-sunken p-3">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 text-sm font-semibold wrap-anywhere text-ink">
                    SharePoint & OneDrive Upload Sessions
                  </span>
                  <PresetBadge enabled={uploadPresetEnabled} />
                </div>
                <p className="text-xs wrap-anywhere text-muted">
                  Hosts: <code className="break-all">*.sharepoint.com</code> and{" "}
                  <code className="break-all">*.files.1drv.com</code> (HTTPS:443). Required for
                  large-file resumable upload sessions and the Sites.Selected write probe.
                </p>
              </div>
            </div>
          </Card>

          <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
            <Card
              as="section"
              className="min-w-0 lg:col-span-2"
              title="Application credentials & sender mailbox"
              description="Client credentials are encrypted at rest. Rotating or clearing the client secret immediately isolates cached OAuth tokens."
            >
              <form
                noValidate
                onSubmit={(e) => void onSave(e)}
                className="flex min-w-0 flex-col gap-4"
                aria-label="Application credentials & sender mailbox"
              >
                {errors.form ? (
                  <Callout tone="danger" live="assertive">
                    <p className="wrap-anywhere">{errors.form}</p>
                  </Callout>
                ) : null}
                <Switch
                  className="min-w-0"
                  label={<span className="wrap-anywhere">Enable Microsoft Graph mail & cloud API</span>}
                  description="When off, Graph mail and cloud probes remain paused until switched on."
                  checked={form.enabled}
                  onCheckedChange={(v) => set("enabled", v)}
                />
                <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Tenant ID" required error={errors.tenantId}>
                    <Input
                      value={form.tenantId}
                      onChange={(e) => set("tenantId", e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="Application (client) ID" required error={errors.clientId}>
                    <Input
                      value={form.clientId}
                      onChange={(e) => set("clientId", e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                </div>
                <Field
                  label="Client secret"
                  hint={
                    data.clientSecretConfigured
                      ? `A client secret is stored${data.clientSecretLast4 ? ` (ending ••••${data.clientSecretLast4})` : ""}. It is never shown. Leave empty to keep it, or type a new value to rotate it.`
                      : "No client secret is stored. Paste the Entra client secret value."
                  }
                >
                  <Input
                    type="password"
                    value={form.clientSecret}
                    disabled={form.clearSecret}
                    onChange={(e) => set("clientSecret", e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
                {data.clientSecretConfigured ? (
                  <Checkbox
                    label="Remove the stored client secret"
                    checked={form.clearSecret}
                    onCheckedChange={(v) =>
                      setForm((p) => (p ? { ...p, clearSecret: v, clientSecret: "" } : p))
                    }
                  />
                ) : null}
                <Field
                  label="Sender mailbox"
                  hint={data.mailboxRestrictionNote || "Exchange Online mailbox used for application sendMail."}
                  error={errors.senderMailbox}
                >
                  <Input
                    type="email"
                    value={form.senderMailbox}
                    onChange={(e) => set("senderMailbox", e.target.value)}
                    autoComplete="off"
                  />
                </Field>
                {!data.egressPresetEnabled ? (
                  <Checkbox
                    label="Also enable the Microsoft Graph & Entra Token outbound preset on save"
                    checked={form.enableEgressPreset}
                    onCheckedChange={(v) => set("enableEgressPreset", v)}
                  />
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={update.isPending}>
                    Save Graph settings
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setDraft(undefined);
                      setErrors({});
                    }}
                  >
                    Discard changes
                  </Button>
                </div>
              </form>
            </Card>

            <Card
              as="section"
              className="min-w-0"
              title="Connection & test message"
              description="Verify OAuth token acquisition and send a real test message from the configured sender mailbox."
            >
              <div className="flex min-w-0 flex-col gap-4">
                <KeyValueList
                  items={[
                    {
                      label: "Last checked",
                      value: data.lastCheckedAt ? <DateTime value={data.lastCheckedAt} /> : "Never",
                    },
                    {
                      label: "Last outcome",
                      value: data.lastOutcome ? OUTCOME_LABEL[data.lastOutcome] : "No check run yet",
                    },
                  ]}
                />
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    loading={testConnection.isPending}
                    onClick={() => void onTestConnection()}
                  >
                    Test Graph connection
                  </Button>
                </div>
                {connError ? (
                  <Callout tone="danger" live="assertive">
                    <p className="wrap-anywhere">{connError}</p>
                  </Callout>
                ) : null}
                {connResult ? (
                  <Callout
                    tone={connResult.outcome === "succeeded" ? "success" : "danger"}
                    title={
                      connResult.outcome === "succeeded"
                        ? "Graph connection verified"
                        : "Graph connection failed"
                    }
                    live="polite"
                  >
                    <p className="wrap-anywhere">{connResult.safeMessage}</p>
                    <p className="mt-1 text-xs wrap-anywhere text-muted">
                      Reason: <code className="break-all">{connResult.reasonCode}</code> · Completed
                      in {connResult.durationMs} ms.
                    </p>
                  </Callout>
                ) : null}

                <form
                  noValidate
                  onSubmit={(e) => void onSendTest(e)}
                  className="flex min-w-0 flex-col gap-3 border-t border-line pt-4"
                  aria-label="Send test message"
                >
                  <Field label="Send test mail to" required error={mailError}>
                    <Input
                      type="email"
                      value={toAddress}
                      onChange={(e) => setToAddress(e.target.value)}
                      autoComplete="email"
                    />
                  </Field>
                  <div>
                    <Button type="submit" variant="secondary" loading={sendTest.isPending}>
                      Send test message
                    </Button>
                  </div>
                </form>
                {mailResult ? (
                  <Callout
                    tone={MAIL_TEST_TONE[mailResult.outcome]}
                    title={MAIL_TEST_TITLE[mailResult.outcome]}
                    live="polite"
                  >
                    <p className="wrap-anywhere">{mailResult.safeMessage}</p>
                    <p className="mt-1 text-xs wrap-anywhere text-muted">
                      Recipient: <span className="break-all">{mailResult.recipientAddress}</span> ·
                      Completed in {mailResult.durationMs} ms.
                    </p>
                  </Callout>
                ) : null}
              </div>
            </Card>
          </div>

          <Card
            as="section"
            className="min-w-0"
            title="SharePoint Sites.Selected write check"
            description="Verifies OAuth token acquisition, site/library read access, and resumable upload-session write permission. The probe opens an upload session and immediately cancels it with HTTP DELETE so zero marker files remain in SharePoint."
          >
            <div className="flex min-w-0 flex-col gap-4">
              <KeyValueList
                items={[
                  {
                    label: "Last write check",
                    value: data.sitesSelectedLastCheckedAt ? (
                      <DateTime value={data.sitesSelectedLastCheckedAt} />
                    ) : (
                      "Never"
                    ),
                  },
                  {
                    label: "Last write check outcome",
                    value: data.sitesSelectedLastOutcome
                      ? OUTCOME_LABEL[data.sitesSelectedLastOutcome]
                      : "No write check run yet",
                  },
                ]}
              />

              <form
                noValidate
                onSubmit={(e) => void onVerifyWrite(e)}
                className="flex min-w-0 flex-col gap-4"
                aria-label="SharePoint Sites.Selected write check"
              >
                {probeError ? (
                  <Callout tone="danger" live="assertive">
                    <p className="wrap-anywhere">{probeError}</p>
                  </Callout>
                ) : null}
                <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-3">
                  <Field
                    label="SharePoint site URL or Graph site ID"
                    hint="Optional — defaults to configured storage site when omitted."
                  >
                    <Input
                      value={siteUrlOrId}
                      onChange={(e) => setSiteUrlOrId(e.target.value)}
                      placeholder="https://contoso.sharepoint.com/sites/orders"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field
                    label="Document library drive ID"
                    hint="Optional — resolves the site's default document library when omitted."
                  >
                    <Input
                      value={driveId}
                      onChange={(e) => setDriveId(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field
                    label="Probe folder path"
                    hint="Optional — defaults to .readypackets-probe."
                  >
                    <Input
                      value={probeFolderPath}
                      onChange={(e) => setProbeFolderPath(e.target.value)}
                      placeholder=".readypackets-probe"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                </div>
                <div>
                  <Button type="submit" variant="secondary" loading={verifyWrite.isPending}>
                    Run Sites.Selected write check
                  </Button>
                </div>
              </form>

              {probeResult ? (
                <div className="flex min-w-0 flex-col gap-3">
                  <Callout
                    tone={probeResult.outcome === "succeeded" ? "success" : "danger"}
                    title={
                      probeResult.outcome === "succeeded"
                        ? "Sites.Selected read and upload-session write verified"
                        : "Sites.Selected write check did not pass"
                    }
                    live="polite"
                  >
                    <p className="wrap-anywhere">{probeResult.safeMessage}</p>
                    <p className="mt-1 text-xs wrap-anywhere text-muted">
                      Reason: <code className="break-all">{probeResult.reasonCode}</code> · Completed
                      in {probeResult.durationMs} ms at <DateTime value={probeResult.checkedAt} />.
                    </p>
                  </Callout>
                  <div className="flex min-w-0 flex-wrap gap-2" aria-label="Write check stages">
                    <StageBadge ok={probeResult.graphEgressEnabled} label="Graph egress" />
                    <StageBadge ok={probeResult.uploadEgressEnabled} label="Upload session egress" />
                    <StageBadge ok={probeResult.tokenAcquired} label="Entra token" />
                    <StageBadge ok={probeResult.readVerified} label="Drive read" />
                    <StageBadge ok={probeResult.writeVerified} label="Upload session + DELETE" />
                  </div>
                </div>
              ) : null}
            </div>
          </Card>

          <Card
            as="section"
            className="min-w-0"
            title="Entra Sites.Selected runbook"
            description="Grant least-privilege site-scoped write access instead of tenant-wide SharePoint or OneDrive permissions."
          >
            {runbook.error ? (
              <ErrorState
                error={runbook.error}
                title="Entra runbook unavailable"
                onRetry={() => void runbook.refetch()}
              />
            ) : !runbook.data ? (
              <Skeleton lines={4} />
            ) : (
              <div className="flex min-w-0 flex-col gap-4">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-sm font-medium wrap-anywhere text-ink">
                    Required application permission:
                  </span>
                  <span
                    className="inline-flex min-w-0 max-w-full"
                    title={runbook.data.requiredApplicationPermission}
                  >
                    <Badge className="min-w-0" tone="success">
                      {runbook.data.requiredApplicationPermission}
                    </Badge>
                  </span>
                  {runbook.data.discouragedBroadPermissions.length > 0 ? (
                    <>
                      <span className="text-sm font-medium wrap-anywhere text-ink">
                        Avoid broad permissions:
                      </span>
                      {runbook.data.discouragedBroadPermissions.map((perm) => (
                        <span key={perm} className="inline-flex min-w-0 max-w-full" title={perm}>
                          <Badge className="min-w-0" tone="warning">
                            {perm}
                          </Badge>
                        </span>
                      ))}
                    </>
                  ) : null}
                </div>

                <ol className="min-w-0 list-decimal space-y-1.5 pl-5 text-sm wrap-anywhere text-body">
                  {runbook.data.steps.map((step, idx) => (
                    <li key={idx} className="wrap-anywhere">
                      {step}
                    </li>
                  ))}
                </ol>

                <Callout tone="info" title="OneDrive & site scope note">
                  <p className="wrap-anywhere">{runbook.data.oneDriveNote}</p>
                </Callout>

                <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <h3 className="text-sm font-semibold wrap-anywhere text-ink">
                      Graph site permission endpoint
                    </h3>
                    <CodeBlock label="Graph site permission endpoint" language="HTTP" copyable wrap>
                      {runbook.data.siteGrantEndpointTemplate}
                    </CodeBlock>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <h3 className="text-sm font-semibold wrap-anywhere text-ink">
                      Grant payload example
                    </h3>
                    <CodeBlock label="Grant payload example" language="JSON" copyable wrap>
                      {runbook.data.siteGrantPayloadExample}
                    </CodeBlock>
                  </div>
                </div>

                <div className="flex min-w-0 flex-col gap-1.5">
                  <h3 className="text-sm font-semibold wrap-anywhere text-ink">
                    PnP / Microsoft Graph PowerShell example
                  </h3>
                  <CodeBlock label="PowerShell site grant example" language="PowerShell" copyable wrap>
                    {runbook.data.powershellExample}
                  </CodeBlock>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function PresetBadge({ enabled }: { enabled: boolean }) {
  const label = enabled ? "Enabled" : "Switched off";
  return (
    <span className="inline-flex min-w-0 max-w-full" title={label}>
      {enabled ? (
        <Badge className="min-w-0" tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden />}>
          {label}
        </Badge>
      ) : (
        <Badge className="min-w-0" tone="warning" icon={<CircleDashed className="size-3.5" aria-hidden />}>
          {label}
        </Badge>
      )}
    </span>
  );
}

function StageBadge({ ok, label }: { ok: boolean; label: string }) {
  const text = ok ? `${label}: passed` : `${label}: not passed`;
  return (
    <span className="inline-flex min-w-0 max-w-full" title={text}>
      {ok ? (
        <Badge className="min-w-0" tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden />}>
          {text}
        </Badge>
      ) : (
        <Badge className="min-w-0" tone="danger" icon={<XCircle className="size-3.5" aria-hidden />}>
          {text}
        </Badge>
      )}
    </span>
  );
}
