/** /community/search?q= — published posts only (server-side LIKE with escaped wildcards). */
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { EmptyState, ErrorState, LoadMore } from "@/ui";
import { useCommunityApi } from "../api";
import { COMMUNITY_CRUMB, CommunityFrame, CommunityGate, LoadingBlock, SearchBox, TopicList } from "./shared";

export function searchTerm(search: string): string {
  return (new URLSearchParams(search).get("q") ?? "").replace(/\s+/gu, " ").trim().slice(0, 100);
}

export default function SearchPage() {
  const q = searchTerm(useSearch());
  const crumbs = [COMMUNITY_CRUMB, { label: "Search" }];
  return (
    <CommunityGate title="Search the community" crumbs={crumbs}>
      {() => (
        <CommunityFrame title="Search the community" crumbs={crumbs}>
          <SearchBox key={q} initial={q} />
          {q.length < 2 ? <p className="text-sm text-muted">Enter at least 2 characters to search.</p> : <Results q={q} />}
        </CommunityFrame>
      )}
    </CommunityGate>
  );
}

function Results({ q }: { q: string }) {
  const api = useCommunityApi();
  const results = useInfiniteQuery(api.search.infiniteQueryOptions({ q }, { getNextPageParam: (last) => last.nextCursor }));
  if (results.isPending) return <LoadingBlock label="Searching" />;
  if (results.isError) return <ErrorState error={results.error} onRetry={() => void results.refetch()} />;
  const items = results.data.pages.flatMap((page) => page.items);
  return (
    <section aria-labelledby="search-results" className="flex flex-col gap-3">
      <h2 id="search-results" className="text-lg font-semibold text-ink">
        Results for “{q}”
      </h2>
      <TopicList topics={items} empty={<EmptyState variant="filtered" size="sm" headingLevel={3} title="No matching topics" description="Try different or fewer words." />} />
      <LoadMore hasMore={Boolean(results.hasNextPage)} loading={results.isFetchingNextPage} onLoadMore={() => void results.fetchNextPage()} summary={`Showing ${items.length} ${items.length === 1 ? "topic" : "topics"}`} />
    </section>
  );
}
