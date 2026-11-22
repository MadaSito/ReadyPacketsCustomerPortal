/** platform feature — routes, navigation and the console overview widget. Owner: platform engineer. Every page is lazy; console pages are admin/staff only and /account/privacy is any full session. The server re-checks. */
import { lazy } from "react";
import { Activity, Cookie, ListChecks, Settings2, ShieldCheck } from "lucide-react";
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
    { access: "admin", capability: "privacy.consent.read", path: "/admin/privacy", title: "Cookies and consent", component: lazy(() => import("./consent/ConsentAdminPage")) },
    { access: "customer", path: "/account/privacy", title: "Privacy and cookies", component: lazy(() => import("./consent/PrivacyPage")) },
  ],
  nav: [
    { access: "admin", label: "Setup", href: "/admin/setup", icon: ListChecks, area: "console", group: "Platform", order: 80 },
    { ...manage, label: "Settings", href: "/admin/settings", icon: Settings2, area: "console", group: "Platform", order: 81 },
    { access: "staff", capability: "platform.health.read", label: "System health", href: "/admin/health", icon: Activity, area: "console", group: "Platform", order: 82 },
    { access: "admin", capability: "privacy.consent.read", label: "Cookies and consent", href: "/admin/privacy", icon: Cookie, area: "console", group: "Platform", order: 83 },
    { access: "customer", label: "Privacy and cookies", href: "/account/privacy", icon: ShieldCheck, area: "customer", group: "Account", order: 240, placement: "account" },
  ],
  widgets: [
    { key: "platform.system_health", area: "console", access: "staff", capability: "platform.health.read", order: 10, span: 4, component: SystemHealthWidget },
  ],
};
