import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Download, Plus, ReceiptText } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import type { InvoiceDetailView, InvoicePaymentView, InvoiceSummaryView } from "@server/modules/compliance/invoicesService";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Breadcrumbs, Button, Callout, Card, DateTime, EmailLink, EmptyState, ErrorState, KeyValueList, LoadMore, Money, PageHeader, Section, Skeleton, Tabs } from "@/ui";
import { useCan } from "../admin/common";
import { ConsoleOrderReceiptsSection, CustomerOrderReceiptsSection, CustomerReceiptsPanel } from "../receipts/ReceiptViews";
import { downloadInvoicePdf, InvoiceStatusBadge, OrderLifecycleBadge } from "../shared";

const PUBLIC_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export const invoiceCheckoutNavigation = {
  redirectToHostedCheckout(url: string): void {
    window.location.assign(url);
  },
};

export function isHostedCheckoutUrl(
  raw: string,
  provider: "stripe" | "square",
  environment: "test" | "live",
): boolean {
  if (!raw || raw.length > 2048 || /[\s"'<>\\]/u.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (provider === "stripe") return url.hostname === "checkout.stripe.com" && url.pathname.length > 1;
    if (url.hash) return false;
    if (environment === "live" && url.hostname === "checkout.square.site") return url.pathname.startsWith("/merchant/");
    return (
      url.hostname === (environment === "live" ? "square.link" : "sandbox.square.link") &&
      /^\/u\/[A-Za-z0-9_-]{1,160}$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function Amount({ minor, currency }: { minor: number; currency: string }) {
  return <Money value={{ amountMinor: minor, currency }} />;
}

function DueDate({ date }: { date: Date | null }) {
  return date ? <DateTime value={date} format="date" /> : <>No due date set</>;
}

function InvoicePaymentReturnBannerLoader({
  attemptPublicId,
  resultHint,
  currentInvoiceId,
}: {
  attemptPublicId: string;
  resultHint: string | null;
  currentInvoiceId?: string;
}) {
  const trpc = useTRPC();
  const statusQuery = useQuery({
    ...trpc.payments.checkoutStatus.queryOptions({ attemptPublicId }),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      if (data.invoiceStatus === "paid" || data.invoiceStatus === "void") return false;
      return data.attempt?.status === "redirected" ? 3000 : false;
    },
  });

  if (statusQuery.isPending) {
    return (
      <Callout tone="info" title="Checking payment status" live="polite">
        Verifying your invoice payment status with the payment provider.
      </Callout>
    );
  }

  if (statusQuery.isError || !statusQuery.data) {
    return null;
  }

  const data = statusQuery.data;
  const showInvoiceLink = Boolean(data.invoicePublicId && data.invoicePublicId !== currentInvoiceId);

  if (data.invoiceStatus === "paid") {
    return (
      <Callout tone="success" title="Payment confirmed" live="polite">
        <p>Your payment has been verified and recorded on this invoice.</p>
        <div className="mt-2 flex flex-wrap gap-3">
          {showInvoiceLink ? (
            <Link
              href={`/invoices/${encodeURIComponent(data.invoicePublicId)}`}
              className="font-semibold text-action underline underline-offset-2"
            >
              View paid invoice
            </Link>
          ) : null}
          {data.receiptPublicId ? (
            <Link
              href={`/receipts/${encodeURIComponent(data.receiptPublicId)}`}
              className="font-semibold text-action underline underline-offset-2"
            >
              View payment receipt
            </Link>
          ) : null}
        </div>
      </Callout>
    );
  }

  if (resultHint === "cancelled" || data.attempt?.status === "cancelled") {
    return (
      <Callout tone="info" title="Checkout was cancelled" live="polite">
        <p>No payment was completed. You can pay this invoice online whenever you are ready.</p>
        {showInvoiceLink ? (
          <p className="mt-2">
            <Link
              href={`/invoices/${encodeURIComponent(data.invoicePublicId)}`}
              className="font-semibold text-action underline underline-offset-2"
            >
              Return to invoice
            </Link>
          </p>
        ) : null}
      </Callout>
    );
  }

  if (data.attempt?.status === "failed" || data.attempt?.status === "expired") {
    return (
      <Callout tone="warning" title="Payment was not completed" live="polite">
        <p>The checkout session ended without a confirmed payment. Open the invoice to start a new payment attempt.</p>
        {showInvoiceLink ? (
          <p className="mt-2">
            <Link
              href={`/invoices/${encodeURIComponent(data.invoicePublicId)}`}
              className="font-semibold text-action underline underline-offset-2"
            >
              Open invoice
            </Link>
          </p>
        ) : null}
      </Callout>
    );
  }

  return (
    <Callout tone="info" title="Confirming your payment" live="polite">
      <p>
        We received your return from hosted checkout and are waiting for the signed confirmation from the payment provider. Bank-debit methods can take 1 to 5 business days to settle; this page updates automatically once confirmed.
      </p>
      {showInvoiceLink ? (
        <p className="mt-2">
          <Link
            href={`/invoices/${encodeURIComponent(data.invoicePublicId)}`}
            className="font-semibold text-action underline underline-offset-2"
          >
            View invoice details
          </Link>
        </p>
      ) : null}
    </Callout>
  );
}

function InvoicePaymentReturnBanner({ currentInvoiceId }: { currentInvoiceId?: string }) {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const attempt = params.get("attempt")?.trim() ?? "";
  if (!PUBLIC_ID_PATTERN.test(attempt)) return null;
  return (
    <InvoicePaymentReturnBannerLoader
      attemptPublicId={attempt}
      resultHint={params.get("result")}
      currentInvoiceId={currentInvoiceId}
    />
  );
}

export interface InvoiceOnlinePayActionProps {
  invoicePublicId: string;
  label?: string;
  variant?: "primary" | "secondary";
  successPath?: string;
  cancelPath?: string;
  onCheckoutError: (message: string | null) => void;
  onSettled?: () => void | Promise<void>;
}

export function InvoiceOnlinePayAction({
  invoicePublicId,
  label = "Pay online",
  variant = "primary",
  successPath,
  cancelPath,
  onCheckoutError,
  onSettled,
}: InvoiceOnlinePayActionProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const startCheckout = useMutation(trpc.payments.startInvoiceCheckout.mutationOptions());

  async function payOnline() {
    onCheckoutError(null);
    try {
      const defaultPath = `/invoices/${invoicePublicId}`;
      const res = await startCheckout.mutateAsync({
        invoicePublicId,
        successPath: successPath ?? defaultPath,
        cancelPath: cancelPath ?? defaultPath,
      });
      if (res.mode === "redirect") {
        const environment =
          "environment" in res && (res.environment === "live" || res.environment === "test")
            ? res.environment
            : "test";
        if (!isHostedCheckoutUrl(res.redirectUrl, res.provider, environment)) {
          onCheckoutError("We couldn't verify the payment provider link. Please try again or contact us.");
          return;
        }
        invoiceCheckoutNavigation.redirectToHostedCheckout(res.redirectUrl);
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.compliance.invoices.pathKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.compliance.receipts.pathKey() }),
      ]);
      await onSettled?.();
    } catch (error) {
      onCheckoutError(errorMessage(error, "Online checkout could not be started for this invoice."));
    }
  }

  return (
    <Button
      variant={variant}
      leadingIcon={<CreditCard aria-hidden="true" />}
      loading={startCheckout.isPending}
      onClick={() => {
        void payOnline();
      }}
    >
      {label}
    </Button>
  );
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
  const orderBaseHref = area === "console" ? "/admin/orders" : "/orders";
  const fallbackLabel = area === "console" ? "Draft invoice" : "View invoice";
  return <ul className="grid gap-3">
    {items.map((invoice) => (
      <li key={invoice.invoicePublicId}>
        <Card
          title={
            <Link href={`${baseHref}/${encodeURIComponent(invoice.invoicePublicId)}`} className="inline-flex min-h-6 items-center py-0.5 text-action underline underline-offset-2">
              {invoice.invoiceNumber ?? fallbackLabel}
            </Link>
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <OrderLifecycleBadge state={invoice.orderLifecycleState} />
              <InvoiceStatusBadge status={invoice.status} />
            </div>
          }
        >
          <KeyValueList columns={3} items={[
            ...(showOrder ? [{
              label: "Order",
              value:
                invoice.orderLifecycleState && invoice.orderLifecycleState !== "live" ? (
                  <span className="font-mono break-all">{invoice.orderReference}</span>
                ) : (
                  <Link
                    href={`${orderBaseHref}/${encodeURIComponent(invoice.orderPublicId)}`}
                    className="font-mono break-all text-action underline underline-offset-2"
                  >
                    {invoice.orderReference}
                  </Link>
                ),
            }] : []),
            ...(showOrder && invoice.projectName?.trim()
              ? [{ label: "Project", value: <span className="break-words">{invoice.projectName.trim()}</span> }]
              : []),
            { label: "Due date", value: <DueDate date={invoice.dueAt} /> },
            { label: "Total", value: <Amount minor={invoice.totalMinor} currency={invoice.currency} /> },
            { label: "Outstanding balance", value: invoice.status === "void" ? "Not payable" : <Amount minor={invoice.balanceDueMinor} currency={invoice.currency} /> },
          ]} />
        </Card>
      </li>
    ))}
  </ul>;
}

