import { AlertCircle, CheckCircle2, Clock, History } from "lucide-react";
import { Badge, DateTime, type SelectOption } from "@/ui";
import type {
  AcceptanceFreshness,
  AcceptanceLogMethod,
  AcceptanceLogSource,
  CustomerPolicyRequirementState,
  PolicyAudience,
} from "./types";

function pad2(num: number): string {
  return String(num).padStart(2, "0");
}

/** Formats a Date or ISO timestamp into explicit UTC text (`YYYY-MM-DD HH:MM UTC`). */
export function formatUtcTimestamp(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  const year = date.getUTCFullYear();
  const month = pad2(date.getUTCMonth() + 1);
  const day = pad2(date.getUTCDate());
  const hours = pad2(date.getUTCHours());
  const minutes = pad2(date.getUTCMinutes());
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

/**
 * Renders a timestamp in the viewer's local time zone (`<DateTime />`) alongside its explicit UTC
 * representation so UTC is always inspectable on touch, keyboard, and 320 px viewports without hover.
 */
export function TimestampWithUtc({
  value,
  inline = false,
}: {
  value: Date | string | null | undefined;
  inline?: boolean;
}) {
  if (!value) return <span className="text-muted">—</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return <span className="text-muted">—</span>;
  return (
    <span
      className={
        inline
          ? "inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 gap-y-0.5"
          : "flex min-w-0 max-w-full flex-col gap-0.5"
      }
    >
      <DateTime value={date} format="datetime" className="break-words text-ink" />
      <span className="font-mono text-xs break-words text-muted">{formatUtcTimestamp(date)}</span>
    </span>
  );
}

export const SOURCE_OPTIONS: readonly SelectOption[] = [
  { value: "registration", label: "Registration" },
  { value: "portal_acceptance", label: "Account acceptance" },
  { value: "portal_reacceptance", label: "Re-acceptance" },
  { value: "checkout", label: "Checkout" },
  { value: "order_gate", label: "Order gate" },
  { value: "imported_historical", label: "Imported record" },
];

export const METHOD_OPTIONS: readonly SelectOption[] = [
  { value: "checkbox", label: "Tick box" },
  { value: "typed_signature", label: "Typed name" },
  { value: "imported", label: "Imported" },
];

export const FRESHNESS_OPTIONS: readonly SelectOption[] = [
  { value: "current", label: "Current version" },
  { value: "superseded", label: "Superseded version" },
];

export function formatAcceptanceSource(source: AcceptanceLogSource): string {
  switch (source) {
    case "registration":
      return "Registration";
    case "portal_acceptance":
      return "Account acceptance";
    case "portal_reacceptance":
      return "Re-acceptance";
    case "checkout":
      return "Checkout";
    case "order_gate":
      return "Order gate";
    case "imported_historical":
      return "Imported record";
  }
}

export function formatAcceptanceMethod(method: AcceptanceLogMethod): string {
  switch (method) {
    case "checkbox":
      return "Tick box";
    case "typed_signature":
      return "Typed name";
    case "imported":
      return "Imported";
  }
}

export function formatPolicyAudience(audience: PolicyAudience): string {
  switch (audience) {
    case "all":
      return "All users";
    case "customer":
      return "Customers";
    case "staff":
      return "Staff";
  }
}

export function FreshnessBadge({
  freshness,
  supersededByVersionLabel,
}: {
  freshness: AcceptanceFreshness;
  supersededByVersionLabel: string | null;
}) {
  if (freshness === "current") {
    return (
      <span className="inline-flex min-w-0 max-w-full" title="Current version">
        <Badge tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden="true" />}>
          Current
        </Badge>
      </span>
    );
  }
  return (
    <span
      className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
      title="Superseded version"
    >
      <Badge tone="warning" icon={<History className="size-3.5" aria-hidden="true" />}>
        Superseded
      </Badge>
      {supersededByVersionLabel ? (
        <span className="text-xs break-words text-muted">
          by version {supersededByVersionLabel}
        </span>
      ) : null}
    </span>
  );
}

export function RequirementStateBadge({ state }: { state: CustomerPolicyRequirementState }) {
  switch (state) {
    case "accepted_current":
      return (
        <span
          className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
          title="Accepted current version"
        >
          <Badge tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden="true" />}>
            Accepted
          </Badge>
          <span className="text-xs break-words text-muted">Current version</span>
        </span>
      );
    case "update_pending":
      return (
        <span
          className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
          title="Update pending"
        >
          <Badge tone="warning" icon={<AlertCircle className="size-3.5" aria-hidden="true" />}>
            Update pending
          </Badge>
          <span className="text-xs break-words text-muted">Update not yet accepted</span>
        </span>
      );
    case "not_accepted":
      return (
        <span
          className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
          title="Pending acceptance"
        >
          <Badge tone="warning" icon={<Clock className="size-3.5" aria-hidden="true" />}>
            Pending
          </Badge>
          <span className="text-xs break-words text-muted">Not yet accepted</span>
        </span>
      );
    case "not_required":
      return (
        <span className="inline-flex min-w-0 max-w-full" title="Not required">
          <Badge tone="neutral">Not required</Badge>
        </span>
      );
  }
}

const DATE_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseUtcDateInputStart(value: string): Date | undefined {
  const match = DATE_INPUT_RE.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
}

export function parseUtcDateInputExclusiveEnd(value: string): Date | undefined {
  const start = parseUtcDateInputStart(value);
  if (!start) return undefined;
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

export function downloadCsvFile(csv: string, filename: string, contentType = "text/csv; charset=utf-8"): void {
  const safeFilename = `${filename.replace(/\.csv$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-") || "policy-acceptances"}.csv`;
  const blob = new Blob([csv], { type: contentType });
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeFilename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    if (typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(url);
    }
  }
}
