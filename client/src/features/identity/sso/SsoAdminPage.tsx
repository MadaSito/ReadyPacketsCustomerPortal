/**
 * /admin/sso — Microsoft Entra ID single sign-on configuration (capability identity.sso.manage).
 * Secret is write-only (configured + last 4). Saving, enabling, testing and linking need step-up.
 * Increment 07: OpenID Connect or SAML 2.0, the three-mode MFA setting (typed confirmation for "entra"),
 * allowed roles, signing certificates and app-role mappings (SamlCards).
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useSearch } from "wouter";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, Checkbox, ConfirmDialog, CopyButton, ErrorState, Field, Input, KeyValueList, PageHeader, RadioGroup, Skeleton,
  StepUpCancelledError, Switch, TagInput, Textarea, useStepUp, useToast,
} from "@/ui";
import { RoleMappingsCard, SamlCertificatesCard, SamlEntraValues, type AdminView } from "./SamlCards";
import { lastSsoTestResult } from "./SsoCompletePage";

type JitMode = AdminView["jitMode"];
type Protocol = AdminView["protocol"];
type MfaMode = AdminView["entraMfaMode"];
type Role = AdminView["allowedRoles"][number];

/** Must match the server's ENTRA_MODE_CONFIRMATION. */
const ENTRA_MODE_CONFIRMATION = "ENTRA MANAGES MFA";

const PROTOCOL_OPTIONS = [
  { value: "oidc", label: "OpenID Connect", description: "App registration with a client secret." },
  { value: "saml", label: "SAML 2.0", description: "Enterprise application with a signing certificate." },
];

const MFA_OPTIONS = [
  { value: "claim", label: "Trust Microsoft when it confirms MFA (recommended)", description: "No portal code when Microsoft reports multi-factor sign-in; otherwise the portal asks for its own factor." },
  { value: "entra", label: "Microsoft Entra ID manages MFA", description: "The portal never asks people who sign in with Microsoft for its own factor. Use only with a Conditional Access policy that requires MFA." },
  { value: "portal", label: "Always ask for the portal factor", description: "People sign in with Microsoft and then confirm with their portal authenticator." },
];

