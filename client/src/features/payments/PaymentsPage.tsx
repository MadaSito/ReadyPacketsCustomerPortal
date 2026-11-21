import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, RefreshCw, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ActivePaymentProvider, PaymentAttemptStatus, PaymentWebhookStatus } from "@server/modules/payments/schema";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, ConfirmDialog, DataTable, DateTime, Dialog, EmptyState, ErrorState, Field, FilterBar,
  LoadMore, Money, PageHeader, Select, Skeleton, StepUpCancelledError, Tabs, useStepUp, useToast,
} from "@/ui";
import { PaymentSettings, providerLabels, type PaymentSettingsInput } from "./PaymentSettings";

const providers = [{ value: "", label: "All providers" }, { value: "stripe", label: "Stripe" }, { value: "square", label: "Square" }];
const attemptStates: Record<PaymentAttemptStatus, string> = {
  created: "Created", redirected: "Awaiting provider", expired: "Expired", paid: "Paid", cancelled: "Cancelled", failed: "Failed",
};
const webhookStates: Record<PaymentWebhookStatus, string> = {
  processed: "Processed", ignored: "Ignored", retry_pending: "Retry pending", verification_mismatch: "Verification mismatch",
};
function options(states: Record<string, string>) {
  return [{ value: "", label: "All statuses" }, ...Object.entries(states).map(([value, label]) => ({ value, label }))];
}
function attemptBadge(status: PaymentAttemptStatus) {
  return <Badge tone={status === "paid" ? "success" : status === "failed" ? "danger" :
    status === "redirected" ? "info" : "neutral"}>{attemptStates[status]}</Badge>;
}
function webhookBadge(status: PaymentWebhookStatus) {
  return <Badge tone={status === "processed" ? "success" : status === "verification_mismatch" ? "danger" :
    status === "retry_pending" ? "warning" : "neutral"}>{webhookStates[status]}</Badge>;
}
function providerBadge(provider: ActivePaymentProvider, environment: "test" | "live") {
  return <span className="flex flex-wrap items-center gap-2">{providerLabels[provider]}
    <Badge tone={environment === "live" ? "warning" : "neutral"}>{environment === "live" ? "Live" : "Test"}</Badge>
  </span>;
}
const publicId = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const smallId = (id: string) => <span className="break-all font-mono text-xs">{id}</span>;

export function PaymentsLayout({ configuration, attempts, webhooks, actions }: {
  configuration: ReactNode; attempts: ReactNode; webhooks: ReactNode; actions?: ReactNode;
}) {
  return <>
    <PageHeader title="Payments" description="Configure hosted checkout, review payment attempts, and inspect verified webhook receipts."
      meta={<CreditCard className="size-5 text-action" aria-hidden />} actions={actions} />
    <Tabs label="Payment administration" items={[
      { value: "configuration", label: "Configuration", content: configuration },
      { value: "attempts", label: "Payment attempts", content: attempts },
      { value: "webhooks", label: "Verified webhooks", content: webhooks },
    ]} />
  </>;
}

