/** trash feature — Trash centre route and navigation (increment 09 D2.7). Owner: audit_engineer (UI). Admin-only; the server re-checks capabilities and step-up. */
import { lazy } from "react";
import { Trash2 } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";
import { TrashNavCount } from "./TrashNavCount";

const read = { access: "admin", capability: "trash.read" } as const;

export const trashFeature: FeatureRoutes = {
  routes: [{ ...read, path: "/admin/trash", title: "Trash", component: lazy(() => import("./TrashCentrePage")) }],
  nav: [{ ...read, label: "Trash", href: "/admin/trash", icon: Trash2, area: "console", group: "Operations", order: 59, badge: TrashNavCount }],
};
