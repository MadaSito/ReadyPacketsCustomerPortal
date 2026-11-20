/** Feature registry. Owner: integrator (/root). One line per feature; features never import each other. */
import { createElement, type ComponentType } from "react";
import type { FeatureRoutes, RouteDef, RouteWrapper } from "@/lib/routes";
import { authFeature } from "@/features/auth/routes";
import { dashboardFeature } from "@/features/dashboard/routes";
import { identityFeature } from "@/features/identity/routes";
import { assuranceFeature } from "@/features/assurance/routes";
import { ordersFeature } from "@/features/orders/routes";
import { filesFeature } from "@/features/files/routes";
import { engagementFeature } from "@/features/engagement/routes";
import { complianceFeature } from "@/features/compliance/routes";
import { auditFeature } from "@/features/audit/routes";
import { siemFeature } from "@/features/siem/routes";
import { platformFeature } from "@/features/platform/routes";
import { jobsFeature } from "@/features/jobs/routes";
import { portableFeature } from "@/features/portable/routes";
import { backupFeature } from "@/features/backup/routes";
import { integrationsFeature } from "@/features/integrations/routes";

export const FEATURES: readonly FeatureRoutes[] = [
  authFeature,
  dashboardFeature,
  identityFeature,
  assuranceFeature,
  ordersFeature,
  filesFeature,
  engagementFeature,
  complianceFeature,
  auditFeature,
  siemFeature,
  platformFeature,
  jobsFeature,
  portableFeature,
  backupFeature,
  integrationsFeature,
];

export const ROUTE_WRAPPERS: readonly RouteWrapper[] = FEATURES.flatMap((feature) => feature.routeWrappers ?? []).sort((a, b) => a.order - b.order);

/** Applies registered wrappers (outermost first) to a route's component; routes without wrappers are untouched. */
export function applyRouteWrappers(route: RouteDef, wrappers: readonly RouteWrapper[] = ROUTE_WRAPPERS): RouteDef {
  const matching = wrappers.filter((wrapper) => wrapper.path === route.path);
  if (matching.length === 0) return route;
  const Inner = route.component as ComponentType;
  const Wrapped: ComponentType = () =>
    matching.reduceRight((child, wrapper) => createElement(wrapper.component, null, child), createElement(Inner));
  Wrapped.displayName = `Wrapped(${route.path})`;
  return { ...route, component: Wrapped };
}

export const ALL_ROUTES = FEATURES.flatMap((feature) => feature.routes).map((route) => applyRouteWrappers(route));
export const ALL_NAV = FEATURES.flatMap((feature) => feature.nav ?? []).sort((a, b) => a.order - b.order);
export const ORDER_TABS = FEATURES.flatMap((feature) => feature.orderTabs ?? []).sort((a, b) => a.order - b.order);
export const CUSTOMER_TABS = FEATURES.flatMap((feature) => feature.customerTabs ?? []).sort((a, b) => a.order - b.order);
export const WIDGETS = FEATURES.flatMap((feature) => feature.widgets ?? []).sort((a, b) => a.order - b.order);
