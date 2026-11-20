import { Tabs as RTabs } from "radix-ui";
import { ChevronRight } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { cn } from "./cn";

export interface TabItem {
  value: string;
  label: ReactNode;
  /** Small trailing content (count badge). */
  badge?: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}
export interface TabsProps {
  items: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Accessible name of the tab list. */
  label: string;
  className?: string;
}

/** WAI-ARIA tabs (arrow-key navigation). The list scrolls horizontally on narrow screens. */
/**
 * Bring the active tab fully into the horizontally scrolling list. Horizontal only (never scrolls the page,
 * unlike scrollIntoView with an off-screen list) and instant (no smooth scrolling, so reduced motion holds).
 */
export function revealActiveTab(list: HTMLElement | null): void {
  const tab = list?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
  if (!list || !tab) return;
  const box = list.getBoundingClientRect();
  const item = tab.getBoundingClientRect();
  const pad = 4;
  if (item.left < box.left) list.scrollLeft = Math.max(0, list.scrollLeft - (box.left - item.left + pad));
  else if (item.right > box.right) list.scrollLeft += item.right - box.right + pad;
}

export function Tabs({ items, value, defaultValue, onValueChange, label, className }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? items[0]?.value);
  const active = value ?? uncontrolled;
  useLayoutEffect(() => revealActiveTab(listRef.current), [active]);
  return (
    <RTabs.Root
      value={value}
      defaultValue={defaultValue ?? items[0]?.value}
      onValueChange={(next) => {
        setUncontrolled(next);
        onValueChange?.(next);
      }}
      className={cn("min-w-0", className)}
    >
      <RTabs.List ref={listRef} aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1 [scrollbar-width:thin]">
        {items.map((item) => (
          <RTabs.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className="relative inline-flex min-h-11 shrink-0 items-center gap-2 px-3 text-sm font-medium whitespace-nowrap text-muted hover:text-ink data-[state=active]:text-ink after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full data-[state=active]:after:bg-action disabled:opacity-50"
          >
            {item.label}
            {item.badge}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {items.map((item) => (
        <RTabs.Content key={item.value} value={item.value} className="pt-4 outline-none">
          {item.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}

export interface Crumb {
  label: string;
  /** Omit for the current page. */
  href?: string;
}
export function Breadcrumbs({ items, className }: { items: readonly Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
        {items.map((crumb, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="inline-flex min-w-0 items-center gap-1">
              {crumb.href && !last ? (
                <Link href={crumb.href} className="truncate rounded underline-offset-2 hover:text-ink hover:underline">
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={cn("truncate", last && "font-medium text-ink")}>
                  {crumb.label}
                </span>
              )}
              {!last ? <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
