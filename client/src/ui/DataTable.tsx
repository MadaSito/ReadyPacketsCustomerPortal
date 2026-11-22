/**
 * Responsive data table. ≥md: a real <table> with caption, column headers (scope=col) and optional
 * sortable headers (aria-sort). <md: the same rows as a list of stacked, labelled cards (<dl>), so nothing
 * scrolls horizontally at 320 px. Both renderings are in the DOM; CSS shows one (screen readers see one).
 */
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Minus } from "lucide-react";
import { Checkbox as RCheckbox } from "radix-ui";
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

/**
 * Optional row selection (e.g. "Export selected"). Keys are the same strings as `rowKey`. The table renders a
 * labelled checkbox per row (first column / card header), a "select all on this page" checkbox with the mixed
 * state, and a polite status "n of m selected". Selection of rows that are no longer listed is the owner's call.
 */
export interface DataTableSelection<Row> {
  selectedKeys: ReadonlySet<string>;
  onSelectedKeysChange: (next: Set<string>) => void;
  /** Accessible name per row checkbox, e.g. `Select workflow ${row.name}`. */
  rowLabel: (row: Row) => string;
  /** Rows that cannot be selected get a disabled checkbox. */
  isSelectable?: (row: Row) => boolean;
  /** Name of the items in the status text (default "rows"). */
  noun?: string;
}

function SelectBox({ label, checked, disabled, onChange }: { label: string; checked: boolean | "indeterminate"; disabled?: boolean; onChange: (next: boolean) => void }) {
  // The Radix root itself is the 44 x 44 CSS px hit area (WCAG 2.5.8 / 2.5.5); the 20 px box is only visual.
  return (
    <RCheckbox.Root
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(value) => onChange(value === true)}
      className="group -m-2.5 inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="inline-flex size-5 items-center justify-center rounded border-2 border-control-border bg-surface group-data-[state=checked]:border-action group-data-[state=checked]:bg-action group-data-[state=checked]:text-on-action group-data-[state=indeterminate]:border-action group-data-[state=indeterminate]:bg-action group-data-[state=indeterminate]:text-on-action">
        <RCheckbox.Indicator>{checked === "indeterminate" ? <Minus aria-hidden="true" className="size-3.5" strokeWidth={3} /> : <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />}</RCheckbox.Indicator>
      </span>
    </RCheckbox.Root>
  );
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
  selection?: DataTableSelection<Row>;
  /** Optional link-like primary action rendered by the primary column cell; keep cells focusable via <Link>. */
  className?: string;
}

function SortIcon({ active, direction }: { active: boolean; direction?: "asc" | "desc" }) {
  if (!active) return <ArrowUpDown aria-hidden="true" className="size-3.5 opacity-60" />;
  return direction === "asc" ? <ArrowUp aria-hidden="true" className="size-3.5" /> : <ArrowDown aria-hidden="true" className="size-3.5" />;
}

