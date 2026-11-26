/**
 * Increment 08 (D6) — customer order page layout (audit_engineer): the wizard first, the former tabs behind a
 * secondary "Order details" disclosure on the same page. A deep link to a tab (`/orders/:id/files`, `?slot=` …)
 * opens the details on load, so every existing link keeps working.
 *
 * WCAG 2.2: the disclosure is a native button with `aria-expanded` / `aria-controls`; the details stay in the
 * DOM order after the wizard; the button is at least 44 px tall.
 */
import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/ui/cn";

export function CustomerOrderLayout({ wizard, details, deepLink }: {
  wizard: ReactNode;
  /** The former order tabs (RouteTabs + RouteTabPanel). */
  details: ReactNode;
  /** The tab the URL asks for (deep link), or null; the details open, and open again when it changes. */
  deepLink: string | null;
}) {
  const [open, setOpen] = useState(deepLink !== null);
  const [seenLink, setSeenLink] = useState(deepLink);
  if (deepLink !== seenLink) {
    setSeenLink(deepLink);
    if (deepLink !== null) setOpen(true);
  }
  const panelId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {wizard}
      <div className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-4 py-2 font-semibold text-ink hover:underline"
        >
          <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 motion-safe:transition-transform", open && "rotate-180")} />
          Order details
        </button>
        <div id={panelId} hidden={!open} className="mt-4 min-w-0">
          {open ? details : null}
        </div>
      </div>
    </div>
  );
}
