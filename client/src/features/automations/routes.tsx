/** automations feature — routes and navigation. Owner: audit engineer. Every page is lazy and admin-only; the server re-checks capabilities and step-up. */
import { lazy } from "react";
import { Workflow } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const read = { access: "admin", capability: "automations.read" } as const;
const editor = lazy(() => import("./AutomationEditorPage"));

export const automationsFeature: FeatureRoutes = {
  routes: [
    { ...read, path: "/admin/automations", title: "Automations", component: lazy(() => import("./AutomationsPage")) },
    // Static paths must precede the :automationId pattern.
    { ...read, path: "/admin/automations/new", title: "New automation", component: editor },
    { ...read, path: "/admin/automations/:automationId/edit", title: "Edit automation", component: editor },
    { ...read, path: "/admin/automations/:automationId", title: "Automation", component: lazy(() => import("./AutomationDetailPage")) },
  ],
  nav: [{ ...read, label: "Automations", href: "/admin/automations", icon: Workflow, area: "console", group: "Integrations", order: 62 }],
};
