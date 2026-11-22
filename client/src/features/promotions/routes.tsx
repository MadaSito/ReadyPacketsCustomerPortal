/** promotions feature — routes and navigation. Owner: audit engineer. The server re-checks every capability. */
import { lazy } from "react";
import type { FeatureRoutes } from "@/lib/routes";

export const promotionsFeature: FeatureRoutes = {
  routes: [
    /* Link landing: the code arrives in the URL fragment and is kept in sessionStorage for this tab. */
    { path: "/promo", access: "public", title: "Discount code", component: lazy(() => import("./PromoLandingPage")) },
  ],
};