function Attempts() {
  const trpc = useTRPC();
  const [provider, setProvider] = useState<ActivePaymentProvider | "">("");
  const [status, setStatus] = useState<PaymentAttemptStatus | "">("");
  const [invoiceDraft, setInvoiceDraft] = useState("");
  const [invoicePublicId, setInvoice] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [selected, setSelected] = useState("");
  const list = useInfiniteQuery(trpc.payments.admin.listAttempts.infiniteQueryOptions({
    limit: 25, provider: provider || undefined, status: status || undefined, invoicePublicId: invoicePublicId || undefined,
  }, { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return <Card title="Payment attempts" description="An attempt and a browser redirect are not proof of payment.">
    <FilterBar search={invoiceDraft} onSearchChange={setInvoiceDraft} searchLabel="Invoice public ID"
      searchPlaceholder="Search by exact invoice ID" activeCount={Number(!!provider) + Number(!!status) + Number(!!invoicePublicId)}
      onSearchSubmit={(raw) => {
        const value = raw.trim().toUpperCase();
        const valid = !value || publicId.test(value);
        setInvalid(!valid);
        if (valid) setInvoice(value);
      }}
      onReset={() => { setInvoice(""); setInvoiceDraft(""); setProvider(""); setStatus(""); setInvalid(false); }}>
      <Field label="Attempt provider"><Select options={providers} value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)} /></Field>
      <Field label="Attempt status"><Select options={options(attemptStates)} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} /></Field>
    </FilterBar>
    {invalid ? <p className="mb-4 text-sm text-danger" role="alert">Enter a valid 26-character invoice public ID.</p> : null}
    <DataTable caption="Hosted checkout attempts" rows={rows} rowKey={(row) => row.publicId} loading={list.isPending}
      error={list.error} onRetry={() => { void list.refetch(); }}
      empty={<EmptyState icon={CreditCard} title="No matching payment attempts" description="Try changing the filters. New attempts appear after customers start checkout." />}
      columns={[
        { key: "invoice", header: "Invoice ID", primary: true, cell: (row) => smallId(row.invoicePublicId) },
        { key: "provider", header: "Provider", cell: (row) => providerBadge(row.provider, row.environment) },
        { key: "status", header: "Status", cell: (row) => attemptBadge(row.status) },
        { key: "amount", header: "Amount", align: "end", cell: (row) => <Money value={{ amountMinor: row.amountMinor, currency: row.currency }} /> },
        { key: "created", header: "Created", hideOnMobile: true, cell: (row) => <DateTime value={row.createdAt} /> },
      ]}
      rowActions={(row) => <Button variant="secondary" size="sm" aria-label={`Details for attempt ${row.publicId}`} onClick={() => setSelected(row.publicId)}>
        Details
      </Button>} />
    <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => { void list.fetchNextPage(); }} />
    <Dialog title="Payment attempt details" description="Payment references and verified receipts for this attempt." open={!!selected}
      onOpenChange={(open) => { if (!open) setSelected(""); }}>
      {selected ? <AttemptDetails id={selected} /> : null}
    </Dialog>
  </Card>;
}

function AttemptDetails({ id }: { id: string }) {
  const trpc = useTRPC();
  const detail = useQuery(trpc.payments.admin.getAttempt.queryOptions({ attemptPublicId: id }));
  if (!detail.data) return detail.isPending ? <div role="status" aria-label="Loading payment attempt"><Skeleton lines={4} /></div> :
    <ErrorState title="Could not load payment attempt" error={detail.error} onRetry={() => { void detail.refetch(); }} />;
  const { attempt, webhooks } = detail.data;
  return <div className="grid min-w-0 gap-4">
    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
      <div><dt className="font-semibold">Attempt ID</dt><dd>{smallId(attempt.publicId)}</dd></div>
      <div><dt className="font-semibold">Invoice ID</dt><dd>{smallId(attempt.invoicePublicId)}</dd></div>
      <div><dt className="font-semibold">Status</dt><dd>{attemptBadge(attempt.status)}</dd></div>
      <div><dt className="font-semibold">Provider</dt><dd>{providerBadge(attempt.provider, attempt.environment)}</dd></div>
      <div><dt className="font-semibold">Amount</dt><dd><Money value={{ amountMinor: attempt.amountMinor, currency: attempt.currency }} /></dd></div>
      <div><dt className="font-semibold">Created</dt><dd><DateTime value={attempt.createdAt} /></dd></div>
      {attempt.failureReasonCode ? <div><dt className="font-semibold">Reason code</dt><dd>{smallId(attempt.failureReasonCode)}</dd></div> : null}
    </dl>
    <h3 className="font-semibold">Verified receipts</h3>
    {webhooks.length ? <ul className="grid gap-2">
      {webhooks.map((row) => <li key={row.publicId} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
        {smallId(row.eventType)} {webhookBadge(row.status)} <DateTime value={row.receivedAt} />
      </li>)}
    </ul> : <p className="text-sm text-muted">No verified receipts are linked to this attempt.</p>}
  </div>;
}

