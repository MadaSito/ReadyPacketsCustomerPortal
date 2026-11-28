/**
 * Customer shell (increment 04, decision 16): sticky top bar (logo, notifications, System | Light | Dark
 * control, account menu), a left sidebar with Main / Support / Account sections at ≥ lg (collapsible to icons,
 * in-memory only), the same sections in a drawer below lg, and the phone bottom bar (4 entries + More) below md.
 * Entries with `enabledBy` appear only while their feature switch is on. Exactly one entry is current
 * (longest matching href).
 */
import { ChevronsLeft, ChevronsRight, Menu } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ALL_NAV } from "@/app/registry";
import type { MeUser } from "@/lib/authApi";
import type { NavItem } from "@/lib/routes";
import { BrandLogo, Drawer, IconButton, ThemeControl, Tooltip } from "@/ui";
import { cn } from "@/ui/cn";
import { CartBadgeSlot, CookieConsentSlot, NotificationSlot } from "../slots";
import { PolicyPromptSlot } from "../policyPromptSlot";
import { PortalSwitch, StaffPortalNotice } from "../portal";
import { isStaffRole } from "@/lib/portal";
import {
  AccountMenu,
  CUSTOMER_SECTIONS,
  customerNavSections,
  Footer,
  MaintenanceBanner,
  phoneTabLabel,
  PreviewBanner,
  SkipLink,
  ThemeToggle,
  useCurrentNav,
  useEnabledNav,
  visibleNav,
  type CustomerNavSections,
} from "./common";

const GRID_COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" };

function EntryLabel({ item }: { item: NavItem }) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.href === "/cart" ? <CartBadgeSlot /> : null}
    </>
  );
}

