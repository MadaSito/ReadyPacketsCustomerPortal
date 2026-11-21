import { lazy } from "react";
import { Webhook } from "lucide-react";
import type { NavItem, RouteDef } from "@/lib/routes";
import { WEBHOOK_PATHS } from "./paths";

const guard = { access: "admin", capability: "webhooks.manage" } as const;

export const webhookRoutes: readonly RouteDef[] = [
  { ...guard, path: WEBHOOK_PATHS.subscriptions, title: "Webhook subscriptions", component: lazy(() => import("./SubscriptionsPage")) },
  { ...guard, path: WEBHOOK_PATHS.inbound, title: "Inbound webhook endpoints", component: lazy(() => import("./InboundPage")) },
  { ...guard, path: WEBHOOK_PATHS.deliveries, title: "Webhook deliveries", component: lazy(() => import("./DeliveriesPage")) },
];

export const webhookNav: readonly NavItem[] = [
  { ...guard, label: "Webhooks", href: WEBHOOK_PATHS.subscriptions, icon: Webhook, area: "console", group: "Platform", order: 84 },
];
