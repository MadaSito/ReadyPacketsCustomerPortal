/**
 * integrations feature — routes and navigation.
 * `routes.tsx` + `consent.tsx` owned by `integrations_engineer`; `./admin/**` owned by `identity_engineer`
 * (`integrationsAdminRoutes` + `integrationsAdminNav` exported from `./admin/index.ts`).
 */
import type { FeatureRoutes, NavItem, RouteDef } from "@/lib/routes";

interface IntegrationsAdminModule {
  integrationsAdminRoutes?: readonly RouteDef[];
  integrationsAdminNav?: readonly NavItem[];
}

const adminModules = import.meta.glob<IntegrationsAdminModule>("./admin/index.{ts,tsx}", {
  eager: true,
});

const loadedAdmin = Object.values(adminModules)[0];

export const integrationsFeature: FeatureRoutes = {
  routes: [...(loadedAdmin?.integrationsAdminRoutes ?? [])],
  nav: [...(loadedAdmin?.integrationsAdminNav ?? [])],
};
