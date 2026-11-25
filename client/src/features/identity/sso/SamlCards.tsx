/**
 * SAML 2.0 (increment 07, D10) parts of /admin/sso: Entra values to copy, signing certificates (metadata URL,
 * metadata file or PEM), and app-role mappings. Every mutation needs step-up and returns the refreshed view.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, useTRPC, type useTRPCClient } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, ConfirmDialog, CopyField, DateTime, Field, FileDropzone, Input, Select, StepUpCancelledError, Textarea,
  useStepUp, useToast,
} from "@/ui";

export type AdminView = Awaited<ReturnType<ReturnType<typeof useTRPCClient>["identity"]["admin"]["sso"]["get"]["query"]>>;
type Certificate = AdminView["saml"]["certificates"][number];
type MappedRole = AdminView["roleMappings"][number]["role"];

const CLAIM_LABELS: Record<string, string> = {
  "http://schemas.microsoft.com/identity/claims/objectidentifier": "Object ID (objectidentifier)",
  "http://schemas.microsoft.com/identity/claims/tenantid": "Tenant ID (tenantid)",
  "http://schemas.microsoft.com/claims/authnmethodsreferences": "Authentication methods (authnmethodsreferences)",
};

const CERT_STATE: Record<Certificate["state"], { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  trusted: { label: "Trusted", tone: "success" },
  not_yet_valid: { label: "Not yet valid", tone: "warning" },
  expired: { label: "Expired", tone: "danger" },
  retired: { label: "Retired", tone: "neutral" },
};

function useGuarded() {
  const stepUp = useStepUp();
  const toast = useToast();
  return async (action: () => Promise<unknown>, success: string, onError: (message: string) => void) => {
    try {
      await stepUp.run(action);
      toast.show({ tone: "success", title: success });
      return true;
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) onError(errorMessage(err));
      return false;
    }
  };
}

/** Values the administrator copies into the Entra "Basic SAML Configuration" and claims pages. */
export function SamlEntraValues({ data }: { data: AdminView }) {
  const saml = data.saml;
  return (
    <Card title="Values for Microsoft Entra ID" description="Enterprise application → Single sign-on → SAML → Basic SAML Configuration.">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <CopyField label="Identifier (Entity ID)" value={saml.entityId} monospace hint={saml.entityIdIsDefault ? "Default value. You can change it in the settings below." : "Custom value from the settings below."} />
          <CopyField label="Reply URL (Assertion Consumer Service URL)" value={saml.acsUrl} monospace />
          <CopyField label="Sign on URL" value={saml.signOnUrl} monospace />
          <CopyField label="Service provider metadata URL" value={saml.metadataUrl} monospace hint="Available while SAML is the selected protocol." />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-ink">Required claims</h3>
          <p className="mt-1 text-sm text-muted">Keep these claims in Attributes &amp; Claims. E-mail, name and roles are optional.</p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm">
            {saml.requiredClaims.map((claim) => (
              <li key={claim} className="min-w-0 break-words"><span>{CLAIM_LABELS[claim] ?? claim}</span> <code className="break-all text-muted">{claim}</code></li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

/** Entra signing certificates: import metadata (URL or file), paste a PEM, retire. */
export function SamlCertificatesCard({ data, onChanged }: { data: AdminView; onChanged: () => Promise<void> }) {
  const trpc = useTRPC();
  const guarded = useGuarded();
  const importMetadata = useMutation(trpc.identity.admin.sso.saml.importMetadata.mutationOptions());
  const addCertificate = useMutation(trpc.identity.admin.sso.saml.addCertificate.mutationOptions());
  const retire = useMutation(trpc.identity.admin.sso.saml.retireCertificate.mutationOptions());
  const [url, setUrl] = useState(data.saml.metadataSourceUrl ?? "");
  const [pem, setPem] = useState("");
  const [error, setError] = useState<string>();
  const [retiring, setRetiring] = useState<Certificate | null>(null);
  const saml = data.saml;
  const trusted = saml.certificates.filter((c) => c.state === "trusted").length;

  const run = async (action: () => Promise<unknown>, success: string) => {
    setError(undefined);
    if (await guarded(action, success, setError)) await onChanged();
  };
  const onFile = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    const xml = await file.text();
    await run(() => importMetadata.mutateAsync({ expectedVersion: data.version, xml }), "Federation metadata imported");
  };

  return (
    <Card title="Entra signing certificates" description="Responses are accepted only when signed by a trusted certificate (SHA-256 or stronger).">
      <div className="flex min-w-0 flex-col gap-5">
        {trusted === 0 ? <Callout tone="warning" title="No trusted certificate">Import the federation metadata or add the certificate before enabling SAML sign-in.</Callout> : null}
        <form
          className="flex min-w-0 flex-col gap-3"
          noValidate
          onSubmit={(e) => { e.preventDefault(); void run(() => importMetadata.mutateAsync({ expectedVersion: data.version, url: url.trim() }), "Federation metadata imported"); }}
        >
          <Field label="App Federation Metadata Url" hint="From the SAML Certificates section in Entra. Only login.microsoftonline.com addresses for your tenant are accepted. It is checked daily for certificate rollover.">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" inputMode="url" />
          </Field>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button type="submit" loading={importMetadata.isPending} disabled={!url.trim()}>Import from URL</Button>
            {saml.metadataRefreshedAt ? (
              <p className="text-sm text-muted">Last checked <DateTime value={saml.metadataRefreshedAt} format="relative" />{saml.metadataStatus && saml.metadataStatus !== "OK" ? ` (${saml.metadataStatus.toLowerCase().replace(/_/g, " ")})` : ""}</p>
            ) : null}
          </div>
        </form>
        <FileDropzone label="Or upload the Federation Metadata XML file" hint="XML file, up to 512 KB." accept=".xml,application/xml,text/xml" maxSize={512 * 1024} onFiles={(files) => void onFile(files)} disabled={importMetadata.isPending} />
        <form
          className="flex min-w-0 flex-col gap-3"
          noValidate
          onSubmit={(e) => { e.preventDefault(); void run(() => addCertificate.mutateAsync({ expectedVersion: data.version, pem }), "Certificate added").then(() => setPem("")); }}
        >
          <Field label="Or paste the certificate (Base64)" hint="The Certificate (Base64) download from Entra, including the BEGIN and END lines.">
            <Textarea rows={4} value={pem} onChange={(e) => setPem(e.target.value)} spellCheck={false} className="font-mono" />
          </Field>
          <div><Button type="submit" variant="secondary" loading={addCertificate.isPending} disabled={pem.trim().length < 100}>Add certificate</Button></div>
        </form>
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        {saml.certificates.length > 0 ? (
          <ul className="flex min-w-0 flex-col divide-y divide-border rounded-md border border-border" aria-label="Certificates">
            {saml.certificates.map((cert) => (
              <li key={cert.id} className="flex min-w-0 flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    <span className="break-all">{cert.subject || "Entra signing certificate"}</span>
                    <Badge tone={CERT_STATE[cert.state].tone}>{CERT_STATE[cert.state].label}</Badge>
                  </p>
                  <p className="mt-1 text-sm text-muted">Expires <DateTime value={cert.notAfter} format="date" /> · {cert.source === "metadata" ? "From metadata" : "Added manually"}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted">SHA-256 {cert.fingerprintSha256}</p>
                </div>
                {cert.state !== "retired" ? (
                  <Button variant="secondary" size="sm" onClick={() => setRetiring(cert)}>Retire</Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <ConfirmDialog
        open={retiring !== null}
        onOpenChange={(open) => { if (!open) setRetiring(null); }}
        title="Retire this certificate?"
        description="Responses signed with it are refused from now on. If it is the only trusted certificate, SAML sign-in stops working."
        confirmLabel="Retire"
        destructive
        onConfirm={async () => {
          const cert = retiring;
          if (cert) await run(() => retire.mutateAsync({ expectedVersion: data.version, certificateId: cert.id }), "Certificate retired");
          setRetiring(null);
        }}
      />
    </Card>
  );
}

const ROLE_OPTIONS = [
  { value: "staff", label: "Staff" },
  { value: "customer", label: "Customer" },
];

/** Entra app-role value → portal role for first-time accounts. Administrators are never created. */
export function RoleMappingsCard({ data, onChanged }: { data: AdminView; onChanged: () => Promise<void> }) {
  const trpc = useTRPC();
  const guarded = useGuarded();
  const save = useMutation(trpc.identity.admin.sso.roleMappings.set.mutationOptions());
  const [rows, setRows] = useState(() => data.roleMappings.map((m) => ({ ...m })));
  const [error, setError] = useState<string>();
  const set = (index: number, patch: Partial<{ appRoleValue: string; role: MappedRole }>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <Card title="App role mappings" description="Which portal role a first-time Microsoft user gets, by the Entra app role assigned to them. Administrators are never created this way.">
      <form
        className="flex min-w-0 flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setError(undefined);
          const mappings = rows.map((r) => ({ appRoleValue: r.appRoleValue.trim(), role: r.role })).filter((r) => r.appRoleValue);
          void guarded(() => save.mutateAsync({ expectedVersion: data.version, mappings }), "Role mappings saved", setError).then((ok) => (ok ? onChanged() : undefined));
        }}
      >
        {rows.length === 0 ? <p className="text-sm text-muted">No mappings. The staff app role in the settings above still applies.</p> : null}
        {rows.map((row, index) => (
          <div key={index} className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] sm:items-end">
            <Field label={`App role value ${index + 1}`}>
              <Input value={row.appRoleValue} onChange={(e) => set(index, { appRoleValue: e.target.value })} spellCheck={false} maxLength={120} />
            </Field>
            <Field label={`Portal role ${index + 1}`}>
              <Select options={ROLE_OPTIONS} value={row.role} onChange={(e) => set(index, { role: e.target.value as MappedRole })} />
            </Field>
            <Button type="button" variant="ghost" onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>
              Remove<span className="sr-only"> mapping {index + 1}</span>
            </Button>
          </div>
        ))}
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="secondary" disabled={rows.length >= 20} onClick={() => setRows((current) => [...current, { appRoleValue: "", role: "staff" }])}>Add mapping</Button>
          <Button type="submit" loading={save.isPending}>Save mappings</Button>
        </div>
      </form>
    </Card>
  );
}
