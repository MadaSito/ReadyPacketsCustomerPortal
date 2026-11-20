/** assurance feature — routes and navigation. Owner: see docs/engineering/BUILD_CONTRACT.md. Lazy-load every page. */
import { lazy } from "react";
import { ShieldCheck } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const SecurityPage = lazy(() => import("./pages/SecurityPage"));
const CredentialsTab = lazy(() => import("./pages/CredentialsTab"));

export const assuranceFeature: FeatureRoutes = {
  routes: [{ path: "/account/security", access: "customer", title: "Account security", component: SecurityPage }],
  nav: [{ label: "Account security", href: "/account/security", icon: ShieldCheck, area: "customer", access: "customer", order: 90 }],
  customerTabs: [{ key: "credentials", label: "Credentials", access: "admin", component: CredentialsTab, order: 90 }],
};
