import { CalendarClock, ListChecks, Mail, Wrench } from "lucide-react";
import { lazy } from "react";
import type { FeatureRoutes } from "@/lib/routes";

const console = { access: "admin", capability: "jobs.read" } as const;
const nav = { ...console, area: "console", group: "Platform" } as const;
export const jobsFeature: FeatureRoutes = {
  routes: [
    { ...console, path: "/admin/jobs", title: "Jobs", component: lazy(() => import("./pages/JobsPage")) },
    { ...console, path: "/admin/jobs/:jobId", title: "Job details", component: lazy(() => import("./pages/JobDetailPage")) },
    { ...console, path: "/admin/schedules", title: "Schedules", component: lazy(() => import("./pages/SchedulesPage")) },
    { ...console, path: "/admin/mail", title: "Mail", component: lazy(() => import("./pages/MailPage")) },
    { ...console, path: "/admin/maintenance", title: "Maintenance", component: lazy(() => import("./pages/MaintenancePage")) },
  ],
  nav: [
    { ...nav, href: "/admin/jobs", label: "Jobs", icon: ListChecks, order: 41 },
    { ...nav, href: "/admin/schedules", label: "Schedules", icon: CalendarClock, order: 42 },
    { ...nav, href: "/admin/mail", label: "Mail", icon: Mail, order: 43 },
    { ...nav, href: "/admin/maintenance", label: "Maintenance", icon: Wrench, order: 44 },
  ],
};
