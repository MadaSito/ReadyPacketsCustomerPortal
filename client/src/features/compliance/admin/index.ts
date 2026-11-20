/**
 * Compliance console (policies, intake, invoices) — routes and navigation. Owner: orders_engineer.
 * compliance_engineer spreads these into compliance/routes.tsx. Every page is lazy.
 */
import { lazy } from "react";
import { ClipboardCheck, ClipboardList, Receipt, ScrollText } from "lucide-react";
import type { NavItem, RouteDef } from "@/lib/routes";

export const complianceAdminRoutes: RouteDef[] = [
  { path: "/admin/policies", access: "admin", title: "Policies", component: lazy(() => import("./PoliciesAdminPage")), capability: "policies.manage" },
  { path: "/admin/policies/:documentId", access: "admin", title: "Policy", component: lazy(() => import("./PolicyDetailPage")), capability: "policies.manage" },
  { path: "/admin/intake", access: "admin", title: "Intake questionnaires", component: lazy(() => import("./IntakeAdminPage")), capability: "intake.manage" },
  { path: "/admin/intake/submissions", access: "staff", title: "Intake submissions", component: lazy(() => import("./IntakeSubmissionsPage")), capability: "intake.review" },
  { path: "/admin/invoices", access: "staff", title: "Invoices", component: lazy(() => import("./InvoicesAdminPage")), capability: "invoices.read_all" },
  { path: "/admin/invoices/:invoiceId", access: "staff", title: "Invoice", component: lazy(() => import("./InvoiceDetailPage")), capability: "invoices.read_all" },
];

export const complianceAdminNav: NavItem[] = [
  { label: "Invoices", href: "/admin/invoices", icon: Receipt, area: "console", group: "Billing & compliance", access: "staff", capability: "invoices.read_all", order: 40 },
  { label: "Intake review", href: "/admin/intake/submissions", icon: ClipboardCheck, area: "console", group: "Billing & compliance", access: "staff", capability: "intake.review", order: 42 },
  { label: "Questionnaires", href: "/admin/intake", icon: ClipboardList, area: "console", group: "Billing & compliance", access: "admin", capability: "intake.manage", order: 44 },
  { label: "Policies", href: "/admin/policies", icon: ScrollText, area: "console", group: "Billing & compliance", access: "admin", capability: "policies.manage", order: 46 },
];
