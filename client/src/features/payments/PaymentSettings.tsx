import { KeyRound, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { PaymentsConfigValue } from "@server/modules/payments/settings";
import type { PaymentsAdminSettingsView } from "@server/modules/payments/service";
import { Badge, Button, Callout, Card, ConfirmDialog, CopyField, Field, Input, Select } from "@/ui";
import { errorMessage } from "@/lib/trpc";

export const providerLabels = {
  none: "Pay by invoice",
  stripe: "Stripe Checkout",
  square: "Square Payment Links",
} as const;
export const providerOptions = Object.entries(providerLabels).map(([value, label]) => ({ value, label }));
const modeOptions = [{ value: "test", label: "Test / sandbox" }, { value: "live", label: "Live payments" }];
type SecretKey = "stripeSecretKey" | "stripeWebhookSecret" | "squareAccessToken" | "squareWebhookSignatureKey";
const emptySecrets: Record<SecretKey, string> = { stripeSecretKey: "", stripeWebhookSecret: "", squareAccessToken: "", squareWebhookSignatureKey: "" };
type PaymentConfig = Pick<PaymentsConfigValue, "provider" | "mode" | "currency" | "successPath" | "cancelPath" | "webhookToleranceSeconds" | "squareLocationId">;
export type PaymentSettingsInput = PaymentConfig & Partial<Record<SecretKey, string>>;
export type PaymentSettingsView = Pick<PaymentsAdminSettingsView, "provider" | "mode" | "currency" | "successPath" | "cancelPath" |
  "webhookToleranceSeconds" | "onlineEnabled" | "stripe" | "square">;

function safePath(value: string) {
  return /^\/(?:checkout|invoices|orders)(?:\/[A-Za-z0-9_-]{1,64}){0,4}$/u.test(value) && value.length <= 200;
}
function keyHint(suffix: string | null) {
  return suffix ? `Configured (ending in ${suffix}). Leave blank to keep it.` : "Not configured. The key is never displayed after saving.";
}

export function PaymentSettings({ settings, saving, onSave }: {
  settings: PaymentSettingsView; saving: boolean; onSave: (input: PaymentSettingsInput) => Promise<void>;
}) {
  const [provider, setProvider] = useState(settings.provider);
  const [mode, setMode] = useState(settings.mode);
  const [currency, setCurrency] = useState(settings.currency);
  const [successPath, setSuccessPath] = useState(settings.successPath);
  const [cancelPath, setCancelPath] = useState(settings.cancelPath);
  const [tolerance, setTolerance] = useState(String(settings.webhookToleranceSeconds));
  const [locationId, setLocationId] = useState(settings.square.locationId ?? "");
  const [secrets, setSecrets] = useState(emptySecrets);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PaymentSettingsInput | null>(null);
  const activeSettings = provider === "none" ? undefined : settings[provider];
  const egressHost = provider === "square" && mode !== settings.mode ?
    (mode === "live" ? "connect.squareup.com" : "connect.squareupsandbox.com") : activeSettings?.egressHost;
  const egressConfirmed = provider !== "square" || mode === settings.mode;
  const changingLive = mode === "live" && provider !== "none" && (settings.mode !== "live" || settings.provider !== provider);
  const newCredentialsRequired = provider !== "none" && (settings.mode !== mode || settings.provider !== provider);

  async function save(input: PaymentSettingsInput) {
    setNotice(null);
    try {
      await onSave(input);
      setSecrets(emptySecrets);
    } catch (error) {
      setNotice(errorMessage(error, "Payment settings could not be saved."));
      throw error;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedCurrency = currency.trim().toUpperCase();
    const seconds = Number(tolerance);
    if (!/^[A-Z]{3}$/u.test(normalizedCurrency) || !safePath(successPath) || !safePath(cancelPath) ||
        !Number.isInteger(seconds) || seconds < 30 || seconds > 300 ||
        (provider === "square" && !/^[A-Za-z0-9_-]{4,64}$/u.test(locationId.trim()))) {
      setNotice("Enter a three-letter currency, valid internal return paths, a 30–300 second webhook window, and a Square location ID if using Square.");
      return;
    }
    const activeSecrets: readonly SecretKey[] = provider === "stripe" ? ["stripeSecretKey", "stripeWebhookSecret"] :
      provider === "square" ? ["squareAccessToken", "squareWebhookSignatureKey"] : [];
    const input: PaymentSettingsInput = {
      provider, mode, currency: normalizedCurrency, successPath, cancelPath, webhookToleranceSeconds: seconds,
      squareLocationId: provider === "square" ? locationId.trim() : settings.square.locationId,
    };
    for (const name of activeSecrets) {
      const value = secrets[name].trim();
      if (value) input[name] = value;
    }
    if (newCredentialsRequired && activeSecrets.some((name) => !input[name])) {
      setNotice("Enter both credentials for the selected provider and environment before activating it.");
      return;
    }
    if (changingLive) setConfirm(input);
    else void save(input).catch(() => {});
  }

  function keyInput(name: SecretKey, label: string, suffix: string | null) {
    return <Field label={label} required={newCredentialsRequired}
      hint={newCredentialsRequired ? "Enter a key issued for the selected environment." : keyHint(suffix)}>
      <Input type="password" value={secrets[name]} autoComplete="new-password" spellCheck={false} maxLength={256} disabled={saving}
        onChange={(event) => setSecrets((previous) => ({ ...previous, [name]: event.target.value }))} />
    </Field>;
  }
  return <div className="grid min-w-0 gap-5">
    <Card title={<span className="inline-flex items-center gap-2"><ShieldCheck className="size-4" aria-hidden />Checkout configuration</span>}
      description="Choose how customers pay newly issued invoices."
      actions={<Badge tone={settings.onlineEnabled ? "success" : "neutral"}>{settings.onlineEnabled ? "Hosted checkout enabled" : "Hosted checkout not active"}</Badge>}>
      <form className="grid min-w-0 gap-5" onSubmit={submit}>
        <div className="grid min-w-0 gap-4 sm:grid-cols-3">
          <Field label="Payment provider" required><Select value={provider} options={providerOptions} disabled={saving}
            onChange={(event) => { setProvider(event.target.value as PaymentConfig["provider"]); setSecrets(emptySecrets); }} /></Field>
          <Field label="Environment" required><Select value={mode} options={modeOptions} disabled={saving}
            onChange={(event) => { setMode(event.target.value as PaymentConfig["mode"]); setSecrets(emptySecrets); }} /></Field>
          <Field label="Invoice currency" hint="Three-letter ISO currency code." required><Input value={currency} disabled={saving}
            maxLength={3} autoCapitalize="characters" onChange={(event) => setCurrency(event.target.value)} /></Field>
        </div>
        {provider !== "none" ? <Callout title={mode === "live" ? "Live charges" : "Test payments only"}
          tone={mode === "live" ? "warning" : "info"}>
          {mode === "live" ? "Customers can make real payments after this change is saved. Use credentials and webhook settings for the live account." :
            "Use sandbox credentials on a staging instance with test invoices. Sandbox payments do not move real money."}
        </Callout> : <Callout title="Invoice-only payments" tone="info">No hosted payment link is offered. Customers can still receive invoices.</Callout>}
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field label="Success return path" hint="Use an internal /checkout, /invoices or /orders path." required>
            <Input value={successPath} disabled={saving} maxLength={200} onChange={(event) => setSuccessPath(event.target.value)} />
          </Field>
          <Field label="Cancel return path" hint="Return navigation never marks an invoice paid." required>
            <Input value={cancelPath} disabled={saving} maxLength={200} onChange={(event) => setCancelPath(event.target.value)} />
          </Field>
          <Field label="Webhook freshness window (seconds)" hint="Use 30 to 300 seconds." required>
            <Input type="number" inputMode="numeric" min={30} max={300} step={1} value={tolerance} disabled={saving}
              onChange={(event) => setTolerance(event.target.value)} />
          </Field>
          {provider === "square" ? <Field label="Square location ID" hint="Use the location from the selected Square environment." required>
            <Input value={locationId} disabled={saving} autoComplete="off" maxLength={64} onChange={(event) => setLocationId(event.target.value)} />
          </Field> : null}
        </div>
        {provider !== "none" ? <fieldset className="grid min-w-0 gap-4 rounded-[var(--radius-card)] border border-line bg-surface-sunken p-3 sm:p-4">
          <legend className="px-1 font-semibold text-ink"><span className="inline-flex items-center gap-2"><KeyRound className="size-4" aria-hidden />Provider credentials</span></legend>
          {provider === "stripe" ? <>
            {keyInput("stripeSecretKey", "Stripe API secret key", settings.stripe.secretKeyLast4)}
            {keyInput("stripeWebhookSecret", "Stripe webhook signing secret", settings.stripe.webhookSecretLast4)}
          </> : <>
            {keyInput("squareAccessToken", "Square access token", settings.square.accessTokenLast4)}
            {keyInput("squareWebhookSignatureKey", "Square webhook signature key", settings.square.webhookSignatureKeyLast4)}
          </>}
        </fieldset> : null}
        {notice ? <Callout title="Payment settings not saved" tone="danger" live="assertive">{notice}</Callout> : null}
        <div><Button type="submit" loading={saving} disabled={saving}>Save payment settings</Button></div>
      </form>
    </Card>
    {activeSettings ? <Card title="Provider webhook" description="Register this exact HTTPS URL with the selected provider. Only verified provider events can confirm a payment.">
      <div className="grid gap-4">
        <CopyField label="Webhook notification URL" value={activeSettings.webhookUrl} copyLabel="Copy webhook URL" monospace />
        <Callout tone={egressConfirmed && activeSettings.egressAllowlisted ? "success" : "warning"} title="Provider network access">
          <span className="break-all font-mono">{egressHost}</span>: {egressConfirmed
            ? (activeSettings.egressAllowlisted ? "Allowlist rule enabled." : "No enabled provider allowlist rule confirmed.")
            : "Verify the rule for this environment before enabling checkout."}
        </Callout>
      </div>
    </Card> : null}
    <ConfirmDialog title="Enable live payments?" open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}
      description="Customers will use the live provider to make real payments. Verify the provider account and live webhook before enabling it."
      confirmLabel="Enable live payments" onConfirm={async () => { if (confirm) await save(confirm); }} />
  </div>;
}
