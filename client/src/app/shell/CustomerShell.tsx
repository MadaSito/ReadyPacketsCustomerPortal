/**
 * Customer shell: sticky top bar (approved lockup, primary nav ≥ lg, notifications, theme, account),
 * bottom navigation on small screens (first 4 items + "More" drawer), footer.
 */
import { Menu } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ALL_NAV } from "@/app/registry";
import type { MeUser } from "@/lib/authApi";
import { BrandLogo, Drawer, IconButton } from "@/ui";
import { cn } from "@/ui/cn";
import { NotificationSlot } from "../slots";
import { AccountMenu, Footer, MaintenanceBanner, SkipLink, ThemeToggle, useActive, visibleNav } from "./common";

const GRID_COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" };

export function CustomerShell({ user, children }: { user: MeUser; children: ReactNode }) {
  const nav = visibleNav(ALL_NAV, "customer", user.role);
  const active = useActive();
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = nav.slice(0, 4);
  const overflow = nav.slice(4);

  return (
    <div className="flex min-h-dvh flex-col bg-surface-soft">
      <SkipLink />
      <MaintenanceBanner />
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-3 sm:px-6 lg:px-8">
          <Link href="/" aria-label="ReadyPackets home" className="mr-2 inline-flex shrink-0 items-center rounded">
            <BrandLogo label="" className="hidden w-48 sm:inline-flex" />
            <BrandLogo label="" variant="icon" className="h-9 sm:hidden" />
          </Link>
          <nav aria-label="Primary" className="hidden min-w-0 flex-1 lg:block">
            <ul className="flex items-center gap-1">
              {nav.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active(item.href) ? "page" : undefined}
                    className={cn(
                      "inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-3 text-sm font-medium text-body hover:bg-surface-sunken hover:text-ink",
                      active(item.href) && "bg-action-soft text-action hover:bg-action-soft hover:text-action",
                    )}
                  >
                    <item.icon aria-hidden={true} className="size-4" />
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <NotificationSlot area="customer" />
            <ThemeToggle />
            <AccountMenu user={user} area="customer" />
            {nav.length > 0 ? (
              <IconButton label="Open navigation menu" icon={<Menu />} className="hidden md:inline-flex lg:hidden" onClick={() => setMoreOpen(true)} />
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
        <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
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
        <nav aria-label="All sections">
          <ul className="flex flex-col gap-1">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  aria-current={active(item.href) ? "page" : undefined}
                  className={cn("flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-[0.9375rem] font-medium text-ink hover:bg-surface-sunken", active(item.href) && "bg-action-soft text-action")}
                >
                  <item.icon aria-hidden={true} className="size-5" />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Drawer>
    </div>
  );
}
