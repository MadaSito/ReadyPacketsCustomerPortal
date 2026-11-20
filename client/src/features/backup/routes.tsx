/** backup feature — routes and navigation. Owner: audit engineer (UI). Every page is lazy and admin-only; the server re-checks capabilities and step-up. */
import { lazy } from "react";
import { DatabaseBackup } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const read = { access: "admin", capability: "backup.read" } as const;

export const backupFeature: FeatureRoutes = {
  routes: [
    { ...read, path: "/admin/backups", title: "Backups", component: lazy(() => import("./BackupsPage")) },
    // Static paths must precede the :backupId pattern.
    { ...read, path: "/admin/backups/restore", title: "Restoring a backup", component: lazy(() => import("./RestorePage")) },
    { ...read, path: "/admin/backups/retention", title: "Backup retention", component: lazy(() => import("./RetentionPage")) },
    { ...read, path: "/admin/backups/:backupId", title: "Backup", component: lazy(() => import("./BackupDetailPage")) },
  ],
  nav: [{ ...read, label: "Backups", href: "/admin/backups", icon: DatabaseBackup, area: "console", group: "Platform", order: 83 }],
};
