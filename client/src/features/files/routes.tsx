import { lazy } from "react";
import { FolderLock } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

export const filesFeature: FeatureRoutes = {
  routes: [{
    path: "/admin/files", title: "File administration", access: "admin",
    component: lazy(() => import("./FilesAdminPage")),
  }],
  nav: [{
    label: "Files", href: "/admin/files", icon: FolderLock, area: "console",
    group: "Operations", access: "admin", order: 32,
  }],
  orderTabs: [{
    key: "files", label: "Files", component: lazy(() => import("./OrderFilesTab")),
    access: "customer", order: 30,
  }],
};
