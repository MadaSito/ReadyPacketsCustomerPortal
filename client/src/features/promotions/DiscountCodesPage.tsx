/** /admin/promotions — "Discount codes": totals, filters, list, status changes, largest-discount guard. Owner: audit engineer. */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Ticket } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import { Link } from "wouter";
import { formatMoney } from "@shared/domain";
import { errorMessage } from "@/lib/trpc";
import { Breadcrumbs, Button, Card, ConfirmDialog, DataTable, DateTime, EmptyState, Field, FilterBar, Input, LoadMore, PageHeader, Select, StatCard, StatGrid, StepUpCancelledError, Switch, useStepUp, useToast } from "@/ui";
import { usePromotionsApi, type ListFilters } from "./api";
import { discountSummary, statusActions, type PromoDerivedStatus, type PromoDiscountType, type PromotionStats, type PromotionView } from "./model";
import { BASE, PromotionStatusBadge, restoreFocusAfterAction, useCanManage, useInvalidFocus } from "./parts";

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "active", label: "Active" },
  { value: "scheduled", label: "Scheduled" },
  { value: "paused", label: "Paused" },
  { value: "expired", label: "Ended" },
  { value: "exhausted", label: "Used up" },
  { value: "revoked", label: "Revoked" },
];
const TYPE_OPTIONS = [
  { value: "", label: "Any type" },
  { value: "percent", label: "Percentage" },
  { value: "fixed", label: "Fixed amount" },
];
const ENDING_OPTIONS = [
  { value: "", label: "Any end date" },
  { value: "7", label: "Ending within 7 days" },
  { value: "30", label: "Ending within 30 days" },
];

export type StatusAction = "pause" | "resume" | "revoke";
const ACTION_COPY: Record<StatusAction, { verb: string; title: (n: string) => string; description: string; done: string }> = {
  pause: { verb: "Pause", title: (n) => `Pause "${n}"?`, description: "Customers cannot apply the code while it is paused. Orders already placed keep their discount.", done: "paused" },
  resume: { verb: "Resume", title: (n) => `Resume "${n}"?`, description: "Customers can apply the code again within its dates and limits.", done: "resumed" },
  revoke: { verb: "Revoke", title: (n) => `Revoke "${n}"?`, description: "Revoking is permanent: the code can never be applied again. Orders already placed keep their discount.", done: "revoked" },
};

/** Pause / resume / revoke with confirmation and step-up; one always-mounted dialog so focus returns to the trigger. */
export function useStatusAction(fallback: RefObject<HTMLElement | null>) {
  const api = usePromotionsApi();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const pause = useMutation(api.pause.mutationOptions());
  const resume = useMutation(api.resume.mutationOptions());
  const revoke = useMutation(api.revoke.mutationOptions());
  const [pending, setPending] = useState<{ promotion: PromotionView; action: StatusAction } | null>(null);
  const run = async () => {
    if (!pending) return;
    const { promotion, action } = pending;
    const m = action === "pause" ? pause : action === "resume" ? resume : revoke;
    try {
      const updated = await stepUp.run(() => m.mutateAsync({ publicId: promotion.publicId, expectedVersion: promotion.version }), { reason: "Changing a discount code requires a fresh confirmation." });
      toast.show({ tone: "success", title: `"${promotion.name}" ${ACTION_COPY[action].done}` });
      // The trigger is replaced (Pause → Resume) or its row may leave a filtered list: go to the row's next
      // action, else to the fallback (results heading / page actions).
      restoreFocusAfterAction(
        () => document.querySelector<HTMLElement>(`[data-promo-actions="${CSS.escape(updated.publicId)}"] button`),
        () => fallback.current,
      );
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ tone: "danger", title: "Not changed", description: errorMessage(error) });
      throw error;
    } finally {
      await qc.invalidateQueries(api.list.pathFilter());
      await qc.invalidateQueries(api.get.pathFilter());
      await qc.invalidateQueries(api.stats.pathFilter());
    }
  };
  const copy = pending ? ACTION_COPY[pending.action] : ACTION_COPY.pause;
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => { if (!open) setPending(null); }}
      title={pending ? copy.title(pending.promotion.name) : ""}
      description={copy.description}
      confirmLabel={copy.verb}
      destructive={pending?.action === "revoke"}
      onConfirm={run}
    />
  );
  return { ask: (promotion: PromotionView, action: StatusAction) => setPending({ promotion, action }), dialog };
}

