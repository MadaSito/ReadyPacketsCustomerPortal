/**
 * Responsive data table. ≥md: a real <table> with caption, column headers (scope=col) and optional
 * sortable headers (aria-sort). <md: the same rows as a list of stacked, labelled cards (<dl>), so nothing
 * scrolls horizontally at 320 px. Both renderings are in the DOM; CSS shows one (screen readers see one).
 */
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { EmptyState, ErrorState, Skeleton } from "./Feedback";

export interface Column<Row> {
  /** Stable key (also the sort key passed to onSortChange). */
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  /** Allow sorting by this column (server-side allowlisted key). */
  sortable?: boolean;
  align?: "start" | "end";
  /** Hide in the stacked mobile card (e.g. redundant with the card title). */
  hideOnMobile?: boolean;
  /** Use as the bold card heading on mobile (one column). */
  primary?: boolean;
  /** Tailwind width hint for the desktop column (e.g. "w-40"). */
  className?: string;
}

export interface SortState {
  key: string;
  direction: "asc" | "desc";
}

export interface DataTableProps<Row> {
  /** Visible or sr-only caption naming the table (required for AT). */
  caption: string;
  showCaption?: boolean;
  columns: readonly Column<Row>[];
  rows: readonly Row[] | undefined;
  rowKey: (row: Row) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Rendered when rows is an empty array. */
  empty?: ReactNode;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  /** Per-row actions (buttons/menus) shown in the last column / card footer. */
  rowActions?: (row: Row) => ReactNode;
  /** Optional link-like primary action rendered by the primary column cell; keep cells focusable via <Link>. */
  className?: string;
}

function SortIcon({ active, direction }: { active: boolean; direction?: "asc" | "desc" }) {
  if (!active) return <ArrowUpDown aria-hidden="true" className="size-3.5 opacity-60" />;
  return direction === "asc" ? <ArrowUp aria-hidden="true" className="size-3.5" /> : <ArrowDown aria-hidden="true" className="size-3.5" />;
}

export function DataTable<Row>({ caption, showCaption, columns, rows, rowKey, loading, error, onRetry, empty, sort, onSortChange, rowActions, className }: DataTableProps<Row>) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading && !rows) {
    return (
      <div role="status" aria-label={`Loading ${caption}`} className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
        <span className="sr-only">Loading {caption}</span>
      </div>
    );
  }
  if (rows && rows.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" description="When there are items, they will appear here." />}</>;
  const list = rows ?? [];
  const primary = columns.find((c) => c.primary) ?? columns[0];

  return (
    <div className={cn("min-w-0", className)} aria-busy={loading || undefined}>
      {/* Desktop / tablet table */}
      <div className="hidden overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)] md:block rp-forced-border">
        <table className="w-full border-collapse text-left text-sm">
          <caption className={cn(showCaption ? "px-4 py-3 text-left text-sm font-semibold text-ink" : "sr-only")}>{caption}</caption>
          <thead className="bg-surface-soft">
            <tr>
              {columns.map((col) => {
                const active = sort?.key === col.key;
                const ariaSort = active ? (sort?.direction === "asc" ? "ascending" : "descending") : col.sortable ? "none" : undefined;
                return (
                  <th key={col.key} scope="col" aria-sort={ariaSort} className={cn("border-b border-line px-4 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase", col.align === "end" && "text-right", col.className)}>
                    {col.sortable && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => onSortChange({ key: col.key, direction: active && sort?.direction === "asc" ? "desc" : "asc" })}
                        className={cn("-mx-2 inline-flex min-h-9 items-center gap-1 rounded px-2 uppercase hover:text-ink", active && "text-ink")}
                      >
                        {col.header}
                        <SortIcon active={active} direction={sort?.direction} />
                        <span className="sr-only">{active ? `, sorted ${ariaSort}` : ", activate to sort"}</span>
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
              {rowActions ? (
                <th scope="col" className="border-b border-line px-4 py-2.5 text-right text-xs font-semibold tracking-wide text-muted uppercase">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {list.map((row) => (
              <tr key={rowKey(row)} className="border-b border-line last:border-b-0 hover:bg-surface-soft">
                {columns.map((col) => (
                  <td key={col.key} className={cn("px-4 py-3 align-middle text-ink", col.align === "end" && "text-right tabular-nums")}>
                    {col.cell(row)}
                  </td>
                ))}
                {rowActions ? <td className="px-4 py-2 text-right whitespace-nowrap">{rowActions(row)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked cards */}
      <ul aria-label={caption} className="flex flex-col gap-3 md:hidden">
        {list.map((row) => (
          <li key={rowKey(row)} className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)] rp-forced-border">
            {primary ? <div className="mb-2 text-[0.9375rem] font-semibold break-words text-ink">{primary.cell(row)}</div> : null}
            <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1.5 text-sm">
              {columns
                .filter((col) => col !== primary && !col.hideOnMobile)
                .map((col) => (
                  <div key={col.key} className="contents">
                    <dt className="text-muted">{col.header}</dt>
                    <dd className="min-w-0 break-words text-ink">{col.cell(row)}</dd>
                  </div>
                ))}
            </dl>
            {rowActions ? <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">{rowActions(row)}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
