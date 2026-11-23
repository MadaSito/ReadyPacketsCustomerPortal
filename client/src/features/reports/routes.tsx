/**
 * Package I — Reports feature routes (`client/src/features/reports`).
 * Mounted in `client/src/app/registry.ts` as `reportsFeature` by `/root`.
 *
 * Access rules (INCREMENT_06_CONTRACT.md D6):
 *   - `/admin/reports` and `/admin/reports/built-in/:reportKey`: `staff` + `admin` (`reports.read`).
 *   - `/admin/reports/custom/*`: `admin` only (`reports.manage`).
 *   - CSV export actions require `reports.export` (admin + fresh MFA step-up).
 */
import { BarChart3 } from "lucide-react";
import { lazy } from "react";
import type { FeatureRoutes } from "@/lib/routes";

const ReportsOverviewPage = lazy(() => import("./pages/ReportsOverviewPage"));
const BuiltInReportPage = lazy(() => import("./pages/BuiltInReportPage"));
const CustomReportBuilderPage = lazy(() => import("./pages/CustomReportBuilderPage"));
const CustomReportRunPage = lazy(() => import("./pages/CustomReportRunPage"));

export const reportsFeature: FeatureRoutes = {
  routes: [
    {
      path: "/admin/reports",
      access: "staff",
      capability: "reports.read",
      title: "Reports",
      component: ReportsOverviewPage,
    },
    {
      path: "/admin/reports/built-in/:reportKey",
      access: "staff",
      capability: "reports.read",
      title: "Built-in report",
      component: BuiltInReportPage,
    },
    {
      path: "/admin/reports/custom/new",
      access: "admin",
      capability: "reports.manage",
      title: "New custom report",
      component: CustomReportBuilderPage,
    },
    {
      path: "/admin/reports/custom/:definitionId/edit",
      access: "admin",
      capability: "reports.manage",
      title: "Edit custom report",
      component: CustomReportBuilderPage,
    },
    {
      path: "/admin/reports/custom/:definitionId",
      access: "admin",
      capability: "reports.manage",
      title: "Custom report",
      component: CustomReportRunPage,
    },
  ],
  nav: [
    {
      label: "Reports",
      href: "/admin/reports",
      icon: BarChart3,
      area: "console",
      group: "Overview",
      access: "staff",
      capability: "reports.read",
      order: 5,
    },
  ],
};