export function StatusActionButtons({ promotion, onAction }: { promotion: PromotionView; onAction: (a: StatusAction) => void }) {
  return (
    <span className="contents" data-promo-actions={promotion.publicId}>
      {statusActions(promotion.status).map((a) => (
        <Button key={a} size="sm" variant={a === "revoke" ? "ghost" : "secondary"} onClick={() => onAction(a)} aria-label={`${ACTION_COPY[a].verb} ${promotion.name}`}>
          {ACTION_COPY[a].verb}
        </Button>
      ))}
    </span>
  );
}

export function StatsGrid({ stats, loading }: { stats: PromotionStats | undefined; loading: boolean }) {
  const given = stats ? Object.entries(stats.discountMinorByCurrency) : [];
  return (
    <StatGrid label="Discount code totals">
      <StatCard label="Active codes" value={stats?.activePromotions ?? "—"} loading={loading} />
      <StatCard label="Redemptions" value={stats?.redemptions ?? "—"} loading={loading} />
      <StatCard label="Released" value={stats?.releasedRedemptions ?? "—"} hint="Returned after an unpaid order was cancelled." loading={loading} />
      <StatCard
        label="Discount given"
        loading={loading}
        value={given.length === 0 ? "—" : <span className="flex flex-col">{given.map(([currency, minor]) => <span key={currency}>{formatMoney({ amountMinor: minor, currency })}</span>)}</span>}
        hint={given.length > 1 ? "Shown per currency." : undefined}
      />
    </StatGrid>
  );
}

function SettingsCard() {
  const api = usePromotionsApi();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const canManage = useCanManage();
  const settings = useQuery(api.getSettings.queryOptions(undefined));
  const update = useMutation(api.updateSettings.mutationOptions());
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);
  const invalid = useInvalidFocus();
  const value = draft ?? (settings.data ? String(settings.data.maxDiscountPercent) : "");
  const save = async (patch: { enabled?: boolean; maxDiscountPercent?: number }, done: string) => {
    try {
      await stepUp.run(() => update.mutateAsync(patch), { reason: "Changing discount code settings requires a fresh confirmation." });
      toast.show({ tone: "success", title: done });
      setDraft(null);
    } catch (e) {
      if (e instanceof StepUpCancelledError) return;
      toast.show({ tone: "danger", title: "Not saved", description: errorMessage(e) });
    } finally {
      await qc.invalidateQueries(api.getSettings.pathFilter());
    }
  };
  const submit = () => {
    const n = Number(value);
    if (!/^\d{1,3}$/u.test(value) || n < 1 || n > 100) {
      const message = "Enter a whole percentage from 1 to 100.";
      setError(message);
      invalid.report(inputRef.current, message);
      return;
    }
    setError(undefined);
    void save({ maxDiscountPercent: n }, "Largest discount per order saved");
  };
  if (!settings.data) return null;
  return (
    <Card title="Settings" headingLevel={2} description="Applies to every order, together with any bundle discount.">
      <div className="space-y-4">
        <Switch
          label="Discount codes"
          description={settings.data.enabled ? "On: customers can apply codes in the cart and staff in the order wizard." : "Off: codes cannot be applied anywhere. Existing orders keep their discount."}
          checked={settings.data.enabled}
          disabled={!canManage || update.isPending}
          onCheckedChange={(enabled) => void save({ enabled }, enabled ? "Discount codes turned on" : "Discount codes turned off")}
        />
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <Field label="Largest discount per order (%)" hint="Bundle and code discounts together never exceed this share of the subtotal." error={error}>
            <Input ref={inputRef} inputMode="numeric" value={value} disabled={!canManage} onChange={(e) => setDraft(e.target.value)} className="w-28" maxLength={3} />
          </Field>
          {canManage ? <Button type="submit" variant="secondary" loading={update.isPending}>Save</Button> : null}
        </form>
        {invalid.region}
      </div>
    </Card>
  );
}

