/**
 * Route + navigation registry contract. Owner: integrator (/root).
 * Every feature folder exports `routes` and (optionally) `nav` from `client/src/features/<feature>/routes.tsx`.
 * The UI foundation renders them inside the correct shell and enforces `access` client-side; the SERVER is
 * always the authority — hiding a link is never an authorization control.
 */
import type { ComponentType, LazyExoticComponent, ReactNode } from "react";
import type { Capability } from "@shared/capabilities";

export type RouteAccess =
  /** No session required (sign-in, register, reset, public policy pages). */
  | "public"
  /** Remediation flow screens (verify email, MFA challenge/enrol, recovery codes, forced password change). */
  | "transition"
  /** Any full session. */
  | "customer"
  /** Full session with role staff or admin. */
  | "staff"
  /** Full session with role admin. */
  | "admin";

export interface RouteDef {
  /** wouter pattern, e.g. `/orders/:orderId`. Customer area lives at `/…`, console at `/admin/…`. */
  path: string;
  access: RouteAccess;
  /** Document title segment; rendered as `<title> · ReadyPackets`. Also announced to screen readers on navigation. */
  title: string;
  component: LazyExoticComponent<ComponentType> | ComponentType;
  /** Optional capability hint for hiding UI. */
  capability?: Capability;
}

export interface NavItem {
  label: string;
  href: string;
  /** lucide-react icon component. */
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  area: "customer" | "console";
  /**
   * Console: grouping heading, e.g. "Operations", "Security", "Platform".
   * Customer area: undefined = main section, "Support" or "Account" (entries placed in the account menu
   * without a group count as "Account").
   */
  group?: string;
  /**
   * Feature switch key (`features.enabled(key)`, platform port). The entry is shown only while the switch is
   * on, and is hidden while loading or when the port is unavailable. Hiding is never authorisation.
   */
  enabledBy?: "cart" | "community" | "referrals" | "knowledge" | (string & {});
  access: RouteAccess;
  capability?: Capability;
  /** Sort order within the area/group (lower first). */
  order: number;
  /**
   * Where the customer shell places the entry (the console sidebar lists everything that isn't "hidden").
   * - "primary": shown in the top bar, the phone bottom bar and the menu drawer.
   * - "account": shown in the avatar menu and in the drawer's "Your account" section.
   * - "hidden": routable but not in navigation (for example Notifications, which the bell opens).
   * When omitted, the shell decides by path: `/account…` and `/policies` → account, `/notifications` → hidden,
   * everything else → primary. Primary is capped (extra entries go to "More"), so labels can never collide.
   */
  placement?: "primary" | "account" | "hidden";
}

/**
 * Cross-feature composition without cross-feature imports: a feature contributes a tab to another feature's
 * detail page. The host page renders every registered tab for its slot (see `ORDER_TABS` / `CUSTOMER_TABS`).
 */
export interface DetailTab<Props> {
  /** Stable key used in the URL (`/orders/:orderId/<key>`). */
  key: string;
  label: string;
  /** Lazy component receiving the host record's publicId. */
  component: LazyExoticComponent<ComponentType<Props>> | ComponentType<Props>;
  /** `customer` tabs show in the customer area and console; `staff`/`admin` only in the console. */
  access: "customer" | "staff" | "admin";
  order: number;
  /** Optional small component rendered next to the label (e.g. unread count). */
  badge?: ComponentType<Props>;
  /**
   * Optional dynamic label rendered IN PLACE OF `label` (text only, e.g. "SharePoint sync (2)"). `label` stays
   * required: it is shown while the component loads and remains the fallback name. Count queries must be cheap
   * and must not run for users who cannot see the tab (the host only mounts it for visible tabs).
   */
  labelComponent?: ComponentType<Props>;
}
export type OrderTab = DetailTab<{ orderId: string; area: "customer" | "console" }>;
/**
 * Full-width block a feature contributes to the order page, rendered between the header and the tab strip
 * (host: orders feature; e.g. the acceptance gate). Rendered inside Suspense with no fallback; the component
 * renders null when it has nothing to show. Server checks stay authoritative.
 */
export interface OrderBanner {
  key: string;
  /** Lower first. */
  order: number;
  area: "customer" | "console" | "both";
  component: LazyExoticComponent<ComponentType<{ orderId: string; area: "customer" | "console" }>> | ComponentType<{ orderId: string; area: "customer" | "console" }>;
}
export type CustomerTab = DetailTab<{ customerId: string }>;
/** Cards a feature contributes to the customer dashboard or console overview. */
export interface DashboardWidget {
  key: string;
  area: "customer" | "console";
  access: RouteAccess;
  capability?: Capability;
  order: number;
  /** Suggested width on a 12-column grid at desktop: 4, 6, 8 or 12. Always full width on mobile. */
  span: 4 | 6 | 8 | 12;
  component: LazyExoticComponent<ComponentType> | ComponentType;
}

/**
 * A feature may wrap ANOTHER feature's route without importing it (for example compliance requiring current
 * policy acceptance before the new-order page). The wrapper renders `children` when its condition is met.
 * This is a convenience for the visitor only — the server enforces the same rule.
 */
export interface RouteWrapper {
  /** Exact `RouteDef.path` to wrap. */
  path: string;
  component: ComponentType<{ children: ReactNode }>;
  /** Lower runs outermost. */
  order: number;
}

/** A card a feature contributes to the customer Security page (`/account/security`, host: assurance feature). */
export interface SecurityCard {
  key: string;
  /** Lower first. Two-factor (host) sits at 20. */
  order: number;
  access: "customer" | "staff" | "admin";
  component: LazyExoticComponent<ComponentType> | ComponentType;
}

export interface FeatureRoutes {
  routes: RouteDef[];
  nav?: NavItem[];
  /** Tabs contributed to the order detail page (host: orders feature). */
  orderTabs?: OrderTab[];
  /** Full-width banners on the order page between header and tabs (host: orders feature). */
  orderBanners?: OrderBanner[];
  /** Tabs contributed to the console customer detail page (host: identity feature). */
  customerTabs?: CustomerTab[];
  /** Cards contributed to the dashboards (host: dashboard feature). */
  widgets?: DashboardWidget[];
  /** Wrappers applied around routes owned by other features (see `RouteWrapper`). */
  routeWrappers?: RouteWrapper[];
  /** Cards contributed to the customer Security page (host: assurance feature). */
  securityCards?: SecurityCard[];
}
