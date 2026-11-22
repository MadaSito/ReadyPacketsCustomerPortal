/** Discount codes — shared admin parts: status badge, redemptions table with manual release, CSV export. Owner: audit engineer. */
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, CalendarClock, CheckCircle2, CircleSlash, Download, PauseCircle, Ticket, TimerOff } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { roleHasCapability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import { errorMessage } from "@/lib/trpc";
import { Badge, Button, DataTable, DateTime, Dialog, EmptyState, Field, LoadMore, Money, Select, StepUpCancelledError, Textarea, useStepUp, useToast, type Tone } from "@/ui";
import { usePromotionsApi, type CsvFile, type RedemptionFilters } from "./api";
import { DERIVED_STATUS_LABEL, downloadCsv, type PromoDerivedStatus, type RedemptionView } from "./model";

export const BASE = "/admin/promotions";

/**
 * After an action that can unmount its own trigger (status change, release): once dialogs have restored focus
 * and the refetch has re-rendered, if focus fell back to <body>, move it to the first candidate still present.
 */
export function restoreFocusAfterAction(...candidates: Array<() => HTMLElement | null | undefined>): void {
  setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    for (const candidate of candidates) {
      const el = candidate();
      if (el?.isConnected) { el.focus(); return; }
    }
  }, 60);
}

/**
 * Field errors set on submit: focus the invalid control (after the error text is committed, so it is read with
 * the control), and announce politely when the control already had focus (Enter inside it re-reads nothing).
 */
export function useInvalidFocus(): { report: (el: HTMLElement | null, message: string) => void; region: ReactNode } {
  const [message, setMessage] = useState("");
  const report = (el: HTMLElement | null, text: string) => {
    const already = el !== null && document.activeElement === el;
    setMessage("");
    requestAnimationFrame(() => {
      el?.focus();
      if (already) setMessage(text);
    });
  };
  return { report, region: <p role="status" aria-live="polite" className="sr-only">{message}</p> };
}

const STATUS_META: Record<PromoDerivedStatus, { tone: Tone; icon: typeof Ticket }> = {
  active: { tone: "success", icon: CheckCircle2 },
  scheduled: { tone: "info", icon: CalendarClock },
  paused: { tone: "warning", icon: PauseCircle },
  revoked: { tone: "danger", icon: Ban },
  expired: { tone: "neutral", icon: TimerOff },
  exhausted: { tone: "neutral", icon: CircleSlash },
};

