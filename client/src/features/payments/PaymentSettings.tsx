import { KeyRound, ReceiptText, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { PaymentsConfigValue, PaymentsReceiptsValue, PaymentsSmallTotalsValue } from "@server/modules/payments/settings";
import type { PaymentsAdminSettingsView } from "@server/modules/payments/service";
import { Badge, Button, Callout, Card, Checkbox, ConfirmDialog, CopyField, Field, Input, Money, Select, Textarea } from "@/ui";
import { errorMessage } from "@/lib/trpc";

export const providerLabels = {
  none: "Pay by invoice",
  stripe: "Stripe Checkout",
  square: "Square Payment Links",
} as const;
export const providerOptions = Object.entries(providerLabels).map(([value, label]) => ({ value, label }));
const modeOptions = [{ value: "test", label: "Test / sandbox" }, { value: "live", label: "Live payments" }];
const smallTotalOptions = [
  { value: "waive", label: "Waive remaining small balance (default)" },
  { value: "block", label: "Block checkout when total is below provider minimum" },
];
type SecretKey =
  | "stripeSecretKey"
  | "stripeWebhookSecret"
  | "stripeWebhookSecretSecondary"
  | "squareAccessToken"
  | "squareWebhookSignatureKey";
const emptySecrets: Record<SecretKey, string> = {
  stripeSecretKey: "",
  stripeWebhookSecret: "",
  stripeWebhookSecretSecondary: "",
  squareAccessToken: "",
  squareWebhookSignatureKey: "",
};
type PaymentConfig = Pick<PaymentsConfigValue, "provider" | "mode" | "currency" | "successPath" | "cancelPath" | "webhookToleranceSeconds" | "squareLocationId">;
export type PaymentSettingsInput = PaymentConfig &
  Partial<Record<SecretKey, string>> & {
    clearStripeWebhookSecretSecondary?: boolean;
    smallTotals?: PaymentsSmallTotalsValue;
    receipts?: PaymentsReceiptsValue;
  };
export type PaymentSettingsView = Pick<
  PaymentsAdminSettingsView,
  "provider" | "mode" | "currency" | "successPath" | "cancelPath" | "webhookToleranceSeconds" | "onlineEnabled"
> & {
  stripe: Pick<
    PaymentsAdminSettingsView["stripe"],
    | "secretKeyConfigured"
    | "secretKeyLast4"
    | "webhookSecretConfigured"
    | "webhookSecretLast4"
    | "webhookUrl"
    | "returnUrlPattern"
    | "egressHost"
    | "egressAllowlisted"
  > &
    Partial<
      Pick<
        PaymentsAdminSettingsView["stripe"],
        | "webhookSecretSecondaryConfigured"
        | "webhookSecretSecondaryLast4"
        | "inboundCountryAllowlistExempt"
        | "requiredEvents"
        | "ready"
        | "lastApiVerifiedAt"
        | "lastVerifiedWebhookAt"
        | "lastVerifiedWebhookEventType"
        | "lastVerifiedWebhookStatus"
        | "lastSelfTestWebhookAt"
      >
    >;
  square: PaymentsAdminSettingsView["square"];
  smallTotals?: PaymentsSmallTotalsValue;
  defaultProviderMinimumsMinor?: PaymentsAdminSettingsView["defaultProviderMinimumsMinor"];
  receipts?: PaymentsReceiptsValue;
};

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
  const [clearSecondary, setClearSecondary] = useState(false);
  const [belowMinimum, setBelowMinimum] = useState<"waive" | "block">(
    settings.smallTotals?.belowProviderMinimum ?? "waive",
  );
  const [receiptsEnabled, setReceiptsEnabled] = useState<boolean>(settings.receipts?.enabled ?? true);
  const [receiptsEmail, setReceiptsEmail] = useState<boolean>(settings.receipts?.emailCustomer ?? true);
  const [receiptsFooter, setReceiptsFooter] = useState<string>(settings.receipts?.footerText ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PaymentSettingsInput | null>(null);
  const activeSettings = provider === "none" ? undefined : settings[provider];
  const normalizedUpperCurrency = currency.trim().toUpperCase() || settings.currency;
  const activeMinMinor =
    provider === "none"
      ? null
      : (settings.smallTotals?.minimumOverrides?.[provider]?.[normalizedUpperCurrency] ??
          settings.defaultProviderMinimumsMinor?.[provider]?.[normalizedUpperCurrency] ??
          (provider === "stripe" ? 50 : 100));
  const egressHost = provider === "square" && mode !== settings.mode ?
    (mode === "live" ? "connect.squareup.com" : "connect.squareupsandbox.com") : activeSettings?.egressHost;
  const egressConfirmed = provider !== "square" || mode === settings.mode;
  const changingLive = mode === "live" && provider !== "none" && (settings.mode !== "live" || settings.provider !== provider);
  const activatingTest = mode === "test" && provider !== "none" && settings.provider !== provider;
  const deactivatingToInvoice = provider === "none" && settings.provider !== "none";
  const needsConfirmation = changingLive || activatingTest || deactivatingToInvoice;
  const sameMode = settings.mode === mode;
  const newCredentialsRequired =
    provider === "stripe"
      ? !sameMode || !settings.stripe.secretKeyConfigured || !settings.stripe.webhookSecretConfigured
      : provider === "square"
        ? !sameMode || !settings.square.accessTokenConfigured || !settings.square.webhookSignatureKeyConfigured
        : false;

  async function save(input: PaymentSettingsInput) {
    setNotice(null);
    try {
      await onSave(input);
      setSecrets(emptySecrets);
      setClearSecondary(false);
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
    const requiredSecrets: readonly SecretKey[] = provider === "stripe" ? ["stripeSecretKey", "stripeWebhookSecret"] :
      provider === "square" ? ["squareAccessToken", "squareWebhookSignatureKey"] : [];
    const optionalSecrets: readonly SecretKey[] = provider === "stripe" ? ["stripeWebhookSecretSecondary"] : [];
    const input: PaymentSettingsInput = {
      provider, mode, currency: normalizedCurrency, successPath, cancelPath, webhookToleranceSeconds: seconds,
      squareLocationId: provider === "square" ? locationId.trim() : settings.square.locationId,
      smallTotals: {
        belowProviderMinimum: belowMinimum,
        ...(settings.smallTotals?.minimumOverrides ? { minimumOverrides: settings.smallTotals.minimumOverrides } : {}),
      },
      receipts: {
        enabled: receiptsEnabled,
        emailCustomer: receiptsEnabled && receiptsEmail,
        footerText: receiptsFooter.trim(),
      },
    };
    for (const name of [...requiredSecrets, ...optionalSecrets]) {
      const value = secrets[name].trim();
      if (value) input[name] = value;
    }
    if (provider === "stripe" && clearSecondary && !input.stripeWebhookSecretSecondary) {
      input.clearStripeWebhookSecretSecondary = true;
    }
    const missingRequired =
      provider === "stripe"
        ? (!sameMode && (!input.stripeSecretKey || !input.stripeWebhookSecret)) ||
          (sameMode &&
            ((!settings.stripe.secretKeyConfigured && !input.stripeSecretKey) ||
              (!settings.stripe.webhookSecretConfigured && !input.stripeWebhookSecret)))
        : provider === "square"
          ? (!sameMode && (!input.squareAccessToken || !input.squareWebhookSignatureKey)) ||
            (sameMode &&
              ((!settings.square.accessTokenConfigured && !input.squareAccessToken) ||
                (!settings.square.webhookSignatureKeyConfigured && !input.squareWebhookSignatureKey)))
          : false;
    if (missingRequired) {
      setNotice("Enter both credentials for the selected provider and environment before activating it.");
      return;
    }
    if (needsConfirmation) setConfirm(input);
    else void save(input).catch(() => {});
  }

  function keyInput(name: SecretKey, label: string, suffix: string | null, required = newCredentialsRequired) {
    return <Field label={label} required={required}
      hint={required && !sameMode ? "Enter a key issued for the selected environment." : keyHint(suffix)}>
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
            onChange={(event) => { setProvider(event.target.value as PaymentConfig["provider"]); setSecrets(emptySecrets); setClearSecondary(false); }} /></Field>
          <Field label="Environment" required><Select value={mode} options={modeOptions} disabled={saving}
            onChange={(event) => { setMode(event.target.value as PaymentConfig["mode"]); setSecrets(emptySecrets); setClearSecondary(false); }} /></Field>
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
            {keyInput(
              "stripeWebhookSecretSecondary",
              "Secondary Stripe webhook signing secret",
              settings.stripe.webhookSecretSecondaryLast4 ?? null,
              false,
            )}
            {sameMode && settings.stripe.webhookSecretSecondaryConfigured ? (
              <Checkbox
                label="Remove secondary signing secret after rotation"
                description="Retire the rollover webhook signing secret once Stripe sends events exclusively with the primary secret."
                checked={clearSecondary}
                disabled={saving || Boolean(secrets.stripeWebhookSecretSecondary.trim())}
                onCheckedChange={setClearSecondary}
              />
            ) : null}
          </> : <>
            {keyInput("squareAccessToken", "Square access token", settings.square.accessTokenLast4)}
            {keyInput("squareWebhookSignatureKey", "Square webhook signature key", settings.square.webhookSignatureKeyLast4)}
          </>}
        </fieldset> : null}
        <fieldset className="grid min-w-0 gap-4 rounded-[var(--radius-card)] border border-line bg-surface-sunken p-3 sm:p-4">
          <legend className="px-1 font-semibold text-ink">Small totals &amp; provider minimums</legend>
          <Field
            label="Totals below provider minimum"
            hint={
              activeMinMinor !== null && /^[A-Z]{3}$/u.test(normalizedUpperCurrency) ? (
                <span>
                  Current {providerLabels[provider]} minimum for {normalizedUpperCurrency}:{" "}
                  <Money value={{ amountMinor: activeMinMinor, currency: normalizedUpperCurrency }} />. Totals of $0.00 settle without calling the payment provider.
                </span>
              ) : (
                "Totals of $0.00 settle without calling a payment provider. Choose how positive balances below an online provider's minimum charge are handled."
              )
            }
          >
            <Select
              value={belowMinimum}
              options={smallTotalOptions}
              disabled={saving}
              onChange={(event) => setBelowMinimum(event.target.value as "waive" | "block")}
            />
          </Field>
        </fieldset>
        <fieldset className="grid min-w-0 gap-4 rounded-[var(--radius-card)] border border-line bg-surface-sunken p-3 sm:p-4">
          <legend className="px-1 font-semibold text-ink">
            <span className="inline-flex items-center gap-2">
              <ReceiptText className="size-4" aria-hidden />
              Payment receipts
            </span>
          </legend>
          <Checkbox
            label="Generate numbered payment receipts"
            description="Creates an immutable RPR-YYYY-NNNNNN receipt and PDF snapshot for every confirmed payment."
            checked={receiptsEnabled}
            disabled={saving}
            onCheckedChange={setReceiptsEnabled}
          />
          <Checkbox
            label="Email PDF receipt to customer automatically"
            description="Queues the branded PDF receipt to the buyer when payment is confirmed."
            checked={receiptsEnabled && receiptsEmail}
            disabled={saving || !receiptsEnabled}
            onCheckedChange={setReceiptsEmail}
          />
          <Field label="Receipt footer note" hint="Optional text included on newly generated receipt PDFs (up to 500 characters).">
            <Textarea
              value={receiptsFooter}
              disabled={saving || !receiptsEnabled}
              rows={2}
              maxLength={500}
              onChange={(event) => setReceiptsFooter(event.target.value)}
            />
          </Field>
        </fieldset>
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
    <ConfirmDialog
      title={
        confirm?.provider === "none"
          ? "Switch back to Pay by invoice?"
          : confirm?.mode === "live"
            ? "Enable live payments?"
            : `Activate ${confirm ? providerLabels[confirm.provider] : "hosted checkout"} (test mode)?`
      }
      open={confirm !== null}
      onOpenChange={(open) => {
        if (!open) setConfirm(null);
      }}
      description={
        confirm?.provider === "none"
          ? "Hosted online checkout buttons will be turned off for new customer cart checkouts and unpaid invoices. Customers will place invoice-only orders while saved provider credentials remain stored."
          : confirm?.mode === "live"
            ? "Customer cart checkouts and unpaid issued invoices will redirect buyers to the live payment provider and charge real funds. Verify outbound API connectivity and live webhooks before enabling it."
            : "Customer cart checkouts and unpaid issued invoices will offer hosted sandbox checkout instead of invoice-only settlement. Test payment methods will be accepted and no real funds will move."
      }
      confirmText={
        confirm && confirm.provider !== "none" && confirm.mode === "live"
          ? "ACTIVATE LIVE PAYMENTS"
          : undefined
      }
      confirmLabel={
        confirm?.provider === "none"
          ? "Switch to Pay by invoice"
          : confirm?.mode === "live"
            ? "Enable live payments"
            : "Activate hosted checkout"
      }
      onConfirm={async () => {
        if (confirm) await save(confirm);
      }}
    />
  </div>;
}
