import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  CheckCircle2,
  Download,
  Edit3,
  LifeBuoy,
  Paperclip,
  Printer,
  Tag,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { Link, useRoute } from "wouter";
import type { KnowledgeAttachmentView } from "@server/modules/knowledge/types";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  Callout,
  Card,
  DateTime,
  ErrorState,
  Field,
  PageHeader,
  Section,
  Skeleton,
  Textarea,
  useToast,
} from "@/ui";
import { redeemKnowledgeAttachmentDownload } from "../downloadAttachment";
import { formatAttachmentBytes, KnowledgeRichRenderer } from "../KnowledgeRichRenderer";

export default function HelpArticlePage() {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [, params] = useRoute("/help/articles/:slug");
  const slug = params?.slug ? decodeURIComponent(params.slug) : "";

  const statusQuery = useQuery(trpc.knowledge.status.queryOptions());
  const articleQuery = useQuery({
    ...trpc.knowledge.help.article.queryOptions({ slug }),
    enabled: slug.length >= 2,
  });

  const [selectedHelpful, setSelectedHelpful] = useState<boolean | null>(null);
  const [comment, setComment] = useState("");
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const feedbackMutation = useMutation(trpc.knowledge.help.submitFeedback.mutationOptions());

  if (articleQuery.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          breadcrumbs={<Breadcrumbs items={[{ label: "Knowledge base", href: "/help" }, { label: "Article" }]} />}
          title="Loading article"
        />
        <Skeleton lines={8} />
      </div>
    );
  }

  if (articleQuery.error || !articleQuery.data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          breadcrumbs={<Breadcrumbs items={[{ label: "Knowledge base", href: "/help" }, { label: "Article" }]} />}
          title="Article unavailable"
        />
        <ErrorState error={articleQuery.error} onRetry={() => void articleQuery.refetch()} />
      </div>
    );
  }

  const article = articleQuery.data;
  const effectiveHelpful = selectedHelpful ?? article.myFeedback?.helpful ?? null;

  const crumbs = [
    { label: "Knowledge base", href: "/help" },
    ...(article.categorySlug && article.categoryTitle
      ? [
          {
            label: article.categoryTitle,
            href: `/help/categories/${encodeURIComponent(article.categorySlug)}`,
          },
        ]
      : []),
    { label: article.title },
  ];

  const handleVote = async (helpful: boolean, includeComment?: string) => {
    setSelectedHelpful(helpful);
    try {
      await feedbackMutation.mutateAsync({
        articlePublicId: article.publicId,
        helpful,
        comment: includeComment?.trim() ? includeComment.trim() : null,
      });
      setFeedbackNotice("Thank you for your feedback.");
      if (includeComment !== undefined) {
        setComment("");
      }
      void queryClient.invalidateQueries({
        queryKey: trpc.knowledge.help.article.queryKey({ slug }),
      });
    } catch (err) {
      toast.show({
        tone: "danger",
        title: "Could not save feedback",
        description: errorMessage(err),
      });
    }
  };

  const handleCommentSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (effectiveHelpful === null) return;
    await handleVote(effectiveHelpful, comment);
  };

  const handleDownload = async (att: KnowledgeAttachmentView) => {
    if (downloadingId) return;
    setDownloadingId(att.publicId);
    try {
      const res = await redeemKnowledgeAttachmentDownload(
        (attachmentPublicId) =>
          trpcClient.knowledge.attachments.issueDownloadTicket.mutate({ attachmentPublicId }),
        att,
      );
      if (!res.ok) {
        toast.show({
          tone: "danger",
          title: "Download unavailable",
          description: res.message,
        });
      }
    } catch (err) {
      toast.show({
        tone: "danger",
        title: "Download unavailable",
        description: errorMessage(err),
      });
    } finally {
      setDownloadingId(null);
    }
  };

  const jumpToSection = (headingId: string) => {
    const target = document.getElementById(headingId);
    if (!target) return;
    target.scrollIntoView?.({ behavior: "smooth", block: "start" });
    target.focus({ preventScroll: true });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        breadcrumbs={<Breadcrumbs items={crumbs} />}
        title={article.title}
        description={article.summary}
        meta={
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            {article.audience === "staff" ? <Badge tone="warning">Staff internal</Badge> : null}
            {article.reviewedOn ? (
              <Badge tone="success" icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}>
                Reviewed {article.reviewedOn}
              </Badge>
            ) : null}
            <span>
              Updated <DateTime value={article.updatedAt} format="date" />
            </span>
          </div>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {statusQuery.data?.canManage ? (
              <Button asChild variant="ghost" leadingIcon={<Edit3 className="h-4 w-4" aria-hidden />}>
                <Link href={`/admin/knowledge/${encodeURIComponent(article.publicId)}`}>
                  Edit article
                </Link>
              </Button>
            ) : null}
            <Button
              variant="secondary"
              leadingIcon={<Printer className="h-4 w-4" aria-hidden />}
              onClick={() => window.print()}
            >
              Print
            </Button>
          </div>
        }
      />

      <div className="grid min-w-0 gap-6 lg:grid-cols-4">
        <article className="flex min-w-0 flex-col gap-6 lg:col-span-3">
          <Card>
            <KnowledgeRichRenderer blocks={article.bodyBlocks} />

            {article.tags.length > 0 ? (
              <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <span className="text-xs font-medium text-muted">Tags:</span>
                {article.tags.map((t) => (
                  <Link
                    key={t}
                    href={`/help?tag=${encodeURIComponent(t)}`}
                    className="inline-flex min-h-6 items-center gap-1 rounded-[var(--radius-control)] border border-line bg-surface-soft px-2 py-0.5 text-xs font-medium text-action hover:underline"
                  >
                    <Tag className="h-3 w-3" aria-hidden />
                    <span>{t}</span>
                  </Link>
                ))}
              </div>
            ) : null}
          </Card>

          {article.attachments.length > 0 ? (
            <Section title="Attachments" description="Supporting reference files for this article.">
              <ul className="flex flex-col gap-2">
                {article.attachments.map((att) => (
                  <li key={att.publicId} className="min-w-0">
                    <Card>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <Paperclip className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                          <div className="min-w-0">
                            <p className="font-medium text-ink break-words">{att.displayName}</p>
                            <p className="text-xs text-muted">
                              {att.extension.toUpperCase()} · {formatAttachmentBytes(att.size)}
                            </p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={downloadingId === att.publicId}
                          leadingIcon={<Download className="h-4 w-4" aria-hidden />}
                          onClick={() => void handleDownload(att)}
                        >
                          Download
                        </Button>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Card
            title="Was this article helpful?"
            description={`${article.helpfulYesCount} found this helpful`}
            className="rp-print-avoid-break"
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant={effectiveHelpful === true ? "primary" : "secondary"}
                  aria-pressed={effectiveHelpful === true}
                  loading={feedbackMutation.isPending && selectedHelpful === true}
                  leadingIcon={<ThumbsUp className="h-4 w-4" aria-hidden />}
                  onClick={() => void handleVote(true)}
                >
                  Yes
                </Button>
                <Button
                  variant={effectiveHelpful === false ? "primary" : "secondary"}
                  aria-pressed={effectiveHelpful === false}
                  loading={feedbackMutation.isPending && selectedHelpful === false}
                  leadingIcon={<ThumbsDown className="h-4 w-4" aria-hidden />}
                  onClick={() => void handleVote(false)}
                >
                  No
                </Button>
              </div>

              {feedbackNotice ? (
                <Callout tone="success" live="polite">
                  {feedbackNotice}
                </Callout>
              ) : null}

              {article.allowFeedbackComments && effectiveHelpful !== null ? (
                <form onSubmit={handleCommentSubmit} className="flex max-w-xl flex-col gap-3">
                  <Field
                    label="Optional note for our documentation team"
                    hint="Encrypted at rest. Do not include passwords or payment card numbers."
                  >
                    <Textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      maxLength={1000}
                      rows={3}
                      placeholder="Let us know what worked or what could be clearer."
                    />
                  </Field>
                  <div>
                    <Button
                      type="submit"
                      size="sm"
                      variant="secondary"
                      loading={feedbackMutation.isPending}
                      disabled={comment.trim().length === 0}
                    >
                      Send note
                    </Button>
                  </div>
                </form>
              ) : null}
            </div>
          </Card>
        </article>

        <aside
          aria-label="Article navigation and related guides"
          className="flex min-w-0 flex-col gap-4"
        >
          {article.toc.length > 0 ? (
            <Card title="On this page" headingLevel={2}>
              <nav aria-label="On this page">
                <ul className="flex flex-col gap-1">
                  {article.toc.map((entry) => (
                    <li key={entry.id} className={entry.level === 3 ? "pl-3" : ""}>
                      <button
                        type="button"
                        onClick={() => jumpToSection(entry.id)}
                        className="flex min-h-7 w-full items-center rounded-[var(--radius-control)] px-2 py-1 text-left text-sm text-action hover:bg-surface-soft hover:underline focus-visible:outline-2 focus-visible:outline-action break-words"
                      >
                        {entry.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            </Card>
          ) : null}

          {article.relatedArticles.length > 0 ? (
            <Card title="Related articles" headingLevel={2}>
              <ul className="flex flex-col gap-3">
                {article.relatedArticles.map((rel) => (
                  <li key={rel.publicId} className="min-w-0">
                    <Link
                      href={`/help/articles/${encodeURIComponent(rel.slug)}`}
                      className="inline-flex min-w-0 items-center gap-1.5 font-medium text-action underline-offset-2 hover:underline break-words"
                    >
                      <BookOpen className="h-4 w-4 shrink-0" aria-hidden />
                      <span>{rel.title}</span>
                    </Link>
                    <p className="mt-0.5 text-xs text-muted break-words">{rel.summary}</p>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card title="Still need help?" headingLevel={2}>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-body">
                Open a support ticket and a consultant will respond directly in your portal.
              </p>
              <Button
                asChild
                variant="secondary"
                leadingIcon={<LifeBuoy className="h-4 w-4" aria-hidden />}
              >
                <Link href="/support/new">Open support ticket</Link>
              </Button>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
