/**
 * Package D2 — Policy Acceptance Log Centre & Customer Policies Tab (owner: engagement_engineer).
 * Auto-discovered by `client/src/features/compliance/routes.tsx`.
 */
import { FileCheck2 } from "lucide-react";
import { lazy } from "react";
import type { CustomerTab, NavItem, RouteDef } from "@/lib/routes";

const PolicyAcceptancesPage = lazy(() => import("./PolicyAcceptancesPage"));
const PolicyVersionTextPage = lazy(() => import("./PolicyVersionTextPage"));
const CustomerPoliciesTab = lazy(() => import("./CustomerPoliciesTab"));

export const acceptanceLogRoutes: RouteDef[] = [
  {
    path: "/admin/policy-acceptances",
    access: "staff",
    capability: "policies.acceptances.read",
    title: "Policy acceptances",
    component: PolicyAcceptancesPage,
  },
  {
    path: "/admin/policy-acceptances/coverage",
    access: "staff",
    capability: "policies.acceptances.read",
    title: "Policy acceptances — Coverage",
    component: PolicyAcceptancesPage,
  },
  {
    path: "/admin/policy-acceptances/updates",
    access: "staff",
    capability: "policies.acceptances.read",
    title: "Policy acceptances — Policy updates",
    component: PolicyAcceptancesPage,
  },
  {
    path: "/admin/policy-acceptances/versions/:versionId",
    access: "staff",
    capability: "policies.acceptances.read",
    title: "Policy version",
    component: PolicyVersionTextPage,
  },
];

export const acceptanceLogNav: NavItem[] = [
  {
    label: "Policy acceptances",
    href: "/admin/policy-acceptances",
    icon: FileCheck2,
    area: "console",
    group: "Billing & compliance",
    access: "staff",
    capability: "policies.acceptances.read",
    order: 47,
  },
];

export const acceptanceLogCustomerTabs: CustomerTab[] = [
  {
    key: "policies",
    label: "Policies",
    access: "staff",
    order: 40,
    component: CustomerPoliciesTab,
  },
];
