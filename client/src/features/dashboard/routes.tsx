/** dashboard feature — customer home and console overview. Owner: ui_foundation_engineer. */
import { Home, LayoutDashboard } from "lucide-react";
import { lazy } from "react";
import type { FeatureRoutes } from "@/lib/routes";

export const dashboardFeature: FeatureRoutes = {
  routes: [
    { path: "/", access: "customer", title: "Home", component: lazy(() => import("./pages/CustomerHomePage")) },
    { path: "/admin", access: "staff", title: "Overview", component: lazy(() => import("./pages/ConsoleOverviewPage")) },
  ],
  nav: [
    { label: "Dashboard", href: "/", icon: Home, area: "customer", access: "customer", order: 0 },
    { label: "Overview", href: "/admin", icon: LayoutDashboard, area: "console", group: "Overview", access: "staff", order: 0 },
  ],
};
