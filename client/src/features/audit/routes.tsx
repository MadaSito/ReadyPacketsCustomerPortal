/** audit feature — routes and navigation. Owner: audit engineer. Every page is lazy and admin-only; the server re-checks capabilities. */
import { lazy } from "react";
import { ScrollText } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const admin = { access: "admin", capability: "audit.read" } as const;

export const auditFeature: FeatureRoutes = {
  routes: [
    { ...admin, path: "/admin/audit", title: "Audit center", component: lazy(() => import("./AuditCenterPage")) },
    { ...admin, path: "/admin/audit/saved", title: "Saved audit searches", component: lazy(() => import("./SavedQueriesPage")) },
    { ...admin, path: "/admin/audit/cases", title: "Investigation cases", component: lazy(() => import("./CasesPage")) },
    { access: "admin", capability: "audit.export", path: "/admin/audit/exports", title: "Audit exports", component: lazy(() => import("./ExportsPage")) },
    { ...admin, path: "/admin/audit/integrity", title: "Audit integrity", component: lazy(() => import("./IntegrityPage")) },
    { access: "admin", capability: "audit.retention.manage", path: "/admin/audit/retention", title: "Audit retention", component: lazy(() => import("./RetentionPage")) },
  ],
  widgets: [{ key: "audit.integrity", area: "console", access: "admin", capability: "audit.read", order: 40, span: 4, component: lazy(() => import("./widgets/IntegrityWidget")) }],
  nav: [{ ...admin, label: "Audit center", href: "/admin/audit", icon: ScrollText, area: "console", group: "Security", order: 34 }],
};
