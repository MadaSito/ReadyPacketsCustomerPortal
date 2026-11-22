/** promotions feature — routes and navigation. Owner: audit engineer. The server re-checks every capability, the feature flag and step-up. */
import { lazy } from "react";
import { Ticket } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

/* Staff with promotions.read see masked codes; promotions.manage (administrators) changes them. */
const read = { access: "staff", capability: "promotions.read" } as const;
const manage = { access: "admin", capability: "promotions.manage" } as const;
const editor = lazy(() => import("./PromotionEditorPage"));

export const promotionsFeature: FeatureRoutes = {
  routes: [
    /* Link landing: the code arrives in the URL fragment and is kept in sessionStorage for this tab. */
    { path: "/promo", access: "public", title: "Discount code", component: lazy(() => import("./PromoLandingPage")) },
    { ...read, path: "/admin/promotions", title: "Discount codes", component: lazy(() => import("./DiscountCodesPage")) },
    // Static paths must precede the :promotionId pattern.
    { ...manage, path: "/admin/promotions/new", title: "New discount code", component: editor },
    { ...read, path: "/admin/promotions/redemptions", title: "Discount code redemptions", component: lazy(() => import("./RedemptionsPage")) },
    { ...manage, path: "/admin/promotions/:promotionId/edit", title: "Edit discount code", component: editor },
    { ...read, path: "/admin/promotions/:promotionId", title: "Discount code", component: lazy(() => import("./PromotionDetailPage")) },
  ],
  /* No `enabledBy`: the on/off switch lives on this page, so administrators must reach it while it is off. */
  nav: [{ ...read, label: "Discount codes", href: "/admin/promotions", icon: Ticket, area: "console", group: "Operations", order: 20 }],
};
