/** /admin/promotions/:promotionId — rules, code (reveal + copy code / link), batch generation, exports, redemptions. Owner: audit engineer. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, Layers, Pencil } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { formatMoney } from "@shared/domain";
import { errorMessage } from "@/lib/trpc";
import { Breadcrumbs, Button, Card, CopyButton, CopyField, DateTime, Dialog, ErrorState, Field, Input, KeyValueList, PageHeader, Skeleton, StepUpCancelledError, useStepUp, useToast } from "@/ui";
import { usePromotionsApi } from "./api";
import { StatusActionButtons, StatsGrid, useStatusAction } from "./DiscountCodesPage";
import { BATCH_MAX, batchErrors, discountSummary, newIdempotencyKey, SCOPE_LABEL, type PromotionView } from "./model";
import { BASE, PromotionStatusBadge, RedemptionsSection, useCanManage, useCsvExport, useInvalidFocus } from "./parts";
import { promoLink } from "./savedCode";

function scopeDetail(p: PromotionView): string {
  const s = p.scope;
  if (s.kind === "all") return SCOPE_LABEL.all;
  const n = s.kind === "products" ? s.productPublicIds.length : s.kind === "tiers" ? s.tierKeys.length : s.packetNumbers.length;
  const list = s.kind === "packets" ? `: ${s.packetNumbers.join(", ")}` : s.kind === "tiers" ? `: ${s.tierKeys.join(", ")}` : "";
  return `${SCOPE_LABEL[s.kind]} (${n})${list}`;
}

export default function PromotionDetailPage() {
  const { promotionId = "" } = useParams<{ promotionId: string }>();
  const api = usePromotionsApi();
  const canManage = useCanManage();
  const promotion = useQuery(api.get.queryOptions({ publicId: promotionId }));
  const stats = useQuery(api.stats.queryOptions({ promotionPublicId: promotionId }));
  const fallbackRef = useRef<HTMLDivElement>(null);
  const actions = useStatusAction(fallbackRef);
  const p = promotion.data;
  const crumbs = <Breadcrumbs items={[{ label: "Console", href: "/admin" }, { label: "Discount codes", href: BASE }, { label: p?.name ?? "Discount code" }]} />;

  if (promotion.isPending) return <><PageHeader breadcrumbs={crumbs} title="Discount code" /><Skeleton className="h-64" /></>;
  if (promotion.error || !p) return <><PageHeader breadcrumbs={crumbs} title="Discount code" /><ErrorState error={promotion.error} title="Could not load this discount code" onRetry={() => void promotion.refetch()} /></>;

  const money = (minor: number) => (p.currency ? formatMoney({ amountMinor: minor, currency: p.currency }) : String(minor));
  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={p.name}
        meta={<PromotionStatusBadge status={p.derivedStatus} />}
        description={`Customers see: ${p.label}`}
        actions={canManage ? (
          <div ref={fallbackRef} tabIndex={-1} aria-label="Discount code actions" role="group" className="flex flex-wrap gap-2 outline-none">
            {p.status !== "revoked" ? <Button asChild variant="secondary" leadingIcon={<Pencil className="size-4" aria-hidden />}><Link href={`${BASE}/${p.publicId}/edit`}>Edit</Link></Button> : null}
            <StatusActionButtons promotion={p} onAction={(a) => actions.ask(p, a)} />
          </div>
        ) : undefined}
      />
      <div className="space-y-8">
        <StatsGrid stats={stats.data} loading={stats.isPending} />
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Rules" headingLevel={2} className="lg:col-span-2">
            <KeyValueList
              items={[
                { label: "Discount", value: discountSummary(p) },
                { label: "Applies to", value: <span className="break-words">{scopeDetail(p)}</span> },
                { label: "Minimum subtotal", value: p.minSubtotalMinor > 0 ? money(p.minSubtotalMinor) : "None" },
                { label: "Starts", value: p.startsAt ? <DateTime value={p.startsAt} format="datetime" /> : "Immediately" },
                { label: "Ends", value: p.endsAt ? <DateTime value={p.endsAt} format="datetime" /> : "No end date" },
                { label: "Total uses", value: `${p.redemptionCount.toLocaleString("en-US")} of ${p.maxRedemptions === null ? "unlimited" : p.maxRedemptions.toLocaleString("en-US")}` },
                { label: "Uses per customer", value: String(p.maxPerCustomer) },
                { label: "First order only", value: p.firstOrderOnly ? "Yes" : "No" },
                { label: "With a bundle discount", value: p.combineWithBundle ? "Both apply" : "The larger applies" },
                { label: "Only these customers", value: p.allowCustomerPublicIds.length ? `${p.allowCustomerPublicIds.length} customers` : "Everyone" },
                { label: "Only these e-mail domains", value: p.allowEmailDomains.length ? <span className="break-words">{p.allowEmailDomains.join(", ")}</span> : "Any" },
                { label: "Note", value: p.note ? <span className="break-words">{p.note}</span> : "—" },
                { label: "Created", value: <DateTime value={p.createdAt} format="datetime" /> },
              ]}
            />
          </Card>
          <CodeCard promotion={p} canManage={canManage} />
        </div>
        <RedemptionsSection promotionPublicId={p.publicId} />
      </div>
      {actions.dialog}
    </>
  );
}

function CodeCard({ promotion, canManage }: { promotion: PromotionView; canManage: boolean }) {
  const api = usePromotionsApi();
  const stepUp = useStepUp();
  const toast = useToast();
  const reveal = useMutation(api.reveal.mutationOptions());
  const exportCodes = useMutation(api.exportCodes.mutationOptions());
  const csv = useCsvExport();
  const [code, setCode] = useState<string | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const showRef = useRef<HTMLButtonElement>(null);
  const revealedRef = useRef<HTMLDivElement>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const show = async () => {
    try {
      const out = await stepUp.run(() => reveal.mutateAsync({ publicId: promotion.publicId }), { reason: "Showing a discount code requires a fresh confirmation. The view is recorded." });
      setCode(out.code);
      // "Show code and link" is replaced by the revealed controls: focus the first copy action, never the value.
      requestAnimationFrame(() => revealedRef.current?.querySelector<HTMLElement>("button")?.focus());
    } catch (e) {
      if (e instanceof StepUpCancelledError) return;
      toast.show({ tone: "danger", title: "Code not shown", description: errorMessage(e) });
    }
  };
  const hide = () => { setCode(null); requestAnimationFrame(() => showRef.current?.focus()); };

  return (
    <Card title={promotion.isBatch ? "Codes" : "Code"} headingLevel={2} className="ph-no-capture" data-clarity-mask="true">
      {promotion.isBatch ? (
        <div className="space-y-4">
          <p className="text-sm text-ink">{promotion.batchSize.toLocaleString("en-US")} single-use codes{promotion.codePrefix ? `, starting with ${promotion.codePrefix}-` : ""}.</p>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" leadingIcon={<Download className="size-4" aria-hidden />} loading={csv.busy} onClick={() => void csv.run(() => exportCodes.mutateAsync({ publicId: promotion.publicId }))}>Export codes (CSV)</Button>
              {promotion.status !== "revoked" ? <Button variant="secondary" leadingIcon={<Layers className="size-4" aria-hidden />} onClick={() => setBatchOpen(true)}>Generate more codes</Button> : null}
            </div>
          ) : <p className="text-sm text-muted">An administrator can export the codes.</p>}
          <GenerateBatchDialog promotion={promotion} open={batchOpen} onOpenChange={setBatchOpen} />
        </div>
      ) : code ? (
        <div ref={revealedRef} className="space-y-4">
          <CopyField label="Code" value={code} secret monospace copyLabel={`Copy code for ${promotion.name}`} />
          <CopyButton value={promoLink(origin, code)} label={`Copy link for ${promotion.name}`} />
          <Button variant="ghost" size="sm" onClick={hide}>Hide code</Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="font-mono text-lg text-ink" aria-label={`Masked code ${promotion.codeMasked ?? ""}`}>{promotion.codeMasked ?? "—"}</p>
          {canManage ? (
            <Button ref={showRef} variant="secondary" leadingIcon={<Eye className="size-4" aria-hidden />} loading={reveal.isPending} onClick={() => void show()}>Show code and link</Button>
          ) : <p className="text-sm text-muted">Only administrators can show the full code.</p>}
        </div>
      )}
    </Card>
  );
}

function GenerateBatchDialog({ promotion, open, onOpenChange }: { promotion: PromotionView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = usePromotionsApi();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const generate = useMutation(api.generateBatch.mutationOptions());
  const [count, setCount] = useState("");
  const [errors, setErrors] = useState<{ batchCount?: string; batchPrefix?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  // One key per intended batch: a retry after a network error re-sends the same key, so the server never doubles it.
  const keyRef = useRef<string | null>(null);
  const countRef = useRef<HTMLInputElement>(null);
  const invalid = useInvalidFocus();
  const close = (next: boolean) => { if (!next) { setCount(""); setErrors({}); setFailure(null); keyRef.current = null; } onOpenChange(next); };
  const submit = async () => {
    const found = batchErrors(count, "");
    setErrors(found);
    if (found.batchCount) { invalid.report(countRef.current, found.batchCount); return; }
    keyRef.current ??= newIdempotencyKey();
    const idempotencyKey = keyRef.current;
    try {
      const out = await stepUp.run(() => generate.mutateAsync({ publicId: promotion.publicId, count: Number(count), prefix: promotion.codePrefix, idempotencyKey }), { reason: "Generating codes requires a fresh confirmation." });
      toast.show({ tone: "success", title: `${out.generated.toLocaleString("en-US")} codes generated`, description: "Export the codes to share them." });
      await qc.invalidateQueries(api.get.pathFilter());
      close(false);
    } catch (e) {
      if (e instanceof StepUpCancelledError) return;
      setFailure(errorMessage(e));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Generate more codes"
      description={`Each new code is single-use and follows the same rules. At most ${BATCH_MAX.toLocaleString("en-US")} per request.`}
      footer={<><Button variant="secondary" onClick={() => close(false)}>Cancel</Button><Button loading={generate.isPending} onClick={() => void submit()}>Generate</Button></>}
    >
      <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {failure ? <p role="alert" className="text-sm text-danger">Not generated: {failure}</p> : null}
        {invalid.region}
        <Field label="Number of codes" hint={`1 to ${BATCH_MAX.toLocaleString("en-US")}.`} error={errors.batchCount} required>
          <Input ref={countRef} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} maxLength={4} />
        </Field>
      </form>
    </Dialog>
  );
}
