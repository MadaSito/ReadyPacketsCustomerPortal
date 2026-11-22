/** Console invoice detail (/admin/invoices/:invoiceId): lines, balance, issue, manual payment, refund, void, PDF. Owner: orders_engineer (compliance admin UI). */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "wouter";
import { useSession } from "@/lib/session";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Breadcrumbs, Button, Callout, Card, ConfirmDialog, DataTable, DateTime, Field, Input, KeyValueList, Money, PageHeader, Select, Textarea, useToast } from "@/ui";
import { InvoiceStatusBadge, downloadInvoicePdf, newIdempotencyKey, parseDecimalToMinor } from "../shared";
import { QueryState, useGuardedAction } from "./common";
import { INVOICE_REASON, InvoiceEditor } from "./InvoiceEditor";
import { MANUAL_PAYMENT_METHODS, PAYMENT_METHOD_LABELS, REFUND_REASONS, ULID, fromLocalInput, money, type InvoiceDetail, type InvoicePayment, type ManualPaymentMethod } from "./model";

type Action = { kind: "edit" } | { kind: "issue" } | { kind: "payment" } | { kind: "refund"; payment: InvoicePayment } | { kind: "void" } | null;

export function refundableMinor(invoice: InvoiceDetail, payment: InvoicePayment): number {
  const refunded = invoice.refunds.filter((r) => r.paymentPublicId === payment.paymentPublicId).reduce((sum, r) => sum + r.amountMinor, 0);
  return payment.status === "succeeded" ? Math.max(0, payment.amountMinor - refunded) : 0;
}

