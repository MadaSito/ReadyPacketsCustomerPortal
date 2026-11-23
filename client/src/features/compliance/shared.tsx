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

/**
 * Downloads a private invoice PDF through `sessionFetch` so both HttpOnly cookie sessions
 * and sandboxed preview header sessions work identically.
 */
export async function downloadInvoicePdf(invoicePublicId: string, invoiceNumber: string | null): Promise<void> {
  const response = await sessionFetch(
    apiUrl(`/api/compliance/invoices/${encodeURIComponent(invoicePublicId)}/pdf`),
    { method: "GET" },
  );
  if (!response.ok) {
    let message = "Unable to download invoice PDF.";
    try {
      const json = (await response.json()) as { error?: { message?: string } };
      if (json?.error?.message) message = json.error.message;
    } catch {
      // ignore non-JSON body
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const safeName = `${(invoiceNumber ?? `invoice-${invoicePublicId}`).replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`;
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
