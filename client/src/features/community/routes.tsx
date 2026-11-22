/**
 * Community feature — routes and navigation. Owner: audit_engineer (package M); customer pages by ui_foundation.
 * Everything is behind the `community` switch: navigation is hidden while off and the server answers
 * NOT_FOUND for every member procedure, which the pages render as the not-found state.
 */
import { lazy } from "react";
import { MessagesSquare, ShieldCheck } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";

const member = { access: "customer" } as const;
const moderator = { access: "staff", capability: "community.moderate" } as const;
const manager = { access: "admin", capability: "community.manage" } as const;

export const communityFeature: FeatureRoutes = {
  routes: [
    { ...member, path: "/community", title: "Community", component: lazy(() => import("./customer/CommunityHomePage")) },
    { ...member, path: "/community/search", title: "Search the community", component: lazy(() => import("./customer/SearchPage")) },
    { ...member, path: "/community/c/:slug", title: "Community category", component: lazy(() => import("./customer/CategoryPage")) },
    { ...member, path: "/community/t/:topicPublicId", title: "Community topic", component: lazy(() => import("./customer/TopicPage")) },
    { ...moderator, path: "/admin/community", title: "Community moderation", component: lazy(() => import("./console/ModerationPage")) },
    { ...manager, path: "/admin/community/settings", title: "Community settings", component: lazy(() => import("./console/CommunitySettingsPage")) },
  ],
  nav: [
    { ...member, label: "Community", href: "/community", icon: MessagesSquare, area: "customer", group: "Support", order: 110, enabledBy: "community" },
    { ...moderator, label: "Community moderation", href: "/admin/community", icon: MessagesSquare, area: "console", group: "Support", order: 45, enabledBy: "community" },
    // Settings stay reachable while the forum is off: that is where it is switched on.
    { ...manager, label: "Community settings", href: "/admin/community/settings", icon: ShieldCheck, area: "console", group: "Platform", order: 85 },
  ],
};
