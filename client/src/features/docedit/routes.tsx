/**
 * docedit feature routes (Increment 06 D9). Owner: Package C engineer.
 * Mounted by `/root` in `client/src/app/registry.ts` via `export const doceditFeature`.
 */
import { lazy } from "react";
import type { FeatureRoutes } from "@/lib/routes";

const CustomerOrderDocumentEditPage = lazy(() => import("./CustomerOrderDocumentEditPage"));
const ConsoleOrderDocumentEditPage = lazy(() => import("./ConsoleOrderDocumentEditPage"));

export const doceditFeature: FeatureRoutes = {
  routes: [
    {
      path: "/orders/:orderId/documents/:fileId/edit",
      access: "customer",
      title: "Edit document",
      component: CustomerOrderDocumentEditPage,
    },
    {
      path: "/admin/orders/:orderId/documents/:fileId/edit",
      access: "staff",
      title: "Edit document",
      component: ConsoleOrderDocumentEditPage,
      capability: "orders.read_all",
    },
  ],
};
