/** /admin/integrations/smtp — mail relay settings. The password is write-only: the server only says whether one is stored. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { safeError, useTRPC, type useTRPCClient } from "@/lib/trpc";
import { Button, Callout, Card, Checkbox, DateTime, ErrorState, Field, Input, KeyValueList, PageHeader, RadioGroup, Skeleton, Switch } from "@/ui";
import { IntegrationsCrumbs, ProviderStatusBadge, usePrivilegedAction } from "../shared";

type Client = ReturnType<typeof useTRPCClient>;
type SmtpConfig = Awaited<ReturnType<Client["integrations"]["admin"]["smtp"]["get"]["query"]>>;
type TestResult = Awaited<ReturnType<Client["integrations"]["admin"]["smtp"]["sendTest"]["mutate"]>>;
type TlsMode = "starttls" | "implicit";

interface Form {
  enabled: boolean; host: string; port: string; tlsMode: TlsMode; username: string;
  password: string; clearPassword: boolean; fromAddress: string; fromName: string; replyToAddress: string;
}
type Errors = Partial<Record<keyof Form | "form", string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function fromConfig(c: SmtpConfig): Form {
  return {
    enabled: c.enabled, host: c.host ?? "", port: c.port ? String(c.port) : "587", tlsMode: c.tlsMode ?? "starttls",
    username: c.username ?? "", password: "", clearPassword: false, fromAddress: c.fromAddress ?? "", fromName: c.fromName ?? "",
    replyToAddress: c.replyToAddress ?? "",
  };
}

const TEST_TONE = { accepted: "success", rejected: "danger", unknown: "warning" } as const;
const TEST_TITLE = { accepted: "Relay accepted the message", rejected: "Relay refused the message", unknown: "Result unknown — the relay did not confirm" } as const;
const OUTCOME_LABEL = { succeeded: "Succeeded", failed: "Failed", unknown: "Unknown (not confirmed)" } as const;

export function validateSmtp(form: Form): Errors {
  const errors: Errors = {};
  if (!HOST.test(form.host.trim())) errors.host = "Enter the relay host name, for example smtp.example.com.";
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = "Enter a port between 1 and 65535.";
  else if (port === 25) errors.port = "Port 25 is not allowed. Use 587 (STARTTLS) or 465 (implicit TLS).";
  if (!form.username.trim()) errors.username = "Enter the relay username.";
  if (!EMAIL.test(form.fromAddress.trim())) errors.fromAddress = "Enter the address mail is sent from.";
  if (!form.fromName.trim()) errors.fromName = "Enter the sender name people see.";
  if (form.replyToAddress.trim() && !EMAIL.test(form.replyToAddress.trim())) errors.replyToAddress = "Enter a valid reply-to address or leave it empty.";
  return errors;
}

export default function SmtpPage() {
  const trpc = useTRPC();
  const run = usePrivilegedAction();
  const config = useQuery(trpc.integrations.admin.smtp.get.queryOptions());
  const update = useMutation(trpc.integrations.admin.smtp.update.mutationOptions());
  const sendTest = useMutation(trpc.integrations.admin.smtp.sendTest.mutationOptions());
  const [draft, setDraft] = useState<Form>();
  // The form shows server values until edited; clearing the draft re-derives from the latest server data.
  const form = draft ?? (config.data ? fromConfig(config.data) : undefined);
  const setForm = (update: (prev: Form | undefined) => Form | undefined) => setDraft((prev) => update(prev ?? (config.data ? fromConfig(config.data) : undefined)));
  const [errors, setErrors] = useState<Errors>({});
  const [toAddress, setToAddress] = useState("");
  const [testError, setTestError] = useState<string>();
  const [lastTest, setLastTest] = useState<TestResult>();

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    const found = validateSmtp(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    // password: undefined keeps the stored secret, null clears it, a value rotates it. Never echoed back.
    const password = form.clearPassword ? null : form.password ? form.password : undefined;
    try {
      const done = await run(() => update.mutateAsync({
        enabled: form.enabled, host: form.host.trim(), port: Number(form.port), tlsMode: form.tlsMode, username: form.username.trim(),
        ...(password === undefined ? {} : { password }), fromAddress: form.fromAddress.trim(), fromName: form.fromName.trim(),
        ...(form.replyToAddress.trim() ? { replyToAddress: form.replyToAddress.trim() } : {}),
      }), "E-mail settings saved", "Changing mail settings needs verification.");
      if (done === undefined) return;
      await config.refetch();
      setDraft(undefined);
    } catch (err) {
      const safe = safeError(err);
      setErrors({ form: safe?.safeMessage ?? "The settings were not saved." });
    }
  };

  const onTest = async (event: FormEvent) => {
    event.preventDefault();
    setTestError(undefined);
    if (!EMAIL.test(toAddress.trim())) { setTestError("Enter the address that should receive the test message."); return; }
    try {
      const result = await run(() => sendTest.mutateAsync({ toAddress: toAddress.trim() }), "Test finished", "Sending a test message needs verification.");
      if (result) { setLastTest(result); void config.refetch(); }
    } catch (err) {
      setTestError(safeError(err)?.safeMessage ?? "The test could not be run.");
    }
  };

  const data = config.data;
  return (
    <>
      <PageHeader breadcrumbs={<IntegrationsCrumbs current="E-mail (SMTP)" />} title="E-mail (SMTP)"
        description="The mail relay ReadyPackets uses for sign-in codes, invitations and order notices. Saving and testing need your verification."
        meta={data ? <ProviderStatusBadge state={data.state} verified={data.verified} /> : undefined} />
      {config.error ? <ErrorState error={config.error} title="E-mail settings unavailable" onRetry={() => void config.refetch()} /> : !form || !data ? <Skeleton lines={6} /> : (
        <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
          <Card as="section" className="min-w-0 lg:col-span-2" title="Relay settings" description="Only TLS connections are used. Port 25 is not accepted.">
            <form noValidate onSubmit={(e) => void onSave(e)} className="flex flex-col gap-4" aria-label="Relay settings">
              {errors.form ? <Callout tone="danger" live="assertive">{errors.form}</Callout> : null}
              <Switch label="Send mail through this relay" description="When off, no mail is sent and messages wait in the outbox." checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="Host" required error={errors.host} className="sm:col-span-2">
                  <Input value={form.host} onChange={(e) => set("host", e.target.value)} autoComplete="off" spellCheck={false} inputMode="url" />
                </Field>
                <Field label="Port" required error={errors.port}>
                  <Input value={form.port} onChange={(e) => set("port", e.target.value)} inputMode="numeric" autoComplete="off" />
                </Field>
              </div>
              <RadioGroup legend="TLS mode" value={form.tlsMode} onValueChange={(v) => set("tlsMode", v as TlsMode)} orientation="horizontal" options={[
                { value: "starttls", label: "STARTTLS", description: "Usually port 587. The connection is upgraded to TLS before sign-in; plain fallback is refused." },
                { value: "implicit", label: "Implicit TLS", description: "Usually port 465. TLS from the first byte." },
              ]} />
              <Field label="Username" required error={errors.username}>
                <Input value={form.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Password" hint={data.passwordConfigured
                ? "A password is stored. It is never shown. Leave empty to keep it, or type a new one to replace it."
                : "No password is stored. Type one if your relay requires it."}>
                <Input type="password" value={form.password} disabled={form.clearPassword} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" />
              </Field>
              {data.passwordConfigured ? (
                <Checkbox label="Remove the stored password" checked={form.clearPassword} onCheckedChange={(v) => setForm((p) => (p ? { ...p, clearPassword: v, password: "" } : p))} />
              ) : null}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="From address" required error={errors.fromAddress}>
                  <Input type="email" value={form.fromAddress} onChange={(e) => set("fromAddress", e.target.value)} autoComplete="off" />
                </Field>
                <Field label="From name" required error={errors.fromName}>
                  <Input value={form.fromName} onChange={(e) => set("fromName", e.target.value)} autoComplete="off" />
                </Field>
              </div>
              <Field label="Reply-to address" hint="Optional." error={errors.replyToAddress}>
                <Input type="email" value={form.replyToAddress} onChange={(e) => set("replyToAddress", e.target.value)} autoComplete="off" />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={update.isPending}>Save settings</Button>
                <Button type="button" variant="secondary" onClick={() => { setDraft(undefined); setErrors({}); }}>Discard changes</Button>
              </div>
            </form>
          </Card>
          <div className="flex min-w-0 flex-col gap-6">
            <Card as="section" title="Current status">
              <KeyValueList columns={1} items={[
                { label: "Status", value: <ProviderStatusBadge state={data.state} verified={data.verified} /> },
                { label: "Last check", value: data.lastCheckedAt ? <DateTime value={data.lastCheckedAt} /> : "Never checked" },
                { label: "Last result", value: data.lastOutcome ? OUTCOME_LABEL[data.lastOutcome] : "No test yet" },
                { label: "Summary", value: data.summary || "—" },
              ]} />
            </Card>
            <Card as="section" title="Send a test message" description="Checks the saved settings by sending one message. Save changes first.">
              <form noValidate onSubmit={(e) => void onTest(e)} className="flex flex-col gap-3" aria-label="Send a test message">
                <Field label="Send to" required error={testError}>
                  <Input type="email" value={toAddress} onChange={(e) => setToAddress(e.target.value)} autoComplete="off" />
                </Field>
                <div><Button type="submit" variant="secondary" loading={sendTest.isPending} disabled={!data.configured}>Send test message</Button></div>
                {!data.configured ? <p className="text-sm text-muted">Save complete relay settings before testing.</p> : null}
              </form>
              {lastTest ? (
                <div className="mt-4" aria-live="polite">
                  <Callout tone={TEST_TONE[lastTest.outcome]} title={TEST_TITLE[lastTest.outcome]}>
                    <p>{lastTest.safeMessage}</p>
                    <p className="mt-1 text-xs">Checked <DateTime value={lastTest.checkedAt} /></p>
                  </Callout>
                </div>
              ) : null}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
