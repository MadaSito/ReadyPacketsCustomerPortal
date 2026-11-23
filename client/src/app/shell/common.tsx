/** Pieces shared by both shells: theme toggle, account menu, footer, banners, nav filtering. */
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Download, LogOut, Monitor, Moon, Settings, ShieldCheck, Sun, UserRound } from "lucide-react";
import { Link, useLocation } from "wouter";
import type { UserRole } from "@shared/domain";
import type { NavItem } from "@/lib/routes";
import { useAuthApi, type MeUser } from "@/lib/authApi";
import { useSignOut } from "@/lib/signOut";
import { useConsent } from "@/lib/consent";
import { Callout, DropdownMenu, IconButton, useTheme, type ThemePreference } from "@/ui";
import { cn } from "@/ui/cn";
import { RUNTIME } from "@/lib/runtime";
import { PwaInstallDialog, usePwaInstall } from "@/app/PwaInstallEntry";

export const LEGAL_NAME = "Ready Packets Consulting LLC";
export const PUBLIC_SITE_URL = "https://www.readypackets.com";

export function visibleNav(items: readonly NavItem[], area: NavItem["area"], role: UserRole): NavItem[] {
  return items.filter((item) => {
    if (item.area !== area) return false;
    if (item.access === "admin") return role === "admin";
    if (item.access === "staff") return role === "staff" || role === "admin";
    return item.access === "customer";
  });
}

/** Drops entries whose feature switch (`NavItem.enabledBy`) is off, unknown or still loading. */
export function useEnabledNav(items: readonly NavItem[]): NavItem[] {
  const api = useAuthApi();
  const needed = items.some((item) => item.enabledBy);
  // Same public query as `@/lib/features` (platform.bootstrap), read through the AuthApi facade so the shell
  // works without a tRPC provider in tests. Loading, failure or an unknown key ⇒ hidden (fail closed).
  const bootstrap = useQuery({ queryKey: ["rp", "platform", "bootstrap", "nav"], queryFn: () => api.bootstrap(), enabled: needed, staleTime: 60_000, retry: false });
  const features = bootstrap.data?.features ?? {};
  return items.filter((item) => !item.enabledBy || (Object.hasOwn(features, item.enabledBy) && features[item.enabledBy] === true));
}

export type NavPlacement = NonNullable<NavItem["placement"]>;

/** Paths that default to the avatar menu rather than the top bar (see `NavItem.placement`). */
const ACCOUNT_PATHS = ["/account", "/policies"];
/** Paths that already have a dedicated control in the top bar (the notification bell). */
const HIDDEN_PATHS = ["/notifications"];

const underAny = (href: string, roots: readonly string[]) => roots.some((root) => href === root || href.startsWith(`${root}/`));

/** Shell-level placement rule: explicit `placement` wins, otherwise derived from the path. */
export function navPlacement(item: NavItem): NavPlacement {
  if (item.placement) return item.placement;
  if (item.area !== "customer") return "primary";
  if (underAny(item.href, HIDDEN_PATHS)) return "hidden";
  if (underAny(item.href, ACCOUNT_PATHS)) return "account";
  return "primary";
}

/** Maximum entries drawn inline in the customer top bar; the rest go to a "More" menu. */
export const MAX_PRIMARY_NAV = 5;

export interface CustomerNavLayout {
  /** Drawn inline in the top bar (at most MAX_PRIMARY_NAV). */
  primary: NavItem[];
  /** Primary entries beyond the cap, offered from the top bar's "More" menu. */
  more: NavItem[];
  /** Avatar-menu entries (with defaults when no feature registers any). */
  account: NavItem[];
}

const DEFAULT_ACCOUNT_NAV: NavItem[] = [
  { label: "Your account", href: "/account", icon: UserRound, area: "customer", access: "customer", order: 80, placement: "account" },
  { label: "Account security", href: "/account/security", icon: ShieldCheck, area: "customer", access: "customer", order: 90, placement: "account" },
];

export function customerNavLayout(items: readonly NavItem[]): CustomerNavLayout {
  const byOrder = (a: NavItem, b: NavItem) => a.order - b.order;
  const all = [...items].sort(byOrder);
  const primaryAll = all.filter((item) => navPlacement(item) === "primary");
  const account = all.filter((item) => navPlacement(item) === "account");
  const accountHrefs = new Set(account.map((item) => item.href));
  for (const fallback of DEFAULT_ACCOUNT_NAV) if (!accountHrefs.has(fallback.href)) account.push(fallback);
  account.sort(byOrder);
  return { primary: primaryAll.slice(0, MAX_PRIMARY_NAV), more: primaryAll.slice(MAX_PRIMARY_NAV), account };
}

