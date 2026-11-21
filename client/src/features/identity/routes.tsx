/** identity feature — routes and navigation. Owner: identity engineer. Every page is lazy-loaded. */
import { lazy } from "react";
import { KeyRound, MonitorSmartphone, ShieldCheck, UserRound, Users } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const AccountPage = lazy(() => import("./pages/AccountPage"));
const SessionsPage = lazy(() => import("./pages/SessionsPage"));
const CustomersPage = lazy(() => import("./pages/CustomersPage"));
const CustomerDetailPage = lazy(() => import("./pages/CustomerDetailPage"));
const StaffPage = lazy(() => import("./pages/StaffPage"));
const SsoAdminPage = lazy(() => import("./sso/SsoAdminPage"));
const SsoCompletePage = lazy(() => import("./sso/SsoCompletePage"));
const SsoRefusedPage = lazy(() => import("./sso/SsoRefusedPage"));

export const identityFeature: FeatureRoutes = {
  routes: [
    { path: "/account", access: "customer", title: "Your account", component: AccountPage },
    { path: "/account/sessions", access: "customer", title: "Active sessions", component: SessionsPage },
    { path: "/admin/customers", access: "staff", title: "Customers", component: CustomersPage, capability: "customers.read_all" },
    { path: "/admin/customers/:customerId", access: "staff", title: "Customer", component: CustomerDetailPage, capability: "customers.read_all" },
    { path: "/admin/staff", access: "admin", title: "Staff", component: StaffPage, capability: "staff.manage" },
    { path: "/admin/sso", access: "admin", title: "Single sign-on", component: SsoAdminPage, capability: "identity.sso.manage" },
    { path: "/sso/complete", access: "public", title: "Finishing single sign-on", component: SsoCompletePage },
    { path: "/sso/refused", access: "public", title: "Single sign-on", component: SsoRefusedPage },
  ],
  nav: [
    { label: "Your account", href: "/account", icon: UserRound, area: "customer", access: "customer", order: 80 },
    { label: "Sessions", href: "/account/sessions", icon: MonitorSmartphone, area: "customer", access: "customer", order: 85 },
    { label: "Customers", href: "/admin/customers", icon: Users, area: "console", group: "Operations", access: "staff", capability: "customers.read_all", order: 20 },
    { label: "Staff", href: "/admin/staff", icon: ShieldCheck, area: "console", group: "Security", access: "admin", capability: "staff.manage", order: 30 },
    { label: "Single sign-on", href: "/admin/sso", icon: KeyRound, area: "console", group: "Security", access: "admin", capability: "identity.sso.manage", order: 35 },
  ],
};
