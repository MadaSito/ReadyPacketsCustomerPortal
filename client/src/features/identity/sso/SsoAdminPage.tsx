/**
 * /admin/sso — Microsoft Entra ID single sign-on configuration (capability identity.sso.manage).
 * Secret is write-only (configured + last 4). Saving, enabling, testing and linking need step-up.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useSearch } from "wouter";
import { errorMessage, safeError, useTRPC, type useTRPCClient } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, ConfirmDialog, CopyButton, ErrorState, Field, Input, KeyValueList, PageHeader, RadioGroup, Skeleton,
  StepUpCancelledError, Switch, Textarea, useStepUp, useToast,
} from "@/ui";
import { lastSsoTestResult } from "./SsoCompletePage";

type AdminView = Awaited<ReturnType<ReturnType<typeof useTRPCClient>["identity"]["admin"]["sso"]["get"]["query"]>>;
type JitMode = AdminView["jitMode"];

const JIT_OPTIONS = [
  { value: "off", label: "Off", description: "Only accounts linked by the person or by an administrator can sign in." },
  { value: "customers", label: "Create customer accounts", description: "First-time Microsoft users get a customer account." },
  { value: "staff", label: "Create staff accounts", description: "Only for users assigned the app role below. Administrators are never created." },
];

const header = <PageHeader title="Single sign-on" description="Let people sign in with Microsoft Entra ID. Local sign-in with MFA always stays available for administrators." />;

export default function SsoAdminPage() {
  const trpc = useTRPC();
  const view = useQuery(trpc.identity.admin.sso.get.queryOptions());
  if (view.isPending) return <>{header}<div role="status"><span className="sr-only">Loading single sign-on settings</span><Skeleton lines={6} /></div></>;
  if (!view.data) return <>{header}<ErrorState error={view.error} onRetry={() => void view.refetch()} /></>;
  return <>{header}<SsoAdmin key={view.data.version} data={view.data} refetch={async () => void (await view.refetch())} /></>;
}

function SsoAdmin({ data, refetch }: { data: AdminView; refetch: () => Promise<void> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const search = useSearch();
  const update = useMutation(trpc.identity.admin.sso.update.mutationOptions());
  const setEnabled = useMutation(trpc.identity.admin.sso.setEnabled.mutationOptions());
  const prepare = useMutation(trpc.identity.sso.prepare.mutationOptions());
  const [tenantId, setTenantId] = useState(data.tenantId ?? "");
  const [clientId, setClientId] = useState(data.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [buttonLabel, setButtonLabel] = useState(data.buttonLabel ?? "");
  const [domains, setDomains] = useState(data.allowedDomains.join("\n"));
  const [trust, setTrust] = useState(data.trustEntraMfa);
  const [jitMode, setJitMode] = useState<JitMode>(data.jitMode);
  const [appRole, setAppRole] = useState(data.jitStaffAppRole ?? "");
  const [limit, setLimit] = useState(String(data.jitDailyLimit));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmEnable, setConfirmEnable] = useState<boolean | null>(null);
  // The completion page leaves the last test outcome in memory (never in browser storage) and returns here with ?test=done.
  const [testResult] = useState<Record<string, unknown> | null>(() =>
    new URLSearchParams(search).get("test") === "done" ? lastSsoTestResult.value : null);

  const guarded = async <T,>(action: () => Promise<T>, failure: string): Promise<T | undefined> => {
    try {
      return await stepUp.run(action);
    } catch (err) {
      if (err instanceof StepUpCancelledError) return undefined;
      toast.show({ tone: "danger", title: failure, description: errorMessage(err) });
      throw err;
    }
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setFieldErrors({});
    const days = Number(limit);
    try {
      await guarded(() => update.mutateAsync({
        expectedVersion: data.version,
        tenantId: tenantId.trim() || null,
        clientId: clientId.trim() || null,
        ...(secret ? { clientSecret: secret } : {}),
        buttonLabel: buttonLabel.trim() || null,
        allowedDomains: domains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean),
        trustEntraMfa: trust,
        jitMode,
        jitStaffAppRole: appRole.trim() || null,
        jitDailyLimit: Number.isInteger(days) ? days : 0,
      }), "Settings not saved");
      setSecret("");
      toast.show({ tone: "success", title: "Single sign-on settings saved" });
      await refetch();
    } catch (err) {
      const field = (safeError(err) as { details?: { field?: string } } | undefined)?.details?.field;
      if (field) setFieldErrors({ [field]: errorMessage(err) });
    }
  };

  const onToggle = async () => {
    if (confirmEnable === null) return;
    await guarded(() => setEnabled.mutateAsync({ enabled: confirmEnable, expectedVersion: data.version }), confirmEnable ? "Could not enable" : "Could not disable");
    toast.show({ tone: "success", title: confirmEnable ? "Single sign-on enabled" : "Single sign-on disabled" });
    await refetch();
  };

  const onTest = async () => {
    try {
      const result = await guarded(() => prepare.mutateAsync({ purpose: "test", next: "/admin/sso" }), "Could not start the test");
      if (result) window.location.assign(result.startUrl);
    } catch {
      /* toast shown */
    }
  };

  const breakGlass = data.breakGlass;
  const breakGlassWeak = breakGlass !== null && (breakGlass.localMfaAdministrators < 2 || (breakGlass.localMfaAdministrators === 1 && breakGlass.soleLocalMfaAdministratorHasPasskey === false));

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {!data.availableInThisDeployment ? <Callout tone="warning" title="Not available in this deployment">Single sign-on is turned off in the preview deployment.</Callout> : null}
      {breakGlassWeak ? (
        <Callout tone="warning" title="Keep a way back in">
          {breakGlass!.localMfaAdministrators < 2
            ? "Fewer than two administrators can sign in locally with MFA. Add another local administrator so an Entra ID outage cannot lock everyone out."
            : "The only local administrator has no passkey. Add a passkey or a second local administrator."}
        </Callout>
      ) : null}

      <Card
        title="Status"
        actions={data.enabled ? <Badge tone="success">Enabled</Badge> : <Badge tone="neutral">Disabled</Badge>}
      >
        <div className="flex flex-col gap-4">
          <Switch
            label="Show “Sign in with SSO” on the sign-in page"
            description={data.complete ? "People with a linked Microsoft account can sign in with it." : "Enter the tenant ID, client ID and client secret first."}
            checked={data.enabled}
            disabled={!data.complete || !data.availableInThisDeployment}
            onCheckedChange={(next) => setConfirmEnable(next)}
          />
          <KeyValueList
            columns={1}
            items={[
              {
                label: "Redirect URI (add to the app registration in Entra ID)",
                value: <span className="flex min-w-0 flex-wrap items-center gap-2"><code className="break-all">{data.redirectUri}</code><CopyButton value={data.redirectUri} label="Copy redirect URI" iconOnly /></span>,
              },
              { label: "Linked accounts", value: String(data.linkedAccounts) },
            ]}
          />
          <div>
            <Button variant="secondary" onClick={() => void onTest()} disabled={!data.complete || !data.availableInThisDeployment} loading={prepare.isPending}>Test sign-in</Button>
            <p className="mt-2 text-sm text-muted">Signs in to Microsoft and checks the response without linking or signing anyone in.</p>
          </div>
          {testResult ? <TestResult result={testResult} /> : null}
        </div>
      </Card>

      <Card title="Microsoft Entra ID application">
        <form className="flex flex-col gap-4" onSubmit={(e) => void onSave(e)} noValidate>
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            <Field label="Directory (tenant) ID" hint="GUID from the Entra ID overview page. Multi-tenant values are not allowed." error={fieldErrors.tenantId}>
              <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} autoComplete="off" spellCheck={false} inputMode="text" />
            </Field>
            <Field label="Application (client) ID" hint="GUID of the app registration." error={fieldErrors.clientId}>
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            <Field
              label="Client secret"
              hint={data.clientSecret.configured ? `A secret ending in ${data.clientSecret.last4 ?? "····"} is stored. Leave blank to keep it.` : "Paste the secret's Value (not its ID). It is stored encrypted and never shown again."}
              error={fieldErrors.clientSecret}
            >
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" spellCheck={false} />
            </Field>
            <Field label="Button label" hint="Optional. Default: Sign in with SSO." error={fieldErrors.buttonLabel}>
              <Input value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} maxLength={40} />
            </Field>
          </div>
          <Field label="Allowed e-mail domains" hint="Optional. One per line, e.g. contoso.com. Leave empty to allow any account in the tenant." error={fieldErrors.allowedDomains}>
            <Textarea rows={3} value={domains} onChange={(e) => setDomains(e.target.value)} spellCheck={false} />
          </Field>
          <Switch
            label="Trust Microsoft multi-factor authentication"
            description="When Microsoft confirms MFA, people are not asked for the portal authenticator. Turning this off signs out every Microsoft session."
            checked={trust}
            onCheckedChange={setTrust}
          />
          <RadioGroup legend="Create accounts on first sign-in" options={JIT_OPTIONS} value={jitMode} onValueChange={(v) => setJitMode(v as JitMode)} error={fieldErrors.jitMode} />
          {jitMode !== "off" ? (
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              {jitMode === "staff" ? (
                <Field label="Staff app role value" required hint="The app role value assigned in Entra ID, e.g. Portal.Staff." error={fieldErrors.jitStaffAppRole}>
                  <Input value={appRole} onChange={(e) => setAppRole(e.target.value)} spellCheck={false} />
                </Field>
              ) : null}
              <Field label="New accounts per day" hint="1–500. Further sign-ins are refused until the next day." error={fieldErrors.jitDailyLimit}>
                <Input type="number" min={1} max={500} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} />
              </Field>
            </div>
          ) : null}
          <div><Button type="submit" loading={update.isPending}>Save settings</Button></div>
        </form>
      </Card>

      <BindCard onChanged={refetch} />

      <ConfirmDialog
        open={confirmEnable !== null}
        onOpenChange={(open) => { if (!open) setConfirmEnable(null); }}
        title={confirmEnable ? "Enable single sign-on?" : "Disable single sign-on?"}
        description={confirmEnable
          ? "The “Sign in with SSO” button appears on the sign-in page. Local sign-in with MFA stays available."
          : "Microsoft sign-in stops immediately. Pending sign-in attempts are cancelled."}
        confirmLabel={confirmEnable ? "Enable" : "Disable"}
        destructive={confirmEnable === false}
        onConfirm={onToggle}
      />
    </div>
  );
}

