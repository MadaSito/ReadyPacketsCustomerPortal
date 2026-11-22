/**
 * Printable acceptance receipt (package V). Owner: identity_engineer.
 * Customer: `/acceptance-receipts/:receiptId` (own receipts only). Console: `/admin/acceptance-receipts/:receiptId`.
 * The server decides who may read a receipt; it never contains the source address.
 */
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Printer } from "lucide-react";
import { Link, useParams } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Button, Card, DateTime, ErrorState, KeyValueList, PageHeader, Skeleton } from "@/ui";
import { signatureText } from "./AcceptancesTab";

function ReceiptPage({ area }: { area: "customer" | "console" }) {
  const { receiptId = "" } = useParams<{ receiptId: string }>();
  const trpc = useTRPC();
  const receipt = useQuery(trpc.compliance.acceptance.receipt.queryOptions({ receiptId }));
  const data = receipt.data;
  const orderHref = data ? (area === "console" ? `/admin/orders/${data.order.id}/acceptances` : `/orders/${data.order.id}`) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Policy acceptance receipt"
        description={data ? `${data.order.reference} · ${data.order.name}` : undefined}
        actions={
          <div className="rp-no-print flex flex-wrap items-center gap-2">
            {orderHref ? (
              <Button asChild variant="ghost" leadingIcon={<ArrowLeft className="h-4 w-4" aria-hidden />}>
                <Link href={orderHref}>Back to order</Link>
              </Button>
            ) : null}
            <Button variant="secondary" disabled={!data} leadingIcon={<Printer className="h-4 w-4" aria-hidden />} onClick={() => window.print()}>
              Print
            </Button>
          </div>
        }
      />
      {receipt.isPending ? (
        <div role="status"><span className="sr-only">Loading receipt</span><Skeleton lines={6} /></div>
      ) : receipt.isError ? (
        <ErrorState error={receipt.error} onRetry={() => void receipt.refetch()} />
      ) : data ? (
        <Card as="section" aria-label="Receipt details" title={signatureText(data)} className="rp-print-avoid-break">
          <KeyValueList
            items={[
              { label: "Receipt number", value: <span className="font-mono break-all">{data.receiptId}</span> },
              { label: "Order", value: `${data.order.reference} · ${data.order.name}` },
              { label: "Policy", value: `${data.policy.title}, version ${data.policy.versionLabel}` },
              { label: "Step", value: data.gateKey === "order_start" ? "Before work starts" : data.gateKey },
              { label: "Signature", value: data.signatureMode === "typed_name" ? `Typed name: ${data.typedName ?? ""}` : "Checkbox" },
              { label: "Account", value: data.signerName },
              { label: "Accepted", value: <DateTime value={data.acceptedAt} format="datetime" /> },
              { label: "Text fingerprint (SHA-256)", value: <span className="font-mono text-sm break-all">{data.textSha256}</span> },
            ]}
          />
          <p className="mt-4 text-sm text-muted">
            The fingerprint identifies the exact policy text that was shown when this acceptance was recorded.
          </p>
        </Card>
      ) : null}
    </div>
  );
}

export function CustomerAcceptanceReceiptPage() {
  return <ReceiptPage area="customer" />;
}
export function ConsoleAcceptanceReceiptPage() {
  return <ReceiptPage area="console" />;
}
