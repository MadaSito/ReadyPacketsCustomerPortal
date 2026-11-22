import { useQuery } from "@tanstack/react-query";
import { BookOpen, FolderOpen, LifeBuoy } from "lucide-react";
import { Link, useRoute } from "wouter";
import { useTRPC } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  Card,
  DateTime,
  EmptyState,
  ErrorState,
  PageHeader,
  Section,
  Skeleton,
} from "@/ui";

export default function HelpCategoryPage() {
  const trpc = useTRPC();
  const [, params] = useRoute("/help/categories/:slug");
  const slug = params?.slug ? decodeURIComponent(params.slug) : "";

  const categoryQuery = useQuery({
    ...trpc.knowledge.help.category.queryOptions({ slug }),
    enabled: slug.length >= 2,
  });

  if (categoryQuery.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          breadcrumbs={<Breadcrumbs items={[{ label: "Knowledge base", href: "/help" }, { label: "Topic" }]} />}
          title="Loading topic"
        />
        <Skeleton lines={5} />
      </div>
    );
  }

  if (categoryQuery.error || !categoryQuery.data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          breadcrumbs={<Breadcrumbs items={[{ label: "Knowledge base", href: "/help" }, { label: "Topic" }]} />}
          title="Topic unavailable"
        />
        <ErrorState
          error={categoryQuery.error}
          onRetry={() => void categoryQuery.refetch()}
        />
      </div>
    );
  }

  const { category, parentCategory, articles } = categoryQuery.data;

  const crumbs = [
    { label: "Knowledge base", href: "/help" },
    ...(parentCategory
      ? [{ label: parentCategory.title, href: `/help/categories/${encodeURIComponent(parentCategory.slug)}` }]
      : []),
    { label: category.title },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        breadcrumbs={<Breadcrumbs items={crumbs} />}
        title={category.title}
        description={category.description ?? undefined}
        actions={
          <Button asChild variant="secondary" leadingIcon={<LifeBuoy className="h-4 w-4" aria-hidden />}>
            <Link href="/support/new">Contact support</Link>
          </Button>
        }
      />

      {category.children.length > 0 ? (
        <Section title="Subcategories">
          <div className="grid gap-3 sm:grid-cols-2">
            {category.children.map((sub) => (
              <Card key={sub.publicId}>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`/help/categories/${encodeURIComponent(sub.slug)}`}
                      className="inline-flex min-w-0 items-center gap-2 font-semibold text-action underline-offset-2 hover:underline break-words"
                    >
                      <FolderOpen className="h-4 w-4 shrink-0" aria-hidden />
                      <span>{sub.title}</span>
                    </Link>
                    <Badge tone="neutral">{sub.publishedArticleCount}</Badge>
                  </div>
                  {sub.description ? (
                    <p className="text-sm text-muted break-words">{sub.description}</p>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Articles">
        {articles.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No published articles in this topic yet"
            description="Browse other topics in the knowledge base or contact support directly."
            action={
              <Button asChild variant="secondary">
                <Link href="/help">All topics</Link>
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {articles.map((article) => (
              <li key={article.publicId} className="min-w-0">
                <Card>
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link
                        href={`/help/articles/${encodeURIComponent(article.slug)}`}
                        className="text-lg font-semibold text-action underline-offset-2 hover:underline break-words"
                      >
                        {article.title}
                      </Link>
                      {article.audience === "staff" ? (
                        <Badge tone="warning">Staff internal</Badge>
                      ) : null}
                    </div>
                    <p className="text-body break-words">{article.summary}</p>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                      <div className="flex flex-wrap gap-1.5">
                        {article.tags.map((t) => (
                          <Badge key={t} tone="neutral">
                            {t}
                          </Badge>
                        ))}
                      </div>
                      <span>
                        Updated <DateTime value={article.updatedAt} format="date" />
                        {article.reviewedOn ? ` · Reviewed ${article.reviewedOn}` : ""}
                      </span>
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
