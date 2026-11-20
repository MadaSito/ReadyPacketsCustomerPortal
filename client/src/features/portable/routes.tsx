import { lazy } from "react";
import { ArrowLeftRight } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const Transfers = lazy(() => import("./pages/Transfers"));
const NewExport = lazy(() => import("./pages/NewExport"));
const ImportDetails = lazy(() => import("./pages/ImportDetails"));

export const portableFeature: FeatureRoutes = {
  routes: [
    { path: "/admin/portable", access: "admin", capability: "portable.export", title: "Portable transfer", component: Transfers },
    { path: "/admin/portable/export/new", access: "admin", capability: "portable.export", title: "New export", component: NewExport },
    { path: "/admin/portable/import/:importId", access: "admin", capability: "portable.import", title: "Import details", component: ImportDetails },
  ],
  nav: [{ label: "Portable transfer", href: "/admin/portable", icon: ArrowLeftRight, area: "console", group: "Operations",
    access: "admin", capability: "portable.export", order: 55 }],
};
