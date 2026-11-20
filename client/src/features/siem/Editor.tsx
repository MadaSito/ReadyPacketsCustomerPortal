import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import { Breadcrumbs, Button, Callout, Card, Checkbox, ErrorState, Field, Input, KeyValueList, PageHeader, Select, Spinner, StepUpCancelledError, Textarea, useStepUp } from "@/ui";
import { BASE, CATEGORIES, categoryKeys, FORMATS, ID, SEVERITIES, type Destination, type DestinationInput, type Secrets } from "./model";

const STEPS = ["Receiver", "TLS credentials", "Filters and review"] as const;
const defaultPort = (format: Destination["format"]) => format === "otlp_https" ? "443" : "6514";

export default function Editor() {
  const [, route] = useRoute(`${BASE}/:id/edit`);
  const id = route?.id;
  const trpc = useTRPC();
  const detail = useQuery({ ...trpc.siem.admin.destinations.get.queryOptions({ publicId: id ?? "" }), enabled: Boolean(id && ID.test(id)) });
  return (
    <>
      <PageHeader title={id ? "Edit destination" : "Add destination"}
        breadcrumbs={<Breadcrumbs items={[{ label: "SIEM forwarding", href: BASE }, { label: id ? "Edit destination" : "Add destination" }]} />}
        description={id ? "Update the receiver, credentials, and audit filters." : "Configure the receiver before enabling forwarding."} />
      {!id ? <Wizard /> : !ID.test(id) ? <ErrorState title="Destination not found" />
        : detail.isPending ? <Spinner label="Loading destination" />
        : detail.isError ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        : <Wizard key={id} original={detail.data} />}
    </>
  );
}

