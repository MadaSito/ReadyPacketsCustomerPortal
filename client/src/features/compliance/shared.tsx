/**
 * Shared pure UI helpers and safe policy renderer for the compliance feature.
 * Zero raw HTML (`dangerouslySetInnerHTML`), zero inline color styles, semantic `@/ui` tokens only.
 */
import { type ReactNode } from "react";
import { AlertCircle, Ban, CheckCircle2, Clock, FileEdit, Receipt } from "lucide-react";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
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
 * Renders inline `**bold**` and `` `code` `` segments into React nodes without HTML parsing.
 */
function renderInlineSafe(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={`b-${key++}`} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code key={`c-${key++}`} className="rounded-[var(--radius-control)] bg-surface-sunken px-1.5 py-0.5 text-ink">
          {token.slice(1, -1)}
        </code>,
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

/**
 * Safe policy body renderer. Never interprets HTML or external URLs.
 * Headings start at `h3` so page heading order (`h1` -> `h2` -> `h3`) stays strictly valid.
 */
export function SafePolicyText({
  bodyText,
  format,
}: {
  bodyText: string;
  format: PolicyContentFormat;
}) {
  if (format === "plain_text") {
    const paragraphs = bodyText.split(/\n{2,}/);
    return (
      <div className="flex flex-col gap-3 text-body break-words">
        {paragraphs.map((p, idx) => (
          <p key={idx} className="whitespace-pre-line leading-relaxed">
            {p}
          </p>
        ))}
      </div>
    );
  }

  const lines = bodyText.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const raw = lines[idx] ?? "";
    const trimmed = raw.trim();

    if (!trimmed) {
      idx++;
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      blocks.push(<hr key={`hr-${idx}`} className="border-line my-2" />);
      idx++;
      continue;
    }

    if (trimmed.startsWith("### ")) {
      blocks.push(
        <h5 key={`h5-${idx}`} className="mt-3 text-base font-semibold text-ink">
          {renderInlineSafe(trimmed.slice(4))}
        </h5>,
      );
      idx++;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      blocks.push(
        <h4 key={`h4-${idx}`} className="mt-4 text-lg font-semibold text-ink">
          {renderInlineSafe(trimmed.slice(3))}
        </h4>,
      );
      idx++;
      continue;
    }
    if (trimmed.startsWith("# ")) {
      blocks.push(
        <h3 key={`h3-${idx}`} className="mt-4 text-xl font-semibold text-ink">
          {renderInlineSafe(trimmed.slice(2))}
        </h3>,
      );
      idx++;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      const start = idx;
      while (idx < lines.length && /^[-*]\s+/.test((lines[idx] ?? "").trim())) {
        items.push((lines[idx] ?? "").trim().replace(/^[-*]\s+/, ""));
        idx++;
      }
      blocks.push(
        <ul key={`ul-${start}`} className="list-disc space-y-1 pl-6 text-body">
          {items.map((item, itemIdx) => (
            <li key={itemIdx}>{renderInlineSafe(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      const start = idx;
      while (idx < lines.length && /^\d+\.\s+/.test((lines[idx] ?? "").trim())) {
        items.push((lines[idx] ?? "").trim().replace(/^\d+\.\s+/, ""));
        idx++;
      }
      blocks.push(
        <ol key={`ol-${start}`} className="list-decimal space-y-1 pl-6 text-body">
          {items.map((item, itemIdx) => (
            <li key={itemIdx}>{renderInlineSafe(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const paraLines: string[] = [];
    const start = idx;
    while (
      idx < lines.length &&
      (lines[idx] ?? "").trim() !== "" &&
      !/^(#{1,3}\s+|[-*]\s+|\d+\.\s+|---+$)/.test((lines[idx] ?? "").trim())
    ) {
      paraLines.push(lines[idx] ?? "");
      idx++;
    }
    blocks.push(
      <p key={`p-${start}`} className="leading-relaxed text-body">
        {renderInlineSafe(paraLines.join(" "))}
      </p>,
    );
  }

  return <div className="flex flex-col gap-3 break-words">{blocks}</div>;
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
