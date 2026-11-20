/**
 * Production pipeline client registrations (`client/src/features/integrations/production/**`).
 * Spread into `integrationsFeature` via `client/src/features/integrations/routes.tsx`.
 */
import { lazy } from "react";
import { Workflow } from "lucide-react";
import type { NavItem, OrderTab, RouteDef } from "@/lib/routes";
import { PRODUCTION_PIPELINE_PATH } from "./model";

const ProductionPipelinePage = lazy(() => import("./ProductionPipelinePage"));
const OrderProductionTab = lazy(() => import("./OrderProductionTab"));

const manageGuard = { access: "admin", capability: "integrations.manage" } as const;

export const productionAdminRoutes: readonly RouteDef[] = [
  {
    ...manageGuard,
    path: PRODUCTION_PIPELINE_PATH,
    title: "Production pipeline",
    component: ProductionPipelinePage,
  },
];

export const productionAdminNav: readonly NavItem[] = [
  {
    ...manageGuard,
    label: "Production pipeline",
    href: PRODUCTION_PIPELINE_PATH,
    icon: Workflow,
    area: "console",
    group: "Platform",
    order: 84,
  },
];

export const productionOrderTabs: readonly OrderTab[] = [
  {
    key: "production",
    label: "Production",
    component: OrderProductionTab,
    access: "staff",
    order: 30,
  },
];

// Aliases for ergonomic glob discovery in `routes.tsx`.
export const integrationsProductionRoutes = productionAdminRoutes;
export const integrationsProductionNav = productionAdminNav;
export const integrationsProductionOrderTabs = productionOrderTabs;