export function DataTable<Row>({ caption, showCaption, columns, rows, rowKey, loading, error, onRetry, empty, sort, onSortChange, rowActions, selection, className }: DataTableProps<Row>) {
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
  const sortable = onSortChange ? columns.filter((c) => c.sortable) : [];
  const selectableKeys = selection ? list.filter((r) => selection.isSelectable?.(r) ?? true).map(rowKey) : [];
  const selectedHere = selection ? selectableKeys.filter((k) => selection.selectedKeys.has(k)).length : 0;
  const allState: boolean | "indeterminate" = selectedHere === 0 ? false : selectedHere === selectableKeys.length ? true : "indeterminate";
  const toggleAll = (on: boolean) => {
    if (!selection) return;
    const next = new Set(selection.selectedKeys);
    for (const k of selectableKeys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    selection.onSelectedKeysChange(next);
  };
  const toggleRow = (key: string, on: boolean) => {
    if (!selection) return;
    const next = new Set(selection.selectedKeys);
    if (on) next.add(key);
    else next.delete(key);
    selection.onSelectedKeysChange(next);
  };
  const allLabel = `Select all ${selection?.noun ?? "rows"} on this page`;
  const rowBox = (row: Row) =>
    selection ? (
      <SelectBox label={selection.rowLabel(row)} checked={selection.selectedKeys.has(rowKey(row))} disabled={!(selection.isSelectable?.(row) ?? true)} onChange={(on) => toggleRow(rowKey(row), on)} />
    ) : null;

  return (
    <div className={cn("min-w-0", className)} aria-busy={loading || undefined}>
      {/* Desktop / tablet table */}
      {/* Focusable so keyboard users can scroll a wide table horizontally (WCAG 2.1.1; axe scrollable-region-focusable). */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div tabIndex={0} role="region" aria-label={`${caption} table`} className="relative hidden overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)] md:block rp-forced-border">
        <table className="w-full border-collapse text-left text-sm">
          <caption className={cn(showCaption ? "px-4 py-3 text-left text-sm font-semibold text-ink" : "sr-only")}>{caption}</caption>
          <thead className="bg-surface-soft">
            <tr>
              {selection ? (
                <th scope="col" className="w-12 border-b border-line py-2.5 pr-2 pl-4">
                  <SelectBox label={allLabel} checked={allState} disabled={selectableKeys.length === 0} onChange={toggleAll} />
                </th>
              ) : null}
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
              <tr key={rowKey(row)} data-selected={selection?.selectedKeys.has(rowKey(row)) ? "" : undefined} className="border-b border-line last:border-b-0 hover:bg-surface-soft data-selected:bg-surface-soft">
                {selection ? <td className="py-3 pr-2 pl-4 align-middle">{rowBox(row)}</td> : null}
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

      {/* Mobile sort controls: same sort state as the desktop headers. */}
      {sortable.length > 0 && onSortChange ? (
        <div className="mb-3 flex items-end gap-2 md:hidden">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-ink">
            Sort by
            <select
              value={sort && sortable.some((c) => c.key === sort.key) ? sort.key : ""}
              onChange={(e) => e.target.value && onSortChange({ key: e.target.value, direction: sort?.direction ?? "asc" })}
              className="min-h-11 w-full rounded-[var(--radius-control)] border border-control-border bg-surface px-3 text-[0.9375rem] text-ink"
            >
              {!sort || !sortable.some((c) => c.key === sort.key) ? <option value="">Default order</option> : null}
              {sortable.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.header}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!sort}
            onClick={() => sort && onSortChange({ key: sort.key, direction: sort.direction === "asc" ? "desc" : "asc" })}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border border-control-border bg-surface px-3 text-sm font-medium text-ink disabled:opacity-50"
          >
            <SortIcon active={Boolean(sort)} direction={sort?.direction} />
            {sort?.direction === "desc" ? "Descending" : "Ascending"}
            <span className="sr-only">, activate to reverse the order</span>
          </button>
        </div>
      ) : null}

      {selection ? (
        <>
          <div className="mb-3 flex min-h-11 items-center gap-3 px-1 md:hidden">
            <SelectBox label={allLabel} checked={allState} disabled={selectableKeys.length === 0} onChange={toggleAll} />
            <span aria-hidden="true" className="text-sm text-muted">
              Select all
            </span>
          </div>
          <p role="status" className="sr-only">
            {`${selectedHere} of ${selectableKeys.length} ${selection.noun ?? "rows"} selected`}
          </p>
        </>
      ) : null}

      {/* Mobile stacked cards */}
      <ul aria-label={caption} className="flex flex-col gap-3 md:hidden">
        {list.map((row) => (
          <li key={rowKey(row)} className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)] rp-forced-border">
            {primary || selection ? (
              <div className="mb-2 flex min-w-0 items-start gap-3">
                {selection ? <span className="shrink-0">{rowBox(row)}</span> : null}
                {primary ? <div className="min-w-0 flex-1 text-[0.9375rem] font-semibold break-words text-ink">{primary.cell(row)}</div> : null}
              </div>
            ) : null}
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
