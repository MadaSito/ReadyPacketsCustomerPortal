import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Download, Plus, ReceiptText } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "wouter";
import type { InvoiceDetailView, InvoicePaymentView, InvoiceSummaryView } from "@server/modules/compliance/invoicesService";
import { useTRPC } from "@/lib/trpc";
import { Breadcrumbs, Button, Callout, Card, DateTime, EmptyState, ErrorState, KeyValueList, LoadMore, Money, PageHeader, Section, Skeleton } from "@/ui";
import { useCan } from "../admin/common";
import { downloadInvoicePdf, InvoiceStatusBadge } from "../shared";

function Amount({ minor, currency }: { minor: number; currency: string }) {
  return <Money value={{ amountMinor: minor, currency }} />;
}

function DueDate({ date }: { date: Date | null }) {
  return date ? <DateTime value={date} format="date" /> : <>No due date set</>;
}

function InvoiceList({
  items,
  showOrder,
  area = "customer",
  emptyDescription = "Issued invoices will appear here.",
  emptyAction,
}: {
  items: readonly InvoiceSummaryView[];
  showOrder: boolean;
  area?: "customer" | "console";
  emptyDescription?: string;
  emptyAction?: ReactNode;
}) {
  if (!items.length) {
    return <EmptyState icon={ReceiptText} title="No invoices yet" description={emptyDescription} action={emptyAction} />;
  }
  const baseHref = area === "console" ? "/admin/invoices" : "/invoices";
  const fallbackLabel = area === "console" ? "Draft invoice" : "View invoice";
  return <ul className="grid gap-3">
    {items.map((invoice) => (
      <li key={invoice.invoicePublicId}>
        <Card title={<Link href={`${baseHref}/${encodeURIComponent(invoice.invoicePublicId)}`} className="text-action underline underline-offset-2">
          {invoice.invoiceNumber ?? fallbackLabel}
        </Link>} actions={<InvoiceStatusBadge status={invoice.status} />}>
          <KeyValueList columns={3} items={[
            ...(showOrder ? [{ label: "Order", value: invoice.orderReference }] : []),
            { label: "Due date", value: <DueDate date={invoice.dueAt} /> },
            { label: "Total", value: <Amount minor={invoice.totalMinor} currency={invoice.currency} /> },
            { label: "Outstanding balance", value: invoice.status === "void" ? "Not payable" : <Amount minor={invoice.balanceDueMinor} currency={invoice.currency} /> },
          ]} />
        </Card>
      </li>
    ))}
  </ul>;
}

