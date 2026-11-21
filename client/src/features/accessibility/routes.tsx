import { lazy } from "react";
import type { FeatureRoutes } from "@/lib/routes";

export const accessibilityFeature: FeatureRoutes = {
  routes: [
    { path: "/accessibility", access: "public", title: "Accessibility", component: lazy(() => import("./AccessibilityPage")) },
  ],
};
