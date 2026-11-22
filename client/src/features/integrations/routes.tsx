/**
 * integrations feature — routes, navigation, and console order tabs.
 * `routes.tsx` + `consent.tsx` owned by `integrations_engineer`;
 * `./admin/**` owned by `identity_engineer`;
 * `./production/**` owned by `siem_engineer`.
 */
import type { FeatureRoutes, NavItem, OrderTab, RouteDef } from "@/lib/routes";

interface IntegrationsAdminModule {
  integrationsAdminRoutes?: readonly RouteDef[];
  integrationsAdminNav?: readonly NavItem[];
}

interface IntegrationsProductionModule {
  productionAdminRoutes?: readonly RouteDef[];
  integrationsProductionRoutes?: readonly RouteDef[];
  productionAdminNav?: readonly NavItem[];
  integrationsProductionNav?: readonly NavItem[];
  productionOrderTabs?: readonly OrderTab[];
  integrationsProductionOrderTabs?: readonly OrderTab[];
}

interface IntegrationsWebhooksModule {
  webhookRoutes?: readonly RouteDef[];
  webhookNav?: readonly NavItem[];
}

const adminModules = import.meta.glob<IntegrationsAdminModule>("./admin/index.{ts,tsx}", {
  eager: true,
});
const loadedAdmin = Object.values(adminModules)[0];

const productionModules = import.meta.glob<IntegrationsProductionModule>("./production/index.{ts,tsx}", {
  eager: true,
});
const loadedProduction = Object.values(productionModules)[0];

const webhookModules = import.meta.glob<IntegrationsWebhooksModule>("./webhooks/index.{ts,tsx}", {
  eager: true,
});
const loadedWebhooks = Object.values(webhookModules)[0];

export const integrationsFeature: FeatureRoutes = {
  routes: [
    ...(loadedAdmin?.integrationsAdminRoutes ?? []),
    ...(loadedProduction?.productionAdminRoutes ?? loadedProduction?.integrationsProductionRoutes ?? []),
    ...(loadedWebhooks?.webhookRoutes ?? []),
  ],
  nav: [
    ...(loadedAdmin?.integrationsAdminNav ?? []),
    ...(loadedProduction?.productionAdminNav ?? loadedProduction?.integrationsProductionNav ?? []),
    ...(loadedWebhooks?.webhookNav ?? []),
  ],
  orderTabs: [
    ...(loadedProduction?.productionOrderTabs ?? loadedProduction?.integrationsProductionOrderTabs ?? []),
  ],
};
