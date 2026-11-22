import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { errorMessage, safeError, useTRPC, useTRPCClient } from "@/lib/trpc";
import { Button, Callout, Card, Checkbox, EmptyState, ErrorState, Field, Input, Money, PageHeader, Skeleton, Textarea } from "@/ui";
import { SafePolicyText } from "../compliance/shared";
import type { CartViewData } from "./CartPage";

const emptyBilling = {
  fullName: "", company: "", email: "", country: "", region: "", addressLine1: "", addressLine2: "",
  city: "", postalCode: "", taxId: "",
};
type Billing = typeof emptyBilling;
type Policy = CartViewData["pendingPolicies"][number];
type PolicyDraft = { accepted: boolean; signerName: string };
const emptyPolicy: PolicyDraft = { accepted: false, signerName: "" };
const policyKey = (policy: Policy) => `${policy.versionPublicId}:${policy.contentHash}`;

const billingFields: { key: keyof Billing; label: string; maxLength: number; autocomplete?: string; required?: boolean; hint?: string }[] = [
  { key: "fullName", label: "Billing name", maxLength: 160, autocomplete: "billing name", required: true },
  { key: "email", label: "Billing email", maxLength: 254, autocomplete: "billing email", required: true },
  { key: "company", label: "Company", maxLength: 160, autocomplete: "billing organization" },
  { key: "taxId", label: "Tax ID", maxLength: 64 },
  { key: "addressLine1", label: "Address line 1", maxLength: 200, autocomplete: "billing address-line1", required: true },
  { key: "addressLine2", label: "Address line 2", maxLength: 200, autocomplete: "billing address-line2" },
  { key: "city", label: "City or locality", maxLength: 120, autocomplete: "billing address-level2", required: true },
  { key: "region", label: "State, province or region", maxLength: 64, autocomplete: "billing address-level1" },
  { key: "postalCode", label: "Postal code", maxLength: 32, autocomplete: "billing postal-code", required: true },
  { key: "country", label: "Country code", maxLength: 2, autocomplete: "billing country", required: true, hint: "Two letters, such as US, CA or GB." },
];

export function isHostedCheckoutUrl(raw: string, provider: "stripe" | "square", environment: "test" | "live"): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (provider === "stripe") return url.hostname === "checkout.stripe.com" && url.pathname.startsWith("/c/pay/");
    if (url.hash) return false;
    if (environment === "live" && url.hostname === "checkout.square.site") return url.pathname.startsWith("/merchant/");
    return url.hostname === (environment === "live" ? "square.link" : "sandbox.square.link") && /^\/u\/[A-Za-z0-9_-]{1,160}$/u.test(url.pathname);
  } catch { return false; }
}

function CheckoutSummary({ cart }: { cart: CartViewData }) {
  const currency = cart.totals.currency!;
  return <Card title="Order summary">
    <ul className="divide-y divide-line">
      {cart.items.map((item) => <li key={item.itemPublicId} className="flex justify-between gap-3 py-3 text-sm">
        <span className="min-w-0 break-words">{item.name} <span className="text-muted">× {item.quantity}</span></span>
        <span className="shrink-0"><Money value={{ amountMinor: item.lineTotalMinor, currency }} /></span>
      </li>)}
    </ul>
    <dl className="mt-3 grid gap-2 border-t border-line pt-3 text-sm">
      <div className="flex justify-between gap-3"><dt>Subtotal</dt><dd><Money value={{ amountMinor: cart.totals.subtotalMinor, currency }} /></dd></div>
      {cart.totals.discountMinor > 0 ? <div className="flex justify-between gap-3"><dt>{cart.totals.discountLabel ?? "Discount"}</dt>
        <dd><Money value={{ amountMinor: -cart.totals.discountMinor, currency }} /></dd></div> : null}
      <div className="flex justify-between gap-3"><dt>Tax</dt><dd><Money value={{ amountMinor: cart.totals.taxMinor, currency }} /></dd></div>
      <div className="flex justify-between gap-3 border-t border-line pt-3 text-base font-semibold"><dt>Total</dt>
        <dd><Money value={{ amountMinor: cart.totals.totalMinor, currency }} /></dd></div>
    </dl>
  </Card>;
}

