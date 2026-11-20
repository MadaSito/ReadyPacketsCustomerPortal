/**
 * Filter toolbar for list/admin pages: search box + inline filters on desktop; on mobile the extra
 * filters move into a Drawer ("Filters (n)"). Submitting the search is explicit (Enter / button) so
 * screen readers are not flooded; result counts should be announced by the page via LoadMore summary.
 */
import { Search, SlidersHorizontal, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";
import { Drawer } from "./Overlay";

export interface FilterBarProps {
  /** Current search text (controlled). */
  search?: string;
  onSearchChange?: (value: string) => void;
  /** Called on Enter / search button with the current text. */
  onSearchSubmit?: (value: string) => void;
  searchLabel?: string;
  searchPlaceholder?: string;
  /** Additional filter controls (Field+Select, Field+Input type=date …). */
  children?: ReactNode;
  /** Number of non-default filters, shown on the mobile button. */
  activeCount?: number;
  onReset?: () => void;
  /** Right-aligned actions (Export, New). */
  actions?: ReactNode;
  className?: string;
}

export function FilterBar({ search, onSearchChange, onSearchSubmit, searchLabel = "Search", searchPlaceholder, children, activeCount = 0, onReset, actions, className }: FilterBarProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearchSubmit?.(search ?? "");
  };
  return (
    <div className={cn("mb-4 flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end gap-2">
        {onSearchChange ? (
          <form role="search" onSubmit={submit} className="flex min-w-0 flex-1 basis-60 items-center gap-2">
            <label htmlFor="rp-filter-search" className="sr-only">
              {searchLabel}
            </label>
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
              <input
                id="rp-filter-search"
                type="search"
                value={search ?? ""}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={searchPlaceholder ?? searchLabel}
                maxLength={200}
                enterKeyHint="search"
                className="min-h-11 w-full rounded-[var(--radius-control)] border border-control-border bg-surface py-2 pr-3 pl-9 text-ink placeholder:text-muted focus-visible:border-action"
              />
            </div>
            <Button type="submit" variant="secondary" className="hidden sm:inline-flex">
              Search
            </Button>
          </form>
        ) : null}
        {children ? (
          <Button variant="secondary" className="md:hidden" onClick={() => setDrawerOpen(true)} leadingIcon={<SlidersHorizontal aria-hidden="true" />}>
            Filters{activeCount > 0 ? ` (${activeCount})` : ""}
          </Button>
        ) : null}
        {actions ? <div className="ml-auto flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children ? (
        <div className="hidden flex-wrap items-end gap-3 md:flex [&>*]:min-w-44 [&>*]:flex-1 [&>*]:basis-44 [&>*]:max-w-64">
          {children}
          {onReset && activeCount > 0 ? (
            <Button variant="ghost" onClick={onReset} leadingIcon={<X aria-hidden="true" />} className="!min-w-0 !flex-none">
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}
      {children ? (
        <Drawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          title="Filters"
          side="right"
          footer={
            <>
              {onReset ? (
                <Button variant="ghost" onClick={onReset}>
                  Clear filters
                </Button>
              ) : null}
              <Button onClick={() => setDrawerOpen(false)}>Show results</Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">{children}</div>
        </Drawer>
      ) : null}
    </div>
  );
}
