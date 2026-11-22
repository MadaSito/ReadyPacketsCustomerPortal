/**
 * Contextual "Related articles" widget rendered on the New Support Ticket page (`/support/new`).
 * Renders nothing when `feature.knowledge` is disabled, while loading, or when no articles match.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { Link } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Badge, Callout } from "@/ui";

export interface RelatedArticlesSlotProps {
  query: string;
  category?: string;
}

export default function RelatedArticlesSlot({ query, category }: RelatedArticlesSlotProps) {
  const trpc = useTRPC();
  const [debouncedQuery, setDebouncedQuery] = useState(() => query.trim());

  useEffect(() => {
    const trimmed = query.trim();
    const timer = window.setTimeout(() => setDebouncedQuery(trimmed), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const statusQuery = useQuery({
    ...trpc.knowledge.status.queryOptions(),
    staleTime: 60_000,
    retry: false,
  });

  const canSearch = Boolean(statusQuery.data?.enabled) && debouncedQuery.length >= 3;

  const relatedQuery = useQuery({
    ...trpc.knowledge.help.relatedForTicket.queryOptions({
      query: debouncedQuery.slice(0, 160),
      category,
    }),
    enabled: canSearch,
    staleTime: 30_000,
    retry: false,
  });

  const items = relatedQuery.data?.items ?? [];
  if (!canSearch || items.length === 0) {
    return null;
  }

  return (
    <Callout
      tone="info"
      live="polite"
      title="Suggested help articles"
    >
      <div className="mt-1 flex flex-col gap-2.5">
        <p className="text-sm text-body">
          One of these guides may answer your question right away:
        </p>
        <ul className="flex flex-col gap-2">
          {items.map((article) => (
            <li
              key={article.publicId}
              className="min-w-0 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  href={`/help/articles/${encodeURIComponent(article.slug)}`}
                  className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-action underline-offset-2 hover:underline break-words"
                >
                  <BookOpen className="h-4 w-4 shrink-0" aria-hidden />
                  <span>{article.title}</span>
                </Link>
                {article.categoryTitle ? (
                  <Badge tone="neutral">{article.categoryTitle}</Badge>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-muted break-words">{article.summary}</p>
            </li>
          ))}
        </ul>
      </div>
    </Callout>
  );
}