type BillingDocumentsTab = "invoices" | "receipts";

function parseBillingDocumentsTab(search: string): BillingDocumentsTab {
  const raw = new URLSearchParams(search).get("tab");
  return raw === "receipts" ? "receipts" : "invoices";
}

export function InvoicesPage() {
  const trpc = useTRPC();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const activeTab = parseBillingDocumentsTab(search);
  const handleTabChange = (next: string) => {
    if (next !== "invoices" && next !== "receipts") return;
    const pathname = location.split("?")[0] || "/invoices";
    const params = new URLSearchParams(search);
    if (next === "invoices") {
      params.delete("tab");
    } else {
      params.set("tab", next);
    }
    const nextSearch = params.toString();
    navigate(nextSearch ? `${pathname}?${nextSearch}` : pathname, { replace: true });
  };
  const invoices = useInfiniteQuery(trpc.compliance.invoices.listMine.infiniteQueryOptions({ limit: 25 }, {
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  }));
  const items = invoices.data?.pages.flatMap((page) => page.items.filter((invoice) => invoice.issuedAt !== null)) ?? [];
  const invoicesContent = invoices.isPending ? <Skeleton lines={4} /> : invoices.isError && !invoices.data
    ? <ErrorState title="We couldn't load invoices" onRetry={() => void invoices.refetch()} />
    : <div className="space-y-4">
      <InvoiceList items={items} showOrder />
      {invoices.isFetchNextPageError ? <Callout tone="danger" live="polite">Couldn&apos;t load more invoices. Try again.</Callout> : null}
      <LoadMore hasMore={invoices.hasNextPage} loading={invoices.isFetchingNextPage} onLoadMore={() => void invoices.fetchNextPage()} label="Load more invoices" />
    </div>;
  return (
    <>
      <PageHeader title="Invoices" description="See issued invoices, confirmed payment receipts, and their payment status." />
      <div className="mb-4">
        <InvoicePaymentReturnBanner />
      </div>
      <Tabs
        label="Billing documents"
        value={activeTab}
        onValueChange={handleTabChange}
        items={[
          { value: "invoices", label: "Invoices", content: invoicesContent },
          { value: "receipts", label: "Receipts", content: <CustomerReceiptsPanel /> },
        ]}
      />
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
      <ConsoleOrderReceiptsSection orderId={orderId} />
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
  return (
    <div className="space-y-6">
      <InvoiceList items={invoices.data.items.filter((invoice) => invoice.issuedAt !== null)} showOrder={false} />
      <CustomerOrderReceiptsSection orderId={orderId} />
    </div>
  );
}

const paymentLabels: Record<InvoicePaymentView["method"], string> = {
  bank_transfer: "Bank transfer", wire: "Wire transfer", ach: "ACH", check: "Check", card_manual: "Card",
  waiver: "Waiver", provider_online: "Online provider", imported_historical: "Imported history", other: "Other",
};

function InvoiceDetail({ invoice }: { invoice: InvoiceDetailView }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  async function download() {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(false);
    try { await downloadInvoicePdf(invoice.invoicePublicId, invoice.invoiceNumber); }
    catch { setDownloadError(true); }
    finally { setDownloading(false); }
  }
  const amount = (minor: number) => <Amount minor={minor} currency={invoice.currency} />;
  const isOrderLive = !invoice.orderLifecycleState || invoice.orderLifecycleState === "live";
  const canPayOnline = isOrderLive && invoice.onlinePaymentConfigured && invoice.status === "issued" && invoice.balanceDueMinor > 0;
  const projectLabel = invoice.projectName?.trim() || null;
  return (
    <div className="space-y-6">
      <PageHeader breadcrumbs={<Breadcrumbs items={[{ href: "/invoices", label: "Invoices" }, { label: invoice.invoiceNumber ?? "Invoice details" }]} />}
        title={invoice.invoiceNumber ?? "Invoice details"}
        description={projectLabel ? `Order ${invoice.orderReference} · ${projectLabel}` : `Order ${invoice.orderReference}`}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <OrderLifecycleBadge state={invoice.orderLifecycleState} />
            <InvoiceStatusBadge status={invoice.status} />
          </div>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canPayOnline ? (
              <InvoiceOnlinePayAction invoicePublicId={invoice.invoicePublicId} onCheckoutError={setCheckoutError} />
            ) : null}
            <Button leadingIcon={<Download aria-hidden="true" />} variant="secondary" loading={downloading} onClick={() => void download()}>
              Download PDF
            </Button>
          </div>
        } />
      <InvoicePaymentReturnBanner currentInvoiceId={invoice.invoicePublicId} />
      {downloadError ? <Callout tone="danger" live="assertive">We couldn’t download this PDF. Try again or contact us if the problem continues.</Callout> : null}
      {checkoutError ? <Callout tone="danger" title="Could not start online payment" live="assertive">{checkoutError}</Callout> : null}
      <Card title="Order & project">
        <KeyValueList columns={2} items={[
          {
            label: "Order",
            value: isOrderLive ? (
              <Link
                href={`/orders/${encodeURIComponent(invoice.orderPublicId)}`}
                className="font-mono font-semibold break-all text-action underline underline-offset-2"
              >
                {invoice.orderReference}
              </Link>
            ) : (
              <span className="font-mono font-semibold break-all">{invoice.orderReference}</span>
            ),
          },
          {
            label: "Project",
            value: projectLabel ? (
              <span className="font-semibold break-words">{projectLabel}</span>
            ) : (
              <span className="text-muted">Not specified</span>
            ),
          },
          ...(invoice.buyer
            ? [
                { label: "Billed to", value: invoice.buyer.name },
                {
                  label: "Billing email",
                  value: invoice.buyer.email ? (
                    <EmailLink email={invoice.buyer.email} />
                  ) : (
                    <span className="text-muted">Not available</span>
                  ),
                },
                ...(invoice.buyer.customerRef
                  ? [{ label: "Customer reference", value: <span className="font-mono">{invoice.buyer.customerRef}</span> }]
                  : []),
              ]
            : []),
        ]} />
      </Card>
      <Card title="Invoice summary">
        <KeyValueList columns={3} items={[
          { label: "Issued by", value: invoice.issuerName },
          ...(invoice.issuerContact ? [{ label: "Billing contact", value: <EmailLink email={invoice.issuerContact} /> }] : []),
          { label: "Issued on", value: invoice.issuedAt && <DateTime value={invoice.issuedAt} format="date" /> },
          { label: "Due date", value: <DueDate date={invoice.dueAt} /> },
          { label: "Subtotal", value: amount(invoice.subtotalMinor) },
          ...((invoice.promoDiscountMinor ?? 0) > 0
            ? [
                ...((invoice.bundleDiscountMinor ?? 0) > 0
                  ? [{ label: invoice.discountLabel ?? "Bundle discount", value: amount(invoice.bundleDiscountMinor) }]
                  : []),
                {
                  label: invoice.promoLabel ? `Discount (${invoice.promoLabel})` : "Code discount",
                  value: amount(invoice.promoDiscountMinor),
                },
              ]
            : [
                {
                  label: invoice.discountLabel ? `Discount (${invoice.discountLabel})` : "Discount",
                  value: amount(invoice.discountMinor),
                },
              ]),
          { label: "Tax", value: amount(invoice.taxMinor) },
          { label: "Total", value: amount(invoice.totalMinor) },
          ...((invoice.waivedMinor ?? 0) > 0 ? [{ label: "Amount waived", value: amount(invoice.waivedMinor) }] : []),
          { label: "Net paid", value: amount(invoice.netPaidMinor) },
          { label: "Outstanding balance", value: invoice.status === "void" ? "Not payable" : amount(invoice.balanceDueMinor) },
          ...(invoice.memo ? [{ label: "Invoice note", value: <p className="whitespace-pre-wrap">{invoice.memo}</p>, wide: true }] : []),
        ]} />
      </Card>
      {canPayOnline ? (
        <Callout tone="info" title="Online checkout available">
          <p>
            Pay the outstanding balance of {amount(invoice.balanceDueMinor)} securely through hosted checkout, or{" "}
            <Link href="/support" className="font-semibold text-action underline underline-offset-2">
              contact us
            </Link>{" "}
            if you have billing questions.
          </p>
        </Callout>
      ) : invoice.status !== "paid" && invoice.status !== "void" ? (
        <Callout tone="info" title="Online payment is not available.">
          <Link href="/support" className="font-semibold text-action underline underline-offset-2">Contact us</Link> for payment instructions or questions about this invoice.
        </Callout>
      ) : null}
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
  return invoiceId && PUBLIC_ID_PATTERN.test(invoiceId)
    ? <InvoiceDetailQuery key={invoiceId} invoiceId={invoiceId} /> : <InvoiceUnavailable />;
}