export default function InvoiceDetailPage() {
  const { invoiceId = "" } = useParams<{ invoiceId: string }>();
  const session = useSession();
  const trpc = useTRPC();
  const toast = useToast();
  const valid = ULID.test(invoiceId);
  const detail = useQuery(trpc.compliance.invoices.get.queryOptions({ invoicePublicId: invoiceId }, { enabled: valid }));
  const [action, setAction] = useState<Action>(null);
  const [downloading, setDownloading] = useState(false);
  const inv = detail.data;
  const canRefundManual = Boolean(inv?.canManage && session.view.status === "full" && session.view.role === "admin");
  const title = inv ? (inv.invoiceNumber ? `Invoice ${inv.invoiceNumber}` : "Draft invoice") : "Invoice";
  const download = async () => {
    if (!inv) return;
    setDownloading(true);
    try {
      await downloadInvoicePdf(inv.invoicePublicId, inv.invoiceNumber);
    } catch (err) {
      toast.show({ tone: "danger", title: "Download failed", description: errorMessage(err) });
    } finally {
      setDownloading(false);
    }
  };
  const header = (
    <PageHeader
      title={title}
      breadcrumbs={<Breadcrumbs items={[{ label: "Invoices", href: "/admin/invoices" }, { label: title }]} />}
      meta={inv ? <InvoiceStatusBadge status={inv.status} /> : undefined}
      actions={
        inv ? (
          <>
            <Button variant="secondary" leadingIcon={<Download aria-hidden />} loading={downloading} onClick={() => void download()}>
              Download PDF
            </Button>
            {inv.canManage && inv.status === "draft" ? (
              <>
                <Button variant="secondary" onClick={() => setAction({ kind: "edit" })}>
                  Edit draft
                </Button>
                <Button onClick={() => setAction({ kind: "issue" })}>Issue invoice</Button>
              </>
            ) : null}
            {inv.canRecordPayment && inv.status === "issued" ? <Button onClick={() => setAction({ kind: "payment" })}>Record payment</Button> : null}
            {inv.canManage && (inv.status === "draft" || inv.status === "issued") ? (
              <Button variant="danger" onClick={() => setAction({ kind: "void" })}>
                Void
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    />
  );
  if (!valid)
    return (
      <>
        {header}
        <Callout tone="danger">This invoice link is not valid.</Callout>
      </>
    );
  return (
    <QueryState header={header} query={detail}>
      {() => {
        const invoice = detail.data as InvoiceDetail;
        const m = (minor: number) => <Money value={money(minor, invoice.currency)} />;
        return (
          <div className="flex flex-col gap-6">
            <Callout tone="info" title="Payments and refunds">
              Record offline payments received by bank transfer, wire, ACH, check, or other manual methods here. For refunds of online payments, open the{" "}
              <Link href={`/admin/orders/${encodeURIComponent(invoice.orderPublicId)}/refund`} className="font-semibold text-action underline underline-offset-2">
                order&apos;s Refund tab
              </Link>
              .
            </Callout>
            {invoice.status === "void" ? (
              <Callout tone="info" title="This invoice is void">
                {invoice.voidReason ?? "No reason recorded."} {invoice.voidedAt ? <DateTime value={invoice.voidedAt} /> : null}
              </Callout>
            ) : null}
            <div className="grid gap-6 lg:grid-cols-2">
              <Card title="Summary">
                <KeyValueList
                  items={[
                    {
                      label: "Order",
                      value: (
                        <Link href={`/admin/orders/${invoice.orderPublicId}`} className="break-all text-action underline-offset-2 hover:underline">
                          {invoice.orderReference}
                        </Link>
                      ),
                    },
                    { label: "Issued", value: <DateTime value={invoice.issuedAt} format="date" /> },
                    { label: "Due", value: <DateTime value={invoice.dueAt} format="date" /> },
                    { label: "Created", value: <DateTime value={invoice.createdAt} /> },
                    ...(invoice.origin === "import" ? [{ label: "Origin", value: <Badge>Imported</Badge> }] : []),
                    ...(invoice.memo ? [{ label: "Memo", value: <span className="break-words whitespace-pre-line">{invoice.memo}</span>, wide: true }] : []),
                  ]}
                />
              </Card>
              <Card title="Balance">
                <KeyValueList
                  items={[
                    { label: "Subtotal", value: m(invoice.subtotalMinor) },
                    ...((invoice.promoDiscountMinor ?? 0) > 0
                      ? [
                          ...((invoice.bundleDiscountMinor ?? 0) > 0
                            ? [{ label: invoice.discountLabel ?? "Bundle discount", value: m(invoice.bundleDiscountMinor) }]
                            : []),
                          {
                            label: invoice.promoLabel ? `Discount (${invoice.promoLabel})` : "Code discount",
                            value: m(invoice.promoDiscountMinor),
                          },
                        ]
                      : [
                          {
                            label: invoice.discountLabel ? `Discount (${invoice.discountLabel})` : "Discount",
                            value: m(invoice.discountMinor),
                          },
                        ]),
                    { label: "Tax", value: m(invoice.taxMinor) },
                    { label: "Total", value: m(invoice.totalMinor) },
                    { label: "Paid", value: m(invoice.grossPaidMinor) },
                    { label: "Refunded", value: m(invoice.refundedMinor) },
                    { label: "Net paid", value: m(invoice.netPaidMinor) },
                    { label: "Outstanding balance", value: <strong className="text-lg">{m(invoice.balanceDueMinor)}</strong> },
                  ]}
                />
              </Card>
            </div>
            <Card title="Line items">
              <DataTable<InvoiceDetail["lines"][number]>
                caption="Invoice line items"
                rows={invoice.lines}
                rowKey={(l) => l.linePublicId}
                columns={[
                  { key: "description", header: "Description", primary: true, cell: (l) => <span className="break-words">{l.description}</span> },
                  { key: "quantity", header: "Quantity", align: "end", cell: (l) => l.quantity },
                  { key: "unit", header: "Unit price", align: "end", cell: (l) => m(l.unitAmountMinor) },
                  { key: "total", header: "Line total", align: "end", cell: (l) => m(l.lineTotalMinor) },
                ]}
              />
            </Card>
            <Card title="Payments">
              <DataTable<InvoicePayment>
                caption="Payments recorded"
                rows={invoice.payments}
                rowKey={(p) => p.paymentPublicId}
                columns={[
                  { key: "received", header: "Received", primary: true, cell: (p) => <DateTime value={p.receivedAt} /> },
                  { key: "method", header: "Method", cell: (p) => PAYMENT_METHOD_LABELS[p.method] },
                  { key: "amount", header: "Amount", align: "end", cell: (p) => <Money value={money(p.amountMinor, p.currency)} /> },
                  { key: "reference", header: "Reference", cell: (p) => <span className="break-all">{p.reference}</span> },
                  { key: "status", header: "Status", cell: (p) => <Badge tone={p.status === "succeeded" ? "success" : "danger"}>{p.status === "succeeded" ? "Received" : "Failed"}</Badge> },
                ]}
                rowActions={(p) =>
                  canRefundManual && p.method !== "provider_online" && refundableMinor(invoice, p) > 0 ? (
                    <Button size="sm" variant="secondary" onClick={() => setAction({ kind: "refund", payment: p })}>
                      Refund{" "}<span className="sr-only">payment {p.reference}</span>
                    </Button>
                  ) : null
                }
                empty={<p className="text-body">No payments recorded.</p>}
              />
            </Card>
            <Card title="Refunds">
              <DataTable<InvoiceDetail["refunds"][number]>
                caption="Refunds issued"
                rows={invoice.refunds}
                rowKey={(r) => r.refundPublicId}
                columns={[
                  { key: "when", header: "Refunded", primary: true, cell: (r) => <DateTime value={r.refundedAt} /> },
                  { key: "amount", header: "Amount", align: "end", cell: (r) => <Money value={money(r.amountMinor, r.currency)} /> },
                  { key: "reason", header: "Reason", cell: (r) => REFUND_REASONS.find((x) => x.value === r.reasonCode)?.label ?? r.reasonCode },
                  { key: "reference", header: "Reference", cell: (r) => <span className="break-all">{r.reference}</span> },
                ]}
                empty={<p className="text-body">No refunds issued.</p>}
              />
            </Card>
            {action?.kind === "edit" ? <InvoiceEditor invoice={invoice} onClose={() => setAction(null)} /> : null}
            {action?.kind === "issue" ? <IssueDialog invoice={invoice} onClose={() => setAction(null)} /> : null}
            {action?.kind === "payment" ? <PaymentDialog invoice={invoice} onClose={() => setAction(null)} /> : null}
            {action?.kind === "refund" ? <RefundDialog invoice={invoice} payment={action.payment} onClose={() => setAction(null)} /> : null}
            {action?.kind === "void" ? <VoidDialog invoice={invoice} onClose={() => setAction(null)} /> : null}
          </div>
        );
      }}
    </QueryState>
  );
}

/** Typed confirmation token: the invoice number once issued, else the order reference. */
function confirmToken(invoice: InvoiceDetail): string {
  return invoice.invoiceNumber ?? invoice.orderReference;
}

function useFailing() {
  const [error, setError] = useState<string | null>(null);
  const fail = (message: string | null): never => {
    setError(message);
    throw new Error("keep open");
  };
  return { error, setError, fail };
}

function IssueDialog({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const issue = useMutation(trpc.compliance.invoices.admin.issue.mutationOptions());
  const [dueAt, setDueAt] = useState(invoice.dueAt ? new Date(invoice.dueAt).toISOString().slice(0, 10) : "");
  const { error, fail } = useFailing();
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Issue this invoice?"
      description="An invoice number is assigned, the lines are frozen, and the customer can see and download it."
      confirmLabel="Issue invoice"
      onConfirm={async () => {
        const due = fromLocalInput(dueAt);
        if (dueAt && !due) fail("Enter a valid due date.");
        const result = await guarded(() => issue.mutateAsync({ invoicePublicId: invoice.invoicePublicId, dueAt: due ?? undefined }), { reason: INVOICE_REASON, success: "Invoice issued" });
        if (!result.ok) fail(result.error);
      }}
    >
      <div className="flex flex-col gap-3">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <p>
          Total <Money value={money(invoice.totalMinor, invoice.currency)} />
        </p>
        <Field label="Due date" hint="Optional.">
          <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

function PaymentDialog({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const record = useMutation(trpc.compliance.invoices.admin.recordManualPayment.mutationOptions());
  // One key per dialog opening: a retry after a timeout cannot record the payment twice.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [values, setValues] = useState({ method: "bank_transfer" as ManualPaymentMethod, amount: (invoice.balanceDueMinor / 100).toFixed(2), reference: "", notes: "", receivedAt: "" });
  const { error, fail } = useFailing();
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Record a manual payment"
      description={`Records money already received outside the portal. Outstanding balance: ${(invoice.balanceDueMinor / 100).toFixed(2)} ${invoice.currency}.`}
      confirmLabel="Record payment"
      confirmText={confirmToken(invoice)}
      onConfirm={async () => {
        const amountMinor = parseDecimalToMinor(values.amount, false);
        if (amountMinor === null) fail("Enter the amount received, e.g. 125.50.");
        if (!values.reference.trim()) fail("Enter the bank, check or transfer reference.");
        const received = fromLocalInput(values.receivedAt);
        if (values.receivedAt && !received) fail("Enter a valid date received.");
        const result = await guarded(
          () =>
            record.mutateAsync({
              invoicePublicId: invoice.invoicePublicId,
              method: values.method,
              amountMinor: amountMinor as number,
              currency: invoice.currency,
              reference: values.reference.trim(),
              notes: values.notes.trim() || undefined,
              receivedAt: received ?? undefined,
              idempotencyKey,
            }),
          { reason: "Recording a payment needs verification.", success: "Payment recorded" },
        );
        if (!result.ok) fail(result.error);
      }}
    >
      <div className="flex flex-col gap-3">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Field label="Method">
          <Select options={MANUAL_PAYMENT_METHODS.map((value) => ({ value, label: PAYMENT_METHOD_LABELS[value] }))} value={values.method} onChange={(e) => setValues((c) => ({ ...c, method: e.target.value as ManualPaymentMethod }))} />
        </Field>
        <Field label={`Amount (${invoice.currency})`} required>
          <Input inputMode="decimal" value={values.amount} onChange={(e) => setValues((c) => ({ ...c, amount: e.target.value }))} maxLength={14} />
        </Field>
        <Field label="Reference" required>
          <Input value={values.reference} onChange={(e) => setValues((c) => ({ ...c, reference: e.target.value }))} maxLength={128} autoComplete="off" />
        </Field>
        <Field label="Date received" hint="Optional. Defaults to now.">
          <Input type="date" value={values.receivedAt} onChange={(e) => setValues((c) => ({ ...c, receivedAt: e.target.value }))} />
        </Field>
        <Field label="Internal notes" hint="Optional. Staff only.">
          <Textarea value={values.notes} onChange={(e) => setValues((c) => ({ ...c, notes: e.target.value }))} maxLength={500} rows={2} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

function RefundDialog({ invoice, payment, onClose }: { invoice: InvoiceDetail; payment: InvoicePayment; onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const refund = useMutation(trpc.compliance.invoices.admin.recordRefund.mutationOptions());
  const [idempotencyKey] = useState(newIdempotencyKey);
  const max = refundableMinor(invoice, payment);
  const [values, setValues] = useState({ amount: (max / 100).toFixed(2), reasonCode: "", reference: "", notes: "" });
  const { error, fail } = useFailing();
  return (
    <ConfirmDialog
      open
      destructive
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Record a refund"
      description={`Against payment ${payment.reference}. Up to ${(max / 100).toFixed(2)} ${payment.currency} can be refunded. Recorded only — no money is moved by the portal.`}
      confirmLabel="Record refund"
      confirmText="REFUND ORDER"
      onConfirm={async () => {
        const amountMinor = parseDecimalToMinor(values.amount, false);
        if (amountMinor === null || amountMinor > max) fail(`Enter an amount from 0.01 to ${(max / 100).toFixed(2)}.`);
        if (!values.reasonCode) fail("Choose a reason.");
        if (!values.reference.trim()) fail("Enter the refund reference.");
        const result = await guarded(
          () =>
            refund.mutateAsync({
              invoicePublicId: invoice.invoicePublicId,
              paymentPublicId: payment.paymentPublicId,
              amountMinor: amountMinor as number,
              currency: payment.currency,
              reasonCode: values.reasonCode,
              reference: values.reference.trim(),
              notes: values.notes.trim() || undefined,
              confirmationPhrase: "REFUND ORDER",
              idempotencyKey,
            }),
          { reason: "Recording a refund needs verification.", success: "Refund recorded" },
        );
        if (!result.ok) fail(result.error);
      }}
    >
      <div className="flex flex-col gap-3">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Field label={`Amount (${payment.currency})`} required>
          <Input inputMode="decimal" value={values.amount} onChange={(e) => setValues((c) => ({ ...c, amount: e.target.value }))} maxLength={14} />
        </Field>
        <Field label="Reason" required>
          <Select options={REFUND_REASONS} placeholder="Choose a reason" value={values.reasonCode} onChange={(e) => setValues((c) => ({ ...c, reasonCode: e.target.value }))} />
        </Field>
        <Field label="Reference" required>
          <Input value={values.reference} onChange={(e) => setValues((c) => ({ ...c, reference: e.target.value }))} maxLength={128} autoComplete="off" />
        </Field>
        <Field label="Internal notes" hint="Optional. Staff only.">
          <Textarea value={values.notes} onChange={(e) => setValues((c) => ({ ...c, notes: e.target.value }))} maxLength={500} rows={2} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

function VoidDialog({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const trpc = useTRPC();
  const guarded = useGuardedAction();
  const voidInvoice = useMutation(trpc.compliance.invoices.admin.void.mutationOptions());
  const [reason, setReason] = useState("");
  const { error, fail } = useFailing();
  return (
    <ConfirmDialog
      open
      destructive
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Void this invoice?"
      description="Voiding is permanent. The invoice number stays reserved and the customer sees it as void."
      confirmLabel="Void invoice"
      confirmText={confirmToken(invoice)}
      onConfirm={async () => {
        if (reason.trim().length < 3) fail("Enter a reason of at least 3 characters.");
        // The void endpoint takes no idempotency key; it is idempotent by state (voiding an already-void invoice returns the existing void).
        const result = await guarded(() => voidInvoice.mutateAsync({ invoicePublicId: invoice.invoicePublicId, reason: reason.trim() }), { reason: INVOICE_REASON, success: "Invoice voided" });
        if (!result.ok) fail(result.error);
      }}
    >
      <div className="flex flex-col gap-3">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Field label="Reason" required hint="Recorded in the audit log and shown on the invoice.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}
