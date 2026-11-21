/** orders feature — routes, navigation and dashboard widget. Owner: orders_engineer. Every page is lazy. */
import { lazy } from "react";
import { ClipboardList, Package, Plus, Workflow } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const OrdersListPage = lazy(() => import("./pages/OrdersListPage"));
const NewOrderPage = lazy(() => import("./pages/NewOrderPage"));
const OrderDetailPage = lazy(() => import("./pages/OrderDetailPage"));
const AdminOrdersPage = lazy(() => import("./pages/AdminOrdersPage"));
const AdminOrderDetailPage = lazy(() => import("./pages/AdminOrderDetailPage"));

export const ordersFeature: FeatureRoutes = {
  routes: [
    { path: "/orders", access: "customer", title: "Orders", component: OrdersListPage },
    { path: "/orders/new", access: "customer", title: "New order", component: NewOrderPage, capability: "orders.create" },
    { path: "/orders/:orderId", access: "customer", title: "Order", component: OrderDetailPage },
    { path: "/orders/:orderId/:tab", access: "customer", title: "Order", component: OrderDetailPage },
    { path: "/admin/orders", access: "staff", title: "Orders", component: AdminOrdersPage, capability: "orders.read_all" },
    { path: "/admin/orders/:orderId", access: "staff", title: "Order", component: AdminOrderDetailPage, capability: "orders.read_all" },
    { path: "/admin/orders/:orderId/:tab", access: "staff", title: "Order", component: AdminOrderDetailPage, capability: "orders.read_all" },
    { path: "/admin/catalog", access: "admin", title: "Catalog", component: lazy(() => import("./pages/AdminCatalogPage")), capability: "catalog.manage" },
    { path: "/admin/workflows", access: "admin", title: "Workflows", component: lazy(() => import("./pages/AdminWorkflowsPage")), capability: "workflows.manage" },
    { path: "/admin/workflows/drafts/:draftId", access: "admin", title: "Workflow draft", component: lazy(() => import("./pages/workflows/WorkflowDesignerPage")), capability: "workflows.manage" },
    { path: "/admin/workflows/versions/:versionId", access: "admin", title: "Workflow version", component: lazy(() => import("./pages/workflows/WorkflowVersionPage")), capability: "workflows.manage" },
    { path: "/admin/workflows/:workflowId/versions", access: "admin", title: "Workflow versions", component: lazy(() => import("./pages/workflows/WorkflowVersionsPage")), capability: "workflows.manage" },
  ],
  nav: [
    { label: "My orders", href: "/orders", icon: Package, area: "customer", access: "customer", order: 10 },
    { label: "Create an order", href: "/orders/new", icon: Plus, area: "customer", access: "customer", order: 12 },
    { label: "Orders", href: "/admin/orders", icon: Package, area: "console", group: "Operations", access: "staff", capability: "orders.read_all", order: 10 },
    { label: "Catalog", href: "/admin/catalog", icon: ClipboardList, area: "console", group: "Operations", access: "admin", capability: "catalog.manage", order: 12 },
    { label: "Workflows", href: "/admin/workflows", icon: Workflow, area: "console", group: "Operations", access: "admin", capability: "workflows.manage", order: 14 },
  ],
  customerTabs: [{ key: "orders", label: "Orders", access: "staff", order: 20, component: lazy(() => import("./ConsoleOrderTools")) }],
  widgets: [
    { key: "orders.recent", area: "customer", access: "customer", order: 10, span: 8, component: lazy(() => import("./RecentOrdersWidget")) },
    { key: "orders.pipeline", area: "console", access: "staff", capability: "orders.read_all", order: 10, span: 8, component: lazy(() => import("./OrdersPipelineWidget")) },
  ],
};
