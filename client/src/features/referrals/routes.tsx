import { lazy } from "react";
import { Gift } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";
import { RegisterReferralCapture } from "./RegisterReferralCapture";

export {
  clearHeldReferralCodeFirstParty,
  fetchHeldReferralCodeFirstParty,
  getInMemoryHeldReferralCode,
  holdReferralCodeFirstParty,
} from "./api";

const CustomerReferralsPage = lazy(() => import("./CustomerReferralsPage"));
const AdminReferralsPage = lazy(() => import("./AdminReferralsPage"));

export const referralsFeature: FeatureRoutes = {
  routes: [
    {
      path: "/account/referrals",
      access: "customer",
      title: "Referrals",
      component: CustomerReferralsPage,
    },
    {
      path: "/admin/referrals",
      access: "staff",
      capability: "referrals.read_all",
      title: "Referrals",
      component: AdminReferralsPage,
    },
  ],
  nav: [
    {
      label: "Referrals",
      href: "/account/referrals",
      icon: Gift,
      area: "customer",
      group: "Account",
      access: "customer",
      order: 210,
      enabledBy: "referrals",
    },
    {
      label: "Referrals",
      href: "/admin/referrals",
      icon: Gift,
      area: "console",
      group: "Operations",
      access: "staff",
      capability: "referrals.read_all",
      order: 28,
    },
  ],
  routeWrappers: [
    {
      path: "/register",
      order: 50,
      component: RegisterReferralCapture,
    },
  ],
};