function Webhooks() {
  const trpc = useTRPC();
  const [provider, setProvider] = useState<ActivePaymentProvider | "">("");
  const [status, setStatus] = useState<PaymentWebhookStatus | "">("");
  const list = useInfiniteQuery(trpc.payments.admin.listWebhooks.infiniteQueryOptions({ limit: 25, provider: provider || undefined,
    status: status || undefined }, { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return <Card title="Verified webhook receipts" description="Review outcomes and safe reason codes. Raw request bodies and signing keys are not displayed.">
    <FilterBar activeCount={Number(!!provider) + Number(!!status)} onReset={() => { setProvider(""); setStatus(""); }}>
      <Field label="Webhook provider"><Select options={providers} value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)} /></Field>
      <Field label="Webhook status"><Select options={options(webhookStates)} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} /></Field>
    </FilterBar>
    <DataTable caption="Verified payment notifications" rows={rows} rowKey={(row) => row.publicId} loading={list.isPending}
      error={list.error} onRetry={() => { void list.refetch(); }}
      empty={<EmptyState icon={ShieldCheck} title="No verified webhooks match" description="Try changing the filters or verify the notification URL with your provider." />}
      columns={[
        { key: "event", header: "Event type", primary: true, cell: (row) => smallId(row.eventType) },
        { key: "provider", header: "Provider", cell: (row) => providerBadge(row.provider, row.environment) },
        { key: "status", header: "Outcome", cell: (row) => webhookBadge(row.status) },
        { key: "reason", header: "Reason code", cell: (row) => row.reasonCode ? smallId(row.reasonCode) : "Not applicable" },
        { key: "received", header: "Received", hideOnMobile: true, cell: (row) => <DateTime value={row.receivedAt} /> },
      ]} />
    <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => { void list.fetchNextPage(); }} />
  </Card>;
}

export default function PaymentsPage() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const settings = useQuery(trpc.payments.admin.getSettings.queryOptions());
  const reconcile = useMutation(trpc.payments.admin.reconcileNow.mutationOptions());
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: trpc.payments.admin.pathKey() }); };

  async function save(input: PaymentSettingsInput) {
    setSaving(true);
    try {
      // Write-only credentials must not be retained as React Query mutation variables.
      await stepUp.run(() => client.payments.admin.updateSettings.mutate(input), { reason: "Updating payment settings requires a recent identity check." });
      await refresh();
      toast.show({ title: "Payment settings saved", tone: "success" });
    } finally { setSaving(false); }
  }
  async function runReconcile() {
    try {
      const result = await stepUp.run(() => reconcile.mutateAsync(), { reason: "Starting reconciliation requires a recent identity check." });
      await refresh();
      toast.show({ title: "Payment reconciliation finished", tone: "success",
        description: `Checked ${result.scanned}; booked ${result.booked}; still pending ${result.stillPending}.` });
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) toast.show({ title: "Reconciliation was not confirmed", tone: "danger", description: errorMessage(error) });
      throw error;
    }
  }
  const config = settings.data;
  return <>
    <PaymentsLayout
      actions={<Button variant="secondary" leadingIcon={<RefreshCw aria-hidden />} onClick={() => setReconcileOpen(true)}>Reconcile payments</Button>}
      configuration={config ? <PaymentSettings key={JSON.stringify(config)} settings={config} saving={saving} onSave={save} /> :
        settings.isPending ? <div role="status" aria-label="Loading payment settings"><Skeleton lines={6} /></div> :
          <ErrorState title="Could not load payment settings" error={settings.error} onRetry={() => { void settings.refetch(); }} />}
      attempts={<Attempts />} webhooks={<Webhooks />} />
    <ConfirmDialog title="Reconcile pending payments?" open={reconcileOpen} onOpenChange={setReconcileOpen} confirmLabel="Reconcile now" onConfirm={runReconcile}>
      <Callout tone="info" title="What reconciliation does">
        Checks provider records for previously verified events. It does not start any new charges.
      </Callout>
    </ConfirmDialog>
  </>;
}
