/** Package V registry contributions (owner identity_engineer), spread by `../routes.tsx`. */
import { lazy } from "react";
import type { OrderBanner, OrderTab, RouteDef } from "@/lib/routes";
import { AcceptancesTabLabel } from "./AcceptancesTab";

export const acceptanceRoutes: RouteDef[] = [
  {
    path: "/acceptance-receipts/:receiptId",
    title: "Acceptance receipt",
    access: "customer",
    component: lazy(() => import("./AcceptanceReceiptPage").then((m) => ({ default: m.CustomerAcceptanceReceiptPage }))),
  },
  {
    path: "/admin/acceptance-receipts/:receiptId",
    title: "Acceptance receipt",
    access: "staff",
    component: lazy(() => import("./AcceptanceReceiptPage").then((m) => ({ default: m.ConsoleAcceptanceReceiptPage }))),
  },
];

export const acceptanceOrderTabs: OrderTab[] = [
  { key: "acceptances", label: "Acceptances", labelComponent: AcceptancesTabLabel, access: "staff", order: 100, component: lazy(() => import("./AcceptancesTab")) },
];

/** Full-width customer gate on the order page (slot `orderBanners`, host: orders feature). */
export const acceptanceOrderBanners: OrderBanner[] = [
  { key: "acceptance-gate", order: 10, area: "customer", component: lazy(() => import("./AcceptanceGate")) },
];
