/**
 * Console → Knowledge base → article editor (`/admin/knowledge/new`, `/admin/knowledge/:articleId`).
 * The server sanitises bodyHtml on preview and save; the preview renders the server's typed blocks only
 * (never raw HTML). Every write carries `expectedVersion`, so a concurrent edit is refused, not overwritten.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Eye, History, Paperclip, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import type {
  KnowledgeAdminArticleDetailView,
  KnowledgeArticleState,
  KnowledgeArticleSummaryView,
  KnowledgeArticleVersionView,
  KnowledgeAudience,
  KnowledgeCategoryView,
  KnowledgeRichBlock,
  KnowledgeTocEntry,
} from "@server/modules/knowledge/types";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  FileDropzone,
  IconButton,
  Input,
  PageHeader,
  RichTextEditor,
  Select,
  Skeleton,
  TagInput,
  Textarea,
  Timeline,
  buttonClasses,
  useToast,
} from "@/ui";
import { KnowledgeRichRenderer, formatAttachmentBytes } from "../KnowledgeRichRenderer";
import { uploadKnowledgeAttachments } from "../downloadAttachment";
import { AUDIENCE_LABEL, STATE_META, categoryOptions, slugify } from "./AdminKnowledgeListPage";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export interface ArticleForm {
  title: string;
  summary: string;
  slug: string;
  bodyHtml: string;
  categoryPublicId: string;
  audience: KnowledgeAudience;
  tags: string[];
  reviewedOn: string;
  related: { publicId: string; title: string }[];
  changeNote: string;
}
type FormErrors = Partial<Record<"title" | "summary" | "slug" | "bodyHtml" | "reviewedOn" | "changeNote", string>>;

const EMPTY: ArticleForm = { title: "", summary: "", slug: "", bodyHtml: "", categoryPublicId: "", audience: "customers", tags: [], reviewedOn: "", related: [], changeNote: "" };

function fromArticle(a: KnowledgeAdminArticleDetailView): ArticleForm {
  return {
    title: a.title,
    summary: a.summary,
    slug: a.slug,
    bodyHtml: a.bodyHtml,
    categoryPublicId: a.categoryPublicId ?? "",
    audience: a.audience,
    tags: [...a.tags],
    reviewedOn: a.reviewedOn ?? "",
    related: a.relatedArticles.map((r) => ({ publicId: r.publicId, title: r.title })),
    changeNote: "",
  };
}

/** Client-side checks mirror the server's zod limits so errors appear next to the field; the server still decides. */
export function validateArticle(form: ArticleForm): FormErrors {
  const errors: FormErrors = {};
  const title = form.title.trim();
  const summary = form.summary.trim();
  if (title.length < 2 || title.length > 200) errors.title = "Enter a title of 2 to 200 characters.";
  if (summary.length < 5 || summary.length > 500) errors.summary = "Enter a summary of 5 to 500 characters.";
  if (form.slug.length < 2 || form.slug.length > 120 || !SLUG.test(form.slug)) errors.slug = "Use 2 to 120 lowercase letters, numbers and single hyphens.";
  if (!form.bodyHtml.replace(/<[^>]*>/g, "").trim()) errors.bodyHtml = "Write the article before saving.";
  if (form.reviewedOn && !/^\d{4}-\d{2}-\d{2}$/.test(form.reviewedOn)) errors.reviewedOn = "Use a date such as 2026-11-21.";
  if (form.changeNote.length > 255) errors.changeNote = "Keep the change note under 255 characters.";
  return errors;
}

/* ------------------------------------------------------------------ preview */

