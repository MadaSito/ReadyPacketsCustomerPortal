/** knowledge feature — customer Help Centre (`/help*`) and console Knowledge Base (`/admin/knowledge*`). */
import { lazy, type ComponentType } from "react";
import { BookOpen } from "lucide-react";
import type { FeatureRoutes } from "@/lib/routes";
import { EmptyState, PageHeader } from "@/ui";

const HelpCentrePage = lazy(() => import("./pages/HelpCentrePage"));
const HelpCategoryPage = lazy(() => import("./pages/HelpCategoryPage"));
const HelpArticlePage = lazy(() => import("./pages/HelpArticlePage"));

const adminModules = import.meta.glob<{ default: ComponentType }>("./admin/*.tsx");

function resolveAdminPage(fileName: string, fallbackTitle: string): ComponentType {
  const loader = adminModules[`./admin/${fileName}`];
  if (loader) {
    return lazy(loader);
  }
  return function AdminKnowledgeFallback() {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={fallbackTitle} />
        <EmptyState
          icon={BookOpen}
          title="Knowledge base administration"
          description="Loading the console knowledge base module."
        />
      </div>
    );
  };
}

const AdminKnowledgeListPage = resolveAdminPage(
  "AdminKnowledgeListPage.tsx",
  "Knowledge base",
);
const AdminKnowledgeEditorPage = resolveAdminPage(
  "AdminKnowledgeEditorPage.tsx",
  "Knowledge article editor",
);

export const knowledgeFeature: FeatureRoutes = {
  routes: [
    {
      path: "/help",
      access: "customer",
      title: "Knowledge base",
      component: HelpCentrePage,
    },
    {
      path: "/help/categories/:slug",
      access: "customer",
      title: "Knowledge base topic",
      component: HelpCategoryPage,
    },
    {
      path: "/help/articles/:slug",
      access: "customer",
      title: "Knowledge base article",
      component: HelpArticlePage,
    },
    {
      path: "/admin/knowledge",
      access: "staff",
      title: "Knowledge base",
      component: AdminKnowledgeListPage,
      capability: "knowledge.manage",
    },
    {
      path: "/admin/knowledge/new",
      access: "staff",
      title: "New knowledge article",
      component: AdminKnowledgeEditorPage,
      capability: "knowledge.manage",
    },
    {
      path: "/admin/knowledge/:articleId",
      access: "staff",
      title: "Edit knowledge article",
      component: AdminKnowledgeEditorPage,
      capability: "knowledge.manage",
    },
  ],
  nav: [
    {
      label: "Knowledge base",
      href: "/help",
      icon: BookOpen,
      area: "customer",
      group: "Support",
      access: "customer",
      order: 120,
      enabledBy: "knowledge",
    },
    {
      label: "Knowledge base",
      href: "/admin/knowledge",
      icon: BookOpen,
      area: "console",
      group: "Support",
      access: "staff",
      capability: "knowledge.manage",
      order: 48,
    },
  ],
};
