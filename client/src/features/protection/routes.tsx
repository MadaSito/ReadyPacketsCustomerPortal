import { lazy } from "react";
import { ShieldCheck } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const access = { access: "admin", capability: "security.firewall.read" } as const;
export const protectionPages = [
  { path: "/admin/protection", title: "Protection overview", navigation: "Overview", component: lazy(() => import("./pages").then((m) => ({ default: m.OverviewPage }))) },
  { path: "/admin/protection/rules", title: "Protection rules", navigation: "Rules", component: lazy(() => import("./pages").then((m) => ({ default: m.RulesPage }))) },
  { path: "/admin/protection/ip-lists", title: "Protection IP lists", navigation: "IP lists", component: lazy(() => import("./pages").then((m) => ({ default: m.IpListsPage }))) },
  { path: "/admin/protection/countries", title: "Protection countries", navigation: "Countries", component: lazy(() => import("./pages").then((m) => ({ default: m.CountriesPage }))) },
  { path: "/admin/protection/rate-limits", title: "Protection rate limits", navigation: "Rate limits", component: lazy(() => import("./pages").then((m) => ({ default: m.RateLimitsPage }))) },
  { path: "/admin/protection/events", title: "Protection events", navigation: "Events", component: lazy(() => import("./pages").then((m) => ({ default: m.EventsPage }))) },
  { path: "/admin/protection/bans", title: "Sign-in bans", navigation: "Sign-in bans", component: lazy(() => import("./pages").then((m) => ({ default: m.SignInBansPage }))) },
] as const;

export const protectionFeature: FeatureRoutes = {
  routes: protectionPages.map(({ path, title, component }) => ({ ...access, path, title, component })),
  nav: [{ ...access, label: "Protection", href: "/admin/protection", icon: ShieldCheck, area: "console", group: "Platform", order: 72 }],
};
