/**
 * E-mail delivery administration feature (`client/src/features/mail/**`).
 * Owner: siem_engineer (Increment 03, Package E).
 */
import { lazy } from "react";
import { MailCheck } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";
import { EMAIL_DELIVERY_PATH } from "./model";

const guard = { access: "admin", capability: "mail.manage" } as const;

export const mailFeature: FeatureRoutes = {
  routes: [
    {
      ...guard,
      path: EMAIL_DELIVERY_PATH,
      title: "E-mail delivery",
      component: lazy(() => import("./EmailDeliveryPage")),
    },
  ],
  nav: [
    {
      ...guard,
      label: "E-mail delivery",
      href: EMAIL_DELIVERY_PATH,
      icon: MailCheck,
      area: "console",
      group: "Integrations",
      order: 60,
    },
  ],
};
