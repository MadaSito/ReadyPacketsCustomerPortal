/** /admin/promotions — "Discount codes": totals, filters, list, status changes, largest-discount guard. Owner: audit engineer. */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Ticket } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Link } from "wouter";
import { formatMoney } from "@shared/domain";
import { errorMessage } from "@/lib/trpc";
import { Badge, Breadcrumbs, Button, Card, Checkbox, ConfirmDialog, DataTable, DateTime, EmptyState, Field, FilterBar, Input, LoadMore, PageHeader, Select, StatCard, StatGrid, StepUpCancelledError, Switch, useStepUp, useToast } from "@/ui";
import { usePromotionsApi, type ListFilters } from "./api";
import { canReachZero, discountSummary, formatPercentInput, LIMITS_ANCHOR, parseMoney, parsePercent, statusActions, type PromoDerivedStatus, type PromoDiscountType, type PromotionStats, type PromotionView } from "./model";
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
  { value: "set_total", label: "Set order total to" },
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

type SettingsPatch = { enabled?: boolean; maxDiscountPercent?: number; maxFixedAmountMinor?: number | null; allowZeroTotal?: boolean; minOrderTotalAfterDiscountMinor?: number };

function useSaveSettings() {
  const api = usePromotionsApi();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const update = useMutation(api.updateSettings.mutationOptions());
  const save = async (patch: SettingsPatch, done: string): Promise<boolean> => {
    try {
      await stepUp.run(() => update.mutateAsync(patch), { reason: "Changing discount code settings requires a fresh confirmation." });
      toast.show({ tone: "success", title: done });
      return true;
    } catch (e) {
      if (!(e instanceof StepUpCancelledError)) toast.show({ tone: "danger", title: "Not saved", description: errorMessage(e) });
      return false;
    } finally {
      await qc.invalidateQueries(api.getSettings.pathFilter());
    }
  };
  return { save, pending: update.isPending };
}

function SettingsCard() {
  const api = usePromotionsApi();
  const canManage = useCanManage();
  const settings = useQuery(api.getSettings.queryOptions(undefined));
  const { save, pending } = useSaveSettings();
  if (!settings.data) return null;
  return (
    <Card title="Settings" headingLevel={2}>
      <Switch
        label="Discount codes"
        description={settings.data.enabled ? "On: customers can apply codes in the cart and staff in the order wizard." : "Off: codes cannot be applied anywhere. Existing orders keep their discount."}
        checked={settings.data.enabled}
        disabled={!canManage || pending}
        onCheckedChange={(enabled) => void save({ enabled }, enabled ? "Discount codes turned on" : "Discount codes turned off")}
      />
    </Card>
  );
}

type LimitsDraft = { percent: string; maxFixed: string; allowZero: boolean; minTotal: string };
type LimitsErrors = Partial<Record<"percent" | "maxFixed" | "minTotal", string>>;
const minorText = (minor: number) => (minor / 100).toFixed(2);

/** Pure check of the Limits form; returns errors, or the patch to save. */
export function validateLimits(d: LimitsDraft): { errors: LimitsErrors; patch: Required<Omit<SettingsPatch, "enabled">> | null } {
  const errors: LimitsErrors = {};
  const percent = parsePercent(d.percent);
  if (percent === null) errors.percent = "Enter a percentage from 0.01 to 100, with up to two decimals.";
  const maxFixed = parseMoney(d.maxFixed);
  if (maxFixed !== null && (Number.isNaN(maxFixed) || maxFixed <= 0)) errors.maxFixed = "Enter an amount above 0.00, such as 100.00, or leave it empty for no limit.";
  const minTotal = parseMoney(d.minTotal) ?? 0;
  if (Number.isNaN(minTotal) || minTotal < 0) errors.minTotal = "Enter an amount such as 0.00 or 5.00.";
  if (Object.keys(errors).length > 0 || percent === null) return { errors, patch: null };
  return { errors, patch: { maxDiscountPercent: percent, maxFixedAmountMinor: maxFixed, allowZeroTotal: d.allowZero, minOrderTotalAfterDiscountMinor: minTotal } };
}