function TestResult({ result }: { result: Record<string, unknown> }) {
  const yes = (v: unknown) => (v === true ? <Badge tone="success">Yes</Badge> : <Badge tone="warning">No</Badge>);
  return (
    <Callout tone="success" title="Test sign-in completed" live="polite">
      <KeyValueList
        columns={2}
        items={[
          { label: "Signature, tenant and audience", value: yes(result.signatureVerified === true && result.tenantMatches === true && result.audienceMatches === true) },
          { label: "MFA confirmed by Microsoft", value: yes(result.mfaClaimPresent) },
          { label: "E-mail domain", value: typeof result.emailDomain === "string" ? result.emailDomain : "Not provided" },
          { label: "Domain allowed", value: yes(result.domainAllowed) },
          { label: "Staff app role assigned", value: yes(result.staffRoleAssigned) },
          { label: "Linked to you", value: yes(result.linkedToYou) },
        ]}
      />
    </Callout>
  );
}

function BindCard({ onChanged }: { onChanged: () => Promise<void> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const stepUp = useStepUp();
  const bind = useMutation(trpc.identity.admin.sso.bindUser.mutationOptions());
  const unbind = useMutation(trpc.identity.admin.sso.unbindUser.mutationOptions());
  const [userId, setUserId] = useState("");
  const [objectId, setObjectId] = useState("");
  const [error, setError] = useState<string>();
  const [confirmUnbind, setConfirmUnbind] = useState(false);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setError(undefined);
    try {
      await stepUp.run(action);
      toast.show({ tone: "success", title: success });
      await onChanged();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setError(errorMessage(err));
      throw err;
    }
  };

  return (
    <Card title="Link an account" description="Link a portal account to a Microsoft account by its object ID. The link becomes active after that person's first Microsoft sign-in.">
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => bind.mutateAsync({ userId: userId.trim(), objectId: objectId.trim() }), "Account linked — waiting for first sign-in").catch(() => {});
        }}
      >
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <Field label="Portal user ID" hint="The account ID (26 characters) at the end of the customer page address.">
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Microsoft object ID" hint="Object ID (GUID) from the user's Entra ID profile.">
            <Input value={objectId} onChange={(e) => setObjectId(e.target.value)} spellCheck={false} autoComplete="off" />
          </Field>
        </div>
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" loading={bind.isPending} disabled={!userId.trim() || !objectId.trim()}>Link account</Button>
          <Button type="button" variant="secondary" disabled={!userId.trim()} onClick={() => setConfirmUnbind(true)}>Remove link</Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirmUnbind}
        onOpenChange={setConfirmUnbind}
        title="Remove this Microsoft link?"
        description="The person's Microsoft sessions are signed out. Accounts without a password can no longer sign in until a password is set."
        confirmLabel="Remove link"
        destructive
        onConfirm={() => run(() => unbind.mutateAsync({ userId: userId.trim() }), "Link removed")}
      />
    </Card>
  );
}
