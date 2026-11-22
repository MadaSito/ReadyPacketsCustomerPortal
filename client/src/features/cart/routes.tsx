/**
 * Cart & checkout client feature routes, navigation, and `/orders/new` companion wrapper.
 * Owner: recovery_ops_engineer (Increment 04 Package L + Increment 05 Package B).
 */
import { lazy } from "react";
import { ShoppingCart, Sparkles } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";
import { OrderFormCartBanner } from "./OrderFormCartBanner";

const CartPage = lazy(() => import("./CartPage"));
const CheckoutPage = lazy(() => import("./CheckoutPage"));
const CheckoutReturnPage = lazy(() => import("./CheckoutReturnPage"));
const CheckoutCancelPage = lazy(() => import("./CheckoutCancelPage"));
const AdminOpenCartsPage = lazy(() => import("./AdminOpenCartsPage"));
const AdminCartUpsellsPage = lazy(() => import("./AdminCartUpsellsPage"));

export const cartFeature: FeatureRoutes = {
  routes: [
    { path: "/cart", access: "customer", title: "Cart", component: CartPage },
    { path: "/cart/checkout", access: "customer", title: "Checkout", component: CheckoutPage },
    { path: "/checkout/return", access: "customer", title: "Checkout status", component: CheckoutReturnPage },
    { path: "/checkout/cancel", access: "customer", title: "Checkout cancelled", component: CheckoutCancelPage },
    {
      path: "/admin/carts",
      access: "staff",
      title: "Open carts",
      component: AdminOpenCartsPage,
      capability: "carts.read_all",
    },
    {
      path: "/admin/carts/suggestions",
      access: "admin",
      title: "Cart suggestions",
      component: AdminCartUpsellsPage,
      capability: "carts.upsells.manage",
    },
  ],
  nav: [
    {
      label: "Cart",
      href: "/cart",
      icon: ShoppingCart,
      area: "customer",
      access: "customer",
      order: 14,
      enabledBy: "cart",
    },
    {
      label: "Open carts",
      href: "/admin/carts",
      icon: ShoppingCart,
      area: "console",
      group: "Operations",
      access: "staff",
      capability: "carts.read_all",
      order: 18,
    },
    {
      label: "Cart suggestions",
      href: "/admin/carts/suggestions",
      icon: Sparkles,
      area: "console",
      group: "Operations",
      access: "admin",
      capability: "carts.upsells.manage",
      order: 19,
    },
  ],
  routeWrappers: [{ path: "/orders/new", order: 20, component: OrderFormCartBanner }],
};

export default cartFeature;
