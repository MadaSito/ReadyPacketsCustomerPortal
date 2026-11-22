/**
 * /community/t/:topicPublicId — posts, reply (with quote), edit within the window, delete own post, Helpful,
 * report and follow. Hidden/removed/deleted posts render a placeholder, never an empty body.
 */
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Flag, Lock, MessageSquareQuote, Pencil, ThumbsUp, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useParams } from "wouter";
import { errorMessage } from "@/lib/trpc";
import { Badge, Button, Callout, Card, ConfirmDialog, DateTime, Dialog, ErrorState, Field, LoadMore, RadioGroup, Textarea, useToast } from "@/ui";
import { newIdempotencyKey, useCommunityApi, type CommunityStatusView, type PostView, type TopicDetailView } from "../api";
import { CommunityBody, hiddenBodyLabel } from "../text";
import { AuthorName, COMMUNITY_CRUMB, CommunityFrame, CommunityGate, CommunityUnavailable, isNotFound, LoadingBlock, SuspendedNotice } from "./shared";

const BODY_MAX = 10_000;
export const REPORT_REASONS = [
  { value: "spam", label: "Spam or advertising" },
  { value: "abuse", label: "Abusive or harassing" },
  { value: "off_topic", label: "Off topic" },
  { value: "personal_info", label: "Shares personal information" },
  { value: "other", label: "Something else" },
] as const;
type ReportReason = (typeof REPORT_REASONS)[number]["value"];

export default function TopicPage() {
  const { topicPublicId = "" } = useParams<{ topicPublicId: string }>();
  return (
    <CommunityGate title="Community topic" crumbs={[COMMUNITY_CRUMB]}>
      {(status) => <Topic key={topicPublicId} topicPublicId={topicPublicId} status={status} />}
    </CommunityGate>
  );
}

function Topic({ topicPublicId, status }: { topicPublicId: string; status: CommunityStatusView }) {
  const api = useCommunityApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const detail = useInfiniteQuery(api.topics.get.infiniteQueryOptions({ topicPublicId }, { getNextPageParam: (last: TopicDetailView) => last.nextCursor }));
  const subscribe = useMutation(api.subscriptions.set.mutationOptions());
  const [quote, setQuote] = useState<PostView | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.topics.get.pathKey() });

  if (detail.isPending) {
    return (
      <CommunityFrame title="Community topic" crumbs={[COMMUNITY_CRUMB]}>
        <LoadingBlock label="Loading topic" />
      </CommunityFrame>
    );
  }
  if (detail.isError) {
    if (isNotFound(detail.error)) return <CommunityUnavailable title="Community topic" />;
    return (
      <CommunityFrame title="Community topic" crumbs={[COMMUNITY_CRUMB]}>
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </CommunityFrame>
    );
  }
  const first = detail.data.pages[0]!;
  const { topic, category } = first;
  const subscribed = detail.data.pages.at(-1)?.subscribed ?? first.subscribed;
  const posts = detail.data.pages.flatMap((page) => page.posts);
  const closed = topic.locked || status.suspended;

  const toggleFollow = async () => {
    try {
      const result = await subscribe.mutateAsync({ topicPublicId, subscribed: !subscribed });
      await refresh();
      setAnnouncement(result.subscribed ? "You are following this topic. Replies will notify you." : "You stopped following this topic.");
    } catch (err) {
      toast.show({ tone: "danger", title: "Follow setting not changed", description: errorMessage(err) });
    }
  };

  return (
    <CommunityFrame
      title={topic.title}
      crumbs={[COMMUNITY_CRUMB, { label: category.name, href: `/community/c/${category.slug}` }, { label: topic.title }]}
      actions={
        <Button variant="secondary" leadingIcon={subscribed ? <BellOff aria-hidden="true" /> : <Bell aria-hidden="true" />} onClick={() => void toggleFollow()} loading={subscribe.isPending} aria-pressed={subscribed}>
          {subscribed ? "Following" : "Follow"}
        </Button>
      }
    >
      <p role="status" aria-live="polite" className={announcement ? "text-sm text-muted" : "sr-only"}>
        {announcement}
      </p>
      <SuspendedNotice status={status} />
      {topic.locked ? (
        <Callout tone="info" title="Topic locked">
          <span className="inline-flex items-center gap-1.5">
            <Lock aria-hidden="true" className="size-4" /> A moderator closed this topic to new replies.
          </span>
        </Callout>
      ) : null}
      <ol className="flex flex-col gap-4" aria-label="Posts">
        {posts.map((post) => (
          <li key={post.publicId}>
            <PostCard
              post={post}
              closed={closed}
              onQuote={() => {
                setQuote(post);
                replyRef.current?.focus();
              }}
              onChanged={async (message) => {
                await refresh();
                setAnnouncement(message);
              }}
            />
          </li>
        ))}
      </ol>
      <LoadMore hasMore={Boolean(detail.hasNextPage)} loading={detail.isFetchingNextPage} onLoadMore={() => void detail.fetchNextPage()} summary={`Showing ${posts.length} ${posts.length === 1 ? "post" : "posts"}`} label="Load more posts" />
      {closed ? null : (
        <ReplyForm
          topicPublicId={topicPublicId}
          quote={quote}
          onClearQuote={() => setQuote(null)}
          textareaRef={replyRef}
          onPosted={async (message) => {
            setQuote(null);
            await refresh();
            setAnnouncement(message);
          }}
        />
      )}
    </CommunityFrame>
  );
}

