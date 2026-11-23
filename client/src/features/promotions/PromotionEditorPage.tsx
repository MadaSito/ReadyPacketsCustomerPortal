/**
 * /admin/promotions/new and /admin/promotions/:promotionId/edit — every control of contract D3. Owner: audit engineer.
 * Client checks are for fast, specific feedback; the server validates everything again (and decides).
 * After creation the code is shown once (masked, with Show) together with its link; it can be revealed again later.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { errorMessage, safeError } from "@/lib/trpc";
import { Breadcrumbs, Button, Callout, Card, Checkbox, CopyButton, CopyField, ErrorState, Field, Input, PageHeader, RadioGroup, Select, Skeleton, StepUpCancelledError, TagInput, Textarea, useStepUp } from "@/ui";
import { usePromotionsApi } from "./api";
import { BATCH_MAX, LIMITS_ANCHOR, ZERO_FIXED_MESSAGE, PROMO_TIER_KEYS, emptyForm, formatPercentBps, formFromView, toUpdateInput, validateForm, type FormErrors, type PolicyLimits, type PromotionFormState, type PromotionView } from "./model";
import { BASE } from "./parts";
import { promoLink } from "./savedCode";

const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD"].map((c) => ({ value: c, label: c }));
const ERROR_ORDER: Array<keyof PromotionFormState> = ["name", "label", "percent", "maxDiscount", "fixedAmount", "setTotal", "currency", "scopeProducts", "scopeTiers", "scopePackets", "minSubtotal", "startsAt", "endsAt", "maxRedemptions", "maxPerCustomer", "allowDomains", "note", "code", "batchCount", "batchPrefix"];
const fieldId = (k: keyof PromotionFormState) => `promo-${k}`;
/** Focus the control itself when the id sits on a wrapper (tag inputs). */
function focusField(k: keyof PromotionFormState) {
  const el = document.getElementById(fieldId(k));
  const target = el && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) ? el.querySelector<HTMLElement>("input, textarea, select") ?? el : el;
  target?.focus();
}

export default function PromotionEditorPage() {
  const { promotionId } = useParams<{ promotionId?: string }>();
  const api = usePromotionsApi();
  const existing = useQuery({ ...api.get.queryOptions({ publicId: promotionId ?? "" }), enabled: promotionId !== undefined });
  const settings = useQuery(api.getSettings.queryOptions(undefined));
  const editing = promotionId !== undefined;
  const title = editing ? "Edit discount code" : "New discount code";
  const header = (
    <PageHeader
      breadcrumbs={<Breadcrumbs items={[{ label: "Console", href: "/admin" }, { label: "Discount codes", href: BASE }, { label: editing ? "Edit" : "New" }]} />}
      title={title}
      description="Customers see the label on the cart, order and invoice. The code itself is never shown to them after entry."
    />
  );
  if (editing && existing.isPending) return <>{header}<Skeleton className="h-64" /></>;
  if (editing && existing.error) return <>{header}<ErrorState error={existing.error} title="Could not load this discount code" onRetry={() => void existing.refetch()} /></>;
  return (
    <>
      {header}
      <PromotionForm key={existing.data?.publicId ?? "new"} existing={existing.data} limits={settings.data} />
    </>
  );
}

