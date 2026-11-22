import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "./cn";
import { Select } from "./Field";

export interface RouteTabItem {
  /** Stable key, e.g. the URL segment ("files"). */
  value: string;
  /** Plain-text label (also used by the narrow-screen select). */
  label: string;
  /** Same-origin path this tab opens. Every tab has its own URL. */
  href: string;
  /**
   * Optional live text rendered in the strip in place of `label` (e.g. a DetailTab `labelComponent` that renders
   * "SharePoint sync (2)"). Text only; it becomes the tab's accessible name. The select keeps the static `label`.
   */
  labelContent?: ReactNode;
  /** Optional count shown after the label, e.g. "SharePoint sync 3". */
  count?: number;
  disabled?: boolean;
}

export interface RouteTabsProps {
  items: readonly RouteTabItem[];
  /** Value of the tab whose panel is shown (derived from the URL by the page). */
  value: string;
  /** Accessible name of the tab list and the narrow-screen select. */
  label: string;
  /** Replace the history entry when switching tabs (default true: tabs are views of one page). */
  replace?: boolean;
  /** Id prefix linking tabs and the panel; defaults to a generated id. Pass the same id to RouteTabPanel. */
  idBase?: string;
  className?: string;
}

/** Ids shared by RouteTabs and RouteTabPanel. */
export const routeTabId = (idBase: string, value: string) => `${idBase}-tab-${value}`;
export const routeTabPanelId = (idBase: string) => `${idBase}-panel`;

/**
 * Tab the user just opened. If the page remounts the strip on the URL change, the new strip moves focus back to
 * that tab instead of leaving it on <body>. In-memory only; it needs a stable `idBase`.
 */
let pendingFocusId: string | null = null;
function rememberFocus(id: string | null) {
  pendingFocusId = id;
}

/** Keeps a tab clear of the 36 px overlaid scroll buttons (w-9) plus a small gap. */
const EDGE_CLEARANCE = 40;
function revealInStrip(list: HTMLElement | null, element: HTMLElement | null) {
  if (!list || !element) return;
  const box = list.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (rect.left < box.left + EDGE_CLEARANCE) list.scrollLeft = Math.max(0, list.scrollLeft - (box.left + EDGE_CLEARANCE - rect.left));
  else if (rect.right > box.right - EDGE_CLEARANCE) list.scrollLeft += rect.right - (box.right - EDGE_CLEARANCE);
}

const countText = (count: number | undefined) => (count === undefined ? "" : count > 99 ? "99+" : String(count));

/**
 * One WAI-ARIA tablist whose tabs are links (each tab keeps its own URL).
 *
 * - Roving focus: Tab enters on the selected tab; ←/→ (wrapping), Home and End move focus; Enter or Space opens
 *   the focused tab (manual activation, so arrowing never navigates).
 * - The strip scrolls horizontally; visible "Scroll tabs" buttons appear on the side that has hidden tabs. They are
 *   named pointer affordances kept out of the Tab order: every tab is reachable with the arrow keys, which also
 *   scroll the focused tab into view, so keyboard users have an equivalent.
 * - Below 480 px the strip is replaced by a labelled native select listing the same tabs.
 */
