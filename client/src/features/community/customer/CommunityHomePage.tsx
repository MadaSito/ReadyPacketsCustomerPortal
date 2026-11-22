/** /community — categories, recent topics and search. Display-name setup first when the member has none. */
import { useQuery } from "@tanstack/react-query";
import { Archive, MessagesSquare } from "lucide-react";
import { Link } from "wouter";
import { Badge, Card, EmptyState, ErrorState } from "@/ui";
import { useCommunityApi } from "../api";
import { CommunityFrame, CommunityGate, LoadingBlock, SearchBox, SuspendedNotice, TopicList } from "./shared";

export default function CommunityHomePage() {
  return (
    <CommunityGate title="Community">
      {(status) => <CommunityHome suspended={<SuspendedNotice status={status} />} />}
    </CommunityGate>
  );
}

function CommunityHome({ suspended }: { suspended: React.ReactNode }) {
  const api = useCommunityApi();
  const categories = useQuery(api.categories.list.queryOptions());
  const recent = useQuery(api.topics.list.queryOptions({ limit: 10 }));
  return (
    <CommunityFrame title="Community" description="Ask questions, share what worked and learn from other ReadyPackets customers.">
      {suspended}
      <SearchBox />
      <section aria-labelledby="community-categories" className="flex flex-col gap-3">
        <h2 id="community-categories" className="text-lg font-semibold text-ink">Categories</h2>
        {categories.isPending ? (
          <LoadingBlock label="Loading categories" />
        ) : categories.isError ? (
          <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
        ) : categories.data.length === 0 ? (
          <EmptyState icon={MessagesSquare} size="sm" headingLevel={3} title="No categories yet" description="The community team has not opened any categories." />
        ) : (
          <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,16rem),1fr))]">
            {categories.data.map((category) => (
              <li key={category.publicId} className="min-w-0">
                <Card className="h-full">
                  <h3 className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                    <Link href={`/community/c/${category.slug}`} className="break-words underline-offset-4 hover:underline focus-visible:underline">
                      {category.name}
                    </Link>
                    {category.archived ? <Badge tone="neutral" icon={<Archive aria-hidden="true" />}>Archived</Badge> : null}
                  </h3>
                  {category.description ? <p className="mt-1 text-sm text-muted break-words">{category.description}</p> : null}
                  <p className="mt-2 text-sm text-muted">
                    {category.topicCount} {category.topicCount === 1 ? "topic" : "topics"}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="community-recent" className="flex flex-col gap-3">
        <h2 id="community-recent" className="text-lg font-semibold text-ink">Recent topics</h2>
        {recent.isPending ? (
          <LoadingBlock label="Loading recent topics" />
        ) : recent.isError ? (
          <ErrorState error={recent.error} onRetry={() => void recent.refetch()} />
        ) : (
          <TopicList topics={recent.data.items} empty={<EmptyState size="sm" headingLevel={3} title="No topics yet" description="Open a category to start the first conversation." />} />
        )}
      </section>
    </CommunityFrame>
  );
}
