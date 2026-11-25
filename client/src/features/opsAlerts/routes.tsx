import { BellRing } from "lucide-react";
import { lazy } from "react";
import type { FeatureRoutes } from "@/lib/routes";

const access = { access: "staff", capability: "ops.alerts.read" } as const;

export const opsAlertsFeature: FeatureRoutes = {
  routes: [{ ...access, path: "/admin/alerts", title: "Operational alerts", component: lazy(() => import("./OpsAlertsPage")) }],
  nav: [{ ...access, label: "Operational alerts", href: "/admin/alerts", icon: BellRing, area: "console", group: "Operations", order: 18 }],
  widgets: [{ ...access, key: "operations.alerts", area: "console", order: 25, span: 4, component: lazy(() => import("./OpsAlertsWidget")) }],
};
