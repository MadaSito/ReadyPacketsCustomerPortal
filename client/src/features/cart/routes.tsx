/**
 * Cart & checkout client feature routes, navigation, and `/orders/new` companion wrapper.
 * Owner: recovery_ops_engineer (Increment 04, Package L).
 */
import { lazy } from "react";
import { ShoppingCart } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";
import { OrderFormCartBanner } from "./OrderFormCartBanner";

const CartPage = lazy(() => import("./CartPage"));
const CheckoutPage = lazy(() => import("./CheckoutPage"));
const CheckoutReturnPage = lazy(() => import("./CheckoutReturnPage"));
const CheckoutCancelPage = lazy(() => import("./CheckoutCancelPage"));
const AdminOpenCartsPage = lazy(() => import("./AdminOpenCartsPage"));

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
  ],
  routeWrappers: [{ path: "/orders/new", order: 20, component: OrderFormCartBanner }],
};

export default cartFeature;
