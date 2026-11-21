import { lazy } from "react";
import { Mail } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const guard = { access: "admin", capability: "mail.manage" } as const;

export const mailTemplatesFeature: FeatureRoutes = {
  routes: [
    {
      ...guard,
      path: "/admin/email-templates",
      title: "E-mail templates",
      component: lazy(() => import("./pages/MailTemplatesPage")),
    },
    {
      ...guard,
      path: "/admin/email-templates/:templateKey",
      title: "Edit e-mail template",
      component: lazy(() => import("./pages/MailTemplateEditorPage")),
    },
  ],
  nav: [
    {
      ...guard,
      label: "E-mail templates",
      href: "/admin/email-templates",
      icon: Mail,
      area: "console",
      group: "Integrations",
      order: 61,
    },
  ],
};
