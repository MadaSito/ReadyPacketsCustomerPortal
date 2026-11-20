/**
 * Customer shell: sticky top bar (approved lockup, up to MAX_PRIMARY_NAV primary links ≥ xl plus a "More" menu
 * for any extra, notifications bell, theme, avatar menu with the account entries), a menu drawer between md and
 * xl, bottom navigation on phones (first 4 primary + "More" drawer) and the footer. Placement is decided by
 * `customerNavLayout` (shell-level rule, see `NavItem.placement`), so peers' registrations can't crowd the bar.
 */
import { ChevronDown, Menu } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ALL_NAV } from "@/app/registry";
import type { MeUser } from "@/lib/authApi";
import { BrandLogo, Drawer, DropdownMenu, IconButton } from "@/ui";
import { cn } from "@/ui/cn";
import { NotificationSlot } from "../slots";
import { AccountMenu, customerNavLayout, Footer, MaintenanceBanner, PreviewBanner, SkipLink, ThemeToggle, useActive, visibleNav } from "./common";

const GRID_COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" };

const TOP_LINK =
  "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[var(--radius-control)] px-3 text-sm font-medium whitespace-nowrap text-body hover:bg-surface-sunken hover:text-ink";
const TOP_LINK_ACTIVE = "bg-action-soft text-action hover:bg-action-soft hover:text-action";

export function CustomerShell({ user, children }: { user: MeUser; children: ReactNode }) {
  const layout = customerNavLayout(visibleNav(ALL_NAV, "customer", user.role));
  const nav = [...layout.primary, ...layout.more];
  const active = useActive();
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = nav.slice(0, 4);
  const overflow = [...nav.slice(4), ...layout.account];
  const moreActive = layout.more.some((item) => active(item.href));

  return (
    <div className="flex min-h-dvh flex-col bg-surface-soft">
      <SkipLink />
      <PreviewBanner />
      <MaintenanceBanner />
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-3 sm:px-6 lg:px-8">
          <Link href="/" aria-label="ReadyPackets home" className="mr-2 inline-flex shrink-0 items-center rounded">
            <BrandLogo label="" className="hidden w-48 sm:inline-flex" />
            <BrandLogo label="" variant="icon" className="h-9 sm:hidden" />
          </Link>
          <nav aria-label="Primary" className="hidden min-w-0 flex-1 xl:block">
            <ul className="flex min-w-0 items-center gap-1">
              {layout.primary.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active(item.href) ? "page" : undefined}
                    className={cn(
                      TOP_LINK,
                      active(item.href) && TOP_LINK_ACTIVE,
                    )}
                  >
                    <item.icon aria-hidden={true} className="size-4 shrink-0" />
                    {item.label}
                  </Link>
                </li>
              ))}
              {layout.more.length ? (
                <li>
                  <DropdownMenu
                    align="start"
                    trigger={
                      <button type="button" className={cn(TOP_LINK, moreActive && TOP_LINK_ACTIVE)}>
                        More
                        <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
                      </button>
                    }
                    items={layout.more.map((item) => ({
                      label: item.label,
                      asChild: (
                        <Link href={item.href} aria-current={active(item.href) ? "page" : undefined}>
                          <item.icon aria-hidden={true} />
                          {item.label}
                        </Link>
                      ),
                    }))}
                  />
                </li>
              ) : null}
            </ul>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <NotificationSlot area="customer" />
            <ThemeToggle />
            <AccountMenu user={user} area="customer" items={layout.account} />
            {nav.length > 0 ? (
              <IconButton label="Open navigation menu" icon={<Menu />} className="hidden md:inline-flex xl:hidden" onClick={() => setMoreOpen(true)} />
            ) : null}
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl min-w-0 flex-1 px-4 pt-6 pb-28 outline-none sm:px-6 md:pb-10 lg:px-8 lg:pt-8">
        {children}
      </main>
      <Footer className="mb-16 md:mb-0" />

      {/* Bottom navigation (phones) */}
      {nav.length > 0 ? (
        <nav aria-label="Quick navigation" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
          <ul className={cn("grid", GRID_COLS[primary.length + (overflow.length ? 1 : 0)])}>
            {primary.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active(item.href) ? "page" : undefined}
                  className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[0.6875rem] font-medium text-muted", active(item.href) && "text-action")}
                >
                  <item.icon aria-hidden={true} className="size-5" />
                  <span className="max-w-full truncate">{item.label}</span>
                </Link>
              </li>
            ))}
            {overflow.length ? (
              <li>
                <button type="button" onClick={() => setMoreOpen(true)} className="flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium text-muted">
                  <Menu aria-hidden="true" className="size-5" />
                  More
                </button>
              </li>
            ) : null}
          </ul>
        </nav>
      ) : null}

      <Drawer open={moreOpen} onOpenChange={setMoreOpen} title="Menu" side="right" width="sm">
        <nav aria-label="All sections" className="flex flex-col gap-5">
          {[
            { heading: null, items: nav },
            { heading: "Your account", items: layout.account },
          ].map(({ heading, items }) =>
            items.length ? (
              <div key={heading ?? "main"}>
                {heading ? <h2 className="mb-1 px-3 text-xs font-semibold tracking-wide text-muted uppercase">{heading}</h2> : null}
                <ul className="flex flex-col gap-1">
                  {items.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setMoreOpen(false)}
                        aria-current={active(item.href) ? "page" : undefined}
                        className={cn("flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-[0.9375rem] font-medium text-ink hover:bg-surface-sunken", active(item.href) && "bg-action-soft text-action")}
                      >
                        <item.icon aria-hidden={true} className="size-5 shrink-0" />
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </nav>
      </Drawer>
    </div>
  );
}
