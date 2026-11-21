import { lazy } from "react";
import { CreditCard } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const access = { access: "admin", capability: "payments.manage" } as const;
export const paymentsFeature: FeatureRoutes = {
  routes: [{ ...access, path: "/admin/payments", title: "Payments", component: lazy(() => import("./PaymentsPage")) }],
  nav: [{ ...access, href: "/admin/payments", label: "Payments", icon: CreditCard, area: "console", group: "Billing & compliance", order: 41 }],
};