function PostCard({ post, closed, onQuote, onChanged }: { post: PostView; closed: boolean; onQuote: () => void; onChanged: (message: string) => Promise<void> }) {
  const api = useCommunityApi();
  const toast = useToast();
  const react = useMutation(api.posts.react.mutationOptions());
  const remove = useMutation(api.posts.delete.mutationOptions());
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reporting, setReporting] = useState(false);
  const readable = post.body !== null && post.state !== "deleted" && post.state !== "removed";
  const headingId = `post-${post.publicId}`;

  const toggleHelpful = async () => {
    try {
      const result = await react.mutateAsync({ postPublicId: post.publicId, helpful: !post.reactedByMe });
      await onChanged(result.reactedByMe ? "Marked as helpful." : "Helpful mark removed.");
    } catch (err) {
      toast.show({ tone: "danger", title: "Could not update Helpful", description: errorMessage(err) });
    }
  };

  return (
    <article aria-labelledby={headingId} className="rounded-[var(--radius-card)] border border-line bg-surface p-4 sm:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-sm">
          <AuthorName author={post.author} />
          <span className="sr-only">{post.isOpening ? ", opening post" : ", reply"}</span>
        </h2>
        <p className="text-xs text-muted">
          <DateTime value={post.createdAt} />
          {post.editedAt ? <span> · edited</span> : null}
        </p>
      </header>
      {post.state === "pending" && post.mine ? <Badge tone="warning" className="mt-2">Waiting for review</Badge> : null}
      {post.quote ? (
        <blockquote className="mt-3 border-l-4 border-line pl-3 text-sm text-muted">
          <p className="font-medium">{post.quote.author} wrote:</p>
          <p className="break-words">{post.quote.excerpt ?? "This post is no longer available."}</p>
        </blockquote>
      ) : null}
      <div className="mt-3">
        {editing && post.body !== null ? (
          <EditForm post={post} onDone={async (message) => { setEditing(false); if (message) await onChanged(message); }} />
        ) : post.body !== null && readable ? (
          <CommunityBody text={post.body} />
        ) : (
          <p className="text-sm text-muted">{hiddenBodyLabel(post.state)}</p>
        )}
      </div>
      {readable && !editing ? (
        <footer className="mt-4 flex flex-wrap items-center gap-2">
          {post.mine ? (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted">
              <ThumbsUp aria-hidden="true" className="size-4" /> {post.helpfulCount} found this helpful
            </span>
          ) : (
            <Button variant="ghost" size="sm" leadingIcon={<ThumbsUp aria-hidden="true" />} aria-pressed={post.reactedByMe} onClick={() => void toggleHelpful()} loading={react.isPending}>
              Helpful ({post.helpfulCount})
            </Button>
          )}
          {!closed ? (
            <Button variant="ghost" size="sm" leadingIcon={<MessageSquareQuote aria-hidden="true" />} onClick={onQuote}>
              Quote
            </Button>
          ) : null}
          {post.canEdit ? (
            <Button variant="ghost" size="sm" leadingIcon={<Pencil aria-hidden="true" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
          {post.mine ? (
            <Button variant="ghost" size="sm" leadingIcon={<Trash2 aria-hidden="true" />} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          ) : (
            <Button variant="ghost" size="sm" leadingIcon={<Flag aria-hidden="true" />} onClick={() => setReporting(true)}>
              Report
            </Button>
          )}
        </footer>
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this post?"
        description="Other members will see that the post was deleted by its author. This cannot be undone."
        confirmLabel="Delete post"
        destructive
        onConfirm={async () => {
          try {
            await remove.mutateAsync({ postPublicId: post.publicId });
            await onChanged("Your post was deleted.");
          } catch (err) {
            toast.show({ tone: "danger", title: "Post not deleted", description: errorMessage(err) });
            throw err;
          }
        }}
      />
      <ReportDialog open={reporting} onOpenChange={setReporting} postPublicId={post.publicId} onReported={onChanged} />
    </article>
  );
}

function EditForm({ post, onDone }: { post: PostView; onDone: (message: string | null) => Promise<void> }) {
  const api = useCommunityApi();
  const edit = useMutation(api.posts.edit.mutationOptions());
  const [body, setBody] = useState(post.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return setError("Write your post.");
    try {
      const result = await edit.mutateAsync({ postPublicId: post.publicId, body, expectedVersion: post.version });
      await onDone(result.state === "pending" ? "Edit saved. It will appear after a moderator reviews it." : "Edit saved.");
    } catch (err) {
      setError(errorMessage(err, "Your edit could not be saved."));
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3" noValidate>
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
      <Field label="Edit your post" required>
        <Textarea value={body} maxLength={BODY_MAX} rows={5} onChange={(event) => setBody(event.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={edit.isPending}>
          Save edit
        </Button>
        <Button variant="secondary" onClick={() => void onDone(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ReportDialog({ open, onOpenChange, postPublicId, onReported }: { open: boolean; onOpenChange: (open: boolean) => void; postPublicId: string; onReported: (message: string) => Promise<void> }) {
  const api = useCommunityApi();
  const report = useMutation(api.posts.report.mutationOptions());
  const [reason, setReason] = useState<ReportReason | "">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason) return setError("Choose a reason.");
    try {
      await report.mutateAsync({ postPublicId, reason, note: note.trim() || undefined });
      onOpenChange(false);
      setReason("");
      setNote("");
      setError(null);
      await onReported("Thanks. The moderators will review this post.");
    } catch (err) {
      setError(errorMessage(err, "The report could not be sent."));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Report this post"
      description="Reports go to the ReadyPackets moderators. The author is not told who reported it."
      dismissible={!report.isPending}
    >
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <RadioGroup legend="Reason" value={reason} onValueChange={(value) => setReason(value as ReportReason)} options={REPORT_REASONS.map((r) => ({ value: r.value, label: r.label }))} required />
        <Field label="Anything else the moderators should know?" hint="Optional, up to 500 characters.">
          <Textarea value={note} maxLength={500} rows={3} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={report.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={report.isPending}>
            Send report
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ReplyForm({
  topicPublicId,
  quote,
  onClearQuote,
  textareaRef,
  onPosted,
}: {
  topicPublicId: string;
  quote: PostView | null;
  onClearQuote: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onPosted: (message: string) => Promise<void>;
}) {
  const api = useCommunityApi();
  const reply = useMutation(api.posts.reply.mutationOptions());
  const [body, setBody] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return setError("Write your reply.");
    try {
      const result = await reply.mutateAsync({ topicPublicId, body, quotePostPublicId: quote?.publicId, idempotencyKey: key });
      setBody("");
      setKey(newIdempotencyKey());
      setError(null);
      await onPosted(result.state === "pending" ? "Reply received. It will appear after a moderator reviews it." : "Reply posted.");
    } catch (err) {
      setError(errorMessage(err, "Your reply could not be posted. Please try again."));
    }
  };
  return (
    <Card title="Reply">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        {quote ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line bg-surface-sunken px-3 py-2 text-sm">
            <span className="min-w-0 break-words">
              Quoting <span className="font-medium text-ink">{quote.author.displayName}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={onClearQuote}>
              Remove quote
            </Button>
          </div>
        ) : null}
        <Field label="Your reply" required hint="Plain text. Blank lines start paragraphs, “> ” quotes, “- ” lists. https links work.">
          <Textarea ref={textareaRef} value={body} maxLength={BODY_MAX} rows={5} onChange={(event) => setBody(event.target.value)} />
        </Field>
        <div>
          <Button type="submit" loading={reply.isPending}>
            Post reply
          </Button>
        </div>
      </form>
    </Card>
  );
}
