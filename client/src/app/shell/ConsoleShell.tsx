/**
 * Staff/admin console shell: grouped sidebar (collapsible to icons on ≥ lg), drawer on smaller screens,
 * top bar with global search slot, notifications, theme and account menu, maintenance banner.
 */
import { ChevronsLeft, ChevronsRight, Menu } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ALL_NAV } from "@/app/registry";
import type { MeUser } from "@/lib/authApi";
import type { NavItem } from "@/lib/routes";
import { BrandLogo, Drawer, IconButton, Tooltip } from "@/ui";
import { cn } from "@/ui/cn";
import { GlobalSearchSlot, NotificationSlot } from "../slots";
import { AccountMenu, Footer, MaintenanceBanner, PreviewBanner, SkipLink, ThemeToggle, useActive, visibleNav } from "./common";

function groupNav(items: NavItem[]): Array<{ group: string; items: NavItem[] }> {
  const groups = new Map<string, NavItem[]>();
  for (const item of items) {
    const key = item.group ?? "General";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].map(([group, list]) => ({ group, items: list }));
}

function SideNav({ groups, collapsed, onNavigate }: { groups: ReturnType<typeof groupNav>; collapsed?: boolean; onNavigate?: () => void }) {
  const active = useActive();
  return (
    <nav aria-label="Console" className="flex flex-col gap-5">
      {groups.map(({ group, items }) => (
        <div key={group}>
          <h2 className={cn("mb-1 px-3 text-xs font-semibold tracking-wide text-on-navy-muted uppercase", collapsed && "sr-only")}>{group}</h2>
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
                    "flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm font-medium text-on-navy-muted hover:bg-navy-elevated hover:text-on-navy",
                    isActive && "bg-navy-elevated text-on-navy shadow-[inset_3px_0_0_var(--color-teal-light)]",
                    collapsed && "justify-center px-0",
                  )}
                >
                  <item.icon aria-hidden={true} className="size-5 shrink-0" />
                  {collapsed ? null : <span className="truncate">{item.label}</span>}
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
  const groups = groupNav(visibleNav(ALL_NAV, "console", user.role));
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-dvh bg-surface-soft">
      <SkipLink />
      {/* Desktop sidebar (always navy; uses on-navy tokens and the dark logo set) */}
      <aside aria-label="Console navigation" className={cn("sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-navy-border bg-navy rp-on-navy lg:flex", collapsed ? "w-20" : "w-64")}>
        <div className={cn("flex h-16 items-center px-4", collapsed && "justify-center px-2")}>
          <Link href="/admin" aria-label="ReadyPackets console home" className="inline-flex rounded">
            {collapsed ? <BrandLogo appearance="dark" variant="icon" label="" className="h-9" /> : <BrandLogo appearance="dark" label="" className="w-44" />}
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <SideNav groups={groups} collapsed={collapsed} />
        </div>
        <div className="border-t border-navy-border p-3">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn("flex min-h-11 w-full items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm text-on-navy-muted hover:bg-navy-elevated hover:text-on-navy", collapsed && "justify-center px-0")}
          >
            {collapsed ? <ChevronsRight aria-hidden="true" className="size-5" /> : <ChevronsLeft aria-hidden="true" className="size-5" />}
            {collapsed ? null : "Collapse"}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <PreviewBanner />
      <MaintenanceBanner />
        <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
          <div className="flex h-16 items-center gap-2 px-3 sm:px-6">
            <IconButton label="Open console navigation" icon={<Menu />} className="lg:hidden" onClick={() => setDrawerOpen(true)} />
            <Link href="/admin" aria-label="ReadyPackets console home" className="inline-flex shrink-0 rounded lg:hidden">
              <BrandLogo variant="icon" label="" className="h-9" />
            </Link>
            <div className="min-w-0 flex-1 px-1 sm:max-w-md">
              <GlobalSearchSlot />
            </div>
            <div className="ml-auto flex items-center gap-1">
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

      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} title="Console navigation" side="left" width="sm">
        <div className="-m-4 min-h-full bg-navy p-4 rp-on-navy">
          <SideNav groups={groups} onNavigate={() => setDrawerOpen(false)} />
        </div>
      </Drawer>
    </div>
  );
}