export function InvoicesPage() {
  const trpc = useTRPC();
  const invoices = useInfiniteQuery(trpc.compliance.invoices.listMine.infiniteQueryOptions({ limit: 25 }, {
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  }));
  const items = invoices.data?.pages.flatMap((page) => page.items.filter((invoice) => invoice.issuedAt !== null)) ?? [];
  return (
    <>
      <PageHeader title="Invoices" description="See issued invoices and their payment status." />
      {invoices.isPending ? <Skeleton lines={4} /> : invoices.isError && !invoices.data
        ? <ErrorState title="We couldn't load invoices" onRetry={() => void invoices.refetch()} />
        : <div className="space-y-4">
          <InvoiceList items={items} showOrder />
          {invoices.isFetchNextPageError ? <Callout tone="danger" live="polite">Couldn't load more invoices. Try again.</Callout> : null}
          <LoadMore hasMore={invoices.hasNextPage} loading={invoices.isFetchingNextPage} onLoadMore={() => void invoices.fetchNextPage()} label="Load more invoices" />
        </div>}
    </>
  );
}

function ConsoleOrderInvoicesTab({ orderId }: { orderId: string }) {
  const trpc = useTRPC();
  const canManage = useCan("invoices.manage");
  const invoices = useQuery(trpc.compliance.invoices.listForOrder.queryOptions({ orderPublicId: orderId }));
  if (invoices.isPending) return <Skeleton lines={4} />;
  if (invoices.isError) return <ErrorState title="We couldn't load the order's invoices" onRetry={() => void invoices.refetch()} />;
  const items = invoices.data.items;
  const newInvoiceHref = `/admin/invoices?order=${encodeURIComponent(orderId)}`;
  return (
    <div className="space-y-4">
      {items.length > 0 && canManage ? (
        <div className="flex justify-end">
          <Button asChild variant="secondary" leadingIcon={<Plus aria-hidden="true" />}>
            <Link href={newInvoiceHref}>New invoice for this order</Link>
          </Button>
        </div>
      ) : null}
      <InvoiceList
        items={items}
        showOrder={false}
        area="console"
        emptyDescription={canManage ? "Create a draft invoice for this order, then issue it to the customer." : "Invoices for this order will appear here."}
        emptyAction={
          canManage ? (
            <Button asChild leadingIcon={<Plus aria-hidden="true" />}>
              <Link href={newInvoiceHref}>New invoice for this order</Link>
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

export function OrderInvoicesTab({ orderId, area }: { orderId: string; area: "customer" | "console" }) {
  if (area === "console") return <ConsoleOrderInvoicesTab orderId={orderId} />;
  return <CustomerOrderInvoicesTab orderId={orderId} />;
}

function CustomerOrderInvoicesTab({ orderId }: { orderId: string }) {
  const trpc = useTRPC();
  const invoices = useQuery(trpc.compliance.invoices.listForOrder.queryOptions({ orderPublicId: orderId }));
  if (invoices.isPending) return <Skeleton lines={4} />;
  if (invoices.isError) return <ErrorState title="We couldn't load the order's invoices" onRetry={() => void invoices.refetch()} />;
  return <InvoiceList items={invoices.data.items.filter((invoice) => invoice.issuedAt !== null)} showOrder={false} />;
}

const paymentLabels: Record<InvoicePaymentView["method"], string> = {
  bank_transfer: "Bank transfer", wire: "Wire transfer", ach: "ACH", check: "Check", card_manual: "Card",
  waiver: "Waiver", provider_online: "Online provider", imported_historical: "Imported history", other: "Other",
};

function InvoiceDetail({ invoice }: { invoice: InvoiceDetailView }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  async function download() {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(false);
    try { await downloadInvoicePdf(invoice.invoicePublicId, invoice.invoiceNumber); }
    catch { setDownloadError(true); }
    finally { setDownloading(false); }
  }
  const amount = (minor: number) => <Amount minor={minor} currency={invoice.currency} />;
  return (
    <div className="space-y-6">
      <PageHeader breadcrumbs={<Breadcrumbs items={[{ href: "/invoices", label: "Invoices" }, { label: invoice.invoiceNumber ?? "Invoice details" }]} />}
        title={invoice.invoiceNumber ?? "Invoice details"} description={`Order ${invoice.orderReference}`}
        meta={<InvoiceStatusBadge status={invoice.status} />}
        actions={<Button leadingIcon={<Download aria-hidden="true" />} variant="secondary" loading={downloading} onClick={() => void download()}>Download PDF</Button>} />
      {downloadError ? <Callout tone="danger" live="assertive">We couldn’t download this PDF. Try again or contact us if the problem continues.</Callout> : null}
      <Card title="Invoice summary">
        <KeyValueList columns={3} items={[
          { label: "Issued by", value: invoice.issuerName },
          { label: "Issued on", value: invoice.issuedAt && <DateTime value={invoice.issuedAt} format="date" /> },
          { label: "Due date", value: <DueDate date={invoice.dueAt} /> },
          { label: "Subtotal", value: amount(invoice.subtotalMinor) },
          { label: "Discount", value: amount(invoice.discountMinor) },
          { label: "Tax", value: amount(invoice.taxMinor) },
          { label: "Total", value: amount(invoice.totalMinor) },
          { label: "Net paid", value: amount(invoice.netPaidMinor) },
          { label: "Outstanding balance", value: invoice.status === "void" ? "Not payable" : amount(invoice.balanceDueMinor) },
          ...(invoice.memo ? [{ label: "Invoice note", value: <p className="whitespace-pre-wrap">{invoice.memo}</p>, wide: true }] : []),
        ]} />
      </Card>
      <Callout tone="info" title="Online payment is not available.">
        <Link href="/support" className="font-semibold text-action underline underline-offset-2">Contact us</Link> for payment instructions or questions about this invoice.
      </Callout>
      <Section title="Line items">
        {invoice.lines.length ? <ul className="grid gap-3">
          {invoice.lines.map((line) => <li key={line.linePublicId}>
            <Card title={line.description} headingLevel={3}>
              <KeyValueList columns={3} items={[
                { label: "Quantity", value: line.quantity },
                { label: "Unit price", value: amount(line.unitAmountMinor) },
                { label: "Line total", value: amount(line.lineTotalMinor) },
              ]} />
            </Card>
          </li>)}
        </ul> : <p className="text-body">No line items are shown.</p>}
      </Section>
      <Section title="Payments">
        {invoice.payments.length ? <ul className="grid gap-3">
          {invoice.payments.map((payment) => <li key={payment.paymentPublicId}>
            <Card><KeyValueList columns={3} items={[
              { label: "Received", value: <DateTime value={payment.receivedAt} /> },
              { label: "Amount", value: <Amount minor={payment.amountMinor} currency={payment.currency} /> },
              { label: "Method", value: paymentLabels[payment.method] },
              { label: "Status", value: payment.status === "succeeded" ? "Recorded" : "Failed" },
              { label: "Reference", value: payment.reference },
            ]} /></Card>
          </li>)}
        </ul> : <p className="text-body">No payments recorded.</p>}
      </Section>
      <Section title="Refunds">
        {invoice.refunds.length ? <ul className="grid gap-3">
          {invoice.refunds.map((refund) => <li key={refund.refundPublicId}>
            <Card><KeyValueList columns={3} items={[
              { label: "Refunded", value: <DateTime value={refund.refundedAt} /> },
              { label: "Amount", value: <Amount minor={refund.amountMinor} currency={refund.currency} /> },
              { label: "Reference", value: refund.reference },
            ]} /></Card>
          </li>)}
        </ul> : <p className="text-body">No refunds recorded.</p>}
      </Section>
    </div>
  );
}

function InvoiceDetailQuery({ invoiceId }: { invoiceId: string }) {
  const trpc = useTRPC();
  const invoice = useQuery(trpc.compliance.invoices.get.queryOptions({ invoicePublicId: invoiceId }));
  if (invoice.isPending) return <><PageHeader title="Invoice" /><Skeleton lines={4} /></>;
  if (invoice.isError) return <><PageHeader title="Invoice" /><ErrorState title="We couldn't load this invoice" onRetry={() => void invoice.refetch()} /></>;
  if (!invoice.data.issuedAt) return <InvoiceUnavailable />;
  return <InvoiceDetail invoice={invoice.data} />;
}

function InvoiceUnavailable() {
  return <><PageHeader title="Invoice" /><EmptyState title="Invoice not available"
    action={<Button asChild variant="secondary"><Link href="/invoices">Back to invoices</Link></Button>} /></>;
}

export function InvoiceDetailPage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  return invoiceId && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(invoiceId)
    ? <InvoiceDetailQuery key={invoiceId} invoiceId={invoiceId} /> : <InvoiceUnavailable />;
}
