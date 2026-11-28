/**
 * Formatting, date-range validation, CSV download, and safe error helpers for Package I (`reports`).
 */
import {
  CreditCard,
  FileAudio,
  LifeBuoy,
  Package,
  Share2,
  ShieldAlert,
  ShoppingCart,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage, safeError } from "@/lib/trpc";
import { DateTime, EmailLink, formatDateTime, Money } from "@/ui";
import {
  REPORT_LIMITS,
  type Aggregate,
  type Bucket,
  type BuiltInKey,
  type CatalogueBuiltInItem,
  type Cell,
  type ChartType,
  type ColumnView,
  type CsvResult,
  type FilterOp,
  type MetricView,
  type TableResult,
} from "./types";

export const BUILT_IN_META: Record<
  BuiltInKey,
  { icon: LucideIcon; defaultTitle: string; defaultDescription: string }
> = {
  orders: {
    icon: Package,
    defaultTitle: "Orders",
    defaultDescription:
      "Created and completed orders, breakdown by status, phase, workflow, product and tier, turnaround time, overdue orders, and revenue.",
  },
  customers: {
    icon: Users,
    defaultTitle: "Customers",
    defaultDescription:
      "New and active customers, lifecycle distribution, top customers by order volume and revenue, and policy acceptance standing.",
  },
  referrals: {
    icon: Share2,
    defaultTitle: "Referrals",
    defaultDescription:
      "Referral invitations sent, sign-ups attributed, paid conversions, and issued referral rewards.",
  },
  support: {
    icon: LifeBuoy,
    defaultTitle: "Support tickets",
    defaultDescription:
      "Tickets opened and closed, status, category and priority breakdown, time to first response, time to resolution, and backlog age.",
  },
  payments_discounts: {
    icon: CreditCard,
    defaultTitle: "Payments and discounts",
    defaultDescription:
      "Gross paid, refunded, and waived totals, breakdown by payment provider, discount code redemptions, and total discount granted.",
  },
  carts: {
    icon: ShoppingCart,
    defaultTitle: "Carts and upsells",
    defaultDescription:
      "Open, abandoned, and converted carts alongside cart upsell impressions and accepted suggestions.",
  },
  files_recordings: {
    icon: FileAudio,
    defaultTitle: "Files and recordings",
    defaultDescription:
      "Uploaded files and audio recordings, WebM/Opus conversion completions, and conversion failures.",
  },
  signins_security: {
    icon: ShieldAlert,
    defaultTitle: "Sign-ins and security",
    defaultDescription:
      "Successful sign-ins, failed sign-in steps across factors, and automatic or manual IP bans.",
  },
};

export const FALLBACK_BUILT_INS: CatalogueBuiltInItem[] = (
  Object.keys(BUILT_IN_META) as BuiltInKey[]
).map((key) => ({
  key,
  title: BUILT_IN_META[key].defaultTitle,
  description: BUILT_IN_META[key].defaultDescription,
}));

export const FILTER_OP_LABELS: Record<FilterOp, string> = {
  eq: "Equals",
  neq: "Does not equal",
  gt: "Greater than",
  gte: "At least (≥)",
  lt: "Less than",
  lte: "At most (≤)",
  between: "Between",
  in: "Is one of",
  contains: "Contains",
  startsWith: "Starts with",
  isNull: "Is empty",
  isNotNull: "Is not empty",
};

export const AGGREGATE_LABELS: Record<Aggregate, string> = {
  count: "Count rows",
  sum: "Sum",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
};

export const BUCKET_LABELS: Record<Bucket, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  table: "Table only",
  bar: "Bar chart",
  line: "Line chart",
  pie: "Breakdown donut",
};