function CheckoutForm({ cart, reload }: { cart: CartViewData & { cartPublicId: string }; reload: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [projectName, setProjectName] = useState(cart.projectName);
  const [note, setNote] = useState(cart.note);
  const [billing, setBilling] = useState<Billing>(cart.billing ?? emptyBilling);
  const [policies, setPolicies] = useState<Record<string, PolicyDraft>>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ message: string; checkStatus: boolean }>();
  const request = useRef<{ version: number; key: string } | null>(null);
  const inFlight = useRef(false);
  const statusHref = `/checkout/return?cart=${encodeURIComponent(cart.cartPublicId)}`;
  const online = cart.onlinePaymentEnabled && cart.paymentProvider !== "none";

  function updatePolicy(policy: Policy, update: Partial<PolicyDraft>) {
    const key = policyKey(policy);
    setPolicies((previous) => ({ ...previous, [key]: { ...(previous[key] ?? emptyPolicy), ...update } }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (!projectName.trim() || billingFields.some((field) => field.required && !billing[field.key].trim()) ||
        !/^[A-Za-z]{2}$/u.test(billing.country.trim())) {
      setFailure({ message: "Complete the required billing and project fields. Use a two-letter country code.", checkStatus: false });
      return;
    }
    const pending = cart.pendingPolicies;
    if (pending.some((policy) => {
      const draft = policies[policyKey(policy)];
      return !draft?.accepted || (policy.requiresTypedSignature && !draft.signerName.trim());
    })) {
      setFailure({ message: "Review and accept each required policy, and sign where indicated.", checkStatus: false });
      return;
    }
    if (request.current?.version !== cart.version) request.current = { version: cart.version, key: `checkout:${crypto.randomUUID()}` };
    inFlight.current = true;
    setSubmitting(true);
    setFailure(undefined);
    try {
      const result = await client.cart.checkout.mutate({
        cartPublicId: cart.cartPublicId, expectedVersion: cart.version, projectName: projectName.trim(), note: note.trim(),
        billing: { ...billing, country: billing.country.trim().toUpperCase() },
        policyAcceptances: pending.map((policy) => ({
          versionPublicId: policy.versionPublicId, contentHash: policy.contentHash,
          ...(policy.requiresTypedSignature ? { signerName: policies[policyKey(policy)]!.signerName.trim() } : {}),
        })),
        idempotencyKey: request.current.key,
      });
      void queryClient.invalidateQueries({ queryKey: trpc.cart.badgeCount.queryKey() });
      void queryClient.invalidateQueries({ queryKey: trpc.cart.get.queryKey(), refetchType: "none" });
      if (result.mode === "redirect" && isHostedCheckoutUrl(result.redirectUrl, result.provider, result.environment)) {
        window.location.replace(result.redirectUrl);
        return;
      }
      navigate(`/checkout/return?cart=${encodeURIComponent(result.cartPublicId)}`, { replace: true });
    } catch (error) {
      const code = safeError(error);
      if (code?.reasonCode === "STALE_VERSION") {
        await reload();
        setFailure({ message: "Your cart changed. Review the refreshed details and totals before placing your order.", checkStatus: false });
      } else if (code?.reasonCode && ["POLICY_VERSION_NOT_FOUND", "POLICY_VERSION_SUPERSEDED", "POLICY_HASH_MISMATCH", "POLICY_ACCEPTANCE_REQUIRED"].includes(code.reasonCode)) {
        await reload();
        setFailure({ message: "The required policies changed. Review the refreshed versions and accept them before placing your order.", checkStatus: false });
      } else {
        setFailure({ message: errorMessage(error, "We couldn't confirm checkout. Check the order status before trying again."),
          checkStatus: !code || code.domainCode === "UNAVAILABLE" || code.domainCode === "INTERNAL" });
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return <form onSubmit={(event) => { void submit(event); }} className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
    <div className="grid min-w-0 gap-6">
      <Card title="Project details">
        <div className="grid gap-4">
          <Field label="Project name" required><Input value={projectName} onChange={(e) => setProjectName(e.target.value)} maxLength={160} required disabled={submitting} /></Field>
          <Field label="Project notes"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} rows={3} disabled={submitting} /></Field>
        </div>
      </Card>
      <Card title="Billing information" description="These details appear on your invoice.">
        <div className="grid gap-4 sm:grid-cols-2">
          {billingFields.map((field) => <Field key={field.key} label={field.label} hint={field.hint} required={field.required}>
            <Input value={billing[field.key]} onChange={(e) => setBilling((previous) => ({ ...previous, [field.key]: e.target.value }))}
              type={field.key === "email" ? "email" : "text"} maxLength={field.maxLength} autoComplete={field.autocomplete}
              autoCapitalize={field.key === "country" ? "characters" : undefined} required={field.required} disabled={submitting} />
          </Field>)}
        </div>
      </Card>
      {cart.pendingPolicies.length ? <Card title="Required policies" description="Read and accept the current versions before placing your order.">
        <div className="grid gap-5">
          {cart.pendingPolicies.map((policy) => {
            const draft = policies[policyKey(policy)] ?? emptyPolicy;
            return <div key={policyKey(policy)} className="grid gap-3 rounded-lg border border-line p-3 sm:p-4">
              <details>
                <summary className="cursor-pointer break-words font-semibold text-action">{policy.title} · Version {policy.versionNumber}</summary>
                <div className="mt-3"><SafePolicyText bodyText={policy.bodyText} format={policy.contentFormat} /></div>
              </details>
              <Checkbox label={`I have read and agree to ${policy.title} (version ${policy.versionNumber}).`}
                checked={draft.accepted} onCheckedChange={(accepted) => updatePolicy(policy, { accepted })} disabled={submitting} />
              {policy.requiresTypedSignature ? <Field label={`Type your full name to sign ${policy.title}`} hint="Use the name on your ReadyPackets profile." required>
                <Input value={draft.signerName} onChange={(e) => updatePolicy(policy, { signerName: e.target.value })} maxLength={160} required disabled={submitting} />
              </Field> : null}
            </div>;
          })}
        </div>
      </Card> : null}
    </div>
    <div className="grid min-w-0 gap-4">
      <CheckoutSummary cart={cart} />
      {online ? <Callout tone={cart.paymentEnvironment === "test" ? "warning" : "info"} title={cart.paymentEnvironment === "test" ? "Test checkout" : "Secure hosted payment"}>
        {cart.paymentEnvironment === "test" ? "This checkout uses a test environment. No real money is collected." :
          "You’ll continue to the payment provider. ReadyPackets never collects your card details."}
      </Callout> : <Callout tone="info" title="Pay by invoice">We’ll issue an invoice when you place the order. No online payment is collected now.</Callout>}
      {failure ? <Callout tone="danger" live="assertive" title="Checkout not confirmed">
        <p>{failure.message}</p>
        {failure.checkStatus ? <Link className="mt-2 inline-block text-action underline" href={statusHref}>Check order status</Link> : null}
      </Callout> : null}
      <Button type="submit" size="lg" loading={submitting} disabled={submitting}>{online ? "Place order and continue to payment" : "Place order and receive invoice"}</Button>
    </div>
  </form>;
}

export function CheckoutPage() {
  const trpc = useTRPC();
  const cart = useQuery(trpc.cart.get.queryOptions(undefined, { refetchOnMount: "always" }));
  const data = cart.data;
  return <div className="grid gap-6">
    <PageHeader title="Checkout" description="Review your order, billing information and payment options."
      actions={<Button asChild variant="secondary"><Link href="/cart">Back to cart</Link></Button>} />
    {cart.isPending ? <div role="status" aria-label="Loading checkout"><Skeleton lines={5} /></div> :
      cart.isError || !data ? <ErrorState title="Checkout could not be loaded" error={cart.error} onRetry={() => { void cart.refetch(); }} /> :
        !data.cartPublicId || !data.items.length || data.hasUnavailableItems || data.mixedCurrency || !data.totals.currency ?
          <EmptyState title="Review your cart before checking out" description="Checkout needs available items priced in the same currency."
            action={<Button asChild><Link href="/cart">Review cart</Link></Button>} /> :
          <CheckoutForm key={data.cartPublicId} cart={{ ...data, cartPublicId: data.cartPublicId }} reload={cart.refetch} />}
  </div>;
}

export default CheckoutPage;
