import { lazy } from "react";
import { KeyRound } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

export const publicApiPages = [
  { path: "/admin/api", title: "API keys", navigation: "Keys", capability: "api.keys.manage", component: lazy(() => import("./pages").then((m) => ({ default: m.KeysPage }))) },
  { path: "/admin/api/log", title: "API request log", navigation: "Request log", capability: "api.logs.read", component: lazy(() => import("./pages").then((m) => ({ default: m.LogPage }))) },
] as const;

export const publicApiFeature: FeatureRoutes = {
  routes: [
    ...publicApiPages.map(({ path, title, capability, component }) => ({ access: "admin" as const, capability, path, title, component })),
    { access: "admin", capability: "api.logs.read", path: "/admin/api/log/:requestId", title: "API request details", component: lazy(() => import("./pages").then((m) => ({ default: m.RequestDetailPage }))) },
  ],
  nav: [{ access: "admin", capability: "api.logs.read", label: "Public API", href: "/admin/api", icon: KeyRound, area: "console", group: "Platform", order: 73 }],
};