export default function DiscountCodesPage() {
  const api = usePromotionsApi();
  const canManage = useCanManage();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"" | PromoDerivedStatus>("");
  const [type, setType] = useState<"" | PromoDiscountType>("");
  const [ending, setEnding] = useState("");
  const filters: ListFilters = { limit: 50, ...(query ? { query } : {}), ...(status ? { status } : {}), ...(type ? { type } : {}), ...(ending ? { endingWithinDays: Number(ending) } : {}) };
  const list = useInfiniteQuery(api.list.infiniteQueryOptions(filters, { getNextPageParam: (last) => last.nextCursor }));
  const stats = useQuery(api.stats.queryOptions({}));
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const actions = useStatusAction(resultsRef);
  const rows = list.data?.pages.flatMap((p) => p.items);
  const activeCount = [query, status, type, ending].filter(Boolean).length;
  const reset = () => { setSearch(""); setQuery(""); setStatus(""); setType(""); setEnding(""); };

  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Console", href: "/admin" }, { label: "Discount codes" }]} />}
        title="Discount codes"
        description="Codes customers enter in the cart, or staff enter when ordering for a customer. Customers see the label, never the code."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary"><Link href={`${BASE}/redemptions`}>All redemptions</Link></Button>
            {canManage ? <Button asChild leadingIcon={<Plus className="size-4" aria-hidden />}><Link href={`${BASE}/new`}>New discount code</Link></Button> : null}
          </div>
        }
      />
      <div className="space-y-8">
        <StatsGrid stats={stats.data} loading={stats.isPending} />
        <section aria-labelledby="promo-codes-heading" className="min-w-0">
          <h2 id="promo-codes-heading" ref={resultsRef} tabIndex={-1} className="mb-4 text-lg font-semibold text-ink outline-none">Codes</h2>
          <div className="space-y-4">
            <FilterBar search={search} onSearchChange={setSearch} onSearchSubmit={setQuery} searchLabel="Search by name or label" activeCount={activeCount} onReset={reset}>
              <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} options={STATUS_OPTIONS} /></Field>
              <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value as typeof type)} options={TYPE_OPTIONS} /></Field>
              <Field label="Ending soon"><Select value={ending} onChange={(e) => setEnding(e.target.value)} options={ENDING_OPTIONS} /></Field>
            </FilterBar>
            <DataTable
              caption="Discount codes"
              rows={rows}
              rowKey={(r) => r.publicId}
              loading={list.isPending}
              error={list.error}
              onRetry={() => void list.refetch()}
              empty={<EmptyState icon={Ticket} headingLevel={3} title={activeCount ? "No codes match these filters" : "No discount codes yet"} description={activeCount ? "Change or reset the filters." : canManage ? "Create one with New discount code." : "An administrator can create one."} />}
              columns={[
                { key: "name", header: "Name", primary: true, cell: (r) => <span className="flex min-w-0 flex-col"><Link className="font-medium text-brand underline-offset-2 hover:underline" href={`${BASE}/${r.publicId}`}>{r.name}</Link><span className="text-sm text-muted break-words">Customers see: {r.label}</span></span> },
                { key: "code", header: "Code", cell: (r) => r.isBatch ? <span>{r.batchSize.toLocaleString("en-US")} single-use codes</span> : <span className="font-mono text-sm">{r.codeMasked ?? "—"}</span> },
                { key: "discount", header: "Discount", cell: (r) => discountSummary(r) },
                { key: "status", header: "Status", cell: (r) => <PromotionStatusBadge status={r.derivedStatus} /> },
                { key: "used", header: "Used", align: "end", cell: (r) => <span className="tabular-nums">{r.redemptionCount.toLocaleString("en-US")}{r.maxRedemptions !== null ? ` of ${r.maxRedemptions.toLocaleString("en-US")}` : ""}</span> },
                { key: "ends", header: "Ends", hideOnMobile: true, cell: (r) => r.endsAt ? <DateTime value={r.endsAt} format="date" /> : <span className="text-muted">No end date</span> },
              ]}
              rowActions={canManage ? (r) => <div className="flex flex-wrap gap-2"><StatusActionButtons promotion={r} onAction={(a) => actions.ask(r, a)} /></div> : undefined}
            />
            <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} summary={rows ? `Showing ${rows.length} discount ${rows.length === 1 ? "code" : "codes"}` : undefined} />
          </div>
        </section>
        <SettingsCard />
      </div>
      {actions.dialog}
    </>
  );
}