const ROLE_LABELS: Record<Role, string> = { admin: "Administrators", staff: "Staff", customer: "Customers" };

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
  const [protocol, setProtocol] = useState<Protocol>(data.protocol);
  const [entityId, setEntityId] = useState(data.saml.entityIdIsDefault ? "" : data.saml.entityId);
  const [mfaMode, setMfaMode] = useState<MfaMode>(data.entraMfaMode);
  const [contexts, setContexts] = useState<string[]>(data.acceptedAuthnContexts);
  const [roles, setRoles] = useState<Role[]>(data.allowedRoles);
  const [confirmEntra, setConfirmEntra] = useState(false);
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

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    // Switching to "entra" needs the typed confirmation first.
    if (mfaMode === "entra" && data.entraMfaMode !== "entra") setConfirmEntra(true);
    else void save();
  };

  const save = async (entraModeConfirmation?: string) => {
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
        jitMode,
        jitStaffAppRole: appRole.trim() || null,
        jitDailyLimit: Number.isInteger(days) ? days : 0,
        protocol,
        samlEntityId: entityId.trim() || null,
        entraMfaMode: mfaMode,
        ...(entraModeConfirmation ? { entraModeConfirmation } : {}),
        acceptedAuthnContexts: contexts,
        allowedRoles: roles,
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
            description={data.complete
              ? "People with a linked Microsoft account can sign in with it."
              : data.protocol === "saml" ? "Enter the tenant ID and add a trusted signing certificate first." : "Enter the tenant ID, client ID and client secret first."}
            checked={data.enabled}
            disabled={!data.complete || !data.availableInThisDeployment}
            onCheckedChange={(next) => setConfirmEnable(next)}
          />
          <KeyValueList
            columns={1}
            items={[
              { label: "Protocol", value: data.protocol === "saml" ? "SAML 2.0" : "OpenID Connect" },
              ...(data.protocol === "oidc" ? [{
                label: "Redirect URI (add to the app registration in Entra ID)",
                value: <span className="flex min-w-0 flex-wrap items-center gap-2"><code className="break-all">{data.redirectUri}</code><CopyButton value={data.redirectUri} label="Copy redirect URI" iconOnly /></span>,
              }] : []),
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

      {data.protocol === "saml" ? <SamlEntraValues data={data} /> : null}

      <Card title="Microsoft Entra ID application">
        <form className="flex flex-col gap-4" onSubmit={onSave} noValidate>
          <RadioGroup legend="Protocol" variant="cards" orientation="horizontal" options={PROTOCOL_OPTIONS} value={protocol} onValueChange={(v) => setProtocol(v as Protocol)} error={fieldErrors.protocol}
            hint="Switching cancels sign-ins in progress. Linked accounts and signed-in sessions are kept." />
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            <Field label="Directory (tenant) ID" hint="GUID from the Entra ID overview page. Multi-tenant values are not allowed." error={fieldErrors.tenantId}>
              <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} autoComplete="off" spellCheck={false} inputMode="text" />
            </Field>
            {protocol === "oidc" ? (
              <>
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
              </>
            ) : (
              <Field label="Identifier (Entity ID)" hint="Optional. Leave empty to use the default shown in Values for Microsoft Entra ID." error={fieldErrors.samlEntityId}>
                <Input value={entityId} onChange={(e) => setEntityId(e.target.value)} autoComplete="off" spellCheck={false} maxLength={255} />
              </Field>
            )}
            <Field label="Button label" hint="Optional. Default: Sign in with SSO." error={fieldErrors.buttonLabel}>
              <Input value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} maxLength={40} />
            </Field>
          </div>
          <Field label="Allowed e-mail domains" hint="Optional. One per line, e.g. contoso.com. Leave empty to allow any account in the tenant." error={fieldErrors.allowedDomains}>
            <Textarea rows={3} value={domains} onChange={(e) => setDomains(e.target.value)} spellCheck={false} />
          </Field>
          <RadioGroup legend="Multi-factor authentication for Microsoft sign-in" variant="cards" options={MFA_OPTIONS} value={mfaMode} onValueChange={(v) => setMfaMode(v as MfaMode)} error={fieldErrors.entraMfaMode}
            hint="A stricter choice signs out every Microsoft session. Local sign-in always keeps the portal factor." />
          {mfaMode !== "portal" ? (
            <Callout tone={mfaMode === "entra" ? "warning" : "info"} title="Recommended: require MFA in Entra ID">
              Create a Conditional Access policy for this application that requires multi-factor authentication for all users, and keep at least two local administrators with portal MFA for emergencies.
            </Callout>
          ) : null}
          {protocol === "saml" && mfaMode === "claim" ? (
            <TagInput
              label="Authentication contexts that prove MFA (optional)"
              hint="Microsoft's multipleauthn method always counts. Add AuthnContextClassRef values only if your tenant sends them for MFA."
              value={contexts}
              onValueChange={setContexts}
              max={10}
              maxLength={255}
              normalize={(v) => v.trim()}
              validate={(v) => (/^(urn:|https?:\/\/)\S{3,250}$/.test(v) ? null : "Enter a urn: or https:// value.")}
              error={fieldErrors.acceptedAuthnContexts}
            />
          ) : null}
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-sm font-medium text-ink">Who can use single sign-on</legend>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-6">
              {(Object.keys(ROLE_LABELS) as Role[]).map((role) => (
                <Checkbox
                  key={role}
                  label={ROLE_LABELS[role]}
                  checked={roles.includes(role)}
                  onCheckedChange={(on) => setRoles((current) => (on ? [...current, role] : current.filter((r) => r !== role)))}
                />
              ))}
            </div>
            {fieldErrors.allowedRoles ? <p className="mt-1 text-sm text-danger" role="alert">{fieldErrors.allowedRoles}</p> : null}
          </fieldset>
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

      {data.protocol === "saml" ? <SamlCertificatesCard data={data} onChanged={refetch} /> : null}
      {data.jitMode !== "off" ? <RoleMappingsCard data={data} onChanged={refetch} /> : null}

      <BindCard onChanged={refetch} />

      <ConfirmDialog
        open={confirmEntra}
        onOpenChange={setConfirmEntra}
        title="Let Microsoft Entra ID manage MFA?"
        description="People who sign in with Microsoft will never be asked for the portal factor. Only continue if a Conditional Access policy requires MFA for this application. This change is recorded in the audit log."
        confirmLabel="Confirm"
        destructive
        confirmText={ENTRA_MODE_CONFIRMATION}
        onConfirm={async () => { await save(ENTRA_MODE_CONFIRMATION); setConfirmEntra(false); }}
      />

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
          { label: "Protocol", value: result.protocol === "saml" ? "SAML 2.0" : "OpenID Connect" },
          { label: "MFA confirmed by Microsoft", value: yes(result.mfaProven ?? result.mfaClaimPresent) },
          { label: "Portal factor skipped", value: yes(result.mfaSkippedByMode) },
          { label: "Role may use single sign-on", value: yes(result.roleAllowed) },
          ...(typeof result.jitRole === "string" ? [{ label: "New account role", value: result.jitRole === "staff" ? "Staff" : "Customer" }] : []),
          { label: "E-mail domain", value: typeof result.emailDomain === "string" ? result.emailDomain : "Not provided" },
          { label: "Domain allowed", value: yes(result.domainAllowed) },
          { label: "Staff app role assigned", value: yes(result.staffRoleAssigned) },
          { label: "Linked to you", value: yes(result.linkedToYou) },
        ]}
      />
      {Array.isArray(result.claimNames) && result.claimNames.length > 0 ? (
        <div className="mt-3 min-w-0">
          <p className="text-sm font-medium text-ink">Claims received (names only)</p>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-sm">
            {result.claimNames.filter((n): n is string => typeof n === "string").map((name) => <li key={name} className="break-all"><code>{name}</code></li>)}
          </ul>
        </div>
      ) : null}
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
