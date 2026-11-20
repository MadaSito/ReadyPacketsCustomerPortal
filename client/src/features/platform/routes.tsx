/** platform feature — routes, navigation and the console overview widget. Owner: platform engineer. Every page is lazy and admin-only; the server re-checks. */
import { lazy } from "react";
import { Activity, ListChecks, Settings2 } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const SystemHealthWidget = lazy(() => import("./widgets/SystemHealthWidget"));

const manage = { access: "admin", capability: "platform.settings.manage" } as const;

export const platformFeature: FeatureRoutes = {
  routes: [
    { access: "admin", path: "/admin/setup", title: "Installation setup", component: lazy(() => import("./pages/SetupPage")) },
    { ...manage, path: "/admin/settings", title: "Settings", component: lazy(() => import("./pages/SettingsPage")) },
    { ...manage, path: "/admin/settings/features", title: "Features", component: lazy(() => import("./pages/FeaturesPage")) },
    { ...manage, path: "/admin/settings/presentation", title: "Sign-in page", component: lazy(() => import("./pages/PresentationPage")) },
    { ...manage, path: "/admin/settings/transfer", title: "Export and import", component: lazy(() => import("./pages/ConfigTransferPage")) },
    { access: "staff", capability: "platform.health.read", path: "/admin/health", title: "System health", component: lazy(() => import("./pages/HealthPage")) },
  ],
  nav: [
    { access: "admin", label: "Setup", href: "/admin/setup", icon: ListChecks, area: "console", group: "Platform", order: 80 },
    { ...manage, label: "Settings", href: "/admin/settings", icon: Settings2, area: "console", group: "Platform", order: 81 },
    { access: "staff", capability: "platform.health.read", label: "System health", href: "/admin/health", icon: Activity, area: "console", group: "Platform", order: 82 },
  ],
  widgets: [
    { key: "platform.system_health", area: "console", access: "staff", capability: "platform.health.read", order: 10, span: 4, component: SystemHealthWidget },
  ],
};
