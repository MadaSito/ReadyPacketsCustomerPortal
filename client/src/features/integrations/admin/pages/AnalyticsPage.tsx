/**
 * /admin/integrations/analytics — Microsoft Clarity and PostHog. Only public, non-secret identifiers are stored here; the
 * scripts load only after visitor consent, only on allowlisted public legal pages (see consent.tsx for the enforced guarantees).
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { safeError, useTRPC, type useTRPCClient } from "@/lib/trpc";
import { Badge, Button, Callout, Card, CodeBlock, ConfirmDialog, ErrorState, Field, Input, KeyValueList, PageHeader, Select, Skeleton, Switch } from "@/ui";
import { ANALYTICS_CONSENT_COPY } from "../../consent";
import { CLARITY_PROJECT_ID, IntegrationsCrumbs, POSTHOG_PROJECT_KEY, ProviderStatusBadge, usePrivilegedAction, type ProviderRow } from "../shared";

type Client = ReturnType<typeof useTRPCClient>;
type AnalyticsConfig = Awaited<ReturnType<Client["integrations"]["admin"]["analytics"]["get"]["query"]>>;

interface Form { clarityEnabled: boolean; clarityProjectId: string; posthogEnabled: boolean; posthogProjectKey: string; posthogHost: string }
type Errors = Partial<Record<keyof Form | "form", string>>;

function fromConfig(c: AnalyticsConfig): Form {
  return {
    clarityEnabled: c.clarity.enabled, clarityProjectId: c.clarity.projectId ?? "",
    posthogEnabled: c.posthog.enabled, posthogProjectKey: c.posthog.projectKey ?? "",
    posthogHost: c.posthog.host || c.posthog.cloudHosts[0] || "",
  };
}

export function validateAnalytics(form: Form, allowedHosts: readonly string[]): Errors {
  const errors: Errors = {};
  const id = form.clarityProjectId.trim();
  if (id && !CLARITY_PROJECT_ID.test(id)) errors.clarityProjectId = "A Clarity project ID is 6–32 letters and digits, as shown in Clarity under Settings → Overview.";
  if (form.clarityEnabled && !id) errors.clarityProjectId = "Enter the project ID before switching Clarity on.";
  const key = form.posthogProjectKey.trim();
  if (key && !POSTHOG_PROJECT_KEY.test(key)) errors.posthogProjectKey = "A PostHog project API key starts with phc_. Never paste a personal API key here.";
  if (form.posthogEnabled && !key) errors.posthogProjectKey = "Enter the project API key before switching PostHog on.";
  if (form.posthogEnabled && !allowedHosts.includes(form.posthogHost)) errors.posthogHost = "Choose one of the allowed PostHog hosts.";
  return errors;
}

export default function AnalyticsPage() {
  const trpc = useTRPC();
  const run = usePrivilegedAction();
  const config = useQuery(trpc.integrations.admin.analytics.get.queryOptions());
  const providers = useQuery(trpc.integrations.admin.providers.queryOptions());
  const status = (key: "clarity" | "posthog") => providers.data?.find((p) => p.key === key);
  const update = useMutation(trpc.integrations.admin.analytics.update.mutationOptions());
  const [draft, setDraft] = useState<Form>();
  // The form shows server values until edited; clearing the draft re-derives from the latest server data.
  const form = draft ?? (config.data ? fromConfig(config.data) : undefined);
  const setForm = (update: (prev: Form | undefined) => Form | undefined) => setDraft((prev) => update(prev ?? (config.data ? fromConfig(config.data) : undefined)));
  const [errors, setErrors] = useState<Errors>({});
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  const data = config.data;
  const hosts = data ? [...data.posthog.cloudHosts, ...data.posthog.allowedSelfHostedOrigins] : [];

  const [confirming, setConfirming] = useState(false);

  /** Saves through step-up. Resolves true when saved; throws (after showing the error) so a ConfirmDialog stays open. */
  const save = async (): Promise<boolean> => {
    if (!form) return false;
    try {
      const done = await run(() => update.mutateAsync({
        clarityEnabled: form.clarityEnabled, clarityProjectId: form.clarityProjectId.trim(),
        posthogEnabled: form.posthogEnabled, posthogProjectKey: form.posthogProjectKey.trim(), posthogHost: form.posthogHost,
      }), "Analytics settings saved", "Changing analytics needs verification.");
      if (done === undefined) return false;
      await config.refetch();
      setDraft(undefined);
      return true;
    } catch (err) {
      setErrors({ form: safeError(err)?.safeMessage ?? "The settings were not saved." });
      throw err;
    }
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || !data) return;
    const found = validateAnalytics(form, hosts);
    setErrors(found);
    if (Object.keys(found).length) return;
    // Switching a vendor on (off → on) needs an explicit risk acknowledgement before step-up (INT-01).
    if ((form.clarityEnabled && !data.clarity.enabled) || (form.posthogEnabled && !data.posthog.enabled)) {
      setConfirming(true);
      return;
    }
    await save().catch(() => undefined);
  };

  const previewProvider = form?.clarityEnabled && form.posthogEnabled ? "Microsoft Clarity and PostHog" : form?.posthogEnabled ? "PostHog" : "Microsoft Clarity";

  return (
    <>
      <PageHeader breadcrumbs={<IntegrationsCrumbs current="Analytics" />} title="Analytics"
        description="Optional visitor analytics with Microsoft Clarity and PostHog, limited to public legal pages and only after the visitor agrees." />
      {config.error ? <ErrorState error={config.error} title="Analytics settings unavailable" onRetry={() => void config.refetch()} /> : !form || !data ? <Skeleton lines={6} /> : (
        <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
          <form noValidate onSubmit={(e) => void onSave(e)} className="flex min-w-0 flex-col gap-6 lg:col-span-2" aria-label="Analytics settings">
            {errors.form ? <Callout tone="danger" live="assertive">{errors.form}</Callout> : null}
            <OriginRiskWarning />
            <Card as="section" title="Microsoft Clarity" actions={<StatusFor row={status("clarity")} />} description={status("clarity")?.summary}>
              <div className="flex flex-col gap-4">
                <Field label="Clarity project ID" hint="6–32 letters and digits. This is a public identifier, not a secret." error={errors.clarityProjectId}>
                  <Input value={form.clarityProjectId} onChange={(e) => set("clarityProjectId", e.target.value)} autoComplete="off" spellCheck={false} maxLength={32} />
                </Field>
                <Switch label="Enable Microsoft Clarity" description="Loads only after consent, only on the Privacy and Terms pages, with the whole page masked from recordings." checked={form.clarityEnabled} onCheckedChange={(v) => set("clarityEnabled", v)} />
              </div>
            </Card>
            <Card as="section" title="PostHog" actions={<StatusFor row={status("posthog")} />} description={status("posthog")?.summary}>
              <div className="flex flex-col gap-4">
                <Field label="Project API key" hint="Starts with phc_. This public project key is safe in web pages; personal API keys are refused." error={errors.posthogProjectKey}>
                  <Input value={form.posthogProjectKey} onChange={(e) => set("posthogProjectKey", e.target.value)} autoComplete="off" spellCheck={false} />
                </Field>
                <Field label="PostHog host" hint="Official PostHog cloud regions, plus any self-hosted origins your operator allowed." error={errors.posthogHost}>
                  <Select value={form.posthogHost} onChange={(e) => set("posthogHost", e.target.value)} options={hosts.map((h) => ({ value: h, label: h }))} />
                </Field>
                <Switch label="Enable PostHog" description="After consent, sends one anonymous page-view per allowlisted page. No PostHog script, autocapture or session recording runs." checked={form.posthogEnabled} onCheckedChange={(v) => set("posthogEnabled", v)} />
              </div>
            </Card>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={update.isPending}>Save analytics settings</Button>
              <Button type="button" variant="secondary" onClick={() => { setDraft(undefined); setErrors({}); }}>Discard changes</Button>
            </div>
          </form>
          <div className="flex min-w-0 flex-col gap-6">
            <Card as="section" title="How visitors are protected">
              <ul className="list-disc space-y-2 pl-5 text-sm text-body">
                <li>Nothing loads until the visitor chooses “{ANALYTICS_CONSENT_COPY.allow}”. Declining or doing nothing loads nothing.</li>
                <li>Scripts never load on sign-in, security, account, payment, document or administrative screens, whatever is configured here.</li>
                <li>Only clean addresses are eligible: a page with a query string or fragment never loads analytics. Eligible pages contain no form fields.</li>
                <li>The site's content security policy only adds a vendor's origins while that vendor is switched on.</li>
              </ul>
              {data.verificationNote ? <p className="mt-3 text-sm text-muted">{data.verificationNote}</p> : null}
              <div className="mt-4">
                <KeyValueList columns={1} items={[
                  { label: "Pages where analytics may run", value: <span className="flex flex-wrap gap-1">{data.allowedPaths.map((p) => <Badge key={p} tone="info">{p}</Badge>)}</span> },
                  { label: "Always excluded", value: <span className="flex flex-wrap gap-1">{data.permanentlyExcludedPrefixes.map((p) => <Badge key={p}>{p}</Badge>)}</span> },
                ]} />
              </div>
            </Card>
            <Card as="section" title="Consent banner preview" description="What visitors see on an allowlisted page before anything loads.">
              <figure aria-label="Consent banner preview" className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
                <p className="text-sm font-semibold text-ink">{ANALYTICS_CONSENT_COPY.heading}</p>
                <p className="mt-1 text-sm text-muted">{ANALYTICS_CONSENT_COPY.body(previewProvider)}</p>
                <div className="mt-3 flex flex-wrap gap-2" aria-hidden>
                  <span className="rounded-md border border-control-border px-3 py-1 text-sm text-body">{ANALYTICS_CONSENT_COPY.decline}</span>
                  <span className="rounded-md bg-action px-3 py-1 text-sm text-on-action">{ANALYTICS_CONSENT_COPY.allow}</span>
                </div>
                <figcaption className="sr-only">Preview only. Buttons: {ANALYTICS_CONSENT_COPY.decline}, {ANALYTICS_CONSENT_COPY.allow}.</figcaption>
              </figure>
              {!form.clarityEnabled && !form.posthogEnabled ? <p className="mt-3 text-sm text-muted">Both providers are off, so visitors see no banner.</p> : null}
            </Card>
            <Card as="section" title="Exposed to browsers">
              <p className="mb-2 text-sm text-muted">Only these public identifiers are ever sent to visitors' browsers:</p>
              <CodeBlock label="Public analytics configuration" wrap>{JSON.stringify({
                clarity: { enabled: form.clarityEnabled, projectId: form.clarityEnabled ? form.clarityProjectId || null : null },
                posthog: { enabled: form.posthogEnabled, key: form.posthogEnabled ? form.posthogProjectKey || null : null, host: form.posthogEnabled ? form.posthogHost : null },
              }, null, 2)}</CodeBlock>
              <p className="mt-2 text-xs text-muted">Preview of the unsaved form. Disabled providers expose nothing.</p>
            </Card>
          </div>
        </div>
      )}
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} destructive confirmLabel="Accept risk and enable" confirmText={ENABLE_CONFIRM_TEXT}
        title="Enable analytics on the portal origin?"
        description="You will be asked to verify your identity next. This change is recorded in the audit log."
        onConfirm={async () => { const saved = await save(); if (!saved) throw new Error("not saved"); }}>
        <OriginRiskText />
      </ConfirmDialog>
    </>
  );
}

export const ENABLE_CONFIRM_TEXT = "ENABLE ANALYTICS";

/** INT-01 residual risk, stated plainly. Clarity runs vendor script on the origin; PostHog receives page views sent by portal code (no vendor script). */
function OriginRiskText() {
  return (
    <>
      <p>Vendor scripts run on this portal's origin on the Privacy and Terms pages only. Microsoft Clarity's script cannot read the session cookie, but it could make requests with a visitor's session if that visitor signs in from another tab. PostHog runs no vendor script here; the portal itself sends anonymous page views to it.</p>
      <p className="mt-2">Prefer running analytics on your public marketing site. Leave these off unless your organisation has accepted this risk.</p>
    </>
  );
}

function OriginRiskWarning() {
  return (
    <Callout tone="warning" title="Security risk: analytics runs on the portal's own origin">
      <OriginRiskText />
    </Callout>
  );
}

function StatusFor({ row }: { row: ProviderRow | undefined }) {
  return row ? <ProviderStatusBadge state={row.state} verified={row.verified} scaffoldOnly={row.scaffoldOnly} /> : null;
}