/** D5 "Limits" card (anchor #limits): store-wide limits every code must respect, edited in place. */
export function LimitsCard() {
  const api = usePromotionsApi();
  const canManage = useCanManage();
  const settings = useQuery(api.getSettings.queryOptions(undefined));
  const { save, pending } = useSaveSettings();
  const [draft, setDraft] = useState<LimitsDraft | null>(null);
  const [errors, setErrors] = useState<LimitsErrors>({});
  const percentRef = useRef<HTMLInputElement>(null);
  const fixedRef = useRef<HTMLInputElement>(null);
  const minRef = useRef<HTMLInputElement>(null);
  const invalid = useInvalidFocus();
  const sectionRef = useRef<HTMLElement>(null);
  const data = settings.data;
  const loaded = data !== undefined;
  useEffect(() => {
    // Rejection messages link staff to /admin/promotions#limits: bring the card into view once it renders.
    if (loaded && window.location.hash === `#${LIMITS_ANCHOR}`) {
      sectionRef.current?.scrollIntoView?.({ block: "start" });
      sectionRef.current?.focus({ preventScroll: true });
    }
  }, [loaded]);
  if (!data) return null;
  const current: LimitsDraft = draft ?? {
    percent: formatPercentInput(Math.round(data.maxDiscountPercent * 100)),
    // Tolerates an older server view without the D5 fields (defaults: no fixed cap, zero totals allowed, minimum 0.00).
    maxFixed: typeof data.maxFixedAmountMinor === "number" ? minorText(data.maxFixedAmountMinor) : "",
    allowZero: data.allowZeroTotal ?? true,
    minTotal: minorText(data.minOrderTotalAfterDiscountMinor ?? 0),
  };
  const set = <K extends keyof LimitsDraft>(k: K, v: LimitsDraft[K]) => setDraft({ ...current, [k]: v });
  const submit = async () => {
    const { errors: found, patch } = validateLimits(current);
    setErrors(found);
    if (!patch) {
      const first = found.percent ? percentRef.current : found.maxFixed ? fixedRef.current : minRef.current;
      invalid.report(first, Object.values(found)[0] ?? "Check the limits.");
      return;
    }
    if (await save(patch, "Limits saved")) setDraft(null);
  };
  return (
    <section ref={sectionRef} id={LIMITS_ANCHOR} tabIndex={-1} aria-labelledby="promo-limits-heading" className="scroll-mt-24 outline-none">
      <Card title={<span id="promo-limits-heading">Limits</span>} headingLevel={2} description="Store-wide limits every discount code must respect, together with any bundle discount. A code that breaks a limit is refused and the message names the limit.">
        <form noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Largest discount per order (%)" hint="0.01 to 100, up to two decimals, e.g. 99.99." error={errors.percent}>
              <Input ref={percentRef} inputMode="decimal" value={current.percent} disabled={!canManage} onChange={(e) => set("percent", e.target.value)} maxLength={6} />
            </Field>
            <Field label="Maximum fixed discount" hint="Largest amount off for fixed-amount codes. Leave empty for no limit." error={errors.maxFixed}>
              <Input ref={fixedRef} inputMode="decimal" value={current.maxFixed} disabled={!canManage} onChange={(e) => set("maxFixed", e.target.value)} maxLength={12} />
            </Field>
            <Field label="Minimum order total after discount" hint="Orders never go below this amount; 0.00 for no minimum." error={errors.minTotal}>
              <Input ref={minRef} inputMode="decimal" value={current.minTotal} disabled={!canManage} onChange={(e) => set("minTotal", e.target.value)} maxLength={12} />
            </Field>
          </div>
          <Checkbox
            label="Allow zero-total orders"
            description="When off, no code can bring an order total to 0.00, including “Set order total to” codes."
            checked={current.allowZero}
            disabled={!canManage}
            onCheckedChange={(v) => set("allowZero", v)}
          />
          {canManage ? <Button type="submit" variant="secondary" loading={pending}>Save limits</Button> : <p className="text-sm text-muted">An administrator can change these limits.</p>}
        </form>
        {invalid.region}
      </Card>
    </section>
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
                { key: "discount", header: "Discount", cell: (r) => <span className="flex min-w-0 flex-col items-start gap-1"><span>{discountSummary(r)}</span>{canReachZero(r) ? <Badge tone="warning">Can make an order free</Badge> : null}</span> },
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
        <LimitsCard />
      </div>
      {actions.dialog}
    </>
  );
}
