/**
 * Route + navigation registry contract. Owner: integrator (/root).
 * Every feature folder exports `routes` and (optionally) `nav` from `client/src/features/<feature>/routes.tsx`.
 * The UI foundation renders them inside the correct shell and enforces `access` client-side; the SERVER is
 * always the authority — hiding a link is never an authorization control.
 */
import type { ComponentType, LazyExoticComponent } from "react";
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

export interface FeatureRoutes {
  routes: RouteDef[];
  nav?: NavItem[];
}
