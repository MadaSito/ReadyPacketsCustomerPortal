import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Mail, ReceiptText } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "wouter";
import type {
  AdminReceiptSummaryView,
  ReceiptDetailView,
  ReceiptSummaryView,
  RefundNoteSummaryView,
} from "@server/modules/compliance/receiptsService";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import {
  Breadcrumbs,
  Button,
  Callout,
  Card,
  DateTime,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  KeyValueList,
  LoadMore,
  Money,
  PageHeader,
  Section,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from "@/ui";
import { useCan, useGuardedAction } from "../admin/common";
import {
  ReceiptRefundBadge,
  downloadReceiptPdf,
  downloadRefundNotePdf,
  formatReceiptMethodSummary,
} from "../shared";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function MinorAmount({ minor, currency }: { minor: number; currency: string }) {
  return <Money value={{ amountMinor: minor, currency }} />;
}

function RefundNotesList({ notes }: { notes: readonly RefundNoteSummaryView[] }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!notes.length) return null;

  async function handleDownload(note: RefundNoteSummaryView) {
    if (busyId) return;
    setBusyId(note.notePublicId);
    setError(null);
    try {
      await downloadRefundNotePdf(note.notePublicId, note.noteNumber);
    } catch (err) {
      setError(errorMessage(err, "Could not download refund note PDF."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">Refund notes</p>
      {error ? (
        <Callout tone="danger" live="assertive">
          {error}
        </Callout>
      ) : null}
      <ul className="grid gap-2">
        {notes.map((note) => (
          <li
            key={note.notePublicId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line bg-surface-sunken px-3 py-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-semibold text-ink">{note.noteNumber}</span>
              <span className="text-muted">·</span>
              <MinorAmount minor={note.refundAmountMinor} currency={note.currency} />
              <span className="text-muted">·</span>
              <span className="text-muted">
                <DateTime value={note.issuedAt} format="date" />
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
              loading={busyId === note.notePublicId}
              aria-label={`Refund note PDF (${note.noteNumber})`}
              onClick={() => void handleDownload(note)}
            >
              Refund note PDF
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResendReceiptButton({
  receiptPublicId,
  receiptNumber,
  onResent,
  onError,
}: {
  receiptPublicId: string;
  receiptNumber: string;
  onResent?: () => void | Promise<void>;
  onError: (message: string | null) => void;
}) {
  const trpc = useTRPC();
  const toast = useToast();
  const resend = useMutation(trpc.compliance.receipts.admin.resend.mutationOptions());

  async function handleResend() {
    onError(null);
    try {
      await resend.mutateAsync({ receiptPublicId });
      toast.show({
        tone: "success",
        title: "Receipt email queued",
        description: `${receiptNumber} will be sent to the customer.`,
      });
      await onResent?.();
    } catch (err) {
      onError(errorMessage(err, "Could not resend payment receipt."));
    }
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      leadingIcon={<Mail className="h-3.5 w-3.5" aria-hidden="true" />}
      loading={resend.isPending}
      aria-label={`Send again (${receiptNumber})`}
      onClick={() => void handleResend()}
    >
      Send again
    </Button>
  );
}

function ReceiptCard({
  receipt,
  area,
  showOrder,
  onResent,
}: {
  receipt: ReceiptSummaryView | AdminReceiptSummaryView;
  area: "customer" | "console";
  showOrder: boolean;
  onResent?: () => void | Promise<void>;
}) {
  const [downloading, setDownloading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const detailHref =
    area === "console"
      ? `/admin/receipts/${encodeURIComponent(receipt.receiptPublicId)}`
      : `/receipts/${encodeURIComponent(receipt.receiptPublicId)}`;

  const adminFields = "resendCount" in receipt ? receipt : null;

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    setActionError(null);
    try {
      await downloadReceiptPdf(receipt.receiptPublicId, receipt.receiptNumber);
    } catch (err) {
      setActionError(errorMessage(err, "Unable to download receipt PDF."));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card
      title={
        <Link
          href={detailHref}
          className="inline-flex min-h-6 items-center py-0.5 font-mono text-action underline underline-offset-2"
        >
          {receipt.receiptNumber}
        </Link>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <ReceiptRefundBadge state={receipt.refundState} />
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
            loading={downloading}
            aria-label={`Download PDF (${receipt.receiptNumber})`}
            onClick={() => void handleDownload()}
          >
            Download PDF
          </Button>
          {area === "console" ? (
            <ResendReceiptButton
              receiptPublicId={receipt.receiptPublicId}
              receiptNumber={receipt.receiptNumber}
              onResent={onResent}
              onError={setActionError}
            />
          ) : null}
        </div>
      }
    >
      {actionError ? (
        <div className="mb-3">
          <Callout tone="danger" live="assertive">
            {actionError}
          </Callout>
        </div>
      ) : null}
      <KeyValueList
        columns={3}
        items={[
          ...(showOrder
            ? [
                {
                  label: "Order",
                  value:
                    area === "console" ? (
                      <Link
                        href={`/admin/orders/${encodeURIComponent(receipt.orderPublicId)}`}
                        className="font-mono break-all text-action underline underline-offset-2"
                      >
                        {receipt.orderReference}
                      </Link>
                    ) : (
                      <Link
                        href={`/orders/${encodeURIComponent(receipt.orderPublicId)}`}
                        className="font-mono break-all text-action underline underline-offset-2"
                      >
                        {receipt.orderReference}
                      </Link>
                    ),
                },
              ]
            : []),
          ...(showOrder && receipt.projectName?.trim()
            ? [
                {
                  label: "Project",
                  value: <span className="break-words">{receipt.projectName.trim()}</span>,
                },
              ]
            : []),
          { label: "Issued", value: <DateTime value={receipt.issuedAt} format="date" /> },
          {
            label: "Payment method",
            value: receipt.paymentMethodSummary || formatReceiptMethodSummary(receipt),
          },
          {
            label: "Amount paid",
            value: <MinorAmount minor={receipt.amountPaidMinor} currency={receipt.currency} />,
          },
          ...(receipt.amountWaivedMinor > 0
            ? [
                {
                  label: "Amount waived",
                  value: <MinorAmount minor={receipt.amountWaivedMinor} currency={receipt.currency} />,
                },
              ]
            : []),
          ...(receipt.refundedMinor > 0
            ? [
                {
                  label: "Refunded",
                  value: <MinorAmount minor={receipt.refundedMinor} currency={receipt.currency} />,
                },
              ]
            : []),
          ...(adminFields
            ? [
                {
                  label: "Email delivery",
                  value: adminFields.lastResentAt ? (
                    <span>
                      Resent {adminFields.resendCount}× (last <DateTime value={adminFields.lastResentAt} />)
                    </span>
                  ) : adminFields.emailedAt ? (
                    <span>
                      Sent <DateTime value={adminFields.emailedAt} />
                    </span>
                  ) : (
                    <span className="text-muted">Not emailed</span>
                  ),
                },
              ]
            : []),
        ]}
      />
      <RefundNotesList notes={receipt.refundNotes} />
    </Card>
  );
}

export function ReceiptList({
  items,
  area = "customer",
  showOrder = true,
  emptyDescription = "Confirmed payment receipts will appear here.",
  onResent,
}: {
  items: readonly (ReceiptSummaryView | AdminReceiptSummaryView)[];
  area?: "customer" | "console";
  showOrder?: boolean;
  emptyDescription?: string;
  onResent?: () => void | Promise<void>;
}) {
  if (!items.length) {
    return <EmptyState icon={ReceiptText} title="No receipts yet" description={emptyDescription} />;
  }
  return (
    <ul className="grid gap-3">
      {items.map((receipt) => (
        <li key={receipt.receiptPublicId}>
          <ReceiptCard receipt={receipt} area={area} showOrder={showOrder} onResent={onResent} />
        </li>
      ))}
    </ul>
  );
}

export function CustomerReceiptsPanel() {
  const trpc = useTRPC();
  const receipts = useInfiniteQuery(
    trpc.compliance.receipts.myList.infiniteQueryOptions(
      { limit: 25 },
      { getNextPageParam: (page) => page.nextCursor ?? undefined },
    ),
  );
  if (receipts.isPending) return <Skeleton lines={4} />;
  if (receipts.isError && !receipts.data) {
    return <ErrorState title="We couldn't load receipts" onRetry={() => void receipts.refetch()} />;
  }
  const items = receipts.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="space-y-4">
      <ReceiptList items={items} area="customer" showOrder />
      {receipts.isFetchNextPageError ? (
        <Callout tone="danger" live="polite">
          Couldn&apos;t load more receipts. Try again.
        </Callout>
      ) : null}
      <LoadMore
        hasMore={receipts.hasNextPage}
        loading={receipts.isFetchingNextPage}
        onLoadMore={() => void receipts.fetchNextPage()}
        label="Load more receipts"
      />
    </div>
  );
}

export function CustomerOrderReceiptsSection({ orderId }: { orderId: string }) {
  const trpc = useTRPC();
  const receipts = useQuery(
    trpc.compliance.receipts.forOrder.queryOptions(
      { orderPublicId: orderId },
      { retry: false },
    ),
  );
  if (receipts.isPending) return null;
  if (receipts.isError) {
    const code = safeError(receipts.error)?.domainCode;
    // Generic order collaborators without billing access get FORBIDDEN/NOT_FOUND: omit receipt UI cleanly.
    if (code === "FORBIDDEN" || code === "NOT_FOUND") return null;
    return <ErrorState title="We couldn't load receipts for this order" onRetry={() => void receipts.refetch()} />;
  }
  if (!receipts.data.length) return null;
  return (
    <Section title="Payment receipts">
      <ReceiptList items={receipts.data} area="customer" showOrder={false} />
    </Section>
  );
}

export function ConsoleOrderReceiptsSection({ orderId }: { orderId: string }) {
  const trpc = useTRPC();
  const canRead = useCan("invoices.read_all");
  const receipts = useQuery(
    trpc.compliance.receipts.admin.forOrder.queryOptions(
      { orderPublicId: orderId },
      { enabled: canRead },
    ),
  );
  if (!canRead) return null;
  if (receipts.isPending) return <Skeleton lines={2} />;
  if (receipts.isError) {
    return <ErrorState title="We couldn't load receipts for this order" onRetry={() => void receipts.refetch()} />;
  }
  return (
    <Section title="Payment receipts">
      <ReceiptList
        items={receipts.data}
        area="console"
        showOrder={false}
        emptyDescription="Confirmed payments for this order generate numbered receipts here."
        onResent={() => receipts.refetch().then(() => undefined)}
      />
    </Section>
  );
}

export function CustomerReceiptsTab({ customerId }: { customerId: string }) {
  const trpc = useTRPC();
  const receipts = useInfiniteQuery(
    trpc.compliance.receipts.admin.forCustomer.infiniteQueryOptions(
      { customerPublicId: customerId, limit: 25 },
      { getNextPageParam: (page) => page.nextCursor ?? undefined },
    ),
  );
  if (receipts.isPending) return <Skeleton lines={4} />;
  if (receipts.isError && !receipts.data) {
    return <ErrorState title="Could not load customer receipts" onRetry={() => void receipts.refetch()} />;
  }
  const items = receipts.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="space-y-4">
      <ReceiptList
        items={items}
        area="console"
        showOrder
        emptyDescription="Confirmed payment receipts for this customer will appear here."
        onResent={() => receipts.refetch().then(() => undefined)}
      />
      <LoadMore
        hasMore={receipts.hasNextPage}
        loading={receipts.isFetchingNextPage}
        onLoadMore={() => void receipts.fetchNextPage()}
        label="Load more receipts"
      />
    </div>
  );
}

function ReceiptDetailBody({
  receipt,
  area,
  onResent,
}: {
  receipt: ReceiptDetailView;
  area: "customer" | "console";
  onResent: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const toast = useToast();
  const resend = useMutation(trpc.compliance.receipts.admin.resend.mutationOptions());
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      await downloadReceiptPdf(receipt.receiptPublicId, receipt.receiptNumber);
    } catch (err) {
      setError(errorMessage(err, "Unable to download receipt PDF."));
    } finally {
      setDownloading(false);
    }
  }

  async function handleResend() {
    setError(null);
    try {
      await resend.mutateAsync({ receiptPublicId: receipt.receiptPublicId });
      toast.show({
        tone: "success",
        title: "Receipt email queued",
        description: `${receipt.receiptNumber} will be sent to the customer.`,
      });
      await onResent();
    } catch (err) {
      setError(errorMessage(err, "Could not resend payment receipt."));
    }
  }

  const snap = receipt.snapshot;
  const projectLabel = receipt.projectName?.trim() || snap.projectName?.trim() || null;
  const amount = (minor: number) => <MinorAmount minor={minor} currency={receipt.currency} />;
  const backHref = area === "console" ? `/admin/orders/${encodeURIComponent(receipt.orderPublicId)}` : "/invoices";
  const backLabel = area === "console" ? `Order ${receipt.orderReference}` : "Invoices & receipts";
  const orderHref = area === "console" ? `/admin/orders/${encodeURIComponent(receipt.orderPublicId)}` : `/orders/${encodeURIComponent(receipt.orderPublicId)}`;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ href: backHref, label: backLabel }, { label: receipt.receiptNumber }]} />}
        title={`Receipt ${receipt.receiptNumber}`}
        description={projectLabel ? `Order ${receipt.orderReference} · ${projectLabel}` : `Order ${receipt.orderReference}`}
        meta={<ReceiptRefundBadge state={receipt.refundState} />}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              leadingIcon={<Download aria-hidden="true" />}
              loading={downloading}
              onClick={() => void handleDownload()}
            >
              Download PDF
            </Button>
            {area === "console" && receipt.canResend ? (
              <Button
                variant="secondary"
                leadingIcon={<Mail aria-hidden="true" />}
                loading={resend.isPending}
                onClick={() => void handleResend()}
              >
                Send again
              </Button>
            ) : null}
          </div>
        }
      />
      {error ? (
        <Callout tone="danger" live="assertive">
          {error}
        </Callout>
      ) : null}
      {receipt.refundState !== "none" ? (
        <Callout tone="info" title={receipt.refundState === "refunded" ? "Payment refunded" : "Payment partially refunded"}>
          The original receipt PDF remains unchanged as a permanent payment record. Separate numbered refund notes are attached below.
        </Callout>
      ) : null}
      <Card title="Order & project">
        <KeyValueList
          columns={2}
          items={[
            {
              label: "Order",
              value: (
                <Link
                  href={orderHref}
                  className="font-mono font-semibold break-all text-action underline underline-offset-2"
                >
                  {receipt.orderReference}
                </Link>
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
          ]}
        />
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Issued by">
          <KeyValueList
            columns={1}
            items={[
              { label: "Company", value: snap.company.legalName },
              ...(snap.company.address ? [{ label: "Address", value: <span className="whitespace-pre-wrap">{snap.company.address}</span> }] : []),
              ...(snap.company.contact ? [{ label: "Contact", value: snap.company.contact }] : []),
              ...(snap.company.taxId ? [{ label: "Tax ID", value: snap.company.taxId }] : []),
            ]}
          />
        </Card>
        <Card title="Billed to">
          <KeyValueList
            columns={1}
            items={[
              { label: "Customer", value: snap.customer.name },
              { label: "Email", value: snap.customer.email },
              ...(snap.customer.customerRef ? [{ label: "Customer reference", value: snap.customer.customerRef }] : []),
              { label: "Issued on", value: <DateTime value={receipt.issuedAt} /> },
            ]}
          />
        </Card>
      </div>
      <Card title="Payment summary">
        <KeyValueList
          columns={3}
          items={[
            { label: "Payment method", value: receipt.paymentMethodSummary || formatReceiptMethodSummary(receipt) },
            { label: "Subtotal", value: amount(receipt.subtotalMinor) },
            ...(receipt.bundleDiscountMinor > 0
              ? [{ label: snap.discountLabel ?? "Bundle discount", value: amount(receipt.bundleDiscountMinor) }]
              : []),
            ...(receipt.promoDiscountMinor > 0
              ? [{ label: receipt.promoLabel ? `Discount (${receipt.promoLabel})` : "Code discount", value: amount(receipt.promoDiscountMinor) }]
              : receipt.discountMinor > 0 && receipt.bundleDiscountMinor === 0
                ? [{ label: snap.discountLabel ?? "Discount", value: amount(receipt.discountMinor) }]
                : []),
            { label: "Tax", value: amount(receipt.taxMinor) },
            ...(receipt.amountWaivedMinor > 0 ? [{ label: "Amount waived", value: amount(receipt.amountWaivedMinor) }] : []),
            { label: "Amount paid", value: amount(receipt.amountPaidMinor) },
            ...(receipt.refundedMinor > 0 ? [{ label: "Refunded", value: amount(receipt.refundedMinor) }] : []),
          ]}
        />
      </Card>
      <Section title="Items">
        {snap.lines.length ? (
          <ul className="grid gap-3">
            {snap.lines.map((line, index) => (
              <li key={`${line.position}:${index}`}>
                <Card title={line.description} headingLevel={3}>
                  <KeyValueList
                    columns={3}
                    items={[
                      { label: "Quantity", value: line.quantity },
                      { label: "Unit price", value: amount(line.unitAmountMinor) },
                      { label: "Line total", value: amount(line.lineTotalMinor) },
                    ]}
                  />
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body">No line items recorded.</p>
        )}
      </Section>
      {receipt.refundNotes.length ? (
        <Section title="Refund notes">
          <Card>
            <RefundNotesList notes={receipt.refundNotes} />
          </Card>
        </Section>
      ) : null}
    </div>
  );
}

function ReceiptUnavailable({ area }: { area: "customer" | "console" }) {
  return (
    <>
      <PageHeader title="Receipt" />
      <EmptyState
        title="Receipt not available"
        action={
          <Button asChild variant="secondary">
            <Link href={area === "console" ? "/admin/invoices" : "/invoices"}>Back to billing</Link>
          </Button>
        }
      />
    </>
  );
}

function ReceiptDetailQuery({ receiptId, area }: { receiptId: string; area: "customer" | "console" }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.compliance.receipts.get.queryOptions({ receiptPublicId: receiptId }));
  if (query.isPending) {
    return (
      <>
        <PageHeader title="Receipt" />
        <Skeleton lines={4} />
      </>
    );
  }
  if (query.isError) {
    if (safeError(query.error)?.domainCode === "NOT_FOUND") {
      return <ReceiptUnavailable area={area} />;
    }
    return (
      <>
        <PageHeader title="Receipt" />
        <ErrorState title="We couldn't load this receipt" onRetry={() => void query.refetch()} />
      </>
    );
  }
  return (
    <ReceiptDetailBody
      receipt={query.data}
      area={area}
      onResent={async () => {
        await query.refetch();
      }}
    />
  );
}

export function ReceiptDetailPage() {
  const { receiptId } = useParams<{ receiptId: string }>();
  if (!receiptId || !ULID_RE.test(receiptId)) return <ReceiptUnavailable area="customer" />;
  return <ReceiptDetailQuery key={receiptId} receiptId={receiptId} area="customer" />;
}

export function AdminReceiptDetailPage() {
  const { receiptId } = useParams<{ receiptId: string }>();
  if (!receiptId || !ULID_RE.test(receiptId)) return <ReceiptUnavailable area="console" />;
  return <ReceiptDetailQuery key={receiptId} receiptId={receiptId} area="console" />;
}

export function CompanyProfileDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const guarded = useGuardedAction();
  const profile = useQuery(trpc.compliance.invoices.admin.companyProfile.get.queryOptions());
  const update = useMutation(trpc.compliance.invoices.admin.companyProfile.update.mutationOptions());

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Company billing profile"
      description="Shown on newly issued invoices, payment receipts, and refund notes. Existing issued receipts keep their original snapshot."
    >
      {profile.isPending ? (
        <Skeleton lines={5} />
      ) : profile.isError ? (
        <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />
      ) : (
        <CompanyProfileForm
          initial={profile.data}
          saving={update.isPending}
          onCancel={onClose}
          onSave={async (next) => {
            const res = await guarded(
              () => update.mutateAsync(next),
              { reason: "Updating company billing details requires verification.", success: "Company profile saved" },
            );
            if (!res.ok) return res.error;
            await queryClient.invalidateQueries({ queryKey: trpc.compliance.invoices.admin.companyProfile.get.queryKey() });
            onClose();
            return null;
          }}
        />
      )}
    </Dialog>
  );
}

const BRAND_LOGO_OPTIONS = [
  {
    value: "/brand/readypackets-approved-header-icon-light.png",
    label: "Approved header brand mark (light, default)",
  },
  {
    value: "/brand/readypackets-approved-header-wordmark-light.png",
    label: "Approved header wordmark (light)",
  },
  {
    value: "/brand/readypackets-approved-icon-light-192.png",
    label: "Approved icon 192px (light)",
  },
  {
    value: "/brand/readypackets-approved-icon-light-512.png",
    label: "Approved icon 512px (light)",
  },
  {
    value: "/brand/readypackets-approved-icon-maskable-192.png",
    label: "Approved maskable icon 192px",
  },
  {
    value: "/brand/readypackets-approved-icon-maskable-512.png",
    label: "Approved maskable icon 512px",
  },
] as const;

type BrandLogoPath = (typeof BRAND_LOGO_OPTIONS)[number]["value"];

interface CompanyProfileData {
  issuerName: string;
  issuerAddress: string;
  issuerContact: string;
  issuerTaxId: string;
  issuerLogo: {
    mode: "brand" | "none";
    brandPath: BrandLogoPath;
  };
  paymentInstructions: string;
}

function CompanyProfileForm({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  initial: CompanyProfileData;
  saving: boolean;
  onCancel: () => void;
  onSave: (next: CompanyProfileData) => Promise<string | null>;
}) {
  const [issuerName, setIssuerName] = useState(initial.issuerName);
  const [issuerAddress, setIssuerAddress] = useState(initial.issuerAddress);
  const [issuerContact, setIssuerContact] = useState(initial.issuerContact);
  const [issuerTaxId, setIssuerTaxId] = useState(initial.issuerTaxId);
  const [logoMode, setLogoMode] = useState<"brand" | "none">(initial.issuerLogo.mode);
  const [logoBrandPath, setLogoBrandPath] = useState<BrandLogoPath>(initial.issuerLogo.brandPath);
  const [paymentInstructions, setPaymentInstructions] = useState(initial.paymentInstructions);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!issuerName.trim()) {
      setError("Enter your company legal name.");
      return;
    }
    setError(null);
    const err = await onSave({
      issuerName: issuerName.trim(),
      issuerAddress: issuerAddress.trim(),
      issuerContact: issuerContact.trim(),
      issuerTaxId: issuerTaxId.trim(),
      issuerLogo: {
        mode: logoMode,
        brandPath: logoBrandPath,
      },
      paymentInstructions: paymentInstructions.trim(),
    });
    if (err) setError(err);
  };

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4">
      {error ? (
        <Callout tone="danger" live="assertive">
          {error}
        </Callout>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Legal company name" required>
          <Input value={issuerName} onChange={(e) => setIssuerName(e.target.value)} maxLength={160} />
        </Field>
        <Field label="Tax or registration ID" hint="Optional, e.g. EIN or VAT number.">
          <Input value={issuerTaxId} onChange={(e) => setIssuerTaxId(e.target.value)} maxLength={80} />
        </Field>
      </div>
      <Field label="Billing address" hint="Street, city, region, postal code, and country.">
        <Textarea value={issuerAddress} onChange={(e) => setIssuerAddress(e.target.value)} rows={3} maxLength={400} />
      </Field>
      <Field label="Billing contact" hint="Support email, phone, or billing URL shown on PDFs.">
        <Input value={issuerContact} onChange={(e) => setIssuerContact(e.target.value)} maxLength={240} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="PDF header logo">
          <Select
            options={[
              { value: "brand", label: "Embed approved brand logo" },
              { value: "none", label: "Wordmark text only (no image)" },
            ]}
            value={logoMode}
            onChange={(e) => setLogoMode(e.target.value as "brand" | "none")}
          />
        </Field>
        {logoMode === "brand" ? (
          <Field label="Brand logo asset">
            <Select
              options={[...BRAND_LOGO_OPTIONS]}
              value={logoBrandPath}
              onChange={(e) => setLogoBrandPath(e.target.value as BrandLogoPath)}
            />
          </Field>
        ) : null}
      </div>
      <Field label="Offline payment instructions" hint="Optional instructions shown on unpaid invoices.">
        <Textarea
          value={paymentInstructions}
          onChange={(e) => setPaymentInstructions(e.target.value)}
          rows={2}
          maxLength={1000}
        />
      </Field>
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          Save company profile
        </Button>
      </div>
    </form>
  );
}

export default ReceiptDetailPage;
