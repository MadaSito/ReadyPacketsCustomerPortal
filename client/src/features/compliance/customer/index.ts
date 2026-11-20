import { lazy } from "react";
import { BookOpen, ReceiptText } from "lucide-react";
import type { DashboardWidget, NavItem, OrderTab, RouteDef, RouteWrapper } from "@/lib/routes";
import { RequiredPolicyGate } from "./PolicyAcceptance";

export const complianceCustomerRoutes: RouteDef[] = [
  { path: "/legal", title: "Legal Policies", access: "public", component: lazy(() => import("./PolicyPages").then((m) => ({ default: m.LegalPage }))) },
  { path: "/policies", title: "Policies & Agreements", access: "customer", component: lazy(() => import("./PolicyPages").then((m) => ({ default: m.MyPoliciesPage }))) },
  { path: "/invoices", title: "Invoices", access: "customer", component: lazy(() => import("./InvoicePages").then((m) => ({ default: m.InvoicesPage }))) },
  { path: "/invoices/:invoiceId", title: "Invoice", access: "customer", component: lazy(() => import("./InvoicePages").then((m) => ({ default: m.InvoiceDetailPage }))) },
];

export const complianceCustomerNav: NavItem[] = [
  { href: "/invoices", label: "Invoices", icon: ReceiptText, area: "customer", access: "customer", order: 40 },
  { href: "/policies", label: "Policies", icon: BookOpen, area: "customer", access: "customer", order: 50 },
];

export const complianceOrderTabs: OrderTab[] = [
  { key: "intake", label: "Intake", access: "customer", order: 20, component: lazy(() => import("./OrderIntakeTab")) },
  { key: "invoices", label: "Invoices", access: "customer", order: 40, component: lazy(() => import("./InvoicePages").then((m) => ({ default: m.OrderInvoicesTab }))) },
];

export const complianceWidgets: DashboardWidget[] = [
  { key: "compliance-required-policies", area: "customer", access: "customer", order: 5, span: 12, component: lazy(() => import("./PolicyAcceptance")) },
];

export const complianceRouteWrappers: RouteWrapper[] = [
  { path: "/orders/new", order: 10, component: RequiredPolicyGate },
];
