import { lazy } from "react";
import { RadioTower } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const read = { access: "admin", capability: "siem.read" } as const;
const manage = { access: "admin", capability: "siem.manage" } as const;
export const siemFeature: FeatureRoutes = {
  routes: [
    { ...read, path: "/admin/siem", title: "SIEM forwarding", component: lazy(() => import("./Console")) },
    { ...manage, path: "/admin/siem/new", title: "New SIEM destination", component: lazy(() => import("./Editor")) },
    { ...manage, path: "/admin/siem/:id/edit", title: "Edit SIEM destination", component: lazy(() => import("./Editor")) },
    { ...read, path: "/admin/siem/:id", title: "SIEM destination", component: lazy(() => import("./Destination")) },
  ],
  nav: [{ ...read, label: "SIEM forwarding", href: "/admin/siem", icon: RadioTower, area: "console", group: "Security", order: 35 }],
};
