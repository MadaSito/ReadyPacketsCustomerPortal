/** engagement feature — routes, navigation, order detail tab, and dashboard widgets. Owner: engagement_engineer. */
import { lazy } from "react";
import { Bell, Inbox, LifeBuoy, MessageSquare } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";
import { OrderMessagesUnreadBadge } from "./OrderMessagesTab";

const CustomerMessagesPage = lazy(() => import("./pages/CustomerMessagesPage"));
const SupportTicketsPage = lazy(() => import("./pages/SupportTicketsPage"));
const NewSupportTicketPage = lazy(() => import("./pages/NewSupportTicketPage"));
const SupportTicketDetailPage = lazy(() => import("./pages/SupportTicketDetailPage"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage"));
const SearchPage = lazy(() => import("./pages/SearchPage"));
const AdminTicketsPage = lazy(() => import("./pages/AdminTicketsPage"));
const AdminTicketDetailPage = lazy(() => import("./pages/AdminTicketDetailPage"));
const AdminMessagesPage = lazy(() => import("./pages/AdminMessagesPage"));
const OrderMessagesTab = lazy(() => import("./OrderMessagesTab"));
const CustomerEngagementWidget = lazy(() => import("./widgets/CustomerEngagementWidget"));
const ConsoleQueueWidget = lazy(() => import("./widgets/ConsoleQueueWidget"));

export const engagementFeature: FeatureRoutes = {
  routes: [
    { path: "/messages", access: "customer", title: "Messages", component: CustomerMessagesPage },
    { path: "/support", access: "customer", title: "Support tickets", component: SupportTicketsPage },
    { path: "/support/new", access: "customer", title: "New support ticket", component: NewSupportTicketPage },
    { path: "/support/:ticketId", access: "customer", title: "Support ticket", component: SupportTicketDetailPage },
    { path: "/notifications", access: "customer", title: "Notifications", component: NotificationsPage },
    { path: "/search", access: "customer", title: "Search", component: SearchPage },
    {
      path: "/admin/search",
      access: "staff",
      title: "Search",
      component: SearchPage,
      capability: "search.global",
    },
    {
      path: "/admin/tickets",
      access: "staff",
      title: "Support queue",
      component: AdminTicketsPage,
      capability: "tickets.read_all",
    },
    {
      path: "/admin/tickets/:ticketId",
      access: "staff",
      title: "Support ticket",
      component: AdminTicketDetailPage,
      capability: "tickets.read_all",
    },
    {
      path: "/admin/messages",
      access: "staff",
      title: "Order message inbox",
      component: AdminMessagesPage,
      capability: "messages.read_all",
    },
  ],
  nav: [
    {
      label: "Messages",
      href: "/messages",
      icon: MessageSquare,
      area: "customer",
      access: "customer",
      order: 20,
    },
    {
      label: "Support",
      href: "/support",
      icon: LifeBuoy,
      area: "customer",
      group: "Support",
      access: "customer",
      order: 100,
    },
    {
      label: "Notifications",
      href: "/notifications",
      icon: Bell,
      area: "customer",
      access: "customer",
      order: 30,
    },
    {
      label: "Support queue",
      href: "/admin/tickets",
      icon: LifeBuoy,
      area: "console",
      group: "Operations",
      access: "staff",
      capability: "tickets.read_all",
      order: 20,
    },
    {
      label: "Messages",
      href: "/admin/messages",
      icon: Inbox,
      area: "console",
      group: "Operations",
      access: "staff",
      capability: "messages.read_all",
      order: 22,
    },
  ],
  orderTabs: [
    {
      key: "messages",
      label: "Messages",
      component: OrderMessagesTab,
      access: "customer",
      order: 40,
      badge: OrderMessagesUnreadBadge,
    },
  ],
  widgets: [
    {
      key: "engagement.customer_overview",
      area: "customer",
      access: "customer",
      order: 20,
      span: 4,
      component: CustomerEngagementWidget,
    },
    {
      key: "engagement.console_queue",
      area: "console",
      access: "staff",
      capability: "tickets.read_all",
      order: 20,
      span: 6,
      component: ConsoleQueueWidget,
    },
  ],
};
