/**
 * Shared pieces for the customer community pages (ui_foundation for audit_engineer, package M).
 * Members appear only under their chosen display name; staff are marked with a text badge, never colour alone.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, MessagesSquare, Pin } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { errorMessage, safeError } from "@/lib/trpc";
import { Badge, Breadcrumbs, Button, Callout, Card, DateTime, EmptyState, ErrorState, Field, Input, PageHeader, Skeleton, type Crumb } from "@/ui";
import { useCommunityApi, type CommunityStatusView, type TopicSummaryView } from "../api";
import { useCommunityNoindex } from "../text";

type AuthorView = TopicSummaryView["author"];

export const COMMUNITY_CRUMB: Crumb = { label: "Community", href: "/community" };

export function isNotFound(error: unknown): boolean {
  return safeError(error)?.domainCode === "NOT_FOUND";
}

export function useCommunityStatus() {
  const api = useCommunityApi();
  return useQuery(api.status.queryOptions());
}

export function CommunityFrame({
  title,
  description,
  crumbs,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  crumbs?: readonly Crumb[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  useCommunityNoindex();
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader title={title} description={description} actions={actions} breadcrumbs={crumbs ? <Breadcrumbs items={crumbs} /> : undefined} />
      {children}
    </div>
  );
}

export function CommunityUnavailable({ title = "Community" }: { title?: string }) {
  return (
    <CommunityFrame title={title}>
      <EmptyState
        icon={MessagesSquare}
        title="This page is not available"
        description="The community is switched off, or the page no longer exists."
        action={
          <Link href="/" className="font-medium text-action underline underline-offset-4">
            Go to your dashboard
          </Link>
        }
      />
    </CommunityFrame>
  );
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="grid gap-3">
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
    </div>
  );
}

/**
 * Shows loading / unavailable / error for the status query and the display-name setup when the member has no
 * profile yet. Children render only for an enabled forum with a profile.
 */
export function CommunityGate({ title, crumbs, children }: { title: string; crumbs?: readonly Crumb[]; children: (status: CommunityStatusView) => ReactNode }) {
  const status = useCommunityStatus();
  if (status.isPending) {
    return (
      <CommunityFrame title={title} crumbs={crumbs}>
        <LoadingBlock label="Loading community" />
      </CommunityFrame>
    );
  }
  if (status.isError) {
    if (isNotFound(status.error)) return <CommunityUnavailable title={title} />;
    return (
      <CommunityFrame title={title} crumbs={crumbs}>
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      </CommunityFrame>
    );
  }
  if (!status.data.enabled) return <CommunityUnavailable title={title} />;
  if (!status.data.profile) {
    return (
      <CommunityFrame title={title} crumbs={crumbs} description="Choose how you appear to other members before you read or post.">
        <ProfileSetup />
      </CommunityFrame>
    );
  }
  return <>{children(status.data)}</>;
}

export function SuspendedNotice({ status }: { status: CommunityStatusView }) {
  if (!status.suspended) return null;
  return (
    <Callout tone="warning" title="Posting is paused on your account">
      {status.suspendedUntil ? (
        <>
          You can read the community, and you can post again after <DateTime value={status.suspendedUntil} />.
        </>
      ) : (
        "You can read the community. Contact support if you think this is a mistake."
      )}
    </Callout>
  );
}

const DISPLAY_NAME = /^[\p{L}\p{N} ._-]{3,32}$/u;

export function displayNameProblem(value: string): string | null {
  const name = value.trim();
  if (name.length < 3 || name.length > 32) return "Use 3 to 32 characters.";
  if (!DISPLAY_NAME.test(name)) return "Use letters, numbers, spaces, dots, hyphens or underscores.";
  return null;
}

export function ProfileSetup() {
  const api = useCommunityApi();
  const queryClient = useQueryClient();
  const save = useMutation(api.profile.save.mutationOptions());
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = displayNameProblem(name);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    try {
      await save.mutateAsync({ displayName: name.trim() });
      await queryClient.invalidateQueries({ queryKey: api.status.queryKey() });
    } catch (err) {
      setError(errorMessage(err, "That display name could not be saved. Try another one."));
    }
  };
  return (
    <Card title="Choose a display name" description="Other members see only this name. Do not use your e-mail address or full legal name.">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        {error ? (
          <Callout tone="danger" live="assertive">
            {error}
          </Callout>
        ) : null}
        <Field label="Display name" hint="3 to 32 characters: letters, numbers, spaces, dots, hyphens or underscores." error={touched && problem ? problem : undefined} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} onBlur={() => setTouched(true)} maxLength={32} autoComplete="nickname" />
        </Field>
        <div>
          <Button type="submit" loading={save.isPending}>
            Save display name
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function AuthorName({ author }: { author: AuthorView }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-medium text-ink break-words">{author.displayName}</span>
      {author.staff ? <Badge tone="brand">ReadyPackets staff</Badge> : null}
    </span>
  );
}

export function TopicList({ topics, empty }: { topics: readonly TopicSummaryView[]; empty: ReactNode }) {
  if (topics.length === 0) return <>{empty}</>;
  return (
    <ul className="flex flex-col divide-y divide-line rounded-[var(--radius-card)] border border-line bg-surface">
      {topics.map((topic) => (
        <li key={topic.publicId} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2">
              {topic.pinned ? (
                <Badge tone="info" icon={<Pin aria-hidden="true" />}>
                  Pinned
                </Badge>
              ) : null}
              {topic.locked ? (
                <Badge tone="neutral" icon={<Lock aria-hidden="true" />}>
                  Locked
                </Badge>
              ) : null}
              <Link href={`/community/t/${topic.publicId}`} className="font-semibold text-ink underline-offset-4 break-words hover:underline focus-visible:underline">
                {topic.title}
              </Link>
            </p>
            <p className="mt-1 text-sm text-muted">
              Started by <AuthorName author={topic.author} />
            </p>
          </div>
          <p className="shrink-0 text-sm text-muted sm:text-right">
            {topic.replyCount} {topic.replyCount === 1 ? "reply" : "replies"}
            <span aria-hidden="true"> · </span>
            <span className="sr-only">, last activity </span>
            <DateTime value={topic.lastPostAt} />
          </p>
        </li>
      ))}
    </ul>
  );
}

export function SearchBox({ initial = "" }: { initial?: string }) {
  const [q, setQ] = useState(initial);
  const [, navigate] = useLocation();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = q.trim();
    if (query.length >= 2) navigate(`/community/search?q=${encodeURIComponent(query)}`);
  };
  return (
    <form role="search" aria-label="Search the community" onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <Field label="Search the community" hideLabel className="min-w-0 flex-1">
        <Input type="search" value={q} minLength={2} maxLength={100} onChange={(event) => setQ(event.target.value)} placeholder="Search topics and posts" />
      </Field>
      <Button type="submit" variant="secondary" disabled={q.trim().length < 2}>
        Search
      </Button>
    </form>
  );
}
