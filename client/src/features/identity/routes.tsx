/** identity feature — routes and navigation. Owner: identity engineer. Every page is lazy-loaded. */
import { lazy } from "react";
import { History, KeyRound, MonitorSmartphone, Settings, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const AccountPage = lazy(() => import("./pages/AccountPage"));
const SessionsPage = lazy(() => import("./pages/SessionsPage"));
const CustomersPage = lazy(() => import("./pages/CustomersPage"));
const CustomerDetailPage = lazy(() => import("./pages/CustomerDetailPage"));
const StaffPage = lazy(() => import("./pages/StaffPage"));
const SsoAdminPage = lazy(() => import("./sso/SsoAdminPage"));
const SsoCompletePage = lazy(() => import("./sso/SsoCompletePage"));
const SsoRefusedPage = lazy(() => import("./sso/SsoRefusedPage"));
const AdminSessionsPage = lazy(() => import("./pages/AdminSessionsPage"));
const SignInLogPage = lazy(() => import("./pages/SignInLogPage"));
const SessionRestrictionsPage = lazy(() => import("./pages/SessionRestrictionsPage"));
const ChangePasswordCard = lazy(() => import("./security/ChangePasswordCard"));
const ActiveSessionsCard = lazy(() => import("./security/ActiveSessionsCard"));
const SignInActivityCard = lazy(() => import("./security/SignInActivityCard"));

export const identityFeature: FeatureRoutes = {
  routes: [
    { path: "/account", access: "customer", title: "Your account", component: AccountPage },
    { path: "/account/sessions", access: "customer", title: "Security", component: SessionsPage },
    { path: "/admin/sessions", access: "staff", title: "Session centre", component: AdminSessionsPage, capability: "sessions.read_all" },
    { path: "/admin/sign-in-log", access: "staff", title: "Sign-in log", component: SignInLogPage, capability: "sessions.read_all" },
    { path: "/admin/session-restrictions", access: "admin", title: "Session restrictions", component: SessionRestrictionsPage, capability: "sessions.policy.manage" },
    { path: "/admin/customers", access: "staff", title: "Customers", component: CustomersPage, capability: "customers.read_all" },
    { path: "/admin/customers/:customerId", access: "staff", title: "Customer", component: CustomerDetailPage, capability: "customers.read_all" },
    { path: "/admin/staff", access: "admin", title: "Staff", component: StaffPage, capability: "staff.manage" },
    { path: "/admin/sso", access: "admin", title: "Single sign-on", component: SsoAdminPage, capability: "identity.sso.manage" },
    { path: "/sso/complete", access: "public", title: "Finishing single sign-on", component: SsoCompletePage },
    { path: "/sso/refused", access: "public", title: "Single sign-on", component: SsoRefusedPage },
  ],
  nav: [
    { label: "Settings", href: "/account", icon: Settings, area: "customer", group: "Account", placement: "account", access: "customer", order: 200 },
    { label: "Sessions", href: "/admin/sessions", icon: MonitorSmartphone, area: "console", group: "Security", access: "staff", capability: "sessions.read_all", order: 40 },
    { label: "Sign-in log", href: "/admin/sign-in-log", icon: History, area: "console", group: "Security", access: "staff", capability: "sessions.read_all", order: 45 },
    { label: "Session restrictions", href: "/admin/session-restrictions", icon: SlidersHorizontal, area: "console", group: "Security", access: "admin", capability: "sessions.policy.manage", order: 50 },
    { label: "Customers", href: "/admin/customers", icon: Users, area: "console", group: "Operations", access: "staff", capability: "customers.read_all", order: 20 },
    { label: "Staff", href: "/admin/staff", icon: ShieldCheck, area: "console", group: "Security", access: "admin", capability: "staff.manage", order: 30 },
    { label: "Single sign-on", href: "/admin/sso", icon: KeyRound, area: "console", group: "Security", access: "admin", capability: "identity.sso.manage", order: 35 },
  ],
  securityCards: [
    { key: "password", order: 10, access: "customer", component: ChangePasswordCard },
    { key: "sessions", order: 30, access: "customer", component: ActiveSessionsCard },
    { key: "sign-in-activity", order: 40, access: "customer", component: SignInActivityCard },
  ],
};
