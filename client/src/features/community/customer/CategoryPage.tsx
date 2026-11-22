/** /community/c/:slug — topics in one category (pinned first) and the new-topic form. */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useLocation, useParams } from "wouter";
import { errorMessage } from "@/lib/trpc";
import { Button, Callout, Card, EmptyState, ErrorState, Field, Input, LoadMore, Textarea } from "@/ui";
import { newIdempotencyKey, useCommunityApi, type CategoryView, type CommunityStatusView } from "../api";
import { COMMUNITY_CRUMB, CommunityFrame, CommunityGate, CommunityUnavailable, LoadingBlock, SuspendedNotice, TopicList } from "./shared";

export const TITLE_MIN = 5;
export const TITLE_MAX = 140;
export const BODY_MAX = 10_000;

export default function CategoryPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  return <CommunityGate title="Community category" crumbs={[COMMUNITY_CRUMB]}>{(status) => <Category slug={slug} status={status} />}</CommunityGate>;
}

function Category({ slug, status }: { slug: string; status: CommunityStatusView }) {
  const api = useCommunityApi();
  const categories = useQuery(api.categories.list.queryOptions());
  if (categories.isPending) {
    return (
      <CommunityFrame title="Community category" crumbs={[COMMUNITY_CRUMB]}>
        <LoadingBlock label="Loading category" />
      </CommunityFrame>
    );
  }
  if (categories.isError) {
    return (
      <CommunityFrame title="Community category" crumbs={[COMMUNITY_CRUMB]}>
        <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
      </CommunityFrame>
    );
  }
  const category = categories.data.find((c) => c.slug === slug);
  if (!category) return <CommunityUnavailable title="Community category" />;
  return <CategoryBody category={category} status={status} />;
}

function CategoryBody({ category, status }: { category: CategoryView; status: CommunityStatusView }) {
  const api = useCommunityApi();
  const topics = useInfiniteQuery(api.topics.list.infiniteQueryOptions({ categoryPublicId: category.publicId }, { getNextPageParam: (last) => last.nextCursor }));
  const canPost = !category.archived && !status.suspended && (!category.staffOnlyPosting || status.canModerate);
  const items = topics.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <CommunityFrame title={category.name} description={category.description || undefined} crumbs={[COMMUNITY_CRUMB, { label: category.name }]}>
      <SuspendedNotice status={status} />
      {category.archived ? <Callout tone="info">This category is archived. You can read it, but new topics and replies are closed.</Callout> : null}
      {category.staffOnlyPosting && !status.canModerate ? <Callout tone="info">Only ReadyPackets staff start topics here. You can reply where topics are open.</Callout> : null}
      <section aria-labelledby="category-topics" className="flex flex-col gap-3">
        <h2 id="category-topics" className="text-lg font-semibold text-ink">Topics</h2>
        {topics.isPending ? (
          <LoadingBlock label="Loading topics" />
        ) : topics.isError ? (
          <ErrorState error={topics.error} onRetry={() => void topics.refetch()} />
        ) : (
          <>
            <TopicList topics={items} empty={<EmptyState size="sm" headingLevel={3} title="No topics yet" description={canPost ? "Start the first conversation below." : undefined} />} />
            <LoadMore hasMore={Boolean(topics.hasNextPage)} loading={topics.isFetchingNextPage} onLoadMore={() => void topics.fetchNextPage()} summary={`Showing ${items.length} ${items.length === 1 ? "topic" : "topics"}`} />
          </>
        )}
      </section>
      {canPost ? <NewTopicForm categoryPublicId={category.publicId} /> : null}
    </CommunityFrame>
  );
}

function NewTopicForm({ categoryPublicId }: { categoryPublicId: string }) {
  const api = useCommunityApi();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const create = useMutation(api.topics.create.mutationOptions());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [key] = useState(newIdempotencyKey);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleProblem = title.trim().length < TITLE_MIN ? `Use at least ${TITLE_MIN} characters.` : null;
  const bodyProblem = body.trim().length === 0 ? "Write your post." : null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (titleProblem || bodyProblem) return;
    try {
      const result = await create.mutateAsync({ categoryPublicId, title: title.trim(), body, idempotencyKey: key });
      await queryClient.invalidateQueries({ queryKey: api.topics.list.pathKey() });
      navigate(`/community/t/${result.topicPublicId}`);
    } catch (err) {
      setError(errorMessage(err, "Your topic could not be posted. Please try again."));
    }
  };
  return (
    <Card title="Start a topic" description="Be kind and specific. Do not post passwords, payment details or other personal information.">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <Field label="Title" required error={touched && titleProblem ? titleProblem : undefined} hint={`${TITLE_MIN} to ${TITLE_MAX} characters.`}>
          <Input value={title} maxLength={TITLE_MAX} onChange={(event) => setTitle(event.target.value)} autoComplete="off" />
        </Field>
        <Field label="Post" required error={touched && bodyProblem ? bodyProblem : undefined} hint="Plain text. Blank lines start paragraphs, “> ” quotes, “- ” lists. https links work.">
          <Textarea value={body} maxLength={BODY_MAX} rows={6} onChange={(event) => setBody(event.target.value)} />
        </Field>
        <div>
          <Button type="submit" loading={create.isPending}>
            Post topic
          </Button>
        </div>
      </form>
    </Card>
  );
}