function PromotionForm({ existing, limits }: { existing: PromotionView | undefined; limits: PolicyLimits | undefined }) {
  const maxDiscountPercent = limits?.maxDiscountPercent;
  const api = usePromotionsApi();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const [, navigate] = useLocation();
  const create = useMutation(api.create.mutationOptions());
  const update = useMutation(api.update.mutationOptions());
  const [f, setF] = useState<PromotionFormState>(() => (existing ? formFromView(existing) : emptyForm()));
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ promotion: PromotionView; code: string | null; generated: number } | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const creating = existing === undefined;
  const set = <K extends keyof PromotionFormState>(key: K, value: PromotionFormState[K]) => setF((prev) => ({ ...prev, [key]: value }));
  const err = (k: keyof PromotionFormState) => errors[k];
  const focusSummary = () => requestAnimationFrame(() => summaryRef.current?.focus());

  const submit = async () => {
    const { errors: found, input } = validateForm(f, { creating, ...(limits ?? {}) });
    setErrors(found);
    setServerError(null);
    if (!input) { focusSummary(); return; }
    try {
      if (creating) {
        const out = await stepUp.run(() => create.mutateAsync(input), { reason: "Creating a discount code requires a fresh confirmation." });
        await qc.invalidateQueries(api.list.pathFilter());
        setCreated({ promotion: out.promotion, code: out.initialCode, generated: out.generatedCount });
      } else {
        const saved = await stepUp.run(() => update.mutateAsync(toUpdateInput(input, existing)), { reason: "Changing a discount code requires a fresh confirmation." });
        await qc.invalidateQueries(api.list.pathFilter());
        await qc.invalidateQueries(api.get.pathFilter());
        navigate(`${BASE}/${saved.publicId}`);
      }
    } catch (e) {
      if (e instanceof StepUpCancelledError) return;
      const reason = safeError(e)?.reasonCode;
      if (reason === "LABEL_MATCHES_CODE") setErrors({ label: "The label customers see must not be the code itself." });
      if (reason === "PROMO_ZERO_FIXED_USE_SET_TOTAL") setErrors({ fixedAmount: ZERO_FIXED_MESSAGE });
      setServerError(errorMessage(e));
      focusSummary();
    }
  };

  if (created) return <CreatedPanel {...created} />;

  const listed = ERROR_ORDER.filter((k) => errors[k]);
  const percentLocked = !creating;
  return (
    <form className="space-y-6" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div ref={summaryRef} tabIndex={-1} className="outline-none">
        {listed.length > 0 || serverError ? (
          <Callout tone="danger" title={listed.length > 0 ? `Check ${listed.length === 1 ? "1 field" : `${listed.length} fields`}` : "Not saved"} live="assertive">
            {serverError ? <p>{serverError}</p> : null}
            {listed.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5">
                {listed.map((k) => <li key={k}><button type="button" className="inline-flex min-h-6 items-center text-left underline underline-offset-2" onClick={() => focusField(k)}>{errors[k]}</button></li>)}
              </ul>
            ) : null}
          </Callout>
        ) : null}
      </div>

      <Card title="Basics" headingLevel={2}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Internal name" hint="Only staff see this." error={err("name")} required id={fieldId("name")}>
            <Input value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={120} autoComplete="off" />
          </Field>
          <Field label="Label customers see" hint="Shown on the cart, order and invoice, e.g. Spring offer." error={err("label")} required id={fieldId("label")}>
            <Input value={f.label} onChange={(e) => set("label", e.target.value)} maxLength={120} autoComplete="off" />
          </Field>
          <Field label="Note" hint="Optional, staff only. Up to 500 characters." error={err("note")} id={fieldId("note")} className="md:col-span-2">
            <Textarea value={f.note} onChange={(e) => set("note", e.target.value)} maxLength={500} rows={2} />
          </Field>
        </div>
      </Card>

      <Card title="Discount" headingLevel={2} description={percentLocked ? "The type and amount cannot be changed after creation. Create a new code instead." : undefined}>
        <div className="space-y-4">
          <RadioGroup
            legend="Type"
            orientation="horizontal"
            value={f.discountType}
            onValueChange={(v) => set("discountType", v as PromotionFormState["discountType"])}
            options={[
              { value: "percent", label: "Percentage", disabled: percentLocked },
              { value: "fixed", label: "Fixed amount", disabled: percentLocked },
              { value: "set_total", label: "Set order total to", disabled: percentLocked },
            ]}
          />
          {f.discountType === "set_total" && !percentLocked ? (
            <Callout tone="info" title="Codes that can make an order free">
              A total of 0.00 makes eligible orders free. Creating such a code asks you to confirm your identity, and the store-wide <Link href={`${BASE}#${LIMITS_ANCHOR}`} className="font-medium underline underline-offset-2">Limits</Link> still apply.
            </Callout>
          ) : null}
          <div className="grid gap-4 md:grid-cols-3">
            {f.discountType === "percent" ? (
              <>
                <Field label="Percentage off" hint={maxDiscountPercent !== undefined ? `0.01 to ${formatPercentBps(Math.round(maxDiscountPercent * 100))}, up to two decimals (largest discount per order).` : "0.01 to 100, up to two decimals, e.g. 99.99."} error={err("percent")} required id={fieldId("percent")}>
                  <Input inputMode="decimal" value={f.percent} onChange={(e) => set("percent", e.target.value)} maxLength={6} disabled={percentLocked} />
                </Field>
                <Field label="Largest amount off" hint="Optional cap, e.g. 25.00." error={err("maxDiscount")} id={fieldId("maxDiscount")}>
                  <Input inputMode="decimal" value={f.maxDiscount} onChange={(e) => set("maxDiscount", e.target.value)} maxLength={12} />
                </Field>
              </>
            ) : f.discountType === "fixed" ? (
              <Field label="Amount off" hint="More than 0.00, e.g. 10.00. To make orders free, choose “Set order total to”." error={err("fixedAmount")} required id={fieldId("fixedAmount")}>
                <Input inputMode="decimal" value={f.fixedAmount} onChange={(e) => set("fixedAmount", e.target.value)} maxLength={12} disabled={percentLocked} />
              </Field>
            ) : (
              <Field label="Order total" hint="The eligible order total becomes this amount: 0.00 (free), 0.01, or any amount up to the cart total." error={err("setTotal")} required id={fieldId("setTotal")}>
                <Input inputMode="decimal" value={f.setTotal} onChange={(e) => set("setTotal", e.target.value)} maxLength={12} disabled={percentLocked} />
              </Field>
            )}
            <Field label="Currency" error={err("currency")} id={fieldId("currency")}>
              <Select value={f.currency} onChange={(e) => set("currency", e.target.value)} options={CURRENCIES} disabled={percentLocked} />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Applies to" headingLevel={2}>
        <div className="space-y-4">
          <RadioGroup
            legend="Eligible items"
            value={f.scopeKind}
            onValueChange={(v) => set("scopeKind", v as PromotionFormState["scopeKind"])}
            options={[
              { value: "all", label: "Everything in the order" },
              { value: "products", label: "Selected products", description: "Use product IDs from Products." },
              { value: "tiers", label: "Selected tiers" },
              { value: "packets", label: "Selected packet sizes" },
            ]}
          />
          {f.scopeKind === "products" ? <div id={fieldId("scopeProducts")} tabIndex={-1}><TagInput label="Product IDs" value={f.scopeProducts} onValueChange={(v) => set("scopeProducts", v)} max={200} maxLength={26} normalize={(t) => t.trim().toUpperCase()} error={err("scopeProducts")} /></div> : null}
          {f.scopeKind === "tiers" ? (
            <fieldset id={fieldId("scopeTiers")} className="space-y-2" aria-describedby={err("scopeTiers") ? `${fieldId("scopeTiers")}-error` : undefined}>
              <legend className="text-sm font-medium text-ink">Tiers</legend>
              {PROMO_TIER_KEYS.map((tier) => (
                <Checkbox key={tier} label={tier} checked={f.scopeTiers.includes(tier)} onCheckedChange={(on) => set("scopeTiers", on ? [...f.scopeTiers, tier] : f.scopeTiers.filter((t) => t !== tier))} />
              ))}
              {err("scopeTiers") ? <p id={`${fieldId("scopeTiers")}-error`} className="text-sm text-danger">{err("scopeTiers")}</p> : null}
            </fieldset>
          ) : null}
          {f.scopeKind === "packets" ? <div id={fieldId("scopePackets")} tabIndex={-1}><TagInput label="Packet sizes" hint="Whole numbers, e.g. 25." value={f.scopePackets} onValueChange={(v) => set("scopePackets", v)} max={50} maxLength={6} validate={(t) => (/^\d{1,6}$/u.test(t) && Number(t) > 0 ? null : "Use a whole number.")} error={err("scopePackets")} /></div> : null}
        </div>
      </Card>

      <Card title="Conditions and limits" headingLevel={2}>
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Minimum subtotal" hint="Optional, e.g. 50.00." error={err("minSubtotal")} id={fieldId("minSubtotal")}>
              <Input inputMode="decimal" value={f.minSubtotal} onChange={(e) => set("minSubtotal", e.target.value)} maxLength={12} />
            </Field>
            <div className="hidden md:block" aria-hidden="true" />
            <Field label="Starts" hint="Optional. Your local time." error={err("startsAt")} id={fieldId("startsAt")}>
              <Input type="datetime-local" value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} />
            </Field>
            <Field label="Ends" hint="Optional. Your local time." error={err("endsAt")} id={fieldId("endsAt")}>
              <Input type="datetime-local" value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} />
            </Field>
            <Field label="Total uses" hint="Optional. Leave empty for no limit." error={err("maxRedemptions")} id={fieldId("maxRedemptions")}>
              <Input inputMode="numeric" value={f.maxRedemptions} onChange={(e) => set("maxRedemptions", e.target.value)} maxLength={7} />
            </Field>
            <Field label="Uses per customer" error={err("maxPerCustomer")} required id={fieldId("maxPerCustomer")}>
              <Input inputMode="numeric" value={f.maxPerCustomer} onChange={(e) => set("maxPerCustomer", e.target.value)} maxLength={7} />
            </Field>
          </div>
          <Checkbox label="First order only" description="Only customers without an earlier order can use it." checked={f.firstOrderOnly} onCheckedChange={(v) => set("firstOrderOnly", v)} />
          <Checkbox label="Can be combined with a bundle discount" description="When off, the larger of the two applies, never both." checked={f.combineWithBundle} onCheckedChange={(v) => set("combineWithBundle", v)} />
          <TagInput label="Only these customers" hint="Optional. Customer IDs; leave empty for everyone." value={f.allowCustomers} onValueChange={(v) => set("allowCustomers", v)} max={500} maxLength={26} normalize={(t) => t.trim().toUpperCase()} />
          <div id={fieldId("allowDomains")} tabIndex={-1}>
            <TagInput label="Only these e-mail domains" hint="Optional, e.g. example.com. Customers need a verified e-mail address." value={f.allowDomains} onValueChange={(v) => set("allowDomains", v)} max={100} maxLength={253} error={err("allowDomains")} />
          </div>
        </div>
      </Card>

      {creating ? (
        <Card title="Code" headingLevel={2}>
          <div className="space-y-4">
            <RadioGroup
              legend="How customers get it"
              value={f.codeMode}
              onValueChange={(v) => set("codeMode", v as PromotionFormState["codeMode"])}
              options={[
                { value: "chosen", label: "One code I choose", description: "Everyone uses the same code, e.g. SPRING-24." },
                { value: "generated", label: "One generated code", description: "The server creates a random code." },
                { value: "batch", label: "Many single-use codes", description: `Up to ${BATCH_MAX.toLocaleString("en-US")} random codes, each usable once.` },
              ]}
            />
            {f.codeMode === "chosen" ? (
              <Field label="Code" hint="6 to 32 letters, digits or hyphens. Saved in capitals." error={err("code")} required id={fieldId("code")}>
                <Input className="ph-no-capture font-mono uppercase" data-clarity-mask="true" value={f.code} onChange={(e) => set("code", e.target.value.trim().toUpperCase())} maxLength={32} autoComplete="off" spellCheck={false} autoCapitalize="characters" />
              </Field>
            ) : null}
            {f.codeMode === "batch" ? (
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Number of codes" hint={`1 to ${BATCH_MAX.toLocaleString("en-US")}.`} error={err("batchCount")} required id={fieldId("batchCount")}>
                  <Input inputMode="numeric" value={f.batchCount} onChange={(e) => set("batchCount", e.target.value)} maxLength={4} />
                </Field>
                <Field label="Prefix" hint="Optional, 1 to 12 letters or digits. Codes look like PREFIX-7K3M9QX2HT4P." error={err("batchPrefix")} id={fieldId("batchPrefix")}>
                  <Input className="font-mono uppercase" value={f.batchPrefix} onChange={(e) => set("batchPrefix", e.target.value.trim().toUpperCase())} maxLength={12} autoComplete="off" spellCheck={false} />
                </Field>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={create.isPending || update.isPending}>{creating ? "Create discount code" : "Save changes"}</Button>
        <Button asChild variant="secondary"><Link href={existing ? `${BASE}/${existing.publicId}` : BASE}>Cancel</Link></Button>
      </div>
    </form>
  );
}

function CreatedPanel({ promotion, code, generated }: { promotion: PromotionView; code: string | null; generated: number }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const resultRef = useRef<HTMLDivElement>(null);
  // The focused form was replaced by this result: move focus to it (the callout is also announced politely).
  useEffect(() => { resultRef.current?.focus(); }, []);
  return (
    <div className="ph-no-capture space-y-6" data-clarity-mask="true">
      <div ref={resultRef} tabIndex={-1} className="outline-none">
      <Callout tone="success" title={`"${promotion.name}" created`} live="polite">
        {promotion.isBatch ? `${generated.toLocaleString("en-US")} single-use codes were generated. Export them from the code's page.` : "Copy the code or its link now. An administrator can show it again later; every view is recorded."}
      </Callout>
      </div>
      {code ? (
        <Card title="Share" headingLevel={2}>
          <div className="space-y-4">
            <CopyField label="Code" value={code} secret monospace copyLabel={`Copy code for ${promotion.name}`} />
            <div className="flex flex-wrap items-center gap-3">
              <CopyButton value={promoLink(origin, code)} label={`Copy link for ${promotion.name}`} />
              <span className="text-sm text-muted">The link keeps the code out of web addresses sent to servers.</span>
            </div>
          </div>
        </Card>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button asChild><Link href={`${BASE}/${promotion.publicId}`}>Open the discount code</Link></Button>
        <Button asChild variant="secondary"><Link href={BASE}>Back to discount codes</Link></Button>
      </div>
    </div>
  );
}