const NUMBER_FMT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function humanizeCode(raw: string): string {
  if (!raw) return "—";
  if (/^[A-Z0-9-]{4,}$/.test(raw)) return raw;
  const spaced = raw.replace(/[_-]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : raw;
}

export function formatDurationSeconds(secondsInput: number): string {
  if (!Number.isFinite(secondsInput)) return "—";
  const totalSeconds = Math.max(0, Math.round(secondsInput));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const remSeconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return remSeconds > 0 ? `${totalMinutes}m ${remSeconds}s` : `${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 48) {
    return remMinutes > 0 ? `${totalHours}h ${remMinutes}m` : `${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function formatMoneyPlain(amountMinor: number, currency = "USD"): string {
  const code = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${code}`;
  }
}

export function resolveRowCurrency(
  col: ColumnView,
  row: readonly Cell[],
  columns: readonly ColumnView[],
): string {
  if (col.currency && /^[A-Z]{3}$/i.test(col.currency)) {
    return col.currency.toUpperCase();
  }
  const currencyIdx = columns.findIndex((c) => c.key === "currency");
  if (currencyIdx >= 0) {
    const cell = row[currencyIdx];
    if (typeof cell === "string" && /^[A-Z]{3}$/i.test(cell.trim())) {
      return cell.trim().toUpperCase();
    }
  }
  return "USD";
}

export function formatCellPlain(
  value: Cell,
  col: ColumnView,
  row: readonly Cell[],
  columns: readonly ColumnView[],
): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (col.type) {
    case "money": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return String(value);
      return formatMoneyPlain(Math.round(n), resolveRowCurrency(col, row, columns));
    }
    case "duration": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? formatDurationSeconds(n) : String(value);
    }
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? NUMBER_FMT.format(n) : String(value);
    }
    case "boolean":
      return value === true || value === "true" || value === 1 ? "Yes" : "No";
    case "datetime": {
      const raw = String(value);
      if (/^\d{4}-\d{2}(-\d{2})?$/.test(raw)) return raw;
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? raw : formatDateTime(d, "datetime");
    }
    case "enum":
      return humanizeCode(String(value));
    case "string":
    default:
      return String(value);
  }
}

export function renderCellNode(
  value: Cell,
  col: ColumnView,
  row: readonly Cell[],
  columns: readonly ColumnView[],
): ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted">—</span>;
  }
  switch (col.type) {
    case "money": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return String(value);
      return (
        <span className="tabular-nums">
          <Money
            value={{
              amountMinor: Math.round(n),
              currency: resolveRowCurrency(col, row, columns),
            }}
          />
        </span>
      );
    }
    case "duration": {
      const n = typeof value === "number" ? value : Number(value);
      return <span className="tabular-nums">{Number.isFinite(n) ? formatDurationSeconds(n) : String(value)}</span>;
    }
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return <span className="tabular-nums">{Number.isFinite(n) ? NUMBER_FMT.format(n) : String(value)}</span>;
    }
    case "boolean":
      return value === true || value === "true" || value === 1 ? "Yes" : "No";
    case "datetime": {
      const raw = String(value);
      if (/^\d{4}-\d{2}(-\d{2})?$/.test(raw)) {
        return <span className="tabular-nums">{raw}</span>;
      }
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return <span className="break-words">{raw}</span>;
      return <DateTime value={d} format="datetime" />;
    }
    case "enum":
      return <span className="break-words">{humanizeCode(String(value))}</span>;
    case "string":
    default: {
      const str = String(value);
      if (/(^|_|[a-z])email(Address)?$/i.test(col.key)) {
        return <EmailLink email={str} />;
      }
      return <span className="break-words">{str}</span>;
    }
  }
}

export function formatMetricValuePlain(metric: MetricView, value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    if (metric.type === "money" && metric.currency === null) {
      return "Multiple currencies";
    }
    return "—";
  }
  switch (metric.type) {
    case "money":
      return formatMoneyPlain(Math.round(value), metric.currency || "USD");
    case "duration":
      return formatDurationSeconds(value);
    case "number":
    default:
      return NUMBER_FMT.format(value);
  }
}

export function renderMetricValueNode(metric: MetricView): ReactNode {
  if (metric.value === null || metric.value === undefined || !Number.isFinite(metric.value)) {
    if (metric.type === "money" && metric.currency === null) {
      return <span className="text-base font-medium text-muted">Multiple currencies</span>;
    }
    return <span className="text-muted">—</span>;
  }
  if (metric.type === "money") {
    return (
      <Money
        value={{
          amountMinor: Math.round(metric.value),
          currency: metric.currency || "USD",
        }}
      />
    );
  }
  if (metric.type === "duration") {
    return formatDurationSeconds(metric.value);
  }
  return NUMBER_FMT.format(metric.value);
}

/**
 * Plain-language previous-period delta (never relies on colour alone).
 */
export function formatComparisonText(metric: MetricView, compareEnabled: boolean): string | null {
  if (!compareEnabled) {
    if (metric.type === "money" && metric.value === null && metric.currency === null) {
      return "See per-currency panel below.";
    }
    return null;
  }
  if (metric.value === null || metric.previous === null) {
    if (metric.type === "money" && metric.currency === null) {
      return "Mixed currencies — see per-currency panel below.";
    }
    return "Previous period unavailable";
  }
  const prevFormatted = formatMetricValuePlain(metric, metric.previous);
  const diff = metric.value - metric.previous;
  if (Math.abs(diff) < 1e-9) {
    return `Unchanged vs previous period (${prevFormatted})`;
  }
  if (metric.previous === 0) {
    const dir = diff > 0 ? "Up" : "Down";
    return `${dir} from ${prevFormatted} in previous period`;
  }
  const pct = ((diff / Math.abs(metric.previous)) * 100).toFixed(1);
  const dir = diff > 0 ? `Up +${pct}%` : `Down ${pct}%`;
  return `${dir} vs previous period (${prevFormatted})`;
}

export type DatePreset = "7d" | "30d" | "90d" | "ytd" | "365d" | "custom";

export const DATE_PRESET_OPTIONS: { value: DatePreset; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "ytd", label: "Year to date" },
  { value: "365d", label: "Last 365 days" },
  { value: "custom", label: "Custom dates" },
];

export function toIsoDateInput(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function computePresetDateStrings(
  preset: Exclude<DatePreset, "custom">,
  now: Date = new Date(),
): { fromDate: string; toDate: string } {
  const endUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (preset === "ytd") {
    const startYtd = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    return { fromDate: toIsoDateInput(startYtd), toDate: toIsoDateInput(endUtc) };
  }
  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : preset === "90d" ? 90 : 365;
  const startUtc = new Date(endUtc.getTime() - (days - 1) * 86_400_000);
  return { fromDate: toIsoDateInput(startUtc), toDate: toIsoDateInput(endUtc) };
}

export function parseReportDateRange(
  fromDate: string,
  toDate: string,
  maxRangeDays: number = REPORT_LIMITS.maxRangeDays,
):
  | { ok: true; from: Date; to: Date }
  | { ok: false; field: "from" | "to"; message: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    return { ok: false, field: "from", message: "Enter a valid start date (YYYY-MM-DD)." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return { ok: false, field: "to", message: "Enter a valid end date (YYYY-MM-DD)." };
  }
  const from = new Date(`${fromDate}T00:00:00.000Z`);
  const toInclusiveDayStart = new Date(`${toDate}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) {
    return { ok: false, field: "from", message: "Enter a valid start date." };
  }
  if (Number.isNaN(toInclusiveDayStart.getTime())) {
    return { ok: false, field: "to", message: "Enter a valid end date." };
  }
  if (toInclusiveDayStart.getTime() < from.getTime()) {
    return { ok: false, field: "to", message: "The end date must be on or after the start date." };
  }
  // Exclusive UTC end-of-day bound (`toDate + 1 day 00:00Z`) so single-day ranges satisfy `to > from`.
  const to = new Date(toInclusiveDayStart.getTime() + 86_400_000);
  if (to.getTime() - from.getTime() > maxRangeDays * 86_400_000) {
    return {
      ok: false,
      field: "from",
      message: `Choose a range of ${maxRangeDays} days (two years) or less.`,
    };
  }
  return { ok: true, from, to };
}

export function buildTableSummary(title: string, table: TableResult): string {
  if (table.rows.length === 0) {
    return `${title}: 0 rows matched.`;
  }
  const rowWord = table.rowCount === 1 ? "row" : "rows";
  const capNote = table.truncated ? " (capped at screen limit)" : "";
  const numericIdx = table.columns.findIndex(
    (c) => c.type === "number" || c.type === "money" || c.type === "duration",
  );
  const labelIdx = table.columns.findIndex((_, idx) => idx !== numericIdx);
  if (numericIdx >= 0 && table.rows.length > 0) {
    let bestRow = table.rows[0]!;
    let bestVal = Number(bestRow[numericIdx] ?? -Infinity);
    for (const r of table.rows) {
      const v = Number(r[numericIdx]);
      if (Number.isFinite(v) && v > bestVal) {
        bestVal = v;
        bestRow = r;
      }
    }
    if (Number.isFinite(bestVal)) {
      const metricCol = table.columns[numericIdx]!;
      const formattedVal = formatCellPlain(bestVal, metricCol, bestRow, table.columns);
      if (labelIdx >= 0) {
        const labelCol = table.columns[labelIdx]!;
        const formattedLabel = formatCellPlain(bestRow[labelIdx] ?? null, labelCol, bestRow, table.columns);
        return `${title}: ${table.rowCount} ${rowWord}${capNote}. Highest ${metricCol.label} is ${formattedVal} (${labelCol.label}: ${formattedLabel}).`;
      }
      return `${title}: ${table.rowCount} ${rowWord}${capNote}. Highest ${metricCol.label} is ${formattedVal}.`;
    }
  }
  return `${title}: ${table.rowCount} ${rowWord} across ${table.columns.length} ${table.columns.length === 1 ? "column" : "columns"}${capNote}.`;
}

export function downloadReportCsv(result: CsvResult): void {
  const blob = new Blob([result.csv], { type: result.contentType || "text/csv; charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = result.filename || "report.csv";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export interface ParsedReportError {
  reasonCode: string | null;
  title: string;
  message: string;
  specPath: string | null;
}

export function describeReportError(error: unknown): ParsedReportError {
  const safe = safeError(error) as
    | (ReturnType<typeof safeError> & {
        domainCode?: string;
        details?: Record<string, unknown>;
      })
    | undefined;
  const code = String(safe?.domainCode ?? safe?.reasonCode ?? "");
  const rawDetails = safe?.details;
  const specPath =
    rawDetails && typeof rawDetails === "object" && "path" in rawDetails && rawDetails.path
      ? Array.isArray(rawDetails.path)
        ? rawDetails.path.map(String).join(".")
        : String(rawDetails.path)
      : null;

  switch (code) {
    case "REPORT_BUSY":
      return {
        reasonCode: code,
        title: "Another report is currently running",
        message:
          safe?.safeMessage ||
          "Only one report can run at a time for your account. Wait a moment and try again.",
        specPath: null,
      };
    case "REPORT_RATE_LIMITED":
      return {
        reasonCode: code,
        title: "Report rate limit reached",
        message:
          safe?.safeMessage ||
          "Too many report runs in the last minute. Wait briefly before running another report.",
        specPath: null,
      };
    case "REPORT_TIMEOUT":
      return {
        reasonCode: code,
        title: "Report query timed out",
        message:
          safe?.safeMessage ||
          "Narrow the date range, add a filter, or lower the row limit and run the report again.",
        specPath: null,
      };
    case "REPORT_SPEC_INVALID":
      return {
        reasonCode: code,
        title: "Report definition needs adjustment",
        message: specPath
          ? `${safe?.safeMessage || "Invalid report field or filter"} (field: ${specPath}).`
          : safe?.safeMessage || "Check the selected dataset, columns, filters, and groupings.",
        specPath,
      };
    case "VERSION_CONFLICT":
      return {
        reasonCode: code,
        title: "Report was updated elsewhere",
        message:
          safe?.safeMessage ||
          "Reload this report to pick up the latest saved version before saving your changes.",
        specPath: null,
      };
    case "REPORT_NOT_FOUND":
      return {
        reasonCode: code,
        title: "Report not found",
        message: safe?.safeMessage || "This custom report does not exist or is no longer accessible.",
        specPath: null,
      };
    default:
      return {
        reasonCode: code || null,
        title: "Could not complete report action",
        message: errorMessage(error),
        specPath,
      };
  }
}
