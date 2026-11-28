/**
 * Staff/admin console shell: grouped sidebar (collapsible to icons on ≥ lg), drawer on smaller screens,
 * top bar with global search slot, notifications, theme and account menu, maintenance banner.
 */
import { ChevronsLeft, ChevronsRight, Menu, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ALL_NAV } from "@/app/registry";
import type { MeUser } from "@/lib/authApi";
import type { NavItem } from "@/lib/routes";
import { BrandLogo, Drawer, IconButton, Tooltip } from "@/ui";
import { cn } from "@/ui/cn";
import { CookieConsentSlot, CustomerMaintenanceSlot, GlobalSearchSlot, NotificationSlot } from "../slots";
import { PolicyPromptSlot } from "../policyPromptSlot";
import { PortalSwitch } from "../portal";
import { AccountMenu, Footer, navPlacement, MaintenanceBanner, PreviewBanner, SkipLink, ThemeToggle, useCurrentNav, useEnabledNav, visibleNav } from "./common";

function groupNav(items: NavItem[]): Array<{ group: string; items: NavItem[] }> {
  const groups = new Map<string, NavItem[]>();
  for (const item of items) {
    const key = item.group ?? "General";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].map(([group, list]) => ({ group, items: list }));
}

function SideNav({ groups, collapsed, onNavigate }: { groups: ReturnType<typeof groupNav>; collapsed?: boolean; onNavigate?: () => void }) {
  const active = useCurrentNav(groups.flatMap((g) => g.items));
  return (
    <nav aria-label="Console" className="flex flex-col gap-5">
      {groups.map(({ group, items }) => (
        <div key={group}>
          <h2 className={cn("rp-nav-section mb-1 px-3 text-xs font-semibold tracking-wide uppercase", collapsed && "sr-only")}>{group}</h2>
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => {
              const isActive = active(item.href);
              const link = (
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={isActive ? "page" : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  className={cn(
                    "rp-nav-item flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm",
                    collapsed && "justify-center px-0",
                  )}
                >
                  <item.icon aria-hidden={true} className="size-5 shrink-0" />
                  {collapsed ? null : <span className="min-w-0 truncate whitespace-nowrap">{item.label}</span>}
                </Link>
              );
              return <li key={item.href}>{collapsed ? <Tooltip content={item.label} side="right">{link}</Tooltip> : link}</li>;
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function ConsoleShell({ user, children }: { user: MeUser; children: ReactNode }) {
  const groups = groupNav(useEnabledNav(visibleNav(ALL_NAV, "console", user.role)).filter((item) => navPlacement(item) !== "hidden"));
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-dvh flex-col bg-surface-soft">
      {/* The consent banner sits above the sidebar row, never as a flex sibling that squeezes the content column. */}
      <CookieConsentSlot />
      <SkipLink />
      <PolicyPromptSlot />
      <div className="flex min-h-0 flex-1">
        {/* Desktop sidebar (always navy; uses on-navy tokens and the dark logo set) */}
        <aside aria-label="Console navigation" className={cn("rp-nav-panel rp-nav-edge sticky top-0 hidden h-dvh shrink-0 flex-col rp-on-navy lg:flex", collapsed ? "w-20" : "w-64")}>
          {/* Brand tile: the square full lockup (dark file on the navy panel), smaller when collapsed. */}
          <div className={cn("flex items-center justify-center px-4 py-3", collapsed && "px-2")} data-testid="console-brand-tile">
            <Link href="/admin" aria-label="ReadyPackets console home" className="inline-flex rounded">
              <BrandLogo appearance="dark" lockup="square" label="" className={collapsed ? "w-14" : "w-32"} />
            </Link>
          </div>
          <div className="rp-nav-scroll min-h-0 flex-1 overflow-y-auto px-3 py-4">
            <SideNav groups={groups} collapsed={collapsed} />
          </div>
          <div className="border-t border-navy-border p-3">
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={cn("rp-nav-item flex min-h-11 w-full items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm", collapsed && "justify-center px-0")}
            >
              {collapsed ? <ChevronsRight aria-hidden="true" className="size-5" /> : <ChevronsLeft aria-hidden="true" className="size-5" />}
              {collapsed ? null : "Collapse"}
            </button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <PreviewBanner />
          <MaintenanceBanner />
          <CustomerMaintenanceSlot />
          <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
            {/* Below 280 px the five actions use 36 px targets (still above the 24 px minimum) and tighter gaps so
                the row fits at 240 px without shrinking any target. */}
            <div className="flex h-16 items-center gap-2 px-3 sm:px-6 max-[279px]:gap-1 max-[279px]:px-2 max-[279px]:[&_.size-11]:size-9" data-testid="console-header-row">
              <IconButton label="Open console navigation" icon={<Menu />} className="shrink-0 lg:hidden" onClick={() => setDrawerOpen(true)} />
              {/* Narrow bar: the horizontal full lockup where it fits next to the actions (440-767 px). Narrower,
                  and between md and lg where the inline search takes the room, the drawer's brand tile carries it. */}
              <Link href="/admin" aria-label="ReadyPackets console home" className="hidden min-w-0 shrink rounded min-[440px]:inline-flex md:hidden" data-testid="console-header-logo">
                <BrandLogo lockup="horizontal" label="" className="w-32" />
              </Link>
              {/* Inline search from md up (min width keeps the placeholder whole); a single icon link below md. */}
              <div className="hidden min-w-[20rem] flex-1 px-1 md:block md:max-w-md" data-testid="console-search-inline">
                <GlobalSearchSlot className="flex w-full items-center gap-2 [&>*:first-child]:min-w-0 [&>*:first-child]:flex-1" />
              </div>
              <Link
                href="/admin/search"
                aria-label="Search"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-body hover:bg-surface-sunken hover:text-ink md:hidden"
              >
                <Search aria-hidden="true" className="size-5" />
              </Link>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <PortalSwitch area="console" role={user.role} className="mr-1 hidden md:inline-flex" />
                <NotificationSlot area="console" />
                <ThemeToggle />
                <AccountMenu user={user} area="console" />
              </div>
            </div>
          </header>
          <main id="main" tabIndex={-1} className="w-full max-w-[100rem] min-w-0 flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8">
            {children}
          </main>
          <Footer />
        </div>
      </div>

      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} title="Console navigation" side="left" width="sm">
        <div className="rp-nav-panel -m-4 min-h-full p-4 rp-on-navy">
          <div className="mb-4 flex justify-center border-b border-navy-border pb-4" data-testid="drawer-brand-tile">
            <BrandLogo appearance="dark" lockup="square" label="" className="w-28" />
          </div>
          <div className="mb-4 border-b border-navy-border pb-4" data-testid="drawer-portal-switch">
            <PortalSwitch area="console" role={user.role} appearance="nav" onNavigate={() => setDrawerOpen(false)} />
          </div>
          <SideNav groups={groups} onNavigate={() => setDrawerOpen(false)} />
        </div>
      </Drawer>
    </div>
  );
}
