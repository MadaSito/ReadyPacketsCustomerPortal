import type {
  CustomerTab,
  DashboardWidget,
  FeatureRoutes,
  NavItem,
  OrderBanner,
  OrderTab,
  RouteDef,
  RouteWrapper,
} from "@/lib/routes";
import { acceptanceOrderBanners, acceptanceOrderTabs, acceptanceRoutes } from "./acceptance";

interface ComplianceCustomerModule {
  complianceCustomerRoutes?: RouteDef[];
  complianceCustomerNav?: NavItem[];
  complianceOrderTabs?: OrderTab[];
  complianceWidgets?: DashboardWidget[];
  complianceRouteWrappers?: RouteWrapper[];
}

interface ComplianceAdminModule {
  complianceAdminRoutes?: RouteDef[];
  complianceAdminNav?: NavItem[];
}

interface ComplianceAcceptanceLogModule {
  acceptanceLogRoutes?: RouteDef[];
  acceptanceLogNav?: NavItem[];
  acceptanceLogCustomerTabs?: CustomerTab[];
}

const customerModules = import.meta.glob<ComplianceCustomerModule>(
  "./customer/index.{ts,tsx}",
  { eager: true },
);
const adminModules = import.meta.glob<ComplianceAdminModule>(
  "./admin/index.{ts,tsx}",
  { eager: true },
);
const acceptanceLogModules = import.meta.glob<ComplianceAcceptanceLogModule>(
  "./pages/acceptances/index.{ts,tsx}",
  { eager: true },
);

const customerMod = Object.values(customerModules)[0];
const adminMod = Object.values(adminModules)[0];
const acceptanceLogMod = Object.values(acceptanceLogModules)[0];

export const routes: RouteDef[] = [
  ...(customerMod?.complianceCustomerRoutes ?? []),
  ...(adminMod?.complianceAdminRoutes ?? []),
  ...(acceptanceLogMod?.acceptanceLogRoutes ?? []),
  ...acceptanceRoutes,
];

function normalizeCustomerNav(items: NavItem[]): NavItem[] {
  return items.map((item) => {
    if (item.href === "/invoices") {
      const { group: _group, ...rest } = item;
      return { ...rest, order: 40 };
    }
    if (item.href === "/policies") {
      return { ...item, group: "Account", order: 230 };
    }
    return item;
  });
}

export const nav: NavItem[] = [
  ...normalizeCustomerNav(customerMod?.complianceCustomerNav ?? []),
  ...(adminMod?.complianceAdminNav ?? []),
  ...(acceptanceLogMod?.acceptanceLogNav ?? []),
];

export const orderTabs: OrderTab[] = [
  ...(customerMod?.complianceOrderTabs ?? []),
  ...acceptanceOrderTabs,
];

export const orderBanners: OrderBanner[] = [...acceptanceOrderBanners];

export const customerTabs: CustomerTab[] = [
  ...(acceptanceLogMod?.acceptanceLogCustomerTabs ?? []),
];

export const widgets: DashboardWidget[] = [
  ...(customerMod?.complianceWidgets ?? []),
];

export const routeWrappers: RouteWrapper[] = [
  ...(customerMod?.complianceRouteWrappers ?? []),
];

export const complianceFeature: FeatureRoutes = {
  routes,
  nav,
  orderTabs,
  orderBanners,
  customerTabs,
  widgets,
  routeWrappers,
};

export default complianceFeature;
