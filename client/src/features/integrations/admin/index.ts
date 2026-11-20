/**
 * Integrations console — routes and navigation. Owner: identity engineer (UI). Spread into integrationsFeature by
 * ../routes.tsx via import.meta.glob. Every page is lazy-loaded; all need the admin role plus integrations.manage.
 */
import { lazy } from "react";
import { Plug } from "lucide-react";
import type { NavItem, RouteDef } from "@/lib/routes";

const guard = { access: "admin", capability: "integrations.manage" } as const;

export const integrationsAdminRoutes: readonly RouteDef[] = [
  { ...guard, path: "/admin/integrations", title: "Integrations", component: lazy(() => import("./pages/IntegrationsOverviewPage")) },
  { ...guard, path: "/admin/integrations/smtp", title: "E-mail (SMTP)", component: lazy(() => import("./pages/SmtpPage")) },
  { ...guard, path: "/admin/integrations/analytics", title: "Analytics", component: lazy(() => import("./pages/AnalyticsPage")) },
  { ...guard, path: "/admin/integrations/egress", title: "Outbound connections", component: lazy(() => import("./pages/EgressPage")) },
];

export const integrationsAdminNav: readonly NavItem[] = [
  { ...guard, label: "Integrations", href: "/admin/integrations", icon: Plug, area: "console", group: "Platform", order: 83 },
];