/** Text + icon; colour is decoration only. */
export function PromotionStatusBadge({ status }: { status: PromoDerivedStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return <Badge tone={meta.tone} icon={<Icon aria-hidden="true" />}>{DERIVED_STATUS_LABEL[status]}</Badge>;
}

export function useCanManage(): boolean {
  const { me } = useSession();
  const role = me?.state === "full" ? me.user.role : null;
  return role !== null && roleHasCapability(role, "promotions.manage");
}

/** Step-up guarded CSV export. The server builds a formula-safe file and audits `promotion.exported`. */
export function useCsvExport() {
  const stepUp = useStepUp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<CsvFile>) => {
    setBusy(true);
    try {
      const file = await stepUp.run(fn, { reason: "Exporting discount codes requires a fresh confirmation." });
      downloadCsv(file.fileName, file.csv);
      toast.show({ tone: "success", title: "Export ready", description: `${file.rowCount.toLocaleString("en-US")} rows downloaded.` });
    } catch (error) {
      if (error instanceof StepUpCancelledError) return;
      toast.show({ tone: "danger", title: "Export failed", description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

const REDEMPTION_STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "redeemed", label: "Used" },
  { value: "released", label: "Released" },
];

/**
 * Redemptions for one promotion (`promotionPublicId`) or across all of them. Manual release follows ADR 0044:
 * the server releases only a cancelled order that was never paid and has nothing payable left; otherwise it
 * refuses with a plain reason, shown here unchanged.
 */
export function RedemptionsSection({ promotionPublicId }: { promotionPublicId?: string }) {
  const api = usePromotionsApi();
  const qc = useQueryClient();
  const canManage = useCanManage();
  const csv = useCsvExport();
  const [status, setStatus] = useState<"" | "redeemed" | "released">("");
  const filters: RedemptionFilters = { ...(promotionPublicId ? { promotionPublicId } : {}), ...(status ? { status } : {}), limit: 50 };
  const list = useInfiniteQuery(api.redemptions.infiniteQueryOptions(filters, { getNextPageParam: (last) => last.nextCursor }));
  const exportMutation = useMutation(api.exportRedemptions.mutationOptions());
  const [releasing, setReleasing] = useState<RedemptionView | null>(null);
  const rows = list.data?.pages.flatMap((p) => p.items);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-ink outline-none">Redemptions</h2>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Show">
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} options={REDEMPTION_STATUS_OPTIONS} />
          </Field>
          {canManage ? (
            <Button variant="secondary" loading={csv.busy} leadingIcon={<Download className="size-4" aria-hidden />} onClick={() => void csv.run(() => exportMutation.mutateAsync(filters))}>
              Export redemptions (CSV)
            </Button>
          ) : null}
        </div>
      </div>
      <DataTable
        caption={promotionPublicId ? "Redemptions of this discount code" : "Redemptions across all discount codes"}
        rows={rows}
        rowKey={(r) => r.publicId}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        empty={<EmptyState icon={Ticket} headingLevel={3} title="No redemptions yet" description="Orders that use a code appear here." />}
        columns={[
          { key: "order", header: "Order", primary: true, cell: (r) => <Link className="font-medium text-brand underline-offset-2 hover:underline" href={`/admin/orders/${r.orderPublicId}`}>{r.orderNumber ?? "Order"}</Link> },
          ...(promotionPublicId ? [] : [{ key: "promotion", header: "Discount code", cell: (r: RedemptionView) => <Link className="underline-offset-2 hover:underline" href={`${BASE}/${r.promoPublicId}`}>{r.promotionName}</Link> }]),
          { key: "code", header: "Code", cell: (r) => <span className="font-mono text-sm">{r.codeMasked}</span> },
          { key: "status", header: "Status", cell: (r) => r.status === "redeemed" ? <Badge tone="success">Used</Badge> : <Badge tone="neutral">Released</Badge> },
          { key: "discount", header: "Discount", align: "end", cell: (r) => <Money value={{ amountMinor: r.promoDiscountMinor, currency: r.currency }} /> },
          { key: "total", header: "Order total", align: "end", hideOnMobile: true, cell: (r) => <Money value={{ amountMinor: r.totalMinor, currency: r.currency }} /> },
          { key: "when", header: "Used", cell: (r) => <DateTime value={r.redeemedAt} format="datetime" /> },
        ]}
        rowActions={canManage ? (r) => r.status === "redeemed" ? (
          <Button size="sm" variant="ghost" onClick={() => setReleasing(r)} aria-label={`Release the redemption on ${r.orderNumber ?? "this order"}`}>Release</Button>
        ) : null : undefined}
      />
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} summary={rows ? `Showing ${rows.length} ${rows.length === 1 ? "redemption" : "redemptions"}` : undefined} />
      <ReleaseDialog redemption={releasing} onClose={() => setReleasing(null)} onReleased={async () => {
        await qc.invalidateQueries(api.redemptions.pathFilter());
        await qc.invalidateQueries(api.stats.pathFilter());
        // The row's Release button is gone: land on the section heading.
        restoreFocusAfterAction(() => headingRef.current);
      }} />
    </section>
  );
}

function ReleaseDialog({ redemption, onClose, onReleased }: { redemption: RedemptionView | null; onClose: () => void; onReleased: () => Promise<void> }) {
  const api = usePromotionsApi();
  const stepUp = useStepUp();
  const toast = useToast();
  const release = useMutation(api.releaseRedemption.mutationOptions());
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [refusal, setRefusal] = useState<string | undefined>();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const invalid = useInvalidFocus();
  const close = () => { setReason(""); setError(undefined); setRefusal(undefined); onClose(); };
  const submit = async () => {
    if (!redemption) return;
    const trimmed = reason.trim();
    if (trimmed.length < 5) {
      const message = "Explain why, in at least 5 characters.";
      setError(message);
      invalid.report(reasonRef.current, message);
      return;
    }
    setError(undefined);
    try {
      await stepUp.run(() => release.mutateAsync({ redemptionPublicId: redemption.publicId, reason: trimmed }), { reason: "Releasing a redemption requires a fresh confirmation." });
      toast.show({ tone: "success", title: "Redemption released", description: "The customer can use the code again." });
      close();
      await onReleased();
    } catch (e) {
      if (e instanceof StepUpCancelledError) return;
      setRefusal(errorMessage(e));
    }
  };
  return (
    <Dialog
      open={redemption !== null}
      onOpenChange={(open) => { if (!open) close(); }}
      title="Release this redemption?"
      description="Only for a cancelled order that was never paid and has no invoice or payment left open. Void or settle the invoice first; the server checks this and refuses otherwise."
      footer={
        <>
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button variant="danger" loading={release.isPending} onClick={() => void submit()}>Release</Button>
        </>
      }
    >
      <div className="space-y-4">
        {refusal ? <p role="alert" className="text-sm text-danger">Not released: {refusal}</p> : null}
        {invalid.region}
        <Field label="Reason" hint="Recorded in the audit log with your name." error={error} required>
          <Textarea ref={reasonRef} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} />
        </Field>
      </div>
    </Dialog>
  );
}