export function RouteTabs({ items, value, label, replace = true, idBase: idBaseProp, className }: RouteTabsProps) {
  const generated = useId();
  const idBase = idBaseProp ?? `rp-rt${generated.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const [, navigate] = useLocation();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectId = `${idBase}-select`;
  const enabled = items.filter((item) => !item.disabled);
  const tabKey = items.map((item) => item.value).join("\u0000");
  const selected = items.find((item) => item.value === value);
  const [focusValue, setFocusValue] = useState(selected?.value ?? enabled[0]?.value);
  const [edges, setEdges] = useState({ start: false, end: false });

  // When the selected tab changes (URL), the roving tab stop follows it (adjusted during render, not in an effect).
  const [trackedValue, setTrackedValue] = useState(value);
  if (trackedValue !== value) {
    setTrackedValue(value);
    setFocusValue(value);
  }
  // Roving tab stop: the focused tab, else the selected tab, else the first enabled tab.
  const tabStop = enabled.some((item) => item.value === focusValue) ? focusValue : (enabled.find((item) => item.value === value) ?? enabled[0])?.value;

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const max = list.scrollWidth - list.clientWidth;
    const start = list.scrollLeft > 1;
    const end = max - list.scrollLeft > 1;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useLayoutEffect(() => {
    revealInStrip(listRef.current, listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null);
    measure();
    const target = pendingFocusId ? document.getElementById(pendingFocusId) : null;
    if (target && rootRef.current?.contains(target)) {
      rememberFocus(null);
      const active = document.activeElement;
      if (!active || active === document.body) target.focus();
    }
  }, [value, measure]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    // The strip keeps its own width while tab labels grow (counts arriving, web fonts swapping in), so watch the
    // tabs as well as the strip; otherwise the scroll buttons stay hidden over a clipped last tab.
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const tab of list.querySelectorAll('[role="tab"]')) observer.observe(tab);
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) measure();
    });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [measure, tabKey]);

  const focusTab = (next: RouteTabItem) => {
    setFocusValue(next.value);
    const element = document.getElementById(routeTabId(idBase, next.value));
    element?.focus();
    revealInStrip(listRef.current, element);
    measure();
  };

  /** `from` is the control that opened the tab; focus returns to it (the select is the only visible one below 480 px). */
  const open = (item: RouteTabItem, from: "tab" | "select" = "tab") => {
    if (item.disabled || item.value === value) return;
    rememberFocus(from === "select" ? selectId : routeTabId(idBase, item.value));
    navigate(item.href, { replace });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, item: RouteTabItem) => {
    const index = enabled.findIndex((candidate) => candidate.value === item.value);
    let next: RouteTabItem | undefined;
    if (event.key === "ArrowRight") next = enabled[(index + 1) % enabled.length];
    else if (event.key === "ArrowLeft") next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled[enabled.length - 1];
    else if (event.key === " ") {
      event.preventDefault();
      open(item);
      return;
    }
    if (next) {
      event.preventDefault();
      focusTab(next);
    }
  };

  const scrollBy = (direction: -1 | 1) => {
    const list = listRef.current;
    if (!list) return;
    list.scrollLeft += direction * Math.max(120, list.clientWidth * 0.6);
    measure();
  };

  const tabClass =
    "relative inline-flex min-h-11 shrink-0 items-center gap-2 rounded-t px-3 text-sm font-medium whitespace-nowrap text-muted hover:text-ink aria-selected:text-ink after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full aria-selected:after:bg-action";
  const scrollButton = (direction: -1 | 1, visible: boolean): ReactNode => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={direction < 0 ? "Scroll tabs left" : "Scroll tabs right"}
      data-rp-tab-scroll={direction < 0 ? "start" : "end"}
      onClick={() => scrollBy(direction)}
      className={cn(
        "absolute top-0 bottom-px z-10 inline-flex w-9 items-center justify-center bg-surface text-muted shadow-[var(--shadow-card)] hover:text-ink",
        direction < 0 ? "left-0 rounded-r" : "right-0 rounded-l",
        !visible && "hidden",
      )}
    >
      {direction < 0 ? <ChevronLeft aria-hidden="true" className="size-4" /> : <ChevronRight aria-hidden="true" className="size-4" />}
    </button>
  );

  return (
    <div ref={rootRef} className={cn("min-w-0", className)}>
      <div className="relative hidden min-[480px]:block">
        {scrollButton(-1, edges.start)}
        <div
          ref={listRef}
          role="tablist"
          aria-label={label}
          aria-orientation="horizontal"
          onScroll={measure}
          className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1 [scrollbar-width:none]"
        >
          {items.map((item) => {
            const isSelected = item.value === value;
            const common = {
              id: routeTabId(idBase, item.value),
              role: "tab",
              "aria-selected": isSelected,
              "aria-controls": isSelected ? routeTabPanelId(idBase) : undefined,
              tabIndex: item.value === tabStop ? 0 : -1,
            } as const;
            const content = (
              <>
                {item.labelContent ?? item.label}
                {item.count !== undefined ? (
                  <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-surface-soft px-1.5 text-xs font-semibold text-body">
                    {countText(item.count)}
                  </span>
                ) : null}
              </>
            );
            if (item.disabled) {
              return (
                <span key={item.value} {...common} aria-disabled="true" className={cn(tabClass, "cursor-not-allowed opacity-50 hover:text-muted")}>
                  {content}
                </span>
              );
            }
            return (
              <Link
                key={item.value}
                {...common}
                href={item.href}
                replace={replace}
                onFocus={() => setFocusValue(item.value)}
                onClick={() => rememberFocus(routeTabId(idBase, item.value))}
                onKeyDown={(event: KeyboardEvent<HTMLAnchorElement>) => onKeyDown(event, item)}
                className={tabClass}
              >
                {content}
              </Link>
            );
          })}
        </div>
        {scrollButton(1, edges.end)}
      </div>
      <div className="min-[480px]:hidden">
        <label htmlFor={selectId} className="mb-1 block text-sm font-medium text-ink">
          {label}
        </label>
        <Select
          id={selectId}
          value={selected?.value ?? ""}
          onChange={(event) => {
            const next = items.find((item) => item.value === event.target.value);
            if (next) open(next, "select");
          }}
          options={items.map((item) => ({
            value: item.value,
            label: item.count !== undefined ? `${item.label} (${countText(item.count)})` : item.label,
            disabled: item.disabled,
          }))}
        />
      </div>
    </div>
  );
}

export interface RouteTabPanelProps {
  /** Same idBase and value as the RouteTabs above it. */
  idBase: string;
  value: string;
  children: ReactNode;
  className?: string;
}

/** The panel for the selected RouteTabs tab, named by that tab (aria-labelledby also works while the strip is hidden below 480 px). */
export function RouteTabPanel({ idBase, value, children, className }: RouteTabPanelProps) {
  return (
    <div
      id={routeTabPanelId(idBase)}
      role="tabpanel"
      aria-labelledby={routeTabId(idBase, value)}
      tabIndex={0}
      className={cn("pt-4 outline-none focus-visible:ring-2 focus-visible:ring-action", className)}
    >
      {children}
    </div>
  );
}
