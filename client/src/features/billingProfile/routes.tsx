/** billingProfile feature — routes and account navigation (Increment 08, Decision D4). Owner: compliance_engineer. */
import { lazy } from "react";
import { CreditCard } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const BillingInformationPage = lazy(() => import("./BillingInformationPage"));

export const billingProfileFeature: FeatureRoutes = {
  routes: [
    {
      path: "/account/billing",
      access: "customer",
      title: "Billing information",
      component: BillingInformationPage,
    },
  ],
  nav: [
    {
      label: "Billing information",
      href: "/account/billing",
      icon: CreditCard,
      area: "customer",
      group: "Account",
      placement: "account",
      access: "customer",
      order: 210,
    },
  ],
};
