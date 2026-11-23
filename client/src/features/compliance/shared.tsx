/**
 * Shared pure UI helpers and safe policy renderer for the compliance feature.
 * Zero raw HTML (`dangerouslySetInnerHTML`), zero inline color styles, semantic `@/ui` tokens only.
 */
import { AlertCircle, Ban, CheckCircle2, Clock, FileEdit, Receipt } from "lucide-react";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { SafePolicyText as SharedSafePolicyText } from "@/lib/agreementGate";
import { Badge } from "@/ui";

export { formatMinorToDecimalInput, parseDecimalToMinor } from "@/lib/moneyInput";

export type PolicyContentFormat = "plain_text" | "safe_markdown";
export type InvoiceStatus = "draft" | "issued" | "paid" | "void";
export type IntakeSubmissionStatus = "not_started" | "draft" | "submitted" | "returned_for_changes" | "accepted";

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ik-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  switch (status) {
    case "paid":
      return (
        <Badge tone="success" icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}>
          Paid
        </Badge>
      );
    case "issued":
      return (
        <Badge tone="info" icon={<Receipt className="h-3.5 w-3.5" aria-hidden="true" />}>
          Issued
        </Badge>
      );
    case "draft":
      return (
        <Badge tone="neutral" icon={<FileEdit className="h-3.5 w-3.5" aria-hidden="true" />}>
          Draft
        </Badge>
      );
    case "void":
      return (
        <Badge tone="warning" icon={<Ban className="h-3.5 w-3.5" aria-hidden="true" />}>
          Void
        </Badge>
      );
  }
}

export function IntakeStatusBadge({ status }: { status: IntakeSubmissionStatus }) {
  switch (status) {
    case "accepted":
      return (
        <Badge tone="success" icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}>
          Accepted
        </Badge>
      );
    case "submitted":
      return (
        <Badge tone="info" icon={<Clock className="h-3.5 w-3.5" aria-hidden="true" />}>
          Submitted for review
        </Badge>
      );
    case "returned_for_changes":
      return (
        <Badge tone="warning" icon={<AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />}>
          Changes requested
        </Badge>
      );
    case "draft":
      return (
        <Badge tone="neutral" icon={<FileEdit className="h-3.5 w-3.5" aria-hidden="true" />}>
          Draft saved
        </Badge>
      );
    case "not_started":
      return (
        <Badge tone="neutral" icon={<Clock className="h-3.5 w-3.5" aria-hidden="true" />}>
          Not started
        </Badge>
      );
  }
}

/**
 * Safe policy body renderer. Never interprets HTML or unsafe URLs.
 * Headings start at `h3` so page heading order (`h1` -> `h2` -> `h3`) stays strictly valid.
 */
export function SafePolicyText({
  bodyText,
  format,
}: {
  bodyText: string;
  format: PolicyContentFormat;
}) {
  return <SharedSafePolicyText bodyText={bodyText} format={format} />;
}

async function downloadCompliancePdf(path: string, fallbackMessage: string, baseFilename: string): Promise<void> {
  const response = await sessionFetch(apiUrl(path), { method: "GET" });
  if (!response.ok) {
    let message = fallbackMessage;
    try {
      const json = (await response.json()) as { error?: { message?: string } };
      if (json?.error?.message) message = json.error.message;
    } catch {
      // ignore non-JSON body
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const safeName = `${baseFilename.replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`;
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Downloads a private invoice PDF through `sessionFetch` so both HttpOnly cookie sessions
 * and sandboxed preview header sessions work identically.
 */
export async function downloadInvoicePdf(invoicePublicId: string, invoiceNumber: string | null): Promise<void> {
  return downloadCompliancePdf(
    `/api/compliance/invoices/${encodeURIComponent(invoicePublicId)}/pdf`,
    "Unable to download invoice PDF.",
    invoiceNumber ?? `invoice-${invoicePublicId}`,
  );
}

export async function downloadReceiptPdf(receiptPublicId: string, receiptNumber: string): Promise<void> {
  return downloadCompliancePdf(
    `/api/compliance/receipts/${encodeURIComponent(receiptPublicId)}/pdf`,
    "Unable to download payment receipt PDF.",
    receiptNumber || `receipt-${receiptPublicId}`,
  );
}

export async function downloadRefundNotePdf(notePublicId: string, noteNumber: string): Promise<void> {
  return downloadCompliancePdf(
    `/api/compliance/refund-notes/${encodeURIComponent(notePublicId)}/pdf`,
    "Unable to download refund note PDF.",
    noteNumber || `refund-note-${notePublicId}`,
  );
}

export type ReceiptRefundState = "none" | "partially_refunded" | "refunded";

export function ReceiptRefundBadge({ state }: { state: ReceiptRefundState }) {
  switch (state) {
    case "refunded":
      return <Badge tone="warning">Refunded</Badge>;
    case "partially_refunded":
      return <Badge tone="info">Partially refunded</Badge>;
    case "none":
      return (
        <Badge tone="success" icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}>
          Confirmed
        </Badge>
      );
  }
}

export function formatReceiptMethodSummary(item: {
  settlementKind: "provider_online" | "manual_payment" | "zero_total" | "waived_small_total";
  paymentMethod: string;
  paymentMethodBrand: string | null;
  paymentMethodLast4: string | null;
}): string {
  if (item.settlementKind === "zero_total") return "Discount covered full order ($0.00)";
  if (item.settlementKind === "waived_small_total") return "Small balance waived";
  if (item.paymentMethodBrand && item.paymentMethodLast4) {
    const brand = item.paymentMethodBrand.charAt(0).toUpperCase() + item.paymentMethodBrand.slice(1);
    return `${brand} ending in ${item.paymentMethodLast4}`;
  }
  if (item.paymentMethodLast4) return `Card ending in ${item.paymentMethodLast4}`;
  const labels: Record<string, string> = {
    provider_online: "Online card payment",
    bank_transfer: "Bank transfer",
    wire: "Wire transfer",
    ach: "ACH",
    check: "Check",
    card_manual: "Manual card",
    waiver: "Waived",
    other: "Recorded payment",
  };
  return labels[item.paymentMethod] ?? "Confirmed payment";
}
