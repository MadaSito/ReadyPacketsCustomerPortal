import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BookOpen, FolderOpen, LifeBuoy, Settings2, Tag } from "lucide-react";
import { Link, useSearch } from "wouter";
import { useTRPC } from "@/lib/trpc";
import {
  Badge,
  Button,
  Card,
  DateTime,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  LoadMore,
  PageHeader,
  Section,
  Select,
  Skeleton,
} from "@/ui";
import { HighlightSegments } from "../KnowledgeRichRenderer";

export default function HelpCentrePage() {
  const trpc = useTRPC();
  const rawSearch = useSearch();
  const initialParams = useMemo(() => new URLSearchParams(rawSearch), [rawSearch]);

  const [searchInput, setSearchInput] = useState(() => initialParams.get("q") ?? "");
  const [submittedQuery, setSubmittedQuery] = useState(() => initialParams.get("q") ?? "");
  const [categorySlug, setCategorySlug] = useState(() => initialParams.get("category") ?? "");
  const [selectedTag, setSelectedTag] = useState(() => initialParams.get("tag") ?? "");

  const statusQuery = useQuery(trpc.knowledge.status.queryOptions());
  const isEnabled = statusQuery.data?.enabled ?? false;
  const canManage = statusQuery.data?.canManage ?? false;

  const homeQuery = useQuery({
    ...trpc.knowledge.help.home.queryOptions(),
    enabled: isEnabled,
  });

  const isFiltering = Boolean(submittedQuery.trim() || categorySlug || selectedTag);

  const searchQuery = useInfiniteQuery(
    trpc.knowledge.help.search.infiniteQueryOptions(
      {
        q: submittedQuery.trim() || undefined,
        categorySlug: categorySlug || undefined,
        tag: selectedTag || undefined,
        limit: 20,
      },
      {
        enabled: isEnabled && isFiltering,
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      },
    ),
  );

  const categoryOptions = useMemo(() => {
    const opts = [{ value: "", label: "All topics" }];
    for (const root of homeQuery.data?.categories ?? []) {
      opts.push({ value: root.slug, label: root.title });
      for (const child of root.children) {
        opts.push({ value: child.slug, label: `${root.title} / ${child.title}` });
      }
    }
    return opts;
  }, [homeQuery.data?.categories]);

  const activeFilterCount = (categorySlug ? 1 : 0) + (selectedTag ? 1 : 0);

  const clearAllFilters = () => {
    setSearchInput("");
    setSubmittedQuery("");
    setCategorySlug("");
    setSelectedTag("");
  };

  if (statusQuery.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Knowledge base"
          description="Step-by-step guides, packet preparation checklists, and answers to common questions."
        />
        <Skeleton lines={5} />
      </div>
    );
  }

  if (statusQuery.error) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Knowledge base" />
        <ErrorState error={statusQuery.error} onRetry={() => void statusQuery.refetch()} />
      </div>
    );
  }

  if (!isEnabled) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Knowledge base"
          description="Step-by-step guides and answers to common questions."
          actions={
            canManage ? (
              <Button asChild variant="secondary" leadingIcon={<Settings2 className="h-4 w-4" aria-hidden />}>
                <Link href="/admin/knowledge">Manage knowledge base</Link>
              </Button>
            ) : undefined
          }
        />
        <EmptyState
          variant="disabled"
          icon={BookOpen}
          title="Knowledge base is not turned on"
          description="Need help with an order or account question? Open a support ticket and our team will assist you."
          action={
            <Button asChild leadingIcon={<LifeBuoy className="h-4 w-4" aria-hidden />}>
              <Link href="/support/new">Open support ticket</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const searchHits = searchQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const zeroSuggestions = searchQuery.data?.pages[0]?.suggestions ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Knowledge base"
        description="Search guides, packet preparation instructions, and answers to common questions."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canManage ? (
              <Button asChild variant="ghost" leadingIcon={<Settings2 className="h-4 w-4" aria-hidden />}>
                <Link href="/admin/knowledge">Manage articles</Link>
              </Button>
            ) : null}
            <Button asChild variant="secondary" leadingIcon={<LifeBuoy className="h-4 w-4" aria-hidden />}>
              <Link href="/support/new">Contact support</Link>
            </Button>
          </div>
        }
      />

      <FilterBar
        search={searchInput}
        onSearchChange={setSearchInput}
        onSearchSubmit={(q) => setSubmittedQuery(q)}
        searchLabel="Search help articles"
        activeCount={activeFilterCount}
        onReset={clearAllFilters}
      >
        <Field label="Topic">
          <Select
            value={categorySlug}
            onChange={(e) => setCategorySlug(e.target.value)}
            options={categoryOptions}
          />
        </Field>
      </FilterBar>

      {selectedTag ? (
        <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
          <span className="text-sm text-muted">Filtered by tag:</span>
          <Badge tone="info">{selectedTag}</Badge>
          <Button size="sm" variant="ghost" onClick={() => setSelectedTag("")}>
            Clear tag
          </Button>
        </div>
      ) : null}

      {isFiltering ? (
        <Section
          title={
            submittedQuery.trim()
              ? `Search results for "${submittedQuery.trim()}"`
              : "Filtered articles"
          }
          actions={
            <Button size="sm" variant="ghost" onClick={clearAllFilters}>
              Back to all topics
            </Button>
          }
        >
          {searchQuery.isPending ? (
            <Skeleton lines={5} />
          ) : searchQuery.error ? (
            <ErrorState error={searchQuery.error} onRetry={() => void searchQuery.refetch()} />
          ) : searchHits.length === 0 ? (
            <div className="flex flex-col gap-6">
              <EmptyState
                variant="no-results"
                title="No matching articles found"
                description="Try broader keywords, pick a topic below, or open a support ticket."
                onClearFilters={clearAllFilters}
                action={
                  <Button asChild variant="secondary">
                    <Link href="/support/new">Open support ticket</Link>
                  </Button>
                }
              />

              {zeroSuggestions ? (
                <div className="grid gap-4 md:grid-cols-2">
                  {zeroSuggestions.popularArticles.length > 0 ? (
                    <Card title="Suggested articles" headingLevel={3}>
                      <ul className="flex flex-col gap-2.5">
                        {zeroSuggestions.popularArticles.map((art) => (
                          <li key={art.publicId} className="min-w-0">
                            <Link
                              href={`/help/articles/${encodeURIComponent(art.slug)}`}
                              className="font-semibold text-action underline-offset-2 hover:underline break-words"
                            >
                              {art.title}
                            </Link>
                            <p className="text-sm text-muted break-words">{art.summary}</p>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  ) : null}

                  <div className="flex flex-col gap-4">
                    {zeroSuggestions.categories.length > 0 ? (
                      <Card title="Browse topics" headingLevel={3}>
                        <ul className="flex flex-wrap gap-2">
                          {zeroSuggestions.categories.map((cat) => (
                            <li key={cat.publicId}>
                              <Button asChild size="sm" variant="secondary">
                                <Link href={`/help/categories/${encodeURIComponent(cat.slug)}`}>
                                  {cat.title} ({cat.publishedArticleCount})
                                </Link>
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </Card>
                    ) : null}

                    {zeroSuggestions.suggestedTags.length > 0 ? (
                      <Card title="Popular tags" headingLevel={3}>
                        <div className="flex flex-wrap gap-2">
                          {zeroSuggestions.suggestedTags.map((t) => (
                            <Button
                              key={t}
                              size="sm"
                              variant="ghost"
                              leadingIcon={<Tag className="h-3.5 w-3.5" aria-hidden />}
                              onClick={() => {
                                setSearchInput("");
                                setSubmittedQuery("");
                                setSelectedTag(t);
                              }}
                            >
                              {t}
                            </Button>
                          ))}
                        </div>
                      </Card>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <ul className="flex flex-col gap-3">
                {searchHits.map((hit) => (
                  <li key={hit.publicId} className="min-w-0">
                    <Card>
                      <div className="flex min-w-0 flex-col gap-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Link
                            href={`/help/articles/${encodeURIComponent(hit.slug)}`}
                            className="text-lg font-semibold text-action underline-offset-2 hover:underline break-words"
                          >
                            <HighlightSegments segments={hit.titleSegments} />
                          </Link>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {hit.audience === "staff" ? (
                              <Badge tone="warning">Staff internal</Badge>
                            ) : null}
                            {hit.categoryTitle ? (
                              <Badge tone="neutral">{hit.categoryTitle}</Badge>
                            ) : null}
                          </div>
                        </div>

                        <p className="text-body break-words">
                          <HighlightSegments segments={hit.snippetSegments} />
                        </p>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-sm text-muted">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {hit.tags.map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => setSelectedTag(t)}
                                className="inline-flex min-h-6 items-center gap-1 rounded-[var(--radius-control)] border border-line bg-surface-soft px-2 py-0.5 text-xs font-medium text-body hover:border-action focus-visible:outline-2 focus-visible:outline-action"
                              >
                                <Tag className="h-3 w-3" aria-hidden />
                                <span>{t}</span>
                              </button>
                            ))}
                          </div>
                          <span>
                            Updated <DateTime value={hit.updatedAt} format="date" />
                          </span>
                        </div>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>

              <LoadMore
                hasMore={Boolean(searchQuery.hasNextPage)}
                loading={searchQuery.isFetchingNextPage}
                onLoadMore={() => void searchQuery.fetchNextPage()}
                summary={`Showing ${searchHits.length} articles`}
              />
            </div>
          )}
        </Section>
      ) : homeQuery.isPending ? (
        <Skeleton lines={6} />
      ) : homeQuery.error ? (
        <ErrorState error={homeQuery.error} onRetry={() => void homeQuery.refetch()} />
      ) : (homeQuery.data?.categories.length ?? 0) === 0 &&
        (homeQuery.data?.featuredArticles.length ?? 0) === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No help articles published yet"
          description="Check back soon or reach out to our support team directly."
          action={
            <Button asChild>
              <Link href="/support/new">Contact support</Link>
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          {(homeQuery.data?.categories.length ?? 0) > 0 ? (
            <Section
              title="Browse by topic"
              description="Select a category to explore step-by-step articles."
            >
              <div className="grid gap-4 md:grid-cols-2">
                {homeQuery.data!.categories.map((cat) => {
                  const totalPublished =
                    cat.publishedArticleCount +
                    cat.children.reduce((sum, ch) => sum + ch.publishedArticleCount, 0);
                  return (
                    <Card key={cat.publicId}>
                      <div className="flex min-w-0 flex-col gap-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <Link
                            href={`/help/categories/${encodeURIComponent(cat.slug)}`}
                            className="inline-flex min-w-0 items-center gap-2 text-lg font-semibold text-action underline-offset-2 hover:underline break-words"
                          >
                            <FolderOpen className="h-5 w-5 shrink-0" aria-hidden />
                            <span>{cat.title}</span>
                          </Link>
                          <Badge tone="neutral">
                            {totalPublished} {totalPublished === 1 ? "article" : "articles"}
                          </Badge>
                        </div>

                        {cat.description ? (
                          <p className="text-sm text-body break-words">{cat.description}</p>
                        ) : null}

                        {cat.children.length > 0 ? (
                          <div className="flex flex-wrap gap-2 border-t border-line pt-2.5">
                            {cat.children.map((sub) => (
                              <Link
                                key={sub.publicId}
                                href={`/help/categories/${encodeURIComponent(sub.slug)}`}
                                className="inline-flex min-h-7 items-center gap-1.5 rounded-[var(--radius-control)] border border-line bg-surface-soft px-2.5 py-1 text-sm font-medium text-action hover:underline"
                              >
                                <span>{sub.title}</span>
                                <span className="text-xs text-muted">
                                  ({sub.publishedArticleCount})
                                </span>
                              </Link>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </Section>
          ) : null}

          {(homeQuery.data?.featuredArticles.length ?? 0) > 0 ? (
            <Section
              title="Popular articles"
              description="Frequently referenced answers from customers."
            >
              <div className="grid gap-3 md:grid-cols-2">
                {homeQuery.data!.featuredArticles.map((article) => (
                  <Card key={article.publicId}>
                    <div className="flex min-w-0 flex-col gap-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Link
                          href={`/help/articles/${encodeURIComponent(article.slug)}`}
                          className="font-semibold text-action underline-offset-2 hover:underline break-words"
                        >
                          {article.title}
                        </Link>
                        {article.audience === "staff" ? (
                          <Badge tone="warning">Staff internal</Badge>
                        ) : article.categoryTitle ? (
                          <Badge tone="neutral">{article.categoryTitle}</Badge>
                        ) : null}
                      </div>
                      <p className="text-sm text-body break-words">{article.summary}</p>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                        <span>
                          Updated <DateTime value={article.updatedAt} format="date" />
                        </span>
                        {article.reviewedOn ? (
                          <span>Reviewed {article.reviewedOn}</span>
                        ) : null}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </Section>
          ) : null}
        </div>
      )}
    </div>
  );
}
