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
  /** Console grouping heading, e.g. "Operations", "Security", "Platform". */
  group?: string;
  access: RouteAccess;
  capability?: Capability;
  /** Sort order within the area/group (lower first). */
  order: number;
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
}
export type OrderTab = DetailTab<{ orderId: string; area: "customer" | "console" }>;
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

export interface FeatureRoutes {
  routes: RouteDef[];
  nav?: NavItem[];
  /** Tabs contributed to the order detail page (host: orders feature). */
  orderTabs?: OrderTab[];
  /** Tabs contributed to the console customer detail page (host: identity feature). */
  customerTabs?: CustomerTab[];
  /** Cards contributed to the dashboards (host: dashboard feature). */
  widgets?: DashboardWidget[];
  /** Wrappers applied around routes owned by other features (see `RouteWrapper`). */
  routeWrappers?: RouteWrapper[];
}