export type CustomerSection = "main" | "Support" | "Account";
export const CUSTOMER_SECTIONS: readonly { key: CustomerSection; heading: string | null }[] = [
  { key: "main", heading: null },
  { key: "Support", heading: "Support" },
  { key: "Account", heading: "Account" },
];

/** Customer sidebar section: explicit group wins; account-placed entries count as "Account". */
export function customerSection(item: NavItem): CustomerSection {
  if (item.group === "Support" || item.group === "Account") return item.group;
  return navPlacement(item) === "account" ? "Account" : "main";
}

export interface CustomerNavSections {
  main: NavItem[];
  Support: NavItem[];
  Account: NavItem[];
  /** Phone bottom bar (at most 4). */
  phone: NavItem[];
}

/** Preferred phone bottom-bar entries, in order; free slots are filled from the main section. */
export const PHONE_BAR_HREFS = ["/", "/orders", "/orders/new", "/messages"] as const;

export function customerNavSections(items: readonly NavItem[]): CustomerNavSections {
  const visible = [...items].filter((item) => navPlacement(item) !== "hidden").sort((a, b) => a.order - b.order);
  const out: CustomerNavSections = { main: [], Support: [], Account: [], phone: [] };
  for (const item of visible) out[customerSection(item)].push(item);
  const hrefs = new Set(out.Account.map((item) => item.href));
  for (const fallback of DEFAULT_ACCOUNT_NAV) if (!hrefs.has(fallback.href)) out.Account.push(fallback);
  out.Account.sort((a, b) => a.order - b.order);
  const preferred = PHONE_BAR_HREFS.map((href) => out.main.find((item) => item.href === href)).filter((item): item is NavItem => Boolean(item));
  const rest = out.main.filter((item) => !preferred.includes(item));
  out.phone = [...preferred, ...rest].slice(0, 4);
  return out;
}

/**
 * The single current entry: the longest href that matches the location (so `/orders/new` wins over `/orders`,
 * and `/admin/storage/copies` over `/admin/storage`).
 */
export function currentNavHref(location: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) if (isActivePath(location, href) && (best === null || href.length > best.length)) best = href;
  return best;
}

export function useCurrentNav(items: readonly NavItem[]) {
  const [location] = useLocation();
  const current = currentNavHref(
    location,
    items.map((item) => item.href),
  );
  return (href: string) => href === current;
}

export function isActivePath(location: string, href: string): boolean {
  if (href === "/" || href === "/admin") return location === href;
  return location === href || location.startsWith(`${href}/`);
}

export function useActive() {
  const [location] = useLocation();
  return (href: string) => isActivePath(location, href);
}

const themeIcons: Record<ThemePreference, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };
const themeLabels: Record<ThemePreference, string> = { system: "System", light: "Light", dark: "Dark" };

export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();
  const Icon = themeIcons[preference];
  return (
    <DropdownMenu
      trigger={<IconButton label={`Theme: ${themeLabels[preference]}. Change theme`} icon={<Icon />} className={className} />}
      items={[
        { heading: "Theme" },
        ...(["system", "light", "dark"] as const).map((value) => {
          const ItemIcon = themeIcons[value];
          return { label: `${themeLabels[value]}${preference === value ? " (current)" : ""}`, icon: <ItemIcon aria-hidden="true" />, onSelect: () => setPreference(value) };
        }),
      ]}
    />
  );
}