function PreviewDialog({ open, onOpenChange, title, summary, blocks, toc }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; summary: string; blocks: readonly KnowledgeRichBlock[]; toc: readonly KnowledgeTocEntry[] }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Preview" description="How customers will see this article after saving." size="lg">
      <article className="grid min-w-0 gap-4" aria-label={`Preview of ${title}`}>
        <h2 className="text-2xl font-semibold break-words text-ink">{title}</h2>
        <p className="text-body">{summary}</p>
        {toc.length > 0 ? (
          <nav aria-label="On this page" className="rounded-[var(--radius-card)] border border-line p-3 text-sm">
            <ul className="grid gap-1">
              {toc.map((t) => (
                <li key={t.id} className={t.level > 2 ? "pl-4" : undefined}>
                  {t.text}
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <KnowledgeRichRenderer blocks={blocks} />
      </article>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ versions */

function VersionsCard({ article, onRestored }: { article: KnowledgeAdminArticleDetailView; onRestored: () => Promise<void> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const versions = useQuery(trpc.knowledge.admin.articles.versions.queryOptions({ publicId: article.publicId }));
  const restore = useMutation(trpc.knowledge.admin.articles.restoreVersion.mutationOptions());
  const [target, setTarget] = useState<KnowledgeArticleVersionView | null>(null);
  const items = (versions.data as { items: KnowledgeArticleVersionView[] } | undefined)?.items ?? [];

  return (
    <Card title="Version history" description="Every save keeps a copy. Restoring creates a new version; nothing is lost.">
      {versions.isPending ? (
        <div aria-busy="true"><Skeleton lines={3} /></div>
      ) : versions.error ? (
        <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
      ) : (
        <Timeline
          label="Article versions"
          items={items.map((v) => ({
            key: String(v.versionNumber),
            title: (
              <span className="flex flex-wrap items-center gap-2">
                Version {v.versionNumber}
                {v.versionNumber === article.currentVersionNumber ? <Badge tone="info">Current</Badge> : null}
              </span>
            ),
            time: v.createdAt,
            icon: History,
            description: (
              <span className="grid gap-1">
                <span className="break-words">{v.changeNote ?? v.title}</span>
                {v.versionNumber !== article.currentVersionNumber ? (
                  <span>
                    <Button size="sm" variant="secondary" aria-label={`Restore version ${v.versionNumber}`} onClick={() => setTarget(v)}>
                      Restore
                    </Button>
                  </span>
                ) : null}
              </span>
            ),
          }))}
        />
      )}
      {target ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setTarget(null)}
          title={`Restore version ${target.versionNumber}?`}
          description="The article's text and details return to this version and are saved as a new version. Unsaved changes in the editor are discarded."
          confirmLabel="Restore version"
          onConfirm={async () => {
            try {
              await restore.mutateAsync({ publicId: article.publicId, expectedVersion: article.version, versionNumber: target.versionNumber, changeNote: `Restored version ${target.versionNumber}` });
              toast.show({ tone: "success", title: `Version ${target.versionNumber} restored` });
              setTarget(null);
              await onRestored();
            } catch (error) {
              toast.show({ tone: "danger", title: "The version was not restored", description: errorMessage(error) });
              throw error;
            }
          }}
        />
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ attachments */

function AttachmentsCard({ article, onChanged }: { article: KnowledgeAdminArticleDetailView; onChanged: () => Promise<void> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const remove = useMutation(trpc.knowledge.attachments.remove.mutationOptions());
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const policy = article.uploadPolicy;

  async function upload(files: File[]) {
    if (files.length === 0) return;
    if (files.length > policy.maxFiles) {
      setMessage(`Choose up to ${policy.maxFiles} files at a time.`);
      return;
    }
    setUploading(true);
    setMessage("");
    try {
      const results = await uploadKnowledgeAttachments(article.publicId, files);
      const done = results.filter((r) => r.outcome === "completed").length;
      const refused = results.filter((r) => r.outcome !== "completed");
      setMessage(`${done} of ${files.length} ${files.length === 1 ? "file" : "files"} attached.${refused.length ? ` ${refused.map((r) => `${files[r.index]?.name ?? "A file"}: ${r.message ?? "not attached"}`).join(" ")}` : ""}`);
    } catch {
      setMessage("The upload was not confirmed. Check the list before trying again.");
    } finally {
      setUploading(false);
      await onChanged();
    }
  }

  return (
    <Card title="Attachments" description="Files customers can download from the article. Each file is checked before it is offered.">
      <div className="grid gap-4">
        {article.attachments.length > 0 ? (
          <ul className="divide-y divide-line" aria-label="Attached files">
            {article.attachments.map((f) => (
              <li key={f.publicId} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <Paperclip className="size-4 shrink-0 text-body" aria-hidden />
                  <span className="min-w-0 break-words text-ink">{f.displayName}</span>
                  <span className="shrink-0 text-body">{formatAttachmentBytes(f.size)}</span>
                </span>
                <IconButton
                  label={`Remove ${f.displayName}`}
                  icon={<Trash2 className="size-4" aria-hidden />}
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await remove.mutateAsync({ attachmentPublicId: f.publicId });
                      toast.show({ tone: "success", title: `${f.displayName} removed` });
                    } catch (error) {
                      toast.show({ tone: "danger", title: "The file was not removed", description: errorMessage(error) });
                    }
                    await onChanged();
                  }}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-body">No files attached.</p>
        )}
        <FileDropzone
          onFiles={(files) => void upload(files)}
          accept={policy.extensions.map((e) => `.${e}`).join(",")}
          multiple
          maxSize={policy.maxFileBytes}
          disabled={uploading}
          label="Add attachments"
          hint={`${policy.extensions.join(", ").toUpperCase()} · up to ${formatAttachmentBytes(policy.maxFileBytes)} each`}
        />
        <p role="status" aria-live="polite" className="text-sm text-body">
          {uploading ? "Uploading…" : message}
        </p>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ form */

function ArticleEditor({ article, categories }: { article: KnowledgeAdminArticleDetailView | null; categories: readonly KnowledgeCategoryView[] }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const toast = useToast();
  const [, navigate] = useLocation();
  const [form, setForm] = useState<ArticleForm>(article ? fromArticle(article) : EMPTY);
  const [slugTouched, setSlugTouched] = useState(Boolean(article));
  const [errors, setErrors] = useState<FormErrors>({});
  const [preview, setPreview] = useState<{ blocks: readonly KnowledgeRichBlock[]; toc: readonly KnowledgeTocEntry[] } | null>(null);
  const [relatedPick, setRelatedPick] = useState("");
  const create = useMutation(trpc.knowledge.admin.articles.create.mutationOptions());
  const update = useMutation(trpc.knowledge.admin.articles.update.mutationOptions());
  const setState = useMutation(trpc.knowledge.admin.articles.setState.mutationOptions());
  const previewMutation = useMutation(trpc.knowledge.admin.articles.preview.mutationOptions());
  const candidates = useQuery(trpc.knowledge.admin.articles.list.queryOptions({ state: "published", limit: 50 }));
  const relatedOptions = ((candidates.data as { items: KnowledgeArticleSummaryView[] } | undefined)?.items ?? []).filter((a) => a.publicId !== article?.publicId && !form.related.some((r) => r.publicId === a.publicId));
  const saving = create.isPending || update.isPending;

  const set = <K extends keyof ArticleForm>(key: K, value: ArticleForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function refresh() {
    await client.invalidateQueries({ queryKey: trpc.knowledge.admin.articles.get.queryKey() });
    await client.invalidateQueries({ queryKey: trpc.knowledge.admin.articles.versions.queryKey() });
    await client.invalidateQueries({ queryKey: trpc.knowledge.admin.articles.list.queryKey() });
  }

  async function save(publish = false) {
    const next = validateArticle(form);
    setErrors(next);
    if (Object.keys(next).length > 0) {
      toast.show({ tone: "danger", title: "Check the highlighted fields" });
      return;
    }
    const body = {
      title: form.title.trim(),
      summary: form.summary.trim(),
      slug: form.slug,
      bodyHtml: form.bodyHtml,
      categoryPublicId: form.categoryPublicId || null,
      audience: form.audience,
      tags: form.tags,
      reviewedOn: form.reviewedOn || null,
      relatedArticlePublicIds: form.related.map((r) => r.publicId),
      changeNote: form.changeNote.trim() || null,
    };
    try {
      if (article) {
        await update.mutateAsync({ publicId: article.publicId, expectedVersion: article.version, ...body });
        toast.show({ tone: "success", title: "Article saved" });
        await refresh();
      } else {
        const created = await create.mutateAsync({ ...body, state: publish ? "published" : "draft" });
        toast.show({ tone: "success", title: publish ? "Article published" : "Draft saved" });
        await client.invalidateQueries({ queryKey: trpc.knowledge.admin.articles.list.queryKey() });
        navigate(`/admin/knowledge/${created.publicId}`, { replace: true });
      }
    } catch (error) {
      toast.show({ tone: "danger", title: "The article was not saved", description: errorMessage(error) });
    }
  }

  async function changeState(state: KnowledgeArticleState) {
    if (!article) return;
    try {
      await setState.mutateAsync({ publicId: article.publicId, expectedVersion: article.version, state });
      toast.show({ tone: "success", title: state === "published" ? "Article published" : state === "archived" ? "Article archived" : "Article moved to drafts" });
    } catch (error) {
      toast.show({ tone: "danger", title: "The article was not changed", description: errorMessage(error) });
    }
    await refresh();
  }

  async function showPreview() {
    try {
      const result = await previewMutation.mutateAsync({ title: form.title.trim() || "Untitled", summary: form.summary.trim() || "No summary yet.", bodyHtml: form.bodyHtml || "<p></p>" });
      setPreview({ blocks: result.bodyBlocks, toc: result.toc });
    } catch (error) {
      toast.show({ tone: "danger", title: "The preview could not be shown", description: errorMessage(error) });
    }
  }

  return (
    <>
      <PageHeader
        title={article ? "Edit article" : "New article"}
        description={article ? <span className="flex flex-wrap items-center gap-2">{article.title} <Badge tone={STATE_META[article.state].tone}>{STATE_META[article.state].label}</Badge></span> : "Articles start as drafts unless you publish them."}
        actions={
          <Link href="/admin/knowledge" className={buttonClasses("ghost", "md")}>
            <ArrowLeft className="size-4" aria-hidden /> All articles
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <form
          noValidate
          className="grid min-w-0 gap-5"
          aria-label="Article"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Card title="Content">
            <div className="grid gap-4">
              <Field label="Title" required error={errors.title}>
                <Input
                  value={form.title}
                  maxLength={200}
                  onChange={(e) => {
                    const title = e.target.value;
                    setForm((f) => ({ ...f, title, slug: slugTouched ? f.slug : slugify(title) }));
                  }}
                />
              </Field>
              <Field label="Summary" hint="Shown in search results and lists." required error={errors.summary}>
                <Textarea value={form.summary} maxLength={500} rows={2} onChange={(e) => set("summary", e.target.value)} />
              </Field>
              <RichTextEditor id="knowledge-body" label="Article text" required value={form.bodyHtml} onChange={(html) => set("bodyHtml", html)} error={errors.bodyHtml} hint="Use headings to build the “On this page” list." disabled={saving} />
            </div>
          </Card>
          <Card title="Details">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Address" hint="Lowercase words joined by hyphens." required error={errors.slug}>
                <Input
                  value={form.slug}
                  maxLength={120}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setSlugTouched(true);
                    set("slug", e.target.value);
                  }}
                />
              </Field>
              <Field label="Category">
                <Select value={form.categoryPublicId} options={[{ value: "", label: "Uncategorised" }, ...categoryOptions(categories)]} onChange={(e) => set("categoryPublicId", e.target.value)} />
              </Field>
              <Field label="Audience" hint="Staff-only articles never appear in the customer help centre.">
                <Select value={form.audience} options={Object.entries(AUDIENCE_LABEL).map(([value, label]) => ({ value, label }))} onChange={(e) => set("audience", e.target.value as KnowledgeAudience)} />
              </Field>
              <Field label="Last reviewed" error={errors.reviewedOn}>
                <Input type="date" value={form.reviewedOn} maxLength={10} onChange={(e) => set("reviewedOn", e.target.value)} />
              </Field>
              <div className="sm:col-span-2">
                <TagInput label="Tags" value={form.tags} onValueChange={(tags) => set("tags", tags)} max={20} validate={(t) => (TAG.test(t) ? null : "Tags use lowercase letters, numbers, hyphens or underscores.")} hint="Up to 20. Press Enter after each tag." />
              </div>
            </div>
          </Card>
          <Card title="Related articles" description="Up to 10 published articles shown at the end.">
            <div className="grid gap-3">
              {form.related.length > 0 ? (
                <ul className="divide-y divide-line" aria-label="Related articles">
                  {form.related.map((r) => (
                    <li key={r.publicId} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0 break-words text-ink">{r.title}</span>
                      <Button size="sm" variant="ghost" aria-label={`Remove ${r.title} from related articles`} onClick={() => set("related", form.related.filter((x) => x.publicId !== r.publicId))}>
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <Field label="Add a related article">
                    <Select value={relatedPick} disabled={form.related.length >= 10} options={[{ value: "", label: "Choose an article" }, ...relatedOptions.map((a) => ({ value: a.publicId, label: a.title }))]} onChange={(e) => setRelatedPick(e.target.value)} />
                  </Field>
                </div>
                <Button
                  variant="secondary"
                  disabled={!relatedPick || form.related.length >= 10}
                  onClick={() => {
                    const found = relatedOptions.find((a) => a.publicId === relatedPick);
                    if (found) set("related", [...form.related, { publicId: found.publicId, title: found.title }]);
                    setRelatedPick("");
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
          </Card>
          <Card title="Save">
            <div className="grid gap-4">
              <Field label="Change note" hint="Optional. Shown in version history." error={errors.changeNote}>
                <Input value={form.changeNote} maxLength={255} onChange={(e) => set("changeNote", e.target.value)} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={saving}>
                  {article ? "Save changes" : "Save draft"}
                </Button>
                {!article ? (
                  <Button variant="secondary" disabled={saving} onClick={() => void save(true)}>
                    Save and publish
                  </Button>
                ) : null}
                <Button variant="ghost" leadingIcon={<Eye className="size-4" aria-hidden />} loading={previewMutation.isPending} onClick={() => void showPreview()}>
                  Preview
                </Button>
              </div>
            </div>
          </Card>
        </form>
        {article ? (
          <aside className="grid min-w-0 content-start gap-5" aria-label="Publishing and history">
            <Card title="Publishing">
              <div className="grid gap-3 text-sm">
                <p className="text-body">
                  {article.viewCount} views · {article.helpfulYesCount} found it helpful · {article.helpfulNoCount} did not
                </p>
                <div className="flex flex-wrap gap-2">
                  {article.state !== "published" ? (
                    <Button size="sm" onClick={() => void changeState("published")} loading={setState.isPending}>
                      Publish
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => void changeState("draft")} loading={setState.isPending}>
                      Unpublish
                    </Button>
                  )}
                  {article.state !== "archived" ? (
                    <Button size="sm" variant="ghost" onClick={() => void changeState("archived")}>
                      Archive
                    </Button>
                  ) : null}
                </div>
                <p className="text-body">Publishing uses the last saved version. Save your changes first.</p>
              </div>
            </Card>
            <AttachmentsCard article={article} onChanged={refresh} />
            <VersionsCard article={article} onRestored={refresh} />
          </aside>
        ) : (
          <aside className="min-w-0" aria-label="Attachments">
            <Callout tone="info" title="Attachments">
              Save the draft first, then add files.
            </Callout>
          </aside>
        )}
      </div>
      {preview ? <PreviewDialog open onOpenChange={(o) => !o && setPreview(null)} title={form.title.trim() || "Untitled"} summary={form.summary.trim()} blocks={preview.blocks} toc={preview.toc} /> : null}
    </>
  );
}

/* ------------------------------------------------------------------ page */

export default function AdminKnowledgeEditorPage() {
  const trpc = useTRPC();
  const [, params] = useRoute<{ articleId: string }>("/admin/knowledge/:articleId");
  const articleId = params?.articleId && params.articleId !== "new" ? params.articleId : null;
  const categories = useQuery(trpc.knowledge.admin.categories.list.queryOptions({ includeArchived: false }));
  const article = useQuery({ ...trpc.knowledge.admin.articles.get.queryOptions({ publicId: articleId ?? "" }), enabled: articleId !== null });
  const categoryItems = (categories.data as { items: KnowledgeCategoryView[] } | undefined)?.items ?? [];

  if (articleId && article.isPending) {
    return (
      <div aria-busy="true">
        <PageHeader title="Edit article" />
        <Skeleton lines={8} />
      </div>
    );
  }
  if (articleId && (article.error || !article.data)) {
    return (
      <>
        <PageHeader title="Edit article" />
        <ErrorState error={article.error} onRetry={() => void article.refetch()} />
      </>
    );
  }
  const detail = articleId ? (article.data as KnowledgeAdminArticleDetailView) : null;
  // Remount when the content version changes (save or restore) so the form starts from the server's copy;
  // attachment or state changes bump only `version` and keep unsaved edits.
  return <ArticleEditor key={detail ? `${detail.publicId}:${detail.currentVersionNumber}` : "new"} article={detail} categories={categoryItems} />;
}