function SectionNav({ sections, label, collapsed, onNavigate, isCurrent }: { sections: CustomerNavSections; label: string; collapsed?: boolean; onNavigate?: () => void; isCurrent: (href: string) => boolean }) {
  return (
    <nav aria-label={label} className="flex flex-col gap-5">
      {CUSTOMER_SECTIONS.map(({ key, heading }) => {
        const items = sections[key];
        if (!items.length) return null;
        return (
          <div key={key}>
            {heading ? <h2 className={cn("rp-nav-section mb-1 px-3 text-xs font-semibold tracking-wide uppercase", collapsed && "sr-only")}>{heading}</h2> : <h2 className="sr-only">Main</h2>}
            <ul className="flex flex-col gap-0.5">
              {items.map((item) => {
                const current = isCurrent(item.href);
                const link = (
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={current ? "page" : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    className={cn(
                      "rp-nav-item flex min-h-11 min-w-0 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm",
                      collapsed && "justify-center px-0",
                    )}
                  >
                    <item.icon aria-hidden={true} className="size-5 shrink-0" />
                    {collapsed ? null : <EntryLabel item={item} />}
                  </Link>
                );
                return (
                  <li key={item.href}>
                    {collapsed ? (
                      <Tooltip content={item.label} side="right">
                        {link}
                      </Tooltip>
                    ) : (
                      link
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function CustomerShell({ user, children }: { user: MeUser; children: ReactNode }) {
  const items = useEnabledNav(visibleNav(ALL_NAV, "customer", user.role));
  const staff = isStaffRole(user.role);
  const sections = customerNavSections(items);
  const all = [...sections.main, ...sections.Support, ...sections.Account];
  const isCurrent = useCurrentNav(all);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const phone = sections.phone;
  const moreCurrent = all.some((item) => isCurrent(item.href) && !phone.includes(item));

  return (
    <div className="flex min-h-dvh flex-col bg-surface-soft">
      <CookieConsentSlot />
      <SkipLink />
      <PolicyPromptSlot />
      <PreviewBanner />
      <MaintenanceBanner />
      <StaffPortalNotice role={user.role} />
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-surface/85">
        <div className="flex h-16 items-center gap-2 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] sm:px-6">
          <IconButton label="Open navigation menu" icon={<Menu />} className="lg:hidden" onClick={() => setMenuOpen(true)} />
          {/* Narrow bar: the horizontal full lockup. From lg the sidebar's square brand tile replaces it; below
              340 px it yields its room to the actions (the menu drawer shows the brand tile). */}
          <Link href="/" aria-label="ReadyPackets home" className="mr-2 inline-flex min-w-0 shrink items-center rounded max-[339px]:hidden lg:hidden" data-testid="customer-header-logo">
            <BrandLogo lockup="horizontal" label="" className="w-28 sm:w-44" />
          </Link>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {staff ? <PortalSwitch area="customer" role={user.role} className="mr-1 hidden md:inline-flex" /> : null}
            <NotificationSlot area="customer" />
            <ThemeControl className="mx-1 hidden sm:inline-flex" />
            <ThemeToggle className="sm:hidden" />
            <AccountMenu user={user} area="customer" items={sections.Account} />
          </div>
        </div>
      </header>

      <div className="flex min-w-0 flex-1">
        <aside
          aria-label="Customer navigation"
          className={cn("rp-nav-panel rp-nav-edge sticky top-16 hidden h-[calc(100dvh-4rem)] shrink-0 flex-col rp-on-navy lg:flex", collapsed ? "w-20" : "w-64")}
        >
          <div className={cn("flex justify-center px-4 pt-4", collapsed && "px-2")} data-testid="customer-brand-tile">
            <Link href="/" aria-label="ReadyPackets home" className="inline-flex rounded">
              <BrandLogo appearance="dark" lockup="square" label="" className={collapsed ? "w-14" : "w-32"} />
            </Link>
          </div>
          <div className="rp-nav-scroll min-h-0 flex-1 overflow-y-auto px-3 py-4">
            <SectionNav sections={sections} label="Customer" collapsed={collapsed} isCurrent={isCurrent} />
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
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl min-w-0 flex-1 px-4 pt-6 pb-28 outline-none sm:px-6 md:pb-10 lg:px-8 lg:pt-8">
            {children}
          </main>
          <Footer className="mb-[calc(3.5rem+env(safe-area-inset-bottom))] md:mb-0" />
        </div>
      </div>

      {phone.length > 0 ? (
        <nav aria-label="Quick navigation" className="rp-nav-panel rp-nav-bar-top fixed inset-x-0 bottom-0 z-40 pb-[env(safe-area-inset-bottom)] rp-on-navy shadow-[0_-4px_16px_-8px_rgb(0_0_0/0.35)] md:hidden">
          <ul className={cn("grid", GRID_COLS[phone.length + 1])}>
            {phone.map((item) => (
              <li key={item.href} className="min-w-0">
                <Link
                  href={item.href}
                  aria-current={isCurrent(item.href) ? "page" : undefined}
                  className="rp-nav-tab flex min-h-14 flex-col items-center justify-center gap-0.5 px-0.5 py-1 text-[0.6875rem] leading-tight tracking-tight"
                >
                  <item.icon aria-hidden={true} className="size-5 shrink-0" />
                  <span className="max-w-full text-center [overflow-wrap:anywhere]">{phoneTabLabel(item)}</span>
                </Link>
              </li>
            ))}
            <li className="min-w-0">
              <button
                type="button"
                onClick={() => setMenuOpen(true)}
                aria-haspopup="dialog"
                data-current={moreCurrent ? "" : undefined}
                className="rp-nav-tab flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-[0.6875rem]"
              >
                <Menu aria-hidden="true" className="size-5" />
                More
              </button>
            </li>
          </ul>
        </nav>
      ) : null}

      <Drawer open={menuOpen} onOpenChange={setMenuOpen} title="Menu" side="left" width="sm">
        <div className="rp-nav-panel -mx-4 -mt-4 p-4 rp-on-navy">
          <div className="mb-4 flex justify-center border-b border-navy-border pb-4" data-testid="drawer-brand-tile">
            <BrandLogo appearance="dark" lockup="square" label="" className="w-28" />
          </div>
          {staff ? (
            <div className="mb-4 border-b border-navy-border pb-4" data-testid="drawer-portal-switch">
              <PortalSwitch area="customer" role={user.role} appearance="nav" onNavigate={() => setMenuOpen(false)} />
            </div>
          ) : null}
          <SectionNav sections={sections} label="All sections" onNavigate={() => setMenuOpen(false)} isCurrent={isCurrent} />
        </div>
        <div className="mt-6 border-t border-line pt-4 sm:hidden">
          <ThemeControl showLabel />
        </div>
      </Drawer>
    </div>
  );
}
