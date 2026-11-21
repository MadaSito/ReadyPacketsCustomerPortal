import { HardDrive, RefreshCw } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";
import { SharePointOrderSyncPage } from "./SharePointOrderSyncPage";
import { StorageConnectionWizardPage } from "./StorageConnectionWizardPage";
import { StorageConnectionsPage } from "./StorageConnectionsPage";

const guard = { access: "admin", capability: "storage.manage" } as const;

export const storageFeature: FeatureRoutes = {
  routes: [
    {
      ...guard,
      path: "/admin/storage",
      title: "Storage connections",
      component: StorageConnectionsPage,
    },
    {
      ...guard,
      path: "/admin/storage/new",
      title: "Add storage connection",
      component: StorageConnectionWizardPage,
    },
    {
      ...guard,
      path: "/admin/storage/:publicId/edit",
      title: "Edit storage connection",
      component: StorageConnectionWizardPage,
    },
    {
      ...guard,
      path: "/admin/sharepoint-sync",
      title: "SharePoint order sync",
      component: SharePointOrderSyncPage,
    },
  ],
  nav: [
    {
      ...guard,
      label: "Storage connections",
      href: "/admin/storage",
      icon: HardDrive,
      area: "console",
      group: "Integrations",
      order: 63,
    },
    {
      ...guard,
      label: "SharePoint order sync",
      href: "/admin/sharepoint-sync",
      icon: RefreshCw,
      area: "console",
      group: "Integrations",
      order: 64,
    },
  ],
};