function Wizard({ original }: { original?: Destination }) {
  const [initial] = useState(original);
  const [step, setStep] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus(), [step]);
  const [name, setName] = useState(initial?.name ?? "");
  const [format, setFormat] = useState<Destination["format"]>(initial?.format ?? "syslog_rfc5425");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial ? String(initial.port) : defaultPort(format));
  const [otlpPath, setOtlpPath] = useState(initial?.otlpPath ?? "/v1/logs");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(initial?.allowPrivateNetwork ?? false);
  const [authHeaderName, setAuthHeaderName] = useState(initial?.authHeaderName ?? "");
  const [severity, setSeverity] = useState<Destination["minSeverity"]>(initial?.minSeverity ?? "INFO");
  const [categories, setCategories] = useState<DestinationInput["categories"]>(initial ? [...initial.categories] : [...categoryKeys]);
  const [migrateBacklog, setMigrateBacklog] = useState(false);
  const [secrets, setSecrets] = useState<Secrets>({});
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState<string>();
  const [, navigate] = useLocation();
  const trpc = useTRPC();
  const api = useTRPCClient();
  const cache = useQueryClient();
  const stepUp = useStepUp();
  const otlp = format === "otlp_https";
  const numericPort = Number(port);
  const path = otlp ? otlpPath.trim() : null;
  const endpointChanged = Boolean(initial && (initial.host.toLowerCase() !== host.trim().toLowerCase() || initial.port !== numericPort || initial.format !== format || initial.otlpPath !== path));
  const editStale = Boolean(initial && original && initial.version !== original.version);
  const cert = secrets.clientCertPem;
  const key = secrets.clientKeyPem;
  const next = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    if (locked.current || editStale) return;
    if (step === 0 && (!name.trim() || !host.trim() || !/^\d{1,5}$/.test(port) || numericPort < 1 || numericPort > 65_535 || (otlp && (!path || !/^\/(?!\/)/.test(path) || /\s|[?#\\]|\.\./.test(path))))) {
      setError("Enter a destination name, hostname or IP, valid port, and an OTLP path when required.");
      return;
    }
    if (step === 1) {
      const certPresent = typeof cert === "string" ? Boolean(cert.trim()) : cert === null ? false : Boolean(initial?.secrets.hasClientCert);
      const keyPresent = typeof key === "string" ? Boolean(key.trim()) : key === null ? false : Boolean(initial?.secrets.hasClientKey);
      if (certPresent !== keyPresent) {
        setError("A client certificate and private key must be configured or removed together.");
        return;
      }
      const changed = (value: string | null | undefined) => value === null || Boolean(value?.trim());
      if (endpointChanged && ((initial?.secrets.hasClientKey && (!changed(cert) || !changed(key)))
        || (otlp && initial?.secrets.hasAuthSecret && !changed(secrets.authSecret)))) {
        setError("When changing the receiver, replace or remove its existing client credentials and OTLP authentication value.");
        return;
      }
    }
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      return;
    }
    if (categories.length === 0) {
      setError("Select at least one audit category.");
      return;
    }
    const writes: Secrets = {};
    for (const kind of ["customCaPem", "clientCertPem", "clientKeyPem", "authSecret"] as const) {
      const value = secrets[kind];
      if (kind === "authSecret" && !otlp) continue;
      if (value === null || value?.trim()) writes[kind] = value;
    }
    if (!otlp && initial?.secrets.hasAuthSecret) writes.authSecret = null;
    const input: DestinationInput = {
      name: name.trim(), format, host: host.trim(), port: numericPort, otlpPath: path, allowPrivateNetwork,
      minSeverity: severity, categories, authHeaderName: otlp ? authHeaderName.trim() || null : null,
      ...(Object.keys(writes).length > 0 ? { secrets: writes } : {}),
    };
    locked.current = true;
    setBusy(true);
    try {
      // Use the direct client so credential inputs do not persist as mutation cache variables.
      const updated = await stepUp.run(() => initial
        ? api.siem.admin.destinations.update.mutate({ ...input, publicId: initial.publicId, expectedVersion: initial.version, ...(endpointChanged ? { migrateBacklog } : {}) })
        : api.siem.admin.destinations.create.mutate({ ...input, enabled: false }),
      { reason: "Saving a SIEM destination requires verification." });
      setSecrets({});
      cache.setQueryData(trpc.siem.admin.destinations.get.queryKey({ publicId: updated.publicId }), updated);
      void cache.invalidateQueries({ queryKey: trpc.siem.admin.pathKey() });
      navigate(`${BASE}/${updated.publicId}`);
    } catch (failure) {
      if (!(failure instanceof StepUpCancelledError)) setError(errorMessage(failure, "Could not save the destination."));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const secretField = (kind: keyof Secrets, label: string, configured: boolean, maxLength: number) => {
    const value = secrets[kind];
    const set = (nextValue: string | null | undefined) => setSecrets((previous) => ({ ...previous, [kind]: nextValue }));
    return (
      <div className="space-y-1">
        <Field label={label} hint={configured ? "Configured. Leave blank to keep the saved value." : "Optional. Saved values are never shown."}>
          {kind === "authSecret"
            ? <Input type="password" autoComplete="new-password" maxLength={maxLength} value={value ?? ""} disabled={value === null} onChange={(e) => set(e.target.value)} />
            : <Textarea autoComplete="off" spellCheck={false} rows={3} maxLength={maxLength} value={value ?? ""} disabled={value === null} onChange={(e) => set(e.target.value)} />}
        </Field>
        {configured ? <Checkbox label={`Remove saved ${label.toLowerCase()}`} checked={value === null} onCheckedChange={(checked) => set(checked ? null : undefined)} /> : null}
      </div>
    );
  };
  const cancel = initial ? `${BASE}/${initial.publicId}` : BASE;
  return (
    <Card className="max-w-3xl">
      <ol aria-label="Destination setup steps" className="mb-5 flex list-none flex-wrap gap-x-4 gap-y-2 border-b border-line pb-4 text-sm text-muted">
        {STEPS.map((label, index) => <li key={label} aria-current={index === step ? "step" : undefined} className={index === step ? "font-semibold text-ink" : undefined}>{index + 1}. {label}</li>)}
      </ol>
      <h2 ref={title} tabIndex={-1} className="mb-3 text-lg font-semibold text-ink">{STEPS[step]}</h2>
      <form onSubmit={(event) => void next(event)} className="space-y-5" noValidate>
        {editStale ? <Callout tone="warning" title="Destination changed">Leave and reopen the editor to load the current configuration before saving.</Callout> : null}
        {error ? <Callout tone="danger" live="assertive" title="Destination not saved">{error}</Callout> : null}
        {step === 0 ? <>
          <Field label="Destination name" required><Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Forwarding format" required><Select value={format} options={Object.entries(FORMATS).map(([value, label]) => ({ value, label }))} onChange={(e) => {
            const nextFormat = e.target.value as Destination["format"];
            if (port === defaultPort(format)) setPort(defaultPort(nextFormat));
            if (nextFormat !== "otlp_https") {
              setAuthHeaderName("");
              setSecrets((prior) => ({ ...prior, authSecret: undefined }));
            }
            setFormat(nextFormat);
            setMigrateBacklog(false);
          }} /></Field>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,0.35fr)]">
            <Field label="Receiver host" hint="Hostname or IP only. Enter the port separately." required><Input value={host} autoCapitalize="none" spellCheck={false} maxLength={253} onChange={(e) => { setHost(e.target.value); setMigrateBacklog(false); }} /></Field>
            <Field label="Port" required><Input value={port} inputMode="numeric" maxLength={5} onChange={(e) => { setPort(e.target.value); setMigrateBacklog(false); }} /></Field>
          </div>
          {otlp ? <Field label="OTLP path" required><Input value={otlpPath} maxLength={200} onChange={(e) => { setOtlpPath(e.target.value); setMigrateBacklog(false); }} /></Field> : null}
          <Checkbox label="Allow an approved private network receiver" description="The server still requires the destination to match the installation's egress policy."
            checked={allowPrivateNetwork} onCheckedChange={setAllowPrivateNetwork} />
        </> : null}
        {step === 1 ? <>
          <Callout tone="info" title="Certificate verification is required">ReadyPackets always checks the TLS certificate chain and receiver hostname. A custom CA can establish trust for a private receiver.</Callout>
          {endpointChanged && (initial?.secrets.hasClientKey || initial?.secrets.hasAuthSecret) ? <Callout tone="warning" title="Credentials are bound to the saved receiver">Replace or remove existing receiver credentials before saving a different endpoint.</Callout> : null}
          {secretField("customCaPem", "Custom CA bundle (PEM)", Boolean(initial?.secrets.hasCustomCa), 65_536)}
          {secretField("clientCertPem", "Client certificate (PEM)", Boolean(initial?.secrets.hasClientCert), 32_768)}
          {secretField("clientKeyPem", "Client private key (PEM)", Boolean(initial?.secrets.hasClientKey), 32_768)}
          {otlp ? <>
            <Field label="OTLP authentication header" hint="Optional. Enter the HTTP header name only, such as Authorization.">
              <Input value={authHeaderName} maxLength={63} autoComplete="off" onChange={(e) => setAuthHeaderName(e.target.value)} />
            </Field>
            {secretField("authSecret", "OTLP authentication value", Boolean(initial?.secrets.hasAuthSecret), 4_096)}
          </> : null}
        </> : null}
        {step === 2 ? <>
          <KeyValueList columns={2} items={[{ label: "Destination", value: name }, { label: "Format", value: FORMATS[format] },
            { label: "Receiver", value: <span className="break-all">{host}:{port}{path}</span> }, { label: "TLS", value: "Certificate verification required" }]} />
          {initial ? null : <Callout tone="info" title="Forwarding starts paused">Save and send a test event before enabling the destination.</Callout>}
          {endpointChanged ? <Callout tone="warning" title="Receiver changed">
            The server normally quarantines queued events when the endpoint changes. Move them only if the new receiver is authorized to receive the existing backlog.
            <Checkbox label="Move queued events to the changed receiver" checked={migrateBacklog} onCheckedChange={setMigrateBacklog} />
          </Callout> : null}
          <Field label="Minimum severity" required><Select value={severity} options={SEVERITIES.map((value) => ({ value, label: value }))} onChange={(e) => setSeverity(e.target.value as Destination["minSeverity"])} /></Field>
          <fieldset>
            <legend className="mb-1 font-semibold text-ink">Audit categories</legend>
            <p className="mb-2 text-sm text-muted">Choose at least one category to forward.</p>
            <div className="grid gap-x-5 sm:grid-cols-2">
              {categoryKeys.map((category) => <Checkbox key={category} label={CATEGORIES[category]} checked={categories.includes(category)}
                onCheckedChange={(checked) => setCategories((previous) => checked ? [...previous.filter((value) => value !== category), category] : previous.filter((value) => value !== category))} />)}
            </div>
          </fieldset>
        </> : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          <Button asChild variant="ghost"><Link href={cancel}>Cancel</Link></Button>
          {step > 0 ? <Button variant="secondary" disabled={busy} onClick={() => { setError(undefined); setStep(step - 1); }}>Back</Button> : null}
          <Button type="submit" loading={busy} disabled={editStale}>{step === STEPS.length - 1 ? "Save destination" : "Continue"}</Button>
        </div>
      </form>
    </Card>
  );
}