/** Up to two initials from words that start with a letter or digit (Unicode-aware); "?" when none. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter((word) => /^[\p{L}\p{N}]/u.test(word));
  const picks = words.map((word) => [...word][0] ?? "");
  const chosen = picks.length > 1 ? [picks[0], picks[picks.length - 1]] : picks;
  return chosen.join("").toLocaleUpperCase() || "?";
}

export function AccountMenu({ user, area, items: accountItems }: { user: MeUser; area: "customer" | "console"; items?: readonly NavItem[] }) {
  const signOut = useSignOut();
  const staff = user.role !== "customer";
  const entries = accountItems ?? DEFAULT_ACCOUNT_NAV;
  const pwa = usePwaInstall();
  // The install dialog lives outside the menu so it survives the menu closing and returns focus normally.
  const [installOpen, setInstallOpen] = useState(false);
  // The menu item that opened the dialog has unmounted by the time it closes, so focus returns to the trigger.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onInstallOpenChange = (open: boolean) => {
    setInstallOpen(open);
    if (!open) requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const install = () => {
    void pwa.prompt().then((result) => {
      if (result === "unavailable") setInstallOpen(true);
    });
  };
  return (
    <>
    <DropdownMenu
      header={
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{user.name}</p>
          <p className="truncate text-xs text-muted">{user.email}</p>
        </div>
      }
      trigger={
        <button ref={triggerRef} type="button" aria-label={`${initials(user.name)}, account menu for ${user.name}`} className="inline-flex size-11 items-center justify-center rounded-full">
          <span aria-hidden="true" className="inline-flex size-9 items-center justify-center rounded-full bg-action text-sm font-semibold text-on-action">
            {initials(user.name)}
          </span>
        </button>
      }
      items={[
        ...entries.map((entry) => ({
          label: entry.label,
          asChild: (
            <Link href={entry.href}>
              <entry.icon aria-hidden={true} />
              {entry.label}
            </Link>
          ),
        })),
        ...(staff ? [area === "console" ? { label: "Customer view", icon: <UserRound aria-hidden="true" />, asChild: <Link href="/">Customer view</Link> } : { label: "Console", icon: <Settings aria-hidden="true" />, asChild: <Link href="/admin">Console</Link> }] : []),
        ...(pwa.available && !pwa.installed ? [{ label: "Install app", icon: <Download aria-hidden="true" />, onSelect: install }] : []),
        "separator" as const,
        { label: "Sign out", icon: <LogOut aria-hidden="true" />, onSelect: () => void signOut() },
      ]}
    />
    <PwaInstallDialog open={installOpen} onOpenChange={onInstallOpenChange} />
    </>
  );
}

export function Footer({ className }: { className?: string }) {
  const year = new Date().getFullYear();
  return (
    <footer className={cn("border-t border-line bg-surface", className)}>
      <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-5 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <p>
          © {year} {LEGAL_NAME}
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-1">
          <Link href="/privacy" className="inline-flex min-h-11 items-center underline-offset-2 hover:text-ink hover:underline sm:min-h-6">
            Privacy
          </Link>
          <Link href="/terms" className="inline-flex min-h-11 items-center underline-offset-2 hover:text-ink hover:underline sm:min-h-6">
            Terms
          </Link>
          <Link href="/accessibility" className="inline-flex min-h-11 items-center underline-offset-2 hover:text-ink hover:underline sm:min-h-6">
            Accessibility
          </Link>
          <ManageCookiesButton />
          <a href={PUBLIC_SITE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline-offset-2 hover:text-ink hover:underline sm:min-h-6">
            readypackets.com<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </nav>
      </div>
    </footer>
  );
}

/** Persistent "Manage cookie preferences" control (decision 14); only when the consent feature is on. */
export function ManageCookiesButton() {
  const state = useConsent();
  if (!state.enabled) return null;
  return (
    <button type="button" onClick={state.openPreferences} className="inline-flex min-h-11 items-center text-left underline-offset-2 hover:text-ink hover:underline sm:min-h-6">
      Manage cookie preferences
    </button>
  );
}

export const PRESENTATION_QUERY_KEY = ["rp", "platform", "presentation"] as const;

/** True when either the server (platform.presentation.preview) or this build reports the preview profile. */
export function usePreviewProfile(): boolean {
  const api = useAuthApi();
  const presentation = useQuery({ queryKey: PRESENTATION_QUERY_KEY, queryFn: () => api.presentation(), staleTime: 5 * 60_000, retry: false });
  return RUNTIME.preview || presentation.data?.preview === true;
}

/** Permanent, non-dismissible preview notice shown in every shell (review H-3). */
export function PreviewBanner() {
  if (!usePreviewProfile()) return null;
  return (
    <div className="border-b border-info/40 bg-info-soft" data-testid="preview-banner">
      <p className="mx-auto max-w-7xl px-4 py-2 text-center text-sm font-semibold text-ink sm:px-6 lg:px-8">
        Preview — synthetic data only. Do not enter real customer or personal information.
      </p>
    </div>
  );
}

/** Public maintenance notice (jobs.maintenanceBanner). Renders nothing when inactive or unavailable. */
export function MaintenanceBanner() {
  const api = useAuthApi();
  const banner = useQuery({ queryKey: ["rp", "jobs", "maintenanceBanner"], queryFn: () => api.maintenanceBanner(), staleTime: 60_000, retry: false });
  if (!banner.data?.active) return null;
  return (
    <div className="border-b border-warning/40 bg-warning-soft">
      <div className="mx-auto max-w-7xl px-4 py-1 sm:px-6 lg:px-8">
        <Callout tone="warning" live="polite" className="border-0 bg-transparent px-0 py-2">
          {banner.data.message ?? "Scheduled maintenance is in progress. Some actions may be temporarily unavailable."}
        </Callout>
      </div>
    </div>
  );
}

export function SkipLink() {
  return (
    <a
      href="#main"
      className="rp-skip-link"
      onClick={(event) => {
        // Hash routing (preview) must not treat this as navigation.
        event.preventDefault();
        const main = document.getElementById("main");
        main?.focus({ preventScroll: true });
        main?.scrollIntoView({ block: "start" });
      }}
    >
      Skip to main content
    </a>
  );
}
